import { useEffect, useRef } from "react";
import { useBlocker, useLocation } from "react-router-dom";

/** Shell transitions use their explicit guard; the router owns back/forward cancellation. */
export function useAutomationLeaveProtection(active: boolean, message: string) {
  const location = useLocation();
  const current = useRef({ active, message, pathname: location.pathname, search: location.search });
  current.current = { active, message, pathname: location.pathname, search: location.search };
  const blocker = useBlocker(({ historyAction, currentLocation, nextLocation }) =>
    active && historyAction === "POP" &&
    (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search));
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (window.confirm(message)) blocker.proceed();
    else blocker.reset();
  }, [blocker, message]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (!current.current.active) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const click = (event: MouseEvent) => {
      if (!current.current.active || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      // Shell-owned links run the same guard in their navigation handler.
      if (anchor.hasAttribute("data-automation-leave-guarded")) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin === window.location.origin && destination.pathname === current.current.pathname && destination.search === current.current.search) return;
      if (!window.confirm(current.current.message)) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", click, true);
    };
  }, []);
}
