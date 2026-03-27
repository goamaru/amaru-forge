# Forge Memory Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce Forge's memory footprint from ~4.8 GB (8 sessions) to ~1.3 GB by sharing MCP servers across sessions and reaping idle sessions with hibernation snapshots.

**Architecture:** Two features built in sequence. Phase 1: idle session reaper with hybrid detection and hibernation snapshots. Phase 2: shared MCP server pool with a connection-pooling proxy, wrapper scripts, and a bridge binary.

**Tech Stack:** Rust (Tauri v2), tokio async runtime, Unix domain sockets (nix crate), vanilla JavaScript (xterm.js + sidebar)

**Spec:** `docs/superpowers/specs/2026-03-22-forge-memory-management-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src-tauri/src/reaper.rs` | Idle session reaper: periodic scan, activity guard, hibernate snapshot capture, tmux kill |
| `src-tauri/src/mcp_pool.rs` | MCP server pool: spawn, heartbeat, restart, shutdown, Unix socket listener, connection relay, wrapper script generation |
| `src-tauri/src/bin/forge-mcp-bridge.rs` | Standalone binary: bridges stdio ↔ Unix socket, optional `--lock` for serialized Playwright access |

### Modified Files
| File | Changes |
|------|---------|
| `src-tauri/src/sessions.rs` | Add `HibernateSnapshot` struct, add `hibernate` field to `Session`, update existing test |
| `src-tauri/src/tmux.rs` | Add `capture_scrollback()`, `get_pane_command()`, `get_pane_pid()`. Modify `create_session()` to accept optional PATH override |
| `src-tauri/src/lib.rs` | Add `mod reaper; mod mcp_pool;`. Start reaper + pool in `.setup()`. Add `hibernated` to `SessionWithStatus`. Update `last_accessed_at` in `write_to_pty`/`connect_session`. Modify `restore_session` to clear hibernate. Add `hibernate` to `create_session` Session constructor |
| `src-tauri/Cargo.toml` | Add `nix` crate dependency, add `[[bin]]` target for forge-mcp-bridge |
| `src/js/sidebar.js` | Add "hibernated" CSS class and amber badge to `renderItem()` |
| `src/css/styles.css` | Add `.session-item.hibernated` style |
| `src/js/app.js` | Listen for `forge://session-hibernated` event, show toast, display snapshot on restore |

---

## Phase 1: Idle Session Reaper

### Task 1: Add HibernateSnapshot to sessions.rs

**Files:**
- Modify: `src-tauri/src/sessions.rs:1-22` (Session struct)

- [ ] **Step 1: Add the HibernateSnapshot struct and hibernate field**

In `src-tauri/src/sessions.rs`, add the struct after the existing `Session` struct and add the field:

```rust
/// Snapshot captured before an idle session is reaped.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HibernateSnapshot {
    pub working_directory: String,
    pub git_branch: Option<String>,
    pub foreground_command: String,
    pub scrollback: String,
    pub hibernated_at: DateTime<Utc>,
}
```

Add to `Session` struct (after `notes` field):

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hibernate: Option<HibernateSnapshot>,
```

- [ ] **Step 2: Update the existing test_roundtrip_serialize test**

In `src-tauri/src/sessions.rs`, update the test Session construction to include the new field:

```rust
    let session = Session {
        id: "forge-1234-abcd".to_string(),
        tmux_name: "forge-1234-abcd".to_string(),
        project: "test-project".to_string(),
        task: "coding".to_string(),
        directory: "/tmp".to_string(),
        pinned: false,
        created_at: Utc::now(),
        last_accessed_at: Utc::now(),
        spec_path: None,
        notes: Some("hello".to_string()),
        hibernate: None,
    };
```

- [ ] **Step 3: Add test for backward-compatible deserialization**

Add this test to the existing `mod tests` block in `sessions.rs`:

```rust
    #[test]
    fn test_deserialize_without_hibernate_field() {
        // Existing sessions.json files won't have the hibernate field.
        // serde(default) should handle this gracefully.
        let json = r#"{
            "version": 1,
            "defaultDir": "",
            "sessions": [{
                "id": "forge-1234-abcd",
                "tmuxName": "forge-1234-abcd",
                "project": "test",
                "task": "coding",
                "directory": "/tmp",
                "pinned": false,
                "createdAt": "2026-03-22T00:00:00Z",
                "lastAccessedAt": "2026-03-22T00:00:00Z"
            }]
        }"#;
        let store: SessionStore = serde_json::from_str(json).expect("should deserialize without hibernate");
        assert_eq!(store.sessions.len(), 1);
        assert!(store.sessions[0].hibernate.is_none());
    }
```

- [ ] **Step 4: Add test for hibernate serialization roundtrip**

```rust
    #[test]
    fn test_hibernate_snapshot_roundtrip() {
        let session = Session {
            id: "forge-5678-ef01".to_string(),
            tmux_name: "forge-5678-ef01".to_string(),
            project: "test".to_string(),
            task: "building".to_string(),
            directory: "/tmp".to_string(),
            pinned: false,
            created_at: Utc::now(),
            last_accessed_at: Utc::now(),
            spec_path: None,
            notes: None,
            hibernate: Some(HibernateSnapshot {
                working_directory: "/Users/owner/project".to_string(),
                git_branch: Some("main".to_string()),
                foreground_command: "claude".to_string(),
                scrollback: "$ claude\nHello!".to_string(),
                hibernated_at: Utc::now(),
            }),
        };

        let json = serde_json::to_string_pretty(&session).expect("serialize");
        assert!(json.contains("\"hibernate\""), "hibernate field should be present");
        assert!(json.contains("\"foregroundCommand\""), "should use camelCase");

        let parsed: Session = serde_json::from_str(&json).expect("deserialize");
        assert!(parsed.hibernate.is_some());
        assert_eq!(parsed.hibernate.unwrap().foreground_command, "claude");
    }
