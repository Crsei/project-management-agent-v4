//! Selected upstream MCP/Skills schema and DAO assembly. Separate host schema
//! versioning deliberately rejects accidentally opening the desktop database.
use crate::error::AppError;
use rusqlite::Connection;
use std::{fs::{File, OpenOptions}, sync::Mutex};
use fs2::FileExt;
#[path = "../../../../vendor/cc-switch/src-tauri/src/database/dao/mcp.rs"]
mod mcp;
#[path = "../../../../vendor/cc-switch/src-tauri/src/database/dao/skills.rs"]
mod skills;
#[path = "../../../../vendor/cc-switch/src-tauri/src/database/dao/settings.rs"]
mod settings;
mod mcp_assignments;
macro_rules! lock_conn {
    ($mutex:expr) => { $mutex.lock().map_err(|e| AppError::Database(format!("Mutex lock failed: {e}")))? };
}
pub(crate) use lock_conn;
pub struct Database {
    pub(crate) conn: Mutex<Connection>,
    _context_lock: Option<File>,
}
const HOST_SCHEMA_VERSION: i64 = 2;
// These are the exact selected upstream v24 tables; Pi/OMP skill flags remain
// observations of native directories, NOT additional database columns.
const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS mcp_servers (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, server_config TEXT NOT NULL,
 description TEXT, homepage TEXT, docs TEXT, tags TEXT NOT NULL DEFAULT '[]',
 enabled_claude BOOLEAN NOT NULL DEFAULT 0, enabled_codex BOOLEAN NOT NULL DEFAULT 0,
 enabled_gemini BOOLEAN NOT NULL DEFAULT 0, enabled_grokbuild BOOLEAN NOT NULL DEFAULT 0,
 enabled_opencode BOOLEAN NOT NULL DEFAULT 0, enabled_mcode BOOLEAN NOT NULL DEFAULT 0,
 enabled_agy BOOLEAN NOT NULL DEFAULT 0, enabled_kimi BOOLEAN NOT NULL DEFAULT 0,
 enabled_dsh BOOLEAN NOT NULL DEFAULT 0, enabled_hermes BOOLEAN NOT NULL DEFAULT 0,
 enabled_pi BOOLEAN NOT NULL DEFAULT 0, enabled_omp BOOLEAN NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS mcp_agent_overrides (
 server_id TEXT NOT NULL, app TEXT NOT NULL, patch TEXT NOT NULL,
 PRIMARY KEY (server_id, app)
);
CREATE TABLE IF NOT EXISTS skills (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, directory TEXT NOT NULL,
 repo_owner TEXT, repo_name TEXT, repo_branch TEXT DEFAULT 'main', readme_url TEXT,
 enabled_claude BOOLEAN NOT NULL DEFAULT 0, enabled_codex BOOLEAN NOT NULL DEFAULT 0,
 enabled_gemini BOOLEAN NOT NULL DEFAULT 0, enabled_grokbuild BOOLEAN NOT NULL DEFAULT 0,
 enabled_opencode BOOLEAN NOT NULL DEFAULT 0, enabled_mcode BOOLEAN NOT NULL DEFAULT 0,
 enabled_agy BOOLEAN NOT NULL DEFAULT 0, enabled_kimi BOOLEAN NOT NULL DEFAULT 0,
 enabled_dsh BOOLEAN NOT NULL DEFAULT 0, enabled_hermes BOOLEAN NOT NULL DEFAULT 0,
 installed_at INTEGER NOT NULL DEFAULT 0, content_hash TEXT, updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS skill_repos (
 owner TEXT NOT NULL, name TEXT NOT NULL, branch TEXT NOT NULL DEFAULT 'main',
 enabled BOOLEAN NOT NULL DEFAULT 1, PRIMARY KEY (owner, name)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
"#;
impl Database {
    pub fn init() -> Result<Self, AppError> {
        let dir = crate::host_context::data_dir();
        let lock_path = dir.join(".host.lock");
        let mut options = OpenOptions::new(); options.read(true).write(true).create(true);
        #[cfg(unix)]
        { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let lock = options.open(&lock_path).map_err(|e| AppError::io(&lock_path, e))?;
        lock.try_lock_exclusive().map_err(|_| AppError::Message("Context is already owned by another host".into()))?;
        let path = dir.join("cc-switch.db");
        if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(AppError::Message("Database symlinks are refused".into()));
        }
        let conn = Connection::open(&path).map_err(|e| AppError::Database(e.to_string()))?;
        #[cfg(unix)]
        { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|e| AppError::io(&path, e))?; }
        let db = Self::from_connection(conn, Some(lock))?;
        // Authenticate before any secret-bearing record can be returned or changed.
        db.get_all_mcp_servers()?;
        if let Some(check) = db.get_setting("host_context_key_check")? {
            crate::secret_codec::open("$context-key-check", &check).map_err(|e| AppError::Database(e.to_string()))?;
        } else {
            let check = crate::secret_codec::seal("$context-key-check", &serde_json::json!({"host":1}))
                .map_err(|e| AppError::Database(e.to_string()))?;
            db.set_setting("host_context_key_check", &check)?;
        }
        db.init_default_skill_repos()?;
        Ok(db)
    }
    fn from_connection(conn: Connection, lock: Option<File>) -> Result<Self, AppError> {
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(|e| AppError::Database(e.to_string()))?;
        if version > HOST_SCHEMA_VERSION { return Err(AppError::Database("Unsupported headless schema version; restore a matching host build".into())); }
        conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;")
            .map_err(|e| AppError::Database(e.to_string()))?;
        if version == 0 {
            conn.execute_batch(SCHEMA).map_err(|e| AppError::Database(e.to_string()))?;
            conn.pragma_update(None, "user_version", HOST_SCHEMA_VERSION).map_err(|e| AppError::Database(e.to_string()))?;
        }
        if version == 1 {
            conn.execute_batch("CREATE TABLE mcp_agent_overrides (server_id TEXT NOT NULL, app TEXT NOT NULL, patch TEXT NOT NULL, PRIMARY KEY (server_id, app));")
                .map_err(|e| AppError::Database(e.to_string()))?;
            conn.pragma_update(None, "user_version", HOST_SCHEMA_VERSION).map_err(|e| AppError::Database(e.to_string()))?;
        }
        Ok(Self { conn: Mutex::new(conn), _context_lock: lock })
    }
    #[cfg(test)]
    pub fn memory() -> Result<Self, AppError> {
        crate::secret_codec::initialize_test_key();
        Self::from_connection(Connection::open_in_memory().map_err(|e| AppError::Database(e.to_string()))?, None)
    }
}
