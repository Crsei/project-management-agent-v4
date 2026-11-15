(() => {
  const boot = document.getElementById("dovspace-boot");
  const status = document.getElementById("dovspace-boot-status");
  const actions = document.getElementById("dovspace-boot-actions");
  const reload = document.getElementById("dovspace-boot-reload");
  const home = document.getElementById("dovspace-boot-home");
  let en = false;
  try {
    // Read the existing preference contract only; never persist bootstrap state.
    const saved = JSON.parse(localStorage.getItem("pm.display-preferences.v1") || "null");
    if (saved && (saved.version === 1 || saved.version === 2) && saved.preferences) {
      en = saved.preferences.locale === "en";
      if (["light", "dark"].includes(saved.preferences.theme)) boot.dataset.theme = saved.preferences.theme;
      if (saved.preferences.motion === "reduce") boot.dataset.motion = "reduce";
    }
  } catch { /* Storage is optional; the app's default locale remains Chinese. */ }
  document.documentElement.lang = en ? "en" : "zh-CN";
  status.textContent = en ? "Loading application…" : "正在加载应用…";
  reload.textContent = en ? "Reload" : "重新加载";
  home.textContent = en ? "Back to Project Management" : "返回项目管理";
  boot.dataset.loading = "";
  actions.hidden = true;
  reload.addEventListener("click", event => { event.preventDefault(); window.location.reload(); });
  const fail = () => {
    boot.removeAttribute("data-loading");
    status.setAttribute("role", "alert");
    status.textContent = en
      ? "The application could not start. Check your connection and reload. This screen does not retry messages or operations."
      : "应用未能启动。请检查网络后重新加载；此页面不会重试消息或操作。";
    actions.hidden = false;
  };
  const onError = event => {
    if (event instanceof ErrorEvent || event.target instanceof HTMLScriptElement) fail();
  };
  const ready = () => {
    window.removeEventListener("error", onError, true);
    window.removeEventListener("unhandledrejection", fail);
    window.removeEventListener("dovspace:bootstrap-failed", fail);
    window.removeEventListener("dovspace:ready", ready);
  };
  window.addEventListener("error", onError, true);
  window.addEventListener("unhandledrejection", fail);
  window.addEventListener("dovspace:bootstrap-failed", fail);
  window.addEventListener("dovspace:ready", ready);
})();