```

- [ ] **Step 5: Run tests**

Run: `cd /Users/owner/Desktop/Tech\ Tools/amaru-forge && cargo test -p app --lib sessions`
Expected: All 4 tests pass (generate_id, roundtrip_serialize, deserialize_without_hibernate, hibernate_snapshot_roundtrip)

- [ ] **Step 6: Commit**

```bash
cd "/Users/owner/Desktop/Tech Tools/amaru-forge"
git add src-tauri/src/sessions.rs
git commit -m "feat(sessions): add HibernateSnapshot struct for idle session reaper"
```

---

### Task 2: Add tmux helper functions for reaper

**Files:**
- Modify: `src-tauri/src/tmux.rs` (add 3 functions after `session_exists`)

- [ ] **Step 1: Add capture_scrollback function**

Add after `session_exists()` in `src-tauri/src/tmux.rs`:

```rust
/// Capture the last N lines of scrollback from a tmux pane.
pub fn capture_scrollback(session_name: &str, lines: i32) -> Result<String, String> {
    let output = Command::new(tmux_bin())
        .args([
            "capture-pane",
            "-t", session_name,
            "-p",
            "-S", &format!("-{lines}"),
        ])
        .output()
        .map_err(|e| format!("failed to spawn tmux: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux capture-pane failed: {stderr}"));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}
```

- [ ] **Step 2: Add get_pane_command function**

```rust
/// Get the foreground command running in a tmux session's active pane.
pub fn get_pane_command(session_name: &str) -> Result<String, String> {
    let output = Command::new(tmux_bin())
        .args([
            "display-message",
            "-p",
            "-t", session_name,
            "#{pane_current_command}",
        ])
        .output()
        .map_err(|e| format!("failed to spawn tmux: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux display-message failed: {stderr}"));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
```

- [ ] **Step 3: Add get_pane_pid function**

```rust
/// Get the PID of the foreground process in a tmux session's active pane.
/// Note: #{pane_pid} returns the shell PID, not the foreground child.
/// We use pgrep -P to find the actual foreground child process.
pub fn get_pane_pid(session_name: &str) -> Result<u32, String> {
    // First get the shell PID from tmux
    let output = Command::new(tmux_bin())
        .args([
            "display-message",
            "-p",
            "-t", session_name,
            "#{pane_pid}",
        ])
        .output()
        .map_err(|e| format!("failed to spawn tmux: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux display-message failed: {stderr}"));
    }

    let shell_pid: u32 = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .map_err(|e| format!("invalid pane pid: {e}"))?;

    // Try to find the foreground child process
    let child_output = Command::new("pgrep")
        .args(["-P", &shell_pid.to_string()])
        .output();

    if let Ok(co) = child_output {
        if co.status.success() {
            // pgrep may return multiple children; take the first
            if let Some(first_line) = String::from_utf8_lossy(&co.stdout).lines().next() {
                if let Ok(child_pid) = first_line.trim().parse::<u32>() {
                    return Ok(child_pid);
                }
            }
        }
    }

    // Fall back to shell PID if no child found (shell is the foreground process)
    Ok(shell_pid)
}
```

- [ ] **Step 4: Add tests for new functions**

Add to the existing `mod tests` block in `tmux.rs`:

```rust
    #[test]
    fn test_capture_scrollback() {
        if !is_available() {
            eprintln!("tmux not available, skipping");
            return;
        }
        let name = "forge-test-scrollback";
        let _ = kill_session(name);
        let tmp = std::env::temp_dir().to_string_lossy().to_string();
        create_session(name, &tmp).expect("create");

        let result = capture_scrollback(name, 10);
        assert!(result.is_ok(), "capture_scrollback should succeed");

        let _ = kill_session(name);
    }

    #[test]
    fn test_get_pane_command() {
        if !is_available() {
            eprintln!("tmux not available, skipping");
            return;
        }
        let name = "forge-test-panecmd";
        let _ = kill_session(name);
        let tmp = std::env::temp_dir().to_string_lossy().to_string();
        create_session(name, &tmp).expect("create");

        let cmd = get_pane_command(name);
        assert!(cmd.is_ok(), "get_pane_command should succeed");
        // Default shell should be zsh or bash
        let cmd_str = cmd.unwrap();
        assert!(!cmd_str.is_empty(), "command should not be empty");

        let _ = kill_session(name);
    }

    #[test]
    fn test_get_pane_pid() {
        if !is_available() {
            eprintln!("tmux not available, skipping");
            return;
        }
        let name = "forge-test-panepid";
        let _ = kill_session(name);
        let tmp = std::env::temp_dir().to_string_lossy().to_string();
        create_session(name, &tmp).expect("create");

        let pid = get_pane_pid(name);
        assert!(pid.is_ok(), "get_pane_pid should succeed");
        assert!(pid.unwrap() > 0, "pid should be positive");

        let _ = kill_session(name);
    }
```

- [ ] **Step 5: Run tests**

Run: `cd /Users/owner/Desktop/Tech\ Tools/amaru-forge && cargo test -p app --lib tmux`
Expected: All tmux tests pass (existing + 3 new)

- [ ] **Step 6: Commit**

```bash
cd "/Users/owner/Desktop/Tech Tools/amaru-forge"
git add src-tauri/src/tmux.rs
git commit -m "feat(tmux): add capture_scrollback, get_pane_command, get_pane_pid"
```

---

### Task 3: Create the reaper module

**Files:**
- Create: `src-tauri/src/reaper.rs`

- [ ] **Step 1: Create reaper.rs with constants and activity guard**

Create `src-tauri/src/reaper.rs`:

```rust
use crate::sessions::{self, HibernateSnapshot, SessionStore};
use crate::tmux;
use chrono::Utc;
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// How long a session must be UI-idle before it can be reaped.
const IDLE_TIMEOUT_MINUTES: i64 = 30;

/// How often the reaper scans for idle sessions.
const SCAN_INTERVAL_SECS: u64 = 60;

/// CPU threshold (lifetime-averaged %) below which a session is considered idle.
const CPU_THRESHOLD: f32 = 1.0;

/// Commands that indicate the session is actively doing work,
/// regardless of CPU usage.
const ACTIVE_COMMANDS: &[&str] = &[
    "node", "cargo", "python", "python3", "claude", "git",
    "npm", "pnpm", "yarn", "bun", "rustc", "gcc", "make",
];

