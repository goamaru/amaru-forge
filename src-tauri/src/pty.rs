use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::Write;
use std::sync::Arc;
use tauri::ipc::Channel;
use tokio::sync::{mpsc, Mutex};

/// Handle to one connected PTY session.
pub struct PtyHandle {
    writer: Box<dyn Write + Send>,
    kill_tx: mpsc::Sender<()>,
}

/// Manages all active PTY connections.
pub struct PtyManager {
    handles: Arc<Mutex<HashMap<String, PtyHandle>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            handles: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Spawn a PTY that attaches to the given tmux session and streams
    /// output back through the Tauri Channel.
    pub async fn connect(
        &self,
        session_name: &str,
        channel: Channel<Vec<u8>>,
    ) -> Result<(), String> {
        let conf = {
            let home = dirs::home_dir().ok_or("cannot determine home directory")?;
            home.join(".terminal-forge")
                .join("tmux.conf")
                .to_string_lossy()
                .to_string()
        };

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize::default())
            .map_err(|e| format!("failed to open pty: {e}"))?;

        let mut cmd = CommandBuilder::new("tmux");
        cmd.args(["-f", &conf, "attach-session", "-t", session_name]);

        let _child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("failed to spawn tmux attach: {e}"))?;

        // We must drop the slave side so that the master reader gets EOF when
        // the child exits.
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("failed to take pty writer: {e}"))?;

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("failed to clone pty reader: {e}"))?;

        let (kill_tx, _kill_rx) = mpsc::channel::<()>(1);

        let handle = PtyHandle { writer, kill_tx };

        let name = session_name.to_string();
        self.handles.lock().await.insert(name.clone(), handle);

        // Use a std::sync::mpsc channel to shuttle data from the blocking
        // reader thread to the async task that forwards to the Tauri Channel.
        let (data_tx, mut data_rx) = mpsc::channel::<Vec<u8>>(64);

        // Blocking reader thread — owns the reader for its entire lifetime
        let reader_name = name.clone();
        std::thread::spawn(move || {
            use std::io::Read;
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,          // EOF
                    Ok(n) => {
                        if data_tx.blocking_send(buf[..n].to_vec()).is_err() {
                            break; // receiver dropped
                        }
                    }
                    Err(e) => {
                        log::warn!("pty read error for {reader_name}: {e}");
                        break;
                    }
                }
            }
        });

        // Async task to forward data from the reader thread to the frontend
        let handles = self.handles.clone();
        tokio::spawn(async move {
            while let Some(data) = data_rx.recv().await {
                if channel.send(data).is_err() {
                    log::warn!("channel send failed for session {name}, disconnecting");
                    break;
                }
            }
            // Clean up
            handles.lock().await.remove(&name);
        });

        Ok(())
    }

    /// Write bytes to the PTY stdin of a connected session.
    pub async fn write(&self, session_name: &str, data: &[u8]) -> Result<(), String> {
        let mut handles = self.handles.lock().await;
        let handle = handles
            .get_mut(session_name)
            .ok_or_else(|| format!("no pty connection for session: {session_name}"))?;
        handle
            .writer
            .write_all(data)
            .map_err(|e| format!("pty write failed: {e}"))?;
        handle
            .writer
            .flush()
            .map_err(|e| format!("pty flush failed: {e}"))?;
        Ok(())
    }

    /// Disconnect from a PTY session (signals the reader task to stop).
    pub async fn disconnect(&self, session_name: &str) -> Result<(), String> {
        let mut handles = self.handles.lock().await;
        if let Some(handle) = handles.remove(session_name) {
            let _ = handle.kill_tx.send(()).await;
            Ok(())
        } else {
            Err(format!("no pty connection for session: {session_name}"))
        }
    }

    /// Resize the tmux window for the given session.
    pub fn resize(&self, session_name: &str, rows: u16, cols: u16) -> Result<(), String> {
        let output = std::process::Command::new("tmux")
            .args([
                "resize-window",
                "-t",
                session_name,
                "-x",
                &cols.to_string(),
                "-y",
                &rows.to_string(),
            ])
            .output()
            .map_err(|e| format!("failed to spawn tmux resize: {e}"))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("tmux resize-window failed: {stderr}"))
        }
    }
}
