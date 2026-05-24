// =============================================================================
// dashboard-init.js — все inline-IIFE из index.html, вынесенные сюда
// чтобы CSP можно было ужать до script-src 'self' (без unsafe-inline).
// Сгенерировано install/security рефактором Phase 6.7.
// =============================================================================

// ===== BLOCK 1 (раньше был inline после загрузки app.js) =====
// Конфигурация: в Electron preload.js выставляет window._linkTimeConfig
// с фактическим WS_URL (агент знает куда коннектиться). В web — берём с location.host.
window._config = (window._linkTimeConfig && window._linkTimeConfig.wsUrl)
  ? { wsUrl: window._linkTimeConfig.wsUrl, apiBase: window._linkTimeConfig.apiBase }
  : { wsUrl: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host };

// === Global data-action delegation ===
// Заменяет inline onclick="..." (которые блокирует жёсткий CSP).
// Все статические кнопки в HTML используют data-action="..."; здесь маппинг.
(function initGlobalActions() {
    // Утилита: записать в clipboard + флешнуть кнопку
    async function copyText(text, btn) {
        if (!text) return false;
        try {
            await navigator.clipboard.writeText(text);
        } catch (e) {
            // Фолбэк через временный textarea
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch (_) {}
            document.body.removeChild(ta);
        }
        if (btn) {
            btn.classList.add('copied');
            const span = btn.querySelector('span');
            const original = span ? span.textContent : null;
            if (span) span.textContent = 'Скопировано';
            setTimeout(() => {
                btn.classList.remove('copied');
                if (span && original) span.textContent = original;
            }, 1500);
        }
        if (window.showToast) window.showToast('Скопировано в буфер', 'success');
        return true;
    }

    const handlers = {
        'export-csv':  () => window.exportCSV && window.exportCSV(),
        'export-json': () => window.exportJSON && window.exportJSON(),
        'import-json': () => window.importJSON && window.importJSON(),
        'pick-avatar': () => {
            const input = document.getElementById('avatarInput');
            if (input) input.click();
        },
        'copy-user-id': (btn) => {
            const id = document.getElementById('profileUserId');
            if (id) copyText(id.textContent.trim(), btn);
        },
        'copy-share-id': (btn) => {
            const id = document.getElementById('inviteShareId');
            if (id) copyText(id.textContent.trim(), btn);
        },
        'edit-username': () => window.toggleProfileEdit && window.toggleProfileEdit('username', true),
        'edit-email':    () => window.toggleProfileEdit && window.toggleProfileEdit('email', true),
        'cancel-edit-username': () => window.toggleProfileEdit && window.toggleProfileEdit('username', false),
        'cancel-edit-email':    () => window.toggleProfileEdit && window.toggleProfileEdit('email', false),
        'delete-account': async () => {
            // Двойное подтверждение — действие необратимое
            const c1 = confirm(
                'Удалить аккаунт ПОЛНОСТЬЮ?\n\n' +
                'Будут удалены: все задачи, проекты, доски, аватар, участие в командах.\n' +
                'Это действие НЕЛЬЗЯ отменить.'
            );
            if (!c1) return;
            const c2 = prompt('Введите слово УДАЛИТЬ заглавными чтобы подтвердить:', '');
            if (c2 !== 'УДАЛИТЬ') {
                if (window.showToast) window.showToast('Удаление отменено', 'info');
                return;
            }
            try {
                const sk = (typeof state !== 'undefined' && state.sessionKey) || localStorage.getItem('sessionKey');
                if (!sk) throw new Error('no sessionKey');
                const base = (window._config && window._config.apiBase) || '';
                const res = await fetch(base + '/api/account/' + encodeURIComponent(sk), {
                    method: 'DELETE',
                    headers: { 'Authorization': 'Bearer ' + sk }
                });
                const data = await res.json().catch(() => ({}));
                if (res.ok && data.ok) {
                    // Чистим клиент полностью и перезагружаем
                    try {
                        localStorage.clear();
                        sessionStorage.clear();
                        if ('caches' in window) {
                            const keys = await caches.keys();
                            await Promise.all(keys.map(k => caches.delete(k)));
                        }
                        if ('serviceWorker' in navigator) {
                            const regs = await navigator.serviceWorker.getRegistrations();
                            await Promise.all(regs.map(r => r.unregister()));
                        }
                    } catch (_) {}
                    alert('Аккаунт удалён. Страница перезагрузится — будет создан новый профиль.');
                    location.reload();
                } else {
                    alert('Не получилось удалить: ' + (data.error || res.status));
                }
            } catch (e) {
                alert('Ошибка соединения: ' + e.message);
            }
        },
    };
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const fn = handlers[btn.dataset.action];
        if (fn) { e.preventDefault(); fn(btn); }
        // Если экшен не в этом списке — динамические delegators в app.js обработают
    });
})();

// === Electron mode setup ===
// Marks <body> with .is-electron so CSS shows window controls and makes header draggable.
// Hooks min/max/close buttons to the electronAPI exposed by preload.
(function initElectronMode() {
    const isElectron = !!(window.electronAPI && window.electronAPI.isElectron)
                    || !!(window._linkTimeConfig && window._linkTimeConfig.isElectron);
    if (!isElectron) return;
    document.body.classList.add('is-electron');
    window.__electronApp = true;

    const ctl = document.getElementById('windowControls');
    if (ctl) ctl.style.display = 'flex';

    const $ = id => document.getElementById(id);
    $('winMinimize')?.addEventListener('click', () => window.electronAPI?.minimize());
    $('winMaximize')?.addEventListener('click', () => window.electronAPI?.maximize());
    $('winClose')?.addEventListener('click', () => window.electronAPI?.closeWindow());

    // Toggle .is-maximized on body so the icon swaps between max/restore
    if (window.electronAPI?.onMaximizeChange) {
        window.electronAPI.onMaximizeChange((isMax) => {
            document.body.classList.toggle('is-maximized', !!isMax);
        });
    }

    // === Board mini-titlebar (показывается когда открыта доска) ===
    $('boardTitlebarBack')?.addEventListener('click', () => {
        if (typeof window.closeBoardOverlay === 'function') window.closeBoardOverlay();
    });
    $('boardWinMin')?.addEventListener('click', () => window.electronAPI?.minimize());
    $('boardWinMax')?.addEventListener('click', () => window.electronAPI?.maximize());
    $('boardWinClose')?.addEventListener('click', () => window.electronAPI?.closeWindow());
})();

// === Service Worker registration ===
// Skip in Electron (own update mechanism) and in non-https contexts when not localhost.
(function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (window.__electronApp) return;
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => {
            // Listen for an updated SW
            reg.addEventListener('updatefound', () => {
                const next = reg.installing;
                if (!next) return;
                next.addEventListener('statechange', () => {
                    if (next.state === 'installed' && navigator.serviceWorker.controller) {
                        // New version waiting — show subtle toast
                        if (window.showToast) window.showToast('Доступно обновление — обновите страницу', 'info');
                    }
                });
            });
        }).catch(() => {});
    });
})();

