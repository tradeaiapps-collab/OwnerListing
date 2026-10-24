/** What the owner can do with a submitted offer. The AI is never an actor here: only a signed-in owner decides. */
export type OwnerDecision = "accept" | "reject" | "counter_request";

const TARGET: Record<OwnerDecision, string> = { accept: "accepted", reject: "rejected", counter_request: "countered" };
const FROM: Record<OwnerDecision, readonly string[]> = {
  accept: ["submitted", "under_review", "countered"],
  reject: ["submitted", "under_review", "countered"],
  counter_request: ["submitted", "under_review"]
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export function parseDecision(body: unknown): OwnerDecision | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const d = (body as Record<string, unknown>)["decision"];
  return d === "accept" || d === "reject" || d === "counter_request" ? d : undefined;
}

/** The status an offer moves to, or undefined if the decision is not allowed from its current status. */
export function nextStatus(current: string, decision: OwnerDecision): string | undefined {
  return FROM[decision].includes(current) ? TARGET[decision] : undefined;
}
export const statusesAllowing = (decision: OwnerDecision): string[] => [...FROM[decision]];
