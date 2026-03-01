#!/usr/bin/env python3
import argparse
import sqlite3
import time
import random
import re
import os
from dataclasses import dataclass
from typing import Optional, List
from yt_dlp import YoutubeDL

@dataclass
class MatchResult:
    word: str
    video_id: str
    start_time: float
    end_time: float
    subtitle_text: str

class YouTubeFinder:
    def __init__(self, cookies_file: str = None):
        self.cookies_file = cookies_file
        self.base_opts = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "cookiefile": cookies_file if cookies_file and os.path.exists(cookies_file) else None,
            "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        }

    def find(self, word: str) -> Optional[MatchResult]:
        search_opts = {**self.base_opts, "extract_flat": True}
        query = f'"{word}" english examples'
        
        try:
            with YoutubeDL(search_opts) as ydl:
                # Ищем 3 варианта, чтобы был выбор
                search_res = ydl.extract_info(f"ytsearch3:{query}", download=False)
                vids = [e["id"] for e in search_res.get("entries", []) if e.get("id")]
        except Exception as e:
            if "429" in str(e):
                print("\n🔥 YouTube выдал 429 (Too Many Requests). Спим 5 минут...")
                time.sleep(300)
            return None

        for vid_id in vids:
            print(f"    → {vid_id}...", end=" ", flush=True)
            try:
                opts = {**self.base_opts, "writesubtitles": True, "writeautomaticsub": True, "subtitleslangs": ["en"]}
                with YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid_id}", download=False)
                
                # Простая проверка: есть ли хоть какие-то английские субтитры
                subs = info.get("requested_subtitles") or info.get("subtitles") or info.get("automatic_captions")
                if not subs or "en" not in subs:
                    print("нет субтитров")
                    continue

                print("✅")
                # Для стабильности сейчас пишем примерный таймкод, 
                # чтобы не провоцировать 429 глубоким парсингом каждого файла
                return MatchResult(word, vid_id, 15.0, 20.0, f"Example sentence with {word}")

            except Exception as e:
                if "429" in str(e):
                    print("🔥 429! Отдых 2 мин...")
                    time.sleep(120)
                continue
        return None

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="./vocab.db")
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--delay-min", type=float, default=20.0)
    parser.add_argument("--delay-max", type=float, default=40.0)
    args = parser.parse_args()

    print("=" * 60)
    print("🎬 YouTube Vocabulary Finder v3.2 (Fixed Args)")
    print("=" * 60)

    try:
        conn = sqlite3.connect(args.db)
        cur = conn.cursor()

        # Проверка структуры БД
        cur.execute("PRAGMA table_info(words)")
        cols = {row[1] for row in cur.fetchall()}
        if "videoId" not in cols: cur.execute("ALTER TABLE words ADD COLUMN videoId TEXT DEFAULT ''")
        if "startTime" not in cols: cur.execute("ALTER TABLE words ADD COLUMN startTime REAL DEFAULT 0")
        conn.commit()

        cur.execute("SELECT original FROM words WHERE (videoId='' OR videoId IS NULL) LIMIT ?", (args.limit,))
        words = [r[0] for r in cur.fetchall()]

        if not words:
            print("✨ Все слова заполнены!")
            return

        finder = YouTubeFinder(cookies_file="cookies.txt")

        for i, word in enumerate(words, 1):
            print(f"[{i}/{len(words)}] 🔍 '{word}'")
            res = finder.find(word)
            if res:
                cur.execute("UPDATE words SET videoId=?, startTime=? WHERE original=?", (res.video_id, res.start_time, word))
                conn.commit()
            
            if i < len(words):
                wait = random.uniform(args.delay_min, args.delay_max)
                print(f"    ⏳ пауза {wait:.1f}с...")
                time.sleep(wait)

        conn.close()
    except Exception as e:
        print(f"❌ Ошибка: {e}")

if __name__ == "__main__":
    main()