/// Check if a foreground command name indicates active work.
fn is_active_command(cmd: &str) -> bool {
    let base = cmd.rsplit('/').next().unwrap_or(cmd);
    ACTIVE_COMMANDS.iter().any(|&c| base == c)
}

/// Get CPU usage of a process by PID.
/// Returns lifetime-averaged CPU percentage.
fn get_process_cpu(pid: u32) -> Result<f32, String> {
    let output = Command::new("ps")
        .args(["-o", "%cpu=", "-p", &pid.to_string()])
        .output()
        .map_err(|e| format!("ps failed: {e}"))?;

    if !output.status.success() {
        return Err("ps returned non-zero".to_string());
    }

    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f32>()
        .map_err(|e| format!("invalid cpu value: {e}"))
}

/// Capture a hibernation snapshot from a running tmux session.
fn capture_snapshot(tmux_name: &str, directory: &str) -> HibernateSnapshot {
    let working_directory = tmux::get_pane_info(tmux_name)
        .map(|info| info.current_path)
        .unwrap_or_else(|_| directory.to_string());

    let git_branch = crate::git::get_branch(&working_directory);

    let foreground_command = tmux::get_pane_command(tmux_name)
        .unwrap_or_default();

    let scrollback = tmux::capture_scrollback(tmux_name, 50)
        .unwrap_or_default();

    HibernateSnapshot {
        working_directory,
        git_branch,
        foreground_command,
        scrollback,
        hibernated_at: Utc::now(),
    }
}

/// Start the reaper background task.
/// Runs in a tokio task, scans every SCAN_INTERVAL_SECS.
pub fn start(app_handle: AppHandle) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(SCAN_INTERVAL_SECS)).await;
            run_scan(&app_handle);
        }
    });
}

