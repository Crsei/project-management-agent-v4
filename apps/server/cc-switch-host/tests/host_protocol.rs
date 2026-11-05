//! Production-binary boundary tests, alongside retained source behavior tests.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, io::{BufRead, BufReader, Write}, path::{Path, PathBuf}, process::{Child, ChildStdin, ChildStdout, Command, Stdio}};

struct Sidecar { child: Child, input: Option<ChildStdin>, output: BufReader<ChildStdout>, next: u64 }
impl Sidecar {
    fn spawn() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_cc-switch-host"))
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        Self { input: child.stdin.take(), output: BufReader::new(child.stdout.take().unwrap()), child, next: 0 }
    }
    fn request(&mut self, command: &str, args: Value) -> Value {
        self.next += 1; let id = self.next.to_string();
        writeln!(self.input.as_mut().unwrap(), "{}", json!({"id":id,"command":command,"args":args})).unwrap();
        self.input.as_mut().unwrap().flush().unwrap();
        loop {
            let message = self.message();
            if message["id"] == id { return message; }
        }
    }
    fn call(&mut self, command: &str, args: Value) -> Value {
        let response = self.request(command, args);
        assert!(response.get("error").is_none(), "{command}: {response}");
        response["result"].clone()
    }
    fn message(&mut self) -> Value {
        let mut line = String::new();
        assert!(self.output.read_line(&mut line).unwrap() > 0, "private host disconnected");
        serde_json::from_str(&line).unwrap()
    }
    fn initialize(
        &mut self,
        data: &Path,
        home: &Path,
        apps: &BTreeMap<String, PathBuf>,
        claude_mcp_file: Option<&Path>,
        key: u8,
    ) -> Value {
        let mut args = json!({"dataDir":data,"homeDir":home,"appDirs":apps,"secretKey":STANDARD.encode([key;32])});
        if let Some(file) = claude_mcp_file {
            args["claudeMcpFile"] = json!(file);
        }
        self.request("host_initialize", args)
    }
    fn stop(&mut self) {
        drop(self.input.take());
        assert!(self.child.wait().unwrap().success());
    }
}
impl Drop for Sidecar {
    fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); }
}
fn server(id: &str, apps: Value) -> Value {
    json!({"id":id,"name":id,"server":{"command":"node","args":["-e","process.exit(0)"],"env":{"FIXTURE_TOKEN":"sealed-env-fixture"},"headers":{"Authorization":"sealed-header-fixture"},"futureField":{"retained":true}},"apps":apps,"tags":[]})
}

#[test]
fn initialized_private_ipc_encrypts_reopens_and_refuses_wrong_key() {
    let temp = tempfile::tempdir().unwrap(); let data = temp.path().join("private"); let home = data.join("home");
    let apps = BTreeMap::new();
    let mut host = Sidecar::spawn();
    assert!(host.request("get_mcp_servers", json!({})).get("error").is_some());
    assert_eq!(host.initialize(&data, &home, &apps, None, 7)["result"]["initialized"], true);
    let original = server("protected", json!({}));
    host.call("upsert_mcp_server", json!({"server":original}));
    assert_eq!(host.call("get_mcp_servers", json!({}))["protected"]["server"], original["server"]);
    assert!(host.request("toggle_mcp_app", json!({"serverId":"protected","app":"claude","enabled":true})).get("error").is_some());
    assert!(host.request("migrate_skill_storage", json!({"target":"unified"})).get("error").is_some());
    assert!(!home.join(".claude.json").exists());
    host.stop();
    let bytes = fs::read(data.join("cc-switch.db")).unwrap();
    assert!(!bytes.windows(b"sealed-env-fixture".len()).any(|part| part == b"sealed-env-fixture"));
    assert!(!bytes.windows(b"sealed-header-fixture".len()).any(|part| part == b"sealed-header-fixture"));
    let mut reopened = Sidecar::spawn();
    assert!(reopened.initialize(&data, &home, &apps, None, 7).get("result").is_some());
    assert_eq!(reopened.call("get_mcp_servers", json!({}))["protected"]["server"], original["server"]);
    reopened.stop();
    let before_wrong_key = fs::read(data.join("cc-switch.db")).unwrap();
    let mut wrong = Sidecar::spawn();
    assert_eq!(wrong.initialize(&data, &home, &apps, None, 8)["error"]["code"], "INITIALIZATION_FAILED");
    wrong.stop();
    assert_eq!(fs::read(data.join("cc-switch.db")).unwrap(), before_wrong_key);
}

