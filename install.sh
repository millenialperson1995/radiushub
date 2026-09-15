#!/bin/bash
# =====================================================================
# RadiusHub - Instalador do servidor FreeRADIUS + MariaDB + Painel web
# Ubuntu Server 22.04/24.04. Rode como root:  sudo bash install.sh
# EDITE AS VARIAVEIS ABAIXO ANTES DE RODAR.
# =====================================================================
set -euo pipefail

# ============================ CONFIGURE AQUI =========================
RADIUS_IFACE="ens34"                 # interface da rede dedicada RADIUS
RADIUS_IP="10.10.10.2/30"            # IP deste servidor na rede RADIUS
DB_NAME="radius"
DB_USER="radius"
DB_PASS="TROQUE_A_SENHA_MYSQL"       # <-- TROCAR (evite / e & )
RADIUS_SECRET="TROQUE_O_SECRET"      # <-- TROCAR (igual ao /radius do MikroTik)
NAS_IP="10.10.10.1"                  # IP do MikroTik RouterOS na rede RADIUS
SNMP_COMM="public"                   # community SNMP (igual a do RouterOS)
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"   # pasta com index.html api.js api.php
# =====================================================================

[ "$EUID" -eq 0 ] || { echo "ERRO: rode como root (sudo bash install.sh)"; exit 1; }
[ -f "$SRC_DIR/index.html" ] || { echo "ERRO: index.html nao encontrado em $SRC_DIR"; exit 1; }

echo "### 1/8 Pacotes"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq mariadb-server freeradius freeradius-mysql freeradius-utils \
  apache2 php libapache2-mod-php php-mysql snmp curl unzip >/dev/null
systemctl enable --now mariadb freeradius apache2 >/dev/null

echo "### 2/8 Rede dedicada ($RADIUS_IFACE = $RADIUS_IP)"
if ! grep -q "$RADIUS_IP" /etc/netplan/*.yaml 2>/dev/null; then
  cat > /etc/netplan/60-radius.yaml <<EOF
network:
  version: 2
  ethernets:
    $RADIUS_IFACE:
      addresses:
        - $RADIUS_IP
      optional: true
EOF
  chmod 600 /etc/netplan/60-radius.yaml
  netplan generate && netplan apply
fi

echo "### 3/8 Banco de dados"
mariadb -e "CREATE DATABASE IF NOT EXISTS $DB_NAME CHARACTER SET utf8mb4;"
mariadb -e "CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';"
mariadb -e "GRANT ALL PRIVILEGES ON $DB_NAME.* TO '$DB_USER'@'localhost'; FLUSH PRIVILEGES;"
RADD="$(ls -d /etc/freeradius/*/ | head -1)"
if ! mariadb "$DB_NAME" -e "SHOW TABLES;" | grep -q radcheck; then
  mariadb "$DB_NAME" < "$RADD/mods-config/sql/main/mysql/schema.sql"
fi

echo "### 4/8 FreeRADIUS -> MySQL"
SQLF="$RADD/mods-available/sql"
cp -n "$SQLF" "$SQLF.bak" 2>/dev/null || true
python3 - "$SQLF" "$DB_PASS" <<'PYEOF'
import re, sys
p, pw = sys.argv[1], sys.argv[2]
s = open(p).read()
s = s.replace('dialect = "sqlite"', 'dialect = "mysql"')
s = s.replace('driver = "rlm_sql_null"', 'driver = "rlm_sql_mysql"')
s = re.sub(r'#\s*server = "localhost"', 'server = "localhost"', s)
s = re.sub(r'#\s*port = 3306', 'port = 3306', s)
s = re.sub(r'#\s*login = "radius"', 'login = "radius"', s)
s = re.sub(r'#\s*password = "radpass"', 'password = "%s"' % pw, s)
s = s.replace('#\tread_clients = yes', '\tread_clients = yes')
# desativa TLS do bloco mysql (conexao local)
s = s.replace('\t\t\tca_file = "/etc/ssl/certs/my_ca.crt"', '#\t\t\tca_file = "/etc/ssl/certs/my_ca.crt"')
s = s.replace('\t\t\ttls_required = yes', '#\t\t\ttls_required = yes')
open(p, 'w').write(s)
PYEOF
ln -sf ../mods-available/sql "$RADD/mods-enabled/sql"

# habilita a checagem de Simultaneous-Use (fiscaliza 1 sessao por login)
python3 - "$RADD/sites-enabled/default" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
old = 'session {\n#\tradutmp\n\n\t#\n\t#  See "Simultaneous Use Checking Queries" in mods-available/sql\n#\tsql\n}'
new = 'session {\n#\tradutmp\n\n\t#\n\t#  See "Simultaneous Use Checking Queries" in mods-available/sql\n\tsql\n}'
if old in s:
    open(p, 'w').write(s.replace(old, new))
    print("Simultaneous-Use: checagem ativada")
else:
    print("AVISO: bloco session nao encontrado (confira sites-enabled/default)")
PYEOF