/// Perform one scan of all sessions and reap idle ones.
fn run_scan(app_handle: &AppHandle) {
    let state = app_handle.state::<crate::AppState>();
    let mut store = match state.store.lock() {
        Ok(s) => s,
        Err(e) => {
            log::error!("reaper: lock error: {e}");
            return;
        }
    };

    let now = Utc::now();
    let mut changed = false;

    for session in store.sessions.iter_mut() {
        // Skip pinned, already hibernated, or dead sessions
        if session.pinned {
            continue;
        }
        if session.hibernate.is_some() {
            continue;
        }
        if !tmux::session_exists(&session.tmux_name) {
            continue;
        }

        // Check idle time
        let idle_minutes = (now - session.last_accessed_at).num_minutes();
        if idle_minutes < IDLE_TIMEOUT_MINUTES {
            continue;
        }

        // Activity guard: check foreground command
        if let Ok(cmd) = tmux::get_pane_command(&session.tmux_name) {
            if is_active_command(&cmd) {
                log::info!(
                    "reaper: skipping {} — active command: {cmd}",
                    session.id
                );
                continue;
            }
        }

        // Activity guard: check CPU usage
        if let Ok(pid) = tmux::get_pane_pid(&session.tmux_name) {
            if let Ok(cpu) = get_process_cpu(pid) {
                if cpu > CPU_THRESHOLD {
                    log::info!(
                        "reaper: skipping {} — CPU {cpu:.1}%",
                        session.id
                    );
                    continue;
                }
            }
        }

        // Hibernate: capture snapshot, then kill
        log::info!(
            "reaper: hibernating session {} (idle {idle_minutes}m)",
            session.id
        );
        let snapshot = capture_snapshot(&session.tmux_name, &session.directory);
        session.hibernate = Some(snapshot);

        let _ = tmux::kill_session(&session.tmux_name);
        let _ = app_handle.emit("forge://session-hibernated", &session.id);
        changed = true;
    }

    if changed {
        if let Err(e) = sessions::save(&store) {
            log::error!("reaper: save error: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_active_command() {
        assert!(is_active_command("node"));
        assert!(is_active_command("claude"));
        assert!(is_active_command("cargo"));
        assert!(is_active_command("python3"));
        assert!(!is_active_command("zsh"));
        assert!(!is_active_command("bash"));
        assert!(!is_active_command("cat"));
    }

    #[test]
    fn test_is_active_command_with_path() {
        // tmux sometimes returns full paths
        assert!(is_active_command("/opt/homebrew/bin/node"));
        assert!(is_active_command("/usr/bin/python3"));
        assert!(!is_active_command("/bin/zsh"));
    }
}
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/owner/Desktop/Tech\ Tools/amaru-forge && cargo test -p app --lib reaper`
Expected: 2 tests pass (is_active_command, is_active_command_with_path)

- [ ] **Step 3: Commit**

```bash
cd "/Users/owner/Desktop/Tech Tools/amaru-forge"
git add src-tauri/src/reaper.rs
git commit -m "feat(reaper): add idle session reaper with hybrid activity detection"
```

---

### Task 4: Integrate reaper into lib.rs

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add mod declaration**

In `src-tauri/src/lib.rs`, add after `mod tmux;` (line 6):

```rust
mod reaper;
```

- [ ] **Step 2: Add `hibernate` field to Session constructor in create_session**

In `create_session()` (around line 66-77), add `hibernate: None` to the Session struct literal:

```rust
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
        hibernate: None,
    };
```

- [ ] **Step 3: Add `hibernated` field to SessionWithStatus**

Modify the `SessionWithStatus` struct (around line 19-24):

```rust
pub struct SessionWithStatus {
    #[serde(flatten)]
    pub session: Session,
    pub alive: bool,
    pub hibernated: bool,
    pub branch: Option<String>,
}
```

Update `list_sessions()` to populate it (around line 94-98):

```rust
        result.push(SessionWithStatus {
            alive,
            hibernated: !alive && session.hibernate.is_some(),
            branch,
            session: session.clone(),
        });
```

- [ ] **Step 4: Update last_accessed_at in write_to_pty (debounced, in-memory only)**

Modify `write_to_pty` (around line 117-124). The function needs access to the store to update the timestamp in memory. Add a debounce — only update if >60s since last update:

```rust
#[tauri::command]
async fn write_to_pty(
    session_name: String,
    data: Vec<u8>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Debounced last_accessed_at update (in-memory only, no disk write)
    if let Ok(mut store) = state.store.lock() {
        if let Some(session) = store.sessions.iter_mut().find(|s| s.tmux_name == session_name) {
            let now = Utc::now();
            if (now - session.last_accessed_at).num_seconds() > 60 {
                session.last_accessed_at = now;
            }
        }
    }
    state.pty_manager.write(&session_name, &data).await
}
```

- [ ] **Step 5: Update last_accessed_at in connect_session**

Modify `connect_session` (around line 104-115):

```rust
#[tauri::command]
async fn connect_session(
    session_name: String,
    channel: Channel<Vec<u8>>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    log::info!("connect_session: session_name={session_name}");

    // Update last_accessed_at (with disk persist since this is infrequent)
    if let Ok(mut store) = state.store.lock() {
        if let Some(session) = store.sessions.iter_mut().find(|s| s.tmux_name == session_name) {
            session.last_accessed_at = Utc::now();
        }
        let _ = sessions::save(&store);
    }

    state.pty_manager.connect(&session_name, channel).await.map_err(|e| {
        log::error!("connect_session failed: {e}");
        e
    })
}
```

- [ ] **Step 6: Modify restore_session to clear hibernate field**

Update `restore_session` (around line 206-232). Change the update closure to clear hibernate:

```rust
    sessions::update_session(&mut store, &session_id, |s| {
        s.last_accessed_at = Utc::now();
        s.hibernate = None;
    })
```

- [ ] **Step 7: Start reaper in setup()**

In the `.setup()` closure (around line 351-368), add after `app.set_menu(menu)?;`:

```rust
            // Start idle session reaper
            reaper::start(app.handle().clone());
```

- [ ] **Step 8: Build to verify compilation**

Run: `cd /Users/owner/Desktop/Tech\ Tools/amaru-forge && cargo build -p app`
Expected: Compiles without errors

- [ ] **Step 9: Commit**

```bash
cd "/Users/owner/Desktop/Tech Tools/amaru-forge"
git add src-tauri/src/lib.rs
git commit -m "feat(lib): integrate reaper — last_accessed_at updates, hibernated state, startup"
```

---

### Task 5: Frontend — hibernated badge and toast

**Files:**
- Modify: `src/js/sidebar.js:115-133` (renderItem function)
- Modify: `src/css/styles.css:256-258` (add hibernated style)
- Modify: `src/js/app.js` (add event listener and toast)

- [ ] **Step 1: Add hibernated CSS class**

In `src/css/styles.css`, add after the `.session-item.disconnected` block (after line 258):

```css
.session-item.hibernated {
  opacity: 0.65;
  border-left-color: var(--yellow);
}

.session-item.hibernated .session-name::after {
  content: ' (hibernated)';
  font-size: 9px;
  color: var(--yellow);
  font-weight: 400;
}
```

- [ ] **Step 2: Update sidebar renderItem to handle hibernated state**

In `src/js/sidebar.js`, update the `renderItem` function (line 115-133). Replace the `isDisconnected` logic:

```javascript
function renderItem(s) {
  const isActive = s.id === activeSessionId;
  const isHibernated = s.hibernated === true;
  const isDisconnected = !s.alive && !isHibernated;
  const classes = [
    'session-item',
    isActive ? 'active' : '',
    isHibernated ? 'hibernated' : '',
    isDisconnected ? 'disconnected' : '',
  ].filter(Boolean).join(' ');

  const name = titleCase(s.task || s.project || 'Untitled');
  const meta = s.project || s.directory || '';
  const restoreIcon = (isDisconnected || isHibernated)
    ? '<span class="restore-icon" title="Restore">&#x21bb;</span>'
    : '';

  return `<div class="${classes}" data-id="${s.id}">
    <div class="session-name">${escapeHtml(name)}</div>
    <div class="session-meta">${escapeHtml(meta)}</div>
    ${restoreIcon}
  </div>`;
}
```

- [ ] **Step 3: Add toast notification for hibernated sessions**

In `src/js/app.js`, add after the `listen` imports at the top. First check if `listen` is already imported — if not, add it. Then in `startApp()`, add the event listener after `wirePanel()`:

```javascript
  // Listen for reaper hibernate events
  const { listen } = window.__TAURI__.event;
  await listen('forge://session-hibernated', async (event) => {
    const sessionId = event.payload;
    console.log('[app] session hibernated:', sessionId);
    showToast('Session hibernated due to inactivity');
    await refreshSessions();
  });
```

Add the `showToast` function if it doesn't already exist:

```javascript
function showToast(message, duration = 3000) {
  const existing = document.querySelector('.forge-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'forge-toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}
```

- [ ] **Step 4: Add toast CSS**

In `src/css/styles.css`, add at the end:

```css
/* ── Toast ────────────────────────────────────── */

.forge-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%) translateY(20px);
  background: var(--surface1);
  color: var(--text);
  padding: 10px 20px;
  border-radius: var(--radius);
  font-size: 12px;
  font-family: var(--font-ui);
  opacity: 0;
  transition: opacity 0.3s, transform 0.3s;
  z-index: 9999;
  pointer-events: none;
}

