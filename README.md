# RadiusHub — Painel FreeRADIUS + PPPoE (MikroTik)

Painel web para gerenciar um servidor **FreeRADIUS + MariaDB** que autentica
clientes **PPPoE de um MikroTik RouterOS**, com controle de banda por usuário/plano,
accounting, logs e gráfico de tráfego em tempo real (SNMP).

Testado em: **Ubuntu Server 24.04** + **FreeRADIUS 3.2** + **MariaDB 10.11** +
**RouterOS 7.x** + **PHP 8.3**.

---

## 1. Arquitetura

```
  Cliente PPPoE ──(ether2/3/4)──> MikroTik RouterOS ──(ether5, rede dedicada)──> Ubuntu FreeRADIUS
  login/senha         bridge-lan      10.10.10.1/30  <── RADIUS UDP 1812/1813 ──>  10.10.10.2/30
                                          │                                           │
                                          │ consulta                                  │ MariaDB `radius`
                                          │            Administrador ──HTTP──> Apache + RadiusHub
                                          │              (rede gerência 192.168.100.x)
```

- Autenticação/autorização/accounting: FreeRADIUS consultando o MySQL (`rlm_sql_mysql`).
- Limite de banda: atributo `Mikrotik-Rate-Limit` por usuário (`radreply`) ou por
  plano (`radgroupreply` + `radusergroup`). O RADIUS **sobrepõe** o profile PPPoE.
- Tráfego ao vivo: o painel lê contadores das interfaces `<pppoe-*>` via **SNMP** no RouterOS.

## 2. Funcionalidades do painel

| Tela | O que faz (tudo real, sem mock) |
|---|---|
| Dashboard | usuários, sessões online, taxa accept/reject 24h, gráfico hora a hora, tráfego por NAS, últimos eventos, **tráfego em tempo real** e **online agora** |
| Usuários | criar, **editar**, excluir (com confirmação), bloquear/desbloquear (bloquear **derruba sessões ativas via PoD**); Simultaneous-Use |
| Perfis & Grupos | planos de velocidade (`Mikrotik-Rate-Limit` + `Session-Timeout`) e vínculo usuário↔plano |
| Clientes NAS | MikroTik lido do `clients.conf`; novos NAS vão para a tabela `nas` (exige restart) |
| Sessões | online/histórico do `radacct` (tempo, up/down, MAC, IP), filtro e PoD |
| radtest | executa teste real contra o servidor |
| Logs | `radius.log` ao vivo |
| SQL | gera INSERTs reais do que está no banco |

## 3. Requisitos

- Ubuntu Server 22.04/24.04 (root/sudo).
- MikroTik RouterOS (CHR virtual ou equipamento físico) com uma porta livre para a rede do RADIUS.
- Acesso internet no servidor (pacotes + CDNs do painel no navegador).

## 4. Instalação rápida

```bash
git clone <seu-repo> radiushub && cd radiushub
# edite as variáveis no topo do install.sh (senhas, secret, IP do NAS)
sudo bash install.sh
```

O script instala pacotes, cria o banco, importa o schema, configura o
FreeRADIUS (SQL, NAS, logs), publica o painel (HTTPS, sem login) e valida tudo.

## 5. Instalação manual (passo a passo)

### 5.1 Rede dedicada RADIUS (persiste após reboot)

`/etc/netplan/60-radius.yaml` (ajuste `ens34` p/ sua interface):

```yaml
network:
  version: 2
  ethernets:
    ens34:
      addresses: [10.10.10.2/30]
      optional: true
```

```bash
sudo netplan generate && sudo netplan apply
ip -br a show ens34   # deve ter 10.10.10.2/30
```

> Não coloque default route por essa interface (derruba SSH/internet).

### 5.2 Pacotes

```bash
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update
sudo apt-get install -y mariadb-server freeradius freeradius-mysql freeradius-utils \
  apache2 php libapache2-mod-php php-mysql snmp curl unzip
sudo systemctl enable --now mariadb freeradius apache2
```

