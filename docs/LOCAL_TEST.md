# Local test kit (run the whole site on your own PC)

For a non-technical owner on Windows. You run two sites on your own computer and click through every feature in a browser.

| Site | Address | Who uses it |
|---|---|---|
| Public site | http://localhost:3005 | owners, agents, buyers |
| Admin site | http://localhost:3006 | staff (all staff roles) |

Always type `localhost` (not `127.0.0.1`): the sites check the address you used.

Nothing here touches the internet or real money. The demo data is fake. **Never use this kit, `DEV_LOGIN` or the `.env.local` file on a real server.**

## 1. One-time install (about 10 minutes)

Install these two things first (click Next through the installers):
1. **Node.js** (LTS, version 20 or newer): https://nodejs.org
2. **Docker Desktop**: https://www.docker.com/products/docker-desktop/ . Open it and wait until it says the engine is running.

Then get the code (download the ZIP from GitHub and unzip it, or `git clone`). Open **PowerShell** in that folder (in File Explorer, click the address bar, type `powershell`, press Enter) and paste:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\local-setup.ps1
```

It checks Node and Docker (and tells you in plain English what is missing), creates `.env.local` with random secrets, starts the database, installs, sets up the tables and loads the demo data. Safe to run again.

Mac/Linux: `bash scripts/local-setup.sh`.

## 2. Start the sites

```powershell
powershell -ExecutionPolicy Bypass -File scripts\local-start.ps1
```

Two PowerShell windows open (one per site). Wait about 30 seconds the first time (the first page of each site is slow while it builds). Close the two windows to stop. Mac/Linux: `bash scripts/local-start.sh`.

## 3. Sign in (no Google needed)

- Public site accounts: http://localhost:3005/dev-login
- Staff accounts: http://localhost:3006/dev-login

Click an account button. A red banner reminds you it is for local testing only. To switch person, open `/dev-login` again and click another account. Use two different browsers (or one private window) to be a buyer and an owner at the same time.

## 4. Start again from scratch

```powershell
powershell -ExecutionPolicy Bypass -File scripts\local-reset.ps1
```

Wipes the local database and reloads the demo data (type YES to confirm). Mac/Linux: `bash scripts/local-reset.sh`.

## Demo accounts

All demo email addresses end in `@demo.invalid` (not real).

| Account | Site | What it can do |
|---|---|---|
| Sarah Mitchell (owner) | public | Owns 4 listings (Paddington QLD sale, New Farm QLD rent, Bondi NSW sale, Randwick NSW rent), 1 paid invoice, 2 submitted offers, enquiries |
| Daniel Okafor (owner) | public | Owns 4 listings (Fitzroy North VIC sale, Windsor VIC rent, Chermside QLD sale, Sydney NSW rent), 1 pending invoice, an open offer-link request to answer |
| Mia Chen (agent) | public | Verified QLD licence, appointed on Sarah's Paddington listing |
| James Nguyen (buyer, fully verified) | public | Email, phone and ID verified; has enquiries and two offers |
| Emma Wilson (buyer, email only) | public | Email verified only; ID review waiting |
| Liam Brown (buyer, unverified) | public | Nothing verified; ID review waiting |
| Priya Raman (super_admin) | admin | Everything, including staff invites and messaging settings |
| Chris (compliance), Alex (accountant), Sam (support), Taylor (technical), Robin (reporting) | admin | Each sees only what its role allows (try them to check) |

Also seeded: 8 published listings, a law firm with an approved trust account, plan prices (Basic $0, Standard $149, Premium $299) and add-on prices, terms accepted for every demo account.

## Test checklist

Tick each line. "Expected" is what you should see; anything else is a bug to report (note the page and what you clicked).

### Owner (public site, sign in as Sarah)
- [ ] `/dashboard` loads after sign-in. Expected: your listings and invoices.
- [ ] `/listings/mine` shows 4 listings. Expected: all published.
- [ ] `/listings/new`: create a draft listing (title, address, state, sale or rent, bedrooms, bathrooms, parking). Expected: saved as draft.
- [ ] Set a price and save. Expected: price shown on the draft; a rent listing shows the bond pathway choice.
- [ ] Try to add photos. Expected: "not available" (file storage is off locally; that is correct).
- [ ] Terms: all demo accounts have already accepted them. Open `/terms`. Expected: shows the current version as accepted. (To see the gate, run `local-reset` and delete a `terms_acceptance` row, or use a staff-created new account.)
- [ ] Try to publish the new draft. Expected: blocked. The disclosure rules are not configured (`src/config/disclosures.ts` is empty, so it refuses on purpose), the listing fee is unpaid (payments are stubbed) and the trust account is not approved for it. This is the safe, fail-closed behaviour.
- [ ] `/enquiries`: open the Paddington thread. Expected: three messages between Sarah and James; reply and see it appear.
- [ ] Sign in as Daniel, open his enquiry from James. Expected: an offer-link request; issue the link. Expected: the link is sealed and shown to the buyer.
- [ ] `/plans`. Expected: Basic, Standard, Premium with the demo prices.
- [ ] Sarah's offers on Paddington/Bondi (`/listings/<id>` owner view). Expected: two offers listed; open one, run offer analysis (rules-only, AI is off) and the contract draft preview (draft text only). The AI never accepts offers.
- [ ] Checkout / pay an invoice. Expected: "not available yet" (payments stubbed).
- [ ] `/settings` and `/reports`. Expected: pages load, owner report shows the demo numbers.

### Agent (Mia)
- [ ] `/agent/listings`. Expected: the Paddington listing she is appointed on, and no others.

### Buyer (public site, sign in as James, then Emma, then Liam)
- [ ] `/listings`: search and filter by state, sale or rent, price, bedrooms. Expected: 8 listings narrowing as you filter.
- [ ] Open a listing, save it, then see it in `/buyer/saved-listings`. Expected: appears there.
- [ ] `/buyer/saved-searches`: create a saved search. Expected: saved (alert delivery is only logged on the server window, nothing is sent).
- [ ] `/buyer/verification` as Liam: start email or SMS verification. Expected: "not available yet" (email and SMS providers are not set up, so it fails closed). To try it, sign in as a super admin and enter settings in `/staff/messaging` (needs a real SMTP/Twilio account).
- [ ] `/buyer/verification` photo ID as Liam. Expected: "not available yet" (storage, virus scanner not running locally).
- [ ] Enquire on a listing as Liam. Expected: a thread opens with your message.
- [ ] As James on the Fitzroy North listing: request an offer link. Expected: request already open; wait for Daniel to issue it, then open the link.
- [ ] Submit an offer with the link (price, deposit, settlement days, conditions, tick "final"). Expected: accepted once; opening the same link again is refused (single use).
- [ ] As Emma (email only) request an offer link. Expected: refused or asked to finish verification.

### Staff (admin site, sign in as Priya first)
- [ ] `/staff`: home shows the screens your role can open.
- [ ] `/staff/cases`: list loads (empty is fine). Raise and resolve a case if the page offers it.
- [ ] `/staff/id-review`: two waiting submissions (Emma, Liam). Expected: they appear; images are not available locally. Approving needs images so it stays blocked.
- [ ] `/staff/trust-accounts`: Harbour Legal (demo) shows as approved.
- [ ] `/staff/pricing`: plan and add-on prices; change a price with a reason. Expected: saved and visible in `/plans` on the public site.
- [ ] `/staff/invites`: invite an email and revoke it. Expected: listed; the last super admin cannot be removed.
- [ ] `/staff/reports`: loads with demo totals.
- [ ] `/staff/audit`: lists the actions you just took (append only, cannot be deleted).
- [ ] `/staff/messaging`: shows SMS and email as "not set". Expected: saving works because the key was generated; test send fails without a real account.
- [ ] Sign in as each other role (compliance, accountant, support, technical, reporting). Expected: a screen your role may not use shows "not allowed" (403) instead of data.
- [ ] Open `http://localhost:3006/listings`. Expected: 404 (the admin site serves staff pages only). Open `http://localhost:3005/staff`. Expected: 404.
- [ ] Theme editor and investor module switch: not in this version of the code, so there is nothing to click. (If a later version adds them, add them to this list.)

