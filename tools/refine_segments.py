#!/usr/bin/env python3
"""
refine_segments.py v5
---------------------
При 429 автоматически меняет IP через Tor или список прокси.

Варианты запуска:
  # Через Tor (автосмена IP при 429):
  python refine_segments.py --db ./vocab.db --tor

  # Через список прокси (файл с прокси по одному на строку):
  python refine_segments.py --db ./vocab.db --proxy-list ./proxies.txt

  # Просто с cookies (без смены IP):
  python refine_segments.py --db ./vocab.db --cookies-file ./cookies.txt

Установка Tor:
  pip install requests[socks] stem
  Скачай Tor: https://www.torproject.org/download/tor/
  Запусти tor.exe (или tor в Linux/Mac)
"""

from __future__ import annotations

import argparse
import json
import re
import random
import sqlite3
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

try:
    from yt_dlp import YoutubeDL
except ImportError:
    print("❌ pip install yt-dlp")
    raise SystemExit(1)


# ─── Tor / прокси ─────────────────────────────────────────────

class ProxyRotator:
    """Ротатор прокси — Tor или список прокси из файла."""

    def __init__(self, mode: str, proxies: list[str] | None = None,
                 tor_host: str = "127.0.0.1", tor_port: int = 9050,
                 tor_control_port: int = 9051, tor_password: str = ""):
        self.mode       = mode        # "tor" | "list" | "none"
        self.proxies    = proxies or []
        self.proxy_idx  = 0
        self.tor_host   = tor_host
        self.tor_port   = tor_port
        self.tor_control = tor_control_port
        self.tor_password = tor_password
        self._tor_controller = None

        if mode == "tor":
            self._init_tor()

    def _init_tor(self):
        try:
            from stem import Signal
            from stem.control import Controller
            ctrl = Controller.from_port(port=self.tor_control)

            # Пробуем все методы аутентификации по очереди
            authenticated = False
            errors = []

            # 1. Cookie-файл (бинарный — stem читает сам)
            if not authenticated:
                try:
                    ctrl.authenticate()
                    authenticated = True
                except Exception as e:
                    errors.append(f"cookie: {e}")

            # 2. Пустой пароль
            if not authenticated:
                try:
                    ctrl.authenticate(password="")
                    authenticated = True
                except Exception as e:
                    errors.append(f"empty pass: {e}")

            # 3. Заданный пароль
            if not authenticated and self.tor_password:
                try:
                    ctrl.authenticate(password=self.tor_password)
                    authenticated = True
                except Exception as e:
                    errors.append(f"password: {e}")

            if not authenticated:
                raise Exception(" | ".join(errors))

            self._tor_controller = ctrl
            print(f"  🧅 Tor подключён (контроль: порт {self.tor_control})")

        except Exception as e:
            print(f"  ⚠️  Tor контроллер недоступен: {e}")
            print("     Смена IP не будет работать, но прокси всё равно используется.")
            self._tor_controller = None

    @property
    def current_proxy(self) -> str | None:
        if self.mode == "tor":
            return f"socks5://{self.tor_host}:{self.tor_port}"
        if self.mode == "list" and self.proxies:
            return self.proxies[self.proxy_idx % len(self.proxies)]
        return None

    def rotate(self) -> str | None:
        """Меняет IP. Возвращает новый прокси."""
        if self.mode == "tor":
            return self._rotate_tor()
        if self.mode == "list":
            return self._rotate_list()
        return None

    def _rotate_tor(self) -> str:
        if self._tor_controller:
            try:
                from stem import Signal
                self._tor_controller.signal(Signal.NEWNYM)
                time.sleep(3)  # Tor нужно время на смену цепочки
                print("  🔄 Tor: новый IP получен")
            except Exception as e:
                print(f"  ⚠️  Ошибка смены Tor IP: {e}")
        else:
            # Без контроллера просто ждём — Tor сам меняет цепочку раз в 10 мин
            print("  ⏳ Tor без контроллера — ждём 15с...")
            time.sleep(15)
        return f"socks5://{self.tor_host}:{self.tor_port}"

    def _rotate_list(self) -> str | None:
        if not self.proxies:
            return None
        self.proxy_idx = (self.proxy_idx + 1) % len(self.proxies)
        proxy = self.proxies[self.proxy_idx]
        print(f"  🔄 Новый прокси: {proxy}")
        return proxy


def load_proxy_list(path: str) -> list[str]:
    proxies = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                # Добавляем схему если нет
                if not line.startswith(("http", "socks")):
                    line = "socks5://" + line
                proxies.append(line)
    print(f"  📋 Загружено прокси: {len(proxies)}")
    return proxies


