const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the server at a throwaway database before importing it.
const DB = path.join(os.tmpdir(), `tme-test-${process.pid}.db`);
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = DB;

// Озвучка: поддельный piper и временный каталог для кеша звука.
const TTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tme-tts-'));
const FAKE_MODEL = path.join(TTS_DIR, 'voice.onnx');
fs.writeFileSync(FAKE_MODEL, 'model');
process.env.PIPER_BIN = path.join(__dirname, 'fixtures', 'fake-piper.js');
process.env.PIPER_MODEL = FAKE_MODEL;
process.env.TTS_CACHE_DIR = path.join(TTS_DIR, 'cache');
process.env.FAKE_PIPER_LOG = path.join(TTS_DIR, 'calls.log');

const request = require('supertest');
const { app, db, validateWord } = require('../server.js');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(DB + suffix, { force: true });
  }
  fs.rmSync(TTS_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Service worker: версия и список кеша подставляются сервером
// ---------------------------------------------------------------------------
test('GET /sw.js precaches every frontend module and carries a content hash', async () => {
  const res = await request(app).get('/sw.js').expect(200);
  assert.doesNotMatch(res.text, /__ASSET_VERSION__|__PRECACHE__/, 'placeholders must be filled');
  assert.match(res.text, /const VERSION\s*=\s*'norsk-[0-9a-f]{12}'/);
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'js')).filter(f => f.endsWith('.js'))) {
    assert.ok(res.text.includes(`"/js/${f}"`), `sw.js does not precache js/${f}`);
  }
  for (const needed of ['"/"', '"/css/app.css"', '"/decks/a1.txt"', '"/manifest.json"']) {
    assert.ok(res.text.includes(needed), `sw.js does not precache ${needed}`);
  }
  assert.ok(!res.text.includes('package.json'), 'js/package.json is not a public file');
  new Function(res.text.replace(/self\.addEventListener/g, '(()=>{})'));  // синтаксис валиден
});

test('GET /sw.js version is stable between requests', async () => {
  const a = (await request(app).get('/sw.js')).text.match(/norsk-([0-9a-f]{12})/)[1];
  const b = (await request(app).get('/sw.js')).text.match(/norsk-([0-9a-f]{12})/)[1];
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// Инкрементальная синхронизация
// ---------------------------------------------------------------------------
test('POST /api/words/batch inserts, updates and deletes individual words', async () => {
  await request(app).post('/api/sync').send([
    { id: 501, original: 'hus', translate: 'дом' },
    { id: 502, original: 'bok', translate: 'книга' },
    { id: 503, original: 'katt', translate: 'кот' },
  ]).expect(200);

  const res = await request(app).post('/api/words/batch').send({
    upserts: [
      { id: 502, original: 'bok', translate: 'книга', level: 3, sm2Reps: 2, history: [{ ts: 1, q: 2, ef: 2.5 }] },
      { id: 504, original: 'hund', translate: 'собака', pos: 'noun', gender: 'm' },
    ],
    deletes: [503],
  }).expect(200);
  assert.deepStrictEqual(res.body, { status: 'success', upserted: 2, deleted: 1 });

  const words = (await request(app).get('/api/words').expect(200)).body;
  const byId = Object.fromEntries(words.map(w => [w.id, w]));
  assert.deepStrictEqual(Object.keys(byId).map(Number).sort(), [501, 502, 504]);
  assert.equal(byId[501].translate, 'дом', 'untouched word stays');
  assert.equal(byId[502].level, 3);
  assert.equal(byId[502].history.length, 1);
  assert.equal(byId[504].gender, 'm');
});

test('POST /api/words/batch is idempotent', async () => {
  const batch = { upserts: [{ id: 601, original: 'sol', translate: 'солнце' }], deletes: [602] };
  await request(app).post('/api/words/batch').send(batch).expect(200);
  await request(app).post('/api/words/batch').send(batch).expect(200);
  const words = (await request(app).get('/api/words').expect(200)).body;
  assert.equal(words.filter(w => w.id === 601).length, 1);
});

test('POST /api/words/batch validates its input', async () => {
  await request(app).post('/api/words/batch').send({ upserts: 'x' }).expect(400);
  await request(app).post('/api/words/batch').send({ upserts: [{ id: 'x', original: 'a', translate: 'b' }] }).expect(400);
  await request(app).post('/api/words/batch').send({ deletes: ['1'] }).expect(400);
  await request(app).post('/api/words/batch').send({}).expect(200);
});

test('POST /api/words/batch accepts a sendBeacon-style request', async () => {
  // sendBeacon шлёт Blob с type application/json — тело то же, что у fetch.
  await request(app).post('/api/words/batch')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ upserts: [{ id: 701, original: 'tog', translate: 'поезд' }] }))
    .expect(200);
});

