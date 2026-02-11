// Состояние приложения
let state = {
    timerRunning: false,
    timerPaused: false,
    currentSessionStart: null,
    currentPauseStart: null,
    elapsedTime: 0,
    sessionKey: null,
    currentDate: new Date().toISOString().split('T')[0]
};

let timerInterval = null;
let ws = null;
let reconnectInterval = null;
const WS_URL = 'https://linktime.onrender.com';

// Инициализация
document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
    setupEventListeners();
    loadTodayData();
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
    document.getElementById('pauseBtn').addEventListener('click', pauseTimer);
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
    document.getElementById('enterKey').addEventListener('click', showKeyInput);
    document.getElementById('connectKey').addEventListener('click', connectWithKey);

    // Календарь
    document.getElementById('prevMonth').addEventListener('click', () => changeMonth(-1));
    document.getElementById('nextMonth').addEventListener('click', () => changeMonth(1));
}

// === ТАЙМЕР ===

function startTimer() {
    if (!state.timerRunning) {
        state.timerRunning = true;
        state.currentSessionStart = Date.now();
        
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
    } else if (state.timerPaused) {
        // Возобновление после паузы
        const pauseDuration = Date.now() - state.currentPauseStart;
        const sessions = getTodaySessions();
        const currentSession = sessions[sessions.length - 1];
        currentSession.pauses[currentSession.pauses.length - 1].end = Date.now();
        currentSession.pauses[currentSession.pauses.length - 1].duration = pauseDuration;
        
        saveTodaySessions(sessions);
        
        state.timerPaused = false;
        state.currentPauseStart = null;
        
        document.getElementById('pauseBtn').textContent = 'Пауза';
        updateTodayStats();
    }
}

function pauseTimer() {
    if (state.timerRunning && !state.timerPaused) {
        state.timerPaused = true;
        state.currentPauseStart = Date.now();
        
        // Добавляем паузу к текущей сессии
        const sessions = getTodaySessions();
        const currentSession = sessions[sessions.length - 1];
        currentSession.pauses.push({
            start: state.currentPauseStart
        });
        
        saveTodaySessions(sessions);
        
        document.getElementById('pauseBtn').textContent = 'Продолжить';
    }
}

function stopTimer() {
    if (state.timerRunning) {
        // Если была активна пауза, завершаем её
        if (state.timerPaused) {
            const sessions = getTodaySessions();
            const currentSession = sessions[sessions.length - 1];
            const pauseDuration = Date.now() - state.currentPauseStart;
            currentSession.pauses[currentSession.pauses.length - 1].end = Date.now();
            currentSession.pauses[currentSession.pauses.length - 1].duration = pauseDuration;
            saveTodaySessions(sessions);
        }
        
        // Завершаем сессию
        const sessions = getTodaySessions();
        const currentSession = sessions[sessions.length - 1];
        currentSession.end = Date.now();
        currentSession.duration = currentSession.end - currentSession.start;
        
        saveTodaySessions(sessions);
        
        clearInterval(timerInterval);
        state.timerRunning = false;
        state.timerPaused = false;
        state.currentSessionStart = null;
        state.currentPauseStart = null;
        state.elapsedTime = 0;
        
        document.getElementById('timerDisplay').textContent = '00:00:00';
        document.getElementById('startBtn').disabled = false;
        document.getElementById('pauseBtn').disabled = true;
        document.getElementById('pauseBtn').textContent = 'Пауза';
        document.getElementById('stopBtn').disabled = true;
        
        updateTodayStats();
        showToast('Сессия завершена!', 'success');
    }
}

function updateTimer() {
    if (state.timerRunning && !state.timerPaused) {
        state.elapsedTime = Date.now() - state.currentSessionStart;
        
        // Вычитаем время пауз
        const sessions = getTodaySessions();
        const currentSession = sessions[sessions.length - 1];
        let totalPauseTime = 0;
        
        currentSession.pauses.forEach(pause => {
            if (pause.end) {
                totalPauseTime += pause.duration;
            }
        });
        
        const displayTime = state.elapsedTime - totalPauseTime;
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
            date: state.currentDate
        };
        
        const tasks = getTasks();
        tasks.push(task);
        saveTasks(tasks);
        
        hideTaskInput();
        renderTasks();
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
            showToast('Задача удалена', 'info');
        }, 300);
    }
}

