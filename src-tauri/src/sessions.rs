use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// A single managed terminal session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub tmux_name: String,
    pub project: String,
    pub task: String,
    pub directory: String,
    pub pinned: bool,
    pub created_at: DateTime<Utc>,
    pub last_accessed_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spec_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// Top-level JSON store on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStore {
    pub version: u32,
    pub default_dir: String,
    pub sessions: Vec<Session>,
}

impl Default for SessionStore {
    fn default() -> Self {
        Self {
            version: 1,
            default_dir: String::new(),
            sessions: Vec::new(),
        }
    }
}

/// Return the path to `~/.terminal-forge/sessions.json`.
fn store_path() -> PathBuf {
    let home = dirs::home_dir().expect("cannot determine home directory");
    home.join(".terminal-forge").join("sessions.json")
}

/// Load the session store from disk.
/// Returns a default empty store if the file is missing.
/// If the file is corrupt, backs it up to `.bak` and returns an empty store.
pub fn load() -> SessionStore {
    let path = store_path();
    if !path.exists() {
        return SessionStore::default();
    }

    match fs::read_to_string(&path) {
        Ok(contents) => match serde_json::from_str::<SessionStore>(&contents) {
            Ok(store) => store,
            Err(e) => {
                log::warn!("corrupt sessions.json, backing up: {e}");
                let bak = path.with_extension("json.bak");
                let _ = fs::copy(&path, &bak);
                SessionStore::default()
            }
        },
        Err(e) => {
            log::warn!("could not read sessions.json: {e}");
            SessionStore::default()
        }
    }
}

/// Save the session store to disk as pretty-printed JSON.
pub fn save(store: &SessionStore) -> Result<(), String> {
    let path = store_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("cannot create config dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(store)
        .map_err(|e| format!("cannot serialize store: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("cannot write sessions.json: {e}"))?;
    Ok(())
}

/// Generate a unique session ID: `forge-{unix_timestamp}-{random_hex4}`.
pub fn generate_id() -> String {
    use rand::Rng;
    let ts = Utc::now().timestamp();
    let hex: u16 = rand::thread_rng().gen();
    format!("forge-{ts}-{hex:04x}")
}

/// Add a session to the store and persist to disk.
pub fn add_session(store: &mut SessionStore, session: Session) -> Result<(), String> {
    store.sessions.push(session);
    save(store)
}

/// Remove a session by ID and persist to disk.
pub fn remove_session(store: &mut SessionStore, id: &str) -> Result<(), String> {
    store.sessions.retain(|s| s.id != id);
    save(store)
}

/// Update a session by ID using the provided closure, then persist.
pub fn update_session<F>(store: &mut SessionStore, id: &str, updater: F) -> Result<(), String>
where
    F: FnOnce(&mut Session),
{
    let session = store
        .sessions
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("session not found: {id}"))?;
    updater(session);
    save(store)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_id_format() {
        let id = generate_id();
        assert!(id.starts_with("forge-"), "id should start with 'forge-': {id}");
        let parts: Vec<&str> = id.splitn(3, '-').collect();
        assert_eq!(parts.len(), 3, "id should have 3 dash-separated parts");
        // second part should be a unix timestamp (numeric)
        assert!(parts[1].parse::<i64>().is_ok(), "second part should be numeric");
        // third part should be 4 hex chars
        assert_eq!(parts[2].len(), 4, "hex part should be 4 chars");
        assert!(
            u16::from_str_radix(parts[2], 16).is_ok(),
            "third part should be valid hex"
        );
    }

    #[test]
    fn test_roundtrip_serialize() {
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
        };

        let store = SessionStore {
            version: 1,
            default_dir: "/tmp".to_string(),
            sessions: vec![session],
        };

        let json = serde_json::to_string_pretty(&store).expect("serialize");
        let parsed: SessionStore = serde_json::from_str(&json).expect("deserialize");

        assert_eq!(parsed.version, 1);
        assert_eq!(parsed.sessions.len(), 1);
        assert_eq!(parsed.sessions[0].id, "forge-1234-abcd");
        assert_eq!(parsed.sessions[0].notes, Some("hello".to_string()));

        // Verify camelCase keys
        assert!(json.contains("\"createdAt\""), "should use camelCase: createdAt");
        assert!(json.contains("\"lastAccessedAt\""), "should use camelCase: lastAccessedAt");
        assert!(json.contains("\"tmuxName\""), "should use camelCase: tmuxName");
    }
}
