#!/usr/bin/env bash
# ============================================================================
# LinkTime — one-shot installer / updater
# ----------------------------------------------------------------------------
# Usage:  залей репозиторий в /var/www/linktime, потом:
#         sudo bash /var/www/linktime/deploy/install.sh
#
# Делает всё:
#   • Ставит пакеты которых нет (Node 20, git, nginx, certbot, build-essential)
#   • Создаёт /var/lib/linktime/uploads/avatars
#   • npm install --omit=dev
#   • Генерирует systemd unit и nginx site config (встроены ниже как HEREDOC)
#   • Выпускает SSL через Let's Encrypt если нет
#   • Запускает (или перезапускает) сервис
#
# Запускать повторно — обновляет всё на месте, не ломая данные.
# Никаких других файлов в deploy/ кроме этого скрипта не нужно.
# ============================================================================

set -euo pipefail

# ---- config (можно переопределить env-переменными) -------------------------
DOMAIN="${LINKTIME_DOMAIN:-linktime.go-tit.ru}"
PORT="${LINKTIME_PORT:-3002}"
EMAIL="${LINKTIME_EMAIL:-deniskazah33@gmail.com}"
DATA_DIR="${LINKTIME_DATA_DIR:-/var/lib/linktime}"
SERVICE_USER="${LINKTIME_USER:-www-data}"
SERVICE_GROUP="${LINKTIME_GROUP:-www-data}"
NODE_MAJOR="${NODE_MAJOR:-20}"

# DEPLOY_DIR = директория где лежит сам скрипт's parent (репо)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"

