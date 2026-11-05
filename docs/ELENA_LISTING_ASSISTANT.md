# Elena listing assistant (guided creation)

Elena sits at the top of the create and edit listing form for owners and agents. She suggests; every change needs a click and nothing is saved until the form is saved. Rules only: no external AI account (see CLAUDE.md).

## What she does
| Feature | Where | Notes |
|---|---|---|
| Clarifying questions | `clarifyingQuestions` | Up to 4, essentials first (suburb, bedrooms, bathrooms). Optional ones stop after 2 "Not now" clicks. |
| Field tips ("?") | `listing-assistant-tips.ts` | Client-safe file (no server imports) so the form can use it. |
| Auto-tagging | `suggestTags` | Amenity ticks plus highlights (renovated, open plan, views...) from fixed keyword rules, with the words that triggered each. |
| Description rewriter | `rewriteDescription` | "Better" and "shorter". Only removes, trims and reorders the author's words, plus one opening line built from the entered details. Drops contact details, absolute condition claims and blocked wording; keeps report notices. Result passes `checkSuggestion`. |
| Pricing strategy | `pricingAdvice` | Uses `estimatePrice` (comparables). Three options (competitive, at market, aspirational) tucked just under common search steps, never below the low estimate (underquoting rule). |
| Photo shot list | `photoPlan` | By property type and extras. |
| Marketing angles | `marketingAngles` | Describe the property only, never who should buy or rent. |
| Where to advertise | `syndicationPlan` | The platform, saved-search alerts, share link, short-stay portals for furnished rentals, major portals via an agent. |
| Learning | `learnFrom` and friends | See below. |

## API (owners and agents, CSRF, 120 requests per user per hour)
- `POST /api/listings/assistant` `{ facts }` returns the whole plan.
- `POST /api/listings/assistant/rewrite` `{ text, mode?, facts? }`.
- `GET | POST | DELETE /api/listings/assistant/feedback`: what was learned; record events `{ kind, key, action, deltaPct? }`; forget everything.

## Learning from edits
Table `listing_assistant_feedback` stores only a fixed-vocabulary key (tag id, question id, rewrite mode, pricing option), the action and, for edited rewrites, the length change in percent. No text the author wrote is stored, so there is no personal data and nothing here is used to train a model (that would need the consent path in `ai-learning.ts`). Per author, newest 500 rows. Effects: tags kept or skipped move up or down; dismissed questions stop; "shorter" aims for the length the author edits to; the preselected rewrite mode and the recommended price option follow past choices (price only when confidence is 50% or more). The author can read it and reset it in the panel.

## Limits and next steps
- Pricing needs a comparables source (`PRICE_DATA_SOURCE`, see docs/PROVIDER_KEYS.md); without it the card says so.
- Rewriting and tagging are rules, not a language model. A self-hosted model pass behind `AiEnginePort` can be added later behind the same checks.
- The photo count is not passed on the form yet, so the photo question is not asked.
