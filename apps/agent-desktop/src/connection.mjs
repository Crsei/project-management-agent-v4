const bridge = window.desktopConnection;
const form = document.querySelector("#connection-form");
const fields = Object.fromEntries(
  ["projectRoot", "dataDir", "nodePath", "remoteUrl"].map((name) => [
    name,
    form.elements.namedItem(name),
  ]),
);
let current;
let busy = false;
let initialized = false;

function selectedMode() {
  return form.elements.namedItem("mode").value;
}

function displayMode() {
  const local = selectedMode() === "local";
  document.querySelector("#local-fields").hidden = !local;
  document.querySelector("#remote-fields").hidden = local;
  for (const name of ["projectRoot", "dataDir", "nodePath"]) fields[name].required = local;
  fields.remoteUrl.required = !local;
}

function showError(message) {
  const error = document.querySelector("#error");
  error.textContent = message || "";
  error.hidden = !message;
}

function render(state) {
  current = state;
  if (!initialized) {
    for (const [name, element] of Object.entries(fields))
      element.value = state.configuration[name] || "";
    form.elements.namedItem("mode").value = state.configuration.mode;
    initialized = true;
    displayMode();
  }
  const working = busy || ["connecting", "stopping"].includes(state.status);
  for (const element of form.elements) element.disabled = working;
  document.querySelector("#status").textContent = state.message;
  const address = document.querySelector("#address");
  address.hidden = !state.address;
  address.textContent = `${state.address}${state.runtime ? ` · Node ${state.runtime}` : ""}`;
  showError(state.error);
  document.querySelector("#diagnostics").hidden = !state.details;
  document.querySelector("#details").textContent = state.details || "";
  document.querySelector("#connect").textContent = working
    ? "Connecting…"
    : state.status === "connected"
      ? "Change connection"
      : "Connect workspace";
  document.querySelector("#open").hidden = state.status !== "connected";
  document.querySelector("#disconnect").hidden =
    !state.localRunning && state.status !== "connected";
  document.querySelector("#quit").disabled = working;
}

async function invoke(action, options) {
  if (busy) return;
  busy = true;
  if (current) render(current);
  try {
    const value = await bridge.invoke(action, options);
    if (value?.configuration) render(value);
    return value;
  } catch (cause) {
    showError(cause.message);
  } finally {
    busy = false;
    if (current) {
      // Keep a just-reported IPC validation error visible until the next user action or state change.
      const error = document.querySelector("#error").textContent;
      render(current);
      if (error) showError(error);
    }
  }
}

form.addEventListener("change", displayMode);
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  await invoke("connect", {
    configuration: {
      mode: selectedMode(),
      ...Object.fromEntries(Object.entries(fields).map(([name, element]) => [name, element.value])),
    },
  });
});
for (const button of document.querySelectorAll("[data-directory]")) {
  button.addEventListener("click", async () => {
    const value = await invoke("directory", { field: button.dataset.directory });
    if (value) fields[button.dataset.directory].value = value;
  });
}
document.querySelector("#choose-node").addEventListener("click", async () => {
  const value = await invoke("node");
  if (value) fields.nodePath.value = value;
});
for (const action of ["open", "disconnect", "quit"])
  document.querySelector(`#${action}`).addEventListener("click", () => void invoke(action));
if (bridge) {
  bridge.onState(render);
  bridge
    .invoke("state")
    .then(render)
    .catch((cause) => showError(cause.message));
} else
  showError("The trusted desktop bridge is unavailable. Reinstall the complete desktop package.");
