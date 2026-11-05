# White-label: agencies resell under their own brand

## Decision: one shared instance, brand chosen by host name
Every agency runs on the same deployment and the same database. A request is branded by the **Host header**: if the host is a verified domain of an
**active** agency brand, the layout uses that agency's theme; otherwise the platform theme. Listings, accounts, offers and money are **not** split by
tenant (the platform holds no money and listings are one marketplace). Why not separate instances: one deploy and one migration path, no per-agency
infrastructure to patch, and agencies get a domain in minutes. What this does not give: data isolation or an agency-only listing catalogue. If an
agency later needs "only my listings" on its domain, add a `tenant_id` filter to search (separate work package).

## Pieces
- `db/20261105200000_white_label.sql`: `white_label_tenant` (one per agency team), `white_label_domain`, `white_label_asset` (append-only logos).
- `src/domain/white-label.ts`: host rules, brand input to a full validated `ThemeSettings` (same hex, contrast and plain-text checks as the platform theme; no raw CSS).
- `src/server/white-label.ts`: cached host lookup (45 s), DNS TXT check. `request-theme.ts` picks the tenant theme before the platform theme.
- Agency (team managers): `/teams/[id]/brand`, API `/api/agency/white-label` (+ `/asset`, `/domains`).
- Platform staff (`theme.edit`): `/staff/white-label`, API `/api/staff/white-label`.
- Public logo/favicon: `/api/tenant/asset/{logo-light|favicon}?v=<id>`, served only on the tenant's own host.

## Lifecycle and safety
draft -> (domain verified by DNS TXT `_wl-verify.<host>` = `wl-verify=<token>`) -> staff approve -> active. Staff can suspend at once. Renaming the brand or
uploading a new logo on an active brand sends it back to draft (no swapping in another company's name after approval). Reserved hosts (localhost, vercel.app,
`PLATFORM_HOSTS`) cannot be claimed; a host belongs to one agency; at most 5 domains per agency. Every change is in the audit log.

## Deployment
1. `npm run migrate`. 2. Set `PLATFORM_HOSTS` (public hostnames of the platform). 3. Add the agency's domain to the hosting project (Vercel: Domains) so TLS
is issued; the agency sets a CNAME to the platform host and the TXT record shown on its brand page. 4. Staff approve at `/staff/white-label`.
Rollback: suspend the brand (live within ~45 s per server) or remove the domain; the migration is additive.

## Not built yet
Per-agency billing and client invoicing, agency-only catalogue, white-label emails/sender domain, custom dark palette and fonts, automatic Vercel domain API calls.
