/** POST JSON to a staff API route and return the message to show. */
export async function postStaff(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  if (!r) return { ok: false, status: 0, data: { error: "Network error." } };
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

export function loadError(status: number): string {
  if (status === 401) return "Sign in as staff.";
  if (status === 403) return "Your role cannot use this screen.";
  return "Could not load.";
}
