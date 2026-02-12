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
    totalPausedTime: 0
};

let timerInterval = null;
let ws = null;
let reconnectInterval = null;
let heartbeatInterval = null;
const WS_URL = 'https://linktime.onrender.com';

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
    // Получаем или создаём ключ сессии
    state.sessionKey = localStorage.getItem('sessionKey');
    if (!state.sessionKey) {
        state.sessionKey = generateSessionKey();
        localStorage.setItem('sessionKey', state.sessionKey);
    }
    
    // Подключаемся к WebSocket серверу
    connectWebSocket();
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

    // Задачи
    document.getElementById('addTaskBtn').addEventListener('click', showTaskInput);
    document.getElementById('saveTaskBtn').addEventListener('click', saveTask);
    document.getElementById('cancelTaskBtn').addEventListener('click', hideTaskInput);
    document.getElementById('taskText').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') saveTask();
    });

    // Настройки
    document.getElementById('settingsBtn').addEventListener('click', openSettings);
    document.getElementById('closeSettings').addEventListener('click', closeSettings);
    document.getElementById('generateQR').addEventListener('click', generateQRCode);
    document.getElementById('showKey').addEventListener('click', showSessionKey);
    document.getElementById('scanQR').addEventListener('click', startQRScanner);
    document.getElementById('enterKey').addEventListener('click', showKeyInput);
    document.getElementById('connectKey').addEventListener('click', connectWithKey);

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
    // Отменяем обратный отсчёт авто-паузы
    if (autoPauseTimeout) {
        clearTimeout(autoPauseTimeout);
        autoPauseTimeout = null;
    }
    
    sendBrowserEvent('browser_focus');
    requestServerState();
    
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
        
        document.getElementById('pauseBtn').textContent = 'Пауза';
        document.getElementById('pauseBtn').disabled = false;
        
        syncTimerState('resume', {
            sessionStart: state.currentSessionStart,
            totalPausedTime: state.totalPausedTime
        });
        
        showToast('Таймер возобновлён', 'success');
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
        manualPause = false;
        autoPauseActive = false;
        
        // Создаём новую сессию
        const session = {
            start: state.currentSessionStart,
            pauses: []
        };
        
        saveTodaySession(session);
        
        timerInterval = setInterval(updateTimer, 1000);
        
        document.getElementById('startBtn').disabled = true;
        document.getElementById('pauseBtn').disabled = false;
        document.getElementById('stopBtn').disabled = false;
        
        // Синхронизируем старт таймера
        syncTimerState('start', {
            sessionStart: state.currentSessionStart
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
    }
}

function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// === ЗАДАЧИ ===

function showTaskInput() {
    document.getElementById('taskInput').style.display = 'block';
    document.getElementById('taskText').focus();
}

function hideTaskInput() {
    document.getElementById('taskInput').style.display = 'none';
    document.getElementById('taskText').value = '';
}

function saveTask() {
    const taskText = document.getElementById('taskText').value.trim();
    if (taskText) {
        const task = {
            id: Date.now(),
            text: taskText,
            completed: false,
            date: state.selectedDate // Сохраняем задачу для выбранной даты
        };
        
        const tasks = getTasks();
        tasks.push(task);
        saveTasks(tasks);
        
        hideTaskInput();
        renderTasks();
        updateSelectedDateStats();
        showToast('Задача добавлена!', 'success');
    }
}

function toggleTask(taskId) {
    const tasks = getTasks();
    const task = tasks.find(t => t.id === taskId);
    if (task) {
        task.completed = !task.completed;
        saveTasks(tasks);
        renderTasks();
        updateSelectedDateStats();
        if (task.completed) {
            showToast('Задача выполнена! 🎉', 'success');
        }
    }
}

function deleteTask(taskId) {
    const taskItem = document.querySelector(`[data-task-id="${taskId}"]`);
    if (taskItem) {
        taskItem.classList.add('removing');
        setTimeout(() => {
            const tasks = getTasks().filter(t => t.id !== taskId);
            saveTasks(tasks);
            renderTasks();
            updateSelectedDateStats();
            showToast('Задача удалена', 'info');
        }, 300);
    }
}

function renderTasks() {
    const tasks = getTasks().filter(t => t.date === state.selectedDate);
    const tasksList = document.getElementById('tasksList');
    
    if (tasks.length === 0) {
        tasksList.innerHTML = '<li style="text-align: center; color: rgba(255, 255, 255, 0.5); padding: 20px;">Нет задач на эту дату</li>';
        return;
    }
    
    tasksList.innerHTML = tasks.map(task => `
        <li class="task-item ${task.completed ? 'completed' : ''}" data-task-id="${task.id}">
            <input type="checkbox" ${task.completed ? 'checked' : ''} onchange="toggleTask(${task.id})">
            <span>${task.text}</span>
            <button onclick="deleteTask(${task.id})">Удалить</button>
        </li>
    `).join('');
}

