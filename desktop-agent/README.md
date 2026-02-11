# LinkTime Desktop Agent

Desktop-агент для автоматического отслеживания активности в операционной системе.

## Возможности

- 🔍 Автоматическое отслеживание активного окна
- ⚡ Определение статуса активности (работа/отвлечение/неактивность)
- 🔗 Синхронизация с веб-приложением LinkTime
- 🎯 Настраиваемые белые и черные списки приложений
- 🔔 Работа в системном трее
- 📊 Отправка данных на сервер каждые 5 секунд

## Установка

### Требования

- Node.js 16+ 
- Windows / macOS / Linux

### Шаги установки

1. Перейдите в директорию desktop-agent:
```bash
cd desktop-agent
```

2. Установите зависимости:
```bash
npm install
```

3. Запустите агент:
```bash
npm start
```

## Настройка

### Получение ключа сессии

1. Откройте LinkTime в браузере
2. Нажмите ⚙️ (Настройки)
3. Выберите "Показать ключ доступа"
4. Скопируйте ключ

### Подключение агента

1. Откройте Desktop Agent
2. Вставьте ключ сессии в поле
3. Нажмите "Сохранить и подключиться"
4. Агент начнет работу в фоне

## Логика работы

### Статусы активности

**🟢 Работа (working)** - активное окно входит в белый список:
- Visual Studio Code
- Terminal / CMD / PowerShell
- Figma
- Adobe Photoshop
- IDE (WebStorm, PyCharm, IntelliJ, Eclipse)
- Postman
- Git / GitHub Desktop
- Docker

**🟡 Отвлечение (distracted)** - активное окно входит в черный список:
- YouTube
- Netflix
- Facebook / Twitter / Instagram / TikTok
- Reddit / Twitch
- Steam
- Мессенджеры (Discord, Telegram, WhatsApp)

**🔴 Неактивен (idle)** - нет активности более 30 секунд

### Настройка списков

Списки настраиваются в файле конфигурации:
```
%APPDATA%/linktime-desktop-agent/config.json
```

Пример конфигурации:
```json
{
  "sessionKey": "session_xxxxx_xxxxx",
  "checkInterval": 5000,
  "idleTimeout": 30000,
  "whiteList": [
    "Visual Studio Code",
    "Terminal"
  ],
  "blackList": [
    "YouTube",
    "Netflix"
  ]
}
```

## Сборка исполняемого файла

### Windows
```bash
npm run build-win
```
Результат: `dist/LinkTime Agent Setup.exe`

### macOS
```bash
npm run build-mac
```
Результат: `dist/LinkTime Agent.dmg`

### Linux
```bash
npm run build-linux
```
Результат: `dist/LinkTime Agent.AppImage`

## Использование

### Работа в трее

После запуска агент сворачивается в системный трей:
- **Клик по иконке** - открыть настройки
- **Правая кнопка** - меню с текущим статусом

### Автозапуск

Для автозапуска при старте системы:

**Windows:**
1. Win + R → `shell:startup`
2. Создать ярлык на `LinkTime Agent.exe`

**macOS:**
1. System Preferences → Users & Groups → Login Items
2. Добавить LinkTime Agent

**Linux:**
1. Добавить в автозапуск через настройки системы
2. Или создать `.desktop` файл в `~/.config/autostart/`

## Устранение проблем

### Агент не подключается к серверу

1. Проверьте интернет-соединение
2. Убедитесь что ключ сессии введен правильно
3. Проверьте что сервер доступен: https://linktime.onrender.com

### Неправильное определение статуса

1. Откройте конфигурацию
2. Добавьте приложение в нужный список (whiteList/blackList)
3. Перезапустите агент

### Агент не отслеживает окна (Windows)

На Windows может потребоваться запуск с правами администратора для отслеживания некоторых системных окон.

### Агент не видит окна (macOS)

1. System Preferences → Security & Privacy → Privacy → Accessibility
2. Добавить LinkTime Agent в список разрешенных приложений

## Технические детали

### Архитектура

```
Desktop Agent
    ↓ (WebSocket)
Server (server.js)
    ↓ (WebSocket)
Browser Client (app.js)
```

### Протокол связи

**От агента к серверу:**
```json
{
  "type": "activity_update",
  "sessionKey": "session_xxxxx",
  "status": "working",
  "windowTitle": "Visual Studio Code - main.js"
}
```

**От сервера к клиентам:**
```json
{
  "type": "activity_status",
  "status": "working",
  "windowTitle": "Visual Studio Code - main.js"
}
```

### Библиотеки

- **electron** - фреймворк для десктопных приложений
- **active-win** - получение информации об активном окне
- **ws** - WebSocket клиент для связи с сервером

## Разработка

### Структура проекта

```
desktop-agent/
├── main.js          # Главный процесс Electron
├── index.html       # UI настроек
├── package.json     # Зависимости и скрипты
├── icon.png         # Иконка приложения
└── config.json      # Конфигурация (создается автоматически)
```

### Debug режим

```bash
npm start
```

Откройте DevTools: View → Toggle Developer Tools

## Лицензия

MIT
