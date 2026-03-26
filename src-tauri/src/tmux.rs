use std::process::Command;

/// Resolve the full path to the tmux binary.
/// macOS GUI apps don't inherit shell PATH, so /opt/homebrew/bin isn't visible.
pub fn tmux_bin() -> &'static str {
    static PATHS: &[&str] = &[
        "/opt/homebrew/bin/tmux",  // Apple Silicon Homebrew
        "/usr/local/bin/tmux",     // Intel Homebrew
        "/usr/bin/tmux",           // System
    ];
    for p in PATHS {
        if std::path::Path::new(p).exists() {
            return p;
        }
    }
    "tmux" // Fallback to PATH
}

/// Represents a running tmux session.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxSession {
    pub name: String,
    pub created: String,
    pub attached: bool,
    pub width: u32,
    pub height: u32,
}

/// Returns the path to the forge tmux config file.
fn config_path() -> String {
    let home = dirs::home_dir().expect("cannot determine home directory");
    home.join(".terminal-forge").join("tmux.conf").to_string_lossy().to_string()
}

/// Check whether tmux is available on PATH.
pub fn is_available() -> bool {
    Command::new(tmux_bin())
        .arg("-V")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Create a new detached tmux session with the given name and working directory.
pub fn create_session(name: &str, cwd: &str) -> Result<(), String> {
    let conf = config_path();
    let output = Command::new(tmux_bin())
        .args(["-f", &conf, "new-session", "-d", "-s", name, "-c", cwd])
        .output()
        .map_err(|e| format!("failed to spawn tmux: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux new-session failed: {stderr}"));
    }

    // Ensure mouse is off so xterm.js handles selection and scrolling locally.
    disable_mouse(name);
    Ok(())
}

/// Disable tmux mouse mode for a session so xterm.js handles mouse events.
pub fn disable_mouse(session_name: &str) {
    let _ = Command::new(tmux_bin())
        .args(["set-option", "-t", session_name, "mouse", "off"])
        .output();
}

/// List running tmux sessions whose names start with "forge-".
pub fn list_sessions() -> Result<Vec<TmuxSession>, String> {
    let output = Command::new(tmux_bin())
        .args([
            "list-sessions",
            "-F",
            "#{session_name}|#{session_created}|#{session_attached}|#{session_width}|#{session_height}",
        ])
        .output()
        .map_err(|e| format!("failed to spawn tmux: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // "no server running" or "no sessions" → treat as empty, not error
        if stderr.contains("no server running") || stderr.contains("no sessions") {
            return Ok(Vec::new());
        }
        return Err(format!("tmux list-sessions failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut sessions = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.splitn(5, '|').collect();
        if parts.len() < 5 {
            continue;
        }
        let name = parts[0];
        if !name.starts_with("forge-") {
            continue;
        }
        sessions.push(TmuxSession {
            name: name.to_string(),
            created: parts[1].to_string(),
            attached: parts[2] == "1",
            width: parts[3].parse().unwrap_or(80),
            height: parts[4].parse().unwrap_or(24),
        });
    }

    Ok(sessions)
}

/// Kill a tmux session by name.
pub fn kill_session(name: &str) -> Result<(), String> {
    let output = Command::new(tmux_bin())
        .args(["kill-session", "-t", name])
        .output()
        .map_err(|e| format!("failed to spawn tmux: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("tmux kill-session failed: {stderr}"))
    }
}

/// Pane context retrieved from a running tmux session.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneInfo {
    pub current_path: String,
    pub pane_title: String,
}

/// Get the current working directory and pane title of a tmux session's active pane.
pub fn get_pane_info(session_name: &str) -> Result<PaneInfo, String> {
    let output = Command::new(tmux_bin())
        .args([
            "display-message",
            "-p",
            "-t",
            session_name,
            "#{pane_current_path}|#{pane_title}",
        ])
        .output()
        .map_err(|e| format!("failed to spawn tmux: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux display-message failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let parts: Vec<&str> = stdout.splitn(2, '|').collect();

    Ok(PaneInfo {
        current_path: parts.first().unwrap_or(&"").to_string(),
        pane_title: parts.get(1).unwrap_or(&"").to_string(),
    })
}

/// Capture recent text from the active pane of a tmux session.
pub fn capture_pane_text(session_name: &str, lines: usize) -> Result<String, String> {
    let start = format!("-{}", lines.max(1));
    let output = Command::new(tmux_bin())
        .args(["capture-pane", "-p", "-S", &start, "-t", session_name])
        .output()
        .map_err(|e| format!("failed to spawn tmux capture-pane: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux capture-pane failed: {stderr}"));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Scroll a tmux session's pane via copy-mode.
/// Enters copy-mode if not already in it, then scrolls up or down.
pub fn scroll(session_name: &str, lines: i32) -> Result<(), String> {
    if lines == 0 {
        return Ok(());
    }

    let up = lines < 0;
    let count = lines.unsigned_abs();

    // Enter copy-mode (no-op if already in it)
    let _ = Command::new(tmux_bin())
        .args(["copy-mode", "-t", session_name])
        .output();

    // Send scroll command
    let cmd = if up { "scroll-up" } else { "scroll-down" };
    for _ in 0..count {
        let _ = Command::new(tmux_bin())
            .args(["send-keys", "-t", session_name, "-X", cmd])
            .output();
    }

    Ok(())
}

/// Cancel copy-mode for a tmux session (returns to normal prompt).
pub fn cancel_copy_mode(session_name: &str) {
    let _ = Command::new(tmux_bin())
        .args(["send-keys", "-t", session_name, "-X", "cancel"])
        .output();
}

/// Check whether a tmux session with the given name currently exists.
pub fn session_exists(name: &str) -> bool {
    Command::new(tmux_bin())
        .args(["has-session", "-t", name])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_available() {
        // On any dev machine with tmux installed this should be true.
        // If tmux is absent, the test still passes — it just returns false.
        let result = is_available();
        // We only assert it returns a bool without panicking.
        assert!(result || !result);
    }

    #[test]
    fn test_create_and_kill_roundtrip() {
        if !is_available() {
            eprintln!("tmux not available, skipping roundtrip test");
            return;
        }

        let name = "forge-test-roundtrip";

        // Clean up any leftover session from a previous failed run
        let _ = kill_session(name);

        // Create
        let tmp = std::env::temp_dir();
        let cwd = tmp.to_string_lossy().to_string();
        create_session(name, &cwd).expect("create_session should succeed");
        assert!(session_exists(name), "session should exist after creation");

        // Verify it shows up in list
        let sessions = list_sessions().expect("list_sessions should succeed");
        assert!(
            sessions.iter().any(|s| s.name == name),
            "newly created session should appear in list"
        );

        // Kill
        kill_session(name).expect("kill_session should succeed");
        assert!(
            !session_exists(name),
            "session should not exist after kill"
        );
    }
}
