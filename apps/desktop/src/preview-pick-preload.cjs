/**
 * Sandboxed guest preload used only while the user annotates a preview tab.
 * It has no host API surface beyond the fixed ipcRenderer channels below.
 */
(() => {
  const { ipcRenderer } = require("electron");
  const START = "pm-preview:start-pick";
  const CANCEL = "pm-preview:cancel-pick";
  const PICKED = "pm-preview:element-picked";
  const CANCELLED = "pm-preview:pick-cancelled";
  const Z = "2147483646";
  let active = false;
  let overlay = null;
  let box = null;
  let label = null;
  let selected = null;
  let theme = { dark: false };

  const colors = () => theme.dark
    ? { border: "#f5b48b", fill: "rgba(245,180,139,.16)", text: "#fff", chip: "rgba(20,20,20,.88)" }
    : { border: "#c2410c", fill: "rgba(194,65,12,.12)", text: "#111", chip: "rgba(255,255,255,.94)" };

  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.setAttribute("data-pm-preview-picker", "overlay");
    Object.assign(overlay.style, {
      position: "fixed", inset: "0", zIndex: Z, pointerEvents: "none",
      cursor: "crosshair", background: "transparent",
    });
    box = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed", display: "none", pointerEvents: "none", zIndex: Z,
      border: "2px solid", borderRadius: "3px", boxSizing: "border-box",
    });
    label = document.createElement("div");
    Object.assign(label.style, {
      position: "fixed", display: "none", pointerEvents: "none", zIndex: Z,
      padding: "3px 6px", borderRadius: "4px", font: "11px/16px ui-monospace, monospace",
      whiteSpace: "nowrap", maxWidth: "70vw", overflow: "hidden", textOverflow: "ellipsis",
    });
    overlay.append(box, label);
    document.documentElement.append(overlay);
  }

  function teardown() {
    active = false;
    selected = null;
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("pointerdown", onPointer, true);
    window.removeEventListener("mousedown", onPointer, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onScroll, true);
    overlay?.remove();
    overlay = box = label = null;
  }

  function elementAt(event) {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    return element && element.closest("[data-pm-preview-picker]") ? null : element;
  }

  function visibleRect(element) {
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    if (right <= left || bottom <= top) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function draw(element) {
    if (!element) {
      if (box) box.style.display = "none";
      if (label) label.style.display = "none";
      return;
    }
    const rect = visibleRect(element);
    if (!rect) {
      if (box) box.style.display = "none";
      if (label) label.style.display = "none";
      return;
    }
    const palette = colors();
    Object.assign(box.style, {
      display: "block", left: `${rect.x}px`, top: `${rect.y}px`,
      width: `${rect.width}px`, height: `${rect.height}px`,
      borderColor: palette.border, background: palette.fill,
    });
    const name = element.tagName.toLowerCase()
      + (element.id ? `#${element.id}` : "")
      + (typeof element.className === "string" && element.className.trim()
        ? `.${element.className.trim().split(/\s+/).slice(0, 3).join(".")}`
        : "");
    Object.assign(label.style, {
      display: "block", left: `${Math.max(4, rect.x)}px`,
      top: `${rect.y > 26 ? rect.y - 24 : rect.y + 4}px`,
      color: palette.text, background: palette.chip,
    });
    label.textContent = `${name} · ${Math.round(rect.width)}×${Math.round(rect.height)}`;
  }

  function onMove(event) {
    if (!active) return;
    selected = elementAt(event);
    draw(selected);
  }

  function onPointer(event) {
    if (!active) return;
    // Do not let the preview page act on the gesture that selects it.
    event.preventDefault();
    event.stopImmediatePropagation();
    pickAt(event);
  }

  function onScroll() {
    if (active) draw(null);
  }

  function onKey(event) {
    if (!active || event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    ipcRenderer.send(CANCELLED);
    teardown();
  }

  function selectorFor(element) {
    if (element.id) {
      const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(element.id) : element.id;
      if (document.querySelectorAll(`#${escaped}`).length === 1) return `#${escaped}`;
    }
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < 7) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      if (node.id) {
        const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(node.id) : node.id;
        parts[0] = `#${escaped}`;
        break;
      }
      node = parent;
    }
    return parts.join(" > ");
  }

  function pickAt(event) {
    const element = elementAt(event) ?? selected;
    if (!element) return;
    const rect = visibleRect(element);
    if (!rect) return;
    const payload = {
      selector: selectorFor(element),
      tagName: element.tagName.toLowerCase(),
      text: (element.innerText || element.textContent || "").trim().slice(0, 2000),
      rect,
      dpr: window.devicePixelRatio || 1,
    };
    ipcRenderer.send(PICKED, payload);
    teardown();
  }

  function start(options) {
    if (active) teardown();
    theme = { dark: options?.dark === true };
    active = true;
    ensureOverlay();
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("mousedown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
  }

  ipcRenderer.on(START, (_event, options) => start(options));
  ipcRenderer.on(CANCEL, () => teardown());
})();
