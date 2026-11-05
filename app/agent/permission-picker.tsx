"use client";
import { AGENT_PERMISSION_LABELS, SCOPE_PERMISSIONS, type AgentPermission } from "../../src/domain/access";

/** Checkboxes for what an agent may do, limited to the chosen scope. Offer decisions are never offered: they stay with the owner. */
export function PermissionPicker({ scope, value, onChange, disabled }: {
  scope: "enquiries_and_offers" | "full";
  value: readonly AgentPermission[];
  onChange: (next: AgentPermission[]) => void;
  disabled?: boolean;
}) {
  const allowed = SCOPE_PERMISSIONS[scope];
  return (
    <fieldset className="stack" disabled={disabled}>
      <legend>What the agent can do</legend>
      {allowed.map(p => (
        <label key={p}>
          <input type="checkbox" checked={value.includes(p)}
            onChange={e => onChange(e.target.checked ? allowed.filter(x => x === p || value.includes(x)) : value.filter(x => x !== p))} />
          {" "}{AGENT_PERMISSION_LABELS[p]}
        </label>
      ))}
      <p className="muted">Accepting or rejecting offers always stays with you.</p>
    </fieldset>
  );
}

/** Plain list of what an appointment grants. */
export function PermissionList({ granted }: { granted: readonly AgentPermission[] }) {
  return <ul>{granted.map(p => <li key={p}>{AGENT_PERMISSION_LABELS[p]}</li>)}</ul>;
}
