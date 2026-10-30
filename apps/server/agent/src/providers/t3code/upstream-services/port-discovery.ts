import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

/** Process lifecycle accounting only; PM does not enable t3 Preview discovery. */
export const AGENT_THREAD_ENV = "PM_PROVIDER_THREAD_ID";
export class PortDiscovery extends Context.Service<PortDiscovery, {
  readonly trackAgent: () => () => void;
  readonly activeAgents: () => number;
}>()("pm/provider/AgentProcessLifecycle") {}

export function makePmAgentProcessLifecycle(): PortDiscovery["Service"] {
  let active = 0;
  return {
    activeAgents: () => active,
    trackAgent: () => {
      active++;
      let released = false;
      return () => { if (!released) { released = true; active--; } };
    },
  };
}
export const layer = Layer.sync(PortDiscovery, makePmAgentProcessLifecycle);
