#!/usr/bin/env bash
# deploy/uninstall.sh — убирает systemd user-сервис teach-me-english.
#
# База данных и .env НЕ удаляются: там твои слова и настройки. Что с ними
# делать, скрипт скажет в конце — решение за тобой.
set -Eeuo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_step() { echo -e "\n${BLUE}==>${NC} $1"; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_NAME="teach-me-english.service"

log_step "Остановка сервиса"
systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || log_warn "Сервис и так не запущен."

log_step "Удаление юнита"
if [[ -f "${UNIT_DIR}/${UNIT_NAME}" ]]; then
    rm -f "${UNIT_DIR}/${UNIT_NAME}"
    systemctl --user daemon-reload
    log_info "Юнит удалён."
else
    log_info "Юнита не было."
fi

echo
log_info "Готово. Твои данные остались на месте:"
log_info "  словарь:   ${REPO}/vocab.db"
log_info "  настройки: ${REPO}/.env"
log_warn "Удалить их можно вручную — но сначала сделай экспорт из интерфейса."
