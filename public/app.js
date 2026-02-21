// Состояние приложения
let state = {
timerRunning: false,
timerPaused: false,
currentSessionStart: null,
currentPauseStart: null,
elapsedTime: 0,
sessionKey: null,
currentDate: new Date().toISOString().split('T')[0],
selectedDate: new Date().toISOString().split('T')[0], // Добавлена выбранная дата
totalPausedTime: 0,
lastTaskMarkedMs: 0
};

let timerInterval = null;
let ws = null;
let reconnectInterval = null;
let heartbeatInterval = null;
const WS_URL = 'wss://linktime.go-tit.ru';

// XSS защита
function escapeHTML(str) {
const div = document.createElement('div');
div.appendChild(document.createTextNode(str));
return div.innerHTML;
}

// Состояние видимости и фокуса
let isTabVisible = true;
let hasWindowFocus = true;
let autoPauseActive = false; // Флаг авто-паузы
let autoPauseTimeout = null; // Таймер отложенной авто-паузы
let agentConnected = false; // Подключён ли Desktop Agent
let agentStatus = null; // Последний статус от агента
let manualPause = false; // Ручная пауза (приоритет над авто)
let resumeGraceUntil = 0; // Защита от мгновенной повторной паузы

// Инициализация
document.addEventListener('DOMContentLoaded', () => {
initializeApp();
setupEventListeners();
setupVisibilityHandlers();
loadSelectedDateData();
renderCalendar();
});

// Инициализация приложения
function initializeApp() {
// Check URL for sessionKey (from Electron app or shared link)
const urlParams = new URLSearchParams(window.location.search);
const urlKey = urlParams.get('sessionKey');
if (urlKey) {
localStorage.setItem('sessionKey', urlKey);
state.sessionKey = urlKey;
// Clean URL
window.history.replaceState({}, '', window.location.pathname);
} else {
// Получаем или создаём ключ сессии
state.sessionKey = localStorage.getItem('sessionKey');
if (!state.sessionKey) {
state.sessionKey = generateSessionKey();
localStorage.setItem('sessionKey', state.sessionKey);
}
}

// Подключаемся к WebSocket серверу
connectWebSocket();
// Загружаем профиль пользователя
initUserProfile();
}

// Генерация уникального ключа сессии
function generateSessionKey() {
return 'session_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
}

// Настройка обработчиков событий
function setupEventListeners() {
// Таймер
document.getElementById('startBtn').addEventListener('click', startTimer);
document.getElementById('pauseBtn').addEventListener('click', () => pauseTimer(false));
document.getElementById('stopBtn').addEventListener('click', stopTimer);


// Доска задач (новая полноценная)
document.getElementById('boardBtn').addEventListener('click', openBoardOverlay);
window.addEventListener('message', (e) => { if (e.data === 'close-board') closeBoardOverlay(); });

// Настройки
document.getElementById('settingsBtn') && document.getElementById('settingsBtn').addEventListener('click', openSettings);
document.getElementById('burgerBtn').addEventListener('click', toggleBurger);
document.getElementById('burgerSettings').addEventListener('click', () => { closeBurger(); openSettings(); });
document.getElementById('burgerShareTime').addEventListener('click', () => { closeBurger(); openShareTimeModal(); });
document.getElementById('burgerBell').addEventListener('click', toggleNotifications);
document.getElementById('avatarBtn').addEventListener('click', () => { closeBurger(); openProfile(); });
document.getElementById('closeProfile').addEventListener('click', closeProfile);
document.getElementById('closeInvite').addEventListener('click', closeInviteModal);
document.getElementById('saveUsername').addEventListener('click', saveUsername);
document.getElementById('saveEmail').addEventListener('click', saveEmail);
document.getElementById('sendInviteBtn').addEventListener('click', sendInvite);
document.getElementById('avatarInput').addEventListener('change', handleAvatarUpload);
document.getElementById('removeAvatar').addEventListener('click', removeAvatar);
document.getElementById('closeShareTime').addEventListener('click', closeShareTimeModal);
document.getElementById('confirmShareTime').addEventListener('click', confirmShareTime);
document.getElementById('cancelShareTime').addEventListener('click', closeShareTimeModal);
document.addEventListener('click', (e) => {
  if (!document.getElementById('burgerWrap').contains(e.target)) closeBurger();
});
document.getElementById('closeSettings').addEventListener('click', closeSettings);
document.getElementById('generateQR').addEventListener('click', generateQRCode);
document.getElementById('showKey').addEventListener('click', showSessionKey);
document.getElementById('scanQR').addEventListener('click', startQRScanner);
document.getElementById('enterKey').addEventListener('click', showKeyInput);
document.getElementById('connectKey').addEventListener('click', connectWithKey);
document.getElementById('migrateBtn').addEventListener('click', migrateDataToServer);

    // Автозапуск (только для Electron)
    if (window.__electronApp) {
        document.getElementById('autostartCheckbox').addEventListener('change', saveAutostartSetting);
    }

// Календарь
document.getElementById('prevMonth').addEventListener('click', () => changeMonth(-1));
document.getElementById('nextMonth').addEventListener('click', () => changeMonth(1));
}

// Настройка обработчиков видимости и фокуса
function setupVisibilityHandlers() {
// Visibility API - отслеживание скрытия/показа вкладки
document.addEventListener('visibilitychange', () => {
isTabVisible = !document.hidden;

if (isTabVisible) {
console.log('Tab became visible');
onUserReturned();
} else {
console.log('Tab hidden');
onUserLeft('tab_hidden');
}
});

// Отслеживание фокуса окна браузера
window.addEventListener('blur', () => {
hasWindowFocus = false;
console.log('Window lost focus');
onUserLeft('browser_blur');
});

window.addEventListener('focus', () => {
hasWindowFocus = true;
console.log('Window gained focus');
onUserReturned();
});
}

// Пользователь ушёл с вкладки — запускаем обратный отсчёт авто-паузы
function onUserLeft(reason) {
// В Electron idle-паузой управляет main.js через powerMonitor
if (window.__electronApp) return;
if (!state.timerRunning || state.timerPaused) return;
if (Date.now() < resumeGraceUntil) {
console.log('Grace period active — skip auto-pause');
return;
}

sendBrowserEvent(reason);

if (autoPauseTimeout) clearTimeout(autoPauseTimeout);

const delay = 5000;
console.log(`Auto-pause in ${delay/1000}s (reason: ${reason})...`);

autoPauseTimeout = setTimeout(() => {
if (isTabVisible && hasWindowFocus) return;
if (agentConnected && agentStatus === 'working') {
console.log('Agent confirms working — skip auto-pause');
return;
}
if (!state.timerRunning || state.timerPaused) return;

console.log(`Auto-pausing timer (reason: ${reason})`);
pauseTimer(true);

let message = 'Таймер приостановлен';
if (reason === 'tab_hidden') message = 'Авто-Пауза: вкладка скрыта';
if (reason === 'browser_blur') message = 'Авто-Пауза: окно не в фокусе';
showToast(message, 'info');
}, delay);
}

// Пользователь вернулся на вкладку
function onUserReturned() {
// В Electron idle-паузой управляет main.js через powerMonitor
if (window.__electronApp) return;

// Отменяем обратный отсчёт авто-паузы
if (autoPauseTimeout) {
clearTimeout(autoPauseTimeout);
autoPauseTimeout = null;
}

sendBrowserEvent('browser_focus');

// Если была авто-пауза (не ручная) — автоматически возобновляем
if (state.timerRunning && state.timerPaused && autoPauseActive && !manualPause) {
console.log('User returned — auto-resuming timer');
resumeGraceUntil = Date.now() + 7000;

// Прямое возобновление без pauseTimer
const pauseDuration = Date.now() - state.currentPauseStart;
const sessions = getTodaySessions();
const currentSession = sessions[sessions.length - 1];
if (currentSession && currentSession.pauses && currentSession.pauses.length > 0) {
currentSession.pauses[currentSession.pauses.length - 1].end = Date.now();
currentSession.pauses[currentSession.pauses.length - 1].duration = pauseDuration;
saveTodaySessions(sessions);
}
state.totalPausedTime += pauseDuration;
state.timerPaused = false;
state.currentPauseStart = null;
autoPauseActive = false;
manualPause = false;

if (timerInterval) clearInterval(timerInterval);
timerInterval = setInterval(updateTimer, 1000);
updateTimer(); // Мгновенное обновление

document.getElementById('pauseBtn').textContent = 'Пауза';
document.getElementById('pauseBtn').disabled = false;

syncTimerState('resume', {
sessionStart: state.currentSessionStart,
totalPausedTime: state.totalPausedTime
});

showToast('Таймер возобновлён', 'success');
} else {
// Запрашиваем состояние только если не было авто-возобновления
requestServerState();
}
}