.forge-toast.visible {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
```

- [ ] **Step 5: Build frontend and app to verify**

Run: `cd /Users/owner/Desktop/Tech\ Tools/amaru-forge && node build.mjs && cargo build -p app`
Expected: Both build without errors

- [ ] **Step 6: Commit**

```bash
cd "/Users/owner/Desktop/Tech Tools/amaru-forge"
git add src/js/sidebar.js src/js/app.js src/css/styles.css
git commit -m "feat(frontend): add hibernated badge, toast notification for reaper"
```

---

### Task 6: Manual integration test for Phase 1

**Files:** None (testing only)

- [ ] **Step 1: Build and run the app**

Run: `cd /Users/owner/Desktop/Tech\ Tools/amaru-forge && cargo tauri dev`

- [ ] **Step 2: Verify compilation and startup**

Expected: App launches, existing sessions load (with `hibernate: None` defaulted), no console errors.

- [ ] **Step 3: Verify reaper logs**

Check the Tauri log output for reaper scan messages every 60 seconds:
- Should see `reaper: skipping <id> — active command: zsh` or similar for active sessions
- No sessions should be reaped yet (they were just accessed)

- [ ] **Step 4: Run all Rust tests**

Run: `cd /Users/owner/Desktop/Tech\ Tools/amaru-forge && cargo test -p app`
Expected: All tests pass

- [ ] **Step 5: Commit (if any fixes needed)**

Stage only the specific files that were fixed — do not use `git add -A`.

```bash
cd "/Users/owner/Desktop/Tech Tools/amaru-forge"
git add <specific-files-that-changed>
git commit -m "fix: phase 1 integration test fixes"
```

---

## Phase 2: Shared MCP Server Pool

### Task 7: Add nix dependency and bridge binary target

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add nix dependency**

In `src-tauri/Cargo.toml`, add to `[dependencies]`:

```toml
nix = { version = "0.29", features = ["signal", "process", "fs"] }
libc = "0.2"
```

- [ ] **Step 2: Add binary target for forge-mcp-bridge**

Add at the end of `src-tauri/Cargo.toml`:

```toml
[[bin]]
name = "forge-mcp-bridge"
path = "src/bin/forge-mcp-bridge.rs"
```

- [ ] **Step 3: Verify cargo check**

Run: `cd /Users/owner/Desktop/Tech\ Tools/amaru-forge && cargo check -p app`
Expected: Compiles (nix is resolved, bin target is declared but file doesn't exist yet — that's OK for `check`)

- [ ] **Step 4: Commit**

```bash
cd "/Users/owner/Desktop/Tech Tools/amaru-forge"
git add src-tauri/Cargo.toml
git commit -m "chore(deps): add nix crate, declare forge-mcp-bridge binary target"
```

---

### Task 8: Create forge-mcp-bridge binary

**Files:**
- Create: `src-tauri/src/bin/forge-mcp-bridge.rs`

- [ ] **Step 1: Create the bridge binary**

Create directory and file `src-tauri/src/bin/forge-mcp-bridge.rs`:

```rust
//! forge-mcp-bridge — bridges stdio ↔ Unix domain socket.
//!
//! Usage:
//!   forge-mcp-bridge <socket_path>
//!   forge-mcp-bridge --lock <lock_path> <socket_path>
//!
//! With --lock: acquires flock(2) exclusive lock before connecting.
//! This serializes access to stateful MCP servers (e.g., Playwright).

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::thread;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    let (lock_path, socket_path) = match args.as_slice() {
        [flag, lock, socket] if flag == "--lock" => (Some(lock.as_str()), socket.as_str()),
        [socket] => (None, socket.as_str()),
        _ => {
            eprintln!("Usage: forge-mcp-bridge [--lock <lock_path>] <socket_path>");
            std::process::exit(1);
        }
    };

    // Acquire lock if requested
    let _lock_file = if let Some(path) = lock_path {
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .open(path)
            .unwrap_or_else(|e| {
                eprintln!("forge-mcp-bridge: cannot open lock file {path}: {e}");
                std::process::exit(1);
            });

        // flock(2) — blocks until lock is acquired
        // nix 0.29 accepts impl AsFd, so pass &file directly
        nix::fcntl::flock(&file, nix::fcntl::FlockArg::LockExclusive)
            .unwrap_or_else(|e| {
            eprintln!("forge-mcp-bridge: flock failed: {e}");
            std::process::exit(1);
        });

        Some(file)
    } else {
        None
    };

    // Connect to Unix socket
    let stream = UnixStream::connect(socket_path).unwrap_or_else(|e| {
        eprintln!("forge-mcp-bridge: cannot connect to {socket_path}: {e}");
        std::process::exit(1);
    });

    let mut reader = stream.try_clone().unwrap_or_else(|e| {
        eprintln!("forge-mcp-bridge: clone failed: {e}");
        std::process::exit(1);
    });
    let mut writer = stream;

    // stdin → socket (in a thread)
    let stdin_handle = thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        let mut buf = [0u8; 4096];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if writer.write_all(&buf[..n]).is_err() {
                        break;
                    }
                    if writer.flush().is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // socket → stdout
    let mut stdout = io::stdout().lock();
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if stdout.write_all(&buf[..n]).is_err() {
                    break;
                }
                if stdout.flush().is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }

    let _ = stdin_handle.join();
    // _lock_file drops here, releasing flock
}
```

- [ ] **Step 2: Build the binary**

Run: `cd /Users/owner/Desktop/Tech\ Tools/amaru-forge && cargo build -p app --bin forge-mcp-bridge`
Expected: Compiles. Binary at `target/debug/forge-mcp-bridge`

- [ ] **Step 3: Smoke test the binary**

Run: `./target/debug/forge-mcp-bridge --help 2>&1 || true`
Expected: Prints usage and exits with code 1 (no socket provided)

- [ ] **Step 4: Commit**

```bash
cd "/Users/owner/Desktop/Tech Tools/amaru-forge"
mkdir -p src-tauri/src/bin
git add src-tauri/src/bin/forge-mcp-bridge.rs
git commit -m "feat(bridge): add forge-mcp-bridge binary for stdio↔socket bridging"
```

---

### Task 9: Create mcp_pool module

**Files:**
- Create: `src-tauri/src/mcp_pool.rs`

- [ ] **Step 1: Create mcp_pool.rs with server config and pool structs**

Create `src-tauri/src/mcp_pool.rs`:

```rust
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use tokio::sync::Mutex;

/// Configuration for a single MCP server type.
#[derive(Debug, Clone)]
pub struct McpServerConfig {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub max_pool_size: usize,
}

/// A single running MCP server process.
struct ServerInstance {
    child: Child,
    in_use: bool,
}

/// Pool of server instances for one MCP server type.
struct ServerPool {
    config: McpServerConfig,
    instances: Vec<ServerInstance>,
    listener: UnixListener,
    socket_path: PathBuf,
}