function renderTasks() {
    const tasks = getTasks().filter(t => t.date === state.currentDate);
    const tasksList = document.getElementById('tasksList');
    
    if (tasks.length === 0) {
        tasksList.innerHTML = '<li style="text-align: center; color: #6b7280; padding: 20px;">Нет задач на сегодня</li>';
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
    for (let day = 1; day <= lastDay.getDate(); day++) {
        const date = new Date(year, month, day);
        const dateStr = date.toISOString().split('T')[0];
        const dayData = getDataForDate(dateStr);
        
        const div = document.createElement('div');
        div.className = 'calendar-day';
        
        if (dateStr === new Date().toISOString().split('T')[0]) {
            div.classList.add('today');
        }
        
        if (dayData.totalWorkTime > 0) {
            div.classList.add('has-data');
        }
        
        div.innerHTML = `
            <div class="day-number">${day}</div>
            ${dayData.totalWorkTime > 0 ? `<div class="day-time">${formatTime(dayData.totalWorkTime)}</div>` : ''}
        `;
        
        div.addEventListener('click', () => showDayDetails(dateStr));
        calendar.appendChild(div);
    }
}

function changeMonth(direction) {
    currentMonth.setMonth(currentMonth.getMonth() + direction);
    renderCalendar();
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
        sessionCount: sessions.length,
        tasks: tasks
    };
}

function showDayDetails(dateStr) {
    const data = getDataForDate(dateStr);
    const date = new Date(dateStr);
    
    showConfirm(
        date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }),
        `Рабочее время: ${formatTime(data.totalWorkTime)}<br>
        Время пауз: ${formatTime(data.totalPauseTime)}<br>
        Сессий: ${data.sessionCount}<br>
        Задач выполнено: ${data.tasks.filter(t => t.completed).length} из ${data.tasks.length}`,
        () => {},
        true
    );
}

// === СТАТИСТИКА ===

function updateTodayStats() {
    const data = getDataForDate(state.currentDate);
    
    document.getElementById('totalWorkTime').textContent = formatTime(data.totalWorkTime);
    document.getElementById('totalPauseTime').textContent = formatTime(data.totalPauseTime);
    document.getElementById('sessionCount').textContent = data.sessionCount;
}

function loadTodayData() {
    renderTasks();
    updateTodayStats();
}

// === НАСТРОЙКИ ===

function openSettings() {
    document.getElementById('settingsModal').classList.add('active');
}

function closeSettings() {
    document.getElementById('settingsModal').classList.remove('active');
    document.getElementById('qrSection').style.display = 'none';
    document.getElementById('keyInputSection').style.display = 'none';
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
}

function showSessionKey() {
    const qrSection = document.getElementById('qrSection');
    document.getElementById('qrcode').innerHTML = '';
    document.getElementById('keyDisplay').textContent = state.sessionKey;
    qrSection.style.display = 'block';
}

function showKeyInput() {
    document.getElementById('keyInputSection').style.display = 'block';
}

function connectWithKey() {
    const key = document.getElementById('keyInput').value.trim();
    if (key) {
        state.sessionKey = key;
        localStorage.setItem('sessionKey', key);
        showToast('Устройство успешно подключено!', 'success');
        closeSettings();
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
            }
        };
        
        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
        
        ws.onclose = () => {
            console.log('WebSocket disconnected');
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

function applyRemoteData(data) {
    if (!data) return;
    
    // Применяем задачи
    if (data.tasks) {
        localStorage.setItem('tasks', JSON.stringify(data.tasks));
        renderTasks();
    }
    
    // Применяем сессии
    if (data.sessions) {
        Object.keys(data.sessions).forEach(key => {
            localStorage.setItem(key, JSON.stringify(data.sessions[key]));
        });
        updateTodayStats();
        renderCalendar();
    }
}

// === УВЕДОМЛЕНИЯ И МОДАЛЬНЫЕ ОКНА ===

function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

function showConfirm(title, message, onConfirm, infoOnly = false) {
    const modal = document.getElementById('confirmModal');
    const titleEl = document.getElementById('confirmTitle');
    const messageEl = document.getElementById('confirmMessage');
    const okBtn = document.getElementById('confirmOk');
    const cancelBtn = document.getElementById('confirmCancel');
    
    titleEl.textContent = title;
    messageEl.innerHTML = message;
    
    if (infoOnly) {
        okBtn.textContent = 'Закрыть';
        cancelBtn.style.display = 'none';
    } else {
        okBtn.textContent = 'Да';
        cancelBtn.style.display = 'block';
    }
    
    modal.classList.add('active');
    
    const handleOk = () => {
        modal.classList.remove('active');
        if (onConfirm) onConfirm();
        okBtn.removeEventListener('click', handleOk);
        cancelBtn.removeEventListener('click', handleCancel);
    };
    
    const handleCancel = () => {
        modal.classList.remove('active');
        okBtn.removeEventListener('click', handleOk);
        cancelBtn.removeEventListener('click', handleCancel);
    };
    
    okBtn.addEventListener('click', handleOk);
    cancelBtn.addEventListener('click', handleCancel);
    
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            handleCancel();
        }
    });
}
