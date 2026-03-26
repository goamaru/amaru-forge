#[allow(dead_code)]
mod git;
mod pty;
mod sessions;
#[allow(dead_code)]
mod tmux;

use chrono::Utc;
use sessions::{Session, SessionStore};
use std::fs;
use std::path::Path;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::{Emitter, State};
use tokio::process::Command as TokioCommand;
use tokio::time::{timeout, Duration};

/// Enriched session data returned to the frontend.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWithStatus {
    #[serde(flatten)]
    pub session: Session,
    pub alive: bool,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContents {
    pub path: String,
    pub content: String,
}

/// Application state managed by Tauri.
pub struct AppState {
    pub pty_manager: pty::PtyManager,
    pub store: Mutex<SessionStore>,
}

const SIDECAR_TIMEOUT_SECS: u64 = 90;
const SIDECAR_CONTEXT_MAX_CHARS: usize = 12_000;

fn truncate_chars(text: &str, max_chars: usize) -> String {
    let mut truncated = text.chars().take(max_chars).collect::<String>();
    if text.chars().count() > max_chars {
        truncated.push_str("\n…(truncated)");
    }
    truncated
}

fn resolve_cli_bin(binary: &str) -> String {
    for candidate in [
        format!("/opt/homebrew/bin/{binary}"),
        format!("/usr/local/bin/{binary}"),
        format!("/usr/bin/{binary}"),
    ] {
        if Path::new(&candidate).exists() {
            return candidate;
        }
    }
    binary.to_string()
}

fn read_sidecar_file_context(path: &str) -> Result<String, String> {
    let canonical = fs::canonicalize(path).map_err(|e| format!("failed to resolve {path}: {e}"))?;
    fs::read_to_string(&canonical)
        .map_err(|e| format!("failed to read {}: {e}", canonical.display()))
}

fn build_sidecar_prompt(
    prompt: &str,
    directory: &str,
    session_name: Option<&str>,
    context_action: Option<&str>,
    current_file: Option<&str>,
) -> String {
    let mut sections = vec![
        "You are the Amaru Forge sidecar model. The primary terminal session is a separate model. Give a concise second opinion, verification, or review. If context is missing, say what is missing instead of pretending you saw it.".to_string(),
        format!("Working directory: {directory}"),
        format!("User request:\n{prompt}"),
    ];

    if let Some(path) = current_file {
        sections.push(format!("Current editor file: {path}"));
    }

    match context_action {
        Some("ask-run") => {
            if let Some(name) = session_name {
                match tmux::capture_pane_text(name, 220) {
                    Ok(output) if !output.trim().is_empty() => sections.push(format!(
                        "Recent terminal output:\n```text\n{}\n```",
                        truncate_chars(&output, SIDECAR_CONTEXT_MAX_CHARS)
                    )),
                    Ok(_) => sections.push("Recent terminal output was empty.".to_string()),
                    Err(err) => sections.push(format!("Recent terminal output unavailable: {err}")),
                }
            }
        }
        Some("review-diff") => match git::get_diff(directory) {
            Ok(diff) if !diff.trim().is_empty() => sections.push(format!(
                "Current git diff:\n```diff\n{}\n```",
                truncate_chars(&diff, SIDECAR_CONTEXT_MAX_CHARS)
            )),
            Ok(_) => sections.push("Current git diff: clean working tree.".to_string()),
            Err(err) => sections.push(format!("Current git diff unavailable: {err}")),
        },
        Some("focus-file") => {
            if let Some(path) = current_file {
                match read_sidecar_file_context(path) {
                    Ok(contents) => sections.push(format!(
                        "Current file contents:\n```text\n{}\n```",
                        truncate_chars(&contents, SIDECAR_CONTEXT_MAX_CHARS)
                    )),
                    Err(err) => sections.push(format!("Current file unavailable: {err}")),
                }
            }
        }
        _ => {}
    }

    sections.push(
        "Respond in plain text. Be direct. If the user asks which model you are, answer honestly as the sidecar provider you actually are."
            .to_string(),
    );

    sections.join("\n\n")
}