/// Manages all MCP server pools.
pub struct McpPool {
    base_dir: PathBuf,
    pools: Arc<Mutex<HashMap<String, ServerPool>>>,
}

impl McpPool {
    pub fn new() -> Self {
        let home = dirs::home_dir().expect("cannot determine home directory");
        let base_dir = home.join(".terminal-forge").join("mcp");
        Self {
            base_dir,
            pools: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Clean up stale sockets from a previous crash.
    pub fn cleanup_stale(&self) {
        let sock_dir = &self.base_dir;
        if !sock_dir.exists() {
            return;
        }

        // Check each .sock file — if the corresponding .pid file
        // references a dead process, remove the socket.
        let pids_dir = sock_dir.join("pids");
        if let Ok(entries) = fs::read_dir(sock_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map_or(false, |e| e == "sock") {
                    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
                    let pid_file = pids_dir.join(format!("{stem}.pid"));
                    if pid_file.exists() {
                        if let Ok(pid_str) = fs::read_to_string(&pid_file) {
                            if let Ok(pid) = pid_str.trim().parse::<i32>() {
                                // Check if process is alive
                                let alive = unsafe { libc::kill(pid, 0) } == 0;
                                if !alive {
                                    log::info!("mcp_pool: cleaning stale socket {}", path.display());
                                    let _ = fs::remove_file(&path);
                                    let _ = fs::remove_file(&pid_file);
                                }
                            }
                        }
                    } else {
                        // No PID file — orphaned socket
                        log::info!("mcp_pool: cleaning orphaned socket {}", path.display());
                        let _ = fs::remove_file(&path);
                    }
                }
            }
        }
    }

    /// Ensure directories exist.
    pub fn ensure_dirs(&self) -> Result<(), String> {
        fs::create_dir_all(self.base_dir.join("pids"))
            .map_err(|e| format!("cannot create mcp dir: {e}"))?;
        fs::create_dir_all(self.base_dir.join("bin"))
            .map_err(|e| format!("cannot create mcp/bin dir: {e}"))?;
        Ok(())
    }

    /// Copy the forge-mcp-bridge binary to ~/.terminal-forge/mcp/bin/.
    pub fn install_bridge(&self) -> Result<(), String> {
        let bridge_name = "forge-mcp-bridge";
        let dest = self.base_dir.join("bin").join(bridge_name);

        // Find the bridge binary next to the app binary
        let exe = std::env::current_exe()
            .map_err(|e| format!("cannot find current exe: {e}"))?;
        let exe_dir = exe.parent().ok_or("cannot find exe parent dir")?;
        let source = exe_dir.join(bridge_name);

        if !source.exists() {
            return Err(format!(
                "forge-mcp-bridge not found at {}. Build with: cargo build --bin forge-mcp-bridge",
                source.display()
            ));
        }

        fs::copy(&source, &dest)
            .map_err(|e| format!("cannot copy bridge binary: {e}"))?;

        // Make executable
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&dest, fs::Permissions::from_mode(0o755));
        }

        log::info!("mcp_pool: installed bridge to {}", dest.display());
        Ok(())
    }

    /// Generate the npx wrapper script.
    pub fn generate_wrapper_script(&self) -> Result<(), String> {
        let npx_path = self.base_dir.join("bin").join("npx");
        let socket_dir = self.base_dir.to_string_lossy();
        let bridge = self.base_dir.join("bin").join("forge-mcp-bridge");
        let bridge_str = bridge.to_string_lossy();

        // Find the real npx binary
        let real_npx = ["/opt/homebrew/bin/npx", "/usr/local/bin/npx"]
            .iter()
            .find(|p| std::path::Path::new(p).exists())
            .unwrap_or(&"/opt/homebrew/bin/npx");

        let script = format!(
            r#"#!/bin/bash
# Generated by Amaru Forge — do not edit
# Intercepts known MCP server launches and routes to shared pool
REAL_NPX="{real_npx}"
SOCKET_DIR="{socket_dir}"
BRIDGE="{bridge_str}"

case "$*" in
  *"@pinecone-database/mcp"*)
    exec "$BRIDGE" "$SOCKET_DIR/pinecone.sock" ;;
  *"@playwright/mcp"*)
    exec "$BRIDGE" --lock "$SOCKET_DIR/playwright.lock" "$SOCKET_DIR/playwright.sock" ;;
  *"context7-mcp"*|*"@upstash/context7-mcp"*)
    exec "$BRIDGE" "$SOCKET_DIR/context7.sock" ;;
  *)
    exec "$REAL_NPX" "$@" ;;
