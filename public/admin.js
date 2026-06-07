// =============================================================================
// admin.js — клиент админ-панели LinkTime
// Token-auth через X-Admin-Token. Список юзеров, поиск, восстановление, удаление.
// =============================================================================

(function () {
  'use strict';

  let TOKEN = sessionStorage.getItem('lt_admin_token') || '';
  let users = [];
  let sortKey = 'lastUpdate';
  let sortDir = -1;

  const $ = id => document.getElementById(id);

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'X-Admin-Token': TOKEN }, opts.headers || {});
    return fetch('/api/admin' + path, opts);
  }

  function toast(msg, kind) {
    const t = $('toast');
    t.textContent = msg;
    t.className = (kind || '') + ' show';
    setTimeout(() => { t.className = t.className.replace('show', '').trim(); }, 2500);
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function fmtMs(ms) {
    if (!ms) return '0м';
    const m = Math.floor(ms / 60000);
    if (m < 60) return m + 'м';
    const h = Math.floor(m / 60);
    return h + 'ч ' + (m % 60) + 'м';
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const now = Date.now();
    const diff = now - ts;
    if (diff < 60000) return 'только что';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' мин назад';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' ч назад';
    if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + ' дн назад';
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: '2-digit' });
  }

  function copy(text) {
    navigator.clipboard.writeText(text).then(
      () => toast('Скопировано: ' + text.slice(0, 20) + '…', 'ok'),
      () => toast('Не удалось скопировать', 'error')
    );
  }

  // === AUTH ===
  async function tryLogin(token) {
    TOKEN = token;
    const res = await api('/check');
    if (res.ok) {
      sessionStorage.setItem('lt_admin_token', token);
      $('gate').classList.add('hidden');
      $('app').classList.add('visible');
      loadAll();
      return true;
    }
    return false;
  }

  $('loginBtn').addEventListener('click', async () => {
    const t = $('tokenInput').value.trim();
    if (!t) return;
    const ok = await tryLogin(t);
    if (!ok) $('gateErr').textContent = 'Неверный токен';
  });
  $('tokenInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('loginBtn').click();
  });

  $('logoutBtn').addEventListener('click', () => {
    sessionStorage.removeItem('lt_admin_token');
    location.reload();
  });

  $('refreshBtn').addEventListener('click', loadAll);

  $('backupBtn').addEventListener('click', async () => {
    $('backupBtn').disabled = true;
    try {
      const res = await api('/backup', { method: 'POST' });
      const d = await res.json();
      if (d.ok) toast('Бэкап создан: ' + d.file, 'ok');
      else toast('Ошибка бэкапа', 'error');
    } catch (e) { toast('Ошибка соединения', 'error'); }
    $('backupBtn').disabled = false;
  });

  // === LOAD ===
  async function loadAll() {
    try {
      const [statsRes, usersRes] = await Promise.all([api('/stats'), api('/users')]);
      if (statsRes.ok) renderStats(await statsRes.json());
      if (usersRes.ok) {
        const d = await usersRes.json();
        users = d.users || [];
        renderTable();
      }
    } catch (e) {
      toast('Ошибка загрузки', 'error');
    }
  }

  function renderStats(s) {
    const mb = s.dbBytes ? (s.dbBytes / 1048576).toFixed(1) + ' MB' : '—';
    $('stats').innerHTML = [
      ['Пользователей', s.users, 'accent'],
      ['Сессий', s.sessions, ''],
      ['Проектов', s.projects, ''],
      ['Задач', s.tasks, ''],
      ['Команд', s.teams, ''],
      ['Размер БД', mb, ''],
      ['Схема', 'v' + s.schemaVersion, ''],
    ].map(([l, v, cls]) =>
      '<div class="stat"><div class="stat-l">' + l + '</div><div class="stat-v ' + cls + '">' + esc(v) + '</div></div>'
    ).join('');
  }

  function renderTable() {
    const q = $('search').value.trim().toLowerCase();
    let filtered = users;
    if (q) {
      filtered = users.filter(u =>
        (u.username || '').toLowerCase().includes(q) ||
        (u.userId || '').toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q) ||
        (u.sessionKey || '').toLowerCase().includes(q)
      );
    }
    filtered = filtered.slice().sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      if (typeof av === 'string') { av = (av || '').toLowerCase(); bv = (bv || '').toLowerCase(); }
      av = av == null ? -Infinity : av; bv = bv == null ? -Infinity : bv;
      return av < bv ? sortDir : av > bv ? -sortDir : 0;
    });

    $('countBadge').textContent = q ? (filtered.length + ' из ' + users.length) : (users.length + ' юзеров');

    const rows = $('rows');
    if (!filtered.length) {
      rows.innerHTML = '';
      $('emptyState').style.display = '';
      $('emptyState').textContent = q ? 'Ничего не найдено' : 'Нет пользователей';
      return;
    }
    $('emptyState').style.display = 'none';

    rows.innerHTML = filtered.map(u => {
      const teamBadge = u.teams && u.teams.length
        ? ' <span style="color:var(--info);font-size:10px">' + u.teams.map(t => t.role === 'owner' ? '👑' : '👥').join('') + '</span>'
        : '';
      return '<tr data-uid="' + esc(u.userId) + '">' +
        '<td><span class="u-name">' + esc(u.username || '—') + '</span>' + teamBadge + '</td>' +
        '<td><span class="u-id">' + esc(u.userId) + '</span></td>' +
        '<td>' + (u.email
          ? '<span class="u-email">' + esc(u.email) + '</span>'
          : '<span class="u-email none">нет</span>') + '</td>' +
        '<td class="u-num">' + u.taskCount + '</td>' +
        '<td class="u-num">' + u.workDays + '</td>' +
        '<td class="u-num u-time">' + fmtMs(u.totalWorkMs) + '</td>' +
        '<td>' + fmtDate(u.lastUpdate) + '</td>' +
        '<td><span class="u-key" data-copy="' + esc(u.sessionKey) + '" title="Кликни чтобы скопировать">' + esc(u.sessionKey) + '</span></td>' +
        '<td><div class="row-actions">' +
          '<button class="icon-btn copy" data-act="copy-key" title="Скопировать ключ доступа">' +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
          '</button>' +
          '<button class="icon-btn" data-act="view" title="Подробности">' +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' +
          '</button>' +
          '<button class="icon-btn danger" data-act="delete" title="Удалить пользователя">' +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
          '</button>' +
        '</div></td>' +
      '</tr>';
    }).join('');
  }

  // Table interactions
  $('rows').addEventListener('click', async (e) => {
    const keySpan = e.target.closest('.u-key[data-copy]');
    if (keySpan) { copy(keySpan.dataset.copy); return; }

    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const tr = btn.closest('tr');
    const uid = tr.dataset.uid;
    const user = users.find(u => u.userId === uid);
    if (!user) return;

    if (btn.dataset.act === 'copy-key') {
      copy(user.sessionKey);
    } else if (btn.dataset.act === 'view') {
      openDetail(uid);
    } else if (btn.dataset.act === 'delete') {
      if (!confirm('Удалить пользователя ' + (user.username || uid) + ' и ВСЕ его данные? Необратимо.')) return;
      const res = await api('/user/' + encodeURIComponent(uid), { method: 'DELETE' });
      if (res.ok) { toast('Удалён: ' + (user.username || uid), 'ok'); loadAll(); }
      else toast('Ошибка удаления', 'error');
    }
  });

  // Sort
  document.querySelectorAll('.tbl th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (sortKey === k) sortDir = -sortDir;
      else { sortKey = k; sortDir = (k === 'username' || k === 'email' || k === 'userId') ? 1 : -1; }
      renderTable();
    });
  });

  $('search').addEventListener('input', renderTable);

  // Detail modal
  async function openDetail(uid) {
    const res = await api('/user/' + encodeURIComponent(uid));
    if (!res.ok) { toast('Не загрузилось', 'error'); return; }
    const d = await res.json();
    $('detailTitle').textContent = d.user.username || uid;
    const sessionsCount = Object.keys(d.sessions || {}).length;
    $('detailBody').innerHTML =
      '<div class="kv"><b>userId</b><span>' + esc(d.user.userId) + '</span></div>' +
      '<div class="kv"><b>sessionKey</b><span>' + esc(d.user.sessionKey) + '</span></div>' +
      '<div class="kv"><b>email</b><span>' + esc(d.user.email || 'нет') + '</span></div>' +
      '<div class="kv"><b>создан</b><span>' + new Date(d.user.createdAt).toLocaleString('ru-RU') + '</span></div>' +
      '<div class="kv"><b>проектов</b><span>' + (d.projects || []).length + '</span></div>' +
      '<div class="kv"><b>задач</b><span>' + (d.tasks || []).length + '</span></div>' +
      '<div class="kv"><b>дней с работой</b><span>' + sessionsCount + '</span></div>' +
      '<h1 style="font-size:14px;margin:18px 0 8px;color:var(--txt-dim)">Рабочие сессии (raw)</h1>' +
      '<pre>' + esc(JSON.stringify(d.sessions, null, 2).slice(0, 4000)) + '</pre>';
    $('detail').classList.add('open');
  }
  $('detailClose').addEventListener('click', () => $('detail').classList.remove('open'));
  $('detail').addEventListener('click', e => { if (e.target.id === 'detail') $('detail').classList.remove('open'); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('detail').classList.remove('open'); });

  // Auto-login if token saved
  if (TOKEN) {
    tryLogin(TOKEN).then(ok => { if (!ok) { TOKEN = ''; sessionStorage.removeItem('lt_admin_token'); } });
  } else {
    $('tokenInput').focus();
  }
})();
