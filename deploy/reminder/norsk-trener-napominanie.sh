#!/bin/bash
# Напоминание о тренажёре норвежского на компьютере (22.11.2026).
# Таймер — в 17:00. Молчит, если сегодня уже занимался или ничего не ждёт.
# Сводку отдаёт сервер (GET /api/today) — то же число, что на кнопке «Продолжить».
#
#   norsk-trener-napominanie.sh          — проверить и напомнить
#   NORSK_URL=http://127.0.0.1:39xx …    — другой сервер (для проверки)
#   NORSK_DRY=1 …                        — только напечатать, без уведомления
export LC_ALL=C
url="${NORSK_URL:-https://arch-laptop.tailf50474.ts.net:5443}"

# Таймер с Persistent=true сработает и после включения компьютера — но
# утром «ты сегодня не занимался» звучит странно. Напоминаем с 17 до 23.
hour=$(date +%H)
if [ -z "${NORSK_DRY:-}" ] && { [ "$hour" -lt 17 ] || [ "$hour" -ge 23 ]; }; then exit 0; fi

json=$(curl -fsS --max-time 20 "$url/api/today") || {
    # Сервер недоступен — о нём и так скажет server-watch; здесь молчим.
    echo "сервер не ответил: $url" >&2
    exit 0
}
read -r due answered minutes < <(printf '%s' "$json" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(int(d.get("due", 0)), int(d.get("answeredToday", 0)), int(d.get("minutes", 0)))
') || exit 0

if [ "$answered" -gt 0 ] || [ "$due" -eq 0 ]; then
    echo "напоминать не нужно: ждут $due, ответов сегодня $answered"
    exit 0
fi

words() {   # 1 слово, 2 слова, 5 слов
    local n=$1 m10=$(($1 % 10)) m100=$(($1 % 100))
    if [ "$m10" -eq 1 ] && [ "$m100" -ne 11 ]; then echo "$n слово"
    elif [ "$m10" -ge 2 ] && [ "$m10" -le 4 ] && { [ "$m100" -lt 12 ] || [ "$m100" -gt 14 ]; }; then echo "$n слова"
    else echo "$n слов"; fi
}
title="Норвежский: ждут $(words "$due")"
body="Урок примерно на $minutes мин — кнопка «Продолжить»."

if [ -n "${NORSK_DRY:-}" ]; then echo "$title | $body"; exit 0; fi

export DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}
# С кнопкой «Открыть»: notify-send ждёт ответа (до 2 часов). Не доставилось
# (панели нет) — в очередь sys-notify, без кнопки.
action=$(timeout 7200 notify-send -a "Норвежский" -i accessories-dictionary \
    -A open="Открыть тренажёр" "$title" "$body" 2>/dev/null)
rc=$?
if [ "$rc" -ne 0 ] && [ "$rc" -ne 124 ]; then
    "$HOME/.local/bin/sys-notify" -a "Норвежский" -i accessories-dictionary "$title" "$body"
    exit 0
fi
if [ "$action" = open ]; then
    # Отдельной службой: дочерние процессы oneshot-службы systemd убивает при выходе.
    systemd-run --user --quiet --collect xdg-open "$url/"
fi
exit 0
