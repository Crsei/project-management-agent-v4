use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use std::{collections::BTreeMap, path::{Component, Path, PathBuf}, sync::OnceLock};

pub const APP_IDS: [&str; 12] = ["claude", "codex", "gemini", "grokbuild", "opencode", "hermes", "pi", "mcode", "kimi", "dsh", "agy", "omp"];
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Initialize {
    pub data_dir: PathBuf,
    pub home_dir: PathBuf,
    #[serde(default)]
    pub app_dirs: BTreeMap<String, PathBuf>,
    #[serde(default, deserialize_with = "deserialize_explicit_claude_file")]
    pub claude_mcp_file: Option<PathBuf>,
    pub secret_key: String,
}

fn deserialize_explicit_claude_file<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<PathBuf>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // Optional means omitted, not an explicit null or a fallback-path request.
    PathBuf::deserialize(deserializer).map(Some)
}

struct ContextPaths {
    data: PathBuf,
    home: PathBuf,
    apps: BTreeMap<String, PathBuf>,
    claude_mcp_file: Option<PathBuf>,
    physical_home: PathBuf,
    physical_apps: BTreeMap<String, PathBuf>,
}
static PATHS: OnceLock<ContextPaths> = OnceLock::new();

/// Reject relative paths and traversal. Explicit symlink roots are allowed;
/// the host separately reserves canonical physical roots. Native MCP file
/// selection is separate explicit authority, never inferred from root spelling.
pub fn validate_root(path: &Path) -> Result<()> {
    if !path.is_absolute() || path.parent().is_none() || path.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
        bail!("An explicit absolute path without traversal is required");
    }
    let mut prefix = PathBuf::new();
    for part in path.components() {
        prefix.push(part);
        match std::fs::symlink_metadata(&prefix) {
            Ok(meta) if meta.file_type().is_symlink() && !prefix.is_dir() => bail!("Root symlink does not resolve to a directory"),
            Ok(meta) if !meta.is_dir() && !meta.file_type().is_symlink() => bail!("Root component is not a directory"),
            Ok(_) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn validate_claude_mcp_file(
    home: &Path,
    apps: &BTreeMap<String, PathBuf>,
    selected: Option<&Path>,
) -> Result<()> {
    match (apps.get("claude"), selected) {
        (Some(app_dir), Some(file)) => {
            let normalized: PathBuf = file.components().collect();
            if !file.is_absolute()
                || file.components().any(|part| matches!(part, Component::ParentDir | Component::CurDir))
                || file.as_os_str() != normalized.as_os_str()
            {
                bail!("Claude MCP file must be an absolute normalized native path");
            }
            if file != home.join(".claude.json") && file != app_dir.join(".claude.json") {
                bail!("Claude MCP file is outside the two authorized native locations");
            }
            Ok(())
        }
        (Some(_), None) => bail!("Bound Claude target requires an explicit MCP file"),
        (None, Some(_)) => bail!("Claude MCP file requires a bound Claude target"),
        (None, None) => Ok(()),
    }
}
pub fn initialize(args: Initialize) -> Result<Vec<String>> {
    if PATHS.get().is_some() { bail!("Context is already initialized"); }
    validate_root(&args.data_dir)?;
    validate_root(&args.home_dir)?;
    if args.data_dir == Path::new("/") || args.home_dir == Path::new("/") { bail!("Filesystem root is not a management context"); }
    for (app, root) in &args.app_dirs {
        if !APP_IDS.contains(&app.as_str()) { bail!("Unsupported target application"); }
        validate_root(root)?;
    }
    validate_claude_mcp_file(
        &args.home_dir, &args.app_dirs, args.claude_mcp_file.as_deref(),
    )?;
    private_directory(&args.data_dir)?;
    // The host owns creation of the native target HOME. Only create an isolated
    // project home below the context's private data directory.
    if !args.home_dir.exists() {
        if !args.home_dir.starts_with(&args.data_dir) { bail!("Native target HOME must already exist"); }
        private_directory(&args.home_dir)?;
    }
    crate::secret_codec::initialize(&args.secret_key)?;
    let physical_home = physical_identity(&args.home_dir)?;
    let physical_apps = args.app_dirs.iter().map(|(app, root)| Ok((app.clone(), physical_identity(root)?))).collect::<Result<_>>()?;
    let apps = args.app_dirs.keys().cloned().collect();
    PATHS.set(ContextPaths {
        data: args.data_dir,
        home: args.home_dir,
        apps: args.app_dirs,
        claude_mcp_file: args.claude_mcp_file,
        physical_home,
        physical_apps,
    })
        .map_err(|_| anyhow!("Context is already initialized"))?;
    Ok(apps)
}
pub fn private_directory(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path).context("Cannot create private context directory")?;
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?; }
    Ok(())
}
fn paths() -> &'static ContextPaths { PATHS.get().expect("host_initialize must precede management") }
pub fn data_dir() -> PathBuf {
    #[cfg(test)]
    if let Some(home) = test_home() { return home.join(".cc-switch"); }
    paths().data.clone()
}
pub fn home_dir() -> PathBuf {
    #[cfg(test)]
    if let Some(home) = test_home() { return home; }
    paths().home.clone()
}
pub fn is_bound(app: &str) -> bool {
    #[cfg(test)]
    if test_home().is_some() { return APP_IDS.contains(&app); }
    paths().apps.contains_key(app)
}
pub fn has_native_targets() -> bool { !paths().apps.is_empty() }
pub fn claude_mcp_file() -> PathBuf {
    paths().claude_mcp_file.clone().expect("Claude target must have explicit MCP file authority")
}
pub fn require_app(app: &str) -> Result<()> {
    if is_bound(app) { Ok(()) } else { bail!("Application has no authorized native target") }
}

