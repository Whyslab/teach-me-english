#!/bin/bash
# Ставит напоминание на компьютер (HP): скрипт в ~/.local/bin, таймер в systemd --user.
# Снять: systemctl --user disable --now norsk-trener-napominanie.timer
#        rm ~/.local/bin/norsk-trener-napominanie.sh ~/.config/systemd/user/norsk-trener-napominanie.{service,timer}
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
install -Dm755 "$here/norsk-trener-napominanie.sh" "$HOME/.local/bin/norsk-trener-napominanie.sh"
install -Dm644 "$here/norsk-trener-napominanie.service" "$HOME/.config/systemd/user/norsk-trener-napominanie.service"
install -Dm644 "$here/norsk-trener-napominanie.timer" "$HOME/.config/systemd/user/norsk-trener-napominanie.timer"
systemctl --user daemon-reload
systemctl --user enable --now norsk-trener-napominanie.timer
systemctl --user list-timers norsk-trener-napominanie.timer --no-pager
