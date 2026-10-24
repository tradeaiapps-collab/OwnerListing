# Site appearance (theme and branding)

Staff change how the public site looks without code: Staff > Site appearance (`/staff/site`, admin site).

## Who may edit
Permission `theme.edit` (src/domain/staff-access.ts): `super_admin` and the `designer` role only. `designer` holds no other permission (no reports, personal data, pricing or staff management). Invite a designer under Staff access. Every staff API checks CSRF, the staff session (role read from the database now) and the permission before doing anything.

## Workflow
- **Save draft**: each save is a new row in `site_theme_version` (insert-only). A stale editor (someone else saved since) gets 409 instead of overwriting.
- **Preview**: the editor shows the public home in an iframe with `?theme_preview=<token>`. The token is HMAC-signed with `THEME_PREVIEW_SECRET`, lasts 15 minutes and is issued only to staff with `theme.edit`. Colours, fonts, sizes and spacing update while typing (the page validates the settings it is sent and builds the CSS itself; raw CSS is never accepted). Press Reload after saving to see text, navigation and images.
- **Publish**: makes the saved draft live (must be the draft you saw). `site_theme_publish` records who and when.
- **Revert to version N**: copies N into a new version and makes it live at once (rollback). **Reset to defaults**: new draft of the built-in defaults, live only after Publish.
- The public site (APP_MODE=public or admin or all) reads the published version at request time, cached about 45 s per server; a publish clears the cache on the server that handled it. If the database or the settings are unavailable it uses the built-in defaults (the previous look).

## What is validated (server side, src/domain/site-theme.ts)
Hex colours only (6 digits); WCAG AA contrast (4.5:1 text pairs, 3:1 primary and accent on the page background) in light and dark; numbers outside their range are rejected; fonts and navigation items come from fixed lists; links are `https://` or a same-site path; names, tagline and labels are plain text with length caps (no `<`, `>`, braces, backticks, control characters); unknown fields are errors. CSS is generated from the validated values only.

## Logo and favicon
PNG, JPEG, WebP (ICO for the favicon). Type is read from the bytes and the declared content type must match; SVG is rejected; at most 512 KB; logos up to 2000 px, favicon up to 512 px. Stored in `site_theme_asset` (bytea, insert-only). Served at `/api/site/asset/<logo-light|logo-dark|favicon>?v=<id>` with a fixed content type, `nosniff`, a sandbox CSP and a one-year immutable cache (the id changes with the image). An image is public only while the published version uses it; drafts need a preview token. The admin site also serves this one read-only route.

## Setup
Run `npm run migrate` (db/20261025130000_site_theme.sql, also adds the `designer` role). Set `THEME_PREVIEW_SECRET` (32+ characters) to the same value on the public and admin sites, and `APP_URL` on the admin site. Web fonts (Inter, Roboto and others) load from fonts.googleapis.com only while selected; choose system fonts to avoid any third-party request.

## Limits
Email and SMS still use the environment brand name (`NEXT_PUBLIC_SITE_NAME`). Hiding a navigation link does not block the page. Pages are rendered per request (the layout reads the theme), so they are no longer statically cached.
