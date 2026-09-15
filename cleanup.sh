#!/bin/bash
# RadiusHub - Limpeza de sessoes orfas no accounting.
# Se o NAS nao enviar Accounting-Stop, a sessao fica aberta e o
# Simultaneous-Use passa a bloquear o cliente. Aqui fechamos sessoes
# sem nenhuma atualizacao (interim) ha mais de N dias.
set -euo pipefail

DB="radius"
STALE_DAYS=1        # sessoes sem update por mais de N dias serao encerradas

mariadb "$DB" -e "
UPDATE radacct
   SET acctstoptime = COALESCE(acctupdatetime, acctstarttime),
       acctterminatecause = 'Lost-Carrier'
 WHERE acctstoptime IS NULL
   AND COALESCE(acctupdatetime, acctstarttime) < NOW() - INTERVAL $STALE_DAYS DAY;
"
echo "[$(date '+%F %T')] limpeza de sessoes orfas concluida"