test('a failing batch leaves the database unchanged', async () => {
  const before = (await request(app).get('/api/words').expect(200)).body.length;
  // Невалидное второе слово отклоняет весь пакет — первое тоже не записывается.
  await request(app).post('/api/words/batch')
    .send({ upserts: [{ id: 801, original: 'a', translate: 'b' }, { id: 802, original: 'x'.repeat(101), translate: 'b' }] })
    .expect(400);
  const after = (await request(app).get('/api/words').expect(200)).body.length;
  assert.equal(after, before);
});

// ---------------------------------------------------------------------------
// Озвучка через Piper
// ---------------------------------------------------------------------------
const piperCalls = () => {
  try { return fs.readFileSync(process.env.FAKE_PIPER_LOG, 'utf8').trim().split('\n').filter(Boolean); }
  catch { return []; }
};

test('GET /api/tts/status reports the voice as available', async () => {
  const res = await request(app).get('/api/tts/status').expect(200);
  assert.equal(res.body.available, true);
  assert.equal(res.body.voice, 'voice');
});

test('GET /api/tts synthesizes a wav and caches it', async () => {
  const first = await request(app).get('/api/tts?text=' + encodeURIComponent('et hus')).expect(200);
  assert.match(first.headers['content-type'], /audio\/wav/);
  assert.match(first.headers['cache-control'], /immutable/);
  assert.ok(first.body.toString().includes('FAKE-AUDIO:et hus'));
  const calls = piperCalls().length;

  // Тот же текст с другим регистром и пробелами — из кеша, без нового синтеза.
  await request(app).get('/api/tts?text=' + encodeURIComponent('  Et   hus ')).expect(200);
  assert.equal(piperCalls().length, calls);
});

test('GET /api/tts synthesizes a word only once under concurrent requests', async () => {
  const before = piperCalls().length;
  const url = '/api/tts?text=' + encodeURIComponent('å reise');
  const results = await Promise.all([1, 2, 3, 4].map(() => request(app).get(url)));
  results.forEach(r => assert.equal(r.status, 200));
  assert.equal(piperCalls().length, before + 1);
});

test('GET /api/tts keeps Norwegian letters intact', async () => {
  const res = await request(app).get('/api/tts?text=' + encodeURIComponent('kjøkken, blåbær')).expect(200);
  assert.ok(res.body.toString().includes('kjøkken, blåbær'));
});

test('GET /api/tts rejects empty and over-long text', async () => {
  await request(app).get('/api/tts?text=').expect(400);
  await request(app).get('/api/tts?text=%20%20').expect(400);
  await request(app).get('/api/tts?text=' + 'a'.repeat(201)).expect(400);
});

test('GET /api/tts reports a synthesis failure and caches nothing', async () => {
  await request(app).get('/api/tts?text=FAIL').expect(500);
  const cached = fs.readdirSync(process.env.TTS_CACHE_DIR);
  assert.ok(cached.every(f => f.endsWith('.wav')), 'no temporary files left behind');
  assert.equal(cached.length, 3);
});

test('GET /api/tts answers 503 when Piper is not installed', async () => {
  const saved = process.env.PIPER_BIN;
  process.env.PIPER_BIN = path.join(TTS_DIR, 'no-such-piper');
  try {
    const status = await request(app).get('/api/tts/status').expect(200);
    assert.equal(status.body.available, false);
    assert.deepStrictEqual(status.body.missing, ['piper']);
    const res = await request(app).get('/api/tts?text=hei').expect(503);
    assert.equal(res.body.error, 'tts-unavailable');
  } finally {
    process.env.PIPER_BIN = saved;
  }
});

const word = (over = {}) => ({
  id: 1,
  original: 'katt',
  translate: 'кот',
  ...over,
});

