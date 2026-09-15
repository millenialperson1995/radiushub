#!/bin/bash
# RadiusHub - Monitor de saude com alerta (Telegram opcional).
# Instalado em /usr/local/sbin/radiushub-monitor.sh, agendado via cron (5 min).

# ===== configure o Telegram para receber alertas (opcional) =====
TELEGRAM_TOKEN=""      # ex: 123456:ABC-DEF...
TELEGRAM_CHAT=""       # ex: 123456789
# ===============================================================

LOG="/var/log/radiushub-monitor.log"
STATE="/var/lib/radiushub-monitor.state"
DB="radius"
REJECT_LIMIT=20        # rejeicoes em 10 min que disparam alerta
[ -f "$STATE" ] && LAST="$(cat "$STATE")" || LAST="ok"

fail=0; msg=""

for svc in mariadb freeradius apache2; do
    systemctl is-active --quiet "$svc" || { fail=1; msg+="$svc PARADO; "; }
done
ss -lun 2>/dev/null | grep -q ':1812 ' || { fail=1; msg+="porta 1812 fechada; "; }
ss -lun 2>/dev/null | grep -q ':1813 ' || { fail=1; msg+="porta 1813 fechada; "; }

rej=$(mariadb -N -B "$DB" -e "SELECT COUNT(*) FROM radpostauth WHERE reply='Access-Reject' AND authdate >= NOW() - INTERVAL 10 MINUTE" 2>/dev/null || echo 0)
[ "$rej" -gt "$REJECT_LIMIT" ] && { fail=1; msg+="picos de rejeicao ($rej em 10min); "; }

use=$(df / | awk 'NR==2{print $5}' | tr -d '%')
[ "$use" -gt 90 ] && { fail=1; msg+="disco em ${use}%; "; }

ts="$(date '+%F %T')"
if [ "$fail" -eq 0 ]; then
    [ "$LAST" != "ok" ] && echo "[$ts] RECUPERADO: tudo normal." >> "$LOG"
    [ "$LAST" = "ok" ] && echo "[$ts] OK" >> "$LOG"
    echo "ok" > "$STATE"
else
    echo "[$ts] ALERTA: $msg" >> "$LOG"
    if [ "$LAST" != "fail" ] && [ -n "$TELEGRAM_TOKEN" ] && [ -n "$TELEGRAM_CHAT" ]; then
        curl -s -m 10 "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
            --data-urlencode "chat_id=${TELEGRAM_CHAT}" \
            --data-urlencode "text=RadiusHub ALERTA ($(hostname)): $msg" >/dev/null
    fi
    echo "fail" > "$STATE"
fi

# evita crescimento infinito do log (mantem ~2000 linhas)
if [ "$(wc -l < "$LOG" 2>/dev/null || echo 0)" -gt 2000 ]; then
    tail -n 1000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
