#!/usr/bin/env bash
# Creates a private certificate authority and a server certificate for the gateway.
# Install certs/pch-ca.crt on each iPad/laptop (see docs/INSTALL.md), then set
# PCH_TLS_CERT=./certs/pch.crt and PCH_TLS_KEY=./certs/pch.key.
#
#   scripts/gen-cert.sh 192.168.10.5 [hostname.local ...]
set -euo pipefail
if [ $# -lt 1 ]; then
  echo "Usage: $0 <gateway-ip-or-hostname> [more names...]" >&2
  exit 1
fi
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }
DIR="$(cd "$(dirname "$0")/.." && pwd)/certs"
mkdir -p "$DIR"
cd "$DIR"

if [ ! -f pch-ca.key ]; then
  openssl genrsa -out pch-ca.key 3072
  openssl req -x509 -new -key pch-ca.key -sha256 -days 1825 -subj "/CN=Production Control Hub Local CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -out pch-ca.crt
  echo "Created local CA: $DIR/pch-ca.crt"
fi

SAN=""
for n in "$@" localhost 127.0.0.1; do
  if [[ "$n" =~ ^[0-9.]+$ || "$n" == *:* ]]; then SAN="${SAN:+$SAN,}IP:$n"; else SAN="${SAN:+$SAN,}DNS:$n"; fi
done

openssl genrsa -out pch.key 2048
openssl req -new -key pch.key -subj "/CN=$1" -out pch.csr
# iOS requires: serverAuth EKU, SAN, and validity <= 825 days.
cat > pch.ext <<EXT
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$SAN
EXT
openssl x509 -req -in pch.csr -CA pch-ca.crt -CAkey pch-ca.key -CAcreateserial -out pch.crt -days 800 -sha256 -extfile pch.ext
rm -f pch.csr pch.ext
chmod 600 pch.key pch-ca.key
echo "Server certificate: $DIR/pch.crt  (names: $SAN)"
echo "Install $DIR/pch-ca.crt on client devices. Keep pch-ca.key private."
