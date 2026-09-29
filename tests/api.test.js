const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the server at a throwaway database before importing it.
const DB = path.join(os.tmpdir(), `tme-test-${process.pid}.db`);
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = DB;

const request = require('supertest');
const { app, db, validateWord } = require('../server.js');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(DB + suffix, { force: true });
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

test('POST /api/register returns a stable user id', async () => {
  const first = await request(app).post('/api/register').expect(200);
  const second = await request(app).post('/api/register').expect(200);
  assert.ok(first.body.userId);
  assert.strictEqual(first.body.userId, second.body.userId);
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
// Таймер сессии
//
// POST /api/timer писал в базу что угодно: строку, объект, отрицательное число.
// GET потом возвращал NaN, и интерфейс показывал пустоту.
// ---------------------------------------------------------------------------
test('POST /api/timer accepts a sane number', async () => {
    const res = await request(app).post('/api/timer').send({ timeLeft: 1800 });
    assert.equal(res.status, 200);
    const back = await request(app).get('/api/timer');
    assert.equal(back.body.timeLeft, 1800);
});

test('POST /api/timer rejects a non-number', async () => {
    const res = await request(app).post('/api/timer').send({ timeLeft: 'полчаса' });
    assert.equal(res.status, 400);
});

test('POST /api/timer rejects a negative value', async () => {
    const res = await request(app).post('/api/timer').send({ timeLeft: -60 });
    assert.equal(res.status, 400);
});

test('POST /api/timer rejects an absurdly large value', async () => {
    const res = await request(app).post('/api/timer').send({ timeLeft: 99999999 });
    assert.equal(res.status, 400);
});

test('POST /api/timer rejects a missing body', async () => {
    const res = await request(app).post('/api/timer').send({});
    assert.equal(res.status, 400);
});

test('a rejected timer value never reaches the database', async () => {
    await request(app).post('/api/timer').send({ timeLeft: 1800 });
    await request(app).post('/api/timer').send({ timeLeft: {} });
    const back = await request(app).get('/api/timer');
    assert.equal(back.body.timeLeft, 1800);
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

test('GET /app.js is served as JavaScript', async () => {
    const res = await request(app).get('/app.js').expect(200);
    assert.match(res.headers['content-type'], /javascript/);
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
