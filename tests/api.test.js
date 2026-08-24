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
const { app, validateWord } = require('../server.js');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(DB + suffix, { force: true });
  }
});

const word = (over = {}) => ({
  id: 1,
  original: 'cat',
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
    .send([{ id: 1, original: 'cat', translate: 'кот' }])
    .expect(200);
});

test('POST /api/sync rejects a malformed word', async () => {
  await request(app)
    .post('/api/sync')
    .send([{ id: 'not-a-number', original: 'cat', translate: 'кот' }])
    .expect(400);
});

test('POST /api/sync round-trips a word', async () => {
  const deck = [
    { id: 10, original: 'fox', translate: 'лиса', level: 2, tags: ['animals'] },
  ];
  await request(app).post('/api/sync').send(deck).expect(200);

  const res = await request(app).get('/api/words').expect(200);
  const saved = res.body.find(w => w.id === 10);
  assert.ok(saved, 'the synced word should come back');
  assert.strictEqual(saved.original, 'fox');
  assert.strictEqual(saved.level, 2);
  assert.deepStrictEqual(saved.tags, ['animals']);
});

test('GET /api/words normalises tags into an array', async () => {
  await request(app)
    .post('/api/sync')
    .send([{ id: 11, original: 'owl', translate: 'сова' }])
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