### Safety checks for the test sign-in
- [ ] With the sites running, `http://localhost:3005/dev-login` works. Stop, edit `.env.local` to remove the line `DEV_LOGIN=1`, start again: `/dev-login` must answer 404.

## What is stubbed locally

| Area | What happens locally |
|---|---|
| Payments (Westpac PayWay) | Not connected. Checkout says "not available yet"; nothing can be marked paid (demo listings were seeded as paid). |
| SMS | No provider. Mobile verification says "not available yet". |
| Email | No SMTP server. Email verification and alerts send nothing (alerts are only logged in the site window). |
| ID check | No provider and no image storage or scanner. Photo ID upload is "not available yet"; staff ID review has two seeded items without images. |
| File storage and photos | Off (`STORAGE_DRIVER` unset). Uploads answer "not available". |
| AI | Self-hosted AI engine is not installed. AI features say they are off; the rules-only offer analysis and draft contract still work. |
| Google sign-in | Replaced by `/dev-login`. Real Google sign-in stays off (no Google keys). |
| Disclosure rules for publishing | Not configured in code, so publishing a new listing is blocked on purpose. |

## How the test sign-in is kept out of production

`/dev-login` and `POST /api/dev/login` answer 404 unless **all** are true: `NODE_ENV` is not production, `DEV_LOGIN=1`, `VERCEL` is not set, `APP_URL` (and `ADMIN_APP_URL` for the admin site) are localhost, and both the Host header and the request URL are `localhost`, `127.0.0.1` or `[::1]`. The POST also uses the normal CSRF guard and only signs in seeded `@demo.invalid` accounts. The public site lists user accounts; the admin site lists staff accounts. The seed script refuses to run in production or against any database that is not on localhost.

## Troubleshooting

- "Docker is not running": open Docker Desktop and wait for "Engine running".
- Port 5544 or 3005/3006 in use: close the other program, or edit `docker-compose.local.yml` / the ports in `scripts\local-start.ps1` and `.env.local` together.
- A page shows an error after a reset: close both site windows, run `local-start.ps1` again, and sign in again at `/dev-login`.
- Real Google sign-in (optional, not needed): redirect URI would be `http://localhost:3005/api/auth/google/callback` (public) and `http://localhost:3006/api/auth/google/callback` (admin).
