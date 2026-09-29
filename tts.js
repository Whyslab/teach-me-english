// Озвучка норвежских слов через Piper — нейросетевой синтез речи, который
// работает локально, без интернета и ключей.
//
// Браузерный speechSynthesis на Linux идёт через speech-dispatcher и espeak-ng:
// синтезатор из 90-х, который звучит роботом. Piper с моделью
// no_NO-talesyntese-medium звучит почти как живой диктор.
//
// Как синтезируется:
//   1. Постоянный процесс tts_worker.py держит модель в памяти — слово за
//      доли секунды. Раньше на каждое слово запускался `piper`, и каждый раз
//      заново стартовал Python и грузилась модель (около секунды).
//   2. Если процесс не поднимается — разовый вызов `piper`, как раньше.
// Каждое слово синтезируется один раз на каждую скорость и кешируется на
// диске. Если Piper не установлен, эндпоинт отвечает 503, и клиент говорит
// браузерным голосом. Установка голоса: deploy/install-voice.sh.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const express = require('express');
const rateLimit = require('express-rate-limit');

const MAX_TEXT = 200;
const SYNTH_TIMEOUT_MS = 20000;
const WORKER_START_TIMEOUT_MS = 60000;   // первая загрузка модели на медленном диске
const WORKER_MAX_FAILURES = 3;
const quiet = process.env.NODE_ENV === 'test';

function config() {
    const root = __dirname;
    const bin = process.env.PIPER_BIN || path.join(root, '.venv-tts', 'bin', 'piper');
    const model = path.resolve(root, process.env.PIPER_MODEL || 'voices/no_NO-talesyntese-medium.onnx');
    // PIPER_WORKER: путь к исполняемому воркеру; пустая строка — не использовать.
    // По умолчанию — tts_worker.py под Python из того же venv, что и piper.
    let worker = null;
    if (process.env.PIPER_WORKER !== undefined) {
        if (process.env.PIPER_WORKER) worker = { cmd: process.env.PIPER_WORKER, args: [model] };
    } else {
        const python = path.join(path.dirname(bin), 'python');
        if (isExecutable(python)) worker = { cmd: python, args: [path.join(root, 'tts_worker.py'), model] };
    }
    return {
        bin,
        model,
        worker,
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
        mode: c.worker && !worker.disabled ? 'worker' : 'cli',
        missing: [!hasBin && 'piper', !hasModel && 'model'].filter(Boolean),
    };
}

// Текст приводится к одному виду, чтобы «Et hus » и «et hus» делили один файл.
function normalizeText(raw) {
    return String(raw || '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

// Скорость речи: 1 — как у модели, 0.5…1.5, шаг 0.05. Piper управляет
// скоростью через length_scale — длительность фонем, то есть обратную величину.
function parseRate(raw) {
    const r = Number(raw);
    if (!Number.isFinite(r) || r <= 0) return 1;
    return Math.round(Math.min(1.5, Math.max(0.5, r)) * 20) / 20;
}

function lengthScaleFor(rate) {
    return rate === 1 ? null : Math.round((1 / rate) * 1000) / 1000;
}

function cachePath(c, text, rate) {
    const key = crypto.createHash('sha1')
        .update(path.basename(c.model)).update('\0')
        .update(text.toLowerCase()).update('\0')
        .update(String(rate))
        .digest('hex');
    return path.join(c.cacheDir, `${key}.wav`);
}

// ---------------------------------------------------------------------------
// Постоянный процесс
// ---------------------------------------------------------------------------
const worker = {
    proc: null,
    ready: null,         // Promise, который резолвится после {"ready": true}
    pending: new Map(),  // id → { resolve, reject, timer }
    nextId: 1,
    failures: 0,
    disabled: false,
    key: '',
};

function stopWorker(reason) {
    const proc = worker.proc;
    worker.proc = null;
    worker.ready = null;
    for (const [, p] of worker.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(reason));
    }
    worker.pending.clear();
    if (proc && proc.exitCode === null) proc.kill('SIGKILL');
}

function startWorker(c) {
    const key = `${c.worker.cmd}\0${c.worker.args.join('\0')}`;
    if (worker.proc && worker.key === key) return worker.ready;
    if (worker.proc) stopWorker('worker config changed');

    worker.key = key;
    const proc = spawn(c.worker.cmd, c.worker.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    worker.proc = proc;
    let stderr = '';
    proc.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });

    worker.ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker did not become ready')), WORKER_START_TIMEOUT_MS);
        const lines = readline.createInterface({ input: proc.stdout });
        lines.on('line', (line) => {
            let msg;
            try { msg = JSON.parse(line); } catch { return; }
            if (msg.ready) {
                clearTimeout(timer);
                worker.failures = 0;
                if (!quiet) console.log('TTS: голос загружен, синтез в постоянном процессе.');
                resolve();
                return;
            }
            const p = worker.pending.get(msg.id);
            if (!p) return;
            worker.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.ok) p.resolve(); else p.reject(new Error(msg.error || 'synthesis failed'));
        });
        proc.on('error', (err) => { clearTimeout(timer); reject(err); });
        proc.on('exit', (code) => {
            clearTimeout(timer);
            const why = `worker exited with ${code}${stderr ? ': ' + stderr.trim().split('\n').pop() : ''}`;
            reject(new Error(why));
            if (worker.proc === proc) {
                worker.failures++;
                if (worker.failures >= WORKER_MAX_FAILURES) {
                    worker.disabled = true;
                    console.error(`TTS: постоянный процесс падает (${why}) — дальше разовый вызов piper.`);
                }
                stopWorker(why);
            }
        });
    });
    worker.ready.catch(() => {});
    return worker.ready;
}

