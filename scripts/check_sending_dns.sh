#!/usr/bin/env bash
# M2.1 — Check SPF / DKIM / DMARC alignment for the PokeMart sending domain.
# Andy sets DNS; this script only verifies. Exit 0 when all three look present.
set -euo pipefail

DOMAIN="${1:-mail.pokemart.online}"
APEX="${2:-pokemart.online}"
SELECTOR="${DKIM_SELECTOR:-resend}"

echo "== SPF ($DOMAIN / $APEX) =="
spf_ok=0
for host in "$DOMAIN" "$APEX"; do
  txt="$(dig +short TXT "$host" 2>/dev/null | tr -d '"' || true)"
  echo "$host TXT: ${txt:-<none>}"
  if echo "$txt" | grep -qi 'v=spf1'; then
    spf_ok=1
  fi
done
if [[ "$spf_ok" -ne 1 ]]; then
  echo "FAIL: no SPF TXT found on $DOMAIN or $APEX"
  exit 1
fi
echo "ok:spf"

echo "== DKIM selector=$SELECTOR._domainkey.$DOMAIN =="
dkim="$(dig +short TXT "${SELECTOR}._domainkey.${DOMAIN}" 2>/dev/null | tr -d '"' || true)"
echo "${SELECTOR}._domainkey.${DOMAIN}: ${dkim:-<none>}"
if ! echo "$dkim" | grep -qi 'v=DKIM1'; then
  echo "FAIL: no DKIM TXT for selector '$SELECTOR' (set DKIM_SELECTOR=… if Postmark/Resend uses another)"
  exit 1
fi
echo "ok:dkim"

echo "== DMARC (_dmarc.$APEX) =="
dmarc="$(dig +short TXT "_dmarc.${APEX}" 2>/dev/null | tr -d '"' || true)"
echo "_dmarc.${APEX}: ${dmarc:-<none>}"
if ! echo "$dmarc" | grep -qi 'v=DMARC1'; then
  echo "FAIL: no DMARC TXT on _dmarc.$APEX"
  exit 1
fi
echo "ok:dmarc"

echo "PASS: SPF + DKIM + DMARC records present for $DOMAIN / $APEX"
exit 0
