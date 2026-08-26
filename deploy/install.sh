#!/usr/bin/env bash
# deploy/install.sh — ставит teach-me-english как systemd user-сервис.
#
# Делает ровно четыре вещи: проверяет Node, ставит зависимости, собирает юнит
# из шаблона под фактический путь репозитория и запускает сервис. Sudo не
# нужен: user-сервисы живут в домашнем каталоге.
#
# Удаление: deploy/uninstall.sh
set -Eeuo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_err()  { echo -e "${RED}[ERROR]${NC} $1" >&2; }
log_step() { echo -e "\n${BLUE}==>${NC} $1"; }

trap 'log_err "Прервано на строке $LINENO."; exit 1' ERR

if [[ $EUID -eq 0 ]]; then
    log_err "Не запускай install.sh от root — это user-сервис, он должен принадлежать тебе."
    exit 1
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_NAME="teach-me-english.service"

# ---------------------------------------------------------------------------
log_step "Проверка Node.js"
# ---------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
    log_err "Node.js не найден. Поставь его и запусти скрипт заново:"
    log_err "  Arch:   sudo pacman -S nodejs npm"
    log_err "  Debian: sudo apt install nodejs npm"
    exit 1
fi

# sqlite3 6.x требует Node >= 20.17.0, поэтому сверяем и минорную версию тоже.
read -r NODE_MAJOR NODE_MINOR < <(node -p 'const v=process.versions.node.split("."); v[0]+" "+v[1]')
if (( NODE_MAJOR < 20 || (NODE_MAJOR == 20 && NODE_MINOR < 17) )); then
    log_err "Нужен Node 20.17 или новее (этого требует sqlite3 6.x), найден $(node -v)."
    exit 1
fi
log_info "Node $(node -v) — подходит."

# ---------------------------------------------------------------------------
log_step "Зависимости"
# ---------------------------------------------------------------------------
cd "$REPO"
if [[ -f package-lock.json ]]; then
    npm ci --omit=dev --foreground-scripts
else
    npm install --omit=dev --foreground-scripts
fi
# sqlite3 — нативный модуль; на чужой платформе готовый бинарник не подойдёт.
npm rebuild sqlite3 --foreground-scripts >/dev/null 2>&1 || true
log_info "Зависимости установлены."

# ---------------------------------------------------------------------------
log_step "Настройки"
# ---------------------------------------------------------------------------
if [[ ! -f "$REPO/.env" ]]; then
    cp "$REPO/.env.example" "$REPO/.env"
    log_info "Создан .env из .env.example — загляни туда, если нужен другой порт."
else
    log_info ".env уже есть, не трогаю."
fi

# ---------------------------------------------------------------------------
log_step "systemd-юнит"
# ---------------------------------------------------------------------------
mkdir -p "$UNIT_DIR"

if [[ -f "${UNIT_DIR}/${UNIT_NAME}" ]]; then
    cp -f "${UNIT_DIR}/${UNIT_NAME}" "${UNIT_DIR}/${UNIT_NAME}.bak-$(date +%Y%m%d_%H%M%S)"
    log_info "Старый юнит сохранён рядом с суффиксом .bak-*"
fi

sed "s|%REPO%|${REPO}|g" "$REPO/deploy/${UNIT_NAME}.template" > "${UNIT_DIR}/${UNIT_NAME}"

if grep -q '%REPO%' "${UNIT_DIR}/${UNIT_NAME}"; then
    log_err "В собранном юните остались неподставленные плейсхолдеры."
    exit 1
fi
log_info "Юнит собран: ${UNIT_DIR}/${UNIT_NAME}"

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT_NAME"

# ---------------------------------------------------------------------------
log_step "Проверка"
# ---------------------------------------------------------------------------
PORT="$(grep -E '^PORT=' "$REPO/.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')"
PORT="${PORT:-3000}"

for _ in $(seq 1 40); do
    if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then
        log_info "Сервис отвечает на http://127.0.0.1:${PORT}/"
        echo
        log_info "Готово. Открой http://127.0.0.1:${PORT}/ в браузере."
        log_info "Логи:      journalctl --user -u ${UNIT_NAME} -f"
        log_info "Остановить: systemctl --user stop ${UNIT_NAME}"
        exit 0
    fi
    sleep 0.25
done

log_err "Сервис не ответил за 10 секунд. Что случилось — покажет:"
log_err "  journalctl --user -u ${UNIT_NAME} -n 50 --no-pager"
exit 1