# ─── Структуры ────────────────────────────────────────────────

@dataclass
class Chunk:
    text:  str
    start: float
    end:   float

EMPTY_VALUES = ("", "Check video for context", None)

DEFAULT_COLUMNS = {
    "startTime":         "REAL",
    "endTime":           "REAL",
    "subtitleText":      "TEXT",
    "subtitleLang":      "TEXT",
    "subtitleUpdatedAt": "TEXT",
}


# ─── YDL ──────────────────────────────────────────────────────

def _build_ydl_opts(proxy: str | None, cookies_file: str | None) -> dict:
    opts = {
        "quiet":             True,
        "no_warnings":       True,
        "skip_download":     True,
        "extract_flat":      False,
        "writesubtitles":    True,
        "writeautomaticsub": True,
        "subtitleslangs":    ["en"],
        "subtitlesformat":   "json3",
        "retries":           3,
        "sleep_interval":    1,
        "max_sleep_interval": 5,
        "user_agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
    }
    if proxy:
        opts["proxy"] = proxy
    if cookies_file:
        opts["cookiefile"] = cookies_file
    return opts


def fetch_chunks(video_id: str, proxy: str | None,
                 cookies_file: str | None) -> tuple[list[Chunk], str]:
    url      = f"https://www.youtube.com/watch?v={video_id}"
    ydl_opts = _build_ydl_opts(proxy, cookies_file)

    with YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    if not info:
        raise RuntimeError("yt-dlp вернул пустой результат")

    subs_url = lang = None
    for key in ("subtitles", "automatic_captions"):
        lang_data = (info.get(key) or {}).get("en", [])
        for fmt in lang_data:
            if fmt.get("ext") in ("json3", "srv3"):
                subs_url = fmt.get("url")
                lang = "en"
                break
        if subs_url:
            break

    if not subs_url:
        raise RuntimeError("Субтитры на английском не найдены")

    # Скачиваем через yt-dlp (с теми же cookies/proxy)
    with YoutubeDL({**ydl_opts, "quiet": True}) as ydl:
        raw = ydl.urlopen(subs_url).read().decode("utf-8")

    data   = json.loads(raw)
    chunks = _parse_json3(data)
    if not chunks:
        raise RuntimeError("Субтитры пустые после парсинга")

    return chunks, lang or "en"


def _parse_json3(data: dict) -> list[Chunk]:
    result: list[Chunk] = []
    for event in data.get("events", []):
        start_ms = event.get("tStartMs", 0)
        dur_ms   = event.get("dDurationMs", 0)
        text = "".join(s.get("utf8", "") for s in event.get("segs", [])).strip()
        text = _clean(text)
        if text:
            result.append(Chunk(text=text,
                                start=start_ms / 1000.0,
                                end=(start_ms + dur_ms) / 1000.0))
    return result


