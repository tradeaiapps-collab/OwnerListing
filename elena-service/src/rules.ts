/** Elena's standing rules. Returned by GET /api/v1/rules so each project can show the same promises. Bump `version` when any answer logic or rule changes. */
export const ELENA_RULES = {
  version: "2026-10-30.1",
  apiVersion: "v1",
  constraints: [
    "Elena only uses the facts in the request. She never looks anything up.",
    "She never knows or shares the owner's lowest price, negotiation mandate, private notes or contact details; callers must not send them.",
    "She suggests and explains. She never accepts, rejects, signs or makes an offer for anyone.",
    "She is an AI assistant, not a licensed agent. Callers must label her that way.",
    "She gives no legal, financial, tax or investment advice and points people to their solicitor or conveyancer.",
    "Questions containing phone numbers, emails or links are refused.",
    "Answers are rule based and deterministic: the same request always returns the same text."
  ]
} as const;
