const bridge = window.desktopConnection;
const bridgeAvailable = Boolean(bridge && typeof bridge.invoke === "function" && typeof bridge.onState === "function");
if (bridge?.platform === "darwin" || bridge?.platform === "win32" || bridge?.platform === "linux")
  document.documentElement.dataset.desktopShell = bridge.platform;
const bridgeUnavailable = "可信桌面连接桥不可用，请重新安装完整的 Dovspace 桌面应用。";
const form = document.querySelector("#connection-form");
const fields = Object.fromEntries(["projectRoot", "dataDir", "nodePath"].map(name => [name, form.elements.namedItem(name)]));
const maintenanceSecrets = [...document.querySelectorAll("#backup-password, #backup-password-confirm, #restore-password")];
const legacyRestore = document.querySelector("#restore-legacy");
const trustedRestoreSource = document.querySelector("#restore-trusted-source");
function clearMaintenanceSecrets() {
  for (const input of maintenanceSecrets) input.value = "";
  legacyRestore.checked = false;
  trustedRestoreSource.checked = false;
}
const dirty = new Set();
let current;
let pending = 0;
let activeAction = "";
let quitPending = false;
let connectionAttempt;
let maintenanceOperation;
let maintenanceFeedback;
let maintenanceNotice = "";
let localError = bridgeAvailable ? "" : bridgeUnavailable;
let view = "onboarding";
let step = "mode";

// Validate only a configure submission, never navigation or hidden onboarding steps.
form.noValidate = true;

function working() { return pending > 0 || Boolean(current?.update?.busy) || ["connecting", "stopping", "maintenance"].includes(current?.status); }
function changeStep(next) {
  step = next;
}
function diagnostics(state) {
  return [state?.message, state?.details].filter(Boolean).join("\n\n");
}
function showError(selector, message) {
  const element = document.querySelector(selector);
  element.textContent = message || "";
  element.hidden = !message;
}

function syncConfiguration(state, replace = false) {
  for (const [name, element] of Object.entries(fields))
    if (replace || !dirty.has(name)) element.value = state.configuration[name] || "";
}

function statusMessage() {
  if (!bridgeAvailable) return "无法使用桌面连接功能。";
  if (!current) return localError ? "无法读取桌面连接状态。" : "正在读取桌面连接状态…";
  switch (current.status) {
    case "connecting": return "正在准备工作区，请稍候…";
    case "connected": return current?.firstRunPending ? "工作区已启动。请在工作台页面完成首次账号与工作区设置。" : "工作区已连接。请在工作台中登录。";
    case "stopping": return "正在断开连接并停止本地服务与数据库…";
    case "maintenance": return "正在维护工作区数据，请稍候…";
    case "error": return current.localRunning ? "操作未完成，本地服务仍在运行。请查看错误并重试断开或退出。" : "操作未完成，请查看下方错误与原始诊断。";
    default: return "尚未连接。继续设置本地工作台，已有数据不会被重置。";
  }
}

function displayMode(disabled) {
  const configuring = step === "configure";
  for (const name of ["dataDir", "projectRoot", "nodePath"])
    fields[name].disabled = disabled || !configuring || (name === "nodePath" && !current?.developerRuntime);
  fields.dataDir.required = true;
  for (const button of document.querySelectorAll("[data-directory]"))
    button.disabled = disabled || !configuring;
  document.querySelector("#choose-node").disabled = disabled || !configuring || !current?.developerRuntime;
}