function sendBrowserEvent(eventType) {
if (ws && ws.readyState === WebSocket.OPEN) {
ws.send(JSON.stringify({
type: 'browser_event',
sessionKey: state.sessionKey,
event: eventType
}));
}
}

function requestServerState() {
if (ws && ws.readyState === WebSocket.OPEN) {
ws.send(JSON.stringify({
type: 'request_state',
sessionKey: state.sessionKey
}));
}
}

// === ТАЙМЕР ===

function startTimer() {
if (!state.timerRunning) {
// При запуске таймера автоматически выбираем сегодняшнюю дату
state.selectedDate = state.currentDate;
renderCalendar();
updateTasksTitle();
renderTasks();
updateSelectedDateStats();

state.timerRunning = true;
state.currentSessionStart = Date.now();
state.totalPausedTime = 0;
state.lastTaskMarkedMs = 0;
manualPause = false;
autoPauseActive = false;

// Создаём новую сессию
const session = {
start: state.currentSessionStart,
pauses: []
};

saveTodaySession(session);

if (timerInterval) clearInterval(timerInterval);
timerInterval = setInterval(updateTimer, 1000);
updateTimer();

document.getElementById('startBtn').disabled = true;
document.getElementById('pauseBtn').disabled = false;
document.getElementById('stopBtn').disabled = false;

// Синхронизируем старт таймера
syncTimerState('start', {
sessionStart: state.currentSessionStart,
totalPausedTime: 0
});
} else if (state.timerPaused) {
// Возобновление после паузы
const pauseDuration = Date.now() - state.currentPauseStart;
const sessions = getTodaySessions();
const currentSession = sessions[sessions.length - 1];
if (currentSession && currentSession.pauses && currentSession.pauses.length > 0) {
currentSession.pauses[currentSession.pauses.length - 1].end = Date.now();
currentSession.pauses[currentSession.pauses.length - 1].duration = pauseDuration;
saveTodaySessions(sessions);
}

state.totalPausedTime += pauseDuration;

state.timerPaused = false;
state.currentPauseStart = null;

// Запускаем таймер снова
if (timerInterval) clearInterval(timerInterval);
timerInterval = setInterval(updateTimer, 1000);
updateTimer();

// Обновляем кнопки
document.getElementById('startBtn').disabled = true;
document.getElementById('pauseBtn').disabled = false;
document.getElementById('pauseBtn').textContent = 'Пауза';
document.getElementById('stopBtn').disabled = false;

updateSelectedDateStats();

// Синхронизируем продолжение таймера
syncTimerState('resume', {
sessionStart: state.currentSessionStart,
totalPausedTime: state.totalPausedTime
});

// Сбрасываем флаг авто-паузы
autoPauseActive = false;
}
}

function pauseTimer(isAutoPause = false) {
if (state.timerPaused && !isAutoPause) {
// Возобновление после паузы
const pauseDuration = Date.now() - state.currentPauseStart;
const sessions = getTodaySessions();
const currentSession = sessions[sessions.length - 1];
if (currentSession && currentSession.pauses && currentSession.pauses.length > 0) {
currentSession.pauses[currentSession.pauses.length - 1].end = Date.now();
currentSession.pauses[currentSession.pauses.length - 1].duration = pauseDuration;
saveTodaySessions(sessions);
}

state.totalPausedTime += pauseDuration;

state.timerPaused = false;
state.currentPauseStart = null;

// Запускаем таймер снова
if (timerInterval) clearInterval(timerInterval);
timerInterval = setInterval(updateTimer, 1000);
updateTimer();

// Обновляем кнопки
document.getElementById('startBtn').disabled = true;
document.getElementById('pauseBtn').disabled = false;
document.getElementById('pauseBtn').textContent = 'Пауза';
document.getElementById('stopBtn').disabled = false;

updateSelectedDateStats();

// Синхронизируем продолжение таймера
syncTimerState('resume', {
sessionStart: state.currentSessionStart,
totalPausedTime: state.totalPausedTime
});
} else if (state.timerRunning && !state.timerPaused) {
// Ставим на паузу
state.timerPaused = true;
state.currentPauseStart = Date.now();

// Останавливаем таймер
if (timerInterval) {
clearInterval(timerInterval);
timerInterval = null;
}

// Добавляем паузу к текущей сессии
const sessions = getTodaySessions();
const currentSession = sessions[sessions.length - 1];
if (currentSession) {
if (!currentSession.pauses) currentSession.pauses = [];
currentSession.pauses.push({
start: state.currentPauseStart,
isAuto: isAutoPause
});
saveTodaySessions(sessions);
}

// Обновляем текст кнопки и флаги в зависимости от типа паузы
if (isAutoPause) {
document.getElementById('pauseBtn').textContent = 'Продолжить (Авто-Пауза)';
autoPauseActive = true;
manualPause = false;
} else {
document.getElementById('pauseBtn').textContent = 'Продолжить';
autoPauseActive = false;
manualPause = true;
}

// Синхронизируем паузу таймера
syncTimerState('pause', {
sessionStart: state.currentSessionStart,
pauseStart: state.currentPauseStart,
totalPausedTime: state.totalPausedTime,
isAuto: isAutoPause
});
}
}

function stopTimer() {
if (state.timerRunning) {
// Если была активна пауза, завершаем её
if (state.timerPaused) {
const sessions = getTodaySessions();
const currentSession = sessions[sessions.length - 1];
if (currentSession && currentSession.pauses && currentSession.pauses.length > 0) {
const pauseDuration = Date.now() - state.currentPauseStart;
currentSession.pauses[currentSession.pauses.length - 1].end = Date.now();
currentSession.pauses[currentSession.pauses.length - 1].duration = pauseDuration;
saveTodaySessions(sessions);
}
}

// Завершаем сессию
const sessions = getTodaySessions();
const currentSession = sessions[sessions.length - 1];
if (currentSession && !currentSession.end) {
currentSession.end = Date.now();
currentSession.duration = currentSession.end - currentSession.start;
saveTodaySessions(sessions);
}

clearInterval(timerInterval);
state.timerRunning = false;
state.timerPaused = false;
state.currentSessionStart = null;
state.currentPauseStart = null;
state.elapsedTime = 0;
state.totalPausedTime = 0;
state.lastTaskMarkedMs = 0;
autoPauseActive = false;
manualPause = false;
if (autoPauseTimeout) { clearTimeout(autoPauseTimeout); autoPauseTimeout = null; }

document.getElementById('timerDisplay').textContent = '00:00:00';
document.getElementById('startBtn').disabled = false;
document.getElementById('pauseBtn').disabled = true;
document.getElementById('pauseBtn').textContent = 'Пауза';
document.getElementById('stopBtn').disabled = true;

updateSelectedDateStats();
showToast('Сессия завершена!', 'success');

// Синхронизируем остановку таймера
syncTimerState('stop', {});
}
}

function updateTimer() {
if (state.timerRunning && !state.timerPaused) {
state.elapsedTime = Date.now() - state.currentSessionStart;
const displayTime = state.elapsedTime - state.totalPausedTime;
document.getElementById('timerDisplay').textContent = formatTime(displayTime);
// Обновляем рабочее время в реальном времени
if (state.selectedDate === state.currentDate) {
updateSelectedDateStats();
}
}
}

function formatTime(ms) {
const totalSeconds = Math.floor(ms / 1000);
const hours = Math.floor(totalSeconds / 3600);
const minutes = Math.floor((totalSeconds % 3600) / 60);
const seconds = totalSeconds % 60;

return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}


// Заглушки — старые задачи перенесены в проекты (pt-tree)
function renderTasks() {}
function updateTasksTitle() {}

// Получить общее рабочее время за дату (мс)
function getTotalWorkTimeForDate(dateStr) {
const data = getDataForDate(dateStr);
// Если таймер сейчас работает и это сегодня — добавляем текущую сессию
if (dateStr === state.currentDate && state.timerRunning && state.currentSessionStart) {
let currentWork = Date.now() - state.currentSessionStart - state.totalPausedTime;
if (state.timerPaused && state.currentPauseStart) {
currentWork -= (Date.now() - state.currentPauseStart);
}
return data.totalWorkTime + Math.max(0, currentWork);
}
return data.totalWorkTime;
}


// === КАЛЕНДАРЬ ===

let currentMonth = new Date();

function renderCalendar() {
const year = currentMonth.getFullYear();
const month = currentMonth.getMonth();

document.getElementById('currentMonth').textContent = 
currentMonth.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });

const firstDay = new Date(year, month, 1);
const lastDay = new Date(year, month + 1, 0);
const startingDayOfWeek = firstDay.getDay() === 0 ? 6 : firstDay.getDay() - 1;

const calendar = document.getElementById('calendar');
calendar.innerHTML = '';

// Дни недели
const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
weekdays.forEach(day => {
const div = document.createElement('div');
div.className = 'calendar-weekday';
div.textContent = day;
calendar.appendChild(div);
});

