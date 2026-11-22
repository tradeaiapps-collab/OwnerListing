# Test deploy on Vercel (free), for a non-technical person

This is a **test** deploy: two websites from the same code, one public and one for staff only, plus a free database. It is not the production setup (see `docs/DEPLOYMENT.md` for that). Do not put real customer data in it, and do not set any live payment keys.

You will need: a GitHub account with access to this repository, a Google account, about 45 minutes.

## What you are building

| Site | Vercel project | Example address | `APP_MODE` |
|---|---|---|---|
| Public (buyers, owners) | `ownerlisting-public` | `https://www.example.com.au` | `public` |
| Admin (staff only) | `ownerlisting-admin` | `https://admin.example.com.au` | `admin` |

Both projects read the same database. The public project answers **404** for every `/staff` page, `/api/staff` route and staff sign-in. The admin project answers **404** for everything except staff pages, staff APIs, staff sign-in, sign-out, `/api/health` and static files. Staff sign-in cookies are host-only, so the browser never sends them to the public site.

Until you own a domain, use the free `*.vercel.app` addresses Vercel gives each project (step 5 shows where).

## Step 1. Free database (Neon or Supabase)

Pick one.

**Neon** (neon.tech): sign up, create a project, region closest to Australia (Sydney if offered). On the project page click **Connect** and copy the connection string. Copy two: the normal one (called "Direct") and the one with `-pooler` in the host ("Pooled"). It looks like `postgresql://user:password@ep-xxxx.ap-southeast-2.aws.neon.tech/neondb?sslmode=require`.

**Supabase** (supabase.com): create a project, choose Sydney, save the database password. Click **Connect**, copy the **Direct connection** string and the **Session pooler** string. Replace `[YOUR-PASSWORD]` in both with your password.

Keep both strings private (a password manager is fine). Use the **direct** string for step 2 and the **pooled** string as `DATABASE_URL` in Vercel (serverless functions open many short connections; the pooler stops the free database running out).

## Step 2. Create the tables (`npm run migrate`)

This runs once from your own PC, and again after any update that adds a file under `db/`.

1. Install Node.js 22 (nodejs.org, "LTS") and Git.
2. Open a terminal (Windows: PowerShell) and run:
   ```
   git clone https://github.com/falahjoon-prog/ownerlisting.git
   cd ownerlisting
   npm install
   ```
3. Run the migration with the **direct** connection string.
   - Mac/Linux: `DATABASE_URL="paste-direct-string" npm run migrate`
   - Windows PowerShell: `$env:DATABASE_URL="paste-direct-string"; npm run migrate`
4. It prints each file it applies. Running it again applies nothing. If it stops with an error, send the error text to the engineer; do not run it a third time.

Test-deploy shortcut and its risk: the default database user can do everything, including emptying the audit and chat tables. `docs/DEPLOYMENT.md` section 1 describes the safer owner role plus restricted app role. For a throwaway test with fake data, one role is acceptable; for anything real, set up two roles first.

## Step 3. Secrets

Generate one value per line below, on your PC (Mac/Linux terminal, or Windows "Git Bash" which comes with Git):

```
openssl rand -base64 32
```

Each run prints a new random value. Generate separately for each secret and never reuse one. `SESSION_SECRET` must be at least 32 characters (`openssl rand -base64 48` is better). Do not use the same `SESSION_SECRET` value as an example you found anywhere else.

## Step 4. Google sign-in

1. console.cloud.google.com, create a project, **APIs & Services**, **OAuth consent screen** (External, test mode; add yourself and your staff as test users), then **Credentials**, **Create credentials**, **OAuth client ID**, type **Web application**.
2. **Authorised redirect URIs**, add both (replace with your real addresses once known; you can edit later):
   - `https://YOUR-PUBLIC-ADDRESS/api/auth/google/callback`
   - `https://YOUR-ADMIN-ADDRESS/api/auth/google/callback`
3. Copy the **Client ID** and **Client secret**. The same pair is used by both projects.

Staff must already exist in the database as active staff accounts (see `docs/HANDOVER.md`). Signing in with Google alone never creates a staff account.

## Step 5. Create the two Vercel projects

Do this twice. Sign up at vercel.com with GitHub.

1. **Add New**, **Project**, import `falahjoon-prog/ownerlisting`. Framework is detected as Next.js. Leave build settings alone (`vercel.json` is in the repo).
2. Name the first `ownerlisting-public`, the second `ownerlisting-admin`.
3. Open **Environment Variables** and add the values below **before** pressing Deploy (changing one later needs a **Redeploy**, because some values are baked in at build time).
4. Press **Deploy**. When it finishes, the **Domains** tab shows the project's `*.vercel.app` address. Put that address into `APP_URL` / `ADMIN_APP_URL` (exact, `https://`, no trailing path, no trailing slash) and into the Google redirect URIs, then **Redeploy**. This loop is normal.

