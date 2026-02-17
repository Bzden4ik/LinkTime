#!/bin/bash
# ============================================
# LinkTime — первичный деплой на Ubuntu 24.04
# Сервер: 138.124.53.246
# Домен: linktime.go-tit.ru
# Порт: 3002
# ============================================

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

REPO_URL="https://github.com/Bzden4ik/LinkTime.git"
DEPLOY_DIR="/var/www/linktime"
DATA_DIR="/var/lib/linktime"

# --- Шаг 1: Node.js ---
info "Проверяю Node.js..."
if ! command -v node &> /dev/null; then
    warn "Node.js не установлен. Устанавливаю Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi
info "Node.js: $(node -v)"

# --- Шаг 2: Git ---
info "Проверяю git..."
if ! command -v git &> /dev/null; then
    apt-get install -y git
fi

# --- Шаг 3: Директории ---
info "Создаю директории..."
mkdir -p "$DATA_DIR"
mkdir -p /var/www/certbot

# --- Шаг 4: Клонируем или обновляем репозиторий ---
info "Разворачиваю репозиторий..."
if [ -d "$DEPLOY_DIR/.git" ]; then
    info "Репозиторий уже есть — обновляю..."
    cd "$DEPLOY_DIR"
    git pull origin main
else
    git clone "$REPO_URL" "$DEPLOY_DIR"
    cd "$DEPLOY_DIR"
fi

# --- Шаг 5: npm install ---
info "Устанавливаю зависимости..."
npm install --omit=dev

# --- Шаг 6: Права доступа ---
info "Настраиваю права..."
chown -R www-data:www-data "$DEPLOY_DIR"
chown -R www-data:www-data "$DATA_DIR"
# git-директория должна быть доступна для pull от root
chmod -R 755 "$DEPLOY_DIR"

# --- Шаг 7: Systemd сервис ---
info "Настраиваю systemd сервис..."
cp "$DEPLOY_DIR/deploy/linktime.service" /etc/systemd/system/linktime.service
systemctl daemon-reload
systemctl enable linktime
systemctl restart linktime
sleep 2

if systemctl is-active --quiet linktime; then
    info "Сервис linktime: РАБОТАЕТ"
else
    error "Сервис не запустился. Смотри: journalctl -u linktime -n 50"
fi

# --- Шаг 8: Nginx ---
info "Настраиваю Nginx..."
cp "$DEPLOY_DIR/deploy/nginx-linktime.conf" /etc/nginx/sites-available/linktime.go-tit.ru

if [ ! -L /etc/nginx/sites-enabled/linktime.go-tit.ru ]; then
    ln -s /etc/nginx/sites-available/linktime.go-tit.ru /etc/nginx/sites-enabled/
fi

nginx -t || error "Ошибка конфига nginx!"
systemctl reload nginx

# --- Шаг 9: SSL ---
info "Проверяю SSL..."
if [ ! -d /etc/letsencrypt/live/linktime.go-tit.ru ]; then
    warn "SSL не найден. Получаю через certbot..."
    if ! command -v certbot &> /dev/null; then
        apt-get install -y certbot python3-certbot-nginx
    fi
    certbot --nginx -d linktime.go-tit.ru --non-interactive --agree-tos --email deniskazah33@gmail.com
    info "SSL получен."
else
    info "SSL уже есть."
    nginx -t && systemctl reload nginx
fi

# --- Шаг 10: Проверка ---
sleep 2
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
echo "  Код:    $DEPLOY_DIR"
echo "  БД:     $DATA_DIR/linktime.db"
echo ""
echo "  Обновить с GitHub:"
echo "    bash $DEPLOY_DIR/deploy/update.sh"
echo ""
echo "  Логи:"
echo "    journalctl -u linktime -f"
echo "==========================================="