### 5.3 Banco de dados

```bash
sudo mariadb -e "CREATE DATABASE radius CHARACTER SET utf8mb4;"
sudo mariadb -e "CREATE USER 'radius'@'localhost' IDENTIFIED BY 'TROQUE_AQUI';"
sudo mariadb -e "GRANT ALL PRIVILEGES ON radius.* TO 'radius'@'localhost'; FLUSH PRIVILEGES;"
sudo mariadb radius < /etc/freeradius/3.0/mods-config/sql/main/mysql/schema.sql
```

### 5.4 FreeRADIUS → MySQL (`/etc/freeradius/3.0/mods-available/sql`)

```ini
dialect = "mysql"
driver = "rlm_sql_mysql"
server = "localhost"
port = 3306
login = "radius"
password = "TROQUE_AQUI"     # mesma do passo 5.3
radius_db = "radius"
read_clients = yes            # NAS via tabela `nas` (lidos no start)
```

- Desative o bloco TLS do MySQL nesse arquivo (conexão local não usa TLS).
- Ative o módulo: `sudo ln -sf ../mods-available/sql /etc/freeradius/3.0/mods-enabled/sql`
- O `sql` já vem referenciado nos sites `default`/`inner-tunnel` (`-sql`).
- Auditoria em `/etc/freeradius/3.0/radiusd.conf`, seção `log`:
  `auth = yes`, `auth_badpass = yes`, `auth_goodpass = yes`.

### 5.5 NAS MikroTik (`/etc/freeradius/3.0/clients.conf`)

```ini
client mikrotik_routeros {
    ipaddr = 10.10.10.1
    secret = TROQUE_AQUI
    require_message_authenticator = yes
    nas_type = other
}
```

```bash
sudo freeradius -CX   # deve terminar com "Configuration appears to be OK"
sudo systemctl restart freeradius
radtest usuario senha 127.0.0.1 0 testing123   # teste local
```

### 5.6 MikroTik RouterOS

```routeros
/ip address add address=10.10.10.1/30 interface=ether5
/radius add service=ppp address=10.10.10.2 secret=TROQUE_AQUI timeout=3s
/ppp aaa set use-radius=yes accounting=yes
/snmp set enabled=yes          # para o gráfico de tráfego ao vivo
/ping 10.10.10.2
/radius monitor 0
```

PPPoE Server (exemplo):

```routeros
/interface bridge add name=bridge-clientes
/interface bridge port add bridge=bridge-clientes interface=ether2
/interface bridge port add bridge=bridge-clientes interface=ether3
/ip pool add name=pool-pppoe ranges=172.16.0.2-172.16.0.254
/ppp profile add name=Plano-Base local-address=172.16.0.1 remote-address=pool-pppoe \
  dns-server=8.8.8.8,1.1.1.1 use-encryption=no
/interface pppoe-server server add service-name=Servidor-PPPoE \
  interface=bridge-clientes default-profile=Plano-Base \
  authentication=pap,chap,mschap1,mschap2 disabled=no
/ip firewall nat add chain=srcnat action=masquerade out-interface=ether1
```

> O profile entrega IP/DNS (base). A **velocidade vem do RADIUS** e sobrepõe o profile.
> O RADIUS só é consultado se **não existir usuário local** com o mesmo nome.

### 5.7 Painel web

```bash
sudo mkdir -p /var/www/radiushub
sudo cp index.html api.js api.php /var/www/radiushub/
sudo chown -R www-data:www-data /var/www/radiushub
# ajuste DB_USER/DB_PASS/SNMP_COMM no topo do api.php
```

`/etc/apache2/sites-available/radiushub.conf` (sem login; veja seção 12):

```apache
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
```

