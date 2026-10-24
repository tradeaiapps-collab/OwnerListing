/** Start of the fixed window containing `nowIso`, as an ISO string. */
export function windowStart(nowIso: string, windowMs: number): string {
  const t = Date.parse(nowIso);
  return new Date(t - (t % windowMs)).toISOString();
}

/** Fails closed: anything that is not a finite hit count within the limit is treated as over the limit. */
export const withinLimit = (hits: unknown, limit: number): boolean =>
  typeof hits === "number" && Number.isFinite(hits) && hits >= 1 && hits <= limit;

export const OFFER_LINK_ISSUE_RATE = { windowMs: 10 * 60 * 1000, perOwner: 10 } as const;

/** Per-buyer spam limits for enquiries. Automated system messages are not counted. */
export const ENQUIRY_RATE = {
  messages: { windowMs: 60 * 60 * 1000, perBuyer: 20 },
  newThreads: { windowMs: 24 * 60 * 60 * 1000, perBuyer: 5 }
} as const;

/** A buyer asking for an offer link from a thread. */
export const OFFER_LINK_REQUEST_RATE = { windowMs: 24 * 60 * 60 * 1000, perBuyer: 5 } as const;

export const OFFER_RATE ={ windowMs: 10 * 60 * 1000, perLink: 5, perIp: 20 } as const;
