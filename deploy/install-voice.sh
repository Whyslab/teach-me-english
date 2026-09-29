#!/usr/bin/env bash
# deploy/install-voice.sh — ставит нейросетевой голос для озвучки норвежских слов.
#
# Браузер на Linux озвучивает через espeak-ng — это звучит роботом. Этот скрипт
# ставит Piper (локальный нейросетевой синтез речи, без интернета и ключей)
# и норвежскую модель no_NO-talesyntese-medium. Всё кладётся внутрь каталога
# приложения: .venv-tts/ (Piper) и voices/ (модель, ~60 МБ). Sudo не нужен.
#
# Повторный запуск безопасен: уже скачанное не скачивается заново.
# Удалить: rm -rf .venv-tts voices tts-cache
set -Eeuo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_err()  { echo -e "${RED}[ERROR]${NC} $1" >&2; }
log_step() { echo -e "\n${BLUE}==>${NC} $1"; }
trap 'log_err "Прервано на строке $LINENO."; exit 1' ERR

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$REPO/.venv-tts"
VOICE="no_NO-talesyntese-medium"
VOICES_DIR="$REPO/voices"
MODEL="$VOICES_DIR/$VOICE.onnx"
HF="https://huggingface.co/rhasspy/piper-voices/resolve/main/no/no_NO/talesyntese/medium"
UNIT="teach-me-norwegian.service"
cd "$REPO"

# ---------------------------------------------------------------------------
log_step "Piper"
# ---------------------------------------------------------------------------
if [[ -x "$VENV/bin/piper" ]]; then
    log_info "Piper уже установлен: $VENV/bin/piper"
elif command -v uv >/dev/null 2>&1; then
    # uv сам скачает подходящий Python: у onnxruntime бывают не собраны
    # колёса под самую свежую версию Python в Arch.
    log_info "Ставлю через uv (Python 3.12)…"
    uv venv --python 3.12 "$VENV"
    uv pip install --python "$VENV/bin/python" piper-tts
else
    command -v python3 >/dev/null || { log_err "Нет python3: sudo pacman -S python"; exit 1; }
    log_info "Ставлю через python3 -m venv ($(python3 --version))…"
    python3 -m venv "$VENV"
    if ! "$VENV/bin/pip" install --quiet --upgrade pip piper-tts; then
        rm -rf "$VENV"
        log_err "pip не смог поставить piper-tts — скорее всего, под твою версию Python"
        log_err "ещё нет колёс onnxruntime. Поставь uv и запусти скрипт снова:"
        log_err "  sudo pacman -S uv && $0"
        exit 1
    fi
fi
[[ -x "$VENV/bin/piper" ]] || { log_err "После установки нет $VENV/bin/piper"; exit 1; }

# ---------------------------------------------------------------------------
log_step "Норвежский голос ($VOICE)"
# ---------------------------------------------------------------------------
mkdir -p "$VOICES_DIR"
for f in "$VOICE.onnx.json" "$VOICE.onnx"; do
    if [[ -s "$VOICES_DIR/$f" ]]; then
        log_info "$f уже скачан"
        continue
    fi
    log_info "Скачиваю $f…"
    curl -fL --retry 3 --progress-bar -o "$VOICES_DIR/$f.part" "$HF/$f?download=true"
    mv "$VOICES_DIR/$f.part" "$VOICES_DIR/$f"
done

# ---------------------------------------------------------------------------
log_step "Проверка синтеза"
# ---------------------------------------------------------------------------
TEST_WAV="$(mktemp --suffix=.wav)"
echo "Hei! Hvordan går det?" | "$VENV/bin/piper" -m "$MODEL" -f "$TEST_WAV" 2>/dev/null
SIZE=$(stat -c %s "$TEST_WAV")
(( SIZE > 1000 )) || { log_err "Piper не создал звук (файл $SIZE байт)"; exit 1; }
log_info "Синтез работает ($SIZE байт)."
for player in pw-play paplay aplay; do
    if command -v "$player" >/dev/null 2>&1; then
        log_info "Проигрываю пробную фразу через $player…"
        "$player" "$TEST_WAV" 2>/dev/null || true
        break
    fi
done
rm -f "$TEST_WAV"

# ---------------------------------------------------------------------------
log_step "Перезапуск приложения"
# ---------------------------------------------------------------------------
PORT="$(grep -E '^PORT=' "$REPO/.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')"
PORT="${PORT:-3000}"
if systemctl --user cat "$UNIT" >/dev/null 2>&1; then
    systemctl --user restart "$UNIT"
    for _ in $(seq 1 40); do
        curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null && break
        sleep 0.25
    done
    STATUS="$(curl -fsS "http://127.0.0.1:${PORT}/api/tts/status" || true)"
    echo "  /api/tts/status: $STATUS"
    if [[ "$STATUS" == *'"available":true'* ]]; then
        log_info "Готово. Открой http://127.0.0.1:${PORT}/ и нажми Ctrl+Shift+R."
    else
        log_err "Сервер не видит голос. Логи: journalctl --user -u $UNIT -n 30 --no-pager"
        exit 1
    fi
else
    log_warn "Служба $UNIT не найдена — перезапусти сервер вручную (npm start)."
fi