// Пустые ячейки до начала месяца
for (let i = 0; i < startingDayOfWeek; i++) {
calendar.appendChild(document.createElement('div'));
}

// Дни месяца
const today = new Date();
const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

for (let day = 1; day <= lastDay.getDate(); day++) {
const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const dayData = getDataForDate(dateStr);

const div = document.createElement('div');
div.className = 'calendar-day';

// Зелёным - сегодняшний день
if (dateStr === todayStr) {
div.classList.add('today');
}

// Жёлтым - выбранный день
if (dateStr === state.selectedDate) {
div.classList.add('selected');
}

if (dayData.totalWorkTime > 0) {
div.classList.add('has-data');
}

div.innerHTML = `
           <div class="day-number">${day}</div>
           ${dayData.totalWorkTime > 0 ? `<div class="day-time">${formatTime(dayData.totalWorkTime)}</div>` : ''}
       `;

div.addEventListener('click', () => selectDate(dateStr));
calendar.appendChild(div);
}
}

function changeMonth(direction) {
currentMonth.setMonth(currentMonth.getMonth() + direction);
renderCalendar();
}

function selectDate(dateStr) {
state.selectedDate = dateStr;
renderCalendar();
updateTasksTitle();
renderTasks();
updateSelectedDateStats();
}

function getDataForDate(dateStr) {
const sessions = getSessionsForDate(dateStr);
const tasks = cache.tasks.filter(t => t.date === dateStr);

let totalWorkTime = 0;
let totalPauseTime = 0;

sessions.forEach(session => {
if (session.end) {
let sessionTime = session.end - session.start;
(session.pauses || []).forEach(pause => {
if (pause.duration) {
totalPauseTime += pause.duration;
sessionTime -= pause.duration;
}
});
totalWorkTime += Math.max(0, sessionTime);
} else if (dateStr === state.currentDate && state.timerRunning && state.currentSessionStart && session.start === state.currentSessionStart) {
// Текущая активная сессия — считаем в реальном времени
let currentWork = Date.now() - session.start - state.totalPausedTime;
if (state.timerPaused && state.currentPauseStart) {
currentWork -= (Date.now() - state.currentPauseStart);
}
totalWorkTime += Math.max(0, currentWork);
}
});

return {
totalWorkTime,
totalPauseTime,
sessionCount: sessions.filter(s => s.end).length,
tasks: tasks
};
}

// === СТАТИСТИКА ===

function updateSelectedDateStats() {
const data = getDataForDate(state.selectedDate);
const today = new Date().toISOString().split('T')[0];

// Обновляем метку рабочего времени
const workTimeLabel = document.getElementById('workTimeLabel');
if (state.selectedDate === today) {
workTimeLabel.textContent = 'Рабочее время:';
} else {
const dateObj = new Date(state.selectedDate + 'T00:00:00');
workTimeLabel.textContent = 'Рабочее время (' + dateObj.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) + '):';
}

document.getElementById('totalWorkTime').textContent = formatTime(data.totalWorkTime);
document.getElementById('sessionCount').textContent = data.sessionCount;

const completedTasks = data.tasks.filter(t => t.completed).length;
const totalTasks = data.tasks.length;
document.getElementById('tasksCompleted').textContent = `${completedTasks} из ${totalTasks}`;
}

function loadSelectedDateData() {
updateTasksTitle();
renderTasks();
updateSelectedDateStats();
}

// === ЭКСПОРТ ДАННЫХ ===

function exportJSON() {
    const data = {
        exportedAt: new Date().toISOString(),
        tasks: cache.tasks || [],
        sessions: cache.sessions || {}
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `linktime-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('JSON экспортирован', 'success');
}

function exportCSV() {
    const sessions = cache.sessions || {};
    const rows = [['Дата', 'Начало', 'Конец', 'Длительность (мин)', 'Задачи']];

    for (const key of Object.keys(sessions).sort()) {
        const date = key.replace('sessions_', '');
        const daySessions = sessions[key] || [];
        const tasks = (cache.tasks || [])
            .filter(t => t.date === date && t.completed)
            .map(t => t.text)
            .join('; ');

        for (const s of daySessions) {
            const start = new Date(s.startTime);
            const end = s.endTime ? new Date(s.endTime) : new Date();
            const dur = Math.round((end - start - (s.totalPausedTime || 0)) / 60000);
            rows.push([
                date,
                start.toLocaleTimeString('ru'),
                s.endTime ? end.toLocaleTimeString('ru') : '',
                dur,
                tasks
            ]);
        }
    }

    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `linktime-export-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('CSV экспортирован', 'success');
}

function importJSON() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const data = JSON.parse(ev.target.result);
                if (data.tasks) {
                    // Merge с существующими данными
                    const existing = cache.tasks || [];
                    const existingIds = new Set(existing.map(t => t.id));
                    const newTasks = data.tasks.filter(t => !existingIds.has(t.id));
                    cache.tasks = [...existing, ...newTasks];
                    saveTasks(cache.tasks);
                }
                if (data.sessions) {
                    for (const key of Object.keys(data.sessions)) {
                        const existing = cache.sessions[key] || [];
                        const byStart = new Map(existing.map(s => [s.startTime, s]));
                        for (const s of data.sessions[key]) byStart.set(s.startTime, s);
                        cache.sessions[key] = Array.from(byStart.values());
                        localStorage.setItem(key, JSON.stringify(cache.sessions[key]));
                    }
                }
                renderTasks();
                renderCalendar();
                updateSelectedDateStats();
                showToast('Данные импортированы', 'success');
            } catch {
                showToast('Ошибка чтения файла', 'error');
            }
        };
        reader.readAsText(file);
    };
    input.click();
}

// === НАСТРОЙКИ ===

function openSettings() {
document.getElementById('settingsModal').classList.add('active');
renderAppLists();

    // Показываем секцию автозапуска только в Electron
    if (window.__electronApp) {
        document.getElementById('autostartSection').style.display = 'block';
        loadAutostartSetting();
    } else {
        document.getElementById('autostartSection').style.display = 'none';
    }
    
// Enter для добавления в списки
document.getElementById('whiteListInput').onkeypress = (e) => {
if (e.key === 'Enter') addListItem('white');
};
document.getElementById('blackListInput').onkeypress = (e) => {
if (e.key === 'Enter') addListItem('black');
};
}

function closeSettings() {
document.getElementById('settingsModal').classList.remove('active');
document.getElementById('qrSection').style.display = 'none';
document.getElementById('keyInputSection').style.display = 'none';
document.getElementById('scanQRSection').style.display = 'none';
}

function generateQRCode() {
const qrSection = document.getElementById('qrSection');
const qrcode = document.getElementById('qrcode');

qrcode.innerHTML = '';

new QRCode(qrcode, {
text: state.sessionKey,
width: 256,
height: 256
});

document.getElementById('keyDisplay').textContent = state.sessionKey;
qrSection.style.display = 'block';
document.getElementById('scanQRSection').style.display = 'none';
document.getElementById('keyInputSection').style.display = 'none';
}

function showSessionKey() {
const qrSection = document.getElementById('qrSection');
document.getElementById('qrcode').innerHTML = '';
document.getElementById('keyDisplay').textContent = state.sessionKey;
qrSection.style.display = 'block';
document.getElementById('scanQRSection').style.display = 'none';
document.getElementById('keyInputSection').style.display = 'none';
}

function startQRScanner() {
const scanSection = document.getElementById('scanQRSection');
scanSection.style.display = 'block';
document.getElementById('qrSection').style.display = 'none';
document.getElementById('keyInputSection').style.display = 'none';

const video = document.getElementById('qrVideo');
const canvas = document.getElementById('qrCanvas');
const ctx = canvas.getContext('2d');

navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
.then(stream => {
video.srcObject = stream;
video.play();
scanQRCode(video, canvas, ctx, stream);
})
.catch(err => {
showToast('Не удалось получить доступ к камере', 'error');
console.error('Camera error:', err);
});
}

function scanQRCode(video, canvas, ctx, stream) {
const scan = () => {
if (video.readyState === video.HAVE_ENOUGH_DATA) {
canvas.width = video.videoWidth;
canvas.height = video.videoHeight;
ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
const code = jsQR(imageData.data, imageData.width, imageData.height);

if (code) {
stream.getTracks().forEach(track => track.stop());
handleQRCodeScanned(code.data);
return;
}
}
requestAnimationFrame(scan);
};
scan();
}

function handleQRCodeScanned(key) {
document.getElementById('scanQRSection').style.display = 'none';

state.sessionKey = key;
localStorage.setItem('sessionKey', key);
showToast('Устройство успешно подключено!', 'success');
closeSettings();
// Переподключаемся к WebSocket с новым ключом
if (ws) {
ws.close();
}
connectWebSocket();
}

