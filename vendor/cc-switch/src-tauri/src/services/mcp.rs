use indexmap::IndexMap;
use std::collections::HashMap;

use crate::app_config::{AppType, McpServer};
use crate::error::AppError;
use crate::mcp;
use crate::store::AppState;

/// MCP 相关业务逻辑（v3.7.0 统一结构）
pub struct McpService;

/// 「重新同步到各应用」里单个应用的结果
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAppSyncOutcome {
    pub app: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl McpService {
    /// 获取所有 MCP 服务器（统一结构）
    pub fn get_all_servers(state: &AppState) -> Result<IndexMap<String, McpServer>, AppError> {
        state.db.get_all_mcp_servers()
    }

    /// 添加或更新 MCP 服务器
    pub fn upsert_server(state: &AppState, server: McpServer) -> Result<(), AppError> {
        #[cfg(feature = "headless")]
        crate::mcp_management::validate_mutation(state, &server)?;
        // 读取旧状态：用于处理“编辑时取消勾选某个应用”的场景（需要从对应 live 配置中移除）
        let previous = state.db.get_all_mcp_servers()?.get(&server.id).cloned();
        let prev_apps = previous
            .as_ref()
            .map(|s| s.apps.clone())
            .unwrap_or_default();
        let omp_spec = Self::effective_spec(state, &server, &AppType::Omp)?;
        let previous_omp = previous.as_ref().map(|saved| Self::effective_spec(state, saved, &AppType::Omp)).transpose()?;
        let dsh_spec = Self::effective_spec(state, &server, &AppType::Dsh)?;
        let kimi_spec = Self::effective_spec(state, &server, &AppType::Kimi)?;
        let agy_spec = Self::effective_spec(state, &server, &AppType::Agy)?;
        let pi_spec = Self::effective_spec(state, &server, &AppType::Pi)?;
        let mcode_spec = Self::effective_spec(state, &server, &AppType::Mcode)?;
        let omp_patch = Self::projection_patch(state, &server, &AppType::Omp, previous.as_ref())?;
        let dsh_patch = Self::projection_patch(state, &server, &AppType::Dsh, previous.as_ref())?;
        let kimi_patch = Self::projection_patch(state, &server, &AppType::Kimi, previous.as_ref())?;
        let agy_patch = Self::projection_patch(state, &server, &AppType::Agy, previous.as_ref())?;
        let pi_patch = Self::projection_patch(state, &server, &AppType::Pi, previous.as_ref())?;
        let mcode_patch = Self::projection_patch(state, &server, &AppType::Mcode, previous.as_ref())?;

        // Keep our disabled OMP tombstone in step with edits while the checkbox is off.
        let managed_omp = server.apps.omp
            || prev_apps.omp
            || (Self::target_bound(&AppType::Omp) && previous.as_ref().is_some_and(|saved| {
                mcp::omp::is_disabled_managed(&saved.id, previous_omp.as_ref().unwrap()).unwrap_or(false)
            }));
        // Native MCP writes and managed state commit together.
        let save_with_omp = || {
            if managed_omp {
                mcp::omp::sync_and_commit_overridden(
                    &server.id,
                    mcp::omp::OmpChange::from_previous(
                        &omp_spec,
                        previous_omp.as_ref().unwrap_or(&omp_spec),
                        server.apps.omp,
                    ),
                    omp_patch.as_ref(),
                    || state.db.save_mcp_server(&server),
                )
            } else {
                state.db.save_mcp_server(&server)
            }
        };
        // MCode / Pi 的文件和数据库一起提交：任一步失败都恢复原样
        let save_with_dsh = || {
            if server.apps.dsh || prev_apps.dsh {
                mcp::dsh::sync_and_commit_overridden(
                    &server.id,
                    server.apps.dsh.then_some(&dsh_spec),
                    dsh_patch.as_ref(),
                    save_with_omp,
                )
            } else {
                save_with_omp()
            }
        };
        let save_with_kimi = || {
            if server.apps.kimi || prev_apps.kimi {
                mcp::kimi::sync_and_commit_overridden(
                    &server.id,
                    server.apps.kimi.then_some(&kimi_spec),
                    kimi_patch.as_ref(),
                    save_with_dsh,
                )
            } else {
                save_with_dsh()
            }
        };
        let save_with_agy = || {
            if server.apps.agy || prev_apps.agy {
                mcp::agy::sync_and_commit_overridden(
                    &server.id,
                    mcp::agy::AgyChange::from_enabled(server.apps.agy.then_some(&agy_spec)),
                    agy_patch.as_ref(),
                    save_with_kimi,
                )
            } else {
                save_with_kimi()
            }
        };
        let save_with_pi = || {
            if server.apps.pi || prev_apps.pi {
                mcp::pi::sync_and_commit_overridden(
                    &state.db,
                    &server.id,
                    mcp::pi::PiChange::from_enabled(server.apps.pi.then_some(&pi_spec)),
                    pi_patch.as_ref(),
                    save_with_agy,
                )
            } else {
                save_with_agy()
            }
        };
        if server.apps.mcode || prev_apps.mcode {
            mcp::mcode::sync_and_commit_overridden(
                &server.id,
                server.apps.mcode.then_some(&mcode_spec),
                mcode_patch.as_ref(),
                save_with_pi,
            )?;
        } else {
            save_with_pi()?;
        }

        // 处理禁用：若旧版本启用但新版本取消，则需要从该应用的 live 配置移除
        if prev_apps.claude && !server.apps.claude {
            Self::remove_server_from_app(state, &server.id, &AppType::Claude)?;
        }
        if prev_apps.codex && !server.apps.codex {
            Self::remove_server_from_app(state, &server.id, &AppType::Codex)?;
        }
        if prev_apps.gemini && !server.apps.gemini {
            Self::remove_server_from_app(state, &server.id, &AppType::Gemini)?;
        }
        if prev_apps.grokbuild && !server.apps.grokbuild {
            Self::remove_server_from_app(state, &server.id, &AppType::GrokBuild)?;
        }
        if prev_apps.opencode && !server.apps.opencode {
            Self::remove_server_from_app(state, &server.id, &AppType::OpenCode)?;
        }
        if prev_apps.hermes && !server.apps.hermes {
            Self::remove_server_from_app(state, &server.id, &AppType::Hermes)?;
        }

        // 同步到各个启用的应用
        Self::sync_server_to_apps(state, &server, previous.as_ref())?;

        Ok(())
    }

    /// 删除 MCP 服务器
    pub fn delete_server(state: &AppState, id: &str) -> Result<bool, AppError> {
        let server = state.db.get_all_mcp_servers()?.shift_remove(id);
        #[cfg(feature = "headless")]
        if let Some(server) = &server {
            for app in server.apps.enabled_apps() {
                crate::host_context::require_app(app.as_str()).map_err(|_| AppError::InvalidInput("unbound_target".into()))?;
                mcp::snapshot::validate_target_paths(&app)?;
            }
        }

        if let Some(server) = server {
            let omp_spec = Self::effective_spec(state, &server, &AppType::Omp)?;
            let pi_spec = Self::effective_spec(state, &server, &AppType::Pi)?;
            let delete_with_dsh = || {
                if server.apps.dsh {
                    mcp::dsh::sync_and_commit(id, None, || state.db.delete_mcp_server(id))
                } else {
                    state.db.delete_mcp_server(id)
                }
            };
            let delete_with_kimi = || {
                if server.apps.kimi {
                    mcp::kimi::sync_and_commit(id, None, delete_with_dsh)
                } else {
                    delete_with_dsh()
                }
            };
            let delete_with_omp = || {
                if server.apps.omp {
                    mcp::omp::sync_and_commit(
                        id,
                        mcp::omp::OmpChange::Remove(Some(&omp_spec)),
                        delete_with_kimi,
                    )
                } else {
                    delete_with_kimi()
                }
            };
            let delete_with_agy = || {
                if server.apps.agy {
                    mcp::agy::sync_and_commit(id, mcp::agy::AgyChange::Remove, delete_with_omp)
                } else {
                    delete_with_omp()
                }
            };
            let delete_with_pi = || {
                if server.apps.pi {
                    mcp::pi::sync_and_commit(
                        &state.db,
                        id,
                        mcp::pi::PiChange::Remove,
                        delete_with_agy,
                    )
                } else {
                    delete_with_agy()
                }
            };
            if server.apps.mcode {
                mcp::mcode::sync_and_commit(id, None, delete_with_pi)?;
            } else {
                delete_with_pi()?;
            }
            // A false agy flag carries no ownership history. Even an identical disabled
            // native entry may belong to the user; leave it intact without proof of ownership.
            if !server.apps.pi && Self::target_bound(&AppType::Pi) {
                // Only matching disabled entries carry source ownership evidence.
                if let Err(err) = mcp::pi::remove_disabled_if_managed(id, &pi_spec) {
                    log::warn!("清理 Pi 中已禁用的 MCP 条目 '{id}' 失败: {err}");
                }
            }

            if !server.apps.omp && Self::target_bound(&AppType::Omp) {
                if let Err(err) = mcp::omp::remove_disabled_if_managed(id, &omp_spec) {
                    log::warn!("Cleaning disabled Oh My Pi MCP '{id}' failed: {err}");
                }
            }
            // 从所有应用的 live 配置中移除
            Self::remove_server_from_all_apps(state, id, &server)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// 命令入口用的 [`Self::toggle_app`]：先拿这个应用的切换锁再读改写 live 配置。
    ///
    /// 逐条写入是「读文件 → 改 → 写回」，并发的两次切换（批量勾选、和切换供应商或
    /// 重新同步撞在一起）会互相覆盖、丢掉对方写的条目。和 `resync_mcp_to_apps` 用同一把
    /// 锁。`toggle_app` 内部不拿这把锁（tokio 的锁不可重入），已经持锁的调用方直接调它。
    pub async fn toggle_app_locked(
        state: &AppState,
        server_id: &str,
        app: AppType,
        enabled: bool,
    ) -> Result<(), AppError> {
        #[cfg(not(feature = "headless"))]
        let _guard = state.proxy_service.lock_switch_for_app(app.as_str()).await;
        #[cfg(feature = "headless")]
        let _guard = state.app_switch_locks.lock_switch_for_app(app.as_str()).await;
        Self::toggle_app(state, server_id, app, enabled)
    }

    /// 切换指定应用的启用状态。调用方负责先拿这个应用的切换锁（见 [`Self::toggle_app_locked`]）。
    pub fn toggle_app(
        state: &AppState,
        server_id: &str,
        app: AppType,
        enabled: bool,
    ) -> Result<(), AppError> {
        Self::toggle_app_configuration(state, server_id, app, enabled, #[cfg(feature = "headless")] None)
    }

    pub fn toggle_app_configuration(
        state: &AppState, server_id: &str, app: AppType, enabled: bool,
        #[cfg(feature = "headless")] change: Option<&Option<serde_json::Value>>,
    ) -> Result<(), AppError> {
        #[cfg(feature = "headless")]
        let (next_server, effective, previous_effective, projection_patch) = {
            crate::host_context::require_app(app.as_str()).map_err(|_| AppError::InvalidInput("unbound_target".into()))?;
            mcp::snapshot::validate_target_paths(&app)?;
            let mut server = state.db.get_all_mcp_servers()?.shift_remove(server_id)
                .ok_or_else(|| AppError::InvalidInput("unknown_server".into()))?;
            let previous = state.db.effective_mcp_spec(&server, &app)?;
            let saved_patch = state.db.get_mcp_override(server_id, &app)?;
            let effective = match change {
                None => previous.clone(),
                Some(patch) => crate::mcp_management::effective(&server.server, patch.as_ref()),
            };
            mcp::snapshot::validate(&app, server_id, &effective)?;
            server.apps.set_enabled_for(&app, enabled);
            let active_patch = change.map_or(saved_patch.as_ref(), |patch| patch.as_ref());
            let projection_patch = Some(crate::mcp_management::native_projection_patch(&effective, active_patch, Some(&previous)));
            (server, effective, previous, projection_patch)
        };
        if matches!(
            app,
            AppType::Mcode
                | AppType::Kimi
                | AppType::Dsh
                | AppType::Omp
                | AppType::Pi
                | AppType::Agy
        ) {
            if let Some(saved) = state.db.get_all_mcp_servers()?.get(server_id) {
                #[cfg(feature = "headless")]
                let _ = saved;
                #[cfg(not(feature = "headless"))]
                let effective = saved.server.clone();
                #[cfg(not(feature = "headless"))]
                let projection_patch: Option<serde_json::Value> = None;
                let spec = enabled.then_some(&effective);
                let commit = || {
                    #[cfg(feature = "headless")]
                    { state.db.save_mcp_assignment(&next_server, &app, change) }
                    #[cfg(not(feature = "headless"))]
                    { state.db.update_mcp_server_app_enabled(server_id, &app, enabled).map(|_| ()) }
                };
                if app == AppType::Agy {
                    mcp::agy::sync_and_commit_overridden(
                        server_id,
                        mcp::agy::AgyChange::from_enabled(spec),
                        projection_patch.as_ref(),
                        commit,
                    )?;
                } else if app == AppType::Dsh {
                    mcp::dsh::sync_and_commit_overridden(server_id, spec, projection_patch.as_ref(), commit)?;
                } else if app == AppType::Kimi {
                    mcp::kimi::sync_and_commit_overridden(server_id, spec, projection_patch.as_ref(), commit)?;
                } else if app == AppType::Mcode {
                    mcp::mcode::sync_and_commit_overridden(server_id, spec, projection_patch.as_ref(), commit)?;
                } else if app == AppType::Omp {
                    mcp::omp::sync_and_commit_overridden(
                        server_id,
                        mcp::omp::OmpChange::from_previous(
                            &effective,
                            #[cfg(feature = "headless")] &previous_effective,
                            #[cfg(not(feature = "headless"))] &effective,
                            enabled,
                        ),
                        projection_patch.as_ref(),
                        commit,
                    )?;
                } else {
                    mcp::pi::sync_and_commit_overridden(
                        &state.db,
                        server_id,
                        mcp::pi::PiChange::from_enabled(spec),
                        projection_patch.as_ref(),
                        commit,
                    )?;
                }
            }
            return Ok(());
        }
        #[cfg(feature = "headless")]
        {
            state.db.save_mcp_assignment(&next_server, &app, change)?;
            if enabled {
                Self::sync_server_to_app_no_config(server_id, &effective, &app, projection_patch.as_ref())?;
            }
            else { Self::remove_server_from_app(state, server_id, &app)?; }
            Ok(())
        }
        #[cfg(not(feature = "headless"))]
        {
        if let Some(server) = state
            .db
            .update_mcp_server_app_enabled(server_id, &app, enabled)?
        {
            // 同步到对应应用
            if enabled {
                Self::sync_server_to_app(state, &server, &app)?;
            } else {
                Self::remove_server_from_app(state, server_id, &app)?;
            }
        }

        Ok(())
        }
    }

    /// 将 MCP 服务器同步到所有启用的应用
    fn sync_server_to_apps(state: &AppState, server: &McpServer, previous: Option<&McpServer>) -> Result<(), AppError> {
        for app in server.apps.enabled_apps() {
            if matches!(
                app,
                AppType::Mcode
                    | AppType::Kimi
                    | AppType::Dsh
                    | AppType::Omp
                    | AppType::Pi
                    | AppType::Agy
            ) {
                continue; // Already written before saving the managed state.
            }
            Self::sync_server_to_app_previous(state, server, &app, previous)?;
        }

        Ok(())
    }

    /// 将 MCP 服务器同步到指定应用
    fn sync_server_to_app(
        state: &AppState,
        server: &McpServer,
        app: &AppType,
    ) -> Result<(), AppError> {
        Self::sync_server_to_app_previous(state, server, app, None)
    }

    fn sync_server_to_app_previous(
        state: &AppState, server: &McpServer, app: &AppType, previous: Option<&McpServer>,
    ) -> Result<(), AppError> {
        let effective = Self::effective_spec(state, server, app)?;
        #[cfg(feature = "headless")]
        {
            crate::host_context::require_app(app.as_str()).map_err(|_| AppError::InvalidInput("unbound_target".into()))?;
            mcp::snapshot::validate_target_paths(app)?;
            mcp::snapshot::validate(app, &server.id, &effective)?;
        }
        let patch = Self::projection_patch(state, server, app, previous)?;
        Self::sync_server_to_app_no_config(&server.id, &effective, app, patch.as_ref())
    }

    fn sync_server_to_app_no_config(id: &str, spec: &serde_json::Value, app: &AppType, patch: Option<&serde_json::Value>) -> Result<(), AppError> {
        match app {
            AppType::Claude => {
                mcp::sync_single_server_to_claude(&Default::default(), id, spec)?;
                // 各官方账号目录镜像默认 .claude.json 的 mcpServers
                #[cfg(not(feature = "headless"))]
                crate::services::claude_account::sync_all_shared(
                    &crate::config::get_app_config_dir(),
                );
            }
            AppType::ClaudeDesktop => {
                log::debug!("Claude Desktop 3P profiles do not use CC Switch MCP sync, skipping");
            }
            AppType::Codex => {
                // Codex uses TOML format, must use the correct function
                mcp::sync_single_server_to_codex(&Default::default(), id, spec)?;
            }
            AppType::Gemini => {
                mcp::sync_single_server_to_gemini(&Default::default(), id, spec)?;
            }
            AppType::GrokBuild => {
                mcp::sync_single_server_to_grokbuild(
                    &Default::default(),
                    id,
                    spec,
                )?;
            }
            AppType::OpenCode => {
                mcp::sync_single_server_to_opencode(
                    &Default::default(),
                    id,
                    spec,
                )?;
            }
            AppType::OpenClaw => {
                // OpenClaw MCP support is still in development (Issue #4834)
                // Skip for now
                log::debug!("OpenClaw MCP support is still in development, skipping sync");
            }
            AppType::Hermes => {
                mcp::sync_single_server_to_hermes_overridden(&Default::default(), id, spec, patch)?;
            }
            AppType::Mcode => mcp::mcode::sync_and_commit_overridden(id, Some(spec), patch, || Ok(()))?,
            AppType::Kimi => mcp::kimi::sync_and_commit_overridden(id, Some(spec), patch, || Ok(()))?,
            AppType::Dsh => mcp::dsh::sync_and_commit_overridden(id, Some(spec), patch, || Ok(()))?,
            AppType::Pi => mcp::pi::sync_overridden(id, Some(spec), patch)?,
            AppType::Agy => mcp::agy::sync_and_commit_overridden(id, mcp::agy::AgyChange::Upsert(spec), patch, || Ok(()))?,
            AppType::Omp => mcp::omp::sync_and_commit_overridden(id, mcp::omp::OmpChange::from_enabled(spec, true), patch, || Ok(()))?,
        }
        Ok(())
    }

    /// 从所有曾启用过该服务器的应用中移除
    fn remove_server_from_all_apps(
        state: &AppState,
        id: &str,
        server: &McpServer,
    ) -> Result<(), AppError> {
        // 从所有曾启用的应用中移除
        for app in server.apps.enabled_apps() {
            if matches!(
                app,
                AppType::Mcode
                    | AppType::Kimi
                    | AppType::Dsh
                    | AppType::Omp
                    | AppType::Pi
                    | AppType::Agy
            ) {
                continue; // Already removed before deleting the managed record.
            }
            Self::remove_server_from_app(state, id, &app)?;
        }
        Ok(())
    }

    fn remove_server_from_app(_state: &AppState, id: &str, app: &AppType) -> Result<(), AppError> {
        match app {
            AppType::Claude => {
                mcp::remove_server_from_claude(id)?;
                #[cfg(not(feature = "headless"))]
                crate::services::claude_account::sync_all_shared(
                    &crate::config::get_app_config_dir(),
                );
            }
            AppType::ClaudeDesktop => {
                log::debug!("Claude Desktop 3P profiles do not use CC Switch MCP sync, skipping");
            }
            AppType::Codex => mcp::remove_server_from_codex(id)?,
            AppType::Gemini => mcp::remove_server_from_gemini(id)?,
            AppType::GrokBuild => mcp::remove_server_from_grokbuild(id)?,
            AppType::OpenCode => {
                mcp::remove_server_from_opencode(id)?;
            }
            AppType::OpenClaw => {
                // OpenClaw MCP support is still in development
                log::debug!("OpenClaw MCP support is still in development, skipping remove");
            }
            AppType::Hermes => {
                mcp::remove_server_from_hermes(id)?;
            }
            AppType::Mcode => mcp::mcode::sync(id, None)?,
            AppType::Kimi => mcp::kimi::sync(id, None)?,
            AppType::Dsh => mcp::dsh::sync(id, None)?,
            AppType::Pi => mcp::pi::sync(id, None)?,
            AppType::Agy => mcp::agy::sync(id, None)?,
            AppType::Omp => mcp::remove_server_from_omp(id)?,
        }
        Ok(())
    }

    fn effective_spec<'a>(state: &AppState, server: &'a McpServer, app: &AppType) -> Result<std::borrow::Cow<'a, serde_json::Value>, AppError> {
        #[cfg(feature = "headless")]
        {
            match state.db.get_mcp_override(&server.id, app)? {
                Some(patch) => Ok(std::borrow::Cow::Owned(crate::mcp_management::effective(&server.server, Some(&patch)))),
                None => Ok(std::borrow::Cow::Borrowed(&server.server)),
            }
        }
        #[cfg(not(feature = "headless"))]
        { let _ = (state, app); Ok(std::borrow::Cow::Borrowed(&server.server)) }
    }

    fn projection_patch(state: &AppState, server: &McpServer, app: &AppType, previous: Option<&McpServer>) -> Result<Option<serde_json::Value>, AppError> {
        #[cfg(feature = "headless")]
        {
            if !Self::target_bound(app) { return Ok(None); }
            let spec = state.db.effective_mcp_spec(server, app)?;
            let previous = previous.map(|server| state.db.effective_mcp_spec(server, app)).transpose()?;
            let patch = state.db.get_mcp_override(&server.id, app)?;
            Ok(Some(crate::mcp_management::native_projection_patch(&spec, patch.as_ref(), previous.as_ref())))
        }
        #[cfg(not(feature = "headless"))]
        { let _ = (state, server, app, previous); Ok(None) }
    }

    fn target_bound(app: &AppType) -> bool {
        #[cfg(feature = "headless")]
        { crate::host_context::is_bound(app.as_str()) && mcp::snapshot::validate_target_paths(app).is_ok() }
        #[cfg(not(feature = "headless"))]
        { let _ = app; true }
    }

    /// 手动同步所有启用的 MCP 服务器到对应的应用。
    ///
    /// Best-effort：单个应用投影失败（如 ~/.claude.json 坏 JSON）不阻断
    /// 其余应用——各应用的 live 文件互相独立，一处损坏没有理由让其他
    /// 应用的 MCP 状态陈旧。全部跑完后若有失败，聚合成一个错误上报，
    /// 保留调用方的可见性。
    pub fn sync_all_enabled(state: &AppState) -> Result<(), AppError> {
        let servers = Self::get_all_servers(state)?;

        let mut failures: Vec<String> = Vec::new();
        for app in Self::live_sync_apps() {
            if let Err(err) = Self::project_servers_to_app(state, &servers, &app) {
                log::warn!("同步 MCP 到 {app:?} 失败: {err}");
                failures.push(format!("{}: {err}", app.as_str()));
            }
        }

        if failures.is_empty() {
            Ok(())
        } else {
            Err(AppError::Message(format!(
                "部分应用 MCP 同步失败: {}",
                failures.join("; ")
            )))
        }
    }

    /// 只把启用状态投影到单个应用。某个应用的 live 被整体重写后用它做
    /// 定向重投影，避免把无关应用的失败面（如 ~/.claude.json 坏 JSON）
    /// 牵连进目标应用的关键路径。
    pub fn sync_enabled_for_app(state: &AppState, app: &AppType) -> Result<(), AppError> {
        let servers = Self::get_all_servers(state)?;
        Self::project_servers_to_app(state, &servers, app)
    }

    /// 由 CC Switch 管理 MCP 的应用（Claude Desktop、OpenClaw 不支持）
    pub fn live_sync_apps() -> Vec<AppType> {
        AppType::all()
            .filter(|app| {
                #[cfg(feature = "headless")]
                { crate::host_context::is_bound(app.as_str()) }
                #[cfg(not(feature = "headless"))]
                { let _ = app; true }
            })
            .filter(|app| !matches!(app, AppType::OpenClaw | AppType::ClaudeDesktop))
            .collect()
    }

    /// 解析「重新同步」的目标应用：缺省或空列表＝全部受管应用；
    /// 不认识或不支持 MCP 的应用直接报错，不静默跳过。
    pub fn resync_targets(apps: Option<&[String]>) -> Result<Vec<AppType>, AppError> {
        let managed = Self::live_sync_apps();
        let Some(apps) = apps.filter(|apps| !apps.is_empty()) else {
            return Ok(managed);
        };
        let mut targets = Vec::new();
        for raw in apps {
            let app = <AppType as std::str::FromStr>::from_str(raw)?;
            if !managed.contains(&app) {
                return Err(AppError::Message(format!(
                    "{} 不支持由 CC Switch 管理 MCP",
                    app.as_str()
                )));
            }
            if !targets.contains(&app) {
                targets.push(app);
            }
        }
        Ok(targets)
    }

    /// 把数据库里的启用状态重新投影到一个应用的 live 配置，结果按应用报告。
    /// 调用方负责先拿这个应用的切换锁。
    pub fn resync_app(state: &AppState, app: &AppType) -> McpAppSyncOutcome {
        match Self::sync_enabled_for_app(state, app) {
            Ok(()) => McpAppSyncOutcome {
                app: app.as_str().to_string(),
                ok: true,
                error: None,
            },
            Err(err) => {
                log::warn!("重新同步 MCP 到 {app:?} 失败: {err}");
                McpAppSyncOutcome {
                    app: app.as_str().to_string(),
                    ok: false,
                    error: Some(err.to_string()),
                }
            }
        }
    }

    fn project_servers_to_app(
        state: &AppState,
        servers: &IndexMap<String, McpServer>,
        app: &AppType,
    ) -> Result<(), AppError> {
        if matches!(app, AppType::OpenClaw | AppType::ClaudeDesktop) {
            return Ok(());
        }
        #[cfg(feature = "headless")]
        mcp::snapshot::validate_target_paths(app)?;

        // 逐条容错：一条写不进去（规范不是对象、这个应用不认的类型）不该让排在
        // 它后面的服务器全都停在旧状态。全部跑完后聚合上报，调用方照旧能看到
        // 失败。错误相同的条目归并成一项：live 文件本身损坏时每一条都报同一句。
        let mut failures: IndexMap<String, Vec<&str>> = IndexMap::new();
        for server in servers.values() {
            let result = if server.apps.is_enabled_for(app) {
                Self::sync_server_to_app(state, server, app)
            } else if !matches!(
                app,
                AppType::Mcode
                    | AppType::Kimi
                    | AppType::Dsh
                    | AppType::Omp
                    | AppType::Pi
                    | AppType::Agy
            ) {
                Self::remove_server_from_app(state, &server.id, app)
            } else {
                // MCode / Pi's false flag also covers pre-existing, unmanaged servers.
                // Only explicit disable/delete operations may remove those entries.
                Ok(())
            };
            if let Err(err) = result {
                log::warn!("同步 MCP 服务器 '{}' 到 {app:?} 失败: {err}", server.id);
                failures
                    .entry(err.to_string())
                    .or_default()
                    .push(&server.id);
            }
        }

        if failures.is_empty() {
            return Ok(());
        }
        let detail = failures
            .iter()
            .map(|(error, ids)| format!("{}: {error}", ids.join(", ")))
            .collect::<Vec<_>>()
            .join("; ");
        Err(AppError::Message(format!(
            "部分 MCP 服务器同步到 {} 失败: {detail}",
            app.as_str()
        )))
    }

    // ========================================================================
    // 兼容层：支持旧的 v3.6.x 命令（已废弃，将在 v4.0 移除）
    // ========================================================================

    /// [已废弃] 获取指定应用的 MCP 服务器（兼容旧 API）
    #[deprecated(since = "3.7.0", note = "Use get_all_servers instead")]
    pub fn get_servers(
        state: &AppState,
        app: AppType,
    ) -> Result<HashMap<String, serde_json::Value>, AppError> {
        let all_servers = Self::get_all_servers(state)?;
        let mut result = HashMap::new();

        for (id, server) in all_servers {
            if server.apps.is_enabled_for(&app) {
                result.insert(id, Self::effective_spec(state, &server, &app)?.into_owned());
            }
        }

        Ok(result)
    }

    /// [已废弃] 设置 MCP 服务器在指定应用的启用状态（兼容旧 API）
    #[deprecated(since = "3.7.0", note = "Use toggle_app instead")]
    pub fn set_enabled(
        state: &AppState,
        app: AppType,
        id: &str,
        enabled: bool,
    ) -> Result<bool, AppError> {
        Self::toggle_app(state, id, app, enabled)?;
        Ok(true)
    }

    /// [已废弃] 同步启用的 MCP 到指定应用（兼容旧 API）
    #[deprecated(since = "3.7.0", note = "Use sync_all_enabled instead")]
    pub fn sync_enabled(state: &AppState, app: AppType) -> Result<(), AppError> {
        let servers = Self::get_all_servers(state)?;

        for server in servers.values() {
            if server.apps.is_enabled_for(&app) {
                Self::sync_server_to_app(state, server, &app)?;
            }
        }

        Ok(())
    }

    /// 从 Claude 导入 MCP（v3.7.0 已更新为统一结构）
    #[cfg(not(feature = "headless"))]
    pub fn import_from_claude(state: &AppState) -> Result<usize, AppError> {
        // 创建临时 MultiAppConfig 用于导入
        let mut temp_config = crate::app_config::MultiAppConfig::default();

        // 调用原有的导入逻辑（从 mcp.rs）
        let count = crate::mcp::import_from_claude(&mut temp_config)?;

        let mut new_count = 0;

        // 如果有导入的服务器，保存到数据库
        if count > 0 {
            if let Some(servers) = &temp_config.mcp.servers {
                let mut existing = state.db.get_all_mcp_servers()?;
                for server in servers.values() {
                    // 已存在：仅启用 Claude，不覆盖其他字段（与导入模块语义保持一致）
                    let to_save = if let Some(existing_server) = existing.get(&server.id) {
                        let mut merged = existing_server.clone();
                        merged.apps.claude = true;
                        merged
                    } else {
                        // 真正的新服务器
                        new_count += 1;
                        server.clone()
                    };

                    state.db.save_mcp_server(&to_save)?;
                    existing.insert(to_save.id.clone(), to_save.clone());

                    // 导入是读取已有配置，不应反向写回任何应用的 live 配置。
                    // 显式编辑、启用/禁用或手动同步时再执行写回。
                }
            }
        }

        Ok(new_count)
    }

    /// 从 Codex 导入 MCP（v3.7.0 已更新为统一结构）
    #[cfg(not(feature = "headless"))]
    pub fn import_from_codex(state: &AppState) -> Result<usize, AppError> {
        // 创建临时 MultiAppConfig 用于导入
        let mut temp_config = crate::app_config::MultiAppConfig::default();

        // 调用原有的导入逻辑（从 mcp.rs）
        let count = crate::mcp::import_from_codex(&mut temp_config)?;

        let mut new_count = 0;

        // 如果有导入的服务器，保存到数据库
        if count > 0 {
            if let Some(servers) = &temp_config.mcp.servers {
                let mut existing = state.db.get_all_mcp_servers()?;
                for server in servers.values() {
                    // 已存在：仅启用 Codex，不覆盖其他字段（与导入模块语义保持一致）
                    let to_save = if let Some(existing_server) = existing.get(&server.id) {
                        let mut merged = existing_server.clone();
                        merged.apps.codex = true;
                        merged
                    } else {
                        // 真正的新服务器
                        new_count += 1;
                        server.clone()
                    };

                    state.db.save_mcp_server(&to_save)?;
                    existing.insert(to_save.id.clone(), to_save.clone());

                    // 导入是读取已有配置，不应反向写回任何应用的 live 配置。
                    // 显式编辑、启用/禁用或手动同步时再执行写回。
                }
            }
        }

        Ok(new_count)
    }

    /// 从 Gemini 导入 MCP（v3.7.0 已更新为统一结构）
    #[cfg(not(feature = "headless"))]
    pub fn import_from_gemini(state: &AppState) -> Result<usize, AppError> {
        // 创建临时 MultiAppConfig 用于导入
        let mut temp_config = crate::app_config::MultiAppConfig::default();

        // 调用原有的导入逻辑（从 mcp.rs）
        let count = crate::mcp::import_from_gemini(&mut temp_config)?;

        let mut new_count = 0;

        // 如果有导入的服务器，保存到数据库
        if count > 0 {
            if let Some(servers) = &temp_config.mcp.servers {
                let mut existing = state.db.get_all_mcp_servers()?;
                for server in servers.values() {
                    // 已存在：仅启用 Gemini，不覆盖其他字段（与导入模块语义保持一致）
                    let to_save = if let Some(existing_server) = existing.get(&server.id) {
                        let mut merged = existing_server.clone();
                        merged.apps.gemini = true;
                        merged
                    } else {
                        // 真正的新服务器
                        new_count += 1;
                        server.clone()
                    };

                    state.db.save_mcp_server(&to_save)?;
                    existing.insert(to_save.id.clone(), to_save.clone());

                    // 导入是读取已有配置，不应反向写回任何应用的 live 配置。
                    // 显式编辑、启用/禁用或手动同步时再执行写回。
                }
            }
        }

        Ok(new_count)
    }

    /// 从 Grok Build 的 `[mcp_servers]` 导入 MCP。
    #[cfg(not(feature = "headless"))]
    pub fn import_from_grokbuild(state: &AppState) -> Result<usize, AppError> {
        let mut temp_config = crate::app_config::MultiAppConfig::default();
        let count = crate::mcp::import_from_grokbuild(&mut temp_config)?;
        let mut new_count = 0;

        if count > 0 {
            if let Some(servers) = &temp_config.mcp.servers {
                let mut existing = state.db.get_all_mcp_servers()?;
                for server in servers.values() {
                    let to_save = if let Some(existing_server) = existing.get(&server.id) {
                        let mut merged = existing_server.clone();
                        merged.apps.grokbuild = true;
                        merged
                    } else {
                        new_count += 1;
                        server.clone()
                    };
                    state.db.save_mcp_server(&to_save)?;
                    existing.insert(to_save.id.clone(), to_save);
                }
            }
        }
        Ok(new_count)
    }

    /// 从 OpenCode 导入 MCP（v3.9.2+ 新增）
    #[cfg(not(feature = "headless"))]
    pub fn import_from_opencode(state: &AppState) -> Result<usize, AppError> {
        // 创建临时 MultiAppConfig 用于导入
        let mut temp_config = crate::app_config::MultiAppConfig::default();

        // 调用原有的导入逻辑（从 mcp/opencode.rs）
        let count = crate::mcp::import_from_opencode(&mut temp_config)?;

        let mut new_count = 0;

        // 如果有导入的服务器，保存到数据库
        if count > 0 {
            if let Some(servers) = &temp_config.mcp.servers {
                let mut existing = state.db.get_all_mcp_servers()?;
                for server in servers.values() {
                    // 已存在：仅启用 OpenCode，不覆盖其他字段（与导入模块语义保持一致）
                    let to_save = if let Some(existing_server) = existing.get(&server.id) {
                        let mut merged = existing_server.clone();
                        merged.apps.opencode = true;
                        merged
                    } else {
                        // 真正的新服务器
                        new_count += 1;
                        server.clone()
                    };

                    state.db.save_mcp_server(&to_save)?;
                    existing.insert(to_save.id.clone(), to_save.clone());

                    // 导入是读取已有配置，不应反向写回任何应用的 live 配置。
                    // 显式编辑、启用/禁用或手动同步时再执行写回。
                }
            }
        }

        Ok(new_count)
    }

    /// 从 Hermes 导入 MCP
    #[cfg(not(feature = "headless"))]
    pub fn import_from_hermes(state: &AppState) -> Result<usize, AppError> {
        // 创建临时 MultiAppConfig 用于导入
        let mut temp_config = crate::app_config::MultiAppConfig::default();

        // 调用导入逻辑（从 mcp/hermes.rs）
        let count = crate::mcp::import_from_hermes(&mut temp_config)?;

        let mut new_count = 0;

        // 如果有导入的服务器，保存到数据库
        if count > 0 {
            if let Some(servers) = &temp_config.mcp.servers {
                let mut existing = state.db.get_all_mcp_servers()?;
                for server in servers.values() {
                    // 已存在：仅启用 Hermes，不覆盖其他字段（与导入模块语义保持一致）
                    let to_save = if let Some(existing_server) = existing.get(&server.id) {
                        let mut merged = existing_server.clone();
                        merged.apps.hermes = true;
                        merged
                    } else {
                        // 真正的新服务器
                        new_count += 1;
                        server.clone()
                    };

                    state.db.save_mcp_server(&to_save)?;
                    existing.insert(to_save.id.clone(), to_save.clone());

                    // 导入是读取已有配置，不应反向写回任何应用的 live 配置。
                    // 显式编辑、启用/禁用或手动同步时再执行写回。
                }
            }
        }

        Ok(new_count)
    }

    /// 从 Oh My Pi 导入 MCP
    #[cfg(not(feature = "headless"))]
    pub fn import_from_omp(state: &AppState) -> Result<usize, AppError> {
        mcp::omp::import(state)
    }

    /// 从所有支持 MCP 的应用导入服务器，返回新导入的数量。
    ///
    /// Best-effort：单个应用导入失败（如坏 config.toml）不阻断其余应用；
    /// 全部跑完后若有失败，聚合成一个错误上报——历史实现逐应用
    /// `unwrap_or(0)` 吞错，坏文件只会表现为"导入成功 0 个"，用户
    /// 无从得知哪个应用出了问题。
    #[cfg(not(feature = "headless"))]
    pub fn import_from_all_apps(state: &AppState) -> Result<usize, AppError> {
        let mut total = 0;
        let mut failures: Vec<String> = Vec::new();

        let importers: [(&str, fn(&AppState) -> Result<usize, AppError>); 12] = [
            ("claude", Self::import_from_claude),
            ("codex", Self::import_from_codex),
            ("gemini", Self::import_from_gemini),
            ("grokbuild", Self::import_from_grokbuild),
            ("opencode", Self::import_from_opencode),
            ("hermes", Self::import_from_hermes),
            ("mcode", mcp::mcode::import),
            ("kimi", mcp::kimi::import),
            ("dsh", mcp::dsh::import),
            ("agy", mcp::agy::import),
            ("pi", mcp::pi::import),
            ("omp", Self::import_from_omp),
        ];
        for (app, import) in importers {
            #[cfg(feature = "headless")]
            if !crate::host_context::is_bound(app) { continue; }
            match import(state) {
                Ok(count) => total += count,
                Err(err) => {
                    log::warn!("从 {app} 导入 MCP 失败: {err}");
                    failures.push(format!("{app}: {err}"));
                }
            }
        }

        if failures.is_empty() {
            Ok(total)
        } else {
            Err(AppError::Message(format!(
                "已导入 {total} 个，部分应用导入失败: {}",
                failures.join("; ")
            )))
        }
    }
}
