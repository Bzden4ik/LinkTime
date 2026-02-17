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
sudo mkdir -p /var/www/certbot

# --- Шаг 3: Копируем файлы ---
info "Копирую файлы проекта..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

sudo cp "$PROJECT_DIR/server.js" /var/www/linktime/
sudo cp "$PROJECT_DIR/package.json" /var/www/linktime/

sudo mkdir -p /var/www/linktime/public
sudo cp "$PROJECT_DIR/public/index.html" /var/www/linktime/public/
sudo cp "$PROJECT_DIR/public/app.js" /var/www/linktime/public/
sudo cp "$PROJECT_DIR/public/style.css" /var/www/linktime/public/

# --- Шаг 4: Устанавливаем зависимости ---
info "Устанавливаю npm зависимости..."
cd /var/www/linktime
sudo npm install --omit=dev

# --- Шаг 5: Права доступа ---
info "Настраиваю права доступа..."
sudo chown -R www-data:www-data /var/www/linktime
sudo chown -R www-data:www-data /var/lib/linktime
sudo chown -R www-data:www-data /var/log/linktime

# --- Шаг 6: Systemd сервис ---
info "Настраиваю systemd сервис..."
sudo cp "$SCRIPT_DIR/linktime.service" /etc/systemd/system/linktime.service
sudo systemctl daemon-reload
sudo systemctl enable linktime
sudo systemctl restart linktime
sleep 2

if systemctl is-active --quiet linktime; then
    info "LinkTime сервис: РАБОТАЕТ"
else
    error "LinkTime сервис не запустился. Смотри: sudo journalctl -u linktime -n 50"
fi

# --- Шаг 7: Nginx (HTTP сначала) ---
info "Настраиваю Nginx (HTTP)..."
sudo cp "$SCRIPT_DIR/nginx-linktime.conf" /etc/nginx/sites-available/linktime.go-tit.ru

if [ ! -L /etc/nginx/sites-enabled/linktime.go-tit.ru ]; then
    sudo ln -s /etc/nginx/sites-available/linktime.go-tit.ru /etc/nginx/sites-enabled/
fi

sudo nginx -t || error "Nginx config test failed!"
sudo systemctl reload nginx
info "Nginx перезагружен (HTTP)"

# --- Шаг 8: SSL сертификат ---
info "Проверяю SSL сертификат..."
if [ ! -d /etc/letsencrypt/live/linktime.go-tit.ru ]; then
    warn "SSL сертификат не найден. Получаю через certbot..."

    if ! command -v certbot &> /dev/null; then
        info "Устанавливаю certbot..."
        sudo apt-get install -y certbot python3-certbot-nginx
    fi

    sudo certbot --nginx -d linktime.go-tit.ru --non-interactive --agree-tos --email deniskazah33@gmail.com
    info "SSL сертификат получен, Nginx обновлён certbot'ом"
else
    info "SSL сертификат уже существует"
    sudo nginx -t && sudo systemctl reload nginx
fi

# --- Шаг 9: Проверка ---
sleep 2
info "Проверяю работоспособность..."

if curl -s http://localhost:3002/api/health | grep -q '"status":"ok"'; then
    info "Health check: OK"
else
    warn "Health check не ответил (сервис может ещё стартовать)"
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