def _clean(text: str) -> str:
    text = text.replace("\n", " ")
    text = re.sub(r"\[(?:music|applause|laughter|noise|\s)+\]", "", text, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", text).strip()


# ─── Поиск слова ──────────────────────────────────────────────

def find_sentence(chunks: list[Chunk], word: str,
                  max_expand: int = 6,
                  max_duration: float = 15.0) -> Optional[tuple[float, float, str]]:
    """
    Ищет слово в субтитрах и возвращает фрагмент не длиннее max_duration секунд.
    Центрирует окно вокруг чанка со словом.
    """
    pattern = re.compile(r"(?<!\w)" + re.escape(word) + r"(?!\w)", re.IGNORECASE)
    hit = next((i for i, c in enumerate(chunks) if pattern.search(c.text)), None)
    if hit is None:
        return None

    # Расширяем влево до границы предложения
    left = hit
    while left > 0 and (hit - left) < max_expand:
        if re.search(r"[.!?…]\s*$", chunks[left - 1].text):
            break
        left -= 1

    # Расширяем вправо до границы предложения
    right = hit
    while right < len(chunks) - 1 and (right - hit) < max_expand:
        if re.search(r"[.!?…]\s*$", chunks[right].text):
            break
        right += 1
        if re.search(r"[.!?…]\s*$", chunks[right].text):
            break

    # Обрезаем если фрагмент длиннее max_duration секунд
    # Центрируем окно вокруг чанка со словом
    word_start = chunks[hit].start
    word_end   = chunks[hit].end
    half       = max_duration / 2.0

    clip_start = max(chunks[left].start, word_start - half)
    clip_end   = clip_start + max_duration

    # Сужаем left/right чтобы вписаться в окно
    while left < hit and chunks[left].start < clip_start:
        left += 1
    while right > hit and chunks[right].end > clip_end:
        right -= 1

    # Финальная проверка длины — если всё ещё длиннее, берём только чанк со словом
    final_start = chunks[left].start
    final_end   = chunks[right].end
    if final_end - final_start > max_duration:
        left = right = hit
        final_start = chunks[hit].start
        final_end   = chunks[hit].end

    sentence = re.sub(r"\s+", " ",
                      " ".join(c.text for c in chunks[left:right + 1])).strip()

    # Небольшой контекст вокруг (но не выходим за max_duration)
    pad_start = max(0.0, final_start - 0.5)
    pad_end   = final_end + 0.5
    if pad_end - pad_start > max_duration:
        pad_end = pad_start + max_duration

    return round(pad_start, 2), round(pad_end, 2), sentence


# ─── БД ───────────────────────────────────────────────────────

def ensure_columns(cur: sqlite3.Cursor) -> None:
    cur.execute("PRAGMA table_info(words)")
    existing = {row[1] for row in cur.fetchall()}
    for col, typ in DEFAULT_COLUMNS.items():
        if col not in existing:
            cur.execute(f"ALTER TABLE words ADD COLUMN {col} {typ}")
            print(f"  ✚ Добавлена колонка: {col}")


def select_words(cur: sqlite3.Cursor, limit: int,
                 reprocess_long: float = 0.0) -> list[tuple]:
    if reprocess_long > 0:
        # Перезаписать записи где endTime - startTime > лимита
        cur.execute("""
            SELECT rowid, original, videoId FROM words
            WHERE  COALESCE(videoId, '') != ''
              AND  length(COALESCE(original,'')) >= 2
              AND  subtitleText IS NOT NULL
              AND  TRIM(subtitleText) != ''
              AND  (endTime - startTime) > ?
            LIMIT  ?
        """, (reprocess_long, limit))
    else:
        placeholders = ",".join("?" * len(EMPTY_VALUES))
        cur.execute(f"""
            SELECT rowid, original, videoId FROM words
            WHERE  COALESCE(videoId, '') != ''
              AND  length(COALESCE(original,'')) >= 2
              AND  (subtitleText IS NULL OR TRIM(subtitleText) IN ({placeholders}))
            LIMIT  ?
        """, (*EMPTY_VALUES, limit))
    return cur.fetchall()


# ─── Основной цикл ────────────────────────────────────────────

def refine(args: argparse.Namespace) -> None:

    # Инициализируем ротатор прокси
    if args.tor:
        rotator = ProxyRotator(
            mode="tor",
            tor_host=args.tor_host,
            tor_port=args.tor_port,
            tor_control_port=args.tor_control_port,
            tor_password=args.tor_password,
        )
    elif args.proxy_list:
        proxies = load_proxy_list(args.proxy_list)
        if not proxies:
            print("❌ Файл прокси пустой!")
            return
        rotator = ProxyRotator(mode="list", proxies=proxies)
    elif args.proxy:
        rotator = ProxyRotator(mode="list", proxies=[args.proxy])
    else:
        rotator = ProxyRotator(mode="none")

    conn = sqlite3.connect(args.db)
    cur  = conn.cursor()
    ensure_columns(cur)
    conn.commit()

    rows = select_words(cur, args.limit, reprocess_long=getattr(args, "reprocess_long", 0.0))
    if not rows:
        print("✨ Нет слов для обработки.")
        conn.close()
        return

    print(f"📋 Слов к обработке: {len(rows)}")
    if rotator.current_proxy:
        print(f"  🌐 Прокси: {rotator.current_proxy}")
    if args.cookies_file:
        print(f"  🍪 Cookies: {args.cookies_file}")
    print()

    ok = fail_count = 0

    for idx, (rowid, word, video_id) in enumerate(rows, 1):
        if not word or not video_id:
            continue

        print(f"[{idx}/{len(rows)}] 🔍 '{word}' ({video_id})", end=" ... ", flush=True)

        # Пробуем загрузить субтитры — при 429 меняем IP и повторяем
        max_retries = max(1, len(rotator.proxies) if rotator.mode == "list" else 3)
        chunks = lang = None

        for attempt in range(1, max_retries + 2):
            try:
                chunks, lang = fetch_chunks(video_id, rotator.current_proxy, args.cookies_file)
                fail_count = 0
                break

            except KeyboardInterrupt:
                print("\n⛔ Прервано.")
                conn.close()
                return

            except Exception as exc:
                msg = str(exc)
                is_rate  = any(x in msg for x in ("429", "Too Many", "blocked", "Forbidden", "403"))
                no_subs  = "не найдены" in msg or "no subtitle" in msg.lower() or "not found" in msg.lower()

                if no_subs:
                    print("⚠️  нет субтитров")
                    cur.execute("UPDATE words SET subtitleText=? WHERE rowid=?",
                                ("Check video for context", rowid))
                    conn.commit()
                    chunks = None
                    break

                if is_rate:
                    print(f"❌ 429", end="")
                    if attempt <= max_retries:
                        print(f" — меняю IP (попытка {attempt})...", end=" ", flush=True)
                        rotator.rotate()
                        continue  # повторяем с новым IP
                    else:
                        print(f" — попытки исчерпаны")
                        fail_count += 1

                else:
                    print(f"❌ {msg[:80]}")
                    fail_count += 1

                break

        if fail_count >= args.max_consecutive_errors:
            print(f"🛑 {fail_count} ошибок подряд — останавливаюсь.")
            break

        if chunks is None:
            if idx < len(rows):
                time.sleep(random.uniform(1, 3))
            continue

        # Ищем слово в субтитрах
        result = find_sentence(chunks, word, max_duration=args.max_duration)
        if result is None:
            print("⚠️  слово не найдено в субтитрах")
            cur.execute("UPDATE words SET subtitleText=? WHERE rowid=?",
                        ("Check video for context", rowid))
            conn.commit()
        else:
            start, end, sentence = result
            now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
            cur.execute("""
                UPDATE words
                SET startTime=?, endTime=?, subtitleText=?, subtitleLang=?, subtitleUpdatedAt=?
                WHERE rowid=?
            """, (start, end, sentence, lang, now_iso, rowid))
            conn.commit()
            preview = sentence[:70] + ("…" if len(sentence) > 70 else "")
            print(f"✅ [{start}s–{end}s]  «{preview}»")
            ok += 1

        if idx < len(rows):
            time.sleep(random.uniform(args.sleep_min, args.sleep_max))

    conn.close()
    print(f"\n🏁 Готово!  ✅ {ok}  ❌ {len(rows) - ok}")


# ─── CLI ──────────────────────────────────────────────────────

def main() -> None:
    p = argparse.ArgumentParser(
        description="Refine subtitle segments — с авто-сменой IP при 429",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Варианты запуска:

  1. Tor (автосмена IP при каждом 429):
     Сначала установи и запусти Tor:
       pip install stem
       Скачай tor.exe: https://www.torproject.org/download/tor/
       Запусти tor.exe
     Потом:
       python refine_segments.py --db ./vocab.db --tor

  2. Список прокси (файл proxies.txt, по одному на строку):
     python refine_segments.py --db ./vocab.db --proxy-list ./proxies.txt
     Формат строк: 192.168.1.1:1080  или  socks5://user:pass@host:port

  3. Один прокси:
     python refine_segments.py --db ./vocab.db --proxy "socks5://127.0.0.1:1080"

  4. Только cookies (без смены IP):
     python refine_segments.py --db ./vocab.db --cookies-file ./cookies.txt
        """
    )
    p.add_argument("--db",            default="./vocab.db")
    p.add_argument("--limit",         type=int,   default=100)
    p.add_argument("--cookies-file",  default=None)

    # Прокси
    g = p.add_mutually_exclusive_group()
    g.add_argument("--tor",        action="store_true", help="Использовать Tor с автосменой IP")
    g.add_argument("--proxy-list", default=None,        help="Файл со списком прокси")
    g.add_argument("--proxy",      default=None,        help="Один прокси URL")

    # Tor настройки
    p.add_argument("--tor-host",         default="127.0.0.1")
    p.add_argument("--tor-port",         type=int, default=9050)
    p.add_argument("--tor-control-port", type=int, default=9051)
    p.add_argument("--tor-password",     default="",
                   help="Пароль Tor контроллера (если задан в torrc)")

    # Паузы и лимиты
    p.add_argument("--sleep-min",             type=float, default=3.0)
    p.add_argument("--sleep-max",             type=float, default=8.0)
    p.add_argument("--max-consecutive-errors", type=int,  default=10)
    p.add_argument("--max-duration", type=float, default=15.0,
                   help="Макс. длина фрагмента в секундах (default: 15)")
    p.add_argument("--reprocess-long", type=float, default=0.0, metavar="SEC",
                   help="Перезаписать записи длиннее SEC секунд (напр. --reprocess-long 15)")

    args = p.parse_args()
    args.sleep_max = max(args.sleep_min, args.sleep_max)
    refine(args)


if __name__ == "__main__":
    main()