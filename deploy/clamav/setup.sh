#!/usr/bin/env bash
# One-time setup of the OwnerListing ClamAV server. Run as root on a fresh Ubuntu 22.04/24.04 VPS (2 GB RAM minimum):
#   sudo bash setup.sh <public-hostname-or-ip>
# Safe to run again: existing certificates are kept, so the app's settings stay valid.
set -euo pipefail
HOST="${1:-}"
[ -n "$HOST" ] || { echo "Usage: sudo bash setup.sh <public-hostname-or-ip of this server>" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)." >&2; exit 2; }
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "== 1/5 packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y docker.io docker-compose-v2 ufw openssl unattended-upgrades
systemctl enable --now docker

echo "== 2/5 firewall (SSH and the TLS port only; clamd 3310 is never opened)"
ufw allow OpenSSH
ufw allow 3443/tcp
ufw --force enable

echo "== 3/5 certificates (private CA, server cert for $HOST, one client cert for the app)"
mkdir -p certs client && chmod 755 certs && chmod 700 client
if [ ! -f certs/ca.crt ]; then
  if [[ "$HOST" =~ ^[0-9.]+$ ]]; then SAN="IP:$HOST"; else SAN="DNS:$HOST"; fi
  openssl req -x509 -newkey rsa:4096 -nodes -keyout certs/ca.key -out certs/ca.crt -days 3650 -subj "/CN=OwnerListing ClamAV CA" 2>/dev/null
  openssl req -newkey rsa:3072 -nodes -keyout certs/server.key -out certs/server.csr -subj "/CN=$HOST" 2>/dev/null
  printf "subjectAltName=%s\nextendedKeyUsage=serverAuth\n" "$SAN" > certs/server.ext
  openssl x509 -req -in certs/server.csr -CA certs/ca.crt -CAkey certs/ca.key -CAcreateserial -out certs/server.crt -days 825 -extfile certs/server.ext 2>/dev/null
  openssl req -newkey rsa:3072 -nodes -keyout client/client.key -out client/client.csr -subj "/CN=ownerlisting-app" 2>/dev/null
  printf "extendedKeyUsage=clientAuth\n" > client/client.ext
  openssl x509 -req -in client/client.csr -CA certs/ca.crt -CAkey certs/ca.key -CAcreateserial -out client/client.crt -days 825 -extfile client/client.ext 2>/dev/null
  rm -f certs/*.csr client/*.csr certs/*.ext client/*.ext
  # Values to paste into Vercel (base64 so they fit on one line)
  base64 -w0 certs/ca.crt        > client/CLAMD_TLS_CA_B64
  base64 -w0 client/client.crt   > client/CLAMD_TLS_CERT_B64
  base64 -w0 client/client.key   > client/CLAMD_TLS_KEY_B64
  chmod 600 certs/* client/*
  chmod 644 certs/ca.crt certs/server.crt certs/server.key   # stunnel runs as a non-root user inside its container
else
  echo "certificates already exist, keeping them"
fi

echo "== 4/5 start ClamAV (first start downloads the signature database, allow ~5 minutes)"
docker compose up -d --build

echo "== 5/5 wait for healthy"
for i in $(seq 1 60); do
  s="$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q clamav)" 2>/dev/null || true)"
  [ "$s" = healthy ] && break
  sleep 10
done
docker compose ps
echo
echo "Done. Add these Vercel env vars (both projects), values are in $DIR/client/ :"
echo "  CLAMD_HOST=$HOST   CLAMD_PORT=3443"
echo "  CLAMD_TLS_CA_B64, CLAMD_TLS_CERT_B64, CLAMD_TLS_KEY_B64  (print each with: cat $DIR/client/<name>)"
echo "Never paste these into chat or commit them. Then run: npm run smoke:prod with CLAMD_* set."