function showKeyInput() {
document.getElementById('keyInputSection').style.display = 'block';
document.getElementById('qrSection').style.display = 'none';
document.getElementById('scanQRSection').style.display = 'none';
}

function connectWithKey() {
const key = document.getElementById('keyInput').value.trim();
if (key) {
state.sessionKey = key;
localStorage.setItem('sessionKey', key);
showToast('Устройство успешно подключено!', 'success');
closeSettings();
// Переподключаемся к WebSocket с новым ключом
if (ws) {
ws.close();
}
connectWebSocket();
}
}

// === ХРАНИЛИЩЕ (сервер — единственный источник правды) ===

// In-memory кеш — актуален пока открыта вкладка
const cache = {
tasks: [],
sessions: {} // { 'sessions_2025-01-01': [...] }
};

function getTasks() {
return cache.tasks;
}

function saveTasks(tasks) {
cache.tasks = tasks;
syncData();
}

function getTodaySessions() {
return cache.sessions[`sessions_${state.currentDate}`] || [];
}

function saveTodaySessions(sessions) {
cache.sessions[`sessions_${state.currentDate}`] = sessions;
syncData();
}

function saveTodaySession(session) {
const sessions = getTodaySessions();
sessions.push(session);
saveTodaySessions(sessions);
}

function getSessionsForDate(dateStr) {
return cache.sessions[`sessions_${dateStr}`] || [];
}

// === WEBSOCKET СИНХРОНИЗАЦИЯ ===

function connectWebSocket() {
try {
// Закрываем старое соединение если оно ещё открыто/подключается
if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
ws.onclose = null; // Не триггерим reconnect от старого сокета
ws.close();
}
ws = new WebSocket(WS_URL);

ws.onopen = () => {
console.log('WebSocket connected');
// Присоединяемся к сессии
ws.send(JSON.stringify({
type: 'join',
sessionKey: state.sessionKey
}));

// Останавливаем попытки переподключения
if (reconnectInterval) {
clearInterval(reconnectInterval);
reconnectInterval = null;
}

// Запускаем heartbeat (каждые 5 секунд)
startHeartbeat();

// Синхронизируем локальные данные на сервер (чтобы другие клиенты получили)
setTimeout(() => syncData(), 500);
};

ws.onmessage = (event) => {
const message = JSON.parse(event.data);

switch (message.type) {
case 'init':
// Получаем начальные данные при подключении
applyRemoteData(message.data);
break;
case 'update':
// Получаем обновления от других устройств
if (message.from !== 'self') {
applyRemoteData(message.data);
}
break;
case 'timer_state':
// Получаем обновление состояния таймера
applyTimerState(message.data);
break;
case 'activity_status':
// Получаем статус активности от сервера
handleActivityStatus(message.status, message.windowTitle);
break;
case 'force_pause':
// Сервер принудительно ставит на паузу
handleForcePause(message.reason);
break;
case 'heartbeat_ack':
// Подтверждение heartbeat от сервера
console.log('Heartbeat acknowledged');
break;
case 'agent_status':
// Desktop Agent подключился/отключился
handleAgentStatus(message.connected);
break;
case 'notification_count':
updateNotifBadge(message.count);
loadNotificationCount();
break;
case 'team_updated':
loadTeam();
break;
case 'team_timer_update':
handleTeamTimerUpdate(message);
break;
}
};

ws.onerror = (error) => {
console.error('WebSocket error:', error);
};

ws.onclose = () => {
console.log('WebSocket disconnected');

// Останавливаем heartbeat
stopHeartbeat();

// Пытаемся переподключиться через 5 секунд
if (!reconnectInterval) {
reconnectInterval = setInterval(() => {
console.log('Attempting to reconnect...');
connectWebSocket();
}, 5000);
}
};
} catch (error) {
console.error('Failed to connect WebSocket:', error);
}
}

function syncData() {
if (ws && ws.readyState === WebSocket.OPEN) {
ws.send(JSON.stringify({
type: 'sync',
sessionKey: state.sessionKey,
tasks: cache.tasks,
sessions: cache.sessions,
date: state.currentDate
}));
}
}

function syncTimerState(action, data) {
if (ws && ws.readyState === WebSocket.OPEN) {
ws.send(JSON.stringify({
type: 'timer_sync',
sessionKey: state.sessionKey,
action: action,
data: data
}));
}
}

function applyTimerState(data) {
const { action, ...timerData } = data;

switch (action) {
case 'start': {
// При получении старта от другого устройства тоже выбираем сегодняшнюю дату
state.selectedDate = state.currentDate;
renderCalendar();
updateTasksTitle();
renderTasks();

// Запускаем таймер, даже если он уже был запущен
if (timerInterval) clearInterval(timerInterval);

state.timerRunning = true;
state.timerPaused = false;
state.currentSessionStart = timerData.sessionStart;
state.totalPausedTime = timerData.totalPausedTime || 0;

if (timerInterval) clearInterval(timerInterval);
timerInterval = setInterval(updateTimer, 1000);
updateTimer(); // Мгновенное обновление дисплея

// Создаём сессию если её нет
const sessions = getTodaySessions();
const hasActiveSession = sessions.length > 0 && 
!sessions[sessions.length - 1].end &&
sessions[sessions.length - 1].start === timerData.sessionStart;

if (!hasActiveSession && (sessions.length === 0 || sessions[sessions.length - 1].end)) {
const session = {
start: timerData.sessionStart,
pauses: []
};
saveTodaySession(session);
}

document.getElementById('startBtn').disabled = true;
document.getElementById('pauseBtn').disabled = false;
document.getElementById('pauseBtn').textContent = 'Пауза';
document.getElementById('stopBtn').disabled = false;
break;
}

case 'pause': {
// Игнорируем если мы только что возобновили (grace period)
if (Date.now() < resumeGraceUntil) {
console.log('applyTimerState: ignoring pause during grace period');
break;
}
// Ставим на паузу независимо от текущего состояния
state.timerPaused = true;
state.currentPauseStart = timerData.pauseStart;
state.totalPausedTime = timerData.totalPausedTime;

// Убеждаемся что таймер работает для паузы
if (!state.timerRunning) {
state.timerRunning = true;
state.currentSessionStart = timerData.sessionStart || Date.now();
}

if (timerInterval) {
clearInterval(timerInterval);
timerInterval = null;
}

// Сохраняем паузу в сессии
const sessions = getTodaySessions();
if (sessions.length > 0) {
const currentSession = sessions[sessions.length - 1];
// Проверяем что пауза ещё не добавлена
if (!currentSession.pauses.some(p => p.start === timerData.pauseStart)) {
currentSession.pauses.push({
start: timerData.pauseStart
});
saveTodaySessions(sessions);
}
}

document.getElementById('startBtn').disabled = true;
document.getElementById('pauseBtn').disabled = false;
// Сохраняем текст кнопки если авто-пауза активна
if (!autoPauseActive) {
document.getElementById('pauseBtn').textContent = 'Продолжить';
}
document.getElementById('stopBtn').disabled = false;

// Показываем время на момент паузы
if (state.currentPauseStart && state.currentSessionStart) {
const displayTime = (state.currentPauseStart - state.currentSessionStart) - state.totalPausedTime;
document.getElementById('timerDisplay').textContent = formatTime(Math.max(0, displayTime));
}
break;
}

case 'resume': {
// Не возобновляем если системная idle-пауза активна
if (window.__idlePaused) {
console.log('[TIMER_STATE] Ignoring resume — system idle pause active');
break;
}
// Возобновляем таймер независимо от текущего состояния
state.timerRunning = true;
state.timerPaused = false;
state.currentPauseStart = null;
state.currentSessionStart = timerData.sessionStart;
state.totalPausedTime = timerData.totalPausedTime;

if (timerInterval) clearInterval(timerInterval);
timerInterval = setInterval(updateTimer, 1000);
updateTimer(); // Мгновенное обновление дисплея

// Завершаем последнюю паузу в сессии
const sessions = getTodaySessions();
if (sessions.length > 0) {
const currentSession = sessions[sessions.length - 1];
if (currentSession && currentSession.pauses && currentSession.pauses.length > 0) {
const lastPause = currentSession.pauses[currentSession.pauses.length - 1];
if (!lastPause.end) {
const pauseDuration = Date.now() - lastPause.start;
lastPause.end = Date.now();
lastPause.duration = pauseDuration;
saveTodaySessions(sessions);
}
}
}

document.getElementById('startBtn').disabled = true;
document.getElementById('pauseBtn').disabled = false;
document.getElementById('pauseBtn').textContent = 'Пауза';
document.getElementById('stopBtn').disabled = false;
break;
}

case 'stop': {
// Останавливаем таймер независимо от текущего состояния
if (timerInterval) clearInterval(timerInterval);

// Завершаем текущую сессию если она есть
const sessions = getTodaySessions();
if (sessions.length > 0) {
const currentSession = sessions[sessions.length - 1];
if (!currentSession.end) {
currentSession.end = Date.now();
currentSession.duration = currentSession.end - currentSession.start;
saveTodaySessions(sessions);
}
}

state.timerRunning = false;
state.timerPaused = false;
state.currentSessionStart = null;
state.currentPauseStart = null;
state.elapsedTime = 0;
state.totalPausedTime = 0;

document.getElementById('timerDisplay').textContent = '00:00:00';
document.getElementById('startBtn').disabled = false;
document.getElementById('pauseBtn').disabled = true;
document.getElementById('pauseBtn').textContent = 'Пауза';
document.getElementById('stopBtn').disabled = true;

updateSelectedDateStats();
break;
}
}

// Сбрасываем флаг авто-паузы при синхронизации состояния
if (data.action === 'resume' || data.action === 'start') {
autoPauseActive = false;
document.getElementById('pauseBtn').textContent = 'Пауза';
}
}