test('validateWord: tags are optional', () => {
  // Regression: the old implementation ended with `w.tags?.every(...)`, which
  // is undefined when tags is absent, so a word with no tags was rejected —
  // and /api/sync validates with .every(), so one such word failed the lot.
  assert.strictEqual(validateWord(word()), true);
});

test('validateWord: an empty tag array is fine', () => {
  assert.strictEqual(validateWord(word({ tags: [] })), true);
});

test('validateWord: string tags are fine', () => {
  assert.strictEqual(validateWord(word({ tags: ['animals', 'a1'] })), true);
});

test('validateWord: non-string tags are rejected', () => {
  assert.strictEqual(validateWord(word({ tags: [42] })), false);
});

test('validateWord: an over-long tag is rejected', () => {
  assert.strictEqual(validateWord(word({ tags: ['x'.repeat(51)] })), false);
});

test('validateWord: tags must be an array', () => {
  assert.strictEqual(validateWord(word({ tags: 'animals' })), false);
});

test('validateWord: a non-numeric id is rejected', () => {
  assert.strictEqual(validateWord(word({ id: '1' })), false);
});

test('validateWord: an over-long original is rejected', () => {
  assert.strictEqual(validateWord(word({ original: 'x'.repeat(101) })), false);
});

test('validateWord: a missing translation is rejected', () => {
  const w = word();
  delete w.translate;
  assert.strictEqual(validateWord(w), false);
});

test('GET /api/words returns an array', async () => {
  const res = await request(app).get('/api/words').expect(200);
  assert.ok(Array.isArray(res.body));
});

test('POST /api/sync rejects a non-array body', async () => {
  await request(app).post('/api/sync').send({ not: 'an array' }).expect(400);
});

test('POST /api/sync accepts words without tags', async () => {
  // The end-to-end form of the regression above.
  await request(app)
    .post('/api/sync')
    .send([{ id: 1, original: 'katt', translate: 'кот' }])
    .expect(200);
});

test('POST /api/sync rejects a malformed word', async () => {
  await request(app)
    .post('/api/sync')
    .send([{ id: 'not-a-number', original: 'katt', translate: 'кот' }])
    .expect(400);
});

test('POST /api/sync round-trips a word', async () => {
  const deck = [
    { id: 10, original: 'rev', translate: 'лиса', level: 2, tags: ['animals'] },
  ];
  await request(app).post('/api/sync').send(deck).expect(200);

  const res = await request(app).get('/api/words').expect(200);
  const saved = res.body.find(w => w.id === 10);
  assert.ok(saved, 'the synced word should come back');
  assert.strictEqual(saved.original, 'rev');
  assert.strictEqual(saved.level, 2);
  assert.deepStrictEqual(saved.tags, ['animals']);
});

test('GET /api/words normalises tags into an array', async () => {
  await request(app)
    .post('/api/sync')
    .send([{ id: 11, original: 'ugle', translate: 'сова' }])
    .expect(200);

  const res = await request(app).get('/api/words').expect(200);
  const saved = res.body.find(w => w.id === 11);
  assert.deepStrictEqual(saved.tags, [], 'a word with no tags reads back as []');
});

test('GET / serves the app shell', async () => {
  await request(app).get('/').expect(200).expect('Content-Type', /html/);
});

test('GET /sw.js is served as JavaScript and never cached', async () => {
  const res = await request(app).get('/sw.js').expect(200);
  assert.match(res.headers['content-type'], /javascript/);
  assert.match(res.headers['cache-control'], /no-cache|no-store/);
});

test('GET /manifest.json is valid JSON with icons', async () => {
  const res = await request(app).get('/manifest.json').expect(200);
  const manifest = JSON.parse(res.text);
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
});

test('GET /favicon.ico returns a real image', async () => {
  // It used to 404: the code asked for favicon.ico while the file on disk was
  // Favicon.ico, and zero bytes at that.
  const res = await request(app).get('/favicon.ico').expect(200);
  assert.match(res.headers['content-type'], /image/);
  assert.ok(res.body.length > 0, 'favicon must not be empty');
});