```bash
sudo a2dissite 000-default && sudo a2ensite radiushub
# permite reload/restart do FreeRADIUS pelo painel:
echo "www-data ALL=(ALL) NOPASSWD: /usr/bin/systemctl reload freeradius, /usr/bin/systemctl restart freeradius" | sudo tee /etc/sudoers.d/radiushub
sudo chmod 440 /etc/sudoers.d/radiushub && sudo visudo -c
sudo usermod -aG freerad www-data   # lê clients.conf (lista NAS / PoD)
sudo systemctl restart apache2 freeradius
```

Acesse: `http://IP-DO-SERVIDOR/` (rede de gerência).

## 6. CRUD de usuários (SQL direto, sem painel)

```sql
-- criar
INSERT INTO radcheck (username,attribute,op,value) VALUES ('joao','Cleartext-Password',':=','senha');
-- limite 20 Mbps download (rx=upload, tx=download, do ponto de vista do roteador)
INSERT INTO radreply (username,attribute,op,value) VALUES ('joao','Mikrotik-Rate-Limit',':=','5M/20M');
-- listar / atualizar / apagar
SELECT username,attribute,value FROM radcheck;
UPDATE radreply SET value='50M' WHERE username='joao' AND attribute='Mikrotik-Rate-Limit';
DELETE FROM radreply WHERE username='joao'; DELETE FROM radcheck WHERE username='joao';
```

QoS completo (taxa, burst, prioridade 1–8, mínimo garantido):

```
'20M/20M 40M/40M 15M/15M 10/10 5 4M/4M'
```

Outros `radreply`: `Session-Timeout` (ex `86400`), `Idle-Timeout` (ex `600`),
`Framed-Pool`, `Filter-Id`, `Framed-IP-Address`.

## 7. API interna (`api.php?action=...`)

`status, users, user_save, user_delete, groups, group_save, group_delete,
accounting, events, stats, logs, radtest, reload, restart, nas_list,
nas_save, nas_delete, pod, snmp_traffic` — JSON, servido em HTTPS (sem login).

## 8. Simultaneous-Use (1 login por usuário)

Impede que o mesmo login conecte em dois locais ao mesmo tempo. A checagem fica
no `session` do site `default` (já habilitada pelo install.sh) e o atributo fica
em **radcheck** (item de checagem), com valor `1`:

```sql
INSERT INTO radcheck (username,attribute,op,value) VALUES ('joao','Simultaneous-Use',':=','1');
```

No painel, criar/editar usuário com o campo *Simultaneous-Use* já grava assim.
O log registra `Multiple logins (max 1)` quando bloqueia.

## 9. Backup e restauração

- Script: `/usr/local/sbin/radiushub-backup.sh` (diário às 03:00, retenção 30 dias).
- Destino: `/var/backups/radiushub/` — dump do MySQL + `tar.gz` do FreeRADIUS e do painel.
- Log: `/var/log/radiushub-backup.log`.

Restaurar:

```bash
# banco
gunzip < /var/backups/radiushub/radius-AAAA-MM-DD_hhmmss.sql.gz | sudo mariadb radius
# config do FreeRADIUS
sudo tar xzf /var/backups/radiushub/freeradius-AAAA....tar.gz -C /etc/freeradius
sudo systemctl restart freeradius
# painel
sudo tar xzf /var/backups/radiushub/radiushub-AAAA....tar.gz -C /var/www
```

> Guarde uma cópia fora do servidor (rsync/scp para outra máquina ou nuvem).

## 10. HTTPS

O install.sh gera um certificado self-signed e serve o painel em HTTPS,
redirecionando o HTTP. O navegador mostrará aviso de certificado (normal em
self-signed); para eliminar, use um certificado Let's Encrypt (precisa de
domínio apontando para o servidor).

```bash
sudo a2enmod ssl rewrite
sudo systemctl restart apache2
# testar
curl -k https://SEU-IP/api.php?action=status
```

## 11. Monitoramento e alertas

- Script: `/usr/local/sbin/radiushub-monitor.sh` (cron a cada 5 min).
- Verifica: serviços (mariadb, freeradius, apache2), portas 1812/1813,
  picos de rejeição (força bruta) e uso de disco.
