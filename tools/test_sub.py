from youtube_transcript_api import YouTubeTranscriptApi

video_id = "8f3_8p8Uv-8" # Популярное видео с английской речью
try:
    sub = YouTubeTranscriptApi.get_transcript(video_id, languages=['en'])
    print("✅ Субтитры работают! Проблема была только в поиске.")
    print(f"Первая строка: {sub[0]['text']}")
except Exception as e:
    print(f"❌ Даже субтитры не качаются: {e}")