from youtube_transcript_api import YouTubeTranscriptApi

# ID видео про Apple, которое у тебя находилось раньше
vid = "o98SqAMxEMU" 

try:
    print(f"Проверяю видео {vid}...")
    # Создаем объект через конструктор
    api = YouTubeTranscriptApi()
    ts_list = api.list(vid)
    
    # Пытаемся найти любые английские субтитры
    ts = ts_list.find_transcript(['en'])
    data = ts.fetch()
    
    print(f"✅ УСПЕХ! Найдено строк субтитров: {len(data)}")
    print(f"Первая фраза: {data[0]['text']}")
except Exception as e:
    print(f"❌ ОШИБКА: {e}")