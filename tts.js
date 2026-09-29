// Озвучка норвежских слов через Piper — нейросетевой синтез речи, который
// работает локально, без интернета и ключей.
//
// Браузерный speechSynthesis на Linux идёт через speech-dispatcher и espeak-ng:
// синтезатор из 90-х, который звучит роботом. Piper с моделью
// no_NO-talesyntese-medium звучит почти как живой диктор.
//
// Каждое слово синтезируется один раз и кешируется на диске. Если Piper не
// установлен, эндпоинт отвечает 503, и клиент возвращается к браузерной речи.
// Установка голоса: deploy/install-voice.sh.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const rateLimit = require('express-rate-limit');

const MAX_TEXT = 200;
const SYNTH_TIMEOUT_MS = 20000;

function config() {
    const root = __dirname;
    return {
        bin: process.env.PIPER_BIN || path.join(root, '.venv-tts', 'bin', 'piper'),
        model: path.resolve(root, process.env.PIPER_MODEL || 'voices/no_NO-talesyntese-medium.onnx'),
        cacheDir: path.resolve(root, process.env.TTS_CACHE_DIR || 'tts-cache'),
    };
}

function isExecutable(file) {
    try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

function status() {
    const c = config();
    const hasBin = isExecutable(c.bin);
    const hasModel = fs.existsSync(c.model);
    return {
        available: hasBin && hasModel,
        engine: 'piper',
        voice: path.basename(c.model, '.onnx'),
        missing: [!hasBin && 'piper', !hasModel && 'model'].filter(Boolean),
    };
}

// Текст приводится к одному виду, чтобы «Et hus » и «et hus» делили один файл.
function normalizeText(raw) {
    return String(raw || '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

function cachePath(c, text) {
    const key = crypto.createHash('sha1')
        .update(path.basename(c.model)).update('\0').update(text.toLowerCase())
        .digest('hex');
    return path.join(c.cacheDir, `${key}.wav`);
}

// Одновременные запросы одного и того же слова ждут один синтез.
const inFlight = new Map();

function synthesize(c, text, target) {
    if (inFlight.has(target)) return inFlight.get(target);
    const job = new Promise((resolve, reject) => {
        fs.mkdirSync(c.cacheDir, { recursive: true });
        const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
        // -m/-f понимают и старый piper (C++), и новый piper-tts (Python).
        const child = spawn(c.bin, ['-m', c.model, '-f', tmp], { stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), SYNTH_TIMEOUT_MS);
        child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
        child.on('error', (err) => { clearTimeout(timer); reject(err); });
        child.on('close', (code) => {
            clearTimeout(timer);
            let size = 0;
            try { size = fs.statSync(tmp).size; } catch { /* нет файла */ }
            if (code !== 0 || size <= 44) {
                fs.rmSync(tmp, { force: true });
                return reject(new Error(`piper exited with ${code}: ${stderr.trim().split('\n').pop() || 'no output'}`));
            }
            fs.renameSync(tmp, target);
            resolve(target);
        });
        child.stdin.end(text + '\n');
    }).finally(() => inFlight.delete(target));
    inFlight.set(target, job);
    return job;
}

const router = express.Router();

// Синтез — тяжёлая операция, но кешированные слова отдаются с диска мгновенно.
// Лимит защищает только от случайного цикла на клиенте.
const ttsLimiter = rateLimit({ windowMs: 60 * 1000, max: 300 });

router.get('/api/tts/status', (req, res) => {
    res.json(status());
});

router.get('/api/tts', ttsLimiter, async (req, res) => {
    const text = normalizeText(req.query.text);
    if (!text || text.length > MAX_TEXT) {
        return res.status(400).json({ error: `text required, up to ${MAX_TEXT} characters` });
    }
    const s = status();
    if (!s.available) {
        return res.status(503).json({ error: 'tts-unavailable', missing: s.missing });
    }
    const c = config();
    const target = cachePath(c, text);
    try {
        if (!fs.existsSync(target)) await synthesize(c, text, target);
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        res.type('audio/wav').sendFile(target);
    } catch (err) {
        console.error('TTS:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'synthesis failed' });
    }
});

module.exports = { router, status, normalizeText };
