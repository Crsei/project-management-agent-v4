use crate::{app_config::{AppType, McpServer}, database::Database, host_context, services::{McpService, skill::{SkillService, SkillStorageLocation}}, store::AppState};
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{json, Value};
use std::{path::Path, str::FromStr, sync::Arc};
use tokio::sync::{mpsc, Mutex};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub id: String,
    pub command: String,
    #[serde(default = "empty_args")] pub args: Value,
}
fn empty_args() -> Value { json!({}) }
fn arg<T: DeserializeOwned>(args: &Value, name: &str) -> Result<T> {
    serde_json::from_value(args.get(name).cloned().ok_or_else(|| anyhow!("Missing command argument: {name}"))?)
        .with_context(|| format!("Invalid command argument: {name}"))
}
fn optional<T: DeserializeOwned>(args: &Value, name: &str) -> Result<Option<T>> {
    match args.get(name) { None | Some(Value::Null) => Ok(None), Some(value) => Ok(Some(serde_json::from_value(value.clone())?)) }
}
fn app(args: &Value, name: &str) -> Result<AppType> {
    let raw: String = arg(args, name)?;
    host_context::require_app(&raw)?;
    Ok(AppType::from_str(&raw)?)
}
fn encode(value: impl serde::Serialize) -> Result<Value> { Ok(serde_json::to_value(value)?) }

