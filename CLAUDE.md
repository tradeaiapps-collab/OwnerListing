# OwnerListing agent notes

Australian property marketplace. Owners list their own homes; AI assists but never accepts offers. Stack: TypeScript domain layer (`src/domain`, pure functions), Vitest tests (`tests/`), Next.js app (`app/`), PostgreSQL migrations (`db/NNN_name.sql`, new ones timestamped).

## Commands
- `npm test` and `npm run typecheck` are the gate (CI runs both). `npm run dev` serves on port 3004.
- `npm run check:providers -- --production` before a deploy (provider keys: docs/PROVIDER_KEYS.md).

## Rules
- Working rules: see claude/working-rules.md in the Claude Project. One feature per PR; minimal patches; name files before editing.
- Never skip or disable a test. Never edit CI to pass.
- Security review for auth, file upload, ID/personal data, raw SQL, payments. No live payment keys until pen test and counsel sign-off.
- Platform holds no money: deposits go to the solicitor's trust account; nothing publishes without verified trust account.
- AI is self-hosted, no external AI account; AI never auto-accepts offers.
- Chat messages and published files are never deletable.

## Details
PROJECT_STATUS.md (decisions), docs/ (reference; search, don't read whole), db/ (schema).
Phone app: mobile/ (Expo); its README covers sign-in tokens, push and setup.
