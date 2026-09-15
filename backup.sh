#!/bin/bash
# RadiusHub - Backup diario (MySQL + FreeRADIUS + painel)
# Instalado em /usr/local/sbin/radiushub-backup.sh, agendado via cron.
set -euo pipefail

DEST="/var/backups/radiushub"
KEEP_DAYS=30
DB="radius"
STAMP="$(date +%F_%H%M%S)"
mkdir -p "$DEST"

# 1) banco de dados
mariadb-dump --single-transaction --quick --routines "$DB" | gzip > "$DEST/radius-$STAMP.sql.gz"

# 2) configuracao do FreeRADIUS (inclui clients.conf, mods, sites)
RADD="$(ls -d /etc/freeradius/*/ | head -1)"
tar czf "$DEST/freeradius-$STAMP.tar.gz" -C "$(dirname "$RADD")" "$(basename "$RADD")"

# 3) painel web
tar czf "$DEST/radiushub-$STAMP.tar.gz" -C /var/www radiushub

# 4) retencao
find "$DEST" -type f -mtime +"$KEEP_DAYS" -delete

echo "[$(date '+%F %T')] backup OK -> $DEST (radius-$STAMP.sql.gz)"
