#!/usr/bin/env python3
import argparse
import sqlite3
import time
import random
from dataclasses import dataclass
from typing import Optional
from yt_dlp import YoutubeDL

@dataclass
class MatchResult:
    word: str
    video_id: str
    start_time: float

class YouTubeFinder:
    def __init__(self):
        self.ydl_opts = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "extract_flat": False,
            "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        }

    def find(self, word: str) -> Optional[MatchResult]:
        query = f"sentence with the word {word} english"
        try:
            with YoutubeDL(self.ydl_opts) as ydl:
                search_data = ydl.extract_info(f"ytsearch1:{query}", download=False)
                if not search_data or 'entries' not in search_data or not search_data['entries']:
                    return None
                
                entry = search_data['entries'][0]
                return MatchResult(word, entry['id'], 5.0)
        except:
            return None

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="./vocab.db")
    parser.add_argument("--limit", type=int, default=100)
    args = parser.parse_args()

    try:
        conn = sqlite3.connect(args.db)
        cur = conn.cursor()
        
        # Проверяем колонки
        cur.execute("PRAGMA table_info(words)")
        cols = {row[1] for row in cur.fetchall()}
        if "videoId" not in cols: cur.execute("ALTER TABLE words ADD COLUMN videoId TEXT DEFAULT ''")
        if "startTime" not in cols: cur.execute("ALTER TABLE words ADD COLUMN startTime REAL DEFAULT 0")
        conn.commit()

        # Исправленный запрос получения слов
        cur.execute("""
            SELECT original FROM words 
            WHERE (videoId IS NULL OR videoId = '') 
              AND length(original) > 1 
            LIMIT ?
        """, (args.limit,))
        
        words = [row[0] for row in cur.fetchall()]
        
        if not words:
            print("✨ Все videoId уже заполнены. Работы нет!")
            return

        finder = YouTubeFinder()
        print(f"🤖 Автоматизация запущена! Обрабатываю {len(words)} слов...")

        for i, word in enumerate(words, start=1):
            res = finder.find(word)
            if res:
                # Вставляем ID видео прямо в базу
                cur.execute("UPDATE words SET videoId=?, startTime=? WHERE original=?", 
                            (res.video_id, res.start_time, word))
                conn.commit()
                print(f"[{i}/{len(words)}] ✅ {word} -> {res.video_id}")
            else:
                print(f"[{i}/{len(words)}] ❌ {word} -> пропуск")
            
            # Пауза для защиты от бана
            time.sleep(random.uniform(4, 8))

        conn.close()
        print("🏁 Автоматизация успешно завершена!")

    except Exception as e:
        print(f"❌ Ошибка: {e}")

if __name__ == "__main__":
    main()