#[test]
fn all_twelve_copied_mcp_adapters_project_to_explicit_roots() {
    let temp = tempfile::tempdir().unwrap(); let home = temp.path().join("home"); fs::create_dir_all(&home).unwrap();
    let mut apps = BTreeMap::new();
    for app in cc_switch_host::host_context::APP_IDS {
        let root = if app == "claude" { home.join(".claude") } else { temp.path().join("targets").join(app) };
        fs::create_dir_all(&root).unwrap(); apps.insert(app.to_string(), root);
    }
    let mut host = Sidecar::spawn();
    assert!(host.initialize(&temp.path().join("data"), &home, &apps, Some(&home.join(".claude.json")), 9).get("result").is_some());
    let flags: serde_json::Map<String, Value> = apps.keys().map(|app| (app.clone(), json!(true))).collect();
    host.call("upsert_mcp_server", json!({"server":server("matrix-fixture", Value::Object(flags))}));
    let outcomes = host.call("resync_mcp_to_apps", json!({}));
    assert_eq!(outcomes.as_array().unwrap().len(), 12);
    assert!(outcomes.as_array().unwrap().iter().all(|outcome| outcome["ok"] == true), "{outcomes}");
    let files = [
        ("claude", home.join(".claude.json")),
        ("codex", apps["codex"].join("config.toml")),
        ("gemini", apps["gemini"].join("settings.json")),
        ("grokbuild", apps["grokbuild"].join("config.toml")),
        ("opencode", apps["opencode"].join("opencode.json")),
        ("hermes", apps["hermes"].join("config.yaml")),
        ("pi", apps["pi"].join("mcp.json")), ("omp", apps["omp"].join("mcp.json")),
        ("mcode", apps["mcode"].join("mcp.json")), ("kimi", apps["kimi"].join("mcp.json")),
        ("dsh", apps["dsh"].join("profiles/web/cordis.patch.yml")),
        ("agy", apps["agy"].join("mcp_config.json")),
    ];
    for (app, file) in files { assert!(fs::read_to_string(file).unwrap().contains("matrix-fixture"), "{app}"); }
    host.stop();
}

