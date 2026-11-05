import React from "react";
import { useLocation, useNavigate } from "react-router-dom";

interface NavigationLinkClassNameState { isActive: boolean }
export interface NavigationLinkProps extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "href"> {
  to: string;
  replace?: boolean;
  end?: boolean;
  state?: unknown;
  className?: string | ((state: NavigationLinkClassNameState) => string | undefined);
}

function isModifiedEvent(event: React.MouseEvent<HTMLAnchorElement>) {
  return event.metaKey || event.altKey || event.ctrlKey || event.shiftKey;
}
function isPathActive(currentPath: string, to: string, end: boolean) {
  const path = to.split(/[?#]/)[0];
  if (path === "/" || end) return currentPath === path;
  return currentPath === path || currentPath.startsWith(`${path}/`);
}

// Keep the source anchor semantics, but delegate to the already-mounted host
// router. Its settings blocker remains authoritative for drafts and mutations.
export const NavigationLink = React.forwardRef<HTMLAnchorElement, NavigationLinkProps>(
  ({ to, replace = false, end = false, state, onClick, className, children, target, rel, "aria-current": ariaCurrent, ...props }, ref) => {
    const location = useLocation();
    const navigate = useNavigate();
    const isActive = isPathActive(location.pathname, to, end);
    const resolvedClassName = typeof className === "function" ? className({ isActive }) : className;
    const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (event.defaultPrevented || event.button !== 0 || isModifiedEvent(event) || target && target !== "_self" || props.download !== undefined) return;
      event.preventDefault();
      void navigate(to, { replace, state: state ?? location.state });
    };
    return <a {...props} ref={ref} href={to} target={target} rel={rel} onClick={handleClick} className={resolvedClassName} aria-current={ariaCurrent ?? (isActive ? "page" : undefined)}>{children}</a>;
  },
);
NavigationLink.displayName = "NavigationLink";