// ---------------------------------------------------------------------------
// Раздача статики
//
// express.static раздавал весь каталог проекта — включая базу со словарём.
// ---------------------------------------------------------------------------
for (const file of ['vocab.db', 'server.js', 'package.json', 'deploy/install.sh', '.env', 'README.md']) {
    test(`GET /${file} is not served`, async () => {
        const res = await request(app).get('/' + file);
        assert.equal(res.status, 404);
    });
}

test('frontend modules, styles and decks are served', async () => {
    const js = await request(app).get('/js/main.js').expect(200);
    assert.match(js.headers['content-type'], /javascript/);
    const css = await request(app).get('/css/app.css').expect(200);
    assert.match(css.headers['content-type'], /css/);
    const deck = await request(app).get('/decks/a1.txt').expect(200);
    assert.match(deck.headers['content-type'], /text\/plain.*utf-8/i);
    assert.match(deck.text, /hus\|дом/);
});

for (const p of ['/js/package.json', '/js/../server.js', '/js/%2e%2e/server.js', '/decks/../vocab.db', '/js/nope.js', '/app.js']) {
    test(`GET ${p} is not served`, async () => {
        const res = await request(app).get(p);
        assert.equal(res.status, 404);
    });
}

test('the timer and register endpoints are gone', async () => {
    await request(app).get('/api/timer').expect(404);
    await request(app).post('/api/register').expect(404);
});

test('POST /api/sync round-trips gender and forms', async () => {
    await request(app).post('/api/sync').send([
        { id: 30, original: 'bok', translate: 'книга', pos: 'noun', gender: 'f',
          forms: { defSg: 'boka', indefPl: 'bøker', defPl: 'bøkene', junk: 'x' } },
        { id: 31, original: 'å gå', translate: 'идти', pos: 'verb', gender: 'n',
          forms: { present: 'går', past: 'gikk', perfect: 'har gått' } },
    ]).expect(200);
    const res = await request(app).get('/api/words').expect(200);
    const bok = res.body.find(w => w.id === 30);
    assert.equal(bok.pos, 'noun');
    assert.equal(bok.gender, 'f');
    assert.deepStrictEqual(bok.forms, { defSg: 'boka', indefPl: 'bøker', defPl: 'bøkene' }, 'unknown form keys dropped');
    const gaa = res.body.find(w => w.id === 31);
    assert.equal(gaa.gender, '', 'a verb has no gender');
    assert.equal(gaa.forms.past, 'gikk');
});

test('validateWord rejects an unknown part of speech or gender', () => {
    assert.strictEqual(validateWord(word({ pos: 'adverb' })), false);
    assert.strictEqual(validateWord(word({ pos: 'noun', gender: 'x' })), false);
    assert.strictEqual(validateWord(word({ forms: ['a'] })), false);
    assert.strictEqual(validateWord(word({ pos: 'noun', gender: 'n', forms: {} })), true);
});