function startHeartbeat() {
// Останавливаем предыдущий heartbeat если есть
stopHeartbeat();

// Отправляем heartbeat каждые 5 секунд
heartbeatInterval = setInterval(() => {
if (ws && ws.readyState === WebSocket.OPEN) {
ws.send(JSON.stringify({
type: 'heartbeat',
sessionKey: state.sessionKey,
tabVisible: isTabVisible,
hasFocus: hasWindowFocus
}));
}
}, 5000);
}

function stopHeartbeat() {
if (heartbeatInterval) {
clearInterval(heartbeatInterval);
heartbeatInterval = null;
}
}

function handleAgentStatus(connected) {
console.log(`Desktop Agent ${connected ? 'connected' : 'disconnected'}`);
agentConnected = connected;

const indicator = document.getElementById('activityIndicator');
if (connected) {
indicator.textContent = '🟢 Desktop Agent подключён';
indicator.className = 'activity-indicator working';
} else {
indicator.textContent = '⚪ Ожидание Desktop Agent...';
indicator.className = 'activity-indicator';
agentStatus = null;
}
}

function handleActivityStatus(status, windowTitle) {
console.log(`[ACTIVITY] status=${status}, window="${windowTitle}", idle=${window.__idlePaused || false}`);
agentStatus = status;

updateActivityIndicator(status, windowTitle);

// Если системная idle-пауза — не даём activity менять таймер
if (window.__idlePaused) {
console.log('[ACTIVITY] System idle pause active — ignoring activity status');
return;
}

// Если агент говорит distracted/idle и таймер идёт — ставим авто-паузу
if (status !== 'working' && state.timerRunning && !state.timerPaused && Date.now() >= resumeGraceUntil) {
console.log(`[ACTIVITY] Agent reports ${status} — auto-pausing`);
pauseTimer(true);

let message = 'Авто-Пауза';
if (status === 'distracted') message = `Авто-Пауза: обнаружена нецелевая активность (${windowTitle})`;
if (status === 'idle') message = 'Авто-Пауза: неактивность';
showToast(message, 'info');
}

// Если агент говорит working и была авто-пауза — возобновляем
if (status === 'working' && state.timerRunning && state.timerPaused && autoPauseActive && !manualPause) {
console.log('[ACTIVITY] Agent reports working — auto-resuming');
startTimer();
showToast(`Таймер возобновлён: ${windowTitle}`, 'success');
}
}

function handleForcePause(reason) {
console.log(`Force pause received: ${reason}`);

// Если вкладка активна и в фокусе — игнорируем
if (isTabVisible && hasWindowFocus) {
console.log('Tab is active — ignoring force_pause');
return;
}

// Если в grace period — игнорируем
if (Date.now() < resumeGraceUntil) {
console.log('Grace period — ignoring force_pause');
return;
}

if (state.timerRunning && !state.timerPaused) {
pauseTimer(true);

// Показываем уведомление
let message = 'Таймер приостановлен';
if (reason === 'distracted') {
message = 'Авто-Пауза: отвлечение обнаружено';
} else if (reason === 'idle') {
message = 'Авто-Пауза: неактивность';
} else if (reason === 'timeout') {
message = 'Авто-Пауза: потеря соединения';
}

showToast(message, 'info');
}
}

function updateActivityIndicator(status, windowTitle) {
// Создаем или обновляем индикатор активности в UI
let indicator = document.getElementById('activityIndicator');

if (!indicator) {
// Создаем индикатор если его нет
indicator = document.createElement('div');
indicator.id = 'activityIndicator';
indicator.className = 'activity-indicator';

// Вставляем после timerDisplay
const timerDisplay = document.getElementById('timerDisplay');
timerDisplay.parentNode.insertBefore(indicator, timerDisplay.nextSibling);
}

// Обновляем содержимое
let statusText = '';
let statusClass = '';

if (status === 'working') {
statusText = '🟢 Работа';
statusClass = 'working';
} else if (status === 'distracted') {
statusText = '🟡 Отвлечение';
statusClass = 'distracted';
} else if (status === 'idle') {
statusText = '🔴 Неактивен';
statusClass = 'idle';
}

if (windowTitle) {
statusText += `: ${windowTitle}`;
}

indicator.textContent = statusText;
indicator.className = `activity-indicator ${statusClass}`;
}

function applyRemoteData(data) {
if (!data) return;

if (data.tasks && Array.isArray(data.tasks)) {
    const local = cache.tasks || [];
    // Merge по id: remote побеждает для существующих, локальные уникальные сохраняются
    const remoteById = new Map(data.tasks.map(t => [t.id, t]));
    const localUnique = local.filter(t => !remoteById.has(t.id));
    cache.tasks = [...data.tasks, ...localUnique];
    renderTasks();
}

if (data.sessions) {
    // Merge сессий по датам: для каждой даты объединяем по startTime
    const local = cache.sessions || {};
    const remote = data.sessions;
    const merged = { ...local };
    for (const key of Object.keys(remote)) {
        const localArr = local[key] || [];
        const remoteArr = remote[key] || [];
        // Объединяем по startTime, remote побеждает при конфликте
        const byStart = new Map(localArr.map(s => [s.startTime, s]));
        for (const s of remoteArr) byStart.set(s.startTime, s);
        merged[key] = Array.from(byStart.values())
            .sort((a, b) => a.startTime - b.startTime);
    }
    cache.sessions = merged;
    updateSelectedDateStats();
    renderCalendar();
}
}

// === УВЕДОМЛЕНИЯ ===

function showToast(message, type = 'info') {
const toast = document.getElementById('toast');
toast.textContent = message;
toast.className = `toast ${type} show`;

setTimeout(() => {
toast.classList.remove('show');
}, 3000);
}

// Экспорт функций для глобального доступа (для onclick в HTML)
window.toggleTask = toggleTask;
window.deleteTask = deleteTask;
window.exportCSV = exportCSV;
window.exportJSON = exportJSON;
window.importJSON = importJSON;

// === УПРАВЛЕНИЕ СПИСКАМИ ПРИЛОЖЕНИЙ (white/black) ===

const DEFAULT_WHITE_LIST = [
'LinkTime', 'Visual Studio Code', 'Code.exe', 'Terminal', 'cmd.exe',
'PowerShell', 'Figma', 'Adobe Photoshop', 'Sublime Text', 'WebStorm',
'PyCharm', 'IntelliJ IDEA', 'Eclipse', 'Postman', 'Docker', 'Git', 'GitHub Desktop'
];

const DEFAULT_BLACK_LIST = [
'YouTube', 'Netflix', 'Facebook', 'Twitter', 'Instagram', 'TikTok',
'Reddit', 'Twitch', 'Steam', 'Discord - ', 'Telegram', 'WhatsApp'
];

function getAppList(type) {
const key = type === 'white' ? 'whiteList' : 'blackList';
const stored = localStorage.getItem(key);
if (stored) return JSON.parse(stored);
const defaults = type === 'white' ? DEFAULT_WHITE_LIST : DEFAULT_BLACK_LIST;
localStorage.setItem(key, JSON.stringify(defaults));
return defaults;
}

function saveAppList(type, list) {
const key = type === 'white' ? 'whiteList' : 'blackList';
localStorage.setItem(key, JSON.stringify(list));
}

function renderAppLists() {
renderListItems('white');
renderListItems('black');
}

// === АВТОЗАПУСК (только Electron) ===
function loadAutostartSetting() {
    const autostart = localStorage.getItem('autostart');
    const checkbox = document.getElementById('autostartCheckbox');
    if (checkbox) {
        checkbox.checked = autostart === 'true';
    }
}

function saveAutostartSetting() {
    const checkbox = document.getElementById('autostartCheckbox');
    if (!checkbox) return;
    
    const autostart = checkbox.checked;
    localStorage.setItem('autostart', autostart);
    
    // Electron main.js синхронизирует эту настройку автоматически
    showToast(autostart ? 'Автозапуск включен' : 'Автозапуск выключен', 'success');
}

