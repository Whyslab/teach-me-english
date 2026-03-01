#!/usr/bin/env python3
import sqlite3
import time
import random
import json
import subprocess

def get_precise_range(v_id, target_word):
    """Скачивает субтитры и находит идеальный узкий таймкод для слова"""
    try:
        # Вызываем CLI инструмент для получения JSON субтитров
        cmd = ["youtube-transcript-api", v_id, "--format", "json"]
        result = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8')
        
        if result.returncode != 0:
            return None

        transcript = json.loads(result.stdout)
        word_low = target_word.lower()
        
        for i, entry in enumerate(transcript):
            if word_low in entry['text'].lower():
                # Нашли! Теперь делаем красивый "надрез"
                raw_start = entry['start']
                raw_duration = entry.get('duration', 5.0)
                
                # Логика обрезки:
                # Начинаем за 2 секунды до (чтобы фраза не обрывалась)
                new_start = max(0, raw_start - 2.0)
                
                # Заканчиваем через 5-7 секунд, или захватываем следующую фразу
                new_end = raw_start + raw_duration + 3.0
                
                # Формируем чистый текст предложения
                clean_text = entry['text'].replace('\n', ' ')
                if i + 1 < len(transcript):
                    clean_text += " " + transcript[i+1]['text'].replace('\n', ' ')
                
                return round(new_start, 2), round(new_end, 2), clean_text.strip()
        return None
    except:
        return None

def main():
    db_path = "./vocab.db"
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    # Выбираем слова, где видео уже привязано
    cur.execute("SELECT original, videoId FROM words WHERE videoId != '' AND videoId IS NOT NULL")
    rows = cur.fetchall()

    print(f"✂️ Начинаем ювелирную подрезку для {len(rows)} слов...")

    for word, v_id in rows:
        print(f"🎯 Оптимизируем '{word}'...", end=" ", flush=True)
        
        result = get_precise_range(v_id, word)
        
        if result:
            start, end, text = result
            cur.execute("""
                UPDATE words 
                SET startTime = ?, endTime = ?, subtitleText = ? 
                WHERE original = ? AND videoId = ?
            """, (start, end, text, word, v_id))
            conn.commit()
            print(f"✅ Теперь: {start}s -> {end}s (было сокращено)")
        else:
            print("❌ слово не найдено в субтитрах")
            
        time.sleep(random.uniform(1.5, 3))

    conn.close()
    print("🚀 Все таймкоды уточнены!")

if __name__ == "__main__":
    main()