echo "### 5/8 NAS MikroTik (clients.conf) + log de auditoria"
if ! grep -q "client mikrotik_routeros" "$RADD/clients.conf"; then
  cat >> "$RADD/clients.conf" <<EOF

client mikrotik_routeros {
	ipaddr = $NAS_IP
	secret = $RADIUS_SECRET
	require_message_authenticator = yes
	nas_type = other
}
EOF
fi
sed -i 's/^\tauth = no/\tauth = yes/; s/^\tauth_badpass = no/\tauth_badpass = yes/; s/^\tauth_goodpass = no/\tauth_goodpass = yes/' "$RADD/radiusd.conf"
freeradius -CX > /dev/null
systemctl restart freeradius

echo "### 6/8 Painel web"
mkdir -p /var/www/radiushub
cp "$SRC_DIR/index.html" "$SRC_DIR/api.js" "$SRC_DIR/api.php" /var/www/radiushub/
sed -i "s/__DB_PASS__/$DB_PASS/; s/__DB_USER__/$DB_USER/; s/__DB_NAME__/$DB_NAME/; s/__SNMP_COMM__/$SNMP_COMM/" /var/www/radiushub/api.php
grep -q "__DB_PASS__" /var/www/radiushub/api.php && { echo "ERRO: placeholder nao substituido no api.php"; exit 1; }
chown -R www-data:www-data /var/www/radiushub
cat > /etc/apache2/sites-available/radiushub.conf <<'VHOST'
<VirtualHost *:80>
    RewriteEngine On
    RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]
</VirtualHost>
<VirtualHost *:443>
    DocumentRoot /var/www/radiushub
    SSLEngine on
    SSLCertificateFile /etc/ssl/certs/radiushub.crt
    SSLCertificateKeyFile /etc/ssl/private/radiushub.key
    <Directory /var/www/radiushub>
        Options -Indexes +FollowSymLinks
        AllowOverride None
        Require all granted
    </Directory>
</VirtualHost>
VHOST
a2enmod ssl rewrite >/dev/null
[ -f /etc/ssl/certs/radiushub.crt ] || openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
    -keyout /etc/ssl/private/radiushub.key -out /etc/ssl/certs/radiushub.crt \
    -subj "/C=BR/O=RadiusHub/CN=radiushub" >/dev/null 2>&1
chmod 600 /etc/ssl/private/radiushub.key
a2dissite 000-default >/dev/null 2>&1 || true
a2ensite radiushub >/dev/null
echo "www-data ALL=(ALL) NOPASSWD: /usr/bin/systemctl reload freeradius, /usr/bin/systemctl restart freeradius" > /etc/sudoers.d/radiushub
chmod 440 /etc/sudoers.d/radiushub
visudo -c >/dev/null
usermod -aG freerad www-data
systemctl restart apache2

echo "### 6b/8 Backup automatico + monitoramento + limpeza"
install -m 750 "$SRC_DIR/backup.sh" /usr/local/sbin/radiushub-backup.sh
install -m 750 "$SRC_DIR/monitor.sh" /usr/local/sbin/radiushub-monitor.sh
install -m 750 "$SRC_DIR/cleanup.sh" /usr/local/sbin/radiushub-cleanup.sh
echo "0 3 * * * root /usr/local/sbin/radiushub-backup.sh >> /var/log/radiushub-backup.log 2>&1" > /etc/cron.d/radiushub-backup
echo "*/5 * * * * root /usr/local/sbin/radiushub-monitor.sh" > /etc/cron.d/radiushub-monitor
echo "0 4 * * * root /usr/local/sbin/radiushub-cleanup.sh >> /var/log/radiushub-backup.log 2>&1" > /etc/cron.d/radiushub-cleanup
chmod 644 /etc/cron.d/radiushub-backup /etc/cron.d/radiushub-monitor /etc/cron.d/radiushub-cleanup
/usr/local/sbin/radiushub-backup.sh >/dev/null
/usr/local/sbin/radiushub-cleanup.sh >/dev/null
/usr/local/sbin/radiushub-monitor.sh

echo "### 7/8 Verificacao"
systemctl is-active --quiet freeradius mariadb apache2 || { echo "ERRO: servico parado"; exit 1; }
ss -lun | grep -q ':1812 ' || { echo "ERRO: porta 1812 fechada"; exit 1; }
[ "$(curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1/)" = "200" ] || { echo "ERRO: painel nao respondeu em HTTPS"; exit 1; }
curl -sk "https://127.0.0.1/api.php?action=status" | grep -q '"ok":true' || { echo "ERRO: api.php"; exit 1; }
ls /var/backups/radiushub/*.sql.gz >/dev/null 2>&1 || { echo "ERRO: backup nao gerado"; exit 1; }

echo "### 8/8 OK!"
echo "Painel: https://$(hostname -I | awk '{print $1}')/  (sem login)"
echo "Backups em /var/backups/radiushub (diario 03:00, retencao 30 dias)"
echo "Monitor em /var/log/radiushub-monitor.log (5/5 min)"
echo "Proximos passos no MikroTik: ver README.md secao 5.6"
