# OwnerListing (Australian owner-sold property marketplace)

Full working rules: project doc `working-rules.md` in the Claude project "Realestate Owner". Key points:
- One feature per PR; minimal patches; name files before editing; no new design docs.
- Gate: `npm run typecheck` and `npm test` (CI runs both). Never skip or disable tests.
- Run: `npm install`, `npm run dev` (port 3004).
- Layout: `src/domain` pure TS rules, `src/adapters` external services, `app` Next.js, `db` SQL migrations (`NNN_name.sql`), `tests` Vitest.
- Security review needed for auth, permissions, payments/trust accounts, raw SQL, uploads, ID verification.
- Hard rules: AI never accepts an offer or reveals the floor; platform holds no money (Westpac PayWay for listing fees only); AI is self-hosted; investment module disabled until Gate G4.
- Status: keep `PROJECT_STATUS.md` short; update once a day. End each task with: files changed, work completed, tests performed, remaining issues.
