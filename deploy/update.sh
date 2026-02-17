#!/bin/bash
# ============================================
# LinkTime — обновление с GitHub
# Запускать на сервере: bash /var/www/linktime/deploy/update.sh
# ============================================

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

REPO_DIR="/var/www/linktime"

info "Переходим в директорию проекта..."
cd "$REPO_DIR"

info "Получаем изменения с GitHub..."
git fetch origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    info "Уже актуальная версия. Обновление не требуется."
    exit 0
fi

info "Сбрасываем локальные изменения на сервере..."
git checkout -- .

info "Применяем обновления..."
git pull origin main

info "Перезапускаем сервис..."
systemctl restart linktime
sleep 2

if systemctl is-active --quiet linktime; then
    info "Сервис работает."
else
    error "Сервис не запустился! Смотри: journalctl -u linktime -n 50"
fi

COMMIT=$(git log -1 --format="%h — %s")
info "Обновлено до: $COMMIT"