# ---- pretty -----------------------------------------------------------------
G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[0;36m'; D='\033[2m'; N='\033[0m'
step() { echo -e "\n${B}▸${N} $1"; }
ok()   { echo -e "  ${G}✓${N} $1"; }
warn() { echo -e "  ${Y}⚠${N} $1"; }
die()  { echo -e "  ${R}✗${N} $1"; exit 1; }

# ---- preflight --------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || die "Запусти от root: sudo bash $0"
command -v apt-get >/dev/null || die "Поддерживается только Ubuntu/Debian"
[ -f "$DEPLOY_DIR/server.js" ] || die "Не вижу server.js в $DEPLOY_DIR — скрипт должен лежать в deploy/ рядом с server.js"
[ -f "$DEPLOY_DIR/package.json" ] || die "Не вижу package.json в $DEPLOY_DIR"

echo -e "${D}Repo:${N} $DEPLOY_DIR"
echo -e "${D}Domain:${N} $DOMAIN  ${D}Port:${N} $PORT  ${D}User:${N} $SERVICE_USER"

# ============================================================================
step "1/8 · Системные пакеты"

apt-get update -qq

# Node.js
NODE_OK=false
if command -v node >/dev/null; then
    cur_major=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
    if [ "$cur_major" -ge 18 ]; then
        NODE_OK=true
        ok "Node.js $(node -v) уже стоит"
    fi
fi
if [ "$NODE_OK" = false ]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
    apt-get install -y -qq nodejs
    ok "Установлен Node.js $(node -v)"
fi

# Остальные пакеты
PKGS=(git nginx build-essential python3 ca-certificates curl rsync)
MISSING=()
for p in "${PKGS[@]}"; do
    dpkg -s "$p" >/dev/null 2>&1 || MISSING+=("$p")
done
if [ ${#MISSING[@]} -gt 0 ]; then
    apt-get install -y -qq "${MISSING[@]}"
    ok "Установлено: ${MISSING[*]}"
else
    ok "Базовые пакеты на месте"
fi

# Certbot
if ! command -v certbot >/dev/null; then
    apt-get install -y -qq certbot python3-certbot-nginx
    ok "Установлен certbot"
else
    ok "certbot уже стоит"
fi

# ============================================================================
step "2/8 · Директории и права"

mkdir -p "$DATA_DIR/uploads/avatars"
mkdir -p /var/www/certbot

# Симлинк data/ → DATA_DIR чтобы и БД, и uploads жили в одном месте.
# Если в репо есть data/ из dev (тестовая БД) — переносим её в DATA_DIR,
# но только когда в продакшн-каталоге ещё нет рабочей БД.
if [ -L "$DEPLOY_DIR/data" ]; then
    ok "Симлинк data → $DATA_DIR уже есть"
elif [ -d "$DEPLOY_DIR/data" ]; then
    if [ ! -f "$DATA_DIR/linktime.db" ]; then
        warn "Найдена data/ в репо — переношу содержимое в $DATA_DIR"
        shopt -s dotglob nullglob
        for item in "$DEPLOY_DIR/data"/*; do
            base="$(basename "$item")"
            # Не перезаписываем uploads/avatars если он уже создан
            if [ -e "$DATA_DIR/$base" ]; then
                warn "  $base уже есть в $DATA_DIR — пропускаю"
            else
                mv "$item" "$DATA_DIR/" && echo "  → перенесён: $base"
            fi
        done
        shopt -u dotglob nullglob
        rmdir "$DEPLOY_DIR/data" 2>/dev/null \
            && ln -s "$DATA_DIR" "$DEPLOY_DIR/data" \
            && ok "data/ заменена симлинком" \
            || warn "Не смог удалить $DEPLOY_DIR/data (там остались файлы) — оставляю как есть"
    else
        warn "В $DATA_DIR уже есть прод-БД — не трогаю $DEPLOY_DIR/data (БД пишется через ENV в правильное место)"
    fi
else
    ln -s "$DATA_DIR" "$DEPLOY_DIR/data"
    ok "Симлинк: $DEPLOY_DIR/data → $DATA_DIR"
fi

chown -R "$SERVICE_USER:$SERVICE_GROUP" "$DEPLOY_DIR" "$DATA_DIR"
chmod -R 755 "$DEPLOY_DIR"
chmod -R 770 "$DATA_DIR"
ok "Владелец $SERVICE_USER:$SERVICE_GROUP"

# ============================================================================
step "3/8 · npm зависимости"

# У www-data $HOME = /var/www, и npm пытается писать в /var/www/.npm для логов и
# кеша. Создаём с правильными правами заранее, иначе npm падает на старте.
NPM_CACHE="/var/cache/linktime-npm"
mkdir -p /var/www/.npm "$NPM_CACHE"
chown -R "$SERVICE_USER:$SERVICE_GROUP" /var/www/.npm "$NPM_CACHE"

cd "$DEPLOY_DIR"

# Используем явный кеш через env-переменную — независимо от $HOME
run_npm() {
    sudo -u "$SERVICE_USER" -H env "npm_config_cache=$NPM_CACHE" "$@"
}

NPM_OK=false
if [ -f package-lock.json ]; then
    if run_npm npm ci --omit=dev --no-audit --no-fund 2>&1 | tee /tmp/linktime-npm.log | tail -8; then
        NPM_OK=true
    else
        warn "npm ci упал — пробую npm install"
    fi
fi
if [ "$NPM_OK" = false ]; then
    if run_npm npm install --omit=dev --no-audit --no-fund 2>&1 | tee /tmp/linktime-npm.log | tail -8; then
        NPM_OK=true
    fi
fi

if [ "$NPM_OK" != true ]; then
    echo
    echo "=== npm log tail ==="
    tail -30 /tmp/linktime-npm.log
    die "npm install не прошёл — см. /tmp/linktime-npm.log"
fi

# Проверяем что better-sqlite3 действительно скомпилировался
if [ ! -f "$DEPLOY_DIR/node_modules/better-sqlite3/build/Release/better_sqlite3.node" ]; then
    warn "better-sqlite3 нативный модуль не собран — пробую rebuild"
    run_npm npm rebuild better-sqlite3 2>&1 | tail -8 || die "Не смог собрать better-sqlite3 (нужен build-essential + python3)"
fi
ok "Зависимости установлены (better-sqlite3 ок)"

# ============================================================================
step "4/8 · Systemd unit"

cat > /etc/systemd/system/linktime.service <<EOF
[Unit]
Description=LinkTime — рабочий хронограф
Documentation=https://github.com/Bzden4ik/LinkTime
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$DEPLOY_DIR
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
TimeoutStopSec=15

# Environment
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=DATABASE_PATH=$DATA_DIR/linktime.db
Environment=FORCE_HTTPS=1
Environment=LOG_LEVEL=info
Environment=LOG_JSON=1
Environment=NODE_OPTIONS=--max-old-space-size=512

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=linktime

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR $DEPLOY_DIR/data
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable linktime >/dev/null
ok "linktime.service записан в /etc/systemd/system"

# ============================================================================
step "5/8 · Nginx site"

# Snippet с общими proxy headers — nginx сбрасывает наследование при первом
# proxy_set_header внутри location, поэтому подключаем через include везде.
mkdir -p /etc/nginx/snippets
cat > /etc/nginx/snippets/linktime-proxy.conf <<'EOF'
proxy_http_version   1.1;
proxy_set_header     Host              $host;
proxy_set_header     X-Real-IP         $remote_addr;
proxy_set_header     X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header     X-Forwarded-Proto $scheme;
proxy_set_header     X-Forwarded-Host  $host;
proxy_buffering      off;
proxy_read_timeout   86400s;
proxy_send_timeout   86400s;
EOF

cat > /etc/nginx/sites-available/$DOMAIN <<EOF
# =============================================================================
# LinkTime — nginx site config (managed by deploy/install.sh)
# Upstream: 127.0.0.1:$PORT
# =============================================================================

map \$http_upgrade \$connection_upgrade {
    default upgrade;
    ''      close;
}

upstream linktime_backend {
    server 127.0.0.1:$PORT;
    keepalive 32;
}

server {
    server_name $DOMAIN;
    listen [::]:443 ssl ipv6only=on;
    listen 443 ssl;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 12m;

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_proxied any;
    gzip_types text/plain text/css text/javascript application/javascript application/json application/manifest+json image/svg+xml;
    gzip_comp_level 6;

    add_header X-Frame-Options             "SAMEORIGIN"                       always;
    add_header X-Content-Type-Options      "nosniff"                          always;
    add_header Referrer-Policy             "strict-origin-when-cross-origin"  always;
    add_header Permissions-Policy          "camera=(self), microphone=(), geolocation=()" always;
    add_header Strict-Transport-Security   "max-age=31536000; includeSubDomains" always;

    # ACME http-01
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
        access_log off;
    }

    # PWA: sw.js и manifest НИКОГДА не кешировать долго
    location = /sw.js {
        proxy_pass http://linktime_backend;
        include /etc/nginx/snippets/linktime-proxy.conf;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        expires 0;
    }
    location = /manifest.json {
        proxy_pass http://linktime_backend;
        include /etc/nginx/snippets/linktime-proxy.conf;
        add_header Cache-Control "no-cache, must-revalidate" always;
        expires 0;
    }

    # API health — без access log (мониторинг будет спамить)
    location = /api/health {
        proxy_pass http://linktime_backend;
        include /etc/nginx/snippets/linktime-proxy.conf;
        access_log off;
        add_header Cache-Control "no-store" always;
    }

    # API + WebSocket — общий апстрим, апгрейд включён
    location /api/ {
        proxy_pass http://linktime_backend;
        include /etc/nginx/snippets/linktime-proxy.conf;
        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        add_header Cache-Control "no-store" always;
        proxy_request_buffering off;
    }
    location /ws {
        proxy_pass http://linktime_backend;
        include /etc/nginx/snippets/linktime-proxy.conf;
        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
    }

    # Аватары и медиа — длинный кеш
    location /uploads/ {
        proxy_pass http://linktime_backend;
        include /etc/nginx/snippets/linktime-proxy.conf;
        add_header Cache-Control "public, max-age=604800, immutable" always;
        expires 7d;
        access_log off;
    }

    # Иконки PWA — месячный кеш
    location /icons/ {
        proxy_pass http://linktime_backend;
        include /etc/nginx/snippets/linktime-proxy.conf;
        add_header Cache-Control "public, max-age=2592000, immutable" always;
        expires 30d;
        access_log off;
    }

    # JS/CSS — без кеша, чтобы обновления приехали сразу
    location ~* \.(js|css)\$ {
        proxy_pass http://linktime_backend;
        include /etc/nginx/snippets/linktime-proxy.conf;
        add_header Cache-Control "no-cache, must-revalidate" always;
        expires 0;
    }

    # Картинки/шрифты — день
    location ~* \.(png|jpg|jpeg|webp|gif|svg|ico|woff2?|ttf)\$ {
        proxy_pass http://linktime_backend;
        include /etc/nginx/snippets/linktime-proxy.conf;
        add_header Cache-Control "public, max-age=86400" always;
        expires 1d;
        access_log off;
    }

    # Всё остальное (html и т.д.) — catch-all с поддержкой WebSocket upgrade
    location / {
        proxy_pass http://linktime_backend;
        include /etc/nginx/snippets/linktime-proxy.conf;
        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        add_header Cache-Control "no-cache, must-revalidate" always;
    }
}

# :80 → 301 https
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://\$host\$request_uri; }
}
EOF

# Активируем сайт
if [ ! -L /etc/nginx/sites-enabled/$DOMAIN ]; then
    ln -s /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/
fi
# Убираем дефолтный
[ -L /etc/nginx/sites-enabled/default ] && rm /etc/nginx/sites-enabled/default

ok "Nginx site записан"

# ============================================================================
step "6/8 · SSL"

SSL_DIR="/etc/letsencrypt/live/$DOMAIN"
if [ ! -d "$SSL_DIR" ]; then
    warn "SSL не найден — выпускаю через certbot..."
    # Сначала запустим nginx без SSL чтобы certbot мог пройти http-01
    cat > /etc/nginx/sites-available/${DOMAIN}.acme <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 200 "acme-bootstrap"; }
}
EOF
    rm -f /etc/nginx/sites-enabled/$DOMAIN
    ln -sf /etc/nginx/sites-available/${DOMAIN}.acme /etc/nginx/sites-enabled/${DOMAIN}.acme
    nginx -t >/dev/null 2>&1 && systemctl reload nginx || die "nginx config invalid (bootstrap)"

    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "$EMAIL" --redirect

    # Возвращаем настоящий конфиг
    rm -f /etc/nginx/sites-enabled/${DOMAIN}.acme /etc/nginx/sites-available/${DOMAIN}.acme
    ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/$DOMAIN
    ok "SSL выпущен"
else
    ok "SSL уже есть"
fi

systemctl enable certbot.timer >/dev/null 2>&1 || true

# Проверка финального конфига и reload
nginx -t >/dev/null 2>&1 || { nginx -t; die "Ошибка в финальном nginx config"; }
systemctl reload nginx
ok "Nginx перезагружен"

# ============================================================================
step "7/8 · Запуск сервиса"

systemctl restart linktime
sleep 3

if systemctl is-active --quiet linktime; then
    ok "linktime.service: активен"
else
    journalctl -u linktime -n 30 --no-pager | sed 's/^/    /'
    die "Сервис не стартовал"
fi

# ============================================================================
step "8/8 · Health check"

# FORCE_HTTPS=1 редиректит http→https; nginx делает то же самое через
# X-Forwarded-Proto. Подделываем заголовок чтобы express счёл наш локальный
# запрос «пришедшим через nginx» и не редиректил.
CURL_HEALTH='curl -sf -H X-Forwarded-Proto:https'
HEALTH_OK=false
for i in 1 2 3 4 5; do
    if $CURL_HEALTH "http://127.0.0.1:$PORT/api/health" | grep -q '"status":"ok"'; then
        HEALTH_OK=true; break
    fi
    sleep 1
done

if [ "$HEALTH_OK" = true ]; then
    SCHEMA=$($CURL_HEALTH "http://127.0.0.1:$PORT/api/health" | grep -o '"schema_version":[0-9]*' | head -1)
    ok "/api/health отвечает · $SCHEMA"
else
    warn "Health check не ответил — посмотри: journalctl -u linktime -n 30"
fi

# ============================================================================
echo
echo -e "${G}═══════════════════════════════════════════════════${N}"
echo -e "  ${G}LinkTime развёрнут${N}"
echo
echo -e "  ${B}Сайт:${N}     https://$DOMAIN"
echo -e "  ${B}Локально:${N} http://127.0.0.1:$PORT/api/health"
echo -e "  ${B}Код:${N}      $DEPLOY_DIR"
echo -e "  ${B}Данные:${N}   $DATA_DIR  (БД + uploads/)"
echo
echo -e "  ${D}Команды:${N}"
echo -e "    journalctl -u linktime -f       — логи"
echo -e "    systemctl restart linktime      — рестарт"
echo -e "    bash $0  — повторный запуск (всё идемпотентно)"
echo -e "${G}═══════════════════════════════════════════════════${N}"
