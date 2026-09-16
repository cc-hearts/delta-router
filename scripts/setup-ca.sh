#!/usr/bin/env bash
# Generates the local CA and one leaf certificate covering every intercepted host.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
CERTS="$DIR/certs"
mkdir -p "$CERTS"

SANS="$(node -e '
const cfg = require("path").join(process.argv[1], "config.json");
const j = JSON.parse(require("fs").readFileSync(cfg, "utf8"));
process.stdout.write(j.intercept.map((h) => "DNS:" + h).join(","));
' "$DIR")"
echo "SANs: $SANS"

if [[ "${1:-}" == "--force" || ! -f "$CERTS/ca.pem" || ! -f "$CERTS/ca.key" ]]; then
  openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout "$CERTS/ca.key" -out "$CERTS/ca.pem" \
    -subj "/CN=delta-router local CA/O=delta-router" >/dev/null 2>&1
  echo "created CA (remember: node src/cli.js trust-ca)"
else
  echo "reusing existing CA $CERTS/ca.pem"
fi

openssl req -newkey rsa:2048 -nodes -sha256 \
  -keyout "$CERTS/server.key" -out "$CERTS/server.csr" \
  -subj "/CN=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).intercept[0])' "$DIR/config.json")" >/dev/null 2>&1

printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n' "$SANS" > "$CERTS/server.ext"

openssl x509 -req -in "$CERTS/server.csr" -CA "$CERTS/ca.pem" -CAkey "$CERTS/ca.key" \
  -CAcreateserial -out "$CERTS/server.crt" -days 825 -sha256 -extfile "$CERTS/server.ext" >/dev/null 2>&1

rm -f "$CERTS/server.csr" "$CERTS/server.ext" "$CERTS/ca.srl"
chmod 600 "$CERTS/ca.key" "$CERTS/server.key"
echo "wrote $CERTS/{ca.pem,ca.key,server.crt,server.key}"