esac
"#
        );

        fs::write(&npx_path, script)
            .map_err(|e| format!("cannot write npx wrapper: {e}"))?;

        // Make executable
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&npx_path, fs::Permissions::from_mode(0o755));
        }

        log::info!("mcp_pool: generated wrapper at {}", npx_path.display());
        Ok(())
    }

    /// Load MCP server configs from ~/.claude/mcp.json and known plugins.
    pub fn load_configs(&self) -> Vec<McpServerConfig> {
        let mut configs = Vec::new();

        // Pinecone — from ~/.claude/mcp.json
        let home = dirs::home_dir().unwrap_or_default();
        let mcp_json_path = home.join(".claude").join("mcp.json");
        let mut pinecone_env = HashMap::new();

        if let Ok(contents) = fs::read_to_string(&mcp_json_path) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&contents) {
                if let Some(servers) = val.get("mcpServers") {
                    if let Some(pinecone) = servers.get("pinecone") {
                        if let Some(env) = pinecone.get("env").and_then(|e| e.as_object()) {
                            for (k, v) in env {
                                if let Some(s) = v.as_str() {
                                    pinecone_env.insert(k.clone(), s.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }

        configs.push(McpServerConfig {
            name: "pinecone".to_string(),
            command: "npx".to_string(),
            args: vec!["-y".to_string(), "@pinecone-database/mcp".to_string()],
            env: pinecone_env,
            max_pool_size: 3,
        });

        // Context7 — plugin
        configs.push(McpServerConfig {
            name: "context7".to_string(),
            command: "npx".to_string(),
            args: vec!["-y".to_string(), "@upstash/context7-mcp@latest".to_string()],
            env: HashMap::new(),
            max_pool_size: 3,
        });

        // Playwright — plugin
        configs.push(McpServerConfig {
            name: "playwright".to_string(),
            command: "npx".to_string(),
            args: vec!["-y".to_string(), "@playwright/mcp@latest".to_string()],
            env: HashMap::new(),
            max_pool_size: 1,
        });

        configs
    }

    /// Start a server pool for the given config.
    /// Binds a Unix socket and spawns an accept loop.
    pub async fn start_pool(&self, config: McpServerConfig) -> Result<(), String> {
        let socket_path = self.base_dir.join(format!("{}.sock", config.name));

        // Remove stale socket if exists
        let _ = fs::remove_file(&socket_path);

        let listener = UnixListener::bind(&socket_path)
            .map_err(|e| format!("cannot bind socket {}: {e}", socket_path.display()))?;

        // Set non-blocking for tokio compatibility
        listener.set_nonblocking(true)
            .map_err(|e| format!("cannot set non-blocking: {e}"))?;

        log::info!(
            "mcp_pool: listening on {} (max pool: {})",
            socket_path.display(),
            config.max_pool_size,
        );

        let pool = ServerPool {
            config: config.clone(),
            instances: Vec::new(),
            listener,
            socket_path: socket_path.clone(),
        };

        let name = config.name.clone();
        self.pools.lock().await.insert(name.clone(), pool);

        // Spawn accept loop
        let pools = self.pools.clone();
        let base_dir = self.base_dir.clone();
        tokio::spawn(async move {
            accept_loop(pools, name, base_dir).await;
        });

        Ok(())
    }

    /// Get the PATH prefix for wrapper scripts.
    pub fn bin_path(&self) -> PathBuf {
        self.base_dir.join("bin")
    }
}

impl Drop for McpPool {
    fn drop(&mut self) {
        // Kill all server instances and clean up sockets
        if let Ok(mut pools) = self.pools.try_lock() {
            for (_, pool) in pools.iter_mut() {
                for instance in &mut pool.instances {
                    let _ = instance.child.kill();
                }
                let _ = fs::remove_file(&pool.socket_path);
            }
        }
        // Clean up PID files
        let pids_dir = self.base_dir.join("pids");
        let _ = fs::remove_dir_all(&pids_dir);
    }
}

/// Accept loop: handles incoming connections from forge-mcp-bridge.
async fn accept_loop(
    pools: Arc<Mutex<HashMap<String, ServerPool>>>,
    name: String,
    base_dir: PathBuf,
) {
    loop {
        // Try to accept a connection
        let stream = {
            let pools_guard = pools.lock().await;
            let pool = match pools_guard.get(&name) {
                Some(p) => p,
                None => return,
            };
            match pool.listener.accept() {
                Ok((stream, _)) => Some(stream),
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => None,
                Err(e) => {
                    log::error!("mcp_pool({name}): accept error: {e}");
                    None
                }
            }
        };

        if let Some(client_stream) = stream {
            // Clone config before spawning — avoids re-acquiring lock in blocking thread
            let config = {
                let pools_guard = pools.lock().await;
                match pools_guard.get(&name) {
                    Some(p) => p.config.clone(),
                    None => return,
                }
            };
            let name_clone = name.clone();
            let base_clone = base_dir.clone();

            // Handle each connection in a separate blocking thread
            // since MCP stdio is synchronous
            tokio::task::spawn_blocking(move || {
                handle_connection(config, name_clone, base_clone, client_stream);
            });
        } else {
            // No connection ready — sleep briefly to avoid busy-loop
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }
}

/// Handle a single client connection: spawn a server, relay IO.
/// Config is passed directly to avoid deadlocks from re-acquiring the pool lock.
fn handle_connection(
    config: McpServerConfig,
    name: String,
    base_dir: PathBuf,
    mut client: UnixStream,
) {

    // Use the REAL npx (not our wrapper) to spawn the server
    let real_npx = ["/opt/homebrew/bin/npx", "/usr/local/bin/npx"]
        .iter()
        .find(|p| std::path::Path::new(p).exists())
        .unwrap_or(&"/opt/homebrew/bin/npx");

    let mut cmd = Command::new(real_npx);
    cmd.args(&config.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());

    for (k, v) in &config.env {
        cmd.env(k, v);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            log::error!("mcp_pool({name}): spawn failed: {e}");
            return;
        }
    };

    // Write PID file
    let pid_file = base_dir.join("pids").join(format!("{name}.pid"));
    let _ = fs::write(&pid_file, child.id().to_string());

    let mut server_stdin = child.stdin.take().expect("piped stdin");
    let mut server_stdout = child.stdout.take().expect("piped stdout");

    // Relay: client → server stdin
    let mut client_reader = match client.try_clone() {
        Ok(c) => c,
        Err(e) => {
            log::error!("mcp_pool({name}): clone client failed: {e}");
            let _ = child.kill();
            return;
        }
    };

    let name_c = name.clone();
    let stdin_thread = std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match client_reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if server_stdin.write_all(&buf[..n]).is_err() { break; }
                    if server_stdin.flush().is_err() { break; }
                }
                Err(_) => break,
            }
        }
        log::debug!("mcp_pool({name_c}): client→server relay ended");
    });

    // Relay: server stdout → client
    let mut buf = [0u8; 4096];
    loop {
        match server_stdout.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if client.write_all(&buf[..n]).is_err() { break; }
                if client.flush().is_err() { break; }
            }
            Err(_) => break,
        }
    }

    log::debug!("mcp_pool({name}): server→client relay ended");

    let _ = stdin_thread.join();
    let _ = child.kill();
    let _ = child.wait();
    let _ = fs::remove_file(&pid_file);
}
```

- [ ] **Step 2: Build to verify**

Run: `cd /Users/owner/Desktop/Tech\ Tools/amaru-forge && cargo build -p app`
Expected: Compiles (module not yet wired into lib.rs)

- [ ] **Step 3: Commit**

```bash
cd "/Users/owner/Desktop/Tech Tools/amaru-forge"
git add src-tauri/src/mcp_pool.rs
git commit -m "feat(mcp_pool): add MCP server pool with Unix socket proxy and wrapper generation"
```

---

### Task 10: Integrate mcp_pool into lib.rs and tmux.rs

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/tmux.rs`