function renderListItems(type) {
const container = document.getElementById(type + 'ListItems');
if (!container) return;
const items = getAppList(type);
container.innerHTML = items.map((item, i) => `
       <span class="list-tag ${type}">
           ${item}
           <button class="remove-tag" onclick="removeListItem('${type}', ${i})">×</button>
       </span>
   `).join('');
}

function addListItem(type) {
const input = document.getElementById(type + 'ListInput');
const value = input.value.trim();
if (!value) return;
const list = getAppList(type);
if (list.includes(value)) {
showToast('Уже есть в списке', 'error');
return;
}
list.push(value);
saveAppList(type, list);
renderListItems(type);
input.value = '';
syncData();
}

function removeListItem(type, index) {
const list = getAppList(type);
list.splice(index, 1);
saveAppList(type, list);
renderListItems(type);
syncData();
}

window.addListItem = addListItem;
window.removeListItem = removeListItem;

// === МИГРАЦИЯ ДАННЫХ ИЗ БРАУЗЕРА В БД СЕРВЕРА ===
// === СИНХРОНИЗАЦИЯ С СЕРВЕРОМ ===
async function migrateDataToServer() {
if (!state.sessionKey) {
showToast('Сначала создайте или введите ключ сессии', 'error');
return;
}
const migrateBtn = document.getElementById('migrateBtn');
migrateBtn.disabled = true;
migrateBtn.textContent = 'Загружаем...';
try {
const serverUrl = WS_URL.replace('wss://', 'https://').replace('ws://', 'http://');
const apiUrl = `${serverUrl}/api/data/${encodeURIComponent(state.sessionKey)}`;
const getResp = await fetch(apiUrl);
if (!getResp.ok) throw new Error(`Ошибка сервера: ${getResp.status}`);
const serverData = await getResp.json();
cache.tasks = serverData.tasks || [];
cache.sessions = serverData.sessions || {};
renderTasks();
updateSelectedDateStats();
renderCalendar();
showToast(`Загружено с сервера: ${cache.tasks.length} задач`, 'success');
} catch (error) {
console.error('Sync error:', error);
showToast('Ошибка загрузки: ' + error.message, 'error');
} finally {
migrateBtn.disabled = false;
migrateBtn.textContent = 'Перенести данные из браузера в базу';
}
}

// === ПРОФИЛЬ И КОМАНДЫ ===

let userProfile = null; // { userId, username, email }
let userTeam = null; // { team, members: [] }
let teamTimers = {}; // { userId: { action, sessionStart, totalPausedTime, ... } }

function getApiBase() {
  return WS_URL.replace('wss://', 'https://').replace('ws://', 'http://');
}

async function initUserProfile() {
  try {
    const res = await fetch(`${getApiBase()}/api/user/${state.sessionKey}`);
    userProfile = await res.json();
    updateAvatarDisplay();
    loadNotificationCount();
    loadTeam();
  } catch (e) {
    console.error('Profile init error:', e);
  }
}

function updateAvatarDisplay() {
  if (!userProfile) return;
  const letter = (userProfile.username || '?')[0].toUpperCase();
  
  // Header avatar
  const avatarBtn = document.getElementById('avatarBtn');
  if (userProfile.avatar) {
    avatarBtn.innerHTML = `<img src="${userProfile.avatar}" alt="Avatar" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  } else {
    avatarBtn.innerHTML = `<span class="avatar-letter">${letter}</span>`;
  }
}

function updateAvatarLetter() {
  // Deprecated - use updateAvatarDisplay instead
  updateAvatarDisplay();
}

// === КОМАНДА ===

async function loadTeam() {
  if (!userProfile) return;
  try {
    const res = await fetch(`${getApiBase()}/api/team/${state.sessionKey}`);
    userTeam = await res.json();
    renderTeam();
    updateShareTimeBtnLabel();
  } catch (e) {
    console.error('Team load error:', e);
  }
}

function updateShareTimeBtnLabel() {
  const btn = document.getElementById('burgerShareTime');
  if (!btn || !userTeam || !userTeam.members) return;
  const me = userTeam.members.find(m => m.user_id === userProfile.userId);
  if (me && me.sharing_time) {
    btn.textContent = '📊 Выключить шеринг времени';
  } else {
    btn.textContent = '📊 Поделиться временем с командой';
  }
}

function renderTeam() {
  const container = document.getElementById('teamSlots');
  
  let html = '';
  
  if (userTeam && userTeam.team) {
    const members = userTeam.members || [];
    const me = members.find(m => m.user_id === userProfile.userId);
    const others = members.filter(m => m.user_id !== userProfile.userId);
    
    // Сначала я
    if (me) {
      const avatarContent = userProfile.avatar 
        ? `<img src="${userProfile.avatar}" alt="${me.username}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
        : me.username[0].toUpperCase();
      html += `
        <div class="team-member-avatar me" data-user-id="${me.user_id}">
          ${avatarContent}
          <div class="member-tooltip">
            <div class="tooltip-username">${me.username} <span class="tooltip-you">(вы)</span></div>
          </div>
        </div>
      `;
    }
    
    // Потом остальные
    others.forEach(m => {
      const avatarContent = m.avatar
        ? `<img src="${m.avatar}" alt="${m.username}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
        : m.username[0].toUpperCase();
      
      const timer = teamTimers[m.user_id];
      const hasTimer = timer && m.sharing_time && timer.action && timer.action !== 'stop';
      
      const timerSection = hasTimer ? `
        <div class="tooltip-divider"></div>
        <div class="tooltip-timer-val" id="mtimer-${m.user_id}">${formatTimerFromState(timer)}</div>
        <div class="tooltip-work-label">За день: <span id="mwork-${m.user_id}">${formatWorkTimeForMember(timer)}</span></div>
      ` : '';

      // Зелёная точка на аватарке если шерит время
      const dot = (m.sharing_time && hasTimer) ? `<div class="member-sharing-dot"></div>` : '';

      html += `
        <div class="team-member-avatar" data-user-id="${m.user_id}">
          ${avatarContent}
          ${dot}
          <div class="member-tooltip">
            <div class="tooltip-username">${m.username}</div>
            ${timerSection}
          </div>
        </div>
      `;
    });
  }
  
  // Слот + показываем ВСЕГДА
  html += `
    <div class="team-add-slot" onclick="openInviteModal()" title="Пригласить в команду">+</div>
  `;
  
  container.innerHTML = html;
  startTeamTimerUpdates();
}

function formatWorkTimeForMember(timer) {
  if (!timer) return '00:00:00';
  const completed = timer.completedWorkMs || 0;
  // Добавляем текущую сессию если таймер идёт
  if ((timer.action === 'start' || timer.action === 'resume') && timer.sessionStart) {
    const running = Date.now() - timer.sessionStart - (timer.totalPausedTime || 0);
    return formatTime(completed + Math.max(0, running));
  }
  // На паузе — добавляем время до момента паузы
  if (timer.action === 'pause' && timer.pauseStart && timer.sessionStart) {
    const running = timer.pauseStart - timer.sessionStart - (timer.totalPausedTime || 0);
    return formatTime(completed + Math.max(0, running));
  }
  return formatTime(completed);
}

function formatTimerFromState(timerState) {
  if (!timerState || timerState.action === 'stop') return '00:00:00';
  
  const now = Date.now();
  let elapsed = 0;
  
  if (timerState.action === 'start' || timerState.action === 'resume') {
    elapsed = now - timerState.sessionStart - (timerState.totalPausedTime || 0);
  } else if (timerState.action === 'pause' && timerState.pauseStart) {
    elapsed = timerState.pauseStart - timerState.sessionStart - (timerState.totalPausedTime || 0);
  }
  
  return formatTime(Math.max(0, elapsed));
}

let teamTimerInterval = null;

function startTeamTimerUpdates() {
  if (teamTimerInterval) clearInterval(teamTimerInterval);
  
  teamTimerInterval = setInterval(() => {
    Object.entries(teamTimers).forEach(([userId, timer]) => {
      if (!timer || timer.action === 'stop' || timer.action === 'pause') return;
      
      const timerEl = document.getElementById(`mtimer-${userId}`);
      const workEl = document.getElementById(`mwork-${userId}`);
      
      if (timerEl) timerEl.textContent = formatTimerFromState(timer);
      if (workEl) workEl.textContent = formatWorkTimeForMember(timer);
    });
  }, 1000);
}

function handleTeamTimerUpdate(data) {
  const { userId, timerState, completedWorkMs } = data;
  teamTimers[userId] = { ...timerState, completedWorkMs: completedWorkMs || 0 };
  
  // Обновляем тултип без полного перерендера
  const timerEl = document.getElementById(`mtimer-${userId}`);
  const workEl = document.getElementById(`mwork-${userId}`);
  
  if (timerEl) {
    timerEl.textContent = formatTimerFromState(timerState);
  }
  if (workEl) {
    workEl.textContent = formatWorkTimeForMember(teamTimers[userId]);
  }
  
  // Если элементы не существуют (тултип не создан) — перерисовываем команду
  if (!timerEl || timerState.action === 'stop') {
    loadTeam();
  }
}

// === БУРГЕР ===

function toggleBurger() {
  document.getElementById('burgerDropdown').classList.toggle('open');
  document.getElementById('notificationsPanel').style.display = 'none';
}
function closeBurger() {
  document.getElementById('burgerDropdown').classList.remove('open');
}

// === УВЕДОМЛЕНИЯ ===

async function loadNotificationCount() {
  if (!userProfile) return;
  try {
    const res = await fetch(`${getApiBase()}/api/invitations/${state.sessionKey}`);
    const data = await res.json();
    updateNotifBadge(data.count);
    renderNotifications(data.invitations);
  } catch (e) {}
}

function updateNotifBadge(count) {
  const badge = document.getElementById('burgerBadge');
  const bellBadge = document.getElementById('bellBadge');
  if (count > 0) {
    badge.style.display = 'flex';
    badge.textContent = count;
    bellBadge.style.display = 'flex';
    bellBadge.textContent = count;
  } else {
    badge.style.display = 'none';
    bellBadge.style.display = 'none';
  }
}

function toggleNotifications() {
  const panel = document.getElementById('notificationsPanel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function renderNotifications(invitations) {
  const panel = document.getElementById('notificationsPanel');
  if (!invitations || invitations.length === 0) {
    panel.innerHTML = '<div class="notif-empty">Нет новых уведомлений</div>';
    return;
  }
  panel.innerHTML = invitations.map(inv => `
    <div class="notif-item">
      <strong>${inv.from_username}</strong> приглашает вас в команду
      <div class="notif-actions">
        <button class="notif-accept" onclick="respondInvite(${inv.id}, 'accept')">Принять</button>
        <button class="notif-decline" onclick="respondInvite(${inv.id}, 'decline')">Отклонить</button>
      </div>
    </div>
  `).join('');
}

async function respondInvite(id, action) {
  try {
    const res = await fetch(`${getApiBase()}/api/invite/${id}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey: state.sessionKey, action })
    });
    const data = await res.json();
    if (data.ok) {
      showToast(action === 'accept' ? 'Приглашение принято!' : 'Приглашение отклонено', 'info');
      loadNotificationCount();
      if (action === 'accept') loadTeam();
    }
  } catch (e) {
    showToast('Ошибка', 'error');
  }
}

