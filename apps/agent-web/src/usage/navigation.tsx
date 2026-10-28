import { Link, useLocation, type LinkProps } from "react-router-dom";

/** Usage navigation preserves the originating route and its router state. */
export function UsageNavigationLink({ children = "Usage", state, ...props }: Omit<LinkProps, "to">) {
  const location = useLocation();
  return <Link {...props} data-usage-navigation to="/usage" state={{ usageReturnTo: `${location.pathname}${location.search}${location.hash}`, usageReturnState: location.state, usageNavigationState: state }}>{children}</Link>;
}
