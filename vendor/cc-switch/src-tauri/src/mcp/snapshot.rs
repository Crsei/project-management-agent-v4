//! Read-only native snapshots. Never call an adapter's read/modify/write helper
//! here: in particular OMP's historical import reader takes a write path.
use crate::{app_config::AppType, error::AppError};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::{Path, PathBuf}, sync::Arc};

#[derive(Clone, PartialEq, Eq)]
pub struct FileSnapshot { pub path: PathBuf, pub bytes: Option<Arc<[u8]>> }
#[derive(Clone)]
pub struct NativeEntry { pub spec: Value, pub enabled: bool }
#[derive(Clone)]
pub struct NativeSnapshot {
    pub app: AppType,
    pub files: Vec<FileSnapshot>,
    pub entries: BTreeMap<String, NativeEntry>,
    pub error: Option<&'static str>,
    documents: Vec<Value>,
}
fn invalid() -> AppError { AppError::Config("invalid_native_configuration".into()) }
fn json_document(app: &AppType, text: &str) -> Result<Value, AppError> {
    let value = match app {
        AppType::Codex | AppType::GrokBuild => serde_json::to_value(toml::from_str::<toml::Table>(text).map_err(|_| invalid())?).map_err(|_| invalid())?,
        AppType::Hermes => serde_json::to_value(serde_yaml::from_str::<serde_yaml::Value>(text).map_err(|_| invalid())?).map_err(|_| invalid())?,
        AppType::OpenCode => crate::jsonc_document::JsoncDocument::parse(text)?.value().clone(),
        _ => serde_json::from_str(text).map_err(|_| invalid())?,
    };
    if !value.is_object() { return Err(invalid()); }
    Ok(value)
}
fn paths(app: &AppType) -> Result<Vec<PathBuf>, AppError> {
    let root = crate::host_context::app_dir(app.as_str());
    Ok(match app {
        AppType::Claude => vec![crate::config::get_claude_mcp_path()],
        AppType::Codex | AppType::GrokBuild => vec![root.join("config.toml")],
        AppType::Gemini => vec![root.join("settings.json")],
        AppType::OpenCode => vec![crate::opencode_config::get_opencode_config_path()?],
        AppType::Hermes => vec![root.join("config.yaml")],
        AppType::Agy => vec![root.join("mcp_config.json")],
        AppType::Dsh => crate::dsh_config::target_paths(),
        AppType::Pi | AppType::Omp | AppType::Mcode | AppType::Kimi => vec![root.join("mcp.json")],
        _ => return Err(invalid()),
    })
}
pub fn validate_target_paths(app: &AppType) -> Result<(), AppError> {
    crate::host_context::require_app(app.as_str()).map_err(|_| AppError::InvalidInput("unbound_target".into()))?;
    for path in paths(app)? {
        crate::host_context::require_native_read_path(app.as_str(), &path).map_err(|_| AppError::Config("native_read_failed".into()))?;
    }
    Ok(())
}
fn section(app: &AppType) -> &'static str {
    match app { AppType::Codex | AppType::GrokBuild | AppType::Hermes => "mcp_servers", AppType::OpenCode => "mcp", _ => "mcpServers" }
}
fn decode(app: &AppType, id: &str, native: &Value, document: &Value) -> Result<NativeEntry, AppError> {
    if !native.is_object() { return Err(invalid()); }
    let enabled = match app {
        AppType::Agy | AppType::Dsh => native["disabled"] != true,
        AppType::Omp => super::omp::native_enabled(document, id, native),
        _ => native["enabled"] != false,
    };
    let mut spec = match app {
        AppType::Gemini => {
            let mut spec = native.clone();
            crate::gemini_mcp::normalize_native_spec(&mut spec);
            spec
        }
        AppType::OpenCode => super::opencode::convert_from_opencode_format(native)?,
        AppType::Hermes => super::hermes::convert_from_hermes_format(id, native)?,
        AppType::Mcode => super::mcode::unified_spec(native),
        AppType::Kimi => super::kimi::unified_spec(native),
        AppType::Agy => super::agy::unified_spec(native),
        AppType::Pi | AppType::Omp => super::pi::unified_spec(native),
        AppType::Dsh => {
            let mut spec = native["config"].clone();
            let object = spec.as_object_mut().ok_or_else(invalid)?;
            let transport = object.remove("transport");
            object.remove("serverName");
            object.insert("type".into(), match transport.as_ref().and_then(Value::as_str) {
                Some("stdio") => json!("stdio"), Some("streamable-http") => json!("http"), _ => return Err(invalid()),
            });
            spec
        }
        AppType::Codex | AppType::GrokBuild => {
            let mut spec = native.clone();
            let object = spec.as_object_mut().unwrap();
            if let Some(headers) = object.remove("http_headers") { object.insert("headers".into(), headers); }
            if !object.contains_key("type") {
                object.insert("type".into(), json!(if object.contains_key("url") { "http" } else { "stdio" }));
            }
            spec
        }
        _ => native.clone(),
    };
    // Assignment state is not part of the shared connection definition.
    if let Some(object) = spec.as_object_mut() { object.remove("enabled"); object.remove("disabled"); }
    super::validation::validate_server_spec(&spec)?;
    Ok(NativeEntry { spec, enabled })
}
type ReadCache = BTreeMap<PathBuf, Result<Option<Arc<[u8]>>, ()>>;
fn cached_read(cache: &mut ReadCache, path: &Path) -> Result<Option<Arc<[u8]>>, ()> {
    let identity = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    cache.entry(identity).or_insert_with(|| match fs::read(path) {
        Ok(bytes) => Ok(Some(Arc::from(bytes))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(()),
    }).clone()
}
pub fn read_bound() -> Vec<NativeSnapshot> {
    let mut cache = ReadCache::new();
    crate::services::McpService::live_sync_apps().into_iter().map(|app| {
        let mut snapshot = NativeSnapshot { app: app.clone(), files: vec![], entries: BTreeMap::new(), error: None, documents: vec![] };
        let paths = match paths(&app) { Ok(paths) => paths, Err(_) => { snapshot.error = Some("native_read_failed"); return snapshot; } };
        for path in paths {
            if crate::host_context::require_native_read_path(app.as_str(), &path).is_err() {
                snapshot.error = Some("native_read_failed");
                continue;
            }
            // Physical aliases (DSH profiles in particular) are read once.
            let bytes = match cached_read(&mut cache, &path) { Ok(bytes) => bytes, Err(_) => { snapshot.error = Some("native_read_failed"); continue; } };
            snapshot.files.push(FileSnapshot { path, bytes: bytes.clone() });
            let Some(bytes) = bytes else { snapshot.documents.push(json!({})); continue; };
            let parsed = (|| {
                let text = std::str::from_utf8(&bytes).map_err(|_| invalid())?;
                if app == AppType::Dsh {
                    let mut servers = serde_json::Map::new();
                    for entry in crate::dsh_config::mcp_entries_from(text)? {
                        let id = entry["config"]["serverName"].as_str().ok_or_else(invalid)?.to_owned();
                        if servers.insert(id, serde_json::to_value(entry).map_err(|_| invalid())?).is_some() { return Err(invalid()); }
                    }
                    Ok(json!({"mcpServers": servers}))
                } else { json_document(&app, text) }
            })();
            let document = match parsed { Ok(document) => document, Err(_) => { snapshot.error = Some("invalid_native_configuration"); snapshot.documents.push(json!({})); continue; } };
            let map = document.get(section(&app));
            if map.is_some_and(|map| !map.is_object()) { snapshot.error = Some("invalid_native_configuration"); }
            for (id, native) in map.and_then(Value::as_object).into_iter().flatten() {
                match decode(&app, id, native, &document) {
                    Ok(entry) => {
                        if let Some(previous) = snapshot.entries.get(id) {
                            if previous.spec != entry.spec || previous.enabled != entry.enabled { snapshot.error = Some("native_profiles_conflict"); }
                        } else { snapshot.entries.insert(id.clone(), entry); }
                    }
                    Err(_) => snapshot.error = Some("invalid_native_configuration"),
                }
            }
            snapshot.documents.push(document);
        }
        snapshot
    }).collect()
}

// Pure adapter projection. The same converters used by production writers are
// used for compatibility and file comparisons; no network or command discovery.
pub fn validate(app: &AppType, id: &str, spec: &Value) -> Result<(), AppError> {
    validate_spec(app, id, spec).map_err(|_| AppError::McpValidation("incompatible_configuration".into()))
}
fn validate_spec(app: &AppType, id: &str, spec: &Value) -> Result<(), AppError> {
    super::validation::validate_server_spec(spec)?;
    match app {
        AppType::Pi => super::pi::validate_entry(id, spec)?,
        AppType::Dsh => crate::dsh_config::validate_mcp_spec(id, spec)?,
        AppType::Agy if spec["type"] == "sse" => return Err(AppError::McpValidation("unsupported_transport".into())),
        AppType::ClaudeDesktop | AppType::OpenClaw => return Err(AppError::McpValidation("unsupported_app".into())),
        _ => {},
    }
    projected(app, spec).map(|_| ())
}
fn projected(app: &AppType, spec: &Value) -> Result<Value, AppError> {
    match app {
        AppType::Codex | AppType::GrokBuild => {
            let table = if *app == AppType::Codex { super::codex::json_server_to_codex_toml_table(spec)? } else { super::grokbuild::json_server_to_grokbuild_toml_table(spec)? };
            let mut document = toml_edit::DocumentMut::new();
            document["entry"] = toml_edit::Item::Table(table);
            let root: toml::Table = toml::from_str(&document.to_string()).map_err(|_| invalid())?;
            serde_json::to_value(root.get("entry").ok_or_else(invalid)?).map_err(|_| invalid())
        }
        AppType::Gemini => crate::gemini_mcp::native_server_spec("managed", spec),
        AppType::OpenCode => super::opencode::convert_to_opencode_format(spec),
        AppType::Hermes => super::hermes::convert_to_hermes_format(spec),
        AppType::Pi => super::pi::native_transport(spec),
        AppType::Omp => {
            let mut spec = super::pi::unified_spec(spec);
            spec.as_object_mut().unwrap().retain(|key, _| super::pi::TRANSPORT_FIELDS.contains(&key.as_str()));
            Ok(spec)
        }
        AppType::Kimi => {
            let mut native = super::kimi::unified_spec(spec);
            let typ = native.as_object_mut().unwrap().remove("type");
            if typ.as_ref().and_then(Value::as_str) == Some("sse") { native["transport"] = json!("sse"); }
            Ok(native)
        }
        AppType::Agy => {
            let mut native = super::agy::unified_spec(spec);
            for field in ["type", "enabled", "disabled", "serverUrl"] { native.as_object_mut().unwrap().remove(field); }
            Ok(native)
        }
        _ => Ok(spec.clone()),
    }
}
impl NativeSnapshot {
    pub fn initialized(&self) -> bool { self.files.iter().any(|file| file.bytes.is_some()) }
    pub fn matches(&self, id: &str, effective: &Value, patch: Option<&Value>) -> Result<bool, AppError> {
        if !self.entries.get(id).is_some_and(|entry| entry.enabled) { return Ok(false); }
        self.matches_configuration(id, effective, patch)
    }
    pub fn matches_configuration(&self, id: &str, effective: &Value, patch: Option<&Value>) -> Result<bool, AppError> {
        let expected = projected(&self.app, effective)?;
        for (file, document) in self.files.iter().zip(&self.documents) {
            if file.bytes.is_none() { return Ok(false); }
            let Some(native) = document[section(&self.app)].get(id) else { return Ok(false); };
            let same = match self.app {
                AppType::Dsh => {
                    let text = std::str::from_utf8(file.bytes.as_ref().unwrap()).map_err(|_| invalid())?;
                    let next = crate::dsh_config::mcp_edit_overridden(text, id, Some(effective), patch)?;
                    crate::dsh_config::mcp_entries_from(text)? == crate::dsh_config::mcp_entries_from(&next)?
                }
                AppType::Hermes => {
                    let mut merged = super::hermes::merge_hermes_spec(native, &expected);
                    super::overrides::apply_options(merged.as_object_mut().unwrap(), patch, &["type", "command", "args", "env", "url", "headers", "cwd"]);
                    merged == *native
                }
                AppType::Pi | AppType::Omp => {
                    let mut merged = native.clone();
                    super::overrides::apply_options(merged.as_object_mut().ok_or_else(invalid)?, patch, &super::pi::TRANSPORT_FIELDS);
                    super::pi::transport_spec(native) == super::pi::transport_spec(&expected) && merged == *native
                }
                AppType::Kimi | AppType::Agy | AppType::Mcode => {
                    let mut native = match self.app { AppType::Kimi => super::kimi::unified_spec(native), AppType::Agy => super::agy::unified_spec(native), _ => super::mcode::unified_spec(native) };
                    let mut expected = match self.app { AppType::Kimi => super::kimi::unified_spec(&expected), AppType::Agy => super::agy::unified_spec(&expected), _ => super::mcode::unified_spec(&expected) };
                    for field in ["enabled", "disabled"] { native.as_object_mut().unwrap().remove(field); expected.as_object_mut().unwrap().remove(field); }
                    // Adapters preserve native-only options but replace every transport field.
                    let fields = ["command", "args", "env", "url", "headers", "type"];
                    let mut merged = native.clone();
                    super::overrides::apply_options(merged.as_object_mut().unwrap(), patch, &fields);
                    fields.iter().all(|field| native.get(*field) == expected.get(*field)) && merged == native
                }
                AppType::Codex | AppType::GrokBuild => projected(&self.app, &decode(&self.app, id, native, document)?.spec)? == expected,
                AppType::Claude => super::pi::unified_spec(&decode(&self.app, id, native, document)?.spec) == super::pi::unified_spec(&expected),
                _ => *native == expected,
            };
            if !same { return Ok(false); }
        }
        Ok(!self.files.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pure_compatibility_uses_real_adapter_constraints() {
        assert!(validate(&AppType::Pi, "invalid.name", &json!({"command":"node"})).is_err());
        for app in [AppType::Pi, AppType::Agy, AppType::Dsh] { assert!(validate(&app, "fixture", &json!({"type":"sse","url":"https://example.test/sse"})).is_err()); }
        assert!(validate(&AppType::Codex, "fixture", &json!({"type":"http","url":"https://example.test/mcp"})).is_ok());
    }

    #[test]
    fn toml_projection_keeps_nested_env_and_native_header_names() {
        let stdio = projected(&AppType::Codex,&json!({"command":"node","env":{"TOKEN":"fixture"}})).unwrap();
        assert_eq!(stdio["env"],json!({"TOKEN":"fixture"}));
        let http = projected(&AppType::Codex,&json!({"type":"http","url":"https://example.test/mcp","headers":{"Authorization":"fixture"}})).unwrap();
        assert_eq!(http["http_headers"],json!({"Authorization":"fixture"}));
        assert!(http.get("type").is_none());
    }
    #[test]
    fn a_snapshot_reads_each_file_once_even_if_its_contents_change() {
        let temp=tempfile::tempdir().unwrap();
        let path=temp.path().join("mcp.json");
        fs::write(&path,"first").unwrap();
        let mut cache=ReadCache::new();
        let first=cached_read(&mut cache,&path).unwrap().unwrap();
        fs::write(&path,"changed").unwrap();
        let second=cached_read(&mut cache,&path).unwrap().unwrap();
        assert!(Arc::ptr_eq(&first,&second));
        assert_eq!(&*second,b"first");
        #[cfg(unix)]
        {
            let alias=temp.path().join("alias.json");
            std::os::unix::fs::symlink(&path,&alias).unwrap();
            let same=cached_read(&mut cache,&alias).unwrap().unwrap();
            assert!(Arc::ptr_eq(&first,&same));
        }
    }
}