// === Keyboard shortcuts ===
// Space        — start / pause toggle
// S            — open settings
// B            — open board
// /            — focus search
// Esc          — close topmost modal
// ?            — show shortcut hint toast
(function keyboardShortcuts() {
    function isTyping(el) {
        if (!el) return false;
        const tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    }

    function topOpenModal() {
        const list = document.querySelectorAll('.modal.active, .card-modal.open, .board-overlay.open');
        return list[list.length - 1] || null;
    }

    // Special-case: the iframe-style overlay #board-overlay (note: id, not class .board-overlay)
    function iframeBoardOpen() {
        const el = document.getElementById('board-overlay');
        return el && el.style.display !== 'none' && el.style.display !== '' ? el : null;
    }

    function findCloseButton(modal) {
        return modal.querySelector('.close-btn, .board-close-btn, #closeSettings, #closeProfile, #closeInvite, #closeShareTime, #boardCloseBtn, #cardModalClose, #kickConfirmClose');
    }

    let hintShown = false;
    function showHintOnce() {
        if (hintShown) return;
        if (window.showToast) {
            window.showToast('Space — старт/пауза · S — настройки · B — доска · / — поиск', 'info');
        }
        hintShown = true;
    }

    document.addEventListener('keydown', (e) => {
        const k = e.key;
        const mod = e.ctrlKey || e.metaKey;
        const typing = isTyping(document.activeElement);

        // Esc — always closes topmost modal (including iframe board overlay)
        if (k === 'Escape') {
            const iframeBoard = iframeBoardOpen();
            if (iframeBoard) {
                if (typeof window.closeBoardOverlay === 'function') window.closeBoardOverlay();
                else iframeBoard.style.display = 'none';
                e.preventDefault();
                return;
            }
            const m = topOpenModal();
            if (m) {
                const btn = findCloseButton(m);
                if (btn) { btn.click(); e.preventDefault(); }
            }
            return;
        }

        // Cmd/Ctrl + K — open search (global)
        if (mod && k.toLowerCase() === 'k') {
            e.preventDefault();
            document.getElementById('headerSearch')?.click();
            return;
        }

        // ? — hint
        if (k === '?' && !typing) {
            e.preventDefault();
            showHintOnce();
            return;
        }

        // Skip remaining if user is typing
        if (typing) return;

        switch (k) {
            case ' ': {
                e.preventDefault();
                // Smart toggle: if not running → start, if running → pause toggle
                const startBtn = document.getElementById('startBtn');
                const pauseBtn = document.getElementById('pauseBtn');
                if (startBtn && !startBtn.disabled) {
                    startBtn.click();
                } else if (pauseBtn && !pauseBtn.disabled) {
                    pauseBtn.click();
                }
                break;
            }
            case 's': case 'S':
                e.preventDefault();
                document.getElementById('burgerSettings')?.click();
                break;
            case 'b': case 'B':
                e.preventDefault();
                document.getElementById('boardBtn')?.click();
                break;
            case '/':
                e.preventDefault();
                document.getElementById('headerSearch')?.click();
                break;
        }
    });

    // Show hint after 8s of using the app (only once per session)
    setTimeout(showHintOnce, 8000);
})();

// === Online/offline indicator ===
(function networkStatus() {
    function applyOnline() {
        document.body.classList.toggle('is-offline', !navigator.onLine);
    }
    window.addEventListener('online', () => {
        applyOnline();
        if (window.showToast) window.showToast('Связь восстановлена', 'success');
    });
    window.addEventListener('offline', () => {
        applyOnline();
        if (window.showToast) window.showToast('Работаем без сети — данные синхронизируются позже', 'info');
    });
    applyOnline();
})();

// ===== BLOCK 2 (раньше был inline в конце body) =====
// === SIDEBAR NAVIGATION — strict single-tab visibility ===
(function initSidebar() {
  const sidebarItems = document.querySelectorAll('[data-sidebar-tab]');
  const sections = document.querySelectorAll('[data-tab-content]');
  const headerTitle = document.querySelector('header h1');
  const tabNames = { timer: 'Дашборд', tasks: 'Задачи', calendar: 'Календарь' };

  function switchSidebarTab(tabName) {
    sidebarItems.forEach(item => {
      item.classList.toggle('active', item.dataset.sidebarTab === tabName);
    });
    // Strict: show ONLY the section matching the tab. No special-case for 'timer'.
    sections.forEach(sec => {
      sec.style.display = sec.dataset.tabContent === tabName ? '' : 'none';
    });
    if (headerTitle && tabNames[tabName]) {
      headerTitle.textContent = tabNames[tabName];
    }
    // Mirror to mobile bottom nav
    document.querySelectorAll('.mobile-nav-item').forEach(it => {
      it.classList.toggle('active', it.dataset.tab === tabName);
    });
  }

  sidebarItems.forEach(item => {
    item.addEventListener('click', () => switchSidebarTab(item.dataset.sidebarTab));
  });
  // Mobile nav: data-tab buttons switch view; action buttons open overlays
  document.querySelectorAll('.mobile-nav-item[data-tab]').forEach(item => {
    item.addEventListener('click', () => switchSidebarTab(item.dataset.tab));
  });
  // Mobile board shortcut — triggers the existing boardBtn click
  const mobBoard = document.getElementById('mobileBoardBtn');
  if (mobBoard) mobBoard.addEventListener('click', () => document.getElementById('boardBtn')?.click());
  // Mobile settings shortcut — triggers settings modal
  const mobSettings = document.getElementById('mobileSettingsBtn');
  if (mobSettings) mobSettings.addEventListener('click', () => document.getElementById('burgerSettings')?.click());

  // Initial render: enforce visibility for the default 'timer' tab
  switchSidebarTab('timer');

  // Mobile sidebar toggle via burger
  const burgerBtn = document.getElementById('burgerBtn');
  const sidebar = document.getElementById('sidebar');
  if (burgerBtn && sidebar) {
    burgerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      sidebar.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (sidebar.classList.contains('open') && !sidebar.contains(e.target)) {
        sidebar.classList.remove('open');
      }
    });
  }
})();

// === LOADING SCREEN ===
(function initLoading() {
  const loader = document.getElementById('loadingScreen');
  if (!loader) return;
  window.addEventListener('load', () => {
    setTimeout(() => {
      loader.classList.add('fade-out');
      setTimeout(() => loader.remove(), 400);
    }, 1200);
  });
})();

