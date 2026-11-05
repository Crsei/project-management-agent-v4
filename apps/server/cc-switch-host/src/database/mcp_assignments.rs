use super::{lock_conn, Database};
use crate::{app_config::{AppType, McpServer}, error::AppError};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::collections::BTreeMap;

pub type Overrides = BTreeMap<String, BTreeMap<String, Value>>;
fn db_error(error: impl std::fmt::Display) -> AppError { AppError::Database(error.to_string()) }
fn write_override(conn: &Connection, id: &str, app: &str, patch: Option<&Value>) -> Result<(), AppError> {
    if let Some(patch) = patch {
        let sealed = crate::secret_codec::seal_override(id, app, patch).map_err(db_error)?;
        if !patch.is_object() { return Err(AppError::InvalidInput("Agent override must be an object".into())); }
        conn.execute("INSERT INTO mcp_agent_overrides (server_id,app,patch) VALUES (?1,?2,?3) ON CONFLICT(server_id,app) DO UPDATE SET patch=excluded.patch", params![id,app,sealed]).map_err(db_error)?;
    } else {
        conn.execute("DELETE FROM mcp_agent_overrides WHERE server_id=?1 AND app=?2", params![id,app]).map_err(db_error)?;
    }
    Ok(())
}
impl Database {
    pub fn get_mcp_overrides(&self) -> Result<Overrides, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn.prepare("SELECT server_id,app,patch FROM mcp_agent_overrides ORDER BY server_id,app").map_err(db_error)?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))).map_err(db_error)?;
        let mut result = Overrides::new();
        for row in rows {
            let (id, app, sealed) = row.map_err(db_error)?;
            let patch = crate::secret_codec::open_override(&id, &app, &sealed).map_err(db_error)?;
            if !patch.is_object() { return Err(AppError::Database("Invalid protected override".into())); }
            result.entry(id).or_default().insert(app, patch);
        }
        Ok(result)
    }
    pub fn get_mcp_override(&self, id: &str, app: &AppType) -> Result<Option<Value>, AppError> {
        let conn = lock_conn!(self.conn);
        let sealed: Option<String> = conn.query_row("SELECT patch FROM mcp_agent_overrides WHERE server_id=?1 AND app=?2", params![id, app.as_str()], |row| row.get(0)).optional().map_err(db_error)?;
        sealed.map(|sealed| crate::secret_codec::open_override(id, app.as_str(), &sealed).map_err(db_error)).transpose()
    }
    pub fn effective_mcp_spec(&self, server: &McpServer, app: &AppType) -> Result<Value, AppError> {
        Ok(crate::mcp_management::effective(&server.server, self.get_mcp_override(&server.id, app)?.as_ref()))
    }
    // Used inside the original native adapters' rollback closures. Flags and the
    // optional override change become visible in the same SQLite transaction.
    pub fn save_mcp_assignment(&self, server: &McpServer, app: &AppType, change: Option<&Option<Value>>) -> Result<(), AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn.transaction().map_err(db_error)?;
        let column = Self::mcp_app_enabled_column(app).ok_or_else(|| AppError::InvalidInput("unsupported_app".into()))?;
        let affected = tx.execute(&format!("UPDATE mcp_servers SET {column}=?1 WHERE id=?2"), params![server.apps.is_enabled_for(app), server.id]).map_err(db_error)?;
        if affected != 1 { return Err(AppError::InvalidInput("unknown_server".into())); }
        if let Some(patch) = change { write_override(&tx, &server.id, app.as_str(), patch.as_ref())?; }
        tx.commit().map_err(db_error)
    }
    pub fn commit_mcp_import(&self, servers: &[McpServer], overrides: &[(String, String, Option<Value>)]) -> Result<(), AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn.transaction().map_err(db_error)?;
        for server in servers { Self::save_mcp_server_on(&tx, server)?; }
        for (id, app, patch) in overrides { write_override(&tx, id, app, patch.as_ref())?; }
        tx.commit().map_err(db_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn override_identity_is_unambiguous_and_bound_to_app() {
        crate::secret_codec::initialize_test_key();
        let sealed = crate::secret_codec::seal_override("server", "claude", &json!({"env":{"TOKEN":"fixture"}})).unwrap();
        assert!(crate::secret_codec::open_override("server", "codex", &sealed).is_err());
        assert!(crate::secret_codec::open("server", &sealed).is_err());
        assert!(crate::secret_codec::open_override("server:claude", "", &sealed).is_err());
        assert!(!sealed.contains("fixture"));
    }

    fn fixture() -> McpServer {
        serde_json::from_value(json!({"id":"shared","name":"Shared","server":{"command":"node","env":{"TOKEN":"base-fixture"}},"apps":{}})).unwrap()
    }
    #[test]
    fn definition_save_preserves_override_and_delete_removes_it() {
        let db = Database::memory().unwrap();
        let mut server = fixture();
        db.save_mcp_server(&server).unwrap();
        server.apps.claude = true;
        db.save_mcp_assignment(&server, &AppType::Claude, Some(&Some(json!({"env":{"TOKEN":"agent-fixture"}})))).unwrap();
        server.name = "Edited".into();
        db.save_mcp_server(&server).unwrap();
        assert_eq!(db.effective_mcp_spec(&server, &AppType::Claude).unwrap()["env"]["TOKEN"],"agent-fixture");
        assert_eq!(db.effective_mcp_spec(&server, &AppType::Codex).unwrap()["env"]["TOKEN"],"base-fixture");
        db.delete_mcp_server("shared").unwrap();
        assert!(db.get_mcp_overrides().unwrap().is_empty());
    }
    #[test]
    fn failed_import_rolls_back_every_definition_and_override() {
        let db = Database::memory().unwrap();
        let server = fixture();
        let invalid = vec![("shared".into(),"claude".into(),Some(json!({"env":{"TOKEN":"agent-fixture"}}))),("shared".into(),"codex".into(),Some(json!([])))];
        assert!(db.commit_mcp_import(&[server], &invalid).is_err());
        assert!(db.get_all_mcp_servers().unwrap().is_empty());
        assert!(db.get_mcp_overrides().unwrap().is_empty());
    }
    #[test]
    fn concurrent_assignments_keep_source_flags_and_separate_overrides() {
        use std::sync::{Arc, Barrier};
        let db = Arc::new(Database::memory().unwrap());
        db.save_mcp_server(&fixture()).unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let handles = [AppType::Claude,AppType::Codex].map(|app| {
            let db = db.clone(); let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut server = fixture();
                server.apps.set_enabled_for(&app,true);
                barrier.wait();
                db.save_mcp_assignment(&server,&app,Some(&Some(json!({"env":{"TARGET":app.as_str()}})))).unwrap();
            })
        });
        barrier.wait();
        for handle in handles { handle.join().unwrap(); }
        let server = db.get_all_mcp_servers().unwrap().shift_remove("shared").unwrap();
        assert!(server.apps.claude && server.apps.codex);
        assert_eq!(db.get_mcp_override("shared",&AppType::Claude).unwrap().unwrap()["env"]["TARGET"],"claude");
        assert_eq!(db.get_mcp_override("shared",&AppType::Codex).unwrap().unwrap()["env"]["TARGET"],"codex");
    }
}
