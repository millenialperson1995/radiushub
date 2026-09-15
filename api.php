<?php
// RadiusHub API - backend JSON para o painel (FreeRADIUS + MariaDB).
// Protegido pelo Basic Auth do Apache no vhost.
header('Content-Type: application/json; charset=utf-8');

define('DB_HOST', 'localhost');
define('DB_USER', '__DB_USER__');
define('DB_PASS', '__DB_PASS__');
define('DB_NAME', '__DB_NAME__');
define('RADIUS_LOG', '/var/log/freeradius/radius.log');
define('CLIENTS_CONF', '/etc/freeradius/3.0/clients.conf');
define('DISABLED_GROUP', 'daloRADIUS-Disabled-Users');

function db() {
    static $m = null;
    if ($m === null) {
        $m = new mysqli(DB_HOST, DB_USER, DB_PASS, DB_NAME);
        if ($m->connect_error) { out(['ok' => false, 'error' => 'DB: ' . $m->connect_error]); }
        $m->set_charset('utf8mb4');
    }
    return $m;
}
function out($d) { echo json_encode($d, JSON_UNESCAPED_UNICODE); exit; }
function inp($k, $def = '') { $v = isset($_REQUEST[$k]) ? $_REQUEST[$k] : $def; return is_string($v) ? trim($v) : $v; }
function sh($cmd) { $o = []; $c = 0; exec($cmd . ' 2>&1', $o, $c); return ['code' => $c, 'out' => implode("\n", $o)]; }
function fmt_bytes($b) {
    $b = (float)$b;
    if ($b >= 1073741824) return round($b / 1073741824, 1) . ' GB';
    if ($b >= 1048576) return round($b / 1048576, 1) . ' MB';
    if ($b >= 1024) return round($b / 1024, 1) . ' KB';
    return (int)$b . ' B';
}
function fmt_dur($s) {
    $s = max(0, (int)$s);
    return sprintf('%02d:%02d:%02d', floor($s / 3600), floor(($s % 3600) / 60), $s % 60);
}

$action = inp('action', '');

if ($action === 'status') {
    $fr = sh('systemctl is-active freeradius');
    $db = sh('systemctl is-active mariadb');
    $pid = trim(shell_exec('pidof freeradius 2>/dev/null'));
    $up = trim(shell_exec("ps -o etime= -C freeradius 2>/dev/null | head -1"));
    $ports = sh("ss -lun 2>/dev/null | grep -cE ':(1812|1813) '");
    $m = db();
    $users = (int)$m->query("SELECT COUNT(DISTINCT username) c FROM radcheck")->fetch_assoc()['c'];
    $nasdb = (int)$m->query("SELECT COUNT(*) c FROM nas")->fetch_assoc()['c'];
    $fileclients = 0;
    if (is_readable(CLIENTS_CONF)) {
        $fileclients = preg_match_all('/^\s*client\s+\S+/m', file_get_contents(CLIENTS_CONF));
    }
    $active = (int)$m->query("SELECT COUNT(*) c FROM radacct WHERE acctstoptime IS NULL")->fetch_assoc()['c'];
    $acc24 = (int)$m->query("SELECT COUNT(*) c FROM radpostauth WHERE reply='Access-Accept' AND authdate >= NOW() - INTERVAL 1 DAY")->fetch_assoc()['c'];
    $rej24 = (int)$m->query("SELECT COUNT(*) c FROM radpostauth WHERE reply='Access-Reject' AND authdate >= NOW() - INTERVAL 1 DAY")->fetch_assoc()['c'];
    out(['ok' => true, 'freeradius' => trim($fr['out']), 'mariadb' => trim($db['out']),
        'pid' => $pid ? $pid : '-', 'uptime' => $up ? $up : '-',
        'ports_open' => ((int)$ports['out'] >= 2), 'users' => $users,
        'nas' => $nasdb + $fileclients, 'active' => $active, 'accept24' => $acc24, 'reject24' => $rej24]);
}