// === PROJECT TREE ===
(function initProjectTree() {
  const tree = document.getElementById('ptTree');
  if (!tree) return;

  const addBtn = document.getElementById('ptAddBtn');
  const addDropdown = document.getElementById('ptAddDropdown');
  const addProjectOpt = document.getElementById('ptAddProject');
  const addTaskOpt = document.getElementById('ptAddTask');
  const createBox = document.getElementById('ptCreate');
  const createInput = document.getElementById('ptCreateInput');
  const createSave = document.getElementById('ptCreateSave');
  const createCancel = document.getElementById('ptCreateCancel');
  const orphanSection = document.getElementById('ptOrphanSection');
  const orphanList = document.getElementById('ptOrphanList');

  const sessionKey = localStorage.getItem('sessionKey') || 'default';
  let projects = [];
  let tasks = [];
  let createMode = null;
  let createProjectId = null;
  let openProjects = JSON.parse(localStorage.getItem('pt_open') || '{}');
  const colors = ['#ff6b1f','#ec4899','#f59e0b','#10b981','#06b6d4','#7fb069','#c1440e','#8aa7c8'];

  async function api(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    // Use explicit apiBase in Electron (file://), fallback to relative on the web
    const base = (window._config && window._config.apiBase) ? window._config.apiBase : '';
    const res = await fetch(base + '/api/' + path, opts);
    return res.json();
  }

  async function loadData() {
    try {
      const data = await api('GET', 'projects/' + sessionKey);
      projects = data.projects || [];
      tasks = data.tasks || [];
      window._ptData = { projects, tasks };
    } catch (e) {
      projects = []; tasks = [];
      window._ptData = { projects: [], tasks: [] };
    }
    render();
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // Track last completion time for elapsed calc
  var lastCheckTime = null;
  var trackedTimerStart = null; // tracks which timer session we're in

  function fmtDur(ms) {
    if (!ms || ms <= 0) return '';
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + 'с';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'м ' + (s % 60) + 'с';
    var h = Math.floor(m / 60);
    return h + 'ч ' + (m % 60) + 'м';
  }

  function fmtDate(d) {
    if (!d) return '';
    var today = new Date().toISOString().slice(0,10);
    if (d === today) return 'Сегодня';
    var parts = d.split('-');
    var months = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
    return +parts[2] + ' ' + months[+parts[1]-1];
  }

  function renderTask(t, i) {
    var timeHtml = t.time_spent ? '<span class="pt-task-time">' + fmtDur(t.time_spent) + '</span>' : '';
    var dateHtml = '';
    if (t.due_date) {
      var isOverdue = !t.completed && t.due_date < new Date().toISOString().slice(0,10);
      dateHtml = '<span class="pt-task-date' + (isOverdue ? ' overdue' : '') + '">' + fmtDate(t.due_date) + '</span>';
    }
    return '<div class="pt-task' + (t.completed ? ' done' : '') + '" data-task-id="' + t.id + '">' +
      '<button class="pt-task-check"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></button>' +
      '<span class="pt-task-text pt-task-open">' + esc(t.text) + '</span>' +
      dateHtml + timeHtml +
      '<button class="pt-task-del" title="Удалить"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>' +
    '</div>';
  }

  function buildProjectHTML(p, pTasks, doneCount) {
    var isOpen = openProjects[p.id];
    var tasksHtml = pTasks.map(function(t, ti) { return renderTask(t, ti); }).join('');
    if (!pTasks.length) tasksHtml = '<div class="pt-add-inline pt-empty-hint" style="opacity:0.5;cursor:default;padding-left:30px;">Нет задач</div>';
    return '<div class="pt-project' + (isOpen ? ' open' : '') + '" data-project-id="' + p.id + '">' +
      '<div class="pt-project-head">' +
        '<svg class="pt-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>' +
        '<span class="pt-project-dot" style="background:' + p.color + '"></span>' +
        '<span class="pt-project-name">' + esc(p.name) + '</span>' +
        '<span class="pt-project-count">' + doneCount + '/' + pTasks.length + '</span>' +
        '<div class="pt-project-actions">' +
          '<button class="pt-project-action pt-add-task-in" title="Добавить задачу"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg></button>' +
          '<button class="pt-project-action danger pt-del-project" title="Удалить"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>' +
        '</div>' +
      '</div>' +
      '<div class="pt-tasks">' + tasksHtml + '</div>' +
    '</div>';
  }

  function render() {
    // === DIFF RENDER: обновляем только изменившиеся элементы ===
    var existingProjectIds = Array.from(tree.querySelectorAll('.pt-project')).map(function(el) { return +el.dataset.projectId; });
    var newProjectIds = projects.map(function(p) { return p.id; });

    // Удаляем проекты которых больше нет
    existingProjectIds.forEach(function(pid) {
      if (newProjectIds.indexOf(pid) === -1) {
        var el = tree.querySelector('.pt-project[data-project-id="' + pid + '"]');
        if (el) el.remove();
      }
    });

    // Обновляем/добавляем проекты
    projects.forEach(function(p, pi) {
      var pTasks = tasks.filter(function(t) { return t.project_id === p.id; });
      var doneCount = pTasks.filter(function(t) { return t.completed; }).length;
      var existing = tree.querySelector('.pt-project[data-project-id="' + p.id + '"]');

      if (!existing) {
        // Новый проект — создаём и анимируем
        var div = document.createElement('div');
        div.innerHTML = buildProjectHTML(p, pTasks, doneCount);
        var el = div.firstElementChild;
        el.classList.add('animate-in');
        el.addEventListener('animationend', function() { el.classList.remove('animate-in'); }, { once: true });
        tree.appendChild(el);
      } else {
        // Обновляем счётчик и цвет без пересоздания
        var countEl = existing.querySelector('.pt-project-count');
        if (countEl) countEl.textContent = doneCount + '/' + pTasks.length;
        var dotEl = existing.querySelector('.pt-project-dot');
        if (dotEl) dotEl.style.background = p.color;
        var nameEl = existing.querySelector('.pt-project-name');
        if (nameEl && nameEl.textContent !== p.name) nameEl.textContent = p.name;
        // Открытость
        if (openProjects[p.id]) existing.classList.add('open');
        // Диффим задачи внутри проекта
        diffTasks(existing.querySelector('.pt-tasks'), pTasks);
      }
    });

    // Переупорядочиваем проекты только если порядок изменился
    var children = Array.from(tree.querySelectorAll('.pt-project'));
    var needsReorder = projects.some(function(p, i) { return !children[i] || +children[i].dataset.projectId !== p.id; });
    if (needsReorder) {
      projects.forEach(function(p) {
        var el = tree.querySelector('.pt-project[data-project-id="' + p.id + '"]');
        if (el) tree.appendChild(el);
      });
    }

    // Orphan tasks
    var orphans = tasks.filter(function(t) { return !t.project_id; });
    if (orphans.length) {
      orphanSection.style.display = '';
      diffTasks(orphanList, orphans);
    } else {
      orphanSection.style.display = 'none';
      orphanList.innerHTML = '';
    }
  }

  function diffTasks(container, newTasks) {
    var existingIds = Array.from(container.querySelectorAll('.pt-task')).map(function(el) { return +el.dataset.taskId; });
    var newIds = newTasks.map(function(t) { return t.id; });

    // Удаляем отсутствующие
    existingIds.forEach(function(tid) {
      if (newIds.indexOf(tid) === -1) {
        var el = container.querySelector('.pt-task[data-task-id="' + tid + '"]');
        if (el) el.remove();
      }
    });

    // Убираем пустую подсказку если есть задачи
    if (newTasks.length) {
      var hint = container.querySelector('.pt-empty-hint');
      if (hint) hint.remove();
    }

    // Обновляем/добавляем задачи
    newTasks.forEach(function(t, i) {
      var existing = container.querySelector('.pt-task[data-task-id="' + t.id + '"]');
      if (!existing) {
        var div = document.createElement('div');
        div.innerHTML = renderTask(t, i);
        var el = div.firstElementChild;
        el.classList.add('animate-in');
        el.addEventListener('animationend', function() { el.classList.remove('animate-in'); }, { once: true });
        container.appendChild(el);
      } else {
        // Обновляем состояние без пересоздания
        existing.classList.toggle('done', !!t.completed);
        var txt = existing.querySelector('.pt-task-text');
        if (txt && txt.textContent !== t.text) txt.textContent = t.text;
        // Обновляем время
        var timeEl = existing.querySelector('.pt-task-time');
        var newTime = t.time_spent ? fmtDur(t.time_spent) : '';
        if (newTime && !timeEl) {
          var span = document.createElement('span');
          span.className = 'pt-task-time';
          span.textContent = newTime;
          existing.insertBefore(span, existing.querySelector('.pt-task-del'));
        } else if (!newTime && timeEl) {
          timeEl.remove();
        } else if (timeEl && timeEl.textContent !== newTime) {
          timeEl.textContent = newTime;
        }
        // Обновляем дату
        var dateEl = existing.querySelector('.pt-task-date');
        var newDate = t.due_date ? fmtDate(t.due_date) : '';
        var isOverdue = !t.completed && t.due_date && t.due_date < new Date().toISOString().slice(0,10);
        if (newDate && !dateEl) {
          var dspan = document.createElement('span');
          dspan.className = 'pt-task-date' + (isOverdue ? ' overdue' : '');
          dspan.textContent = newDate;
          existing.insertBefore(dspan, existing.querySelector('.pt-task-del'));
        } else if (!newDate && dateEl) {
          dateEl.remove();
        } else if (dateEl) {
          dateEl.textContent = newDate;
          dateEl.classList.toggle('overdue', !!isOverdue);
        }
      }
    });

    // Переупорядочиваем задачи только если порядок изменился
    var taskChildren = Array.from(container.querySelectorAll('.pt-task'));
    var taskNeedsReorder = newTasks.some(function(t, i) { return !taskChildren[i] || +taskChildren[i].dataset.taskId !== t.id; });
    if (taskNeedsReorder) {
      newTasks.forEach(function(t) {
        var el = container.querySelector('.pt-task[data-task-id="' + t.id + '"]');
        if (el) container.appendChild(el);
      });
    }

    // Добавляем пустую подсказку если задач нет
    if (!newTasks.length && !container.querySelector('.pt-empty-hint')) {
      container.innerHTML = '<div class="pt-add-inline pt-empty-hint" style="opacity:0.5;cursor:default;padding-left:30px;">Нет задач</div>';
    }
  }

  function bindEvents() {}

  // === EVENT DELEGATION (один раз навсегда) ===
  function initDelegation() {
    // Клик по шапке проекта (раскрыть/свернуть)
    tree.addEventListener('click', async function(e) {
      var head = e.target.closest('.pt-project-head');
      if (head && !e.target.closest('.pt-project-action')) {
        var proj = head.closest('.pt-project');
        var pid = +proj.dataset.projectId;
        proj.classList.toggle('open');
        openProjects[pid] = proj.classList.contains('open');
        localStorage.setItem('pt_open', JSON.stringify(openProjects));
        return;
      }

      // Добавить задачу в проект
      var addTaskBtn = e.target.closest('.pt-add-task-in');
      if (addTaskBtn) {
        e.stopPropagation();
        var pid = +addTaskBtn.closest('.pt-project').dataset.projectId;
        showCreate('task-in-project', pid);
        return;
      }

      // Удалить проект
      var delProjBtn = e.target.closest('.pt-del-project');
      if (delProjBtn) {
        e.stopPropagation();
        var proj = delProjBtn.closest('.pt-project');
        var pid = +proj.dataset.projectId;
        proj.classList.add('removing');
        var fired = false;
        var doDelete = async function() {
          if (fired) return;
          fired = true;
          try { await api('DELETE', 'projects/' + sessionKey + '/' + pid); } catch (_) {}
          await loadData();
        };
        proj.addEventListener('animationend', doDelete, { once: true });
        // Safety: если анимация не выстрелила (reduced-motion / display:none / другая причина)
        setTimeout(doDelete, 280);
        return;
      }
    });

    // Делегация на весь документ для задач (в проектах и orphan)
    document.addEventListener('click', async function(e) {
      // Чекбокс задачи
      var checkBtn = e.target.closest('.pt-task-check');
      if (checkBtn) {
        var taskEl = checkBtn.closest('.pt-task');
        var tid = +taskEl.dataset.taskId;
        var task = tasks.find(function(t) { return t.id === tid; });
        if (!task) return;
        var elapsed = 0;
        if (!task.completed) {
          var now = Date.now();
          var st = (typeof state !== 'undefined') ? state : window.state;
          var timerOn = st && st.timerRunning && st.currentSessionStart;
          if (!timerOn) { lastCheckTime = null; trackedTimerStart = null; }
          if (timerOn && trackedTimerStart !== st.currentSessionStart) {
            trackedTimerStart = st.currentSessionStart;
            lastCheckTime = st.currentSessionStart;
          }
          if (lastCheckTime && timerOn) elapsed = Math.round(now - lastCheckTime);
          lastCheckTime = now;
        }
        var newCompleted = !task.completed;
        await api('PATCH', 'tasks/' + sessionKey + '/' + tid + '/toggle', { completed: newCompleted, timeSpent: newCompleted ? elapsed : 0 });
        await loadData();
        return;
      }

      // Открыть детали задачи
      var openSpan = e.target.closest('.pt-task-open');
      if (openSpan) {
        var tid = +openSpan.closest('.pt-task').dataset.taskId;
        openDetail(tid);
        return;
      }

      // Удалить задачу
      var delBtn = e.target.closest('.pt-task-del');
      if (delBtn) {
        e.stopPropagation();
        var taskEl = delBtn.closest('.pt-task');
        var tid = +taskEl.dataset.taskId;
        taskEl.classList.add('removing');
        var fired = false;
        var doDelete = async function() {
          if (fired) return;
          fired = true;
          try { await api('DELETE', 'tasks/' + sessionKey + '/' + tid); } catch (_) {}
          await loadData();
        };
        taskEl.addEventListener('animationend', doDelete, { once: true });
        setTimeout(doDelete, 280);
        return;
      }
    });
  }
  initDelegation();

  addBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    addDropdown.classList.toggle('open');
  });

  addProjectOpt.addEventListener('click', function() {
    addDropdown.classList.remove('open');
    showCreate('project');
  });

  addTaskOpt.addEventListener('click', function() {
    addDropdown.classList.remove('open');
    showCreate('task');
  });

  function showCreate(mode, projectId) {
    createMode = mode;
    createProjectId = projectId || null;
    createBox.style.display = 'flex';
    createInput.placeholder = mode === 'project' ? 'Название проекта...' : 'Название задачи...';
    createInput.value = '';
    createInput.focus();
  }

  function hideCreate() {
    createBox.style.display = 'none';
    createMode = null;
    createProjectId = null;
  }

  async function doCreate() {
    var val = createInput.value.trim();
    if (!val) return;
    if (createMode === 'project') {
      var color = colors[projects.length % colors.length];
      await api('POST', 'projects/' + sessionKey, { name: val, color: color });
    } else {
      await api('POST', 'tasks/' + sessionKey, { text: val, projectId: createProjectId });
      if (createProjectId) openProjects[createProjectId] = true;
    }
    hideCreate();
    await loadData();
  }

  createSave.addEventListener('click', doCreate);
  createCancel.addEventListener('click', hideCreate);
  createInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') doCreate();
    if (e.key === 'Escape') hideCreate();
  });

  document.addEventListener('click', function(e) {
    if (!addBtn.contains(e.target) && !addDropdown.contains(e.target)) {
      addDropdown.classList.remove('open');
    }
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') addDropdown.classList.remove('open');
  });

  // === DETAIL PANEL ===
  var detailPanel = document.getElementById('ptDetail');
  var detailBack = document.getElementById('ptDetailBack');
  var detailName = document.getElementById('ptDetailName');
  var detailDesc = document.getElementById('ptDetailDesc');
  var detailDate = document.getElementById('ptDetailDate');
  var detailTimeStart = document.getElementById('ptDetailTimeStart');
  var detailTimeEnd = document.getElementById('ptDetailTimeEnd');
  var detailTimeBadge = document.getElementById('ptDetailTimeBadge');
  var detailMediaList = document.getElementById('ptDetailMediaList');
  var detailFileInput = document.getElementById('ptDetailFileInput');
  var detailSave = document.getElementById('ptDetailSave');
  var currentDetailId = null;
  var detailMedia = [];

  async function openDetail(taskId) {
    currentDetailId = taskId;
    var task = tasks.find(function(t) { return t.id === taskId; });
    if (!task) return;
    // Try to load full data from server
    try {
      var full = await api('GET', 'tasks/' + sessionKey + '/' + taskId);
      if (full && full.id) task = full;
    } catch(e) {}
    detailName.value = task.text || '';
    detailDesc.value = task.description || '';
    detailDate.value = task.due_date || '';
    detailTimeStart.value = task.time_start || '';
    detailTimeEnd.value = task.time_end || '';
    detailTimeBadge.textContent = task.time_spent ? fmtDur(task.time_spent) : '';
    detailMedia = task.media ? (typeof task.media === 'string' ? JSON.parse(task.media) : task.media) : [];
    renderMedia();
    detailPanel.style.display = 'flex';
  }

  function closeDetail() {
    detailPanel.style.display = 'none';
    currentDetailId = null;
    detailMedia = [];
  }

  detailBack.addEventListener('click', closeDetail);

  detailSave.addEventListener('click', async function() {
    if (!currentDetailId) return;
    // Save name if changed
    var task = tasks.find(function(t) { return t.id === currentDetailId; });
    var newName = detailName.value.trim();
    if (task && newName && newName !== task.text) {
      await api('PUT', 'tasks/' + sessionKey + '/' + currentDetailId, { text: newName, projectId: task.project_id });
    }
    // Save details
    await api('PATCH', 'tasks/' + sessionKey + '/' + currentDetailId + '/details', {
      description: detailDesc.value.trim(),
      dueDate: detailDate.value || null,
      timeStart: detailTimeStart.value || null,
      timeEnd: detailTimeEnd.value || null,
      media: detailMedia.length ? detailMedia : null
    });
    closeDetail();
    await loadData();
  });

  // Media: file input handler
  detailFileInput.addEventListener('change', function() {
    var files = detailFileInput.files;
    for (var i = 0; i < files.length; i++) {
      (function(file) {
        var reader = new FileReader();
        reader.onload = function(e) {
          detailMedia.push({
            name: file.name,
            type: file.type.startsWith('video') ? 'video' : 'image',
            data: e.target.result
          });
          renderMedia();
        };
        reader.readAsDataURL(file);
      })(files[i]);
    }
    detailFileInput.value = '';
  });

  function renderMedia() {
    if (!detailMedia.length) {
      detailMediaList.innerHTML = '<span style="font-size:0.72rem;color:var(--text-muted)">Нет вложений</span>';
      return;
    }
    detailMediaList.innerHTML = detailMedia.map(function(m, i) {
      var content = m.type === 'video'
        ? '<video src="' + m.data + '" muted></video>'
        : '<img src="' + m.data + '" alt="' + esc(m.name) + '" />';
      return '<div class="pt-detail-media-item" data-idx="' + i + '">' + content +
        '<button class="pt-detail-media-del" data-idx="' + i + '">&times;</button></div>';
    }).join('');
    detailMediaList.querySelectorAll('.pt-detail-media-item').forEach(function(item) {
      item.addEventListener('click', function(e) {
        if (e.target.closest('.pt-detail-media-del')) return;
        openLightbox(detailMedia, +item.dataset.idx);
      });
    });
    detailMediaList.querySelectorAll('.pt-detail-media-del').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        detailMedia.splice(+btn.dataset.idx, 1);
        renderMedia();
      });
    });
  }

  // Reset lastCheckTime when timer stops
  var wasRunning = false;
  setInterval(function() {
    var st2 = (typeof state !== 'undefined') ? state : window.state;
    if (!st2) return;
    var running = st2.timerRunning;
    // Timer stopped — clear everything
    if (wasRunning && !running) {
      lastCheckTime = null;
      trackedTimerStart = null;
    }
    wasRunning = running;
  }, 300);

  loadData();
})();