### Environment variables

Required means the site does not work without it. Fail-closed-optional means leaving it empty is safe: that feature simply refuses to work (answers "not available yet", 403 or 503) and nothing is silently allowed.

| Variable | Public project | Admin project | Required? |
|---|---|---|---|
| `APP_MODE` | `public` | `admin` | Required. If unset in production it falls back to `public`, so the admin project would show nothing. |
| `APP_URL` | public address | leave empty (admin ignores it) | Required on public. Without it: login off, every POST answers 403. |
| `ADMIN_APP_URL` | leave empty | admin address | Required on admin. Without it: staff sign-in off, every POST answers 403. |
| `DATABASE_URL` | pooled string | pooled string | Required. |
| `SESSION_SECRET` | `openssl rand -base64 48` | a different `openssl rand -base64 48` | Required, 32+ characters. Sign-in is off without it. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | from step 4 | same pair | Required. Sign-in is off without them. |
| `TRUSTED_PROXY_HOPS` | `1` | `1` | Required in practice (default 1). Vercel is one hop. |
| `NODE_ENV` | do not set | do not set | Vercel sets it. |
| `NEXT_PUBLIC_SITE_NAME`, `SITE_NAME`, `NEXT_PUBLIC_SITE_TAGLINE`, `SITE_TAGLINE` | optional | optional | Optional. Brand name and tagline; default "OwnerListing". Set `NEXT_PUBLIC_SITE_NAME` on both projects, then redeploy. |
| `THEME_PREVIEW_SECRET` | `openssl rand -base64 48` | the SAME value as public | Optional. Signs the 15-minute `?theme_preview=` link used by Staff > Site appearance. Unset: Preview is off. Not the session secret. On admin also set `APP_URL` to the public address (used only to build the preview link). |
| `OFFER_LINK_TOKEN_KEY` | `openssl rand -base64 32` | leave empty | Fail-closed-optional. Empty: offer links are refused. |
| `ALERT_UNSUBSCRIBE_KEY` | `openssl rand -base64 48` | empty | Fail-closed-optional. Empty: no alerts sent. |
| `ALERT_CRON_SECRET` | `openssl rand -base64 48` | empty | Fail-closed-optional. Empty: `/api/internal/alerts/run` answers 503. |
| `ALERT_CRON_SECRET` (digest) | same value | empty | Daily digest worker: call `POST /api/internal/notifications/digest` with header `x-cron-secret` every hour, on the hour. Needs email delivery configured; the digest link in each email needs `ALERT_UNSUBSCRIBE_KEY`. |
| `ALERT_DELIVERY` | leave empty | empty | Fail-closed-optional. No email/SMS provider is wired yet; nothing sends. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | see "Email with Resend" below | empty | Fail-closed-optional. Empty: no email is sent (sign-up and password-reset links, alerts, offers, staff invites). Set them on the public project; the admin project needs them too if staff invites should send. |
| `SMS_CODE_SECRET` | `openssl rand -base64 48` | empty | Fail-closed-optional. Empty: mobile verification "not available yet". |
| `ID_CHECK_WEBHOOK_SECRET` | empty | empty | Fail-closed-optional. Empty: webhook rejects everything. |
| `PAYWAY_MERCHANT_ID`, `PAYWAY_API_KEY`, `PAYWAY_WEBHOOK_SECRET` | empty | empty | Fail-closed-optional. Empty: checkout "not available yet", so nothing can be marked paid and nothing publishes. Never set live keys here. |
| `STORAGE_DRIVER`, `STORAGE_LOCAL_DIR`, `STORAGE_LOCAL_ALLOW_PRODUCTION`, `CLAMD_HOST`, `CLAMD_PORT` | leave empty | empty | Fail-closed-optional. Empty: uploads answer 503 (see limits below). |
| `INVESTMENT_MODULE_ENABLED` | `false` | `false` | Master key of the investor projects module (also needs the admin switch). Keep `false` until counsel signs off. |

Use a different value for every secret, and different values in the two projects. Never paste a secret into chat, email or the repository.

### Email with Resend (SMTP)

The app already sends through any SMTP relay (`src/adapters/email.ts`: TLS required, timeouts, every send logged on `/staff/messaging`). Resend offers a standard SMTP endpoint, so no code change is needed.

1. Create a free account at resend.com (3,000 emails/month, 100/day on the free plan).
2. Domains, Add domain: your domain (for example `ownerlisting.com.au`), region Sydney if offered. Add the DNS records Resend shows (SPF, DKIM, and a DMARC record is recommended) at your registrar, then wait for "Verified". Until the domain is verified, Resend only sends to your own address.
3. API Keys, Create API key, permission "Sending access", limited to that domain. Copy it once.
4. In Vercel, Settings, Environment Variables (Production), on the public project (and the admin project):

