# DocuSign e-signing

Added 5 Nov 2026 (db/20261105160000). Replaces the built-in click-to-sign for new documents when `SIGNING_PROVIDER=docusign`. The built-in flow (docs/DOCUMENT_SIGNING.md) stays as the fallback and keeps finishing any document that started with it.

## How it works
- Templates, field filling, the frozen text and its SHA-256 are unchanged. Each `signing_document` now records its `provider` (`builtin` or `docusign`), set once at creation and never changed (database trigger).
- **Send** (`sendViaDocusign`): the platform renders the frozen text as HTML, creates an envelope (`POST /envelopes`, status `sent`) with one embedded signer per person (`clientUserId` = our signer id, anchored signature and date boxes, per-envelope Connect webhook with HMAC), and only then marks the document out for signature. If DocuSign refuses, the document stays a draft.
- **Sign**: each signer clicks "Sign with DocuSign" while signed in to their own account; we request a one-time recipient view for that signer and redirect. DocuSign returns them to `/signing/{id}?docusign=return`, which refreshes the status once.
- **Roles**: free text per signer (Buyer, Seller, Agent, Inspector are suggested). It becomes the envelope role name and appears in the audit trail.
- **Status and audit trail**: `POST /api/webhooks/docusign` (Connect, JSON restv2.1) and the manual "check status" action both go through `applyEnvelopeUpdate`, which is idempotent. Recipient events become `viewed`/`signed`/`declined`; envelope events `completed`/`declined`/`voided`. Every change is an insert-only `signing_event` with `detail.source = "docusign"`.
- **Signed copies**: when the envelope completes we download the combined signed PDF and the certificate of completion, store them in our own file storage (`signing/{documentId}/...`), record key, SHA-256 and size in `signing_artifact` (insert-only), add the signed PDF to the listing's document history (`property_document`, kind `contract`, visible to parties, when the listing has a property record) and log a `stored` event. Download: `GET /api/signing-documents/{id}/files/signed_pdf|certificate` (owner and signers only, attachment, no-store). If the download or storage fails the webhook returns 503 so DocuSign retries; the document is already `completed` and the copy is fetched on the retry or on "check status".
- **Decline and retry**: a decline in DocuSign closes the document (reason kept). The owner can "Send again as a new document": a new draft with the identical frozen text, hash and signers, linked by `retry_of`. Cancel voids the envelope first.
- Built-in `sign`, `decline` and `send` are refused on a DocuSign document, so the two methods can never disagree about one document.

## Signer emails and reminders
Embedded signing means DocuSign emails nobody, so the platform does (src/server/notifier.ts, kinds `signature_requested` and `signature_reminder`, category Account so in-app and email stay on).
- **On send**: every signer gets an email "<owner> has asked you to sign "<document>"" with a "Review and sign" button to `/signing/{id}`. Signing still needs their signed-in account and the second sign-in step.
- **Automatic reminder**: hourly job `POST /api/internal/signing/reminders` (secret `SIGNING_REMINDER_CRON_SECRET`, workflow signing-reminders.yml). A signer still pending 72 hours after their last request gets one reminder (`signing_signer.reminded_at`).
- **Owner resend**: "Email signers again" on the document (`action: "remind"`). Signers asked within the last hour are skipped; people who already signed or declined are never emailed.
- Wording and delivery follow the notification centre; failures are logged in the email delivery log and never block sending the document.

## Setup (john / ops)
1. Create a DocuSign developer (demo) account, then an **integration key** (Apps and Keys): authentication = JWT grant, generate an **RSA keypair**, add redirect URI `APP_URL`. Note the integration key, the API user id and API account id.
2. Grant consent once: open `https://account-d.docusign.com/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=<integration key>&redirect_uri=<APP_URL>` and approve as the API user.
3. Connect > Add configuration is **not needed** (the webhook is set per envelope), but turn on **HMAC signing** for the account (Connect > Configuration) and copy the key.
4. Set: `DOCUSIGN_INTEGRATION_KEY`, `DOCUSIGN_USER_ID`, `DOCUSIGN_ACCOUNT_ID`, `DOCUSIGN_PRIVATE_KEY` (PEM, `\n` for line breaks), `DOCUSIGN_CONNECT_HMAC_KEY`, `APP_URL` (https), optionally `DOCUSIGN_BASE_PATH` (default demo `https://demo.docusign.net/restapi`; live uses your account's base URI) and `DOCUSIGN_OAUTH_HOST` (`account-d.docusign.com`; live `account.docusign.com`). File storage must be configured (`STORAGE_*`), see docs/PROVIDER_KEYS.md.
5. `npm run check:providers`, then set `SIGNING_PROVIDER=docusign`. Going live: DocuSign "Go-Live" review, then switch the base path and OAuth host.
- With `SIGNING_PROVIDER=docusign` but keys missing, new documents are **refused** (503), never silently downgraded. To fall back, unset `SIGNING_PROVIDER`.

## Not verified against DocuSign
No DocuSign account was available when this was built. The client, envelope shape, anchor tabs and Connect event shape follow DocuSign's public eSignature REST v2.1 docs and are unit-tested against fakes only. Before relying on it: run one end-to-end envelope in the demo account (send, sign, webhook, signed PDF) and check the anchor-based signature boxes land on the page.

## Counsel
Whether DocuSign signatures satisfy each state's Electronic Transactions Act for each document type is still counsel's call (docs/COUNSEL_QUESTIONS.md item 8). Deeds and documents needing witnesses may still need wet ink or DocuSign's witnessing options.