- Log: `/var/log/radiushub-monitor.log`.
- Alerta no **Telegram**: preencha `TELEGRAM_TOKEN` e `TELEGRAM_CHAT` no topo
  do script. Alerta na transição para falha e aviso de recuperação.

### Sessões órfãs (limpeza automática)

Se o RouterOS não enviar o *Accounting-Stop* (queda de link, reboot), a sessão
fica aberta no `radacct` e o **Simultaneous-Use passa a bloquear o cliente**.
O script `/usr/local/sbin/radiushub-cleanup.sh` (cron diário 04:00) encerra
sessões sem atualização há mais de 1 dia:

```sql
UPDATE radacct SET acctstoptime=COALESCE(acctupdatetime,acctstarttime),
       acctterminatecause='Lost-Carrier'
 WHERE acctstoptime IS NULL
   AND COALESCE(acctupdatetime,acctstarttime) < NOW() - INTERVAL 1 DAY;
```

Para desbloquear na hora, use o botão **PoD Disconnect** no painel ou force o
fechamento:

```sql
UPDATE radacct SET acctstoptime=NOW(), acctterminatecause='Admin-Reset'
 WHERE username='LOGIN' AND acctstoptime IS NULL;
```

## 12. Segurança

- Troque **todas** as senhas padrão (MySQL e secret RADIUS).
- O painel **não tem login** (decisão do operador). Como ele permite ver dados e
  desconectar clientes, restrinja o acesso por firewall/IP à rede de gerência.
  Alternativa sem senha: no `<Directory>`, use `Require ip 192.168.100.0/24`.
- `radpostauth` grava a senha tentada — restrinja acesso ao banco.
- Backup: `mariadb-dump radius | gzip > radius-$(date +%F).sql.gz`
  + `/etc/freeradius/3.0/` + `/var/www/radiushub/`.

## 13. Troubleshooting

| Sintoma | Verificar |
|---|---|
| Ping RouterOS↔servidor falha | IP/máscara dos dois lados, cabo/porta, `ip neigh` |
| Nada chega ao RADIUS | `/radius monitor 0`, `/ppp aaa print`, secret, `tcpdump -ni <iface> "udp port 1812"` |
| Accept mas cai / sem IP | profile sem `local-address`/`remote-address`, pool esgotada (`/ip pool used print`) |
| Painel sem dados | `api.php?action=status` no curl, permissão `freerad` p/ www-data, log do Apache |
| Tráfego zerado | `/snmp set enabled=yes` no RouterOS; community; `snmpwalk -v2c -c public 10.10.10.1 1.3.6.1.2.1.2.2.1.2` |

## 14. Mapa de arquivos e serviços (onde fica cada coisa)

