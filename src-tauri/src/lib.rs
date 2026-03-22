#[allow(dead_code)]
mod git;
mod pty;
mod sessions;
#[allow(dead_code)]
mod tmux;

use chrono::Utc;
use sessions::{Session, SessionStore};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::State;

/// Enriched session data returned to the frontend.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWithStatus {
    #[serde(flatten)]
    pub session: Session,
    pub alive: bool,
    pub branch: Option<String>,
}

/// Application state managed by Tauri.
pub struct AppState {
    pub pty_manager: pty::PtyManager,
    pub store: Mutex<SessionStore>,
}

// ── Tauri commands ──────────────────────────────────────────────────────

#[tauri::command]
fn check_tmux() -> Result<bool, String> {
    // Direct file existence check — is_available() uses Command which may fail
    // even with PATH fix if the shell env isn't fully set up
    let exists = std::path::Path::new(tmux::tmux_bin()).exists();
    log::info!("check_tmux: bin={}, exists={}", tmux::tmux_bin(), exists);
    Ok(exists)
}

#[tauri::command]
fn create_session(
    project: String,
    task: String,
    directory: String,
    state: State<'_, AppState>,
) -> Result<Session, String> {
    let id = sessions::generate_id();
    let tmux_name = id.clone();

    tmux::create_session(&tmux_name, &directory)?;

    let session = Session {
        id,
        tmux_name: tmux_name.clone(),
        project,
        task,
        directory,
        pinned: false,
        created_at: Utc::now(),
        last_accessed_at: Utc::now(),
        spec_path: None,
        notes: None,
    };

    let mut store = state.store.lock().map_err(|e| format!("lock error: {e}"))?;
    sessions::add_session(&mut store, session.clone())?;

    Ok(session)
}

#[tauri::command]
fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionWithStatus>, String> {
    let store = state.store.lock().map_err(|e| format!("lock error: {e}"))?;
    let mut result = Vec::new();

    for session in &store.sessions {
        let alive = tmux::session_exists(&session.tmux_name);
        let branch = git::get_branch(&session.directory);
        result.push(SessionWithStatus {
            session: session.clone(),
            alive,
            branch,
        });
    }

    Ok(result)
}

#[tauri::command]
async fn connect_session(
    session_name: String,
    channel: Channel<Vec<u8>>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.pty_manager.connect(&session_name, channel).await
}

#[tauri::command]
async fn write_to_pty(
    session_name: String,
    data: Vec<u8>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.pty_manager.write(&session_name, &data).await
}

#[tauri::command]
async fn disconnect_session(
    session_name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.pty_manager.disconnect(&session_name).await
}

#[tauri::command]
fn kill_session(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut store = state.store.lock().map_err(|e| format!("lock error: {e}"))?;

    // Find the tmux name before removing
    let tmux_name = store
        .sessions
        .iter()
        .find(|s| s.id == session_id)
        .map(|s| s.tmux_name.clone());

    if let Some(name) = tmux_name {
        // Kill tmux session (ignore error if already dead)
        let _ = tmux::kill_session(&name);
    }

    sessions::remove_session(&mut store, &session_id)?;
    Ok(())
}

#[tauri::command]
fn update_session_metadata(
    session_id: String,
    pinned: Option<bool>,
    notes: Option<String>,
    task: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut store = state.store.lock().map_err(|e| format!("lock error: {e}"))?;

    sessions::update_session(&mut store, &session_id, |session| {
        if let Some(p) = pinned {
            session.pinned = p;
        }
        if let Some(n) = notes {
            session.notes = Some(n);
        }
        if let Some(t) = task {
            session.task = t;
        }
        session.last_accessed_at = Utc::now();
    })
}

#[tauri::command]
fn resize_pty(
    session_name: String,
    rows: u16,
    cols: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.pty_manager.resize(&session_name, rows, cols)
}

#[tauri::command]
fn get_git_branch(directory: String) -> Option<String> {
    git::get_branch(&directory)
}

#[tauri::command]
fn restore_session(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut store = state.store.lock().map_err(|e| format!("lock error: {e}"))?;

    let session = store
        .sessions
        .iter()
        .find(|s| s.id == session_id)
        .ok_or_else(|| format!("session not found: {session_id}"))?;

    if tmux::session_exists(&session.tmux_name) {
        return Err(format!(
            "tmux session '{}' already exists",
            session.tmux_name
        ));
    }

    let tmux_name = session.tmux_name.clone();
    let directory = session.directory.clone();

    // Recreate the tmux session
    tmux::create_session(&tmux_name, &directory)?;

    // Update last_accessed_at
    sessions::update_session(&mut store, &session_id, |s| {
        s.last_accessed_at = Utc::now();
    })
}

#[tauri::command]
fn list_project_dirs() -> Result<Vec<String>, String> {
    let base = std::path::Path::new("/Users/owner/Desktop/Tech Tools");

    if !base.exists() {
        return Ok(Vec::new());
    }

    let mut dirs = Vec::new();
    let entries = std::fs::read_dir(base).map_err(|e| format!("cannot read directory: {e}"))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("read_dir entry error: {e}"))?;
        let path = entry.path();
        if path.is_dir() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if !name.starts_with('.') && name != "node_modules" && name != "target" {
                    dirs.push(name.to_string());
                }
            }
        }
    }

    dirs.sort();
    Ok(dirs)
}

// ── App setup ───────────────────────────────────────────────────────────

/// Fix PATH for macOS GUI apps — they don't inherit shell PATH,
/// so Homebrew binaries (/opt/homebrew/bin) are invisible.
fn fix_path() {
    let current = std::env::var("PATH").unwrap_or_default();
    let additions = [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
    ];
    let mut parts: Vec<&str> = additions.to_vec();
    parts.extend(current.split(':'));
    std::env::set_var("PATH", parts.join(":"));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    fix_path();
    let store = sessions::load();

    tauri::Builder::default()
        .manage(AppState {
            pty_manager: pty::PtyManager::new(),
            store: Mutex::new(store),
        })
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            check_tmux,
            create_session,
            list_sessions,
            connect_session,
            write_to_pty,
            disconnect_session,
            kill_session,
            update_session_metadata,
            resize_pty,
            get_git_branch,
            restore_session,
            list_project_dirs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
