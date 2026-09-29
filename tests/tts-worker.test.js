// Постоянный процесс синтеза (tts_worker.py) — на поддельном воркере с тем же
// протоколом. Отдельный файл = отдельный процесс со своими переменными окружения.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tme-worker-'));
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = path.join(DIR, 'vocab.db');
fs.writeFileSync(path.join(DIR, 'voice.onnx'), 'model');
process.env.PIPER_BIN = path.join(__dirname, 'fixtures', 'fake-piper.js');
process.env.PIPER_MODEL = path.join(DIR, 'voice.onnx');
process.env.PIPER_WORKER = path.join(__dirname, 'fixtures', 'fake-worker.js');
process.env.TTS_CACHE_DIR = path.join(DIR, 'cache');
process.env.FAKE_WORKER_LOG = path.join(DIR, 'worker.log');
process.env.FAKE_PIPER_LOG = path.join(DIR, 'cli.log');

const request = require('supertest');
const { app } = require('../server.js');
const { parseRate, lengthScaleFor, resetWorker } = require('../tts.js');

const lines = (f) => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
const workerLog = () => lines(process.env.FAKE_WORKER_LOG);
const cliLog = () => lines(process.env.FAKE_PIPER_LOG);
const tts = (text, rate) => request(app).get(`/api/tts?text=${encodeURIComponent(text)}${rate ? `&rate=${rate}` : ''}`);

test.after(() => {
    resetWorker();
    fs.rmSync(DIR, { recursive: true, force: true });
});

test('status reports the worker mode', async () => {
    const res = await request(app).get('/api/tts/status').expect(200);
    assert.equal(res.body.mode, 'worker');
});

test('one worker process serves many words', async () => {
    for (const w of ['hus', 'bok', 'katt']) {
        const res = await tts(w).expect(200);
        assert.ok(res.body.toString().includes(`WORKER:${w}:null`));
    }
    assert.equal(workerLog().filter(l => l === 'start').length, 1, 'started once');
    assert.equal(cliLog().length, 0, 'the one-shot CLI was not used');
});

test('concurrent requests are answered in order and deduplicated', async () => {
    const texts = ['en', 'to', 'tre', 'fire', 'fem', 'en'];
    const results = await Promise.all(texts.map(t => tts(t)));
    results.forEach((r, i) => {
        assert.equal(r.status, 200);
        assert.ok(r.body.toString().includes(`WORKER:${texts[i]}:`), `response ${i} has its own audio`);
    });
    assert.equal(workerLog().filter(l => l.startsWith('en @')).length, 1, '"en" synthesized once');
});

test('speech rate becomes length_scale and is part of the cache key', async () => {
    assert.equal(parseRate('0.8'), 0.8);
    assert.equal(parseRate('0.83'), 0.85, 'step 0.05');
    assert.equal(parseRate('9'), 1.5);
    assert.equal(parseRate('abc'), 1);
    assert.equal(lengthScaleFor(1), null, 'normal speed keeps the model default');
    assert.equal(lengthScaleFor(0.8), 1.25);

    await tts('sakte', 0.8).expect(200);
    await tts('sakte').expect(200);
    const log = workerLog();
    assert.ok(log.includes('sakte @1.25'));
    assert.ok(log.includes('sakte @null'), 'another speed is another file');
});

test('a synthesis error is reported and the worker keeps running', async () => {
    const starts = workerLog().filter(l => l === 'start').length;
    // Воркер ответил ошибкой — сервер пробует разовый piper (он справляется).
    await tts('ERROR').expect(200);
    assert.ok(cliLog().includes('ERROR'), 'fell back to the CLI');
    await tts('etter').expect(200);
    assert.equal(workerLog().filter(l => l === 'start').length, starts, 'no restart needed');
});

test('a crashed worker is restarted on the next request', async () => {
    const starts = workerLog().filter(l => l === 'start').length;
    await tts('CRASH').expect(200);           // CLI подхватывает этот запрос
    await tts('igjen').expect(200);
    assert.ok(workerLog().includes('igjen @null'), 'the next word went to a fresh worker');
    assert.equal(workerLog().filter(l => l === 'start').length, starts + 1);
});

test('a worker that cannot start falls back to the CLI for good', async () => {
    resetWorker();
    process.env.FAKE_WORKER_BROKEN = '1';
    try {
        for (const w of ['a1', 'a2', 'a3', 'a4']) await tts(w).expect(200);
        const status = await request(app).get('/api/tts/status').expect(200);
        assert.equal(status.body.mode, 'cli');
        assert.ok(cliLog().includes('a4'));
    } finally {
        delete process.env.FAKE_WORKER_BROKEN;
        resetWorker();
    }
});
