// deploy/backup.js: согласованная копия базы, пока сервер держит её открытой
// в режиме WAL, и ротация старых копий.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sqlite3 = require('sqlite3');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tme-backup-'));
const DB = path.join(DIR, 'vocab.db');
const OUT = path.join(DIR, 'backups');
const SCRIPT = path.join(__dirname, '..', 'deploy', 'backup.js');

const run = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, e => (e ? rej(e) : res())));
const get = (db, sql) => new Promise((res, rej) => db.get(sql, (e, r) => (e ? rej(e) : res(r))));

let live;

test.before(async () => {
    live = new sqlite3.Database(DB);
    await run(live, 'PRAGMA journal_mode = WAL');
    await run(live, 'PRAGMA wal_autocheckpoint = 0');   // всё остаётся в -wal, как у работающего сервера
    await run(live, 'CREATE TABLE words (id REAL, original TEXT)');
    for (let i = 0; i < 40; i++) await run(live, 'INSERT INTO words VALUES (?, ?)', [i, `ord${i}`]);
});

test.after(async () => {
    await new Promise(r => live.close(r));
    fs.rmSync(DIR, { recursive: true, force: true });
});

function backup(env = {}) {
    return execFileSync(process.execPath, [SCRIPT], {
        env: { ...process.env, DATABASE_PATH: DB, BACKUP_DIR: OUT, ...env },
        encoding: 'utf8',
    });
}

test('a backup of a live WAL database contains every word', async () => {
    assert.ok(fs.statSync(DB + '-wal').size > 0, 'the rows are still in the WAL file');
    const out = backup();
    assert.match(out, /40 слов/);
    const files = fs.readdirSync(OUT);
    assert.equal(files.length, 1);
    const copy = new sqlite3.Database(path.join(OUT, files[0]), sqlite3.OPEN_READONLY);
    const n = (await get(copy, 'SELECT COUNT(*) AS n FROM words')).n;
    await new Promise(r => copy.close(r));
    assert.equal(n, 40);
});

test('only the newest BACKUP_KEEP copies are kept', () => {
    for (const d of ['2026-01-01_000000', '2026-01-02_000000', '2026-01-03_000000', '2026-01-04_000000']) {
        fs.writeFileSync(path.join(OUT, `vocab-${d}.db`), 'old');
    }
    fs.writeFileSync(path.join(OUT, 'notes.txt'), 'not a backup');
    backup({ BACKUP_KEEP: '3' });
    const kept = fs.readdirSync(OUT).filter(f => f.endsWith('.db')).sort();
    assert.equal(kept.length, 3);
    assert.ok(!kept.includes('vocab-2026-01-01_000000.db'), 'the oldest is gone');
    assert.ok(fs.existsSync(path.join(OUT, 'notes.txt')), 'foreign files are left alone');
});

test('a missing database is an error, not an empty backup', () => {
    assert.throws(() => backup({ DATABASE_PATH: path.join(DIR, 'nope.db') }));
});
