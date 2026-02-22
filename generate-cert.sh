#!/bin/bash
# Generate self-signed SSL certificates for local HTTPS development.
# Usage: ./generate-cert.sh

CERT_DIR="./certs"
mkdir -p "$CERT_DIR"

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$CERT_DIR/key.pem" \
  -out "$CERT_DIR/cert.pem" \
  -days 365 \
  -subj "/CN=localhost/O=WatchParty/C=US"

echo "Self-signed certificates generated in $CERT_DIR/"
echo "  cert: $CERT_DIR/cert.pem"
echo "  key:  $CERT_DIR/key.pem"
echo ""
echo "Set USE_HTTPS=true in .env to enable HTTPS."
