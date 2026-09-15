/* RadiusHub backend adapter - troca os dados mockados por dados reais via api.php */
(function () {
'use strict';

async function apiGet(action, params) {
    params = params || {};
    const qs = new URLSearchParams(Object.assign({ action: action }, params));
    const r = await fetch('api.php?' + qs.toString(), { credentials: 'same-origin' });
    return r.json();
}
async function apiPost(action, data) {
    data = data || {};
    const body = new URLSearchParams(Object.assign({ action: action }, data));
    const r = await fetch('api.php', { method: 'POST', credentials: 'same-origin', body: body });
    return r.json();
}
function esc(s) { return String(s == null ? '' : s); }

/* ---------- boot: carrega tudo do servidor ---------- */
async function bootReal() {
    try {
        const [st, us, nas, gr, ac, ev, stats] = await Promise.all([
            apiGet('status'), apiGet('users'), apiGet('nas_list'), apiGet('groups'),
            apiGet('accounting', { filter: 'all' }), apiGet('events'), apiGet('stats')
        ]);
        if (st.ok) applyStatus(st);
        const usersArr = (us.ok && Array.isArray(us.users)) ? us.users : [];
        const groupsArr = (gr.ok && Array.isArray(gr.groups)) ? gr.groups : [];
        const sessArr = (ac.ok && Array.isArray(ac.sessions)) ? ac.sessions : [];
        if (us.ok) {
            APP_STATE.users = usersArr.map(function (u) {
                return { id: u.username, username: u.username, attribute: u.attribute, op: ':=',
                    value: u.value, group: u.group, framedIp: u.framedIp,
                    simultaneous: u.simultaneous, status: u.status };
            });
            renderUsers();
            refreshGroupSelect(groupsArr);
        }
        if (nas.ok) {
            APP_STATE.nasClients = nas.nas.map(function (n) {
                return { id: (n.source === 'db' ? 'db:' + n.id : 'file:' + n.nasname),
                    name: n.shortname, ip: n.nasname, type: n.type, secret: n.secret, desc: n.description };
            });
            renderNasClients();
        }
        if (gr.ok) {
            APP_STATE.groups = groupsArr.map(function (g) {
                return { id: g.name, name: g.name, rate: g.rate || '-', timeout: g.timeout || '-', desc: 'radgroupreply' };
            });
            renderGroups();
        }
        if (ac.ok) {
            APP_STATE.sessions = sessArr.map(function (s) {
                return { id: s.id, username: s.username, nasIp: s.nasIp, port: s.port,
                    framedIp: s.framedIp, mac: s.mac, duration: s.duration,
                    down: s.down, up: s.up, active: s.active };
            });
            const f = document.getElementById('acct-filter');
            if (f) f.value = 'all';
            renderAccounting();
        }
        if (ev.ok && Array.isArray(ev.events)) renderRealEvents(ev.events);
        if (stats.ok && stats.hours) applyStats(stats);
        await refreshLogs();
        updateSqlDump();
        logEvent('INFO: Painel conectado ao backend real (api.php).');
    } catch (e) {
        showToast('Falha ao falar com api.php: ' + e.message);
    }
}

function applyStatus(st) {
    const pill = document.querySelector('header span.font-mono.font-semibold');
    setText('daemon-pid', st.pid);
    setText('daemon-uptime', st.uptime);
    setText('daemon-db', 'radius');
    setText('stat-total-users', st.users);
    setText('badge-users-count', st.users);
    setText('stat-nas-count', st.nas);
    setText('badge-nas-count', st.nas);
    setText('stat-active-sessions', st.active);
    const tot = st.accept24 + st.reject24;
    setText('stat-accept-rate', tot ? (100 * st.accept24 / tot).toFixed(1) + '%' : '—');
    setText('stat-accept-sub', st.accept24 + ' autorizações / ' + st.reject24 + ' rejeições (24h)');
}
function setText(id, v) { const el = document.getElementById(id); if (el) el.innerText = v; }
window.apiGet = apiGet; window.apiPost = apiPost; window.setText = setText; window.esc = esc;

function renderRealEvents(evts) {
    const tbody = document.getElementById('dashboard-recent-events');
    if (!tbody) return;
    tbody.innerHTML = '';
    evts.slice(0, 6).forEach(function (e) {
        const ok = e.reply === 'Access-Accept';
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-slate-800/40 transition';
        tr.innerHTML =
            '<td class="py-2.5 px-3 text-slate-400 whitespace-nowrap">' + esc(e.authdate) + '</td>' +
            '<td class="py-2.5 px-3"><span class="px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300">AUTH</span></td>' +
            '<td class="py-2.5 px-3 text-white font-medium">' + esc(e.username) + '</td>' +
            '<td class="py-2.5 px-3 text-slate-400 whitespace-nowrap">10.10.10.1</td>' +
            '<td class="py-2.5 px-3 font-semibold ' + (ok ? 'text-emerald-400' : 'text-rose-400') + '">' + (ok ? 'OK' : 'REJECT') + '</td>' +
            '<td class="py-2.5 px-3 text-slate-400 whitespace-nowrap">' + esc(e.reply) + '</td>';
        tbody.appendChild(tr);
    });
}

function applyStats(s) {
    if (window.authChart) {
        window.authChart.data.labels = s.hours;
        window.authChart.data.datasets[0].data = s.accept;
        window.authChart.data.datasets[1].data = s.reject;
        window.authChart.update();
    }
    if (window.nasPieChart) {
        const labels = s.bynas.map(function (x) { return x.nas; });
        const data = s.bynas.map(function (x) { return x.bytes; });
        window.nasPieChart.data.labels = labels.length ? labels : ['sem tráfego'];
        window.nasPieChart.data.datasets[0].data = data.length ? data : [1];
        window.nasPieChart.update();
    }
}

function refreshGroupSelect(groups) {
    const sel = document.getElementById('form-user-group');
    if (!sel) return;
    sel.innerHTML = '<option value="">Sem grupo (velocidade individual)</option>';
    groups.forEach(function (g) {
        const o = document.createElement('option');
        o.value = g.name; o.innerText = g.name + (g.rate ? ' (' + g.rate + ')' : '');
        sel.appendChild(o);
    });
}

/* ---------- overrides: ações reais ---------- */

window.handleSaveUser = async function (e) {
    e.preventDefault();
    const username = document.getElementById('form-user-name').value.trim();
    const attr = document.getElementById('form-user-attr').value;
    const pass = document.getElementById('form-user-pass').value;
    const group = document.getElementById('form-user-group').value;
    const ip = document.getElementById('form-user-ip').value.trim();
    const simultaneous = parseInt(document.getElementById('form-user-simultaneous').value) || 1;
    const r = await apiPost('user_save', { username: username, attribute: attr, password: pass, group: group, framedIp: ip, simultaneous: simultaneous, status: 'active' });
    if (!r.ok) { showToast('Erro: ' + (r.error || 'falha ao salvar')); return; }
    showToast('Usuário ' + username + ' salvo no MySQL!');
    closeModal('modal-add-user');
    e.target.reset();
    const us = await apiGet('users');
    if (us.ok) {
        APP_STATE.users = us.users.map(function (u) {
            return { id: u.username, username: u.username, attribute: u.attribute, op: ':=', value: u.value, group: u.group, framedIp: u.framedIp, simultaneous: u.simultaneous, status: u.status };
        });
        renderUsers();
    }
};

window.deleteUser = async function (id) {
    const u = APP_STATE.users.find(function (x) { return String(x.id) === String(id); });
    const name = u ? u.username : id;
    if (!confirm('Excluir o usuário ' + name + ' do FreeRADIUS?')) return;
    const r = await apiPost('user_delete', { username: name });
    if (!r.ok) { showToast('Erro: ' + (r.error || 'falha')); return; }
    APP_STATE.users = APP_STATE.users.filter(function (x) { return String(x.id) !== String(id); });
    renderUsers();
    showToast('Usuário ' + name + ' removido.');
};

window.toggleUserStatus = async function (id) {
    const u = APP_STATE.users.find(function (x) { return String(x.id) === String(id); });
    if (!u) return;
    const next = u.status === 'active' ? 'disabled' : 'active';
    const r = await apiPost('user_save', { username: u.username, attribute: u.attribute, password: u.value, group: u.group, framedIp: u.framedIp, simultaneous: u.simultaneous, status: next });
    if (!r.ok) { showToast('Erro: ' + (r.error || 'falha')); return; }
    u.status = next;
    renderUsers();
    showToast(u.username + ': ' + (next === 'active' ? 'habilitado' : 'BLOQUEADO (Auth-Type Reject)') + '.');
};

window.handleSaveNas = async function (e) {
    e.preventDefault();
    const r = await apiPost('nas_save', {
        name: document.getElementById('form-nas-name').value.trim(),
        ip: document.getElementById('form-nas-ip').value.trim(),
        type: document.getElementById('form-nas-type').value,
        secret: document.getElementById('form-nas-secret').value.trim(),
        desc: document.getElementById('form-nas-desc').value.trim()
    });
    if (!r.ok) { showToast('Erro: ' + (r.error || 'falha')); return; }
    closeModal('modal-add-nas');
    e.target.reset();
    const nas = await apiGet('nas_list');
    if (nas.ok) {
        APP_STATE.nasClients = nas.nas.map(function (n) {
            return { id: (n.source === 'db' ? 'db:' + n.id : 'file:' + n.nasname), name: n.shortname, ip: n.nasname, type: n.type, secret: n.secret, desc: n.description };
        });
        renderNasClients();
    }
    showToast('NAS salvo na tabela nas.');
    if (r.restart_required && confirm('NAS salvo! O FreeRADIUS só lê novos NAS ao reiniciar. Reiniciar agora? (cai nada: sessões PPPoE ativas continuam)')) {
        const rr = await apiPost('restart', {});
        showToast(rr.ok ? 'FreeRADIUS reiniciado.' : 'Falha no restart: ' + (rr.output || ''));
    }
};

window.deleteNas = async function (id) {
    const n = APP_STATE.nasClients.find(function (x) { return String(x.id) === String(id); });
    if (!n) return;
    if (String(id).indexOf('file:') === 0) { showToast('Este NAS está no clients.conf — edite o arquivo no servidor.'); return; }
    if (!confirm('Remover NAS ' + n.name + ' (' + n.ip + ')?')) return;
    const dbid = String(id).split(':')[1];
    const r = await apiPost('nas_delete', { id: dbid });
    if (!r.ok) { showToast('Erro: ' + (r.error || 'falha')); return; }
    APP_STATE.nasClients = APP_STATE.nasClients.filter(function (x) { return String(x.id) !== String(id); });
    renderNasClients();
    showToast('NAS removido. Reinicie o FreeRADIUS para valer.');
};

window.handleSaveGroup = async function (e) {
    e.preventDefault();
    const name = document.getElementById('form-group-name').value.trim();
    const rate = document.getElementById('form-group-rate').value.trim();
    const timeout = document.getElementById('form-group-timeout').value.trim();
    const r = await apiPost('group_save', { name: name, rate: rate, timeout: timeout });
    if (!r.ok) { showToast('Erro: ' + (r.error || 'falha')); return; }
    closeModal('modal-add-group');
    e.target.reset();
    const gr = await apiGet('groups');
    if (gr.ok) {
        APP_STATE.groups = gr.groups.map(function (g) {
            return { id: g.name, name: g.name, rate: g.rate || '-', timeout: g.timeout || '-', desc: 'radgroupreply' };
        });
        renderGroups();
        refreshGroupSelect(gr.groups);
    }
    showToast('Plano ' + name + ' salvo.');
};

window.deleteGroup = async function (id) {
    const g = APP_STATE.groups.find(function (x) { return String(x.id) === String(id); });
    const name = g ? g.name : id;
    if (!confirm('Excluir o plano ' + name + '? (usuários vinculados perdem o limite do grupo)')) return;
    const r = await apiPost('group_delete', { name: name });
    if (!r.ok) { showToast('Erro: ' + (r.error || 'falha')); return; }
    APP_STATE.groups = APP_STATE.groups.filter(function (x) { return String(x.id) !== String(id); });
    renderGroups();
    showToast('Plano ' + name + ' removido.');
};

window.executeRadtest = async function () {
    const user = document.getElementById('radtest-user').value.trim();
    const pass = document.getElementById('radtest-pass').value;
    const output = document.getElementById('radtest-output');
    const pill = document.getElementById('radtest-status-pill');
    const btn = document.getElementById('btn-run-radtest');
    btn.disabled = true;
    pill.className = 'text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/20 text-amber-300';
    pill.innerText = 'Testando contra 127.0.0.1:1812...';
    output.innerText = 'Access-Request -> 127.0.0.1:1812 (secret testing123)\nUser-Name = "' + user + '"\n';
    try {
        const r = await apiPost('radtest', { user: user, pass: pass });
        if (!r.ok) { pill.innerText = 'Erro'; output.innerText += '\n' + (r.error || 'falha'); }
        else if (r.accept) {
            pill.className = 'text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300';
            pill.innerText = 'Access-Accept (Code 2)';
            output.innerText += '\n' + r.output;
        } else {
            pill.className = 'text-[10px] font-mono px-2 py-0.5 rounded bg-rose-500/20 text-rose-300';
            pill.innerText = 'Access-Reject (Code 3)';
            output.innerText += '\n' + r.output;
        }
    } catch (e) { output.innerText += '\nFalha de rede: ' + e.message; }
    btn.disabled = false;
};

window.sendDisconnectPod = async function (user) {
    if (!confirm('Desconectar (PoD) a sessão de ' + user + '?')) return;
    showToast('Enviando Disconnect-Request...');
    try {
        const r = await apiPost('pod', { username: user });
        showToast(r.ok ? 'Resposta do NAS: ' + (r.output || '(vazia)').substring(0, 80) : 'PoD: ' + (r.error || 'falha'));
    } catch (e) { showToast('PoD: ' + e.message); }
    const ac = await apiGet('accounting', { filter: 'all' });
    if (ac.ok) {
        APP_STATE.sessions = ac.sessions.map(function (s) {
            return { id: s.id, username: s.username, nasIp: s.nasIp, port: s.port, framedIp: s.framedIp, mac: s.mac, duration: s.duration, down: s.down, up: s.up, active: s.active };
        });
        renderAccounting();
    }
};

window.sendRadReload = async function () {
    showToast('Enviando HUP...');
    try {
        const r = await apiPost('reload', {});
        showToast(r.ok ? 'Config recarregada (HUP)!' : 'Falha: ' + (r.output || ''));
    } catch (e) { showToast('Falha: ' + e.message); }
};

window.updateSqlDump = async function () {
    try {
        const [us, nas] = await Promise.all([apiGet('users'), apiGet('nas_list')]);
        let sql = '-- FreeRADIUS MySQL - dump gerado pelo RadiusHub (dados REAIS)\n\n-- Clientes NAS (tabela nas)\n';
        if (nas.ok) nas.nas.forEach(function (n) {
            if (n.source !== 'db') return;
            sql += "INSERT INTO nas (nasname, shortname, type, secret, description) VALUES ('" + n.nasname + "', '" + n.shortname + "', '" + n.type + "', '" + n.secret + "', '" + (n.description || '') + "');\n";
        });
        sql += '\n-- Usuários (radcheck)\n';
        if (us.ok) us.users.forEach(function (u) {
            sql += "INSERT INTO radcheck (username, attribute, op, value) VALUES ('" + u.username + "', '" + u.attribute + "', ':=', '" + u.value + "');\n";
        });
        const dumpArea = document.getElementById('sql-dump-area');
        if (dumpArea) dumpArea.value = sql;
    } catch (e) { /* mantém dump anterior */ }
};

window.renderAccounting = function () {
    const filterEl = document.getElementById('acct-filter');
    const filter = filterEl ? filterEl.value : 'all';
    apiGet('accounting', { filter: filter }).then(function (r) {
        if (!r.ok) return;
        APP_STATE.sessions = r.sessions.map(function (s) {
            return { id: s.id, username: s.username, nasIp: s.nasIp, port: s.port, framedIp: s.framedIp, mac: s.mac, duration: s.duration, down: s.down, up: s.up, active: s.active };
        });
        renderAccountingReal();
        const activeCount = APP_STATE.sessions.filter(function (s) { return s.active; }).length;
        setText('stat-active-sessions', activeCount);
    });
};

/* render real da tabela accounting (mesmo layout do original) */
function renderAccountingReal() {
    const tbody = document.getElementById('accounting-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    APP_STATE.sessions.forEach(function (sess) {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-slate-800/40 transition';
        tr.innerHTML =
            '<td class="py-3 px-4 text-slate-400 font-mono text-[11px]">' + esc(sess.id) + '</td>' +
            '<td class="py-3 px-4 text-white font-medium">' + esc(sess.username) + '</td>' +
            '<td class="py-3 px-4 text-slate-400">' + esc(sess.nasIp) + ' <span class="text-slate-500 text-[10px]">(' + esc(sess.port) + ')</span></td>' +
            '<td class="py-3 px-4"><div class="text-emerald-400">' + esc(sess.framedIp) + '</div><div class="text-[10px] text-slate-500">' + esc(sess.mac) + '</div></td>' +
            '<td class="py-3 px-4 text-slate-300">' + esc(sess.duration) + '</td>' +
            '<td class="py-3 px-4 text-slate-300 whitespace-nowrap"><span class="text-emerald-400">&darr; ' + esc(sess.down) + '</span> / <span class="text-cyan-400">&uarr; ' + esc(sess.up) + '</span></td>' +
            '<td class="py-3 px-4"><span class="px-2 py-0.5 text-[10px] font-semibold rounded ' + (sess.active ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-slate-400') + '">' + (sess.active ? 'ONLINE' : 'STOPPED') + '</span></td>' +
            '<td class="py-3 px-4 text-right">' + (sess.active
                ? '<button onclick="sendDisconnectPod(\'' + esc(sess.username).replace(/'/g, "\\'") + '\')" class="px-2.5 py-1 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 text-[11px] border border-rose-500/20 transition active:scale-95">PoD Disconnect</button>'
                : '<span class="text-slate-600 text-xs">-</span>') + '</td>';
        tbody.appendChild(tr);
    });
}
window.renderAccountingReal = renderAccountingReal;

async function refreshLogs() {
    if (APP_STATE.isLogPaused) return;
    const view = document.getElementById('view-raw-logs');
    if (view && view.classList.contains('hidden')) return;
    try {
        const r = await apiGet('logs', { lines: 150 });
        if (!r.ok) return;
        const term = document.getElementById('terminal-logs');
        if (!term) return;
        term.innerHTML = r.lines.map(function (ln) {
            let c = 'text-slate-300';
            if (/Login OK|Access-Accept/.test(ln)) c = 'text-emerald-400';
            else if (/Login incorrect|Access-Reject|Error/.test(ln)) c = 'text-rose-400';
            else if (/Info/.test(ln)) c = 'text-slate-500';
            return '<div class="' + c + '">' + esc(ln) + '</div>';
        }).join('');
        term.scrollTop = term.scrollHeight;
    } catch (e) { /* próxima tentativa */ }
}

/* polls */
setInterval(refreshLogs, 4000);
setInterval(function () {
    const view = document.getElementById('view-accounting');
    if (view && !view.classList.contains('hidden')) window.renderAccounting();
}, 12000);

window.addEventListener('DOMContentLoaded', function () { setTimeout(bootReal, 50); });

})();

/* ===== PATCH 2: botoes de usuario corrigidos + tempo real ===== */
(function () {
'use strict';
const apiGet = window.apiGet, apiPost = window.apiPost, setText = window.setText, esc = window.esc;

function jsq(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

/* renderUsers corrigido: ids entre aspas + botao Editar */
window.renderUsers = function (list) {
    list = list || APP_STATE.users;
    const tbody = document.getElementById('users-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    list.forEach(function (user) {
        const qid = "'" + jsq(user.id) + "'";
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-slate-800/40 transition';
        tr.innerHTML =
            '<td class="py-3 px-4 font-mono font-medium text-white flex items-center gap-2">' +
                '<div class="h-2 w-2 rounded-full shrink-0 ' + (user.status === 'active' ? 'bg-emerald-400' : 'bg-slate-600') + '"></div>' +
                '<span class="truncate max-w-[120px] sm:max-w-none">' + esc(user.username) + '</span></td>' +
            '<td class="py-3 px-4 font-mono text-slate-400"><span class="text-[11px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">' + esc(user.attribute) + '</span></td>' +
            '<td class="py-3 px-4"><span class="px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">' + esc(user.group || 'Sem grupo') + '</span></td>' +
            '<td class="py-3 px-4 font-mono text-slate-400">' + (user.framedIp || '<span class="text-slate-600">Dinâmico</span>') + '</td>' +
            '<td class="py-3 px-4"><span class="px-2 py-0.5 text-[10px] font-semibold uppercase rounded ' + (user.status === 'active' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300') + '">' + (user.status === 'active' ? 'Ativo' : 'Bloqueado') + '</span></td>' +
            '<td class="py-3 px-4 text-right space-x-1 sm:space-x-2">' +
                '<button onclick="testUserDirect(\'' + jsq(user.username) + '\')" title="Testar no radtest" class="p-1.5 rounded-lg hover:bg-slate-800 text-emerald-400 transition inline-block"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg></button>' +
                '<button onclick="editUser(' + qid + ')" title="Editar" class="p-1.5 rounded-lg hover:bg-slate-800 text-cyan-400 transition inline-block"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg></button>' +
                '<button onclick="toggleUserStatus(' + qid + ')" title="' + (user.status === 'active' ? 'Desabilitar' : 'Habilitar') + '" class="p-1.5 rounded-lg hover:bg-slate-800 text-amber-400 transition inline-block"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/></svg></button>' +
                '<button onclick="deleteUser(' + qid + ')" title="Excluir" class="p-1.5 rounded-lg hover:bg-slate-800 text-rose-400 transition inline-block"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg></button>' +
            '</td>';
        tbody.appendChild(tr);
    });
    setText('badge-users-count', APP_STATE.users.length);
    setText('stat-total-users', APP_STATE.users.length);
    updateSqlDump();
};

/* editar: abre o modal preenchido */
window.editUser = function (id) {
    const u = APP_STATE.users.find(function (x) { return String(x.id) === String(id); });
    if (!u) { showToast('Usuário não encontrado'); return; }
    document.getElementById('form-user-name').value = u.username;
    document.getElementById('form-user-attr').value = u.attribute || 'Cleartext-Password';
    document.getElementById('form-user-pass').value = u.value || '';
    document.getElementById('form-user-group').value = u.group || '';
    document.getElementById('form-user-ip').value = u.framedIp || '';
    document.getElementById('form-user-simultaneous').value = u.simultaneous || 1;
    openModal('modal-add-user');
};

/* salvar preservando status atual (nao reabilita sem querer) */
window.handleSaveUser = async function (e) {
    e.preventDefault();
    const username = document.getElementById('form-user-name').value.trim();
    const cur = APP_STATE.users.find(function (x) { return x.username === username; });
    const r = await apiPost('user_save', {
        username: username,
        attribute: document.getElementById('form-user-attr').value,
        password: document.getElementById('form-user-pass').value,
        group: document.getElementById('form-user-group').value,
        framedIp: document.getElementById('form-user-ip').value.trim(),
        simultaneous: parseInt(document.getElementById('form-user-simultaneous').value) || 1,
        status: cur ? cur.status : 'active'
    });
    if (!r.ok) { showToast('Erro: ' + (r.error || 'falha ao salvar')); return; }
    showToast('Usuário ' + username + ' salvo no MySQL!');
    closeModal('modal-add-user');
    e.target.reset();
    const us = await apiGet('users');
    if (us.ok) {
        APP_STATE.users = us.users.map(function (u) {
            return { id: u.username, username: u.username, attribute: u.attribute, op: ':=', value: u.value, group: u.group, framedIp: u.framedIp, simultaneous: u.simultaneous, status: u.status };
        });
        renderUsers();
    }
};

/* habilitar/desabilitar COM confirmacao; desabilitar derruba sessoes ativas */
window.toggleUserStatus = async function (id) {
    const u = APP_STATE.users.find(function (x) { return String(x.id) === String(id); });
    if (!u) return;
    const disabling = u.status === 'active';
    const msg = disabling
        ? 'BLOQUEAR ' + u.username + '?\n\nEle não conseguirá mais autenticar E as sessões ativas serão derrubadas na hora (PoD).'
        : 'REABILITAR ' + u.username + '? Ele voltará a autenticar normalmente.';
    if (!confirm(msg)) return;
    const r = await apiPost('user_save', { username: u.username, attribute: u.attribute, password: u.value, group: u.group, framedIp: u.framedIp, simultaneous: u.simultaneous, status: disabling ? 'disabled' : 'active' });
    if (!r.ok) { showToast('Erro: ' + (r.error || 'falha')); return; }
    u.status = disabling ? 'disabled' : 'active';
    renderUsers();
    if (disabling) {
        showToast(u.username + ' BLOQUEADO. Derrubando sessões ativas...');
        try {
            const pod = await apiPost('pod', { username: u.username });
            showToast(pod.ok ? 'Sessões de ' + u.username + ' derrubadas.' : 'Bloqueado (sem sessão ativa p/ derrubar).');
        } catch (e) { showToast('Bloqueado. PoD: ' + e.message); }
        window.renderAccounting();
    } else {
        showToast(u.username + ' reabilitado.');
    }
};

/* ---------- tráfego em tempo real (SNMP) + online agora ---------- */
const liveHist = { labels: [], down: [], up: [] };

function initLiveChart() {
    const cv = document.getElementById('liveTrafficChart');
    if (!cv || typeof Chart === 'undefined' || window.liveChart) return;
    window.liveChart = new Chart(cv.getContext('2d'), {
        type: 'line',
        data: { labels: [], datasets: [
            { label: 'Download (Mbps)', data: [], borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.08)', fill: true, tension: 0.35, borderWidth: 2, pointRadius: 0 },
            { label: 'Upload (Mbps)', data: [], borderColor: '#06b6d4', backgroundColor: 'transparent', tension: 0.35, borderWidth: 2, pointRadius: 0 }
        ]},
        options: { responsive: true, maintainAspectRatio: false,
            plugins: { legend: { labels: { color: '#94a3b8', font: { size: 10 } } } },
            scales: { x: { grid: { color: '#1e293b' }, ticks: { color: '#64748b', font: { size: 9 } } },
                      y: { grid: { color: '#1e293b' }, ticks: { color: '#64748b', font: { size: 9 } }, beginAtZero: true } },
            animation: false }
    });
}

async function tickTraffic() {
    const view = document.getElementById('view-dashboard');
    if (!view || view.classList.contains('hidden')) return;
    const stEl = document.getElementById('snmp-status');
    let r;
    try { r = await apiGet('snmp_traffic'); }
    catch (e) { if (stEl) { stEl.innerText = 'falha de rede'; stEl.className = 'text-xs font-mono text-rose-400'; } return; }
    if (!r.ok) {
        if (stEl) { stEl.innerText = 'SNMP off — /snmp set enabled=yes no RouterOS'; stEl.className = 'text-xs font-mono text-amber-300'; }
        return;
    }
    if (stEl) { stEl.innerText = 'LIVE • ' + r.total_down.toFixed(1) + '↓ / ' + r.total_up.toFixed(1) + '↑ Mbps'; stEl.className = 'text-xs font-mono text-emerald-400'; }
    const now = new Date().toTimeString().split(' ')[0];
    liveHist.labels.push(now); liveHist.down.push(r.total_down); liveHist.up.push(r.total_up);
    if (liveHist.labels.length > 40) { liveHist.labels.shift(); liveHist.down.shift(); liveHist.up.shift(); }
    if (window.liveChart) {
        window.liveChart.data.labels = liveHist.labels.slice();
        window.liveChart.data.datasets[0].data = liveHist.down.slice();
        window.liveChart.data.datasets[1].data = liveHist.up.slice();
        window.liveChart.update();
    }
    const box = document.getElementById('live-rates');
    if (box) {
        if (!r.users.length) { box.innerHTML = '<p class="text-xs text-slate-500">Nenhuma interface PPPoE com tráfego no momento.</p>'; }
        else {
            const max = Math.max.apply(null, r.users.map(function (x) { return x.down + x.up; }).concat([0.01]));
            box.innerHTML = r.users.slice(0, 8).map(function (x) {
                const pct = Math.round(100 * (x.down + x.up) / max);
                return '<div class="text-xs font-mono"><div class="flex justify-between text-slate-300"><span class="truncate">' + esc(x.user) + '</span>' +
                    '<span><span class="text-emerald-400">↓ ' + x.down.toFixed(1) + '</span> <span class="text-cyan-400">↑ ' + x.up.toFixed(1) + '</span> <span class="text-slate-500">Mb</span></span></div>' +
                    '<div class="h-1 mt-1 rounded bg-slate-800"><div class="h-1 rounded bg-emerald-500" style="width:' + pct + '%"></div></div></div>';
            }).join('');
        }
    }
    const on = document.getElementById('online-now-list');
    if (on) {
        if (!r.online.length) { on.innerHTML = '<p class="text-xs text-slate-500">Ninguém online.</p>'; }
        else {
            on.innerHTML = r.online.map(function (o) {
                return '<div class="flex items-center justify-between text-xs bg-slate-800/40 border border-slate-800 rounded-xl px-3 py-2">' +
                    '<div><div class="text-white font-medium font-mono">' + esc(o.user) + '</div><div class="text-slate-500 font-mono">' + esc(o.ip) + ' • ' + esc(o.dur) + '</div></div>' +
                    '<span class="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span></div>';
            }).join('');
        }
    }
}

setInterval(tickTraffic, 3000);
window.addEventListener('DOMContentLoaded', function () { setTimeout(function () { initLiveChart(); tickTraffic(); }, 300); });

})();