function maintenanceStatus() {
  if (maintenanceOperation) {
    const action = maintenanceOperation.action === "restore" ? "恢复" : "备份";
    return current?.status === "maintenance" ? `正在${action}本地工作区，请勿关闭应用。` : `正在准备${action}，请完成桌面对话框中的确认。`;
  }
  const availability = !current?.maintenanceAllowed
    ? "请先返回连接页面并断开连接；备份和恢复仅在所有本地服务停止后可用。"
    : "本地服务已停止，可以备份或恢复。恢复只写入新的空目录，不会自动连接。";
  if (maintenanceNotice) return `${maintenanceNotice} ${availability}`;
  if (maintenanceFeedback?.status === "error") return `上次维护未完成，请查看下方错误。${availability}`;
  if (maintenanceFeedback?.status === "idle" && maintenanceFeedback.started)
    return `${maintenanceFeedback.action === "restore" ? "恢复已完成，请返回连接页面后手动连接。" : "加密备份已完成，请将备份与口令分开安全保管。"} ${availability}`;
  return working() ? "正在处理桌面操作，请稍候。" : availability;
}
function renderUpdate() {
  const update = current?.update;
  const statuses = {
    unavailable: "此安装不支持应用内自动更新。", idle: "可以检查同一发布通道的更新。",
    checking: "正在检查 GitHub Releases 并核对候选安装元数据…", current: "当前已是此通道的最新版本。",
    available: "发现兼容更新，可手动下载。", downloading: "正在下载并校验安装器；不会自动安装。",
    downloaded: "安装器校验完成，等待你确认重启安装。", preparing: "正在重新核对发布来源和数据兼容性…",
    stopping: "正在等待草稿确认，并正常停止本地服务与 PostgreSQL…", installing: "正在启动安装器…",
    error: "更新未完成，请查看错误；应用不会自动重试安装。",
  };
  document.querySelector("#update-versions").textContent = update
    ? `当前版本 ${update.currentVersion}${update.channel ? ` · ${update.channel} 通道` : ""}${update.targetVersion ? ` · 目标版本 ${update.targetVersion}` : ""}`
    : "尚未读取更新版本。";
  document.querySelector("#update-status").textContent = update ? statuses[update.status] || "更新状态未知，请重新检查。" : "正在读取更新状态…";
  document.querySelector("#update-detail").textContent = update?.message || "";
  document.querySelector("#update-test-warning").hidden = !update?.testPackage;
  showError("#update-error", update?.error);
  const progress = document.querySelector("#update-progress");
  progress.hidden = update?.status !== "downloading";
  if (update?.progress) progress.value = update.progress.percent;
  else progress.removeAttribute("value");
  const transfer = document.querySelector("#update-transfer");
  transfer.hidden = !update?.progress;
  transfer.textContent = update?.progress
    ? `${update.progress.percent.toFixed(1)}% · ${(update.progress.transferred / 1_048_576).toFixed(1)} / ${(update.progress.total / 1_048_576).toFixed(1)} MiB · ${(update.progress.bytesPerSecond / 1_048_576).toFixed(1)} MiB/s`
    : "";
  for (const [action, permission] of [["check", "canCheck"], ["download", "canDownload"], ["install", "canInstall"]])
    document.querySelector(`#update-${action}`).disabled = !bridgeAvailable || !update?.[permission] || working();
  const cancel = document.querySelector("#update-cancel");
  cancel.hidden = !update?.canCancel;
  cancel.disabled = !bridgeAvailable || !update?.canCancel || activeAction === "update-cancel";
}


