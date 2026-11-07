import type { ReactNode } from "react";
import { Check, ChevronRight, Minus, TriangleAlert } from "lucide-react";
import { APP_DISPLAY_NAME } from "@pm/cc-switch-ui";
import { cn } from "@pm/openhands-source/utils/utils";
import { AgentAvatar } from "./agent-avatar";

export interface AgentMatrixCell {
  supported: boolean;
  enabled: boolean;
  syncState?: string;
  reason?: string;
}

export interface AgentMatrixRow {
  id: string;
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  issue?: string | null;
  cells: Record<string, AgentMatrixCell>;
}

function AssignmentCheckbox({ checked, indeterminate = false, disabled = false, syncState, label, onChange }: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  syncState?: string;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return <button
    type="button"
    role="checkbox"
    aria-checked={indeterminate ? "mixed" : checked}
    aria-label={label}
    title={label}
    disabled={disabled}
    data-sync-state={checked ? syncState : undefined}
    className={cn("oh-assignment-checkbox", checked && "oh-assignment-checkbox-checked", indeterminate && "oh-assignment-checkbox-mixed")}
    onClick={event => { event.stopPropagation(); onChange(!checked); }}
  >
    {checked ? <Check aria-hidden /> : indeterminate ? <Minus aria-hidden /> : null}
    {checked && syncState && syncState !== "synced" ? <span className="oh-assignment-sync-dot" aria-hidden /> : null}
  </button>;
}

export function AgentMatrixTable({ agents, rows, selected, onSelectedChange, onToggleCell, onOpenRow, agentCounts, rowHeaderLabel, emptyLabel }: {
  agents: readonly string[];
  rows: AgentMatrixRow[];
  selected: Set<string>;
  onSelectedChange: React.Dispatch<React.SetStateAction<Set<string>>>;
  onToggleCell: (rowId: string, app: string, enabled: boolean) => void;
  onOpenRow: (rowId: string) => void;
  agentCounts: Record<string, number>;
  rowHeaderLabel: string;
  emptyLabel: string;
}) {
  const allSelected = rows.length > 0 && rows.every(row => selected.has(row.id));
  const someSelected = rows.some(row => selected.has(row.id));
  return <div className="oh-agent-matrix-scroll">
    <table className="oh-agent-matrix-table">
      <thead>
        <tr>
          <th scope="col" className="oh-agent-matrix-row-header">
            <div className="oh-agent-matrix-row-heading">
              <AssignmentCheckbox
                checked={allSelected}
                indeterminate={someSelected && !allSelected}
                label={rowHeaderLabel}
                onChange={() => onSelectedChange(allSelected ? new Set() : new Set(rows.map(row => row.id)))}
              />
              <span>{rowHeaderLabel}</span>
            </div>
          </th>
          {agents.map(app => <th key={app} scope="col" className="oh-agent-matrix-agent">
            <div>
              <AgentAvatar app={app} size="sm" />
              <span title={APP_DISPLAY_NAME[app as keyof typeof APP_DISPLAY_NAME] ?? app}>{APP_DISPLAY_NAME[app as keyof typeof APP_DISPLAY_NAME] ?? app}</span>
              <small>{agentCounts[app] ?? 0}</small>
            </div>
          </th>)}
          <th scope="col" className="oh-agent-matrix-manage" aria-label={rowHeaderLabel} />
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? <tr><td colSpan={agents.length + 2} className="oh-agent-matrix-empty">{emptyLabel}</td></tr> : rows.map(row => {
          const isSelected = selected.has(row.id);
          return <tr key={row.id} data-testid={`matrix-row-${row.id}`} data-selected={isSelected || undefined}>
            <td className="oh-agent-matrix-row-header">
              <div className="oh-agent-matrix-row-heading">
                <AssignmentCheckbox
                  checked={isSelected}
                  label={row.title}
                  onChange={checked => onSelectedChange(previous => {
                    const next = new Set(previous);
                    if (checked) next.add(row.id); else next.delete(row.id);
                    return next;
                  })}
                />
                {row.icon}
                <div className="oh-agent-matrix-row-copy">
                  <button type="button" onClick={() => onOpenRow(row.id)}>{row.title}</button>
                  {row.subtitle ? <p title={row.subtitle}>{row.subtitle}</p> : null}
                </div>
                {row.issue ? <TriangleAlert aria-label={row.issue} className="oh-agent-matrix-issue" /> : null}
              </div>
            </td>
            {agents.map(app => {
              const cell = row.cells[app];
              return <td key={app} data-testid={`matrix-cell-${row.id}-${app}`} className="oh-agent-matrix-agent">
                {cell && (cell.supported || cell.enabled)
                  ? <AssignmentCheckbox
                    checked={cell.enabled}
                    syncState={cell.syncState}
                    disabled={!cell.supported && !cell.enabled}
                    label={cell.reason ?? `${row.title} · ${APP_DISPLAY_NAME[app as keyof typeof APP_DISPLAY_NAME] ?? app}`}
                    onChange={checked => onToggleCell(row.id, app, checked)}
                  />
                  : <span className="oh-agent-matrix-unsupported" title={cell?.reason}>{cell ? "—" : "—"}</span>}
              </td>;
            })}
            <td className="oh-agent-matrix-manage">
              <button type="button" aria-label={row.title} title={row.title} onClick={() => onOpenRow(row.id)}><ChevronRight aria-hidden /></button>
            </td>
          </tr>;
        })}
      </tbody>
    </table>
  </div>;
}

export function MatrixBulkBar({ selectedCount, agents, canAssign, onAssign, onClearAssignments, onClearSelection, assignLabel, clearLabel, clearSelectionLabel }: {
  selectedCount: number;
  agents: readonly string[];
  canAssign: (app: string) => boolean;
  onAssign: (app: string) => void;
  onClearAssignments: () => void;
  onClearSelection: () => void;
  assignLabel: string;
  clearLabel: string;
  clearSelectionLabel: string;
}) {
  if (selectedCount === 0) return null;
  return <div className="oh-matrix-bulk" data-testid="matrix-bulk-bar">
    <strong>{selectedCount}</strong>
    <span>{assignLabel}</span>
    <div className="oh-matrix-bulk-agents">
      {agents.map(app => {
        const available = canAssign(app);
        return <button key={app} type="button" disabled={!available} onClick={() => onAssign(app)}>
          <AgentAvatar app={app} size="xs" />
          {APP_DISPLAY_NAME[app as keyof typeof APP_DISPLAY_NAME] ?? app}
        </button>;
      })}
    </div>
    <div className="oh-matrix-bulk-actions">
      <button type="button" onClick={onClearAssignments}>{clearLabel}</button>
      <button type="button" onClick={onClearSelection}>{clearSelectionLabel}</button>
    </div>
  </div>;
}