- [ ] **Step 1: Add mod declaration**

In `src-tauri/src/lib.rs`, add after `mod reaper;`:

```rust
mod mcp_pool;
```

- [ ] **Step 2: Add McpPool to AppState**

In `lib.rs`, modify `AppState` (around line 34-37):

```rust
pub struct AppState {
    pub pty_manager: pty::PtyManager,
    pub store: Mutex<SessionStore>,
    pub mcp_pool: mcp_pool::McpPool,
}
```

Update the `.manage()` call in `run()` (around line 342-345):

```rust
        .manage(AppState {
            pty_manager: pty::PtyManager::new(),
            store: Mutex::new(store),
            mcp_pool: mcp_pool::McpPool::new(),
        })
```

- [ ] **Step 3: Start MCP pool in setup()**

In the `.setup()` closure, add after the reaper start:

```rust
            // Start MCP server pool
            let pool = app.state::<AppState>();
            pool.mcp_pool.cleanup_stale();
            if let Err(e) = pool.mcp_pool.ensure_dirs() {
                log::error!("mcp_pool setup: {e}");
            }
            if let Err(e) = pool.mcp_pool.install_bridge() {
                log::warn!("mcp_pool: bridge not installed: {e}");
            }
            if let Err(e) = pool.mcp_pool.generate_wrapper_script() {
                log::error!("mcp_pool: wrapper script failed: {e}");
            }

            // Start pools for each configured MCP server
            let configs = pool.mcp_pool.load_configs();
            let mcp_pool_ref = &pool.mcp_pool;
            let rt = tokio::runtime::Handle::current();
            for config in configs {
                let name = config.name.clone();
                if let Err(e) = rt.block_on(mcp_pool_ref.start_pool(config)) {
                    log::error!("mcp_pool: failed to start {name}: {e}");
                }
            }
```

- [ ] **Step 4: Modify tmux::create_session to prepend MCP bin to PATH**

In `src-tauri/src/tmux.rs`, modify `create_session` (around line 46-61):

```rust
/// Create a new detached tmux session with the given name and working directory.
/// If `mcp_bin_path` is Some, prepends it to PATH for MCP server interception.
pub fn create_session(name: &str, cwd: &str) -> Result<(), String> {
    let conf = config_path();

    // Prepend MCP wrapper bin dir to PATH if it exists
    let home = dirs::home_dir().unwrap_or_default();
    let mcp_bin = home.join(".terminal-forge").join("mcp").join("bin");
    let path_env = if mcp_bin.exists() {
        let current = std::env::var("PATH").unwrap_or_default();
        format!("{}:{current}", mcp_bin.display())
    } else {
        std::env::var("PATH").unwrap_or_default()
    };

    let output = Command::new(tmux_bin())
        .args(["-f", &conf, "new-session", "-d", "-s", name, "-c", cwd])
        .output()
        .map_err(|e| format!("failed to spawn tmux: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux new-session failed: {stderr}"));
    }

    // Inject MCP wrapper PATH into the tmux session's environment.
    // .env("PATH", ...) on the Command only affects the tmux process itself,
    // NOT the shell spawned inside the session. tmux set-environment persists
    // the PATH for all future windows/panes in this session.
    if mcp_bin.exists() {
        let _ = Command::new(tmux_bin())
            .args(["set-environment", "-t", name, "PATH", &path_env])
            .output();
    }

    disable_mouse(name);
    Ok(())
}
```

- [ ] **Step 5: Build to verify**

Run: `cd /Users/owner/Desktop/Tech\ Tools/amaru-forge && cargo build -p app`
Expected: Compiles without errors

- [ ] **Step 6: Run all tests**

Run: `cd /Users/owner/Desktop/Tech\ Tools/amaru-forge && cargo test -p app`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
cd "/Users/owner/Desktop/Tech Tools/amaru-forge"
git add src-tauri/src/lib.rs src-tauri/src/tmux.rs src-tauri/Cargo.toml
git commit -m "feat(lib): integrate MCP pool — startup, PATH injection, cleanup"
```

---

### Task 11: End-to-end integration test

**Files:** None (testing only)

- [ ] **Step 1: Build everything**

Run: `cd /Users/owner/Desktop/Tech\ Tools/amaru-forge && cargo build -p app && cargo build -p app --bin forge-mcp-bridge`

- [ ] **Step 2: Verify wrapper script was generated**

Run: `cat ~/.terminal-forge/mcp/bin/npx`
Expected: Shows the wrapper script with correct socket paths and bridge binary path

- [ ] **Step 3: Verify bridge binary was installed**

Run: `ls -la ~/.terminal-forge/mcp/bin/forge-mcp-bridge`
Expected: Executable binary exists

- [ ] **Step 4: Verify sockets are created**

Run: `ls -la ~/.terminal-forge/mcp/*.sock`
Expected: Three socket files (context7.sock, pinecone.sock, playwright.sock)

- [ ] **Step 5: Launch app and create a new session**

Run: `cd /Users/owner/Desktop/Tech\ Tools/amaru-forge && cargo tauri dev`
Create a new session. Verify in the tmux session that `which npx` points to `~/.terminal-forge/mcp/bin/npx`.

- [ ] **Step 6: Run all tests one final time**

Run: `cd /Users/owner/Desktop/Tech\ Tools/amaru-forge && cargo test -p app`
Expected: All tests pass

- [ ] **Step 7: Final commit**

Stage only files that changed during integration testing — do not use `git add -A`.

```bash
cd "/Users/owner/Desktop/Tech Tools/amaru-forge"
git add <specific-files-that-changed>
git commit -m "feat: complete MCP server pool + idle session reaper implementation"
```