function render() {
  const disabled = !bridgeAvailable || !current || working();
  const connected = bridgeAvailable && current?.status === "connected";
  const recovery = Boolean(current?.localRunning && !connected);
  document.body.dataset.view = view;
  document.body.dataset.step = step;
  document.querySelector("#onboarding-view").hidden = view !== "onboarding";
  document.querySelector("#maintenance-view").hidden = view !== "maintenance";
  document.querySelector("#step-mode").hidden = step !== "mode";
  document.querySelector("#step-configure").hidden = step !== "configure";
  document.querySelector("#step-ready").hidden = step !== "ready" && !recovery;
  const steps = ["mode", "configure", "ready"];
  for (const element of document.querySelectorAll("#step-indicator [data-step]")) {
    const active = element.dataset.step === step;
    if (active) element.setAttribute("aria-current", "step");
    else element.removeAttribute("aria-current");
    element.classList.toggle("is-complete", steps.indexOf(element.dataset.step) < steps.indexOf(step));
  }
  for (const element of form.elements) element.disabled = disabled;
  displayMode(disabled);
  document.querySelector("#continue").disabled = disabled || step !== "mode";
  document.querySelector("#back").disabled = disabled || step !== "configure";
  document.querySelector("#development-runtime").hidden = !current?.developerRuntime;
  document.querySelector("#progress").hidden = !working();
  document.querySelector("#status").textContent = statusMessage();
  const processes = document.querySelector("#processes");
  processes.hidden = !current?.localRunning;
  processes.textContent = `本地受管服务仍在运行${current?.processCount ? ` · ${current.processCount} 个应用拥有的进程` : ""}`;
  const address = document.querySelector("#address");
  address.hidden = !current?.address;
  address.textContent = `${current?.address || ""}${current?.runtime ? ` · Node ${current.runtime}` : ""}`;
  showError("#error", [...new Set([localError, current?.error].filter(Boolean))].join("\n\n"));
  const details = diagnostics(current);
  document.querySelector("#diagnostics").hidden = !details;
  document.querySelector("#details").textContent = details;
  const connect = document.querySelector("#connect");
  connect.disabled = disabled || step !== "configure";
  connect.textContent = current?.status === "connecting" ? "正在连接…"
    : current?.status === "stopping" ? "正在停止…"
    : current?.status === "maintenance" ? "正在维护…"
    : "启动本地工作台";
  document.querySelector("#open").hidden = !connected || step !== "ready";
  document.querySelector("#open").disabled = disabled;
  document.querySelector("#change-connection").hidden = !connected || step !== "ready";
  document.querySelector("#change-connection").disabled = disabled;
  document.querySelector("#return-connected").hidden = !connected || step === "ready";
  document.querySelector("#return-connected").disabled = disabled;
  const disconnect = document.querySelector("#disconnect");
  disconnect.hidden = !connected && !current?.localRunning;
  disconnect.disabled = disabled;
  disconnect.textContent = current?.status === "stopping" ? "正在停止…" : current?.localRunning ? "断开并停止本地服务" : "断开连接";
  document.querySelector("#ready-summary").textContent = connected
    ? current?.firstRunPending
      ? "工作区已启动。请在已打开的工作台页面完成首次账号与工作区设置；桌面端会提供本机一次性令牌。"
      : "工作区已就绪。打开工作台后，使用你的 PM 账号登录。"
    : recovery ? "连接尚未完成，但本地服务仍在运行。可重试断开以安全停止服务，或退出应用。" : "正在停止连接，请稍候…";
  document.querySelector("#manage-workspace").disabled = disabled;
  document.querySelector("#maintenance-back").disabled = disabled;
  document.querySelector("#quit").disabled = !bridgeAvailable || quitPending
    || Boolean(current?.update?.busy) || ["stopping", "maintenance"].includes(current?.status) || ["backup", "restore", "disconnect"].includes(activeAction);
  for (const action of ["backup", "restore"])
    document.querySelector(`#${action}`).disabled = disabled || !current?.maintenanceAllowed;
  for (const input of [...maintenanceSecrets, legacyRestore, trustedRestoreSource])
    input.disabled = disabled || !current?.maintenanceAllowed;
  for (const button of document.querySelectorAll("[data-reveal]"))
    button.disabled = disabled || !current?.configuration[button.dataset.reveal];
  document.querySelector("#maintenance-root").textContent = `已保存的工作区：${current?.configuration.dataDir || "尚未读取"}`;
  document.querySelector("#maintenance-status").textContent = maintenanceStatus();
  const maintenanceErrors = [...new Set([maintenanceFeedback?.error, localError, current?.error].filter(Boolean))].join("\n\n");
  showError("#maintenance-error", maintenanceErrors);
  const maintenanceDetails = diagnostics(maintenanceFeedback || current);
  document.querySelector("#maintenance-diagnostics").hidden = !maintenanceDetails;
  document.querySelector("#maintenance-details").textContent = maintenanceDetails;
  renderUpdate();
}

