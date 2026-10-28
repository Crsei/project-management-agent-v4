import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

/** Capture native link/back navigation before it reaches the router; drafts are not saved rules. */
export function useAutomationLeaveProtection(active: boolean, message: string) {
  const location = useLocation();
  const current = useRef({ active, message, href: window.location.href, pathname: location.pathname, index: window.history.state?.idx as number | undefined });
  current.current = { active, message, href: window.location.href, pathname: location.pathname, index: window.history.state?.idx as number | undefined };
  useEffect(() => {
    let returning = false;
    const unload = (event: BeforeUnloadEvent) => {
      if (!current.current.active) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const click = (event: MouseEvent) => {
      if (!current.current.active || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin === window.location.origin && destination.pathname === current.current.pathname) return;
      if (!window.confirm(current.current.message)) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    const back = (event: PopStateEvent) => {
      if (returning) { returning = false; event.stopImmediatePropagation(); return; }
      const previous = current.current;
      if (!previous.active || window.location.pathname === previous.pathname || window.confirm(previous.message)) return;
      const index: unknown = event.state?.idx;
      if (typeof index === "number" && typeof previous.index === "number" && index !== previous.index) {
        event.stopImmediatePropagation();
        returning = true;
        window.history.go(previous.index - index);
      }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", click, true);
    window.addEventListener("popstate", back, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", click, true);
      window.removeEventListener("popstate", back, true);
    };
  }, []);
}
