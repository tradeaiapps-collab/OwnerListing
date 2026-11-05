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

/**
 * Per-user limits on document upload (security review 2026-10, finding 1). Product can change the numbers.
 * Rate: 20 upload attempts per user per 10 minutes, counted before the body is read (a refused attempt still counts).
 * Quota: 500 MB of stored files per user in any rolling 24 hours: a few full-size videos (100 MB each) or hundreds of photos.
 */
export const UPLOAD_RATE = { windowMs: 10 * 60 * 1000, perUser: 20 } as const;
export const UPLOAD_DAILY_BYTES = 500_000_000;
export const UPLOAD_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Listing photos are sent one file per request (a 40-photo gallery is 40 requests), so they have their own bucket.
 * Rate: 120 photo uploads and 120 gallery saves per user per 10 minutes. Bytes count against the same 500 MB a day.
 */
export const PHOTO_UPLOAD_RATE = { windowMs: 10 * 60 * 1000, perUser: 120 } as const;
export const PHOTO_LAYOUT_RATE = { windowMs: 10 * 60 * 1000, perUser: 120 } as const;

/**
 * Per-user limits on document deletion requests (security review 2026-10, finding 1). Product can change the numbers.
 * Rate: 5 recorded requests per user per 10 minutes. Cap: 20 open requests per user; "open" is every request whose
 * outcome is not delete_now (amend_only, held and rejected wait for a person or the legal process; delete_now needs nothing).
 */
export const DELETION_REQUEST_RATE = { windowMs: 10 * 60 * 1000, perUser: 5 } as const;
export const DELETION_OPEN_CAP = 20;

/** Fails closed: unknown usage or an unusable size is treated as over quota. */
export function withinByteQuota(usedBytes: unknown, incomingBytes: number, limit: number = UPLOAD_DAILY_BYTES): boolean {
  return typeof usedBytes === "number" && Number.isFinite(usedBytes) && usedBytes >= 0
    && Number.isFinite(incomingBytes) && incomingBytes > 0 && usedBytes + incomingBytes <= limit;
}

/** Investor projects module. Every counter fails closed (withinLimit). Product can change the numbers. */
export const INVESTMENT_RATE = {
  projectWrite: { windowMs: 24 * 60 * 60 * 1000, perUser: 10 },
  declaration: { windowMs: 24 * 60 * 60 * 1000, perUser: 5 },
  newInterest: { windowMs: 24 * 60 * 60 * 1000, perUser: 10 },
  message: { windowMs: 60 * 60 * 1000, perUser: 30 },
  toggle: { windowMs: 60 * 60 * 1000, perUser: 10 },
  contractUpload: { windowMs: 24 * 60 * 60 * 1000, perUser: 5 }
} as const;

/** Guide assistant questions (public, signed in or not), per client IP hash. Counted before anything else; fails closed. */
export const GUIDE_RATE = { windowMs: 10 * 60 * 1000, perIp: 60 } as const;

/** Elena's search help (filters from a sentence, result facts, compare summaries), per client IP hash. */
export const SEARCH_ASSIST_RATE = { windowMs: 10 * 60 * 1000, perIp: 60 } as const;

/** AI: the staff "Test connection" button, and the owner's "Suggest description" button (each call uses the shared model server). */
export const AI_TEST_RATE = { windowMs: 60 * 60 * 1000, perStaff: 10, allStaff: 30 } as const;
export const AI_DESCRIPTION_RATE = { windowMs: 60 * 60 * 1000, perUser: 10 } as const;
export const LISTING_ASSISTANT_RATE = { windowMs: 60 * 60 * 1000, perUser: 120 } as const;
export const AI_PHOTO_CAPTION_RATE = { windowMs: 60 * 60 * 1000, perUser: 20 } as const;

/**
 * Security review 2026-10 (medium). Per-user limits next to the per-IP ones, so changing IP does not reset a counter.
 * tokenIssue: OAuth token endpoint, per client id and IP together. signerLookup: generating a signing document checks signer
 * addresses, so it is limited per IP (and per user) to stop address guessing. signAttempt: signing tries per user.
 */
export const TOKEN_ISSUE_RATE = { windowMs: 60 * 1000, perClientAndIp: 10, perIp: 30, perClient: 30 } as const;
export const SIGNER_LOOKUP_RATE = { windowMs: 60 * 60 * 1000, perIp: 5, perUser: 20 } as const;
export const SIGN_ATTEMPT_RATE = { windowMs: 15 * 60 * 1000, perUser: 10 } as const;