function receiveState(state) {
  const previous = current;
  current = state;
  syncConfiguration(state);
  if (connectionAttempt && state.status === "connecting") connectionAttempt.started = true;
  const completedConnection = connectionAttempt?.started && !connectionAttempt.completed && state.status === "connected";
  if (completedConnection) {
    connectionAttempt.completed = true;
    dirty.clear();
    syncConfiguration(state, true);
  }
  if ((state.status === "connected" && previous?.status !== "connected") || completedConnection) changeStep("ready");
  else if (state.status === "idle" && previous?.status === "stopping" && !state.localRunning) changeStep("mode");
  else if (step === "ready" && !["connected", "stopping"].includes(state.status)) changeStep("configure");
  if (maintenanceOperation) {
    if (state.status === "maintenance") maintenanceOperation.started = true;
    if (maintenanceOperation.action === "restore" && maintenanceOperation.started
      && !maintenanceOperation.completed && state.status === "idle" && !state.error) {
      // An explicit restore selects a new workspace; older connection drafts must not override it.
      maintenanceOperation.completed = true;
      dirty.clear();
      syncConfiguration(state, true);
    }
    const changed = ["status", "message", "error", "details"].some(key => state[key] !== maintenanceOperation.before[key]);
    if (maintenanceOperation.started || changed) {
      maintenanceOperation.updated = true;
      maintenanceNotice = "";
      maintenanceFeedback = {
        action: maintenanceOperation.action, started: maintenanceOperation.started,
        status: state.status, message: state.message, error: state.error, details: state.details,
      };
    }
  }
  render();
}

async function invoke(action, options) {
  if (!bridgeAvailable) { localError = bridgeUnavailable; render(); return; }
  if (action === "update-cancel") {
    if (!current?.update?.canCancel || activeAction === "update-cancel") return;
    activeAction = action;
  } else if (action === "quit") {
    if (quitPending || ["stopping", "maintenance"].includes(current?.status) || ["backup", "restore", "disconnect"].includes(activeAction)) return;
    quitPending = true;
  } else {
    if (!current || working()) return;
    activeAction = action;
  }
  if (action === "connect") connectionAttempt = { started: false, completed: false };
  if (["backup", "restore"].includes(action)) {
    maintenanceOperation = { action, before: current, started: false, updated: false };
    maintenanceNotice = "";
  }
  pending++;
  localError = "";
  render();
  try {
    const value = await bridge.invoke(action, options);
    if (value?.configuration) receiveState(value);
    return value;
  } catch (cause) {
    // Keep safe host errors verbatim; never infer translations from their contents.
    localError = cause?.message || "桌面操作未完成，请查看诊断或重新打开连接窗口。";
    if (maintenanceOperation && maintenanceOperation.action === action) {
      maintenanceOperation.updated = true;
      maintenanceFeedback = { action, status: "error", message: "", error: localError, details: "" };
    }
  } finally {
    pending--;
    if (action === "quit") quitPending = false;
    else activeAction = "";
    if (action === "connect") connectionAttempt = undefined;
    if (maintenanceOperation?.action === action) {
      if (!maintenanceOperation.updated) maintenanceNotice = "未收到新的维护结果；下方保留已有的原始结果。";
      maintenanceOperation = undefined;
    }
    render();
  }
}

function navigate(nextView, nextStep = step) {
  if (working() || !current) return;
  clearMaintenanceSecrets();
  view = nextView;
  changeStep(nextStep);
  render();
  const target = view === "maintenance" ? document.querySelector("#maintenance-back")
    : step === "mode" ? form.querySelector('input[name="mode"]:checked')
    : step === "configure" ? fields.dataDir
    : document.querySelector("#open");
  target?.focus();
}