if ($action === 'users') {
    $m = db(); $list = [];
    $q = $m->query("SELECT DISTINCT username FROM radcheck ORDER BY username");
    while ($r = $q->fetch_assoc()) {
        $u = $r['username'];
        $pw = $m->query("SELECT attribute, value FROM radcheck WHERE username='" . $m->real_escape_string($u) . "' AND attribute IN ('Cleartext-Password','MD5-Password','SHA2-Password','Crypt-Password','NT-Password') ORDER BY FIELD(attribute,'Cleartext-Password') DESC LIMIT 1")->fetch_assoc();
        $g = $m->query("SELECT groupname FROM radusergroup WHERE username='" . $m->real_escape_string($u) . "' AND groupname<>'" . DISABLED_GROUP . "' LIMIT 1");
        $gr = $g ? $g->fetch_assoc() : null;
        $dis = $m->query("SELECT 1 FROM radusergroup WHERE username='" . $m->real_escape_string($u) . "' AND groupname='" . DISABLED_GROUP . "' LIMIT 1")->num_rows > 0;
        $f = $m->query("SELECT value FROM radreply WHERE username='" . $m->real_escape_string($u) . "' AND attribute='Framed-IP-Address' LIMIT 1");
        $fr = $f ? $f->fetch_assoc() : null;
        $s = $m->query("SELECT value FROM radcheck WHERE username='" . $m->real_escape_string($u) . "' AND attribute='Simultaneous-Use' LIMIT 1");
        if (!$s || !$s->num_rows) $s = $m->query("SELECT value FROM radreply WHERE username='" . $m->real_escape_string($u) . "' AND attribute='Simultaneous-Use' LIMIT 1");
        $sm = $s ? $s->fetch_assoc() : null;
        $list[] = ['username' => $u, 'attribute' => $pw ? $pw['attribute'] : '', 'value' => $pw ? $pw['value'] : '',
            'group' => $gr ? $gr['groupname'] : '', 'framedIp' => $fr ? $fr['value'] : '',
            'simultaneous' => $sm ? (int)$sm['value'] : 1, 'status' => $dis ? 'disabled' : 'active'];
    }
    out(['ok' => true, 'users' => $list]);
}

if ($action === 'user_save') {
    $u = inp('username'); $attr = inp('attribute', 'Cleartext-Password'); $pw = inp('password');
    $group = inp('group'); $fip = inp('framedIp'); $sim = max(1, (int)inp('simultaneous', 1));
    $status = (inp('status', 'active') === 'disabled') ? 'disabled' : 'active';
    if ($u === '' || $pw === '') out(['ok' => false, 'error' => 'Usuário e senha são obrigatórios']);
    $allowed = ['Cleartext-Password', 'MD5-Password', 'SHA2-Password', 'Crypt-Password', 'NT-Password'];
    if (!in_array($attr, $allowed, true)) $attr = 'Cleartext-Password';
    $m = db(); $e = $m->real_escape_string($u);
    $m->query("DELETE FROM radcheck WHERE username='$e'");
    $st = $m->prepare("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, ?, ':=', ?)");
    $st->bind_param('sss', $u, $attr, $pw); $st->execute(); $st->close();
    if ($sim >= 1) {
        $su = 'Simultaneous-Use'; $sv = (string)$sim;
        $st = $m->prepare("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, ?, ':=', ?)");
        $st->bind_param('sss', $u, $su, $sv); $st->execute(); $st->close();
    }
    $m->query("DELETE FROM radreply WHERE username='$e' AND attribute IN ('Framed-IP-Address','Simultaneous-Use')");
    if ($fip !== '' && filter_var($fip, FILTER_VALIDATE_IP)) {
        $st = $m->prepare("INSERT INTO radreply (username, attribute, op, value) VALUES (?, 'Framed-IP-Address', ':=', ?)");
        $st->bind_param('ss', $u, $fip); $st->execute(); $st->close();
    }
    $m->query("DELETE FROM radusergroup WHERE username='$e'");
    if ($group !== '') {
        $st = $m->prepare("INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)");
        $st->bind_param('ss', $u, $group); $st->execute(); $st->close();
    }
    if ($status === 'disabled') {
        $dg = DISABLED_GROUP;
        $st = $m->prepare("INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 0)");
        $st->bind_param('ss', $u, $dg); $st->execute(); $st->close();
    }
    out(['ok' => true]);
}

if ($action === 'user_delete') {
    $u = inp('username'); if ($u === '') out(['ok' => false, 'error' => 'Usuário vazio']);
    $m = db(); $e = $m->real_escape_string($u);
    $m->query("DELETE FROM radreply WHERE username='$e'");
    $m->query("DELETE FROM radusergroup WHERE username='$e'");
    $m->query("DELETE FROM radcheck WHERE username='$e'");
    out(['ok' => true]);
}

if ($action === 'groups') {
    $m = db(); $g = [];
    $q = $m->query("SELECT groupname, attribute, value FROM radgroupreply ORDER BY groupname");
    while ($r = $q->fetch_assoc()) {
        $n = $r['groupname'];
        if (!isset($g[$n])) $g[$n] = ['name' => $n, 'rate' => '', 'timeout' => ''];
        if ($r['attribute'] === 'Mikrotik-Rate-Limit') $g[$n]['rate'] = $r['value'];
        if ($r['attribute'] === 'Session-Timeout') $g[$n]['timeout'] = $r['value'];
    }
    out(['ok' => true, 'groups' => array_values($g)]);
}