| Componente | Caminho | Função |
|---|---|---|
| Config FreeRADIUS | `/etc/freeradius/3.0/` | raiz das configurações (raddb) |
| Módulo SQL | `/etc/freeradius/3.0/mods-available/sql` | conexão com o MariaDB (symlink em `mods-enabled/sql`) |
| Cliente NAS | `/etc/freeradius/3.0/clients.conf` | IP + secret de cada NAS (aqui: MikroTik) |
| Sites | `/etc/freeradius/3.0/sites-enabled/default`, `inner-tunnel` | fluxo de authorize/accounting/post-auth/session |
| Log de auditoria | `/etc/freeradius/3.0/radiusd.conf` (seção `log`) | liga/desliga log de autenticação |
| Banco de dados | MariaDB, base `radius` | tabelas radcheck/radreply/radacct/radpostauth/nas… |
| Logs RADIUS | `/var/log/freeradius/radius.log` | `Login OK` / `Login incorrect` |
| Detalhe de sessões | `/var/log/freeradius/radacct/<NAS-IP>/detail-AAAAMMDD` | todos os atributos de cada sessão |
| Painel web | `/var/www/radiushub/` | `index.html`, `api.js`, `api.php` |
| Vhost Apache | `/etc/apache2/sites-available/radiushub.conf` | HTTP(301)→HTTPS + docroot (sem login) |
| Certificado TLS | `/etc/ssl/certs/radiushub.crt`, `/etc/ssl/private/radiushub.key` | HTTPS self-signed |
| Permissão reload | `/etc/sudoers.d/radiushub` | www-data pode `reload`/`restart` do freeradius |
| Grupo p/ painel | `www-data` no grupo `freerad` | ler `clients.conf` (NAS/PoD) |
| Rede RADIUS | `/etc/netplan/60-radius.yaml` | IP fixo da interface dedicada |
| Backup | `/var/backups/radiushub/` + `/usr/local/sbin/radiushub-backup.sh` | cron diário 03:00 |
| Monitor | `/usr/local/sbin/radiushub-monitor.sh` | cron 5 min, alerta Telegram |
| Limpeza de sessões | `/usr/local/sbin/radiushub-cleanup.sh` | cron diário 04:00, fecha sessões órfãs |
| Cron | `/etc/cron.d/radiushub-backup`, `radiushub-monitor`, `radiushub-cleanup` | agendamentos |

Serviços: `mariadb`, `freeradius`, `apache2` (todos `enabled` no boot).

## 15. Como o FreeRADIUS foi configurado (referência)

### 15.1 Módulo SQL (`mods-available/sql`)

O módulo faz o FreeRADIUS ler/escrever no MariaDB. Valores usados:

```ini
dialect = "mysql"
driver = "rlm_sql_mysql"
server = "localhost"
port = 3306
login = "radius"
password = "SENHA_DO_MYSQL"    # a mesma definida no install.sh
radius_db = "radius"
read_clients = yes             # lê os NAS da tabela `nas` (só no start do serviço)
```

- O bloco `mysql { tls { ... } }` foi **comentado** (conexão local não usa TLS).
- Habilitar: `ln -sf ../mods-available/sql /etc/freeradius/3.0/mods-enabled/sql`
- Backup do original: `/etc/freeradius/3.0/mods-available/sql.bak*`

### 15.2 Cliente NAS (`clients.conf`)

```ini
client mikrotik_routeros {
    ipaddr = 10.10.10.1
    secret = SECRET_DO_RADIUS
    require_message_authenticator = yes
    nas_type = other
}
```

Sem essa entrada (ou com secret diferente) o NAS não consegue autenticar. O
secret precisa ser **idêntico** ao configurado no `/radius` do MikroTik.

### 15.3 Sites (`sites-enabled/default`)

O módulo `sql` já é referenciado nas seções do site `default`
(`-sql` em `authorize`, `accounting` e `post-auth`). Além disso, para
**Simultaneous-Use** funcionar, o `sql` foi ativado na seção `session`:

```
session {
#	radutmp
	#  See "Simultaneous Use Checking Queries" in mods-available/sql
	sql          # <-- ativado
}
```

O site `inner-tunnel` é usado para EAP/túnel.

### 15.4 Log de auditoria (`radiusd.conf`, seção `log`)

```ini
auth = yes
auth_badpass = yes
auth_goodpass = yes
```

Isso registra tentativas no `radius.log` (inclui a senha tentada quando
`auth_goodpass/badpass = yes` — restrinja o acesso ao arquivo/banco).

### 15.5 Comandos úteis do FreeRADIUS

```bash
sudo freeradius -CX                 # valida a configuração e sai
sudo freeradius -X                  # roda em debug (porta 1812 bloqueada: pare o serviço antes)
sudo systemctl restart freeradius
sudo systemctl reload freeradius    # envia HUP (recarrega; é o que o painel faz)
radtest USUARIO SENHA 127.0.0.1 0 testing123   # teste local (cliente localhost)
```

### 15.6 Tabelas do banco `radius` e papel de cada uma

