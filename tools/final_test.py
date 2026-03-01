#!/usr/bin/env python3
import sqlite3
import time
import random
import json
import subprocess
import re

def get_precise_range(v_id, target_word):
    try:
        # Запускаем CLI версию
        cmd = ["youtube-transcript-api", v_id, "--format", "json"]
        result = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8')
        
        if result.returncode != 0:
            return None

        transcript = json.loads(result.stdout)
        
        # Регулярка для поиска слова как отдельного элемента (границы слова \b)
        # Это спасет нас от поиска буквы 'a' внутри слова 'apple'
        pattern = re.compile(r'\b' + re.escape(target_word) + r'\b', re.IGNORECASE)
        
        for i, entry in enumerate(transcript):
            text = entry['text'].replace('\n', ' ')
            
            # 1. Сначала ищем точное совпадение
            match = pattern.search(text)
            
            # 2. Если слово длинное (не артикль) и точного нет, ищем просто вхождение
            if not match and len(target_word) > 3:
                if target_word.lower() in text.lower():
                    match = True
            
            if match:
                raw_start = entry['start']
                raw_dur = entry.get('duration', 4.0)
                
                # Делаем красивый отрезок: -1.5 сек до, +3 сек после
                new_start = max(0, raw_start - 1.5)
                new_end = raw_start + raw_dur + 3.0
                
                # Берем текущую фразу и следующую для полноты смысла
                context = text
                if i + 1 < len(transcript):
                    next_text = transcript[i+1]['text'].replace('\n', ' ')
                    context += " " + next_text
                    new_end = transcript[i+1]['start'] + transcript[i+1].get('duration', 2.0)

                return round(new_start, 2), round(new_end, 2), context.strip()
                
        return "NOT_IN_TEXT"
    except Exception as e:
        return f"ERROR: {str(e)[:20]}"

def main():
    db_path = "./vocab.db"
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    # Берем те, где есть видео, но еще нет нормальной подрезки (startTime был 0 или 10)
    cur.execute("SELECT original, videoId FROM words WHERE videoId != '' AND videoId IS NOT NULL LIMIT 100")
    rows = cur.fetchall()

    print(f"✂️ Ювелирная подрезка v2.0 (Regex Mode)")
    print(f"Обрабатываем пул из {len(rows)} слов...")

    for word, v_id in rows:
        print(f"🔍 '{word}'...", end=" ", flush=True)
        
        res = get_precise_range(v_id, word)
        
        if isinstance(res, tuple):
            start, end, text = res
            cur.execute("""
                UPDATE words SET startTime = ?, endTime = ?, subtitleText = ? 
                WHERE original = ? AND videoId = ?
            """, (start, end, text, word, v_id))
            conn.commit()
            print(f"✅ {start}s -> {end}s")
        else:
            print(f"❌ {res}")
            
        time.sleep(random.uniform(1, 2)) # Ускорился, т.к. CLI работает бодро

    conn.close()

if __name__ == "__main__":
    main()