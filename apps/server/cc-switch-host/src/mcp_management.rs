//! Headless management contracts over the copied source services. This module
//! never writes native files: all publication remains in McpService/adapters.
use crate::{app_config::{AppType, McpServer}, error::AppError, mcp::snapshot::{self, NativeSnapshot}, services::McpService, store::AppState};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

fn input(message: &'static str) -> AppError { AppError::InvalidInput(message.into()) }
pub fn merge_patch(target: &mut Value, patch: &Value) {
    if let Some(patch) = patch.as_object() {
        if !target.is_object() { *target = json!({}); }
        let object = target.as_object_mut().unwrap();
        for (key, value) in patch {
            if value.is_null() { object.remove(key); }
            else { merge_patch(object.entry(key.clone()).or_insert(Value::Null), value); }
        }
    } else { *target = patch.clone(); }
}
pub fn effective(base: &Value, patch: Option<&Value>) -> Value {
    let mut result = base.clone();
    if let Some(patch) = patch { merge_patch(&mut result, patch); }
    result
}

// Managed option values plus explicit tombstones. Native-only fields remain
// untouched, while clearing an override restores its inherited values.
pub fn native_projection_patch(spec: &Value, patch: Option<&Value>, previous: Option<&Value>) -> Value {
    fn overlay(target: &mut Value, patch: &Value) {
        if patch.is_object() && !target.is_object() { *target = json!({}); }
        if let (Some(target), Some(patch)) = (target.as_object_mut(), patch.as_object()) {
            for (key, value) in patch {
                if value.is_object() { overlay(target.entry(key.clone()).or_insert_with(|| json!({})), value); }
                else { target.insert(key.clone(), value.clone()); }
            }
        }
    }
    let mut result = spec.clone();
    if let Some(previous) = previous { overlay(&mut result, &difference(previous, spec)); }
    if let Some(patch) = patch { overlay(&mut result, patch); }
    result
}
fn normalized(spec: &Value) -> Value {
    let mut spec = spec.clone();
    if let Some(object) = spec.as_object_mut() {
        if !object.contains_key("type") { object.insert("type".into(), json!(if object.contains_key("url") { "http" } else { "stdio" })); }
        if object.get("type").and_then(Value::as_str) == Some("streamable-http") { object.insert("type".into(), json!("http")); }
    }
    spec
}
fn definition(server: &McpServer) -> Value {
    let mut value = serde_json::to_value(server).expect("serializable source MCP server");
    value.as_object_mut().unwrap().remove("apps");
    value
}
fn parse_definition(value: Value) -> Result<McpServer, AppError> {
    let object = value.as_object().ok_or_else(|| input("invalid_definition"))?;
    if object.contains_key("apps") || object.keys().any(|key| !matches!(key.as_str(), "id" | "name" | "server" | "description" | "homepage" | "docs" | "tags")) { return Err(input("invalid_definition")); }
    let mut value = value;
    value["apps"] = json!({});
    let server: McpServer = serde_json::from_value(value).map_err(|_| input("invalid_definition"))?;
    if server.id.is_empty() || server.name.is_empty() { return Err(input("invalid_definition")); }
    crate::mcp::validation::validate_server_spec(&server.server)?;
    Ok(server)
}
pub fn validate_mutation(state: &AppState, server: &McpServer) -> Result<(), AppError> {
    crate::mcp::validation::validate_server_spec(&server.server)?;
    let previous = state.db.get_all_mcp_servers()?.shift_remove(&server.id);
    for app in server.apps.enabled_apps().into_iter().chain(previous.iter().flat_map(|server| server.apps.enabled_apps())) {
        crate::host_context::require_app(app.as_str()).map_err(|_| input("unbound_target"))?;
        snapshot::validate_target_paths(&app)?;
        if server.apps.is_enabled_for(&app) { snapshot::validate(&app, &server.id, &state.db.effective_mcp_spec(server, &app)?)?; }
    }
    // Pi treats '-' and '_' as the same server name even before installation.
    if server.apps.pi {
        let name = server.id.replace('-', "_");
        if state.db.get_all_mcp_servers()?.values().any(|other| other.id != server.id && other.apps.pi && other.id.replace('-', "_") == name) { return Err(input("invalid_server_id")); }
    }
    Ok(())
}
pub fn save_definition(state: &AppState, value: Value) -> Result<(), AppError> {
    let mut server = parse_definition(value)?;
    if let Some(previous) = state.db.get_all_mcp_servers()?.shift_remove(&server.id) { server.apps = previous.apps; }
    McpService::upsert_server(state, server)
}
pub fn set_agent_configuration(state: &AppState, id: &str, app: AppType, enabled: bool, change: Option<&Option<Value>>) -> Result<(), AppError> {
    if change.is_some_and(|patch| patch.as_ref().is_some_and(|patch| !patch.is_object())) { return Err(input("invalid_override")); }
    McpService::toggle_app_configuration(state, id, app, enabled, change)
}
fn compatibility(app: &AppType, id: &str, spec: &Value) -> Value {
    let reason = if crate::mcp::validation::validate_server_spec(spec).is_err() { Some("invalid_configuration") }
    else if matches!(app, AppType::Pi | AppType::Dsh | AppType::Agy) && spec["type"] == "sse" { Some("unsupported_transport") }
    else {
        match snapshot::validate(app, id, spec) {
            Ok(()) => None,
            Err(_) if matches!(app, AppType::Pi | AppType::Dsh) => Some("invalid_server_id"),
            Err(_) => Some("invalid_configuration"),
        }
    };
    json!({"supported":reason.is_none(),"reason":reason})
}
pub fn get_management(state: &AppState) -> Result<Value, AppError> {
    let servers = McpService::get_all_servers(state)?;
    let overrides = state.db.get_mcp_overrides()?;
    // Exactly one scan for the entire snapshot, never one scan per server row.
    let native = snapshot::read_bound();
    let mut definitions = serde_json::Map::new();
    let mut configurations = serde_json::Map::new();
    for (id, server) in servers {
        definitions.insert(id.clone(), definition(&server));
        let mut apps = serde_json::Map::new();
        for target in &native {
            let app = &target.app;
            let patch = overrides.get(&id).and_then(|apps| apps.get(app.as_str()));
            let spec = effective(&server.server, patch);
            let enabled = server.apps.is_enabled_for(app);
            let compatibility = compatibility(app, &id, &spec);
            let native_enabled = target.entries.get(&id).is_some_and(|entry| entry.enabled);
            let (sync_state, reason) = if let Some(error) = target.error { ("error", Some(error)) }
                else if !enabled && native_enabled { ("pending", Some("native_configuration_differs")) }
                else if !enabled { ("unassigned", None) }
                else if !target.initialized() { ("unavailable", Some("native_not_initialized")) }
                else if compatibility["supported"] != true { ("error", Some("invalid_configuration")) }
                else { match target.matches(&id, &spec, Some(&native_projection_patch(&spec, patch, None))) {
                    Ok(true) => ("synced", None), Ok(false) => ("pending", Some("native_configuration_differs")), Err(_) => ("error", Some("native_comparison_failed")),
                } };
            apps.insert(app.as_str().into(), json!({"serverId":id,"app":app.as_str(),"enabled":enabled,"override":patch,"effective":spec,"compatibility":compatibility,"sync":{"state":sync_state,"reason":reason}}));
        }
        configurations.insert(id, Value::Object(apps));
    }
    Ok(json!({"definitions":definitions,"agentConfigurations":configurations,"boundApps":native.iter().map(|target| target.app.as_str()).collect::<Vec<_>>()}))
}

#[derive(Default)]
pub struct Management { preview: Option<ImportPlan> }
struct ImportPlan { id: String, entries: Vec<ImportEntry>, warnings: Vec<Value>, ssot: Value, native: Vec<NativeSnapshot> }
struct ImportEntry { id: String, app: AppType, server: McpServer, enabled: bool, classification: &'static str, conflicts: Vec<&'static str>, resolutions: Vec<&'static str> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportSelection { entry_id: String, resolution: String }
fn ssot_snapshot(state: &AppState) -> Result<Value, AppError> { Ok(json!({"servers":state.db.get_all_mcp_servers()?,"overrides":state.db.get_mcp_overrides()?})) }
fn warning(app: &AppType, message: &'static str) -> Value { json!({"app":app.as_str(),"message":message}) }
fn native_equal(a: &[NativeSnapshot], b: &[NativeSnapshot]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(a,b)| a.app == b.app && a.error == b.error && a.files == b.files)
}
// RFC 7396 difference. A target containing literal null cannot always be
// represented by a merge patch; round-trip validation below rejects that plan.
fn difference(base: &Value, target: &Value) -> Value {
    match (base.as_object(), target.as_object()) {
        (Some(base), Some(target)) => {
            let mut patch = serde_json::Map::new();
            for key in base.keys() { if !target.contains_key(key) { patch.insert(key.clone(), Value::Null); } }
            for (key, value) in target { if base.get(key) != Some(value) { patch.insert(key.clone(), base.get(key).map_or_else(|| value.clone(), |base| difference(base, value))); } }
            Value::Object(patch)
        }
        _ => target.clone(),
    }
}
impl Management {
    pub fn preview_import(&mut self, state: &AppState) -> Result<Value, AppError> {
        let ssot = ssot_snapshot(state)?;
        let native = snapshot::read_bound();
        let existing = state.db.get_all_mcp_servers()?;
        let overrides = state.db.get_mcp_overrides()?;
        let mut bases: BTreeMap<String, Value> = existing.iter().map(|(id,server)| (id.clone(), normalized(&server.server))).collect();
        let mut entries = Vec::new();
        let mut warnings = Vec::new();
        for target in &native {
            if let Some(error) = target.error {
                warnings.push(warning(&target.app, error));
                // A partially parsed or divergent target is not safe to import.
                continue;
            }
            for (id, entry) in &target.entries {
                if snapshot::validate(&target.app, id, &entry.spec).is_err() { warnings.push(warning(&target.app, "invalid_import_entry")); continue; }
                let spec = normalized(&entry.spec);
                let saved = existing.get(id);
                let saved_patch = overrides.get(id).and_then(|apps| apps.get(target.app.as_str()));
                let saved_effective = saved.map(|saved| effective(&saved.server, saved_patch));
                let (classification, conflicts, resolutions) = match bases.get(id) {
                    None => { bases.insert(id.clone(), spec.clone()); ("new", vec![], vec!["import", "skip"]) }
                    Some(base) if saved_effective.as_ref().unwrap_or(base) == &spec
                        || target.matches_configuration(id, saved_effective.as_ref().unwrap_or(base), Some(&native_projection_patch(saved_effective.as_ref().unwrap_or(base), saved_patch, None))).unwrap_or(false)
                        => ("duplicate", vec![], vec!["import", "skip"]),
                    Some(_) => ("conflict", vec![if saved.is_some() { "server_configuration_differs" } else { "same_id_native_configuration_differs" }], vec!["merge-override", "skip"]),
                };
                entries.push(ImportEntry { id: uuid::Uuid::new_v4().to_string(), app: target.app.clone(), server: McpServer { id:id.clone(), name:id.clone(), server:entry.spec.clone(), apps:Default::default(), description:None, homepage:None, docs:None, tags:vec![] }, enabled:entry.enabled, classification, conflicts, resolutions });
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        let value = json!({"previewId":id,"entries":entries.iter().map(|entry| json!({"entryId":entry.id,"sourceApp":entry.app.as_str(),"serverId":entry.server.id,"name":entry.server.name,"definition":definition(&entry.server),"enabled":entry.enabled,"classification":entry.classification,"conflicts":entry.conflicts,"resolutions":entry.resolutions})).collect::<Vec<_>>(),"warnings":warnings});
        self.preview = Some(ImportPlan { id, entries, warnings, ssot, native });
        Ok(value)
    }
    pub fn apply_import(&mut self, state: &AppState, preview_id: &str, selections: Vec<ImportSelection>) -> Result<Value, AppError> {
        let plan = self.preview.as_ref().filter(|plan| plan.id == preview_id).ok_or_else(|| input("invalid_import_preview"))?;
        if plan.ssot != ssot_snapshot(state)? || !native_equal(&plan.native, &snapshot::read_bound()) { return Err(input("stale_import_preview")); }
        let mut selected = BTreeMap::new();
        let by_id: BTreeMap<_,_> = plan.entries.iter().map(|entry| (entry.id.as_str(),entry)).collect();
        for selection in selections {
            let entry = by_id.get(selection.entry_id.as_str()).ok_or_else(|| input("invalid_import_selection"))?;
            if !entry.resolutions.contains(&selection.resolution.as_str()) || selected.insert(selection.entry_id, selection.resolution).is_some() { return Err(input("invalid_import_selection")); }
        }
        let mut servers = state.db.get_all_mcp_servers()?;
        let current_overrides = state.db.get_mcp_overrides()?;
        let mut patches = Vec::new();
        let mut changed = BTreeSet::new();
        let mut assignments = BTreeSet::new();
        let mut applied = 0;
        // Establish explicitly approved new bases before processing dependents,
        // regardless of browser selection order.
        for entry in &plan.entries {
            if entry.classification == "new" && selected.get(&entry.id).is_some_and(|resolution| resolution == "import") {
                if servers.contains_key(&entry.server.id) { return Err(input("conflicting_import_plan")); }
                servers.insert(entry.server.id.clone(), entry.server.clone());
            }
        }
        for entry in &plan.entries {
            let Some(resolution) = selected.get(&entry.id).filter(|resolution| resolution.as_str() != "skip") else { continue; };
            crate::host_context::require_app(entry.app.as_str()).map_err(|_| input("unbound_target"))?;
            if !assignments.insert((entry.server.id.clone(), entry.app.as_str())) { return Err(input("conflicting_import_plan")); }
            let saved = servers.get_mut(&entry.server.id).ok_or_else(|| input("missing_import_base_selection"))?;
            let previous_patch = current_overrides.get(&saved.id).and_then(|apps| apps.get(entry.app.as_str()));
            let patch = if resolution == "merge-override" {
                let patch = difference(&saved.server, &entry.server.server);
                if !patch.is_object() || effective(&saved.server, Some(&patch)) != entry.server.server { return Err(input("unrepresentable_import_override")); }
                Some(patch)
            } else {
                let effective = effective(&saved.server, previous_patch);
                let target = plan.native.iter().find(|target| target.app == entry.app).ok_or_else(|| input("conflicting_import_plan"))?;
                if normalized(&effective) != normalized(&entry.server.server)
                    && !target.matches_configuration(&saved.id, &effective, Some(&native_projection_patch(&effective, previous_patch, None)))? { return Err(input("conflicting_import_plan")); }
                previous_patch.cloned()
            };
            let spec = effective(&saved.server, patch.as_ref());
            snapshot::validate(&entry.app, &saved.id, &spec)?;
            saved.apps.set_enabled_for(&entry.app, entry.enabled);
            patches.push((saved.id.clone(), entry.app.as_str().into(), patch));
            changed.insert(saved.id.clone());
            applied += 1;
        }
        let mut pi_names = BTreeSet::new();
        for server in servers.values().filter(|server| server.apps.pi) { if !pi_names.insert(server.id.replace('-', "_")) { return Err(input("conflicting_import_plan")); } }
        // No native write occurs between approval and the single SSOT commit.
        // Recheck after planning too, so changing files during a large plan fails.
        if plan.ssot != ssot_snapshot(state)? || !native_equal(&plan.native, &snapshot::read_bound()) { return Err(input("stale_import_preview")); }
        let changed: Vec<_> = servers.into_iter().filter(|(id,_)| changed.contains(id)).map(|(_,server)| server).collect();
        if applied > 0 { state.db.commit_mcp_import(&changed, &patches)?; }
        let result = json!({"applied":applied,"skipped":plan.entries.len()-applied,"warnings":plan.warnings});
        self.preview = None;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn merge_patch_keeps_inheritance_removes_keys_and_replaces_arrays() {
        let base = json!({"command":"node","env":{"INHERIT":"yes","REMOVE":"old"},"args":["base"],"extra":{"keep":1}});
        let patch = json!({"env":{"REMOVE":null,"ADD":"new"},"args":["agent"]});
        assert_eq!(effective(&base, Some(&patch)), json!({"command":"node","env":{"INHERIT":"yes","ADD":"new"},"args":["agent"],"extra":{"keep":1}}));
        assert_eq!(effective(&base, None), base);
        assert_eq!(effective(&base, Some(&json!({}))), base);
    }
    #[test]
    fn import_difference_preserves_explicit_removal_and_nested_values() {
        let base = json!({"command":"node","env":{"A":"a","B":"b"},"args":["old"]});
        let native = json!({"command":"python","env":{"A":"changed"},"args":["new"]});
        let patch = difference(&base, &native);
        assert_eq!(patch["env"]["B"], Value::Null);
        assert_eq!(effective(&base, Some(&patch)), native);
    }
}