if ($action === 'group_save') {
    $n = inp('name'); $rate = inp('rate'); $to = inp('timeout', '');
    if ($n === '') out(['ok' => false, 'error' => 'Nome do grupo vazio']);
    $m = db(); $e = $m->real_escape_string($n);
    $m->query("DELETE FROM radgroupreply WHERE groupname='$e'");
    if ($rate !== '') {
        $st = $m->prepare("INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'Mikrotik-Rate-Limit', ':=', ?)");
        $st->bind_param('ss', $n, $rate); $st->execute(); $st->close();
    }
    if ($to !== '' && ctype_digit($to)) {
        $st = $m->prepare("INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'Session-Timeout', ':=', ?)");
        $st->bind_param('ss', $n, $to); $st->execute(); $st->close();
    }
    out(['ok' => true]);
}

if ($action === 'group_delete') {
    $n = inp('name'); if ($n === '') out(['ok' => false, 'error' => 'Nome vazio']);
    $m = db(); $e = $m->real_escape_string($n);
    $m->query("DELETE FROM radgroupreply WHERE groupname='$e'");
    $m->query("DELETE FROM radusergroup WHERE groupname='$e'");
    out(['ok' => true]);
}

if ($action === 'accounting') {
    $f = inp('filter', 'active'); $m = db(); $list = [];
    $w = ($f === 'active') ? 'WHERE acctstoptime IS NULL' : (($f === 'closed') ? 'WHERE acctstoptime IS NOT NULL' : '');
    $q = $m->query("SELECT acctsessionid, username, nasipaddress, nasportid, framedipaddress, callingstationid, acctstarttime, acctstoptime, acctinputoctets, acctoutputoctets, acctterminatecause FROM radacct $w ORDER BY acctstarttime DESC LIMIT 200");
    while ($r = $q->fetch_assoc()) {
        $start = strtotime($r['acctstarttime']);
        $end = $r['acctstoptime'] ? strtotime($r['acctstoptime']) : time();
        $list[] = ['id' => $r['acctsessionid'], 'username' => $r['username'], 'nasIp' => $r['nasipaddress'],
            'port' => $r['nasportid'] ? $r['nasportid'] : '-', 'framedIp' => $r['framedipaddress'],
            'mac' => $r['callingstationid'], 'duration' => fmt_dur($end - $start),
            'down' => fmt_bytes($r['acctoutputoctets']), 'up' => fmt_bytes($r['acctinputoctets']),
            'active' => ($r['acctstoptime'] === null), 'cause' => $r['acctterminatecause'] ? $r['acctterminatecause'] : ''];
    }
    out(['ok' => true, 'sessions' => $list]);
}

if ($action === 'events') {
    $m = db(); $list = [];
    $q = $m->query("SELECT username, reply, authdate FROM radpostauth ORDER BY authdate DESC LIMIT 12");
    while ($r = $q->fetch_assoc()) $list[] = $r;
    out(['ok' => true, 'events' => $list]);
}

if ($action === 'stats') {
    $m = db();
    $hours = []; $acc = []; $rej = [];
    for ($i = 7; $i >= 0; $i--) {
        $h0 = date('Y-m-d H:00:00', strtotime("-$i hour"));
        $h1 = date('Y-m-d H:00:00', strtotime("-" . ($i - 1) . " hour"));
        $hours[] = date('H\h', strtotime($h0));
        $e0 = $m->real_escape_string($h0); $e1 = $m->real_escape_string($h1);
        $acc[] = (int)$m->query("SELECT COUNT(*) c FROM radpostauth WHERE reply='Access-Accept' AND authdate>='$e0' AND authdate<'$e1'")->fetch_assoc()['c'];
        $rej[] = (int)$m->query("SELECT COUNT(*) c FROM radpostauth WHERE reply='Access-Reject' AND authdate>='$e0' AND authdate<'$e1'")->fetch_assoc()['c'];
    }
    $pie = [];
    $q = $m->query("SELECT nasipaddress, SUM(acctinputoctets+acctoutputoctets) t FROM radacct GROUP BY nasipaddress ORDER BY t DESC LIMIT 5");
    while ($r = $q->fetch_assoc()) $pie[] = ['nas' => $r['nasipaddress'], 'bytes' => (int)$r['t']];
    out(['ok' => true, 'hours' => $hours, 'accept' => $acc, 'reject' => $rej, 'bynas' => $pie]);
}

