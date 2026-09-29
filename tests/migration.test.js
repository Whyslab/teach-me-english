// Миграция базы от старой английской версии. Отдельный файл = отдельный
// процесс node --test, поэтому здесь своя база, созданная по старой схеме.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const DB = path.join(os.tmpdir(), `tme-test-migration-${process.pid}.db`);
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = DB;

function exec(db, sql) {
    return new Promise((resolve, reject) => db.exec(sql, err => (err ? reject(err) : resolve())));
}
function all(db, sql) {
    return new Promise((resolve, reject) => db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows))));
}

let server;

test.before(async () => {
    const legacy = new sqlite3.Database(DB);
    await exec(legacy, `
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO settings VALUES ('timeLeft', '3600');
        CREATE TABLE words (
            id REAL, original TEXT, translate TEXT, example TEXT, exampleTranslate TEXT,
            level INTEGER, nextReview REAL, forgetStep INTEGER DEFAULT 0, tags TEXT DEFAULT '[]',
            videoId TEXT DEFAULT '', startTime REAL DEFAULT 0, endTime REAL DEFAULT 0,
            subtitleText TEXT DEFAULT '', imageUrl TEXT DEFAULT ''
        );
        INSERT INTO words (id, original, translate, level, imageUrl) VALUES (1, 'old', 'старое', 1, 'data:image/png;base64,AAAA');
        INSERT INTO words (id, original, translate, level) VALUES (1, 'hus', 'дом', 3);
        INSERT INTO words (id, original, translate, level) VALUES (2, 'bok', 'книга', 0);
    `);
    await new Promise(r => legacy.close(r));
    server = require('../server.js');
    await server.ready;
});

test.after(() => {
    for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
});

test('legacy photo/video columns and the timer table are dropped', async () => {
    const cols = (await all(server.db, 'PRAGMA table_info(words)')).map(c => c.name);
    for (const legacy of ['videoId', 'startTime', 'endTime', 'subtitleText', 'imageUrl']) {
        assert.ok(!cols.includes(legacy), `${legacy} still exists`);
    }
    for (const added of ['sm2EF', 'history', 'pos', 'gender', 'forms']) {
        assert.ok(cols.includes(added), `${added} was not added`);
    }
    const tables = (await all(server.db, "SELECT name FROM sqlite_master WHERE type='table'")).map(t => t.name);
    assert.ok(!tables.includes('settings'));
});

test('duplicate ids are collapsed to the newest row and id becomes unique', async () => {
    const rows = await all(server.db, 'SELECT id, original, level FROM words ORDER BY id');
    assert.deepStrictEqual(rows.map(r => [r.id, r.original, r.level]), [[1, 'hus', 3], [2, 'bok', 0]]);
    const idx = await all(server.db, "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_words_id'");
    assert.equal(idx.length, 1);
});

test('the migrated database accepts incremental sync', async () => {
    const request = require('supertest');
    await request(server.app).post('/api/words/batch')
        .send({ upserts: [{ id: 2, original: 'bok', translate: 'книга', level: 2 }], deletes: [1] })
        .expect(200);
    const res = await request(server.app).get('/api/words').expect(200);
    assert.deepStrictEqual(res.body.map(w => [w.id, w.level]), [[2, 2]]);
});
