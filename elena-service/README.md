# Elena service (API v1)

Elena, the AI assistant, as a small HTTP service for OwnerListing and Archova. No dependencies (Node 22+, `node src/main.ts`). Rule based and deterministic; the engine is `src/engine.ts`, extracted from `src/domain/chat-assistant.ts` (a parity test fails if they drift).

## Run
`ELENA_API_KEYS="ownerlisting:SECRET,archova:SECRET" PORT=3010 node elena-service/src/main.ts` (or build the Dockerfile; or wrap `createElenaServer` for a serverless host). Production refuses to start without API keys. Send the key as `x-api-key` (or `Authorization: Bearer`). `GET /healthz` needs no key.

| Env | Meaning |
|---|---|
| `ELENA_API_KEYS` | `name:secret,...` one per calling project (required in production) |
| `ELENA_TTS_URL` / `ELENA_TTS_API_KEY` | Self-hosted text-to-speech: we `POST {"text","voice":"elena"}`, it returns audio bytes. Unset: `/voice` answers 501 and clients use the device voice |
| `ELENA_MEDIA_DIR` | Folder of `elena-video-{idle,talking,presenting}.{mp4,webm}` (default `./media`, all under 65 KB) |
| `ELENA_RATE_PER_MINUTE` | per project, default 600 |

## Endpoints (`/api/...` is the same as `/api/v1/...`)
- `POST /api/chat` returns `response_id, text, answer_type (info|advice|clarification), topic, pose, suggestions, show_me?, highlight?, voice_url, rules_version`. Omit `question` to get the welcome.
- `GET /api/voice/<response_id>` returns audio (immutable, ETag). The id is a hash of the answer text, so it is the same for every caller; the text must have come from a `/chat` call in the last hour (else 404).
- `GET /api/video/<idle|talking|presenting>?format=mp4|webm` (or `Accept`), with ETag and Range.
- `GET /api/rules` returns Elena's constraints and version.

## What a project sends
Snake_case, strict: any field not listed is rejected with 400, so private data cannot slip in.
- `user_role`: `buyer | seller | owner | agent` (`seller` = `owner`). `question` (up to 500 characters; phone, email or link gives 422). `persona_name` (optional).
- `listing_context`: `title, address, transaction_type (sale|rent), property_type`, optional `suburb, asking_cents, bedrooms, bathrooms, parking, verified_disclosures`. Public listing facts only.
- `offer_context` (optional): `price_cents, deposit_cents, settlement_days, conditions[], status`, optional `counter {from_party, price_cents, deposit_cents, settlement_days, conditions[], status}`. Only terms both parties already see.
- `conversation_history` (optional, up to 20 turns): validated and reserved. Answers do not use it yet.

Never send: the owner's floor or mandate, private notes, contact details, safety flags, user ids. The caller still owns authorisation (is this person in this thread?), the discrimination wording check, rate limits per user, and storing the permanent record of each turn.
