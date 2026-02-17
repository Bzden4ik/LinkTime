#!/bin/bash
# ============================================
# LinkTime — скрипт деплоя на Ubuntu 24.04
# Сервер: 138.124.53.246
# Домен: linktime.go-tit.ru
# Порт: 3002
# ============================================

set -e

echo "=== LinkTime Deploy Script ==="
echo ""

# Цвета
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# --- Шаг 1: Проверяем Node.js ---
info "Проверяю Node.js..."
if ! command -v node &> /dev/null; then
    warn "Node.js не установлен. Устанавливаю Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi
NODE_VERSION=$(node -v)
info "Node.js version: $NODE_VERSION"

# --- Шаг 2: Создаём директории ---
info "Создаю директории..."
sudo mkdir -p /var/www/linktime
sudo mkdir -p /var/lib/linktime
sudo mkdir -p /var/log/linktime

# --- Шаг 3: Копируем файлы ---
info "Копирую файлы проекта..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Копируем серверные файлы
sudo cp "$PROJECT_DIR/server.js" /var/www/linktime/
sudo cp "$PROJECT_DIR/package.json" /var/www/linktime/

# Копируем фронтенд в public/
sudo mkdir -p /var/www/linktime/public
sudo cp "$PROJECT_DIR/public/index.html" /var/www/linktime/public/
sudo cp "$PROJECT_DIR/public/app.js" /var/www/linktime/public/
sudo cp "$PROJECT_DIR/public/style.css" /var/www/linktime/public/

# --- Шаг 4: Устанавливаем зависимости ---
info "Устанавливаю npm зависимости..."
cd /var/www/linktime
sudo npm install --production

# --- Шаг 5: Права доступа ---
info "Настраиваю права доступа..."
sudo chown -R www-data:www-data /var/www/linktime
sudo chown -R www-data:www-data /var/lib/linktime
sudo chown -R www-data:www-data /var/log/linktime

# --- Шаг 6: Nginx ---
info "Настраиваю Nginx..."
sudo cp "$SCRIPT_DIR/nginx-linktime.conf" /etc/nginx/sites-available/linktime.go-tit.ru

# Создаём symlink если нет
if [ ! -L /etc/nginx/sites-enabled/linktime.go-tit.ru ]; then
    sudo ln -s /etc/nginx/sites-available/linktime.go-tit.ru /etc/nginx/sites-enabled/
fi

# Проверяем конфиг
sudo nginx -t || error "Nginx config test failed!"

# --- Шаг 7: SSL сертификат ---
info "Проверяю SSL сертификат..."
if [ ! -d /etc/letsencrypt/live/linktime.go-tit.ru ]; then
    warn "SSL сертификат не найден. Получаю через certbot..."

    # Временно убираем SSL из конфига для первого запуска certbot
    # Certbot сам добавит SSL настройки
    sudo certbot --nginx -d linktime.go-tit.ru --non-interactive --agree-tos --email deniskazah33@gmail.com
else
    info "SSL сертификат уже существует"
fi

# --- Шаг 8: Systemd сервис ---
info "Настраиваю systemd сервис..."
sudo cp "$SCRIPT_DIR/linktime.service" /etc/systemd/system/linktime.service
sudo systemctl daemon-reload
sudo systemctl enable linktime

# --- Шаг 9: Запуск ---
info "Перезапускаю сервисы..."
sudo systemctl restart linktime
sudo systemctl reload nginx

# --- Шаг 10: Проверка ---
sleep 2
info "Проверяю работоспособность..."

if systemctl is-active --quiet linktime; then
    info "LinkTime сервис: РАБОТАЕТ"
else
    error "LinkTime сервис: НЕ РАБОТАЕТ. Смотри: sudo journalctl -u linktime -n 50"
fi

# Health check
if curl -s http://localhost:3002/api/health | grep -q '"status":"ok"'; then
    info "Health check: OK"
else
    warn "Health check: не отвечает (подожди 5 секунд и проверь вручную)"
fi

echo ""
echo "==========================================="
echo -e "${GREEN}  LinkTime успешно развёрнут!${NC}"
echo ""
echo "  Сайт:   https://linktime.go-tit.ru"
echo "  Порт:   3002"
echo "  БД:     /var/lib/linktime/linktime.db"
echo ""
echo "  Команды управления:"
echo "    sudo systemctl status linktime"
echo "    sudo systemctl restart linktime"
echo "    sudo journalctl -u linktime -f"
echo "==========================================="
