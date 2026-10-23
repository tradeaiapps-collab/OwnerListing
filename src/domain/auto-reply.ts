import type { OfferAction, OfferPolicyDecision } from "./offers";

export interface AutoReplySettings {
  enabled: boolean;
  /** Owner can pause at any time. */
  paused: boolean;
  /** Minutes the reply is held so the owner can read, edit, cancel, send now, or take over. */
  reviewWindowMinutes: number;
}

export type AutoReplyDecision =
  | { kind: "hold_for_owner"; reason: string }
  | { kind: "send_after"; sendAfter: string };

/** Only routine replies may be auto-sent. Counters, acceptances and anything with a price stay with the owner. */
const AUTO_SENDABLE: readonly OfferAction[] = ["draft_reply", "request_information"];

/**
 * Decides whether a reply may be sent automatically, and when. Auto-sent replies are
 * never sent immediately: they wait for the owner's review window. Out-of-mandate
 * situations always wait for the owner to decide.
 */
export function decideAutoReply(
  action: OfferAction,
  policy: OfferPolicyDecision,
  settings: AutoReplySettings,
  usesOwnerApprovedTemplate: boolean,
  now: string
): AutoReplyDecision {
  if (!settings.enabled || settings.paused) return { kind: "hold_for_owner", reason: "Auto-reply is off or paused." };
  if (!usesOwnerApprovedTemplate) return { kind: "hold_for_owner", reason: "Reply is not from an owner-approved template." };
  if (!policy.mayDraft || !policy.withinMandate) return { kind: "hold_for_owner", reason: "Outside the owner's mandate; owner must decide." };
  if (!AUTO_SENDABLE.includes(action)) return { kind: "hold_for_owner", reason: "This type of reply always needs the owner." };
  if (settings.reviewWindowMinutes < 1) return { kind: "hold_for_owner", reason: "A review window of at least 1 minute is required." };
  const sendAfter = new Date(new Date(now).getTime() + settings.reviewWindowMinutes * 60_000).toISOString();
  return { kind: "send_after", sendAfter };
}
