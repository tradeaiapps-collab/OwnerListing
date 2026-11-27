#!/usr/bin/env bash
# Creates the Android upload keystore and prints the four GitHub secrets to set. Run once, on your own machine (needs JDK keytool).
# The keystore and passwords are NEVER committed. Back the .jks file up somewhere safe: losing it means a new Play upload key request.
set -euo pipefail
OUT="${1:-ownerlisting-upload.jks}"
ALIAS="ownerlisting"
[ -e "$OUT" ] && { echo "$OUT already exists, refusing to overwrite"; exit 1; }
PASS="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)"
keytool -genkeypair -v -keystore "$OUT" -alias "$ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$PASS" -keypass "$PASS" -dname "CN=OwnerListing, O=OwnerListing, C=AU"
echo
echo "Set these in GitHub > repo Settings > Secrets and variables > Actions:"
echo "  ANDROID_KEYSTORE_BASE64   = (contents of $OUT.base64.txt)"
echo "  ANDROID_KEYSTORE_PASSWORD = $PASS"
echo "  ANDROID_KEY_ALIAS         = $ALIAS"
echo "  ANDROID_KEY_PASSWORD      = $PASS"
base64 -w0 "$OUT" 2>/dev/null > "$OUT.base64.txt" || base64 "$OUT" | tr -d '\n' > "$OUT.base64.txt"
echo "Delete $OUT.base64.txt after pasting it into GitHub. Keep $OUT backed up."
