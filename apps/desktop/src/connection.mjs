const bridge = window.desktopConnection;
const form = document.querySelector("#connection-form");
const fields = Object.fromEntries(["projectRoot", "dataDir", "nodePath", "remoteUrl"].map(name => [name, form.elements.namedItem(name)]));
const account = Object.fromEntries(["email", "name", "password", "workspaceName"].map(name => [name, form.elements.namedItem(name)]));
const createAccount = form.elements.namedItem("createAccount");
let current;
let pending = 0;
let configurationKey;
let localError = "";

function selectedMode() { return form.elements.namedItem("mode").value; }
function working() { return pending > 0 || ["connecting", "stopping", "maintenance"].includes(current?.status); }

function displayMode() {
  const local = selectedMode() === "local";
  const disabled = working();
  document.querySelector("#local-fields").hidden = !local;
  document.querySelector("#remote-fields").hidden = local;
  document.querySelector("#account-fields").hidden = !createAccount.checked;
  for (const name of ["dataDir", "projectRoot", "nodePath"]) fields[name].disabled = disabled || !local;
  fields.dataDir.required = local;
  fields.remoteUrl.disabled = disabled || local;
  fields.remoteUrl.required = !local;
  createAccount.disabled = disabled || !local;
  for (const element of Object.values(account)) {
    element.required = local && createAccount.checked;
    element.disabled = disabled || !local || !createAccount.checked;
  }
  for (const button of document.querySelectorAll("[data-directory], #choose-node")) button.disabled = disabled || !local;
}

function showError(message) {
  const error = document.querySelector("#error");
  error.textContent = message || "";
  error.hidden = !message;
}

function render(state) {
  current = state;
  const key = JSON.stringify(state.configuration);
  if (key !== configurationKey) {
    for (const [name, element] of Object.entries(fields)) element.value = state.configuration[name] || "";
    form.elements.namedItem("mode").value = state.configuration.mode;
    createAccount.checked = Boolean(state.setupSuggested) && state.configuration.mode === "local";
    configurationKey = key;
  }
  const disabled = working();
  for (const element of form.elements) element.disabled = disabled;
  displayMode();
  document.querySelector("#development-runtime").hidden = !state.developerRuntime;
  document.querySelector("#progress").hidden = !disabled;
  document.querySelector("#status").textContent = state.message;
  const processes = document.querySelector("#processes");
  processes.hidden = !state.localRunning;
  processes.textContent = `Managed local services running${state.processCount ? ` · ${state.processCount} owned processes` : ""}`;
  const address = document.querySelector("#address");
  address.hidden = !state.address;
  address.textContent = `${state.address}${state.runtime ? ` · Node ${state.runtime}` : ""}`;
  showError(localError || state.error);
  document.querySelector("#diagnostics").hidden = !state.details;
  document.querySelector("#details").textContent = state.details || "";
  document.querySelector("#connect").textContent = state.status === "connecting" ? "Connecting…" : state.status === "stopping" ? "Stopping…" : state.status === "maintenance" ? "Maintaining workspace…" : state.status === "connected" ? "Change connection" : "Connect workspace";
  document.querySelector("#open").hidden = state.status !== "connected";
  document.querySelector("#disconnect").hidden = !state.localRunning && state.status !== "connected";
  document.querySelector("#quit").disabled = ["stopping", "maintenance"].includes(state.status);
  for (const action of ["backup", "restore"]) document.querySelector(`#${action}`).disabled = disabled || !state.maintenanceAllowed;
  for (const button of document.querySelectorAll("[data-reveal]")) button.disabled = disabled || !state.configuration[button.dataset.reveal];
  document.querySelector("#maintenance-root").textContent = `Saved workspace: ${state.configuration.dataDir}`;
}

async function invoke(action, options) {
  if (pending && action !== "quit") return;
  if (!bridge) { showError("The trusted desktop bridge is unavailable. Reinstall the complete desktop package."); return; }
  pending++;
  localError = "";
  if (current) render(current);
  try {
    const value = await bridge.invoke(action, options);
    if (value?.configuration) render(value);
    return value;
  } catch (cause) {
    // Host validation messages are designed to contain no input values or private credentials.
    localError = cause.message;
    showError(localError);
  } finally {
    pending--;
    if (current) render(current);
  }
}

form.addEventListener("change", event => {
  if (event.target === fields.dataDir && current && fields.projectRoot.value === current.configuration.projectRoot)
    fields.projectRoot.value = "";
  if (event.target === createAccount && !createAccount.checked) for (const element of Object.values(account)) element.value = "";
  if (event.target.name === "mode" && selectedMode() !== "local") {
    for (const element of Object.values(account)) element.value = "";
    createAccount.checked = false;
  }
  displayMode();
});
form.addEventListener("submit", async event => {
  event.preventDefault();
  const configuration = { mode: selectedMode(), ...Object.fromEntries(Object.entries(fields).map(([name, element]) => [name, element.value])) };
  if (configuration.mode === "local" && createAccount.checked)
    configuration.setup = Object.fromEntries(Object.entries(account).map(([name, element]) => [name, element.value]));
  // Do not retain the password in the DOM while native startup proceeds or on connection failure.
  account.password.value = "";
  try { await invoke("connect", { configuration }); }
  finally {
    if (configuration.setup) configuration.setup.password = "";
    if (current?.status === "connected") {
      for (const element of Object.values(account)) element.value = "";
      createAccount.checked = false;
      displayMode();
    }
  }
});
for (const button of document.querySelectorAll("[data-directory]")) button.addEventListener("click", async () => {
  const field = button.dataset.directory;
  const value = await invoke("directory", { field });
  if (value) {
    fields[field].value = value;
    if (field === "dataDir") fields.projectRoot.value = "";
  }
});
document.querySelector("#choose-node").addEventListener("click", async () => {
  const value = await invoke("node");
  if (value) fields.nodePath.value = value;
});
for (const button of document.querySelectorAll("[data-reveal]")) button.addEventListener("click", () => void invoke("reveal", { field: button.dataset.reveal }));
for (const action of ["open", "disconnect", "backup", "restore", "quit"])
  document.querySelector(`#${action}`).addEventListener("click", () => void invoke(action));
if (bridge) {
  bridge.onState(state => { localError = ""; render(state); });
  bridge.invoke("state").then(render).catch(cause => showError(cause.message));
} else showError("The trusted desktop bridge is unavailable. Reinstall the complete desktop package.");