test('the photo endpoint is gone', async () => {
    const res = await request(app).get('/api/word-image?word=hus');
    assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// Состояние SM-2
//
// /api/sync не сохранял sm2EF/sm2Interval/sm2Reps/history, и при следующей
// загрузке интервалы всех слов откатывались к началу.
// ---------------------------------------------------------------------------
test('POST /api/sync round-trips the SM-2 state and answer history', async () => {
    const history = [{ ts: 1700000000000, q: 2, ef: 2.5 }, { ts: 1700000500000, q: 3, ef: 2.6 }];
    await request(app).post('/api/sync').send([{
        id: 20, original: 'hus', translate: 'дом', level: 3,
        sm2EF: 2.36, sm2Interval: 15, sm2Reps: 4, history, addedAt: 1690000000000
    }]).expect(200);

    const res = await request(app).get('/api/words').expect(200);
    const saved = res.body.find(w => w.id === 20);
    assert.ok(saved);
    assert.equal(saved.sm2EF, 2.36);
    assert.equal(saved.sm2Interval, 15);
    assert.equal(saved.sm2Reps, 4);
    assert.equal(saved.addedAt, 1690000000000);
    assert.deepStrictEqual(saved.history, history);
});

test('GET /api/words does not leak legacy video/photo columns', async () => {
    const res = await request(app).get('/api/words').expect(200);
    for (const w of res.body) {
        for (const legacy of ['imageUrl', 'videoId', 'startTime', 'endTime', 'subtitleText']) {
            assert.ok(!(legacy in w), `${legacy} should not be returned`);
        }
    }
});

test('concurrent syncs do not collide on the transaction', async () => {
    const decks = [1, 2, 3, 4].map(n => [{ id: 100 + n, original: `ord${n}`, translate: `слово${n}` }]);
    const results = await Promise.all(decks.map(d => request(app).post('/api/sync').send(d)));
    for (const r of results) assert.equal(r.status, 200);
    const res = await request(app).get('/api/words').expect(200);
    assert.equal(res.body.length, 1, 'the last sync wins and leaves exactly one word');
});

test('validateWord: null and non-objects are rejected, not thrown on', () => {
    assert.strictEqual(validateWord(null), false);
    assert.strictEqual(validateWord('hus'), false);
});

test('validateWord: a non-finite id is rejected', () => {
    assert.strictEqual(validateWord(word({ id: NaN })), false);
    assert.strictEqual(validateWord(word({ id: Infinity })), false);
});

test('GET /api/tatoeba rejects an empty word', async () => {
    await request(app).get('/api/tatoeba?word=').expect(400);
});

test('GET /api/tatoeba rejects an over-long word', async () => {
    await request(app).get('/api/tatoeba?word=' + 'a'.repeat(150)).expect(400);
});

// ---------------------------------------------------------------------------
// /api/state: настройки и активность, общие для телефона и компьютера
// ---------------------------------------------------------------------------
test('POST /api/state merges activity by the maximum per day', async () => {
    await request(app).post('/api/state').send({ activity: { '2026-10-01': 12, '2026-10-02': 3 } }).expect(200);
    const res = await request(app).post('/api/state').send({ activity: { '2026-10-02': 7, '2026-10-03': 1 } }).expect(200);
    assert.deepStrictEqual(res.body.activity, { '2026-10-01': 12, '2026-10-02': 7, '2026-10-03': 1 });
    const again = await request(app).post('/api/state').send({ activity: { '2026-10-02': 7 } }).expect(200);
    assert.equal(again.body.activity['2026-10-02'], 7, 'sending the same day twice does not double it');
});

test('POST /api/state: a newer activityEpoch resets the counts, an older one cannot bring them back', async () => {
    const res = await request(app).post('/api/state').send({ activity: {}, activityEpoch: 5000 }).expect(200);
    assert.deepStrictEqual(res.body.activity, {});
    assert.equal(res.body.activityEpoch, 5000);
    // Устройство, не знающее о сбросе, присылает старые дни.
    const stale = await request(app).post('/api/state').send({ activity: { '2026-10-01': 12 }, activityEpoch: 0 }).expect(200);
    assert.deepStrictEqual(stale.body.activity, {}, 'old days are ignored');
    assert.equal(stale.body.activityEpoch, 5000, 'and the device learns about the reset');
    const fresh = await request(app).post('/api/state').send({ activity: { '2026-10-08': 3 }, activityEpoch: 5000 }).expect(200);
    assert.deepStrictEqual(fresh.body.activity, { '2026-10-08': 3 });
    await request(app).post('/api/state').send({ activity: {}, activityEpoch: -1 }).expect(400);
});

test('POST /api/state keeps the newer settings', async () => {
    const first = await request(app).post('/api/state').send({ settings: { dailyGoal: 10 } }).expect(200);
    assert.equal(first.body.settings.dailyGoal, 10, 'an empty server takes any settings');
    await request(app).post('/api/state').send({ settings: { dailyGoal: 20, updatedAt: 2000 } }).expect(200);
    const stale = await request(app).post('/api/state').send({ settings: { dailyGoal: 5, updatedAt: 1000 } }).expect(200);
    assert.equal(stale.body.settings.dailyGoal, 20, 'older settings do not overwrite newer ones');
});

test('POST /api/state rejects malformed input', async () => {
    await request(app).post('/api/state').send({ activity: { 'вчера': 3 } }).expect(400);
    await request(app).post('/api/state').send({ activity: { '2026-10-01': -1 } }).expect(400);
    await request(app).post('/api/state').send({ activity: [] }).expect(400);
    await request(app).post('/api/state').send({ settings: 'x' }).expect(400);
});