window.respondInvite = respondInvite;
window.openInviteModal = openInviteModal;

// === ПРОФИЛЬ ===

function openProfile() {
  if (!userProfile) return;
  document.getElementById('profileUserId').textContent = userProfile.userId;
  document.getElementById('profileUsername').value = userProfile.username || '';
  document.getElementById('profileEmail').value = userProfile.email || '';
  document.getElementById('usernameHint').textContent = '';
  
  // Аватар
  const preview = document.getElementById('profileAvatarPreview');
  const letter = document.getElementById('profileAvatarLetter');
  const removeBtn = document.getElementById('removeAvatar');
  
  if (userProfile.avatar) {
    preview.innerHTML = `<img src="${userProfile.avatar}" alt="Avatar">`;
    removeBtn.style.display = 'inline-block';
  } else {
    preview.innerHTML = `<span id="profileAvatarLetter">${(userProfile.username||'?')[0].toUpperCase()}</span>`;
    removeBtn.style.display = 'none';
  }
  
  document.getElementById('profileModal').classList.add('active');
}
function closeProfile() {
  document.getElementById('profileModal').classList.remove('active');
}

async function saveUsername() {
  const username = document.getElementById('profileUsername').value.trim();
  const hint = document.getElementById('usernameHint');
  try {
    const res = await fetch(`${getApiBase()}/api/user/${state.sessionKey}/username`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username })
    });
    const data = await res.json();
    if (data.ok) {
      userProfile.username = username;
      updateAvatarLetter();
      hint.style.color = '#10b981';
      hint.textContent = 'Имя сохранено!';
    } else {
      hint.style.color = '#ef4444';
      hint.textContent = data.error || 'Ошибка';
    }
  } catch (e) {
    hint.style.color = '#ef4444';
    hint.textContent = 'Ошибка соединения';
  }
}

async function saveEmail() {
  const email = document.getElementById('profileEmail').value.trim();
  try {
    await fetch(`${getApiBase()}/api/user/${state.sessionKey}/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    userProfile.email = email;
    showToast('Email сохранён', 'success');
  } catch (e) {
    showToast('Ошибка', 'error');
  }
}

async function handleAvatarUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 500000) {
    showToast('Файл слишком большой (макс 500 КБ)', 'error');
    return;
  }
  
  const reader = new FileReader();
  reader.onload = async (ev) => {
    const base64 = ev.target.result;
    try {
      const res = await fetch(`${getApiBase()}/api/user/${state.sessionKey}/avatar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar: base64 })
      });
      const data = await res.json();
      if (data.ok) {
        userProfile.avatar = base64;
        updateAvatarDisplay();
        document.getElementById('profileAvatarPreview').innerHTML = `<img src="${base64}" alt="Avatar">`;
        document.getElementById('removeAvatar').style.display = 'inline-block';
        showToast('Аватар обновлён!', 'success');
      } else {
        showToast(data.error || 'Ошибка', 'error');
      }
    } catch (e) {
      showToast('Ошибка загрузки', 'error');
    }
  };
  reader.readAsDataURL(file);
}

async function removeAvatar() {
  try {
    await fetch(`${getApiBase()}/api/user/${state.sessionKey}/avatar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatar: null })
    });
    userProfile.avatar = null;
    updateAvatarDisplay();
    const letter = (userProfile.username||'?')[0].toUpperCase();
    document.getElementById('profileAvatarPreview').innerHTML = `<span id="profileAvatarLetter">${letter}</span>`;
    document.getElementById('removeAvatar').style.display = 'none';
    showToast('Аватар удалён', 'info');
  } catch (e) {
    showToast('Ошибка', 'error');
  }
}

// === ПРИГЛАШЕНИЯ ===

function openInviteModal() {
  document.getElementById('inviteQuery').value = '';
  document.getElementById('inviteHint').textContent = '';
  document.getElementById('inviteModal').classList.add('active');
}
function closeInviteModal() {
  document.getElementById('inviteModal').classList.remove('active');
}

async function sendInvite() {
  const query = document.getElementById('inviteQuery').value.trim();
  const hint = document.getElementById('inviteHint');
  if (!query) { hint.style.color = '#ef4444'; hint.textContent = 'Введите ID или имя'; return; }
  try {
    const res = await fetch(`${getApiBase()}/api/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromSessionKey: state.sessionKey, toQuery: query })
    });
    const data = await res.json();
    if (data.ok) {
      hint.style.color = '#10b981';
      hint.textContent = 'Приглашение отправлено!';
    } else {
      hint.style.color = '#ef4444';
      hint.textContent = data.error || 'Ошибка';
    }
  } catch (e) {
    hint.style.color = '#ef4444';
    hint.textContent = 'Ошибка соединения';
  }
}

// === ШЕРИНГ ВРЕМЕНИ ===

function openShareTimeModal() {
  // Если уже включён — сразу выключаем без модалки
  if (userTeam && userTeam.members) {
    const me = userTeam.members.find(m => m.user_id === userProfile.userId);
    if (me && me.sharing_time) {
      disableShareTime();
      return;
    }
  }
  document.getElementById('shareTimeModal').classList.add('active');
}
function closeShareTimeModal() {
  document.getElementById('shareTimeModal').classList.remove('active');
}

async function disableShareTime() {
  try {
    const res = await fetch(`${getApiBase()}/api/team/sharing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey: state.sessionKey, enabled: false })
    });
    const data = await res.json();
    if (data.ok) {
      showToast('Шеринг времени выключен', 'info');
      loadTeam();
    }
  } catch (e) {
    showToast('Ошибка', 'error');
  }
}

async function confirmShareTime() {
  try {
    const res = await fetch(`${getApiBase()}/api/team/sharing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey: state.sessionKey, enabled: true })
    });
    const data = await res.json();
    if (data.ok) {
      showToast('Шеринг времени включён!', 'success');
      closeShareTimeModal();
      loadTeam();
    }
  } catch (e) {
    showToast('Ошибка', 'error');
  }
}

// WS: получаем уведомление о новом приглашении
// (добавляется в обработчик onmessage)

