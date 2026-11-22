# ClamAV server for production uploads

Vercel cannot run ClamAV, so uploads (photos, documents, ID images) are scanned by a small VPS. Nothing here is deployed until John does the steps below.

**How it is locked down:** clamd has no password, so it is never exposed. Only a TLS front door (stunnel, port 3443) is public, and it accepts only clients holding a certificate signed by our private CA (mutual TLS). The app holds that certificate; nobody else can scan or probe clamd. Vercel's IP addresses change, so an IP allow-list is not used. Signatures update on their own (freshclam runs inside the container).

## What John does (about 30 minutes, about A$8-12 a month)
1. **Buy a VPS**: Ubuntu 24.04 (or 22.04), **2 GB RAM minimum**, Sydney region if available (Vultr, DigitalOcean, Linode or Hetzner all work). Note its public IP. Optional: point a name like `scan.yourdomain.com.au` at it.
2. **Copy this folder** to the server and run setup (replace with your IP or name):
   `scp -r deploy/clamav root@SERVER:/opt/clamav` then `ssh root@SERVER` then `cd /opt/clamav && bash setup.sh SERVER_IP_OR_NAME`
   The first start downloads the signature database (about 5 minutes). Re-running is safe; certificates are kept.
3. **Read the three secret values** on the server: `cat /opt/clamav/client/CLAMD_TLS_CA_B64` (and `..._CERT_B64`, `..._KEY_B64`).
4. **Add Vercel env vars** to BOTH Vercel projects (public and admin), Production only, marked sensitive:
   | Variable | Value |
   |---|---|
   | `CLAMD_HOST` | the same IP or name you gave setup.sh (must match the certificate) |
   | `CLAMD_PORT` | `3443` |
   | `CLAMD_TLS_CA_B64`, `CLAMD_TLS_CERT_B64`, `CLAMD_TLS_KEY_B64` | the three values from step 3 |
   Uploads also need `STORAGE_DRIVER=s3` and the `S3_*` settings (see GO_LIVE_CHECKLIST.md). Never paste the values into chat or commit them. Redeploy after saving.
5. **Check it** from your PC with the same values in your shell: `npm run check:clamd` (or `npm run smoke:prod`, which runs it when `CLAMD_HOST` is set). All three lines must say PASS.

## Behaviour to know
- The app fails closed: if the VPS is down or unreachable, uploads answer 503; nothing unscanned is stored.
- In production the app refuses plain TCP to any non-local host and a partial set of TLS values, so a misconfiguration cannot silently disable scanning.
- Files over 25 MB are refused (clamd StreamMaxLength). Vercel's own request limit (about 4.5 MB) applies first.
- Certificates: server and client expire after 825 days (CA after 10 years). To rotate, delete `certs/` and `client/` on the server, re-run `setup.sh`, and update the three Vercel values.
- Updates: `docker compose pull && docker compose up -d --build` in `/opt/clamav` now and then; Ubuntu security updates are automatic. Logs: `docker compose logs --tail 100`.
- Backup: nothing to back up (no customer data is stored on the VPS; files are scanned in memory).
- Firewall: only SSH (22) and 3443 are open. Consider restricting SSH to your own IP at the VPS provider.
