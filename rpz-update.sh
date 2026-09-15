#!/bin/bash
# RadiusHub - Atualiza a lista RPZ Hagezi Pro e recarrega o Unbound.
# Agendado via cron (toda segunda 04:30). O Unbound tambem atualiza
# sozinho pelo timer SOA da zona; este script garante o arquivo em disco.
set -euo pipefail

URL="https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/rpz/pro.txt"
DST="/var/lib/unbound/hagezi-pro.rpz"
LOG="/var/log/radiushub-backup.log"

TMP="$(mktemp)"
curl -sL --max-time 180 -o "$TMP" "$URL"

# sanidade: arquivo nao vazio e com cabecalho SOA
if [ ! -s "$TMP" ] || ! grep -q "SOA" "$TMP"; then
    echo "[$(date '+%F %T')] RPZ INVALIDA, mantendo a anterior" >> "$LOG"
    rm -f "$TMP"
    exit 1
fi

mv "$TMP" "$DST"
chown unbound:unbound "$DST"
chmod 644 "$DST"
systemctl reload unbound
echo "[$(date '+%F %T')] RPZ Hagezi atualizada: $(wc -l < "$DST") linhas" >> "$LOG"