// === MOBILE TAB NAVIGATION ===
(function initMobileNav() {
const nav = document.getElementById('mobileNav');
if (!nav) return;

const buttons = nav.querySelectorAll('.mobile-nav-item');
const sections = document.querySelectorAll('[data-tab-content]');

function switchTab(tabName) {
buttons.forEach(btn => {
btn.classList.toggle('active', btn.dataset.tab === tabName);
});
sections.forEach(sec => {
if (sec.dataset.tabContent === tabName) {
sec.classList.add('tab-active');
sec.style.display = '';
} else {
sec.classList.remove('tab-active');
// On mobile, hide non-active tabs
if (window.innerWidth <= 768) {
sec.style.display = 'none';
}
}
});
}

buttons.forEach(btn => {
btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// Reset tabs when resizing to desktop
window.addEventListener('resize', () => {
if (window.innerWidth > 768) {
sections.forEach(sec => sec.style.display = '');
} else {
const activeTab = nav.querySelector('.mobile-nav-item.active');
if (activeTab) switchTab(activeTab.dataset.tab);
}
});

// Init: on mobile show only timer
if (window.innerWidth <= 768) {
switchTab('timer');
}
})();

function openBoardOverlay() {
  const overlay = document.getElementById('board-overlay');
  const iframe  = document.getElementById('board-iframe');
  const url = `board.html?sessionKey=${encodeURIComponent(state.sessionKey)}&date=${state.selectedDate}`;
  iframe.src = url;
  overlay.style.display = 'block';
}

function closeBoardOverlay() {
  const overlay = document.getElementById('board-overlay');
  overlay.style.animation = 'none';
  overlay.style.opacity = '0';
  overlay.style.transform = 'scale(0.98)';
  overlay.style.transition = 'opacity .25s,transform .25s';
  setTimeout(() => {
    overlay.style.display = 'none';
    overlay.style.opacity = '';
    overlay.style.transform = '';
    overlay.style.transition = '';
    document.getElementById('board-iframe').src = 'about:blank';
  }, 260);
}

function getBoardTasks() {
  return cache.tasks.filter(t => t.date === state.selectedDate);
}

function openBoard() {
  const overlay = document.getElementById('boardOverlay');
  overlay.classList.add('open');
  document.getElementById('boardSubtitle').textContent =
    state.selectedDate === state.currentDate ? 'Сегодня' :
    new Date(state.selectedDate + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  renderBoard();
}

function closeBoard() {
  document.getElementById('boardOverlay').classList.remove('open');
}

function renderBoard() {
  const cols = { todo: [], in_progress: [], review: [], done: [] };
  getBoardTasks().forEach(t => {
    const status = t.boardStatus || (t.completed ? 'done' : 'todo');
    if (cols[status]) cols[status].push(t);
    else cols.todo.push(t);
  });

  Object.entries(cols).forEach(([status, tasks]) => {
    const container = document.getElementById(`col-${status}`);
    const counter   = document.getElementById(`col-count-${status}`);
    if (!container) return;
    counter.textContent = tasks.length;
    container.innerHTML = tasks.map(t => renderCard(t)).join('');

    // Drag events на карточки
    container.querySelectorAll('.board-card').forEach(card => {
      card.addEventListener('dragstart', onCardDragStart);
      card.addEventListener('dragend',   onCardDragEnd);
    });

    // Drop zone на колонку
    container.addEventListener('dragover', onColDragOver);
    container.addEventListener('dragleave', onColDragLeave);
    container.addEventListener('drop', onColDrop);
  });
}

function renderCard(task) {
  const priority = task.boardPriority || 'medium';
  const color    = task.boardColor || '';
  const desc     = task.boardDesc  || '';
  const date     = new Date(task.id).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const colorBar = color ? `<div class="card-color-bar" style="background:${color}"></div>` : '';
  const priorityLabels = { low: 'Низкий', medium: 'Средний', high: 'Высокий' };

  return `
    <div class="board-card" draggable="true" data-card-id="${task.id}">
      ${colorBar}
      <div class="card-top">
        <div class="card-title">${escapeHTML(task.text)}</div>
        <div class="card-actions">
          <button class="card-action-btn" onclick="editCard(${task.id})" title="Редактировать">✏️</button>
          <button class="card-action-btn delete" onclick="deleteCard(${task.id})" title="Удалить">🗑</button>
        </div>
      </div>
      ${desc ? `<div class="card-desc">${escapeHTML(desc)}</div>` : ''}
      <div class="card-footer">
        <span class="card-priority ${priority}">${priorityLabels[priority]}</span>
        <span class="card-time">${date}</span>
      </div>
    </div>`;
}

// Drag & Drop
function onCardDragStart(e) {
  dragSrcCardId = e.currentTarget.dataset.cardId;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}
function onCardDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.board-col').forEach(c => c.classList.remove('drag-over'));
}
function onColDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const col = e.currentTarget.closest('.board-col');
  if (col) col.classList.add('drag-over');
}
function onColDragLeave(e) {
  const col = e.currentTarget.closest('.board-col');
  if (col) col.classList.remove('drag-over');
}
function onColDrop(e) {
  e.preventDefault();
  const col = e.currentTarget.closest('.board-col');
  if (col) col.classList.remove('drag-over');
  const newStatus = e.currentTarget.dataset.status;
  if (!dragSrcCardId || !newStatus) return;

  const tasks = getTasks();
  const task = tasks.find(t => t.id === Number(dragSrcCardId));
  if (task) {
    task.boardStatus = newStatus;
    task.completed = newStatus === 'done';
    if (task.completed && !task.completedAt) task.completedAt = Date.now();
    saveTasks(tasks);
    renderBoard();
    renderTasks();
    updateSelectedDateStats();
  }
  dragSrcCardId = null;
}

// Card modal
function openCardModal(taskId, status) {
  boardEditingCardId = taskId;
  document.getElementById('cardModalTitle').textContent = taskId ? 'Редактировать' : 'Новая задача';
  document.getElementById('cardTitleInput').value   = '';
  document.getElementById('cardDescInput').value    = '';
  document.getElementById('cardStatusSelect').value = status || 'todo';
  document.querySelectorAll('.priority-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.priority-btn[data-priority="medium"]').classList.add('active');
  document.querySelectorAll('.color-dot').forEach(b => b.classList.remove('active'));
  document.querySelector('.color-dot[data-color=""]').classList.add('active');

  if (taskId) {
    const task = getTasks().find(t => t.id === Number(taskId));
    if (task) {
      document.getElementById('cardTitleInput').value   = task.text;
      document.getElementById('cardDescInput').value    = task.boardDesc || '';
      document.getElementById('cardStatusSelect').value = task.boardStatus || (task.completed ? 'done' : 'todo');
      document.querySelectorAll('.priority-btn').forEach(b => b.classList.remove('active'));
      const pb = document.querySelector(`.priority-btn[data-priority="${task.boardPriority || 'medium'}"]`);
      if (pb) pb.classList.add('active');
      document.querySelectorAll('.color-dot').forEach(b => b.classList.remove('active'));
      const cb = document.querySelector(`.color-dot[data-color="${task.boardColor || ''}"]`);
      if (cb) cb.classList.add('active');
    }
  }

  document.getElementById('cardModal').classList.add('open');
  document.getElementById('cardTitleInput').focus();
}

function closeCardModal() {
  document.getElementById('cardModal').classList.remove('open');
  boardEditingCardId = null;
}

function saveCard() {
  const title    = document.getElementById('cardTitleInput').value.trim();
  if (!title) { document.getElementById('cardTitleInput').focus(); return; }
  const desc     = document.getElementById('cardDescInput').value.trim();
  const status   = document.getElementById('cardStatusSelect').value;
  const priority = document.querySelector('.priority-btn.active')?.dataset.priority || 'medium';
  const color    = document.querySelector('.color-dot.active')?.dataset.color || '';

  const tasks = getTasks();
  if (boardEditingCardId) {
    const task = tasks.find(t => t.id === Number(boardEditingCardId));
    if (task) {
      task.text          = title;
      task.boardDesc     = desc;
      task.boardStatus   = status;
      task.boardPriority = priority;
      task.boardColor    = color;
      task.completed     = status === 'done';
    }
  } else {
    tasks.push({
      id:            Date.now(),
      text:          title,
      completed:     status === 'done',
      date:          state.selectedDate,
      boardDesc:     desc,
      boardStatus:   status,
      boardPriority: priority,
      boardColor:    color,
    });
  }
  saveTasks(tasks);
  renderBoard();
  renderTasks();
  updateSelectedDateStats();
  closeCardModal();
}

function editCard(taskId) { openCardModal(taskId, null); }

function deleteCard(taskId) {
  const tasks = getTasks().filter(t => t.id !== Number(taskId));
  saveTasks(tasks);
  renderBoard();
  renderTasks();
  updateSelectedDateStats();
}

window.editCard   = editCard;
window.deleteCard = deleteCard;
