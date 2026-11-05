# Settlement risk predictor (Elena)

Rules-based, not a trained model. Code: `src/domain/settlement-risk.ts` (points table, bump `RULES_VERSION` when it changes), `src/server/settlement-risk-db.ts` (facts + storing). Tables: `settlement_risks` (last score per settlement, for trends), `fallthrough_history` (db/20261105270000).

Score = 20 base + points, clamped 1 to 100, read as an uncalibrated "fallthrough probability". Bands: low under 35, medium 35 to 59, high 60+.
- Finance past target: +15, +25 once more than 7 days late
- Open major/critical inspection finding (buyer's or shared with buyer): +20
- Inspection cancelled/rescheduled by buyer: +10 each, max 3
- Another buyer's live offer on the listing: +25
- Fall-through case proposed or disputed: +25
- Cooling-off ends within 2 days (or ended), agent has not ticked "buyer still interested": +15
- Stage blocked +10, open over 5 days +5
- Buyer has not confirmed finance needs 3+ days after acceptance: +5; finance stage reached with inspection incomplete: +5
- Agreed price below asking: -10

Predicted fall-through date (high only): earlier of the next open target date and today + (100 - score) / 4 days.

Where: staff `/staff/settlements` (ranked table, top 10 alerts, history), `/staff/settlements/[id]`; owner and agent see a panel on `/settlements/[id]` (the buyer gets 403). APIs: `GET /api/staff/settlements/risk` (re-scores and stores), `GET /api/staff/settlements/[id]/risk`, `GET /api/settlements/[id]/risk`.

Not built: ML training, live monitoring, emails or SMS, deal blocking, insurance advice. "-5 per day seller delays" from the brief is not implemented (meaning unclear). Scores refresh only when staff open the dashboard. Counsel has not reviewed the wording; it is advice only.