| Tabela | Uso |
|---|---|
| `radcheck` | itens de **checagem** do usuário: senha (`Cleartext-Password`) e `Simultaneous-Use` |
| `radreply` | atributos de **resposta**: `Mikrotik-Rate-Limit`, `Framed-IP-Address`, etc. |
| `radgroupcheck` | checagens por **plano/grupo** (ex.: `Auth-Type := Reject` do grupo de bloqueio) |
| `radgroupreply` | respostas por **plano/grupo** (ex.: `Mikrotik-Rate-Limit` do plano) |
| `radusergroup` | liga usuário → grupo (plano) |
| `radacct` | accounting das sessões (início/fim, IP, bytes up/down) |
| `radpostauth` | log de cada tentativa (aceita/rejeitada) |
| `nas` | clientes NAS (usados com `read_clients = yes`) |

Regra de ouro do limite de banda: **`Mikrotik-Rate-Limit` vai em `radreply`
(usuário) ou `radgroupreply` (plano)**, formato `upload/download`
(ex.: `5M/20M`), e **sobrepõe** o profile PPPoE.

## 16. Conexão com o MikroTik (referência completa)

### 16.1 Lado do MikroTik (RouterOS)

```routeros
# rede dedicada ao RADIUS
/ip address add address=10.10.10.1/30 interface=ether5

# servidor RADIUS
/radius add service=ppp address=10.10.10.2 secret=SECRET_DO_RADIUS timeout=3s
/ppp aaa set use-radius=yes accounting=yes

# gráfico de tráfego em tempo real do painel
/snmp set enabled=yes
```

PPPoE (profile entrega IP/DNS; a velocidade vem do RADIUS):

```routeros
/interface bridge add name=bridge-clientes
/interface bridge port add bridge=bridge-clientes interface=ether2
/interface bridge port add bridge=bridge-clientes interface=ether3
/ip pool add name=pool-pppoe ranges=172.16.0.2-172.16.0.254
/ppp profile add name=Plano-Base local-address=172.16.0.1 remote-address=pool-pppoe \
  dns-server=8.8.8.8,1.1.1.1 use-encryption=no
/interface pppoe-server server add service-name=Servidor-PPPoE \
  interface=bridge-clientes default-profile=Plano-Base \
  authentication=pap,chap,mschap1,mschap2 disabled=no
/ip firewall nat add chain=srcnat action=masquerade out-interface=ether1
```

### 16.2 O que acontece num login PPPoE

```
Cliente PPPoE → MikroTik (NAS 10.10.10.1)
   → Access-Request (UDP 1812) para 10.10.10.2
      → FreeRADIUS autoriza no MariaDB (radcheck/radreply/radgroupreply)
      ← Access-Accept + Mikrotik-Rate-Limit / Session-Timeout
   → sessão PPPoE sobe com a banda definida no banco
   → Accounting-Request Start/Interim/Stop (UDP 1813) → radacct
```

Se o usuário **existir localmente** em `/ppp secret`, o RADIUS **não** é
consultado. Use logins só no RADIUS (ou remova os secrets locais).

### 16.3 Diagnóstico no MikroTik

```routeros
/ping 10.10.10.2
/radius monitor 0        # requests/accepts/rejects/timeouts
/ppp active print        # sessões ativas (deve mostrar IP 172.16.0.x)
/log print where topics~"ppp"
```

## 17. Como a GUI fala com o sistema

```
Navegador (HTTPS) ──> Apache /var/www/radiushub
      index.html + api.js
            │  fetch api.php?action=...
            ▼
        api.php  (PHP + MySQLi, sem login)
   ├── lê/escreve MariaDB `radius`  (usuários, planos, accounting, logs, stats)
   ├── executa `radtest`            (teste de autenticação real)
   ├── executa `radclient`          (PoD: derruba sessão do cliente)
   ├── executa `snmpwalk` no RouterOS    (tráfego por usuário em tempo real)
   ├── lê /var/log/freeradius/radius.log e clients.conf
   └── `systemctl reload|restart freeradius` (via sudoers) para HUP/restart
```

