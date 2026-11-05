# Elena learning loop

Code: `src/domain/elena-learning.ts` (pure), `src/server/elena-learning-db.ts`, migration `db/20261105280000_elena_learning.sql`.

**Capture.** Every AI draft (enquiry replies, offer responses, negotiation-coach templates) becomes an `elena_suggestion` (same id) when saved; sent / edited and sent / discarded becomes `elena_feedback` automatically (`captureDraftCreated/Finished` in `ai-records-db.ts`). Other features call `recordSuggestionPg` / `recordFeedbackPg`. People answer "Did it work?" via `POST /api/elena/feedback` (`app/elena-feedback.tsx`, mounted in the negotiation coach). Past drafts are backfilled by the migration.

**Outcomes.** `settlement_outcomes` is filled from settlement_timeline and agreed fall-throughs; staff add price, days, rounds, satisfaction at `/staff/elena-training`.

**Learning.** Statistics, not LLM retraining: acceptance by feature/type/state/role, success score (reaction 60% + deal outcome 40%), per-person patterns (style, pace, risk), weights per suggestion type and state (needs 30 scored results, each weight within +-50%, shrunk for small groups). The monthly job PROPOSES a version; a super admin (`ai.engine_set`) activates it. Safety rules (floor price, wording filter, no auto-accept) are outside the learned config.

**Privacy.** Counts use every row. Suggestion text and per-person patterns only where the person accepted the AI-learning terms clause; text is redacted; context keeps coded facts only. Evidence tables are insert-only.

**Jobs.** `POST /api/internal/elena-learning/run` with `x-cron-secret` (`ELENA_LEARNING_CRON_SECRET`) and body `{"job":"weekly"|"monthly"}`.

**A/B.** `elena_experiment`; `armForPg(feature, userId)` gives a stable arm; record it on the suggestion; results use a two-proportion z test.

**Not done yet.** `rankSuggestions` and `armForPg` are not yet called by the coach, mediation or lead scoring; mediation, moderation, lead scoring, pricing and inspection responder do not yet call `recordSuggestionPg`; post-settlement and post-dispute prompts are not mounted.