if ($action === 'logs') {
    $n = max(20, min(500, (int)inp('lines', 120)));
    $r = sh('tail -n ' . $n . ' ' . escapeshellarg(RADIUS_LOG));
    out(['ok' => true, 'lines' => explode("\n", $r['out'])]);
}

if ($action === 'radtest') {
    $u = inp('user'); $p = inp('pass');
    if ($u === '' || $p === '') out(['ok' => false, 'error' => 'Usuário e senha obrigatórios']);
    $r = sh('timeout 10 radtest ' . escapeshellarg($u) . ' ' . escapeshellarg($p) . ' 127.0.0.1 0 testing123');
    $accept = (strpos($r['out'], 'Received Access-Accept') !== false);
    out(['ok' => true, 'accept' => $accept, 'output' => $r['out']]);
}

if ($action === 'reload') {
    $r = sh('sudo /usr/bin/systemctl reload freeradius');
    out(['ok' => $r['code'] === 0, 'output' => $r['out']]);
}

if ($action === 'restart') {
    $r = sh('sudo /usr/bin/systemctl restart freeradius');
    sleep(2);
    out(['ok' => $r['code'] === 0, 'output' => $r['out']]);
}

if ($action === 'nas_list') {
    $m = db(); $list = [];
    $q = $m->query("SELECT id, nasname, shortname, type, secret, description FROM nas ORDER BY nasname");
    while ($r = $q->fetch_assoc()) { $r['source'] = 'db'; $list[] = $r; }
    if (is_readable(CLIENTS_CONF)) {
        $txt = file_get_contents(CLIENTS_CONF);
        if (preg_match_all('/^\s*client\s+(\S+)\s*\{([^}]*)\}/m', $txt, $mm, PREG_SET_ORDER)) {
            foreach ($mm as $b) {
                $ip = ''; $sec = '';
                if (preg_match('/^\s*ipaddr\s*=\s*(\S+)/m', $b[2], $x)) $ip = trim($x[1]);
                if (preg_match('/^\s*secret\s*=\s*(\S+)/m', $b[2], $x)) $sec = trim($x[1], '"');
                if ($ip !== '' && stripos($b[1], 'localhost') === false) {
                    $list[] = ['id' => 0, 'nasname' => $ip, 'shortname' => trim($b[1]), 'type' => 'other', 'secret' => $sec, 'description' => 'clients.conf (arquivo)', 'source' => 'file'];
                }
            }
        }
    }
    out(['ok' => true, 'nas' => $list]);
}

if ($action === 'nas_save') {
    $name = inp('name'); $ip = inp('ip'); $type = inp('type', 'other'); $sec = inp('secret'); $desc = inp('desc', 'RADIUS Client');
    if ($name === '' || $sec === '') out(['ok' => false, 'error' => 'Nome e secret obrigatórios']);
    if ($ip !== '' && !filter_var($ip, FILTER_VALIDATE_IP)) out(['ok' => false, 'error' => 'IP inválido']);
    $allowed = ['mikrotik', 'cisco', 'other', 'chillispot'];
    if (!in_array($type, $allowed, true)) $type = 'other';
    $m = db();
    $st = $m->prepare("INSERT INTO nas (nasname, shortname, type, secret, description) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE shortname=VALUES(shortname), type=VALUES(type), secret=VALUES(secret), description=VALUES(description)");
    $st->bind_param('sssss', $ip, $name, $type, $sec, $desc); $st->execute(); $st->close();
    out(['ok' => true, 'restart_required' => true]);
}

if ($action === 'nas_delete') {
    $id = (int)inp('id'); if ($id <= 0) out(['ok' => false, 'error' => 'NAS de arquivo: edite o clients.conf manualmente']);
    db()->query("DELETE FROM nas WHERE id=$id");
    out(['ok' => true, 'restart_required' => true]);
}

