//! Persisted management-only settings. Paths are host authority, never settings.
use crate::{error::AppError, services::skill::{SkillStorageLocation, SyncMethod}};
use serde::{Serialize, Deserialize};
use std::{collections::BTreeMap, path::PathBuf, sync::{OnceLock, RwLock}};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomEndpoint {
    pub url: String,
    pub added_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used: Option<i64>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct AppSettings {
    pub skill_sync_method: SyncMethod,
    pub skill_storage_location: SkillStorageLocation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_retain_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default)]
    pub visible_apps: BTreeMap<String, bool>,
    #[serde(skip)] pub claude_config_dir: Option<String>,
    #[serde(skip)] pub codex_config_dir: Option<String>,
    #[serde(skip)] pub gemini_config_dir: Option<String>,
    #[serde(skip)] pub grok_config_dir: Option<String>,
    #[serde(skip)] pub opencode_config_dir: Option<String>,
    #[serde(skip)] pub hermes_config_dir: Option<String>,
    #[serde(skip)] pub pi_config_dir: Option<String>,
    #[serde(skip)] pub omp_config_dir: Option<String>,
    #[serde(skip)] pub openclaw_config_dir: Option<String>,
}
static SETTINGS: OnceLock<RwLock<AppSettings>> = OnceLock::new();
fn store() -> &'static RwLock<AppSettings> { SETTINGS.get_or_init(|| RwLock::new(AppSettings::default())) }
pub fn reload_settings() -> Result<(), AppError> {
    let path = crate::config::get_app_config_dir().join("settings.json");
    let next = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| AppError::json(&path, e))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => AppSettings::default(),
        Err(e) => return Err(AppError::io(&path, e)),
    };
    *store().write().map_err(|e| AppError::Message(e.to_string()))? = next;
    Ok(())
}
pub fn get_settings() -> AppSettings { store().read().unwrap_or_else(|p| p.into_inner()).clone() }
pub fn update_settings(next: AppSettings) -> Result<(), AppError> {
    let mut guard = store().write().map_err(|e| AppError::Message(e.to_string()))?;
    crate::config::write_json_file_private(&crate::config::get_app_config_dir().join("settings.json"), &next)?;
    *guard = next;
    Ok(())
}
pub fn get_skill_sync_method() -> SyncMethod {
    store().read().unwrap_or_else(|p| p.into_inner()).skill_sync_method
}
pub fn get_skill_storage_location() -> SkillStorageLocation {
    store().read().unwrap_or_else(|p| p.into_inner()).skill_storage_location
}
pub fn set_skill_storage_location(location: SkillStorageLocation) -> Result<(), AppError> {
    let mut guard = store().write().map_err(|e| AppError::Message(e.to_string()))?;
    let previous = guard.skill_storage_location;
    guard.skill_storage_location = location;
    if let Err(error) = crate::config::write_json_file_private(
        &crate::config::get_app_config_dir().join("settings.json"), &*guard,
    ) {
        guard.skill_storage_location = previous;
        return Err(error);
    }
    Ok(())
}
pub fn effective_backup_retain_count() -> usize {
    store().read().unwrap_or_else(|p| p.into_inner()).backup_retain_count
        .map(|n| (n as usize).max(1)).unwrap_or(10)
}
pub fn resolve_override_path(raw: &str) -> PathBuf { PathBuf::from(raw) }
macro_rules! roots {
    ($($name:ident => ($app:literal, $field:ident)),* $(,)?) => {
        $(pub fn $name() -> Option<PathBuf> {
            #[cfg(test)]
            { return get_settings().$field.map(PathBuf::from); }
            #[cfg(not(test))]
            { Some(crate::host_context::app_dir($app)) }
        })*
    };
}
roots! {
    get_claude_override_dir => ("claude", claude_config_dir),
    get_codex_override_dir => ("codex", codex_config_dir),
    get_gemini_override_dir => ("gemini", gemini_config_dir),
    get_grok_override_dir => ("grokbuild", grok_config_dir),
    get_opencode_override_dir => ("opencode", opencode_config_dir),
    get_hermes_override_dir => ("hermes", hermes_config_dir),
    get_pi_override_dir => ("pi", pi_config_dir),
    get_omp_override_dir => ("omp", omp_config_dir),
    get_openclaw_override_dir => ("openclaw", openclaw_config_dir),
}
