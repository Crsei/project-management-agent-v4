import { Link, useLocation, type LinkProps } from "react-router-dom";

/** The chat footer entry and `/agent/usage` both resolve to this route. */
export const USAGE_PATH = "/agent/settings/usage";
/** Price, alias and source configuration remain a settings page nested under the usage route. */
export const USAGE_CONFIG_PATH = `${USAGE_PATH}/config`;

/** Usage navigation preserves the originating route and its router state. */
export function UsageNavigationLink({ children = "Usage", state, ...props }: Omit<LinkProps, "to">) {
  const location = useLocation();
  const from = `${location.pathname}${location.search}${location.hash}`;
  return <Link {...props} data-usage-navigation to={USAGE_PATH} state={{ usageReturnTo: from, usageReturnState: location.state, settingsReturnTo: from, usageNavigationState: state }}>{children}</Link>;
}