// Resolve existing ancestors without creating an uninitialized native root.
fn physical_identity(path: &Path) -> Result<PathBuf> {
    let mut ancestor = path;
    let mut suffix = Vec::new();
    loop {
        match ancestor.canonicalize() {
            Ok(mut resolved) => {
                for name in suffix.into_iter().rev() { resolved.push(name); }
                return Ok(resolved);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                suffix.push(ancestor.file_name().ok_or_else(|| anyhow!("Native root unavailable"))?.to_owned());
                ancestor = ancestor.parent().ok_or_else(|| anyhow!("Native root unavailable"))?;
            }
            Err(_) => bail!("Native root unavailable"),
        }
    }
}

/// Fixed adapter paths may not follow a file or retargeted root into another
/// app's Home/config. Explicit root aliases remain valid at their pinned target.
pub fn require_native_read_path(app: &str, path: &Path) -> Result<()> {
    #[cfg(test)]
    if test_home().is_some() { return Ok(()); }
    let context = paths();
    let root = context.apps.get(app).ok_or_else(|| anyhow!("Application has no authorized native target"))?;
    let physical_root = context.physical_apps.get(app).expect("bound physical root");
    if physical_identity(root)? != *physical_root { bail!("Native root changed after authorization"); }
    if app == "claude" && context.claude_mcp_file.as_deref() == Some(context.home.join(".claude.json").as_path()) {
        if context.claude_mcp_file.as_deref() != Some(path)
            || physical_identity(&context.home)? != context.physical_home
            || physical_identity(path)? != context.physical_home.join(".claude.json")
        { bail!("Native file is outside its authorized target"); }
    } else if !path.starts_with(root) || !physical_identity(path)?.starts_with(physical_root) {
        bail!("Native file is outside its authorized target");
    }
    Ok(())
}
/// Unbound legacy accessors resolve ONLY inside the context, never the host HOME.
/// Public mutating operations must additionally call require_app.
pub fn app_dir(app: &str) -> PathBuf {
    #[cfg(test)]
    if let Some(home) = test_home() {
        return match app {
            "claude" => home.join(".claude"), "codex" => home.join(".codex"),
            "gemini" => home.join(".gemini"), "grokbuild" => home.join(".grok"),
            "opencode" => home.join(".config/opencode"), "hermes" => home.join(".hermes"),
            "pi" => home.join(".pi/agent"), "omp" => home.join(".omp/agent"),
            "mcode" => home.join(".minimax"), "kimi" => home.join(".kimi-code"),
            "dsh" => home.join(".dsh"), "agy" => home.join(".gemini/config"),
            _ => home.join(".cc-switch/unbound").join(app),
        };
    }
    paths().apps.get(app).cloned().unwrap_or_else(|| paths().data.join("unbound").join(app))
}
pub fn validate_read_path(path: &Path) -> Result<()> {
    if !path.is_absolute() { bail!("Native path must be absolute"); }
    let canonical = path.canonicalize().context("Native path is unavailable")?;
    let p = paths();
    let within = |root: &Path| root.canonicalize().is_ok_and(|root| canonical.starts_with(root));
    if within(&p.data) || within(&p.home) || p.apps.values().any(|root| within(root)) { Ok(()) }
    else { bail!("Path is outside the authorized context") }
}
pub fn uploaded_zip(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() { bail!("Uploaded archive path must be absolute"); }
    let canonical = path.canonicalize().context("Uploaded archive is unavailable")?;
    let uploads = data_dir().join("uploads").canonicalize().context("Upload directory is unavailable")?;
    if !canonical.starts_with(uploads) || !canonical.is_file() { bail!("Archive is not an owned upload"); }
    Ok(canonical)
}

#[cfg(test)]
fn test_home() -> Option<PathBuf> {
    // This hook only exists in the upstream behavior-test build. No production
    // environment variable can replace an initialized management context.
    std::env::var_os("CC_SWITCH_TEST_HOME").map(PathBuf::from).filter(|p| p.is_absolute())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_mcp_file_requires_an_explicit_bound_native_choice() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let app = home.join(".claude");
        let apps = BTreeMap::from([("claude".into(), app.clone())]);
        let default_file = home.join(".claude.json");
        let explicit_file = app.join(".claude.json");
        assert!(validate_claude_mcp_file(&home, &apps, Some(&default_file)).is_ok());
        assert!(validate_claude_mcp_file(&home, &apps, Some(&explicit_file)).is_ok());
        assert!(validate_claude_mcp_file(&home, &apps, None).is_err());
        assert!(validate_claude_mcp_file(&home, &apps, Some(&temp.path().join("other.json"))).is_err());
        assert!(validate_claude_mcp_file(&home, &apps, Some(Path::new(".claude.json"))).is_err());
        assert!(validate_claude_mcp_file(&home, &apps, Some(&app.join("../.claude.json"))).is_err());
        assert!(validate_claude_mcp_file(&home, &apps, Some(&home.join("./.claude.json"))).is_err());
        assert!(validate_claude_mcp_file(&home, &BTreeMap::new(), None).is_ok());
        assert!(validate_claude_mcp_file(&home, &BTreeMap::new(), Some(&default_file)).is_err());
    }

    #[test]
    fn claude_mcp_file_is_omitted_or_a_native_path_not_null() {
        let args = serde_json::json!({
            "dataDir": "fixture-data",
            "homeDir": "fixture-home",
            "appDirs": {},
            "secretKey": "fixture-key",
        });
        assert!(serde_json::from_value::<Initialize>(args.clone()).is_ok());
        let mut with_null = args;
        with_null["claudeMcpFile"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<Initialize>(with_null).is_err());
    }
}