- `api.js` **substitui** os dados mockados do HTML pelos dados reais (o HTML
  original em `/home/server/freeradius_manager/` continua intacto).
- Requisitos de infraestrutura que a GUI usa:
  - `www-data` no grupo `freerad` (ler `clients.conf`; senão NAS/PoD falham);
  - `/etc/sudoers.d/radiushub` (reload/restart do FreeRADIUS);
  - `/snmp set enabled=yes` no RouterOS (para o gráfico oscilar);
  - PHP com `mysqli`; `snmp` e `freeradius-utils` (`radtest`/`radclient`) instalados.

Ações da API (`api.php?action=`): `status, users, user_save, user_delete, groups,
group_save, group_delete, accounting, events, stats, logs, radtest, reload,
restart, nas_list, nas_save, nas_delete, pod, snmp_traffic`.

## 18. Runbook de recuperação (se esta máquina queimar)

### 18.1 Reconstruir o sistema

1. Instale o Ubuntu Server e clone o repositório.
2. Edite as variáveis no topo do `install.sh` (senhas, secret, IP do NAS) e rode:
   `sudo bash install.sh`
   Isso recria banco, FreeRADIUS, painel, HTTPS, backup, monitor e Simultaneous-Use.
3. **Restaure os dados** do backup (se tiver):

```bash
# banco (usuários, planos, histórico)
gunzip < /var/backups/radiushub/radius-AAAA-MM-DD_hhmmss.sql.gz | sudo mariadb radius
# configuração do FreeRADIUS (clients.conf, mods, sites)
sudo tar xzf /var/backups/radiushub/freeradius-AAAA....tar.gz -C /etc/freeradius
# painel
sudo tar xzf /var/backups/radiushub/radiushub-AAAA....tar.gz -C /var/www
sudo systemctl restart freeradius apache2
```

4. No MikroTik, confirme que o `/radius` aponta para o **novo** IP `10.10.10.2`
   e que o secret bate com o `clients.conf` restaurado.

### 18.2 Onde estão os backups

- Local: `/var/backups/radiushub/` (diário 03:00, retenção 30 dias).
- **Importante:** copie periodicamente para **fora** do servidor, por exemplo:
  `rsync -avz /var/backups/radiushub/ usuario@outra-maquina:/backups/radiushub/`

### 18.3 Checklist pós-recuperação

```bash
ip -br a show ens34                         # 10.10.10.2/30
ping -c3 10.10.10.1                          # enlace com o RouterOS
sudo freeradius -CX                          # config válida
systemctl is-active mariadb freeradius apache2
radtest USUARIO SENHA 127.0.0.1 0 testing123  # autenticação
curl -sk https://127.0.0.1/api.php?action=status
```

No RouterOS: `/ping 10.10.10.2`, `/radius monitor 0` (accepts subindo),
`/ppp active print` (clientes com IP 172.16.0.x).

### 18.4 Reconstruir a configuração manualmente

Se não houver backup, siga a seção **5** (instalação manual) e a seção **15**
(referência do FreeRADIUS); depois reconfigure o MikroTik pela seção **16**.

## 19. Arquivos

```
radiushub/
├── index.html    # painel (Tailwind + Chart.js via CDN)
├── api.js        # adapter: liga o HTML ao backend real
├── api.php       # backend JSON (MySQLi, radtest, logs, SNMP, reload)
├── backup.sh     # backup diario (MySQL + FreeRADIUS + painel)
├── monitor.sh    # monitor de saude + alerta Telegram
├── cleanup.sh    # limpeza de sessoes orfas do accounting
├── install.sh    # instalador do servidor (edite as variaveis no topo)
└── README.md     # este arquivo
```

> `api.php` usa placeholders (`__DB_PASS__`) preenchidos pelo `install.sh`.
> Nunca suba credenciais reais para o GitHub.