pub struct Host {
    state: AppState,
    skills: SkillService,
    /// Native operations are read/modify/write sequences. Keep their original
    /// inner lock order while serializing command-level multi-app mutations.
    operations: Mutex<()>,
    events: mpsc::Sender<Value>,
    management: std::sync::Mutex<crate::mcp_management::Management>,
}
impl Host {
    pub fn initialize(args: Value, events: mpsc::Sender<Value>) -> Result<(Arc<Self>, Value)> {
        let apps = host_context::initialize(serde_json::from_value(args)?)?;
        crate::settings::reload_settings()?;
        let db = Arc::new(Database::init()?);
        crate::proxy::http_client::init(None).map_err(|e| anyhow!(e))?;
        Ok((Arc::new(Self { state: AppState::new(db), skills: SkillService::new(), operations: Mutex::new(()), events, management: std::sync::Mutex::new(crate::mcp_management::Management::default()) }),
            json!({"initialized":true,"apps":apps})))
    }
    pub async fn invoke(&self, request: &Request) -> Result<Value> {
        let args = &request.args;
        if !args.is_object() { bail!("Command arguments must be an object"); }
        // Cancellation must not queue behind a download or another probe batch.
        if request.command == "cancel_mcp_connectivity_checks" {
            crate::services::mcp_connectivity::cancel_checks(&arg::<String>(args, "batchId")?);
            return Ok(Value::Null);
        }
        let _operation = self.operations.lock().await;
        match request.command.as_str() {
            "get_mcp_servers" => encode(McpService::get_all_servers(&self.state)?),
            "get_mcp_management" => encode(crate::mcp_management::get_management(&self.state)?),
            "save_mcp_definition" => {
                crate::mcp_management::save_definition(&self.state, arg(args, "definition")?)?;
                Ok(Value::Null)
            },
            "set_mcp_agent_configuration" => {
                // Omission preserves; explicit null clears. Do not use optional(),
                // which deliberately folds null and omission together elsewhere.
                let change = args.get("override").map(|value| if value.is_null() { None } else { Some(value.clone()) });
                crate::mcp_management::set_agent_configuration(&self.state, &arg::<String>(args, "serverId")?, app(args, "app")?, arg(args, "enabled")?, change.as_ref())?;
                Ok(Value::Null)
            },
            "preview_mcp_import" => encode(self.management.lock().map_err(|_| anyhow!("Management lock unavailable"))?.preview_import(&self.state)?),
            "apply_mcp_import" => encode(self.management.lock().map_err(|_| anyhow!("Management lock unavailable"))?.apply_import(&self.state, &arg::<String>(args, "previewId")?, arg(args, "selections")?)?),
            "upsert_mcp_server" => {
                let server: McpServer = arg(args, "server")?;
                crate::mcp::validation::validate_server_spec(&server.server)?;
                for target in server.apps.enabled_apps() { host_context::require_app(target.as_str())?; }
                McpService::upsert_server(&self.state, server)?;
                Ok(Value::Null)
            },
            "delete_mcp_server" => encode(McpService::delete_server(&self.state, &arg::<String>(args, "id")?)?),
            "toggle_mcp_app" => {
                McpService::toggle_app_locked(&self.state, &arg::<String>(args, "serverId")?, app(args, "app")?, arg(args, "enabled")?).await?;
                Ok(Value::Null)
            },
            "resync_mcp_to_apps" => {
                let apps: Option<Vec<String>> = optional(args, "apps")?;
                if let Some(ref names) = apps { for name in names { host_context::require_app(name)?; } }
                let targets = McpService::resync_targets(apps.as_deref())?;
                let mut outcomes = Vec::with_capacity(targets.len());
                for target in targets {
                    let _guard = self.state.app_switch_locks.lock_switch_for_app(target.as_str()).await;
                    outcomes.push(McpService::resync_app(&self.state, &target));
                }
                encode(outcomes)
            },
            "validate_mcp_command" => encode(crate::claude_mcp::validate_command_in_path(&arg::<String>(args, "cmd")?)?),
            "start_mcp_connectivity_checks" => {
                let ids: Vec<String> = arg(args, "serverIds")?;
                let servers = McpService::get_all_servers(&self.state)?;
                if ids.iter().any(|id| !servers.contains_key(id)) { bail!("Unknown MCP server"); }
                let selected = servers.into_iter().filter(|(id, _)| ids.contains(id)).map(|(_, server)| server).collect();
                let batch_id = uuid::Uuid::new_v4().to_string();
                let event_batch = batch_id.clone();
                let request_id = request.id.clone();
                let events = self.events.clone();
                crate::services::mcp_connectivity::start_checks_with_id(selected, batch_id.clone(), move |result| {
                    events.try_send(json!({"event":"mcp-connectivity","requestId":request_id,"data":{
                        "batchId":event_batch,"serverId":result.server_id,"connected":result.connected
                    }})).is_ok()
                });
                encode(batch_id)
            },
            "get_installed_skills" => encode(SkillService::get_all_installed(&self.state.db)?),
            "get_skill_backups" => encode(SkillService::list_backups()?),
            "delete_skill_backup" => { SkillService::delete_backup(&arg::<String>(args, "backupId")?)?; encode(true) },
            "install_skill_unified" => encode(self.skills.install(&self.state.db, &arg(args, "skill")?, &app(args, "currentApp")?).await?),
            "uninstall_skill_unified" => encode(SkillService::uninstall(&self.state.db, &arg::<String>(args, "id")?)?),
            "restore_skill_backup" => encode(SkillService::restore_from_backup(&self.state.db, &arg::<String>(args, "backupId")?, &app(args, "currentApp")?)?),
            "toggle_skill_app" => {
                SkillService::toggle_app(&self.state.db, &arg::<String>(args, "id")?, &app(args, "app")?, arg(args, "enabled")?)?;
                encode(true)
            },
            "scan_unmanaged_skills" => encode(SkillService::scan_unmanaged(&self.state.db)?),
            "import_skills_from_apps" => {
                let imports: Vec<crate::services::skill::ImportSkillSelection> = arg(args, "imports")?;
                for selection in &imports {
                    for target in selection.apps.enabled_apps() { host_context::require_app(target.as_str())?; }
                }
                encode(SkillService::import_from_apps(&self.state.db, imports)?)
            },
            "discover_available_skills" => encode(self.skills.discover_available_report(self.state.db.get_skill_repos()?, optional(args, "forceRefresh")?.unwrap_or(false)).await?),
            "discover_repo_skills" => {
                let owner: String = arg(args, "owner")?;
                let name: String = arg(args, "name")?;
                let repo = self.state.db.get_skill_repos()?.into_iter().find(|repo| repo.owner == owner && repo.name == name);
                match repo { Some(repo) => encode(self.skills.discover_repo(&repo).await), None => encode(crate::services::skill::SkillDiscoveryResult::default()) }
            },
            "check_skill_updates" => encode(self.skills.check_updates_report(&self.state.db).await?),
            "resync_skills_to_apps" => encode(SkillService::resync_all_apps(&self.state.db)),
            "update_skill" => encode(self.skills.update_skill(&self.state.db, &arg::<String>(args, "id")?).await?),
            "migrate_skill_storage" => {
                let target: SkillStorageLocation = arg(args, "target")?;
                if target == SkillStorageLocation::Unified && !host_context::has_native_targets() {
                    bail!("Project-private contexts cannot publish into native Unified storage");
                }
                encode(SkillService::migrate_storage(&self.state.db, target)?)
            },
            "get_cc_switch_skills_dir" => encode(crate::config::get_app_config_dir().join("skills").to_string_lossy()),
            "search_skills_sh" => encode(SkillService::search_skills_sh(&arg::<String>(args, "query")?, arg(args, "limit")?, arg(args, "offset")?).await?),
            "get_skill_repos" => encode(self.state.db.get_skill_repos()?),
            "add_skill_repo" => {
                let repo: crate::services::skill::SkillRepo = arg(args, "repo")?;
                SkillService::validate_repo_ref(&repo.owner, &repo.name, &repo.branch)?;
                self.state.db.save_skill_repo(&repo)?; encode(true)
            },
            "remove_skill_repo" => { self.state.db.delete_skill_repo(&arg::<String>(args, "owner")?, &arg::<String>(args, "name")?)?; encode(true) },
            "install_skills_from_zip" => {
                let path: String = arg(args, "zipPath")?;
                let path = host_context::uploaded_zip(Path::new(&path))?;
                encode(SkillService::install_from_zip(&self.state.db, &path, &app(args, "currentApp")?)?)
            },
            "get_settings" => encode(crate::settings::get_settings()),
            "save_settings" => {
                let patch: Value = arg(args, "settings")?;
                let patch = patch.as_object().ok_or_else(|| anyhow!("Settings must be an object"))?;
                let mut merged = serde_json::to_value(crate::settings::get_settings())?;
                let stored = merged.as_object_mut().expect("serialized management settings");
                for (name, value) in patch {
                    if !matches!(name.as_str(), "skillSyncMethod" | "skillStorageLocation" | "backupRetainCount" | "language" | "visibleApps") {
                        bail!("Setting is not host-managed");
                    }
                    stored.insert(name.clone(), value.clone());
                }
                let next: crate::settings::AppSettings = serde_json::from_value(merged)?;
                if next.skill_storage_location != crate::settings::get_skill_storage_location() {
                    bail!("Use migrate_skill_storage to change storage location");
                }
                crate::settings::update_settings(next)?; encode(true)
            },
            _ => bail!("Unknown or host-only management command"),
        }
    }
}

/// Only finite host-authored codes escape; upstream errors may quote secrets.
pub fn public_error_code(error: &anyhow::Error) -> &'static str {
    use crate::error::AppError;
    match error.downcast_ref::<AppError>() {
        Some(AppError::InvalidInput(reason)) => match reason.as_str() {
            "stale_import_preview" => "mcp_import_preview_stale",
            "invalid_import_preview" | "invalid_import_selection" => "mcp_import_selection_invalid",
            "conflicting_import_plan" | "missing_import_base_selection" | "unrepresentable_import_override" => "mcp_import_conflict",
            "invalid_override" | "invalid_configuration" | "invalid_server_id" => "mcp_configuration_incompatible",
            "unbound_target" => "mcp_target_unbound",
            _ => "COMMAND_FAILED",
        },
        Some(AppError::McpValidation(_)) => "mcp_configuration_incompatible",
        _ => "COMMAND_FAILED",
    }
}