function updateTasksTitle() {
    const dateObj = new Date(state.selectedDate + 'T00:00:00');
    const today = new Date().toISOString().split('T')[0];
    
    let titleText;
    if (state.selectedDate === today) {
        titleText = 'Задачи на сегодня';
    } else {
        titleText = 'Задачи на ' + dateObj.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    }
    
    document.getElementById('tasksTitle').textContent = titleText;
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
    const sessions = JSON.parse(localStorage.getItem(`sessions_${dateStr}`) || '[]');
    const tasks = getTasks().filter(t => t.date === dateStr);
    
    let totalWorkTime = 0;
    let totalPauseTime = 0;
    
    sessions.forEach(session => {
        if (session.end) {
            let sessionTime = session.end - session.start;
            session.pauses.forEach(pause => {
                if (pause.duration) {
                    totalPauseTime += pause.duration;
                    sessionTime -= pause.duration;
                }
            });
            totalWorkTime += sessionTime;
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

// === НАСТРОЙКИ ===

function openSettings() {
    document.getElementById('settingsModal').classList.add('active');
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

// === ХРАНИЛИЩЕ ===

function getTasks() {
    return JSON.parse(localStorage.getItem('tasks') || '[]');
}

function saveTasks(tasks) {
    localStorage.setItem('tasks', JSON.stringify(tasks));
    syncData();
}

function getTodaySessions() {
    return JSON.parse(localStorage.getItem(`sessions_${state.currentDate}`) || '[]');
}

function saveTodaySessions(sessions) {
    localStorage.setItem(`sessions_${state.currentDate}`, JSON.stringify(sessions));
    syncData();
}

function saveTodaySession(session) {
    const sessions = getTodaySessions();
    sessions.push(session);
    saveTodaySessions(sessions);
}

// === WEBSOCKET СИНХРОНИЗАЦИЯ ===

function connectWebSocket() {
    try {
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
        const tasks = getTasks();
        const allSessions = {};
        
        // Собираем все сессии со всех дат
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith('sessions_')) {
                allSessions[key] = JSON.parse(localStorage.getItem(key));
            }
        }
        
        ws.send(JSON.stringify({
            type: 'sync',
            sessionKey: state.sessionKey,
            tasks: tasks,
            sessions: allSessions,
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
            state.totalPausedTime = 0;
            
            timerInterval = setInterval(updateTimer, 1000);
            
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
            document.getElementById('pauseBtn').textContent = 'Продолжить';
            document.getElementById('stopBtn').disabled = false;
            break;
        }
            
        case 'resume': {
            // Возобновляем таймер независимо от текущего состояния
            state.timerRunning = true;
            state.timerPaused = false;
            state.currentPauseStart = null;
            state.currentSessionStart = timerData.sessionStart;
            state.totalPausedTime = timerData.totalPausedTime;
            
            if (timerInterval) clearInterval(timerInterval);
            timerInterval = setInterval(updateTimer, 1000);
            
            // Завершаем последнюю паузу в сессии
            const sessions = getTodaySessions();
            if (sessions.length > 0) {
                const currentSession = sessions[sessions.length - 1];
                if (currentSession.pauses.length > 0) {
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
    console.log(`Activity status received: ${status} (${windowTitle})`);
    agentStatus = status; // Сохраняем статус агента
    
    // Обновляем UI
    updateActivityIndicator(status, windowTitle);
    
    // Если агент говорит distracted/idle и таймер идёт — ставим авто-паузу
    if (status !== 'working' && state.timerRunning && !state.timerPaused && Date.now() >= resumeGraceUntil) {
        console.log(`Agent reports ${status} — auto-pausing`);
        pauseTimer(true);
        
        let message = 'Авто-Пауза';
        if (status === 'distracted') message = `Авто-Пауза: обнаружена нецелевая активность (${windowTitle})`;
        if (status === 'idle') message = 'Авто-Пауза: неактивность';
        showToast(message, 'info');
    }
    
    // Если агент говорит working и была авто-пауза — возобновляем
    if (status === 'working' && state.timerRunning && state.timerPaused && autoPauseActive && !manualPause) {
        console.log('Agent reports working — auto-resuming');
        startTimer();
        showToast(`Таймер возобновлён: ${windowTitle}`, 'success');
    }
}

function handleForcePause(reason) {
    console.log(`Force pause received: ${reason}`);
    
    if (state.timerRunning && !state.timerPaused && Date.now() >= resumeGraceUntil) {
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
    
    // Применяем задачи только если они изменились
    if (data.tasks) {
        const currentTasks = localStorage.getItem('tasks');
        const newTasks = JSON.stringify(data.tasks);
        if (currentTasks !== newTasks) {
            localStorage.setItem('tasks', newTasks);
            renderTasks();
        }
    }
    
    // Применяем сессии
    if (data.sessions) {
        Object.keys(data.sessions).forEach(key => {
            localStorage.setItem(key, JSON.stringify(data.sessions[key]));
        });
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
