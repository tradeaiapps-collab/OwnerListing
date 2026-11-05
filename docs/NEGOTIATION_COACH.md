# Elena negotiation coach

Advice for the seller (or appointed agent) on one offer and on the listing as a whole. Rules plus a small model, so the numbers are identical with AI on or off. Elena suggests; only the owner accepts, counters or declines.

Code: `src/domain/negotiation-coach.ts` (pure), `src/server/negotiation-coach-{db,service}.ts`, routes `POST /api/listings/{id}/offers/{offerId}/coach` and `POST /api/listings/{id}/coach/parse`, UI `app/listings/[id]/offers/negotiation-coach.tsx`. Tests: `tests/negotiation-coach*.test.ts`.

## What it does
| Part | How |
| --- | --- |
| Offer parsing | `parseOfferText` reads price, deposit (% or $), settlement (days, weeks, months), conditions and pressure phrases from pasted email or text. Lists what it could not read; never guesses a price. |
| Offer analysis | Existing `analyseOffer` flags plus coach red flags (buyer retreat, tiny increments, no or thin deposit, sale-dependent with thin deposit, very long settlement, pressure). |
| Buyer model | The buyer's own price trajectory. Shrinking steps give a geometric tail, so the likely ceiling is estimated; with no history it is a share of the gap to asking. Internal only, never shown. |
| Counter scenarios | Hold firm, Meet in the middle (asymmetric Nash bargaining between the seller's and buyer's reserves; seller share grows with competing offers), Close quickly (adds a small conveyancing contribution). Each has accept chance x completion chance = close chance, and an expected net value (price less contribution, x close chance, small time discount). |
| Concessions | Ordered cheapest first: settlement flexibility, shorter or evidenced finance condition, continue-to-market clause, share a building report, deposit, fixtures, small cost contribution. General information, not legal advice. |
| Risk | 0 to 100 from price gap, finance and deposit, settlement length, conditions (+ verification ticks if known). low under 30, medium under 55, else high. |
| Multi-party | `listingStrategy` ranks all open offers by expected result, advises a best-and-final round when the top two are within 3%, flags sale-dependent offers, warns when every offer is 15% under asking. |
| Templates | Counter x3, best and final, ask for detail, holding message, decline. Saved as `ai_draft` rows and run through `guardDraft`, so they use the same checks and the same send step as AI drafts. |
| History | The existing offer timeline (`offer_event`) is the negotiation history; the coach reads the seller's latest counter from it. |

## Learning from closed and failed deals
`trainingSamplesPg` turns terminal sale offers (accepted = closed; rejected, withdrawn, expired = failed) into 10 numeric features (price vs asking, deposit shortfall, settlement excess, condition count, finance, subject-to-sale, building and pest, counter rounds, competing offers, buyer raised before). No ids leave the query. `trainModel` is logistic regression pulled towards the hand-set prior (worth 25 pseudo-observations). Under 30 samples or under 5 of either outcome it returns the prior unchanged. The model is retrained at most every 10 minutes per server and the response says whether it is `prior` or `learned` and from how many offers. `evaluateModel` gives Brier score and accuracy for comparing a retrain.

The close probability of a counter is accept chance (from the buyer reserve estimate) x completion chance (model with the price feature removed, so price is not counted twice).

## Rules that do not bend
- No accept action, no auto-send. The summary says so.
- The floor price is opened server-side only to clamp scenarios (floor and per-round concession measured from the standing ask). It is never in a response, a template or a prompt; `guardDraft` is given it as a leak check.
- A template mentions other offers only if the seller ticks the box (`mentionOtherOffers`). One buyer's terms are never in another buyer's template.
- Only price, terms and history are used. No buyer identity.
- Templates are held (must be edited) while the wording filter is not installed, like every AI draft.

## Limits
- Training features are the offer as submitted, not the final negotiated terms (counters live in `offer_counter`).
- Rent uses the same maths without cost contributions or conditions; it is untuned.
- Reserve estimates are only as good as the buyer's history; with a first offer the confidence is "low" and the accept chance is flatter.
- Not yet: staff-editable weights, per-suburb models, scheduled retraining job, feeding scenarios into the mandate auto mode (still off).
