#!/usr/bin/env python3
"""Постоянный процесс синтеза речи для tts.js.

Запуск `piper` на каждое слово стоил около секунды: каждый раз заново
стартовал Python, грузился onnxruntime и читалась модель. Этот процесс
загружает модель один раз и дальше синтезирует слово за доли секунды.

Протокол — JSON построчно:
  stdin:  {"id": 1, "text": "et hus", "out": "/path/file.wav", "length_scale": 1.0}
  stdout: {"ready": true}                    — после загрузки модели
          {"id": 1, "ok": true}              — файл записан
          {"id": 1, "ok": false, "error": "…"}

Запускается интерпретатором из .venv-tts (см. deploy/install-voice.sh):
  .venv-tts/bin/python tts_worker.py voices/no_NO-talesyntese-medium.onnx
"""
import json
import sys
import wave

from piper import PiperVoice, SynthesisConfig


def reply(message):
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    voice = PiperVoice.load(sys.argv[1])
    reply({"ready": True, "sample_rate": voice.config.sample_rate})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            config = SynthesisConfig(length_scale=request.get("length_scale"))
            with wave.open(request["out"], "wb") as wav_file:
                voice.synthesize_wav(request["text"], wav_file, syn_config=config)
            reply({"id": request_id, "ok": True})
        except Exception as error:  # noqa: BLE001 — любая ошибка уходит клиенту
            reply({"id": request_id, "ok": False, "error": str(error)})


if __name__ == "__main__":
    main()