// ===== MEDIA LIGHTBOX =====
(function initLightbox() {
  var lb = document.getElementById('mediaLightbox');
  var lbMedia = document.getElementById('mlbMedia');
  var lbCounter = document.getElementById('mlbCounter');
  var lbClose = document.getElementById('mlbClose');
  var lbPrev = document.getElementById('mlbPrev');
  var lbNext = document.getElementById('mlbNext');
  var lbOverlay = document.getElementById('mlbOverlay');
  var items = [], cur = 0;

  window.openLightbox = function(mediaArr, idx) {
    items = mediaArr; cur = idx;
    lb.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    show();
  };

  function show() {
    var m = items[cur];
    lbMedia.innerHTML = m.type === 'video'
      ? '<video src="' + m.data + '" controls autoplay></video>'
      : '<img src="' + m.data + '" />';
    lbCounter.textContent = items.length > 1 ? (cur + 1) + ' / ' + items.length : '';
    lbPrev.style.display = cur > 0 ? '' : 'none';
    lbNext.style.display = cur < items.length - 1 ? '' : 'none';
  }

  function close() {
    lb.style.display = 'none';
    document.body.style.overflow = '';
    lbMedia.innerHTML = '';
    items = []; cur = 0;
  }

  lbClose.addEventListener('click', close);
  lbOverlay.addEventListener('click', close);
  lbPrev.addEventListener('click', function() { if (cur > 0) { cur--; show(); } });
  lbNext.addEventListener('click', function() { if (cur < items.length - 1) { cur++; show(); } });
  document.addEventListener('keydown', function(e) {
    if (lb.style.display === 'none') return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft' && cur > 0) { cur--; show(); }
    if (e.key === 'ArrowRight' && cur < items.length - 1) { cur++; show(); }
  });
})();
// ===== SEARCH =====
(function initSearch() {
  const overlay   = document.getElementById('searchOverlay');
  const backdrop  = document.getElementById('searchBackdrop');
  const input     = document.getElementById('searchInput');
  const results   = document.getElementById('searchResults');
  const trigger   = document.getElementById('headerSearch');
  let activeIdx   = -1;

  function open() {
    overlay.style.display = 'flex';
    input.value = '';
    results.innerHTML = '';
    activeIdx = -1;
    setTimeout(() => input.focus(), 30);
  }
  function close() {
    overlay.style.display = 'none';
    input.value = '';
    results.innerHTML = '';
  }

  trigger.addEventListener('click', open);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', function(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); open(); return; }
    if (overlay.style.display === 'none') return;
    if (e.key === 'Escape') { close(); return; }
    const items = results.querySelectorAll('.search-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, items.length - 1); highlight(items); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); highlight(items); }
    if (e.key === 'Enter' && activeIdx >= 0 && items[activeIdx]) items[activeIdx].click();
  });

  function highlight(items) {
    items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
    if (items[activeIdx]) items[activeIdx].scrollIntoView({ block: 'nearest' });
  }

  function hl(text, q) {
    if (!q) return escapeHTML(text);
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return escapeHTML(text);
    return escapeHTML(text.slice(0, idx)) + '<mark>' + escapeHTML(text.slice(idx, idx + q.length)) + '</mark>' + escapeHTML(text.slice(idx + q.length));
  }
  function escapeHTML(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  input.addEventListener('input', function() {
    const q = input.value.trim();
    activeIdx = -1;
    if (!q) { results.innerHTML = ''; return; }
    render(q);
  });

  function render(q) {
    const ql = q.toLowerCase();
    let html = '';
    let total = 0;

    // --- Проекты ---
    const ptData = window._ptData || { projects: [], tasks: [] };
    const matchProjects = ptData.projects.filter(p => p.name.toLowerCase().includes(ql));
    if (matchProjects.length) {
      html += '<div class="search-group-label">Проекты</div>';
      matchProjects.forEach(p => {
        total++;
        const taskCount = ptData.tasks.filter(t => t.project_id === p.id).length;
        html += `<div class="search-item" data-action="project" data-id="${p.id}">
          <div class="search-item-icon" style="background:${p.color}22;color:${p.color}">${p.icon || '📁'}</div>
          <div class="search-item-body">
            <div class="search-item-title">${hl(p.name, q)}</div>
            <div class="search-item-sub">${taskCount} задач</div>
          </div>
          <span class="search-item-badge">Проект</span>
        </div>`;
      });
    }

    // --- Задачи ---
    const matchTasks = ptData.tasks.filter(t => t.text.toLowerCase().includes(ql));
    if (matchTasks.length) {
      html += '<div class="search-group-label">Задачи</div>';
      matchTasks.slice(0, 12).forEach(t => {
        total++;
        const proj = ptData.projects.find(p => p.id === t.project_id);
        const sub = proj ? proj.name : 'Без проекта';
        const done = t.completed ? 'opacity:0.5;text-decoration:line-through' : '';
        html += `<div class="search-item" data-action="task" data-id="${t.id}" data-project-id="${t.project_id || ''}">
          <div class="search-item-icon">${t.completed ? '✅' : '⬜'}</div>
          <div class="search-item-body" style="${done}">
            <div class="search-item-title">${hl(t.text, q)}</div>
            <div class="search-item-sub">${escapeHTML(sub)}</div>
          </div>
          <span class="search-item-badge">${t.completed ? 'Готово' : 'Задача'}</span>
        </div>`;
      });
    }

    // --- Команда ---
    const team = window.userTeam;
    if (team && team.members) {
      const matchMembers = team.members.filter(m => m.username.toLowerCase().includes(ql) || (m.user_id && m.user_id.toLowerCase().includes(ql)));
      if (matchMembers.length) {
        html += '<div class="search-group-label">Команда</div>';
        matchMembers.forEach(m => {
          total++;
          const letter = m.username[0].toUpperCase();
          html += `<div class="search-item" data-action="member" data-user-id="${m.user_id}">
            <div class="search-item-icon" style="background:rgba(99,102,241,0.15);color:#818cf8;font-weight:700">${letter}</div>
            <div class="search-item-body">
              <div class="search-item-title">${hl(m.username, q)}</div>
              <div class="search-item-sub">ID: ${m.user_id}${m.role === 'owner' ? ' · 👑 Глава' : ''}</div>
            </div>
            <span class="search-item-badge">Участник</span>
          </div>`;
        });
      }
    }

    if (!total) {
      html = `<div class="search-empty">Ничего не найдено по запросу «${escapeHTML(q)}»</div>`;
    }
    results.innerHTML = html;

    // Навешиваем клики
    results.querySelectorAll('.search-item').forEach(item => {
      item.addEventListener('click', () => handleAction(item));
    });
  }

  function handleAction(item) {
    const action = item.dataset.action;
    close();
    if (action === 'project') {
      // Переключаемся на вкладку задач и раскрываем проект
      document.querySelector('[data-sidebar-tab="tasks"]')?.click();
      const pid = +item.dataset.id;
      setTimeout(() => {
        const el = document.querySelector('.pt-project[data-project-id="' + pid + '"]');
        if (el) { el.classList.add('open'); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      }, 100);
    } else if (action === 'task') {
      document.querySelector('[data-sidebar-tab="tasks"]')?.click();
      const pid = item.dataset.projectId;
      const tid = +item.dataset.id;
      setTimeout(() => {
        if (pid) {
          const proj = document.querySelector('.pt-project[data-project-id="' + pid + '"]');
          if (proj) proj.classList.add('open');
        }
        const el = document.querySelector('.pt-task[data-task-id="' + tid + '"]');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }
    // member — просто закрываем, можно расширить
  }
})();

// ===========================================================================
// TODAY'S TIMELINE + TIMER STATE — passive observers, no app.js changes.
// Reads window.cache.sessions for today and draws a 24h strip of real data.
// Drives the timer-card data-state and status text from app.js globals.
// ===========================================================================
(function initDashboard() {
  const card = document.getElementById('timerCard');
  const display = document.getElementById('timerDisplay');
  const metaLabel = document.getElementById('timerMetaLabel');
  const metaDate = document.getElementById('timerMetaDate');
  const statusBox = document.getElementById('timerStatus');
  const statusText = document.getElementById('timerStatusText');
  const statusDetail = document.getElementById('timerStatusDetail');
  const track = document.getElementById('timelineTrack');
  const empty = document.getElementById('timelineEmpty');
  const nowMark = document.getElementById('timelineNow');
  const legacyIndicator = document.getElementById('activityIndicator');
  if (!card || !display) return;

  // --- Format current date in Russian ---
  function todayLabel() {
    const d = new Date();
    const days = ['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];
    const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
    return days[d.getDay()] + ', ' + d.getDate() + ' ' + months[d.getMonth()];
  }
  if (metaDate) metaDate.textContent = todayLabel();

  function todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // --- Read today's sessions from app.js cache (script-scope const) ---
  function getTodaySessions() {
    try {
      // `cache` is declared in app.js at script scope — visible here
      if (typeof cache === 'undefined' || !cache.sessions) return [];
      const key = 'sessions_' + todayKey();
      return cache.sessions[key] || [];
    } catch (_) { return []; }
  }

  // --- Render the 24h timeline track from real session data ---
  const DAY_MS = 24 * 60 * 60 * 1000;
  function dayStartMs() {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  let lastRenderHash = '';
  function renderTimeline() {
    const sessions = getTodaySessions();
    const dStart = dayStartMs();
    const now = Date.now();

    // Cheap change detection
    const hash = sessions.length + ':' + sessions.map(s => (s.start || 0) + '/' + (s.end || 0)).join(',');
    if (hash === lastRenderHash && track.querySelector('.timeline-segment')) {
      // Just move the "now" marker
      moveNow();
      return;
    }
    lastRenderHash = hash;

    // Wipe existing segments (keep .timeline-empty + .timeline-now)
    [...track.querySelectorAll('.timeline-segment')].forEach(el => el.remove());

    if (!sessions.length) {
      if (empty) empty.style.display = '';
      if (nowMark) nowMark.style.display = 'none';
      return;
    }
    if (empty) empty.style.display = 'none';

    // Build segments: for each session, render a "work" block; gaps inside
    // (pauses) are rendered as separate dim segments.
    const frag = document.createDocumentFragment();
    sessions.forEach(s => {
      const sessionStart = s.start;
      const sessionEnd = s.end || now;
      if (!sessionStart) return;

      // Compute pauses
      const pauses = (s.pauses || []).filter(p => p.start);
      // Sort pauses by start
      pauses.sort((a, b) => a.start - b.start);

      // Render work segments between pauses
      let cursor = sessionStart;
      pauses.forEach(p => {
        if (p.start > cursor) {
          frag.appendChild(makeSegment(cursor, p.start, 'work'));
        }
        if (p.end && p.end > p.start) {
          frag.appendChild(makeSegment(p.start, p.end, 'pause'));
        }
        cursor = p.end || p.start;
      });
      if (sessionEnd > cursor) {
        frag.appendChild(makeSegment(cursor, sessionEnd, 'work'));
      }
    });

    track.appendChild(frag);
    if (nowMark) nowMark.style.display = '';
    moveNow();
  }

  function makeSegment(startMs, endMs, kind) {
    const dStart = dayStartMs();
    const leftPct = Math.max(0, (startMs - dStart) / DAY_MS) * 100;
    const widthPct = Math.max(0.1, (endMs - startMs) / DAY_MS) * 100;
    const el = document.createElement('div');
    el.className = 'timeline-segment' + (kind === 'pause' ? ' pause' : kind === 'distracted' ? ' distracted' : '');
    el.style.left = leftPct.toFixed(3) + '%';
    el.style.width = widthPct.toFixed(3) + '%';
    const dur = Math.round((endMs - startMs) / 60000);
    el.title = (kind === 'pause' ? 'Пауза · ' : 'Работа · ') + fmtClockMs(startMs) + ' – ' + fmtClockMs(endMs) + ' (' + dur + ' мин)';
    return el;
  }

  function moveNow() {
    if (!nowMark) return;
    const dStart = dayStartMs();
    const pct = ((Date.now() - dStart) / DAY_MS) * 100;
    nowMark.style.left = pct.toFixed(3) + '%';
  }

  function fmtClockMs(ms) {
    const d = new Date(ms);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // --- Drive timer-card state + status text from app.js globals ---
  let lastDisplay = display.textContent;

  function deriveStatus() {
    let st = {};
    try { if (typeof state !== 'undefined') st = state; } catch (_) {}
    const ind = (legacyIndicator?.textContent || '').trim();

    // Tick-flash micro-anim on display change
    if (display.textContent !== lastDisplay) {
      display.classList.remove('tick-flash');
      void display.offsetWidth;
      display.classList.add('tick-flash');
      lastDisplay = display.textContent;
    }

    // Map state
    let stateName = 'idle';
    if (st.timerRunning && !st.timerPaused) stateName = 'running';
    else if (st.timerRunning && st.timerPaused) stateName = 'paused';
    card.dataset.state = stateName;

    if (metaLabel) {
      if (stateName === 'running') metaLabel.textContent = 'Идёт работа';
      else if (stateName === 'paused') metaLabel.textContent = 'На паузе';
      else metaLabel.textContent = 'Хронограф';
    }

    // Status row — derived from agent activity + timer state
    let statusKey = 'idle';
    let primary = '';
    let detail = '';

    if (ind.startsWith('🟢')) {
      statusKey = 'working';
      primary = 'Работаешь';
      detail = ind.replace('🟢', '').trim().replace(/^Работа\s*:?\s*/i, '');
    } else if (ind.startsWith('🟡')) {
      statusKey = 'distracted';
      primary = 'Отвлекаешься';
      detail = ind.replace('🟡', '').trim().replace(/^Отвлечение\s*:?\s*/i, '');
    } else if (ind.startsWith('🔴')) {
      statusKey = 'idle';
      primary = 'Не активен';
      detail = ind.replace('🔴', '').trim().replace(/^Неактивен\s*:?\s*/i, '');
    } else if (ind.startsWith('⚪')) {
      statusKey = 'idle';
      primary = stateName === 'running' ? 'Таймер идёт' : (stateName === 'paused' ? 'Таймер на паузе' : 'Готов начать работу');
      detail = stateName === 'idle' ? 'Нажмите «Старт» чтобы засечь время' : '';
    } else {
      primary = stateName === 'running' ? 'Таймер идёт' : (stateName === 'paused' ? 'На паузе' : 'Готов начать работу');
    }

    if (statusBox) statusBox.dataset.status = statusKey;
    if (statusText) statusText.textContent = primary;
    if (statusDetail) statusDetail.textContent = detail ? ' · ' + detail : '';
  }

  // Strip trailing colon that app.js writes into workTimeLabel ("Рабочее время:")
  function cleanWorkTimeLabel() {
    const lbl = document.getElementById('workTimeLabel');
    if (!lbl) return;
    let t = lbl.textContent;
    if (t.endsWith(':')) lbl.textContent = t.slice(0, -1);
  }

  // --- Render loop ---
  function tick() {
    deriveStatus();
    renderTimeline();
    cleanWorkTimeLabel();
  }

  tick();
  setInterval(tick, 1000);

  // Re-render timeline immediately when display changes (covers fast-tick cases)
  const obs = new MutationObserver(tick);
  obs.observe(display, { childList: true, characterData: true, subtree: true });
})();

// ===========================================================================
// SETTINGS — tab switcher + live apps detection UI (Phase 2)
// Reads window.LinkTimeApps populated by app.js WS handlers.
// ===========================================================================
(function initSettings() {
  const modal = document.getElementById('settingsModal');
  if (!modal) return;

  // Tab switching + sliding underline
  const tabsContainer = modal.querySelector('.settings-tabs');
  const tabs = modal.querySelectorAll('[data-settings-tab]');
  const panes = modal.querySelectorAll('[data-settings-pane]');

  function moveUnderline(activeTab) {
    if (!activeTab || !tabsContainer) return;
    // requestAnimationFrame чтобы измерить размеры после .active применили
    requestAnimationFrame(() => {
      const tabRect = activeTab.getBoundingClientRect();
      const containerRect = tabsContainer.getBoundingClientRect();
      const x = tabRect.left - containerRect.left;
      const w = tabRect.width;
      tabsContainer.style.setProperty('--tab-x', x + 'px');
      tabsContainer.style.setProperty('--tab-w', w + 'px');
    });
  }

  function switchSettingsTab(name) {
    let activeTab = null;
    tabs.forEach(t => {
      const isActive = t.dataset.settingsTab === name;
      t.classList.toggle('active', isActive);
      if (isActive) activeTab = t;
    });
    panes.forEach(p => p.classList.toggle('active', p.dataset.settingsPane === name));
    moveUnderline(activeTab);
  }
  tabs.forEach(t => t.addEventListener('click', () => switchSettingsTab(t.dataset.settingsTab)));

  // При открытии модалки — переместить underline на активный таб (потому что
  // первоначальная позиция может быть посчитана пока модалка скрыта = размеры 0)
  const settingsObserver = new MutationObserver(() => {
    if (modal.classList.contains('active')) {
      const active = modal.querySelector('.settings-tab.active');
      // Дожидаемся завершения modal-snap прежде чем позиционировать
      setTimeout(() => moveUnderline(active), 60);
    }
  });
  settingsObserver.observe(modal, { attributes: true, attributeFilter: ['class'] });

  // При ресайзе окна — перепозиционировать
  window.addEventListener('resize', () => {
    if (modal.classList.contains('active')) {
      moveUnderline(modal.querySelector('.settings-tab.active'));
    }
  });

  // Refs
  const statusBox = document.getElementById('appsStatus');
  const statusText = document.getElementById('appsStatusText');
  const liveSection = document.getElementById('appsLiveSection');
  const liveList = document.getElementById('appsLiveList');
  const liveCount = document.getElementById('appsLiveCount');
  const refreshBtn = document.getElementById('appsRefreshBtn');
  const manualInput = document.getElementById('appsManualInput');
  const whiteCount = document.getElementById('appsWhiteCount');
  const blackCount = document.getElementById('appsBlackCount');
  const whiteEmpty = document.getElementById('appsWhiteEmpty');
  const blackEmpty = document.getElementById('appsBlackEmpty');
  const whiteItems = document.getElementById('whiteListItems');
  const blackItems = document.getElementById('blackListItems');

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function inWhite(name) {
    const w = (window.LinkTimeApps && window.LinkTimeApps.lists && window.LinkTimeApps.lists.white) || [];
    return w.some(a => a && a.toLowerCase() === name.toLowerCase());
  }
  function inBlack(name) {
    const b = (window.LinkTimeApps && window.LinkTimeApps.lists && window.LinkTimeApps.lists.black) || [];
    return b.some(a => a && a.toLowerCase() === name.toLowerCase());
  }
  function displayKey(app) {
    const p = (app.process || '').replace(/\.exe$/i, '').trim();
    if (p) return p;
    const t = (app.title || '').split(/[-—|·•]/)[0].trim();
    return t || 'Unknown';
  }

  function renderLive() {
    const la = window.LinkTimeApps || {};
    const online = !!la.agentOnline;
    const apps = la.snapshot || [];

    if (statusBox) statusBox.dataset.online = online ? 'true' : 'false';
    if (statusText) {
      statusText.textContent = online
        ? ('Desktop-агент подключён. Видно ' + apps.length + ' приложений за последние 10 минут.')
        : 'Desktop-агент не подключён — добавьте приложения вручную ниже.';
    }

    if (!liveSection) return;
    if (!apps.length) { liveSection.style.display = 'none'; return; }
    liveSection.style.display = '';
    if (liveCount) liveCount.textContent = apps.length;

    liveList.innerHTML = apps.map(app => {
      const name = displayKey(app);
      const matched = inWhite(name) ? 'white' : inBlack(name) ? 'black' : 'none';
      const statusLabel = matched === 'white' ? 'РАБОТА' : matched === 'black' ? 'ОТВЛЕКАЕТ' : '—';
      const itemClass = matched === 'white' ? 'is-white' : matched === 'black' ? 'is-black' : '';
      return '<div class="apps-live-item ' + itemClass + '" data-app-name="' + escapeHtml(name) + '">'
        + '<div class="apps-live-info">'
        + '<div class="apps-live-name">' + escapeHtml(name) + ' <span class="apps-live-status">' + statusLabel + '</span></div>'
        + '<div class="apps-live-title">' + escapeHtml(app.title || '') + '</div>'
        + '</div>'
        + '<div class="apps-live-actions">'
        + '<button class="apps-action-btn work' + (matched === 'white' ? ' active' : '') + '" data-act="white">🟢 Работа</button>'
        + '<button class="apps-action-btn distract' + (matched === 'black' ? ' active' : '') + '" data-act="black">🔴 Отвлекает</button>'
        + '<button class="apps-action-btn ignore' + (matched === 'none' ? ' active' : '') + '" data-act="ignore" title="Не учитывать">⊘</button>'
        + '</div></div>';
    }).join('');
  }

  function renderSavedCounts() {
    const w = (window.LinkTimeApps && window.LinkTimeApps.lists && window.LinkTimeApps.lists.white) || [];
    const b = (window.LinkTimeApps && window.LinkTimeApps.lists && window.LinkTimeApps.lists.black) || [];
    if (whiteCount) whiteCount.textContent = w.length;
    if (blackCount) blackCount.textContent = b.length;
    if (whiteEmpty) whiteEmpty.style.display = (whiteItems && whiteItems.children.length) ? 'none' : '';
    if (blackEmpty) blackEmpty.style.display = (blackItems && blackItems.children.length) ? 'none' : '';
  }

  function renderAll() {
    renderLive();
    try { if (typeof renderAppLists === 'function') renderAppLists(); } catch (_) {}
    renderSavedCounts();
  }

  // Hook to LinkTimeApps state changes
  if (window.LinkTimeApps) {
    window.LinkTimeApps.onChange = renderAll;
  }

  // Live-list action buttons (event delegation)
  if (liveList) {
    liveList.addEventListener('click', function(e) {
      const btn = e.target.closest('.apps-action-btn[data-act]');
      if (!btn) return;
      const item = btn.closest('.apps-live-item');
      if (!item) return;
      const name = item.dataset.appName;
      const act = btn.dataset.act;
      if (typeof window.categorizeApp === 'function') {
        window.categorizeApp(name, act);
      }
    });
  }

  // Manual input
  modal.querySelectorAll('[data-manual-action]').forEach(btn => {
    btn.addEventListener('click', function() {
      const val = manualInput && manualInput.value.trim();
      if (!val) return;
      if (typeof window.categorizeApp === 'function') {
        window.categorizeApp(val, btn.dataset.manualAction);
      }
      if (manualInput) manualInput.value = '';
    });
  });
  if (manualInput) {
    manualInput.addEventListener('keypress', function(e) {
      if (e.key === 'Enter') {
        const val = manualInput.value.trim();
        if (val) window.categorizeApp(val, 'white');
        manualInput.value = '';
      }
    });
  }

  // Refresh button — re-request snapshot from agent
  if (refreshBtn) {
    refreshBtn.addEventListener('click', function() {
      try { window.requestAppsState && window.requestAppsState(); } catch (_) {}
    });
  }

  // When the modal opens, refresh state from server
  const openObserver = new MutationObserver(function() {
    if (modal.classList.contains('active')) {
      renderAll();
      try { window.requestAppsState && window.requestAppsState(); } catch (_) {}
    }
  });
  openObserver.observe(modal, { attributes: true, attributeFilter: ['class'] });

  // Initial render
  renderAll();
})();

// ===========================================================================
// PROCESS PICKER MODAL — список всех процессов системы + выбор .exe
// ===========================================================================
(function initProcessPicker() {
  const modal = document.getElementById('processPickerModal');
  if (!modal) return;

  const openBtn  = document.getElementById('appsPickerOpen');
  const browseBtn = document.getElementById('appsBrowseExe');
  const closeBtn = document.getElementById('processPickerClose');
  const refreshBtn = document.getElementById('processPickerRefresh');
  const searchInput = document.getElementById('processPickerSearch');
  const listEl   = document.getElementById('processPickerList');
  const metaEl   = document.getElementById('processPickerMeta');

  function esc(s) { const d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; }

  function open() {
    modal.classList.add('active');
    refresh();
    setTimeout(() => searchInput && searchInput.focus(), 50);
  }
  function close() { modal.classList.remove('active'); }

  function refresh() {
    if (metaEl) metaEl.textContent = 'Запрашиваю у Desktop Agent…';
    if (refreshBtn) refreshBtn.classList.add('spinning');
    if (listEl) listEl.innerHTML = '';

    if (typeof window.requestAllProcesses === 'function') {
      window.requestAllProcesses();
    }

    clearTimeout(refresh._t);
    refresh._t = setTimeout(() => {
      if (refreshBtn) refreshBtn.classList.remove('spinning');
      if (!window.LinkTimeApps.allProcesses || !window.LinkTimeApps.allProcesses.length) {
        renderEmpty();
      }
    }, 3500);
  }

  function renderEmpty() {
    const offline = window.LinkTimeApps && window.LinkTimeApps.allProcessesOffline;
    const msg = offline
      ? 'Desktop-агент не подключён. Запусти его и попробуй снова.'
      : 'Не удалось получить список процессов (агент молчит или PowerShell вернул пусто).';
    if (metaEl) metaEl.textContent = offline ? 'Агент не подключён' : 'Пусто';
    if (listEl) {
      listEl.innerHTML = '<div class="process-picker-empty">' + esc(msg) + '</div>';
    }
  }

  function rulesMatch(name, path) {
    const la = window.LinkTimeApps || {};
    function check(rule) {
      if (!rule) return false;
      if (typeof rule === 'string') return name && rule.toLowerCase() === name.toLowerCase();
      if (rule.path && path) return rule.path.toLowerCase() === path.toLowerCase();
      if (rule.match && name) return rule.match.toLowerCase() === name.toLowerCase();
      return false;
    }
    if ((la.lists.white || []).some(check)) return 'white';
    if ((la.lists.black || []).some(check)) return 'black';
    return 'none';
  }

  function render() {
    const procs = (window.LinkTimeApps && window.LinkTimeApps.allProcesses) || [];
    if (refreshBtn) refreshBtn.classList.remove('spinning');

    if (!procs.length) { renderEmpty(); return; }

    const q = (searchInput && searchInput.value || '').trim().toLowerCase();
    const filtered = q
      ? procs.filter(p =>
          (p.name || '').toLowerCase().includes(q) ||
          (p.title || '').toLowerCase().includes(q) ||
          (p.path || '').toLowerCase().includes(q))
      : procs;

    if (metaEl) {
      const shown = filtered.length;
      const total = procs.length;
      metaEl.textContent = (q ? (shown + ' из ' + total) : (total + ' процессов'))
        + (procs.some(p => p.title) ? ' · с окнами — сверху' : '');
    }

    if (!filtered.length) {
      listEl.innerHTML = '<div class="process-picker-empty">Ничего не нашлось по запросу.</div>';
      return;
    }

    listEl.innerHTML = filtered.map(p => {
      const matchNow = rulesMatch(p.name, p.path);
      const letter = (p.name || '?')[0].toUpperCase();
      const badge = matchNow === 'white' ? '<span class="proc-badge">Работа</span>'
                  : matchNow === 'black' ? '<span class="proc-badge">Отвлекает</span>'
                  : '';
      const cls = matchNow === 'white' ? 'is-white' : matchNow === 'black' ? 'is-black' : '';
      const titleRow = p.title ? '<div class="proc-item-title">' + esc(p.title) + '</div>' : '';
      const pathRow  = p.path  ? '<div class="proc-item-path">'  + esc(p.path)  + '</div>' : '';
      const instBadge = p.instances && p.instances > 1 ? ' <span class="proc-badge">x' + p.instances + '</span>' : '';
      return ''
        + '<div class="proc-item ' + cls + '" data-name="' + esc(p.name) + '" data-path="' + esc(p.path || '') + '">'
        +   '<div class="proc-item-icon">' + esc(letter) + '</div>'
        +   '<div class="proc-item-info">'
        +     '<div class="proc-item-name">' + esc(p.name) + instBadge + ' ' + badge + '</div>'
        +     titleRow
        +     pathRow
        +   '</div>'
        +   '<div class="proc-item-actions">'
        +     '<button class="apps-action-btn work" data-pick="white">🟢 Работа</button>'
        +     '<button class="apps-action-btn distract" data-pick="black">🔴 Отвлекает</button>'
        +     '<button class="apps-action-btn ignore" data-pick="ignore" title="Не учитывать">⊘</button>'
        +   '</div>'
        + '</div>';
    }).join('');
  }

  if (listEl) {
    listEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-pick]');
      if (!btn) return;
      const item = btn.closest('.proc-item');
      if (!item) return;
      const name = item.dataset.name;
      const path = item.dataset.path || null;
      const kind = btn.dataset.pick;
      const rule = path ? { match: name, path, label: name } : { match: name };
      if (typeof window.addAppRule === 'function') {
        window.addAppRule(rule, kind);
      }
      setTimeout(render, 60);
    });
  }

  if (searchInput) searchInput.addEventListener('input', render);
  if (refreshBtn) refreshBtn.addEventListener('click', refresh);
  if (closeBtn) closeBtn.addEventListener('click', close);
  if (openBtn) openBtn.addEventListener('click', open);

  if (browseBtn) browseBtn.addEventListener('click', async () => {
    if (window.electronAPI && typeof window.electronAPI.pickExeFile === 'function') {
      const filePath = await window.electronAPI.pickExeFile();
      if (!filePath) return;
      const name = filePath.split(/[\\/]/).pop().replace(/\.exe$/i, '');
      if (typeof window.addAppRule === 'function') {
        window.addAppRule({ match: name, path: filePath, label: name }, 'white');
      }
      if (window.showToast) window.showToast('Добавлено в "Работа": ' + name, 'success');
    } else {
      const path = prompt('Введите полный путь к .exe файлу:', '');
      if (!path) return;
      const name = path.split(/[\\/]/).pop().replace(/\.exe$/i, '');
      if (typeof window.addAppRule === 'function') {
        window.addAppRule({ match: name, path, label: name }, 'white');
      }
    }
  });

  if (window.LinkTimeApps) {
    window.LinkTimeApps.onProcessesChange = render;
  }
})();