fn add_sidecar_login_hint(binary: &str, detail: &str) -> String {
    let lower = detail.to_lowercase();
    if lower.contains("login")
        || lower.contains("auth")
        || lower.contains("not logged")
        || lower.contains("api key")
        || lower.contains("authenticate")
    {
        format!("{detail}\n\nRun `{binary}` in Terminal once and complete login for this sidecar model.")
    } else {
        detail.to_string()
    }
}

async fn execute_sidecar_prompt(model: &str, directory: &str, prompt: &str) -> Result<String, String> {
    let (binary, args) = match model {
        "Claude" => (
            "claude",
            vec![
                "--print".to_string(),
                "--output-format".to_string(),
                "text".to_string(),
                "--permission-mode".to_string(),
                "plan".to_string(),
                prompt.to_string(),
            ],
        ),
        "GPT Review" => (
            "codex",
            vec![
                "exec".to_string(),
                "--skip-git-repo-check".to_string(),
                "--sandbox".to_string(),
                "read-only".to_string(),
                "--ephemeral".to_string(),
                "--color".to_string(),
                "never".to_string(),
                prompt.to_string(),
            ],
        ),
        "Gemini" => (
            "gemini",
            vec![
                "--prompt".to_string(),
                prompt.to_string(),
                "--approval-mode".to_string(),
                "plan".to_string(),
                "--output-format".to_string(),
                "text".to_string(),
            ],
        ),
        other => return Err(format!("unsupported sidecar model: {other}")),
    };

    let binary_path = resolve_cli_bin(binary);
    log::info!("run_sidecar_prompt: model={model}, cwd={directory}, bin={binary_path}");

    let mut command = TokioCommand::new(&binary_path);
    command
        .args(args)
        .current_dir(directory)
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("TERM", "dumb");

    let child = command
        .spawn()
        .map_err(|e| format!("failed to start {model} via {binary_path}: {e}"))?;

    let output = match timeout(Duration::from_secs(SIDECAR_TIMEOUT_SECS), child.wait_with_output()).await {
        Ok(result) => result.map_err(|e| format!("{model} execution failed: {e}"))?,
        Err(_) => return Err(format!(
            "{model} timed out after {SIDECAR_TIMEOUT_SECS} seconds. If this is the first run, open `{binary}` in Terminal once and make sure it is logged in."
        )),
    };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if output.status.success() {
        let text = if !stdout.is_empty() { stdout } else { stderr };
        if text.is_empty() {
            return Err(format!("{model} returned no output."));
        }
        Ok(text)
    } else {
        let detail = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("{model} exited with status {}", output.status)
        };
        Err(add_sidecar_login_hint(binary, &format!("{model} failed: {detail}")))
    }
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
    log::info!("create_session: project={project:?}, task={task:?}, dir={directory:?}");
    let id = sessions::generate_id();
    let tmux_name = id.clone();

    tmux::create_session(&tmux_name, &directory).map_err(|e| {
        log::error!("tmux create_session failed: {e}");
        e
    })?;

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
    log::info!("create_session: success, id={}", session.id);

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
    log::info!("connect_session: session_name={session_name}");
    state.pty_manager.connect(&session_name, channel).await.map_err(|e| {
        log::error!("connect_session failed: {e}");
        e
    })
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
    project: Option<String>,
    directory: Option<String>,
    spec_path: Option<String>,
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
        if let Some(p) = project {
            session.project = p;
        }
        if let Some(d) = directory {
            session.directory = d;
        }
        if let Some(sp) = spec_path {
            session.spec_path = Some(sp);
        }
        session.last_accessed_at = Utc::now();
    })
}

#[tauri::command]
async fn resize_pty(
    session_name: String,
    rows: u16,
    cols: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.pty_manager.resize(&session_name, rows, cols).await
}