| Variable | Value |
|---|---|
| `SMTP_HOST` | `smtp.resend.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | `resend` |
| `SMTP_PASSWORD` | the Resend API key (`re_...`), mark as Sensitive |
| `SMTP_FROM` | an address on the verified domain, e.g. `no-reply@ownerlisting.com.au` |

5. Redeploy (variables apply to new deployments only).
6. Check: `npm run check:providers -- --production` should list Email (SMTP) as ready. Then sign up with an email-and-password account and request a password reset, confirm both arrive (check spam on first send), and look at the delivery log on `/staff/messaging`.

Do not use `EMAIL_DELIVERY=dev_file` in production. SendGrid or Amazon SES work the same way with their own SMTP host and credentials.

### Check it

- `https://PUBLIC/api/health` and `https://ADMIN/api/health` both show `{"ok":true}`.
- `https://PUBLIC/staff` shows "Not found". `https://ADMIN/listings` shows "Not found".
- `https://ADMIN/` jumps to `/staff`, which has a red **Admin** banner and no buyer or owner links.
- Staff sign-in works only on the admin address. Then the remaining smoke checks in `docs/DEPLOYMENT.md` section 5 (public side).

## Step 6. Your own domain with GoDaddy

GoDaddy **shared hosting generally cannot run Next.js** (it needs a Node server; shared plans serve PHP and static files). So do not upload this site to GoDaddy hosting. Use GoDaddy only to hold the domain and point it at Vercel.

1. In each Vercel project, **Settings**, **Domains**, add the name: `www.example.com.au` to the public project, `admin.example.com.au` to the admin project. Vercel shows the exact DNS record to create (usually a CNAME to `cname.vercel-dns.com`, or a project-specific value Vercel prints).
2. GoDaddy: **My Products**, your domain, **DNS**, **Add New Record**, type **CNAME**: name `www`, value as Vercel shows; then name `admin`, value as Vercel shows. Remove any older `www` or `admin` record first.
3. The bare `example.com.au` cannot be a CNAME. Either set GoDaddy forwarding from `example.com.au` to `https://www.example.com.au`, or add the A record Vercel shows for the root.
4. Wait (usually minutes, sometimes hours). Vercel issues the HTTPS certificate itself.
5. Update `APP_URL` (public) and `ADMIN_APP_URL` (admin) to the new addresses, add both Google redirect URIs, **Redeploy** both projects.

Using one parent domain is fine (`www.` and `admin.`), but the staff cookie is host-only (no `Domain` attribute) and must stay that way: never add a cookie domain.

## Honest limits of Vercel (free "Hobby" plan)

- **Uploads.** The documents route accepts up to 100 MB in code, but Vercel functions accept a request body of only about 4.5 MB, and on the free plan a function may run only a short time (10 to 60 seconds, depending on plan and settings). Larger photos, reports or videos will fail on Vercel even once storage exists. Also, the local-disk storage driver and the ClamAV scanner need a disk and a long-running server, which serverless does not give. So uploads stay at 503 on this test deploy. Production needs object storage with direct (presigned) uploads or a normal server/container.
- **Time limits.** Slow routes (AI, reports, bulk alerts) can time out. The hourly alert job needs a scheduler calling the **public** address (the admin site answers 404 to it, as it does for webhooks): `POST /api/internal/alerts/run` with header `x-cron-secret`; Vercel's free cron is limited, and no scheduler is configured here.
- **Rate limiting.** In-memory rate limits are per function instance, so they are weaker on serverless than on one server.
- **Database.** Free tiers sleep or pause when idle (first request is slow) and have small storage and no guaranteed backups. Do not rely on them for data you cannot lose.
- **Commercial use.** Vercel's free Hobby plan is for non-commercial use; a live business needs a paid plan.
- **Region.** Set the function region to Sydney (`syd1`) under **Settings**, **Functions** if available, so it sits next to an Australian database.
- **Data location and privacy.** The test deploy stores data with US-owned providers; check with counsel before holding real personal or ID data (`docs/COUNSEL_QUESTIONS.md`).

## When something goes wrong

- Everything answers 404 on the admin site: `APP_MODE` is not exactly `admin`, or you opened a public path.
- Sign-in says "not configured": a variable from step 5 is missing, or you did not Redeploy after setting it.
- Google says `redirect_uri_mismatch`: the address in `APP_URL`/`ADMIN_APP_URL` and the Google redirect URI differ by even one character.
- Forms answer 403 "Cross-origin request denied": `APP_URL` (public) or `ADMIN_APP_URL` (admin) is not the exact address in the browser bar.
- "DATABASE_URL is required": variable missing, or the migration was not run.
