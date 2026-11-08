const bridge = window.desktopConnection;
const bridgeAvailable = Boolean(bridge && typeof bridge.invoke === "function" && typeof bridge.onState === "function");
const bridgeUnavailable = "可信桌面连接桥不可用，请重新安装完整的 Dovspace 桌面应用。";
const form = document.querySelector("#connection-form");
const fields = Object.fromEntries(["projectRoot", "dataDir", "nodePath", "remoteUrl"].map(name => [name, form.elements.namedItem(name)]));
const account = Object.fromEntries(["email", "name", "password", "workspaceName"].map(name => [name, form.elements.namedItem(name)]));
const createAccount = form.elements.namedItem("createAccount");
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

function selectedMode() { return form.elements.namedItem("mode").value; }
function working() { return pending > 0 || ["connecting", "stopping", "maintenance"].includes(current?.status); }
function clearAccount() { for (const element of Object.values(account)) element.value = ""; }
function changeStep(next) {
  if (step !== next) account.password.value = "";
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
  const previousMode = selectedMode();
  for (const [name, element] of Object.entries(fields))
    if (replace || !dirty.has(name)) element.value = state.configuration[name] || "";
  if (replace || !dirty.has("mode")) form.elements.namedItem("mode").value = state.configuration.mode;
  if (replace || !dirty.has("createAccount"))
    createAccount.checked = Boolean(state.setupSuggested) && selectedMode() === "local";
  if (previousMode !== selectedMode() && selectedMode() !== "local") clearAccount();
}

function statusMessage() {
  if (!bridgeAvailable) return "无法使用桌面连接功能。";
  if (!current) return localError ? "无法读取桌面连接状态。" : "正在读取桌面连接状态…";
  switch (current.status) {
    case "connecting": return current.configuration.mode === "local" ? "正在准备本地工作区，请稍候…" : "正在检查远程服务，请稍候…";
    case "connected": return current.configuration.mode === "local"
      ? "本地工作区已连接。请在工作台中登录；关闭工作台窗口不会停止本地任务。"
      : "远程服务已连接。请使用该服务的账号登录，任务在远程运行。";
    case "stopping": return "正在断开连接并停止本地服务与数据库…";
    case "maintenance": return "正在维护工作区数据，请稍候…";
    case "error": return current.localRunning ? "操作未完成，本地服务仍在运行。请查看错误并重试断开或退出。" : "操作未完成，请查看下方错误与原始诊断。";
    default: return "尚未连接。选择连接方式后继续设置，已有数据不会被重置。";
  }
}

function displayMode(disabled) {
  const local = selectedMode() === "local";
  const configuring = step === "configure";
  document.querySelector("#local-fields").hidden = !local;
  document.querySelector("#remote-fields").hidden = local;
  document.querySelector("#account-fields").hidden = !local || !createAccount.checked;
  for (const name of ["dataDir", "projectRoot", "nodePath"])
    fields[name].disabled = disabled || !configuring || !local || (name === "nodePath" && !current?.developerRuntime);
  fields.dataDir.required = local;
  fields.remoteUrl.disabled = disabled || !configuring || local;
  fields.remoteUrl.required = !local;
  createAccount.disabled = disabled || !configuring || !local;
  for (const element of Object.values(account)) {
    element.required = local && createAccount.checked;
    element.disabled = disabled || !configuring || !local || !createAccount.checked;
  }
  for (const button of document.querySelectorAll("[data-directory]"))
    button.disabled = disabled || !configuring || !local;
  document.querySelector("#choose-node").disabled = disabled || !configuring || !local || !current?.developerRuntime;
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
    return `${maintenanceFeedback.action === "restore" ? "恢复已完成，请返回连接页面后手动连接。" : "备份已完成，请妥善保管未加密的私密备份。"} ${availability}`;
  return working() ? "正在处理桌面操作，请稍候。" : availability;
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
    : selectedMode() === "remote" ? "连接远程服务" : createAccount.checked ? "创建并启动工作区" : "启动本地工作区";
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
    ? current.configuration.mode === "local" ? "本地工作区已就绪。打开工作台后，使用你的 PM 账号登录。" : "远程连接已就绪。打开工作台后，使用该服务的 PM 账号登录。"
    : recovery ? "连接尚未完成，但本地服务仍在运行。可重试断开以安全停止服务，或退出应用。" : "正在停止连接，请稍候…";
  document.querySelector("#manage-workspace").disabled = disabled;
  document.querySelector("#maintenance-back").disabled = disabled;
  document.querySelector("#quit").disabled = !bridgeAvailable || quitPending
    || ["stopping", "maintenance"].includes(current?.status) || ["backup", "restore", "disconnect"].includes(activeAction);
  for (const action of ["backup", "restore"])
    document.querySelector(`#${action}`).disabled = disabled || !current?.maintenanceAllowed;
  for (const button of document.querySelectorAll("[data-reveal]"))
    button.disabled = disabled || !current?.configuration[button.dataset.reveal];
  document.querySelector("#maintenance-root").textContent = `已保存的工作区：${current?.configuration.dataDir || "尚未读取"}`;
  document.querySelector("#maintenance-status").textContent = maintenanceStatus();
  const maintenanceErrors = [...new Set([maintenanceFeedback?.error, localError, current?.error].filter(Boolean))].join("\n\n");
  showError("#maintenance-error", maintenanceErrors);
  const maintenanceDetails = diagnostics(maintenanceFeedback || current);
  document.querySelector("#maintenance-diagnostics").hidden = !maintenanceDetails;
  document.querySelector("#maintenance-details").textContent = maintenanceDetails;
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
    clearAccount();
    createAccount.checked = false;
    dirty.add("createAccount");
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
      clearAccount();
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
  if (action === "quit") {
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
  account.password.value = "";
  view = nextView;
  changeStep(nextStep);
  render();
  const target = view === "maintenance" ? document.querySelector("#maintenance-back")
    : step === "mode" ? form.querySelector('input[name="mode"]:checked')
    : step === "configure" ? selectedMode() === "remote" ? fields.remoteUrl : createAccount
    : document.querySelector("#open");
  target?.focus();
}

form.addEventListener("input", event => {
  if (event.target.name) dirty.add(event.target.name);
  if (Object.values(account).includes(event.target)) dirty.add("createAccount");
});
form.addEventListener("change", event => {
  if (event.target.name) dirty.add(event.target.name);
  if (event.target === fields.dataDir && current && fields.projectRoot.value === current.configuration.projectRoot) {
    fields.projectRoot.value = "";
    dirty.add("projectRoot");
  }
  if (event.target === createAccount && !createAccount.checked) clearAccount();
  if (event.target.name === "mode" && selectedMode() !== "local") {
    clearAccount();
    createAccount.checked = false;
    dirty.add("createAccount");
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
  const configuration = { mode: selectedMode(), ...Object.fromEntries(Object.entries(fields).map(([name, element]) => [name, element.value])) };
  if (configuration.mode === "local" && createAccount.checked)
    configuration.setup = Object.fromEntries(Object.entries(account).map(([name, element]) => [name, element.value]));
  // Clear both DOM and temporary payload secrets even if startup fails or is cancelled.
  account.password.value = "";
  try { await invoke("connect", { configuration }); }
  finally { if (configuration.setup) configuration.setup.password = ""; }
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
for (const action of ["open", "disconnect", "backup", "restore", "quit"]) {
  const button = document.querySelector(`#${action}`);
  button.addEventListener("click", () => { if (!button.disabled) void invoke(action); });
}

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
