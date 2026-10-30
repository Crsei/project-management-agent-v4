import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { Copy } from "./types";
import { useShowcasePreferences } from "./preferences";

/** Only visited controllers mount; switching preserves them, reset replaces one. */
export function ScenarioExplorer<Id extends string>({
  pageId,
  title,
  scenario,
  scenarios,
  renderScenario,
  onResetScenario,
}: {
  pageId: string;
  title: string;
  scenario: Id;
  scenarios: readonly { id: Id; name: Copy }[];
  renderScenario: (id: Id, active: boolean) => ReactNode;
  onResetScenario?: (id: Id) => void;
}) {
  const navigate = useNavigate();
  const { locale } = useShowcasePreferences();
  const [visited, setVisited] = useState<Id[]>([scenario]);
  const [versions, setVersions] = useState<Record<string, number>>({});
  if (!visited.includes(scenario)) setVisited([...visited, scenario]);
  return (
    <div className="showcase-explorer" data-scenario-explorer>
      <div
        className="showcase-scenarios"
        data-scenario-toolbar
        role="region"
        aria-label={`${title} 测试场景`}
      >
        <strong>{title}</strong>
        <label>
          {locale === "en" ? "Scenario" : "场景"}
          <select
            value={scenario}
            onChange={(event) =>
              navigate(`/agent/showcase/${pageId}?scenario=${encodeURIComponent(event.target.value)}`)
            }
          >
            {scenarios.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name[locale]}
              </option>
            ))}
          </select>
        </label>
        <span>{locale === "en" ? "Edits stay in each scenario" : "各场景分别保留编辑"}</span>
        <button
          type="button"
          onClick={() => {
            onResetScenario?.(scenario);
            setVersions((state) => ({ ...state, [scenario]: (state[scenario] ?? 0) + 1 }));
          }}
        >
          {locale === "en" ? "Reset scenario" : "重置当前场景"}
        </button>
      </div>
      <div className="showcase-scenario-body">
        {visited.map((id) => (
          <div
            className="h-full"
            key={`${id}:${versions[id] ?? 0}`}
            hidden={scenario !== id}
            data-scenario={id}
          >
            {renderScenario(id, scenario === id)}
          </div>
        ))}
      </div>
    </div>
  );
}
