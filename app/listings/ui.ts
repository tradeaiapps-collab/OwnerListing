import type { BondPathway } from "../../src/domain/publish";

export const JSON_HEADERS = { "content-type": "application/json" } as const;

export const fieldStyle = { width: "100%", boxSizing: "border-box", padding: 8, fontSize: 16 } as const;

/** Owner-facing labels. Record keyed by BondPathway so the compiler flags any pathway left without a label. */
export const BOND_PATHWAY_LABELS: Record<BondPathway, string> = {
  state_bond_authority: "State bond authority",
  solicitor_trust: "Solicitor's trust account",
  bank_guarantee: "Bank guarantee",
  no_bond: "No bond"
};
