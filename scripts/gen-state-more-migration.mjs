// Prints db/20261118090000_state_rent_commercial_disclosure_drafts.sql from src/config/disclosures-states-more.ts.
// Run: node --experimental-strip-types scripts/gen-state-more-migration.mjs > db/20261118090000_state_rent_commercial_disclosure_drafts.sql
import { STATE_MORE_DRAFT_VERSIONS, STATE_MORE_SEED_NOTE } from "../src/config/disclosures-states-more.ts";
const q = (s) => s.replace(/'/g, "''");
console.log(`-- Draft rent (residential, commercial) and commercial sale disclosure requirements for NSW, VIC, SA, WA, TAS, ACT and NT.
-- DRAFTS only: nothing is required, and nothing publishes in these combinations, until a Compliance user other than the author approves
-- each one at /staff/disclosures. Content comes from src/config/disclosures-states-more.ts (tests keep the two identical).
INSERT INTO disclosure_config_version (jurisdiction, transaction_type, use_class, version, items, status, note) VALUES`);
console.log(STATE_MORE_DRAFT_VERSIONS.map(v =>
  `  ('${v.jurisdiction}', '${v.transactionType}', '${v.useClass}', 1, '${q(JSON.stringify(v.items))}'::jsonb, 'draft', '${q(STATE_MORE_SEED_NOTE)}')`).join(",\n") + ";");