if ($action === 'pod') {
    $u = inp('username'); if ($u === '') out(['ok' => false, 'error' => 'Usuário vazio']);
    $m = db(); $e = $m->real_escape_string($u);
    $s = $m->query("SELECT nasipaddress, framedipaddress FROM radacct WHERE username='$e' AND acctstoptime IS NULL ORDER BY acctstarttime DESC LIMIT 1")->fetch_assoc();
    if (!$s) out(['ok' => false, 'error' => 'Sem sessão ativa para este usuário']);
    $nas = $s['nasipaddress'];
    $sec = '';
    $q = $m->query("SELECT secret FROM nas WHERE nasname='" . $m->real_escape_string($nas) . "' LIMIT 1");
    if ($q && $q->num_rows) $sec = $q->fetch_assoc()['secret'];
    if ($sec === '' && $nas === '10.10.10.1' && is_readable(CLIENTS_CONF)) {
        $txt = file_get_contents(CLIENTS_CONF);
        if (preg_match('/ipaddr\s*=\s*10\.10\.10\.1[^}]*secret\s*=\s*(\S+)/s', $txt, $x)) $sec = trim($x[1], '"');
    }
    if ($sec === '') out(['ok' => false, 'error' => 'Secret do NAS desconhecido (cadastre o NAS na tabela nas)']);
    $pkt = sprintf("User-Name=%s\nFramed-IP-Address=%s\n", $u, $s['framedipaddress']);
    $tmp = tempnam(sys_get_temp_dir(), 'pod');
    file_put_contents($tmp, $pkt);
    $r = sh('timeout 6 radclient ' . escapeshellarg($nas . ':1700') . ' disconnect ' . escapeshellarg($sec) . ' < ' . escapeshellarg($tmp));
    @unlink($tmp);
    out(['ok' => true, 'output' => $r['out']]);
}

define('SNMP_HOST', '10.10.10.1');
define('SNMP_COMM', '__SNMP_COMM__');
define('SNMP_STATE', sys_get_temp_dir() . '/radiushub_snmp.json');

if ($action === 'snmp_traffic') {
    $walk = function ($oid) {
        $r = sh('snmpwalk -v2c -c ' . escapeshellarg(SNMP_COMM) . ' -Oqn -t 2 -r 1 ' . escapeshellarg(SNMP_HOST) . ' ' . escapeshellarg($oid));
        $arr = [];
        foreach (explode("\n", $r['out']) as $ln) {
            $ln = trim($ln);
            if ($ln === '' || stripos($ln, 'Timeout') !== false || stripos($ln, 'No Such') !== false) continue;
            if (preg_match('/\.(\d+)\s+(.*)$/', $ln, $m)) $arr[$m[1]] = trim($m[2], '" ');
        }
        return [$r['code'] === 0 && count($arr) > 0, $arr];
    };
    list($okd, $descr) = $walk('1.3.6.1.2.1.2.2.1.2');
    if (!$okd) out(['ok' => false, 'error' => 'SNMP sem resposta em ' . SNMP_HOST . '. No RouterOS: /snmp set enabled=yes']);
    list(, $cin) = $walk('1.3.6.1.2.1.31.1.1.1.6');
    list(, $cout) = $walk('1.3.6.1.2.1.31.1.1.1.10');
    $now = microtime(true);
    $prev = (file_exists(SNMP_STATE) && ($j = json_decode(file_get_contents(SNMP_STATE), true))) ? $j : null;
    $users = []; $td = 0; $tu = 0; $state = ['t' => $now, 'c' => []];
    foreach ($descr as $idx => $d) {
        if (strpos($d, '<pppoe-') !== 0) continue;
        $user = preg_replace('/^<pppoe-(.*)>$/', '$1', $d);
        $in = isset($cin[$idx]) ? (float)$cin[$idx] : 0;
        $ot = isset($cout[$idx]) ? (float)$cout[$idx] : 0;
        $state['c'][$idx] = [$in, $ot];
        $down = 0; $up = 0;
        if ($prev && isset($prev['c'][$idx]) && $now > $prev['t']) {
            $dt = $now - $prev['t'];
            $dd = $in - $prev['c'][$idx][0]; if ($dd < 0) $dd = 0;
            $du = $ot - $prev['c'][$idx][1]; if ($du < 0) $du = 0;
            $up = $dd * 8 / $dt / 1000000;
            $down = $du * 8 / $dt / 1000000;
        }
        $td += $down; $tu += $up;
        $users[] = ['user' => $user, 'iface' => $d, 'down' => round($down, 2), 'up' => round($up, 2)];
    }
    file_put_contents(SNMP_STATE, json_encode($state));
    usort($users, function ($a, $b) { return ($b['down'] + $b['up']) - ($a['down'] + $a['up']); });
    $on = [];
    $q = db()->query("SELECT username, framedipaddress, acctstarttime FROM radacct WHERE acctstoptime IS NULL ORDER BY acctstarttime DESC LIMIT 50");
    while ($r2 = $q->fetch_assoc()) {
        $on[] = ['user' => $r2['username'], 'ip' => $r2['framedipaddress'], 'dur' => fmt_dur(time() - strtotime($r2['acctstarttime']))];
    }
    out(['ok' => true, 'users' => $users, 'total_down' => round($td, 2), 'total_up' => round($tu, 2),
        'online' => $on, 'first' => ($prev === null)]);
}

out(['ok' => false, 'error' => 'Ação inválida']);