form.addEventListener("input", event => {
  if (event.target.name) dirty.add(event.target.name);
});
form.addEventListener("change", event => {
  if (event.target.name) dirty.add(event.target.name);
  if (event.target === fields.dataDir && current && fields.projectRoot.value === current.configuration.projectRoot) {
    fields.projectRoot.value = "";
    dirty.add("projectRoot");
  }
  render();
});
form.addEventListener("submit", async event => {
  event.preventDefault();
  if (step !== "configure" || view !== "onboarding" || working() || !current || !bridgeAvailable) return;
  if (!form.checkValidity()) {
    const invalid = [...form.elements].find(element => element.willValidate && !element.validity.valid);
    for (let parent = invalid?.parentElement; parent && parent !== form; parent = parent.parentElement)
      if (parent.tagName === "DETAILS") parent.open = true;
    form.reportValidity();
    return;
  }
  const configuration = { mode: "local", ...Object.fromEntries(Object.entries(fields).map(([name, element]) => [name, element.value])) };
  await invoke("connect", { configuration });
});
document.querySelector("#continue").addEventListener("click", () => navigate("onboarding", "configure"));
document.querySelector("#back").addEventListener("click", () => navigate("onboarding", "mode"));
document.querySelector("#change-connection").addEventListener("click", () => navigate("onboarding", "mode"));
document.querySelector("#return-connected").addEventListener("click", () => navigate("onboarding", "ready"));
document.querySelector("#manage-workspace").addEventListener("click", () => navigate("maintenance"));
document.querySelector("#maintenance-back").addEventListener("click", () => navigate("onboarding"));
for (const button of document.querySelectorAll("[data-directory]")) button.addEventListener("click", async () => {
  if (button.disabled) return;
  const field = button.dataset.directory;
  const value = await invoke("directory", { field });
  if (value) {
    fields[field].value = value;
    dirty.add(field);
    if (field === "dataDir") { fields.projectRoot.value = ""; dirty.add("projectRoot"); }
    render();
  }
});
document.querySelector("#choose-node").addEventListener("click", async () => {
  if (document.querySelector("#choose-node").disabled) return;
  const value = await invoke("node");
  if (value) { fields.nodePath.value = value; dirty.add("nodePath"); render(); }
});
for (const button of document.querySelectorAll("[data-reveal]"))
  button.addEventListener("click", () => { if (!button.disabled) void invoke("reveal", { field: button.dataset.reveal }); });
for (const action of ["open", "disconnect", "quit", "update-check", "update-download", "update-cancel", "update-install"]) {
  const button = document.querySelector(`#${action}`);
  button.addEventListener("click", () => { if (!button.disabled) return invoke(action); });
}
for (const action of ["backup", "restore"]) document.querySelector(`#${action}`).addEventListener("click", async () => {
  if (document.querySelector(`#${action}`).disabled) return;
  const input = document.querySelector(`#${action}-password`);
  const password = input.value;
  const allowLegacyUnencrypted = action === "restore" && legacyRestore.checked;
  const trustedSourceAcknowledged = action === "restore" && trustedRestoreSource.checked;
  if (action === "restore" && !trustedSourceAcknowledged) {
    localError = "请先确认备份来源可信。恢复会以本机账号权限执行备份中的数据库 SQL；加密与口令不能证明作者可信。";
    render(); trustedRestoreSource.focus(); return;
  }
  if (password.length < (action === "backup" ? 12 : allowLegacyUnencrypted ? 0 : 1) || password.length > 1024) {
    localError = action === "backup" ? "请输入至少 12 个字符的备份口令。" : "请输入备份口令；仅可信旧版未加密备份可不填写。";
    render(); input.focus(); return;
  }
  if (action === "backup" && password !== document.querySelector("#backup-password-confirm").value) {
    localError = "两次输入的备份口令不一致。"; render(); document.querySelector("#backup-password-confirm").focus(); return;
  }
  const options = { password, ...(action === "restore" ? { allowLegacyUnencrypted, trustedSourceAcknowledged } : {}) };
  clearMaintenanceSecrets();
  try { await invoke(action, options); }
  finally {
    options.password = "";
    if (action === "restore") { options.trustedSourceAcknowledged = false; options.allowLegacyUnencrypted = false; }
    clearMaintenanceSecrets();
  }
});
window.addEventListener("pagehide", () => { clearMaintenanceSecrets(); });

render();
if (bridgeAvailable) {
  let receivedUpdate = false;
  try {
    bridge.onState(state => { receivedUpdate = true; receiveState(state); });
    bridge.invoke("state").then(state => { if (!receivedUpdate) receiveState(state); }).catch(cause => {
      localError = cause?.message || "无法读取桌面连接状态。";
      render();
    });
  } catch (cause) {
    localError = cause?.message || bridgeUnavailable;
    render();
  }
}