#[tauri::command]
async fn run_sidecar_prompt(
    model: String,
    prompt: String,
    directory: String,
    session_name: Option<String>,
    context_action: Option<String>,
    current_file: Option<String>,
) -> Result<String, String> {
    let full_prompt = build_sidecar_prompt(
        &prompt,
        &directory,
        session_name.as_deref(),
        context_action.as_deref(),
        current_file.as_deref(),
    );
    execute_sidecar_prompt(&model, &directory, &full_prompt).await
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
fn read_file(path: String) -> Result<FileContents, String> {
    let canonical = fs::canonicalize(&path).map_err(|e| format!("failed to resolve {path}: {e}"))?;
    let content = fs::read_to_string(&canonical)
        .map_err(|e| format!("failed to read {}: {e}", canonical.display()))?;

    Ok(FileContents {
        path: canonical.to_string_lossy().into_owned(),
        content,
    })
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    let canonical = fs::canonicalize(&path).map_err(|e| format!("failed to resolve {path}: {e}"))?;
    fs::write(&canonical, content).map_err(|e| format!("failed to write {}: {e}", canonical.display()))
}

#[tauri::command]
fn get_pane_info(session_name: String) -> Result<tmux::PaneInfo, String> {
    tmux::get_pane_info(&session_name)
}

#[tauri::command]
fn tmux_scroll(session_name: String, lines: i32) -> Result<(), String> {
    tmux::scroll(&session_name, lines)
}

#[tauri::command]
fn tmux_cancel_copy_mode(session_name: String) {
    tmux::cancel_copy_mode(&session_name);
}

#[tauri::command]
fn check_file_exists(path: String) -> bool {
    std::path::Path::new(&path).is_file()
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

/// Fix environment for macOS GUI apps — they don't inherit shell env,
/// so PATH, TERM, LANG, and other essentials are missing.
fn fix_env() {
    // PATH — Homebrew binaries are invisible without this
    let current = std::env::var("PATH").unwrap_or_default();
    let additions = [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
    ];
    let mut parts: Vec<&str> = additions.to_vec();
    parts.extend(current.split(':'));
    std::env::set_var("PATH", parts.join(":"));

    // TERM — tmux needs this to know terminal capabilities
    std::env::set_var("TERM", "xterm-256color");

    // LANG — shell needs this for UTF-8 support
    if std::env::var("LANG").is_err() {
        std::env::set_var("LANG", "en_US.UTF-8");
    }

    // HOME — some tools need this explicitly
    if std::env::var("HOME").is_err() {
        if let Some(home) = dirs::home_dir() {
            std::env::set_var("HOME", home);
        }
    }

    // SHELL — tmux uses this to decide which shell to spawn
    if std::env::var("SHELL").is_err() {
        std::env::set_var("SHELL", "/bin/zsh");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    fix_env();
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
        .setup(|app| {
            // macOS requires a native Edit menu for Cmd+C/V/X to reach the webview
            // when window decorations are disabled.
            let menu = MenuBuilder::new(app)
                .item(
                    &SubmenuBuilder::new(app, "Edit")
                        .undo()
                        .redo()
                        .separator()
                        .cut()
                        .copy()
                        .paste()
                        .select_all()
                        .build()?,
                )
                .build()?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(drag_event) = event {
                match drag_event {
                    tauri::DragDropEvent::Enter { paths, .. } => {
                        let _ = window.emit("forge://drag-enter", &paths);
                    }
                    tauri::DragDropEvent::Drop { paths, .. } => {
                        let _ = window.emit("forge://drag-drop", &paths);
                    }
                    tauri::DragDropEvent::Leave => {
                        let _ = window.emit("forge://drag-leave", ());
                    }
                    _ => {}
                }
            }
        })
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
            get_pane_info,
            read_file,
            write_file,
            list_project_dirs,
            tmux_scroll,
            tmux_cancel_copy_mode,
            check_file_exists,
            run_sidecar_prompt,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