async function synthesizeWithWorker(c, text, lengthScale, out) {
    await startWorker(c);
    const proc = worker.proc;
    if (!proc) throw new Error('worker is not running');
    const id = worker.nextId++;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            worker.pending.delete(id);
            reject(new Error('worker timeout'));
            stopWorker('worker timeout');   // завис — перезапустим при следующем запросе
        }, SYNTH_TIMEOUT_MS);
        worker.pending.set(id, { resolve, reject, timer });
        proc.stdin.write(JSON.stringify({ id, text, out, length_scale: lengthScale }) + '\n');
    });
}

// ---------------------------------------------------------------------------
// Разовый вызов piper (запасной путь)
// ---------------------------------------------------------------------------
function synthesizeWithCli(c, text, lengthScale, out) {
    return new Promise((resolve, reject) => {
        // -m/-f понимают и старый piper (C++), и новый piper-tts (Python).
        const args = ['-m', c.model, '-f', out];
        if (lengthScale !== null) args.push('--length-scale', String(lengthScale));
        const child = spawn(c.bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), SYNTH_TIMEOUT_MS);
        child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
        child.on('error', (err) => { clearTimeout(timer); reject(err); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) return reject(new Error(`piper exited with ${code}: ${stderr.trim().split('\n').pop() || 'no output'}`));
            resolve();
        });
        child.stdin.end(text + '\n');
    });
}

// Одновременные запросы одного и того же слова ждут один синтез.
const inFlight = new Map();

function synthesize(c, text, rate, target) {
    if (inFlight.has(target)) return inFlight.get(target);
    const job = (async () => {
        fs.mkdirSync(c.cacheDir, { recursive: true });
        const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
        const lengthScale = lengthScaleFor(rate);
        try {
            if (c.worker && !worker.disabled) {
                try {
                    await synthesizeWithWorker(c, text, lengthScale, tmp);
                } catch (err) {
                    if (!quiet) console.warn('TTS: постоянный процесс не справился, пробую разовый вызов:', err.message);
                    fs.rmSync(tmp, { force: true });
                    await synthesizeWithCli(c, text, lengthScale, tmp);
                }
            } else {
                await synthesizeWithCli(c, text, lengthScale, tmp);
            }
            let size = 0;
            try { size = fs.statSync(tmp).size; } catch { /* нет файла */ }
            if (size <= 44) throw new Error('piper produced no audio');
            fs.renameSync(tmp, target);
            return target;
        } catch (err) {
            fs.rmSync(tmp, { force: true });
            throw err;
        }
    })().finally(() => inFlight.delete(target));
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
    const rate = parseRate(req.query.rate);
    const target = cachePath(c, text, rate);
    try {
        if (!fs.existsSync(target)) await synthesize(c, text, rate, target);
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        res.type('audio/wav').sendFile(target);
    } catch (err) {
        console.error('TTS:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'synthesis failed' });
    }
});

// Постоянный процесс не должен пережить сервер.
process.on('exit', () => stopWorker('server exit'));

// Для тестов: сбросить состояние постоянного процесса.
function resetWorker() {
    stopWorker('reset');
    worker.failures = 0;
    worker.disabled = false;
}

module.exports = { router, status, normalizeText, parseRate, lengthScaleFor, resetWorker };