#[test]
fn skills_zip_modes_backup_restore_and_unified_migration_use_real_service() {
    for mode in ["auto", "symlink", "copy"] {
        let temp = tempfile::tempdir().unwrap(); let home = temp.path().join("home");
        let claude = home.join(".claude"); fs::create_dir_all(&claude).unwrap();
        let apps = BTreeMap::from([("claude".into(), claude.clone())]); let data = temp.path().join("data");
        fs::create_dir_all(data.join("uploads")).unwrap(); let archive = data.join("uploads/fixture.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
        zip.start_file("fixture/SKILL.md", zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(b"---\nname: fixture\ndescription: Native service fixture\n---\nUse only as a test.\n").unwrap(); zip.finish().unwrap();
        let mut host = Sidecar::spawn();
        assert!(host.initialize(&data, &home, &apps, Some(&home.join(".claude.json")), 10).get("result").is_some());
        host.call("save_settings", json!({"settings":{"skillSyncMethod":mode,"skillStorageLocation":"cc_switch"}}));
        let installed = host.call("install_skills_from_zip", json!({"zipPath":archive,"currentApp":"claude"}));
        let skill = &installed["installed"][0]; let id = skill["id"].as_str().unwrap(); let directory = skill["directory"].as_str().unwrap();
        assert!(claude.join("skills").join(directory).join("SKILL.md").is_file());
        let migrated = host.call("migrate_skill_storage", json!({"target":"unified"}));
        assert_eq!(migrated["errors"], json!([]));
        assert!(home.join(".agents/skills").join(directory).join("SKILL.md").is_file());
        host.call("uninstall_skill_unified", json!({"id":id}));
        let backups = host.call("get_skill_backups", json!({}));
        let backup_id = backups[0]["backupId"].as_str().unwrap();
        host.call("restore_skill_backup", json!({"backupId":backup_id,"currentApp":"claude"}));
        assert!(claude.join("skills").join(directory).join("SKILL.md").is_file());
        host.call("delete_skill_backup", json!({"backupId":backup_id})); host.stop();
    }
}

#[test]
fn single_app_context_never_imports_unbound_targets_or_shared_home_skills() {
    let temp = tempfile::tempdir().unwrap(); let home = temp.path().join("home");
    let claude = home.join(".claude"); fs::create_dir_all(&claude).unwrap();
    fs::create_dir_all(home.join(".gemini")).unwrap();
    fs::write(home.join(".gemini/settings.json"), r#"{"mcpServers":{"unbound":{"command":"do-not-import"}}}"#).unwrap();
    fs::create_dir_all(home.join(".agents/skills/unapproved")).unwrap();
    fs::write(home.join(".agents/skills/unapproved/SKILL.md"), "# Not authorized\n").unwrap();
    let mut host = Sidecar::spawn();
    let apps = BTreeMap::from([("claude".into(), claude)]);
    assert!(host.initialize(&temp.path().join("data"), &home, &apps, Some(&home.join(".claude.json")), 11).get("result").is_some());
    assert_eq!(host.call("preview_mcp_import", json!({}))["entries"], json!([]));
    assert!(host.request("import_mcp_from_apps", json!({})).get("error").is_some());
    assert_eq!(host.call("scan_unmanaged_skills", json!({})), json!([]));
    assert!(host.call("get_mcp_servers", json!({})).get("unbound").is_none()); host.stop();
}

#[test]
fn independent_homes_and_default_custom_claude_paths_do_not_cross() {
    let temp = tempfile::tempdir().unwrap();
    let first_home = temp.path().join("first-home");
    let second_home = temp.path().join("second-home");
    let first_root = first_home.join(".claude");
    let second_root = second_home.join("custom-claude");
    fs::create_dir_all(&first_root).unwrap(); fs::create_dir_all(&second_root).unwrap();
    let mut first = Sidecar::spawn(); let mut second = Sidecar::spawn();
    assert!(first.initialize(&temp.path().join("first-data"), &first_home,
        &BTreeMap::from([("claude".into(), first_root)]), Some(&first_home.join(".claude.json")), 12).get("result").is_some());
    assert!(second.initialize(&temp.path().join("second-data"), &second_home,
        &BTreeMap::from([("claude".into(), second_root.clone())]), Some(&second_root.join(".claude.json")), 13).get("result").is_some());
    first.call("upsert_mcp_server", json!({"server":server("first-only", json!({"claude":true}))}));
    second.call("upsert_mcp_server", json!({"server":server("second-only", json!({"claude":true}))}));
    let first_text = fs::read_to_string(first_home.join(".claude.json")).unwrap();
    let second_text = fs::read_to_string(second_root.join(".claude.json")).unwrap();
    assert!(first_text.contains("first-only") && !first_text.contains("second-only"));
    assert!(second_text.contains("second-only") && !second_text.contains("first-only"));
    assert!(!second_home.join(".claude.json").exists());
    first.stop(); second.stop();
}

#[cfg(unix)]
#[test]
fn explicit_home_claude_file_survives_a_symlink_alias() {
    let temp = tempfile::tempdir().unwrap(); let home = temp.path().join("home");
    let physical = temp.path().join("physical-claude");
    fs::create_dir_all(&home).unwrap(); fs::create_dir_all(&physical).unwrap();
    std::os::unix::fs::symlink(&physical, home.join(".claude")).unwrap();
    let mut host = Sidecar::spawn();
    assert!(host.initialize(&temp.path().join("data"), &home,
        &BTreeMap::from([("claude".into(), home.join(".claude"))]), Some(&home.join(".claude.json")), 14).get("result").is_some());
    host.call("upsert_mcp_server", json!({"server":server("lexical-root", json!({"claude":true}))}));
    assert!(fs::read_to_string(home.join(".claude.json")).unwrap().contains("lexical-root"));
    assert!(!physical.join(".claude.json").exists());
    host.stop();
}

#[test]
fn explicit_default_looking_claude_override_uses_its_own_mcp_file() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let app = home.join(".claude");
    fs::create_dir_all(&app).unwrap();
    let default_file = home.join(".claude.json");
    let selected_file = app.join(".claude.json");
    let default_contents = r#"{"mcpServers":{"default-only":{"command":"must-not-import"}},"preserved":"default"}"#;
    fs::write(&default_file, default_contents).unwrap();
    fs::write(&selected_file, r#"{"mcpServers":{"selected-existing":{"command":"node"}},"preserved":"override"}"#).unwrap();
    let apps = BTreeMap::from([("claude".into(), app)]);
    let mut host = Sidecar::spawn();
    let initialized = host.initialize(
        &temp.path().join("data"), &home, &apps, Some(&selected_file), 15,
    );
    assert!(initialized.get("result").is_some());
    assert!(initialized["result"].get("claudeMcpFile").is_none());
    let preview = host.call("preview_mcp_import", json!({}));
    let selections: Vec<_> = preview["entries"].as_array().unwrap().iter().map(|entry| json!({"entryId":entry["entryId"],"resolution":"import"})).collect();
    assert_eq!(host.call("apply_mcp_import", json!({"previewId":preview["previewId"],"selections":selections}))["applied"], 1);
    let servers = host.call("get_mcp_servers", json!({}));
    assert!(servers.get("selected-existing").is_some());
    assert!(servers.get("default-only").is_none());
    host.call("upsert_mcp_server", json!({"server":server("explicit-default", json!({"claude":true}))}));
    let selected: Value = serde_json::from_slice(&fs::read(&selected_file).unwrap()).unwrap();
    assert!(selected["mcpServers"].get("explicit-default").is_some());
    assert!(selected["mcpServers"].get("selected-existing").is_some());
    assert_eq!(selected["preserved"], "override");
    assert_eq!(fs::read_to_string(&default_file).unwrap(), default_contents);
    assert_eq!(host.call("delete_mcp_server", json!({"id":"explicit-default"})), true);
    let selected: Value = serde_json::from_slice(&fs::read(&selected_file).unwrap()).unwrap();
    assert!(selected["mcpServers"].get("explicit-default").is_none());
    assert!(selected["mcpServers"].get("selected-existing").is_some());
    assert_eq!(fs::read_to_string(&default_file).unwrap(), default_contents);
    host.stop();
}

#[test]
fn initialization_rejects_missing_unbound_and_outside_claude_file_authority() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let app = home.join(".claude");
    fs::create_dir_all(&app).unwrap();
    let bound = BTreeMap::from([("claude".into(), app)]);
    let unbound = BTreeMap::new();
    let outside = temp.path().join("outside.json");
    let unexpected = home.join(".claude.json");
    for (name, apps, file) in [
        ("missing", &bound, None),
        ("outside", &bound, Some(outside.as_path())),
        ("unbound", &unbound, Some(unexpected.as_path())),
    ] {
        let data = temp.path().join(name);
        let mut host = Sidecar::spawn();
        assert_eq!(host.initialize(&data, &home, apps, file, 16)["error"]["code"], "INITIALIZATION_FAILED");
        assert!(!data.exists());
        host.stop();
    }
}

fn definition(id: &str, spec: Value) -> Value { json!({"id":id,"name":id,"server":spec}) }

#[test]
fn definition_assignment_and_real_sync_are_separate_and_reads_never_probe() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let claude = home.join(".claude");
    fs::create_dir_all(&claude).unwrap();
    let file = claude.join(".claude.json");
    let marker = temp.path().join("must-not-execute");
    let spec = json!({"command":"sh","args":["-c",format!("touch {}",marker.display())],"env":{"INHERIT":"base","REMOVE":"fixture-secret"}});
    let mut host = Sidecar::spawn();
    assert!(host.initialize(&temp.path().join("data"), &home, &BTreeMap::from([("claude".into(),claude)]), Some(&file), 20).get("result").is_some());
    host.call("save_mcp_definition", json!({"definition":definition("shared",spec.clone())}));
    let saved = host.call("get_mcp_management", json!({}));
    assert!(saved["definitions"]["shared"].get("apps").is_none());
    assert_eq!(saved["boundApps"], json!(["claude"]));
    assert_eq!(saved["agentConfigurations"]["shared"]["claude"]["sync"]["state"], "unassigned");
    assert!(!file.exists());
    host.call("set_mcp_agent_configuration", json!({"serverId":"shared","app":"claude","enabled":true,"override":{"env":{"REMOVE":null,"AGENT":"fixture-agent"},"args":["agent-array"]}}));
    let managed = host.call("get_mcp_management", json!({}));
    let row = &managed["agentConfigurations"]["shared"]["claude"];
    assert_eq!(row["effective"]["env"], json!({"INHERIT":"base","AGENT":"fixture-agent"}));
    assert_eq!(row["effective"]["args"], json!(["agent-array"]));
    assert_eq!(row["sync"]["state"], "synced");
    assert_eq!(managed["definitions"]["shared"]["server"],spec);
    assert!(!home.join(".claude.json").exists());
    assert!(!marker.exists());
    let mut native: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    native["mcpServers"]["shared"]["env"]["INHERIT"] = json!("external");
    fs::write(&file,serde_json::to_vec(&native).unwrap()).unwrap();
    assert_eq!(host.call("get_mcp_management",json!({}))["agentConfigurations"]["shared"]["claude"]["sync"]["state"],"pending");
    host.call("resync_mcp_to_apps",json!({"apps":["claude"]}));
    assert_eq!(host.call("get_mcp_management",json!({}))["agentConfigurations"]["shared"]["claude"]["sync"]["state"],"synced");
    // Original advanced-matrix writes must preserve the same encrypted override.
    let mut matrix = host.call("get_mcp_servers",json!({}))["shared"].clone();
    matrix["server"]["env"]["INHERIT"] = json!("edited");
    host.call("upsert_mcp_server",json!({"server":matrix}));
    host.call("toggle_mcp_app",json!({"serverId":"shared","app":"claude","enabled":false}));
    host.call("toggle_mcp_app",json!({"serverId":"shared","app":"claude","enabled":true}));
    let row = host.call("get_mcp_management",json!({}))["agentConfigurations"]["shared"]["claude"].clone();
    assert_eq!(row["effective"]["env"],json!({"INHERIT":"edited","AGENT":"fixture-agent"}));
    assert!(row["override"]["env"].get("REMOVE").is_some_and(Value::is_null));
    host.call("set_mcp_agent_configuration",json!({"serverId":"shared","app":"claude","enabled":true,"override":null}));
    assert_eq!(host.call("get_mcp_management",json!({}))["agentConfigurations"]["shared"]["claude"]["effective"]["env"],json!({"INHERIT":"edited","REMOVE":"fixture-secret"}));
    assert!(!marker.exists());
    host.call("delete_mcp_server",json!({"id":"shared"}));
    assert_eq!(host.call("get_mcp_management",json!({}))["definitions"],json!({}));
    host.stop();
}

#[test]
fn import_preview_is_private_read_only_conflict_aware_and_atomic() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let claude = home.join(".claude");
    let codex = home.join(".codex");
    fs::create_dir_all(&claude).unwrap(); fs::create_dir_all(&codex).unwrap();
    let claude_file = claude.join(".claude.json");
    let codex_file = codex.join("config.toml");
    let claude_text = r#"{"mcpServers":{"shared":{"command":"node","env":{"TOKEN":"claude-fixture"}},"same":{"command":"node"}},"keep":true}"#;
    let codex_text = "[mcp_servers.shared]\ncommand=\"node\"\n[mcp_servers.shared.env]\nTOKEN=\"codex-fixture\"\n[mcp_servers.same]\ntype=\"stdio\"\ncommand=\"node\"\n";
    fs::write(&claude_file,claude_text).unwrap(); fs::write(&codex_file,codex_text).unwrap();
    let data = temp.path().join("data");
    let mut host = Sidecar::spawn();
    assert!(host.initialize(&data,&home,&BTreeMap::from([("claude".into(),claude),("codex".into(),codex)]),Some(&claude_file),21).get("result").is_some());
    let before = fs::read(data.join("cc-switch.db")).unwrap();
    let preview = host.call("preview_mcp_import",json!({}));
    assert_eq!(fs::read(data.join("cc-switch.db")).unwrap(),before);
    assert_eq!(fs::read_to_string(&claude_file).unwrap(),claude_text);
    assert_eq!(fs::read_to_string(&codex_file).unwrap(),codex_text);
    assert_eq!(host.call("get_mcp_servers",json!({})),json!({}));
    let entries = preview["entries"].as_array().unwrap();
    assert_eq!(entries.len(),4);
    assert_eq!(entries.iter().filter(|entry| entry["serverId"]=="shared" && entry["classification"]=="conflict").count(),1);
    assert_eq!(entries.iter().filter(|entry| entry["serverId"]=="same" && entry["classification"]=="duplicate").count(),1);
    for entry in entries {
        assert!(!entry["conflicts"].to_string().contains("fixture"));
        assert!(!entry["conflicts"].to_string().contains(temp.path().to_str().unwrap()));
    }
    let selections: Vec<_> = entries.iter().map(|entry| json!({"entryId":entry["entryId"],"resolution":if entry["classification"]=="conflict" {"merge-override"} else {"import"}})).collect();
    let duplicated = vec![selections[0].clone(),selections[0].clone()];
    assert_eq!(host.request("apply_mcp_import",json!({"previewId":preview["previewId"],"selections":duplicated}))["error"]["code"],"mcp_import_selection_invalid");
    assert_eq!(fs::read(data.join("cc-switch.db")).unwrap(),before);
    let conflict = entries.iter().find(|entry| entry["serverId"]=="shared" && entry["classification"]=="conflict").unwrap();
    assert_eq!(host.request("apply_mcp_import",json!({"previewId":preview["previewId"],"selections":[{"entryId":conflict["entryId"],"resolution":"merge-override"}]}))["error"]["code"],"mcp_import_conflict");
    assert_eq!(host.call("get_mcp_servers",json!({})),json!({}));
    assert_eq!(host.call("apply_mcp_import",json!({"previewId":preview["previewId"],"selections":selections}))["applied"],4);
    assert_eq!(fs::read_to_string(&claude_file).unwrap(),claude_text);
    assert_eq!(fs::read_to_string(&codex_file).unwrap(),codex_text);
    let managed = host.call("get_mcp_management",json!({}));
    assert_eq!(managed["agentConfigurations"]["shared"]["claude"]["effective"]["env"]["TOKEN"],"claude-fixture");
    assert_eq!(managed["agentConfigurations"]["shared"]["codex"]["effective"]["env"]["TOKEN"],"codex-fixture");
    for id in ["shared","same"] { for app in ["claude","codex"] { assert_eq!(managed["agentConfigurations"][id][app]["sync"]["state"],"synced","{managed}"); } }
    host.stop();
    let bytes=fs::read(data.join("cc-switch.db")).unwrap();
    for secret in [b"claude-fixture".as_slice(),b"codex-fixture".as_slice()] { assert!(!bytes.windows(secret.len()).any(|part|part==secret)); }
}

