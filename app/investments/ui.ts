export const JSON_HEADERS = { "content-type": "application/json" } as const;

export interface Project {
  id: string; title: string; location: string; jurisdiction: string; projectType: string; summary: string; stage: string;
  fundingTargetCents: number; minimumTicketCents: number; timeline: string; risks: string; structureDescription: string;
  visibleTo: "wholesale_only" | "all_verified"; issuerName: string; issuerLicenceBasis: string; issuerStatement: string;
  status: "pending_review" | "approved" | "changes_requested" | "rejected"; version: number; reviewReason?: string; updatedAt: string;
}

export const aud = (cents: number) => (cents / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
export const label = (v: string) => v.replace(/_/g, " ");
export const STATUS_LABEL: Record<Project["status"], string> = {
  pending_review: "Waiting for staff review", approved: "Approved", changes_requested: "Changes requested", rejected: "Rejected"
};
export const STEP_LINK: Record<string, [string, string]> = {
  verify_email: ["/buyer/verification", "Verify your email"], verify_phone: ["/buyer/verification", "Verify your mobile"],
  verify_id: ["/buyer/verification", "Complete the ID check"], declare: ["/investments/investor", "Complete the investor declaration"],
  investor_account: ["/api/auth/google/start?as=buyer", "Sign in with an investor (buyer) account"]
};

export async function send(url: string, method: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const r = await fetch(url, { method, headers: JSON_HEADERS, body: JSON.stringify(body) }).catch(() => null);
  if (!r) return { ok: false, status: 0, data: { error: "Network error." } };
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}