#[test]
fn stale_native_or_ssot_preview_rejects_before_import_and_unbound_cannot_write() {
    let temp = tempfile::tempdir().unwrap();
    let home=temp.path().join("home"); let claude=home.join(".claude");
    fs::create_dir_all(&claude).unwrap();
    let file=claude.join(".claude.json");
    fs::write(&file,r#"{"mcpServers":{"native":{"command":"node"}}}"#).unwrap();
    let data=temp.path().join("data");
    let mut host=Sidecar::spawn();
    assert!(host.initialize(&data,&home,&BTreeMap::from([("claude".into(),claude)]),Some(&file),22).get("result").is_some());
    let preview=host.call("preview_mcp_import",json!({}));
    let selections=vec![json!({"entryId":preview["entries"][0]["entryId"],"resolution":"import"})];
    fs::write(&file,r#"{"mcpServers":{"native":{"command":"python"}}}"#).unwrap();
    let before=fs::read(data.join("cc-switch.db")).unwrap();
    assert_eq!(host.request("apply_mcp_import",json!({"previewId":preview["previewId"],"selections":selections}))["error"]["code"],"mcp_import_preview_stale");
    assert_eq!(fs::read(data.join("cc-switch.db")).unwrap(),before);
    let preview=host.call("preview_mcp_import",json!({}));
    host.call("save_mcp_definition",json!({"definition":definition("other",json!({"command":"node"}))}));
    let before=fs::read(data.join("cc-switch.db")).unwrap();
    assert_eq!(host.request("apply_mcp_import",json!({"previewId":preview["previewId"],"selections":[{"entryId":preview["entries"][0]["entryId"],"resolution":"import"}]}))["error"]["code"],"mcp_import_preview_stale");
    assert!(host.call("get_mcp_servers",json!({})).get("native").is_none());
    assert!(host.request("set_mcp_agent_configuration",json!({"serverId":"other","app":"codex","enabled":true})).get("error").is_some());
    assert_eq!(fs::read(data.join("cc-switch.db")).unwrap(),before);
    assert!(!home.join(".codex").exists());
    host.stop();
}

#[test]
fn incompatible_effective_assignment_rejects_without_native_or_ssot_changes() {
    let temp=tempfile::tempdir().unwrap(); let home=temp.path().join("home"); let pi=home.join(".pi/agent");
    fs::create_dir_all(&pi).unwrap();
    let data=temp.path().join("data"); let mut host=Sidecar::spawn();
    assert!(host.initialize(&data,&home,&BTreeMap::from([("pi".into(),pi.clone())]),None,23).get("result").is_some());
    host.call("save_mcp_definition",json!({"definition":definition("fixture",json!({"command":"node"}))}));
    let before=fs::read(data.join("cc-switch.db")).unwrap();
    assert_eq!(host.request("set_mcp_agent_configuration",json!({"serverId":"fixture","app":"pi","enabled":true,"override":{"type":"sse","url":"https://example.test/sse","command":null}}))["error"]["code"],"mcp_configuration_incompatible");
    assert_eq!(fs::read(data.join("cc-switch.db")).unwrap(),before);
    assert!(!pi.join("mcp.json").exists());
    host.stop();
}

#[test]
fn effective_overrides_and_explicit_removals_reach_all_twelve_source_adapters() {
    let temp=tempfile::tempdir().unwrap(); let home=temp.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let mut apps=BTreeMap::new();
    for app in cc_switch_host::host_context::APP_IDS {
        let root=temp.path().join("targets").join(app); fs::create_dir_all(&root).unwrap(); apps.insert(app.to_string(),root);
    }
    let claude_file=apps["claude"].join(".claude.json");
    let mut host=Sidecar::spawn();
    assert!(host.initialize(&temp.path().join("data"),&home,&apps,Some(&claude_file),24).get("result").is_some());
    host.call("save_mcp_definition",json!({"definition":definition("effective",json!({"command":"node","args":["base"],"env":{"INHERIT":"base","REMOVE":"old-fixture"},"timeout":100}))}));
    for app in cc_switch_host::host_context::APP_IDS {
        host.call("set_mcp_agent_configuration",json!({"serverId":"effective","app":app,"enabled":true,"override":{"args":["agent"],"env":{"REMOVE":null,"TARGET":app},"timeout":null}}));
    }
    let management=host.call("get_mcp_management",json!({}));
    assert_eq!(management["boundApps"].as_array().unwrap().len(),12);
    for app in cc_switch_host::host_context::APP_IDS {
        let row=&management["agentConfigurations"]["effective"][app];
        assert_eq!(row["effective"]["env"],json!({"INHERIT":"base","TARGET":app}));
        assert!(row["effective"].get("timeout").is_none());
        assert_eq!(row["sync"]["state"],"synced","{app}: {row}");
    }
    let files=[
        ("claude",claude_file),("codex",apps["codex"].join("config.toml")),
        ("gemini",apps["gemini"].join("settings.json")),("grokbuild",apps["grokbuild"].join("config.toml")),
        ("opencode",apps["opencode"].join("opencode.json")),("hermes",apps["hermes"].join("config.yaml")),
        ("pi",apps["pi"].join("mcp.json")),("omp",apps["omp"].join("mcp.json")),
        ("mcode",apps["mcode"].join("mcp.json")),("kimi",apps["kimi"].join("mcp.json")),
        ("dsh",apps["dsh"].join("profiles/web/cordis.patch.yml")),("agy",apps["agy"].join("mcp_config.json")),
    ];
    for (app,file) in &files {
        let text=fs::read_to_string(file).unwrap();
        assert!(text.contains(app),"{app}");
        assert!(!text.contains("old-fixture"),"{app}");
    }
    // A base edit, original toggle and resync retain every encrypted patch.
    host.call("save_mcp_definition",json!({"definition":definition("effective",json!({"command":"node","args":["edited"],"env":{"INHERIT":"edited","REMOVE":"edited-fixture"},"timeout":200}))}));
    for app in cc_switch_host::host_context::APP_IDS {
        host.call("toggle_mcp_app",json!({"serverId":"effective","app":app,"enabled":false}));
        host.call("toggle_mcp_app",json!({"serverId":"effective","app":app,"enabled":true}));
    }
    host.call("resync_mcp_to_apps",json!({}));
    let management=host.call("get_mcp_management",json!({}));
    for app in cc_switch_host::host_context::APP_IDS {
        let row=&management["agentConfigurations"]["effective"][app];
        assert_eq!(row["effective"]["env"],json!({"INHERIT":"edited","TARGET":app}));
        assert_eq!(row["effective"]["args"],json!(["agent"]));
        assert_eq!(row["sync"]["state"],"synced","{app}: {row}");
    }
    host.stop();
}

#[test]
fn bound_but_uninitialized_native_target_reports_unavailable_not_successful_sync() {
    let temp=tempfile::tempdir().unwrap(); let home=temp.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let root=home.join("not-initialized"); let file=root.join(".claude.json");
    let mut host=Sidecar::spawn();
    assert!(host.initialize(&temp.path().join("data"),&home,&BTreeMap::from([("claude".into(),root.clone())]),Some(&file),25).get("result").is_some());
    host.call("save_mcp_definition",json!({"definition":definition("saved",json!({"command":"node"}))}));
    host.call("set_mcp_agent_configuration",json!({"serverId":"saved","app":"claude","enabled":true}));
    let management=host.call("get_mcp_management",json!({}));
    assert_eq!(management["agentConfigurations"]["saved"]["claude"]["sync"],json!({"state":"unavailable","reason":"native_not_initialized"}));
    assert!(!root.exists());
    host.stop();
}

#[cfg(unix)]
#[test]
fn preview_and_mutations_refuse_symlinks_into_unbound_native_targets() {
    let temp=tempfile::tempdir().unwrap(); let home=temp.path().join("home"); let claude=home.join(".claude");
    fs::create_dir_all(&claude).unwrap();
    let outside=temp.path().join("unbound");
    fs::create_dir_all(&outside).unwrap();
    let outside_file=outside.join("native.json");
    let outside_text=r#"{"mcpServers":{"outside-private":{"command":"must-not-import"}}}"#;
    fs::write(&outside_file,outside_text).unwrap();
    let file=claude.join(".claude.json");
    std::os::unix::fs::symlink(&outside_file,&file).unwrap();
    let data=temp.path().join("data"); let mut host=Sidecar::spawn();
    assert!(host.initialize(&data,&home,&BTreeMap::from([("claude".into(),claude)]),Some(&file),26).get("result").is_some());
    let before=fs::read(data.join("cc-switch.db")).unwrap();
    let preview=host.call("preview_mcp_import",json!({}));
    assert_eq!(preview["entries"],json!([]));
    assert_eq!(preview["warnings"],json!([{"app":"claude","message":"native_read_failed"}]));
    assert_eq!(fs::read(data.join("cc-switch.db")).unwrap(),before);
    host.call("save_mcp_definition",json!({"definition":definition("saved",json!({"command":"node"}))}));
    let before=fs::read(data.join("cc-switch.db")).unwrap();
    assert!(host.request("set_mcp_agent_configuration",json!({"serverId":"saved","app":"claude","enabled":true})).get("error").is_some());
    assert_eq!(fs::read(data.join("cc-switch.db")).unwrap(),before);
    assert_eq!(fs::read_to_string(outside_file).unwrap(),outside_text);
    host.stop();
}

#[cfg(unix)]
#[test]
fn context_pins_explicit_symlink_roots_instead_of_authorizing_retargets() {
    let temp=tempfile::tempdir().unwrap(); let home=temp.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let first=temp.path().join("first"); let second=temp.path().join("second");
    fs::create_dir_all(&first).unwrap(); fs::create_dir_all(&second).unwrap();
    let alias=home.join(".claude"); std::os::unix::fs::symlink(&first,&alias).unwrap();
    let file=alias.join(".claude.json"); let data=temp.path().join("data"); let mut host=Sidecar::spawn();
    assert!(host.initialize(&data,&home,&BTreeMap::from([("claude".into(),alias.clone())]),Some(&file),27).get("result").is_some());
    fs::remove_file(&alias).unwrap(); std::os::unix::fs::symlink(&second,&alias).unwrap();
    fs::write(second.join(".claude.json"),r#"{"mcpServers":{"retargeted":{"command":"must-not-import"}}}"#).unwrap();
    let before=fs::read(data.join("cc-switch.db")).unwrap();
    let preview=host.call("preview_mcp_import",json!({}));
    assert_eq!(preview["entries"],json!([]));
    assert_eq!(preview["warnings"][0]["message"],"native_read_failed");
    assert_eq!(fs::read(data.join("cc-switch.db")).unwrap(),before);
    host.stop();
}

#[test]
fn management_gemini_transport_round_trip_uses_source_normalization() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let gemini = home.join(".gemini");
    fs::create_dir_all(&gemini).unwrap();
    let mut host = Sidecar::spawn();
    assert!(host.initialize(&temp.path().join("data"), &home, &BTreeMap::from([("gemini".into(), gemini.clone())]), None, 28).get("result").is_some());
    for transport in ["http", "sse"] {
        host.call("save_mcp_definition", json!({"definition": definition(transport, json!({"type": transport, "url": "https://example.test/mcp", "startup_timeout_sec": 90}))}));
        host.call("set_mcp_agent_configuration", json!({"serverId": transport, "app": "gemini", "enabled": true}));
    }
    let before = fs::read(gemini.join("settings.json")).unwrap();
    let management = host.call("get_mcp_management", json!({}));
    for transport in ["http", "sse"] {
        assert_eq!(management["agentConfigurations"][transport]["gemini"]["sync"]["state"], "synced", "{transport}");
    }
    let preview = host.call("preview_mcp_import", json!({}));
    for transport in ["http", "sse"] {
        let entry = preview["entries"].as_array().unwrap().iter().find(|entry| entry["serverId"] == transport).unwrap();
        assert_eq!(entry["classification"], "duplicate", "{transport}");
        assert_eq!(entry["definition"]["server"]["type"], transport);
        assert_eq!(entry["definition"]["server"]["url"], "https://example.test/mcp");
    }
    assert_eq!(fs::read(gemini.join("settings.json")).unwrap(), before);
    host.stop();
}

#[test]
fn management_unassigned_native_entry_is_drift_not_a_successful_disable() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let codex = home.join(".codex");
    fs::create_dir_all(&codex).unwrap();
    let file = codex.join("config.toml");
    let native = "[mcp_servers.fixture]\ncommand = \"node\"\n";
    fs::write(&file, native).unwrap();
    let mut host = Sidecar::spawn();
    assert!(host.initialize(&temp.path().join("data"), &home, &BTreeMap::from([("codex".into(), codex)]), None, 29).get("result").is_some());
    host.call("save_mcp_definition", json!({"definition": definition("fixture", json!({"command": "node"}))}));
    assert_eq!(fs::read_to_string(&file).unwrap(), native);
    let management = host.call("get_mcp_management", json!({}));
    let row = &management["agentConfigurations"]["fixture"]["codex"];
    assert_eq!(row["enabled"], false);
    assert_eq!(row["sync"], json!({"state": "pending", "reason": "native_configuration_differs"}));
    host.call("set_mcp_agent_configuration", json!({"serverId": "fixture", "app": "codex", "enabled": false}));
    assert_eq!(host.call("get_mcp_management", json!({}))["agentConfigurations"]["fixture"]["codex"]["sync"]["state"], "unassigned");
    fs::write(&file, "[invalid").unwrap();
    assert_eq!(host.call("get_mcp_management", json!({}))["agentConfigurations"]["fixture"]["codex"]["sync"]["state"], "error");
    host.stop();
}
