#!/usr/bin/env node
// deploy/backup.js — снимок базы словаря в каталог бэкапов.
//
// Запускается systemd-таймером раз в день (deploy/install.sh ставит его),
// можно и руками: node deploy/backup.js
//
// VACUUM INTO делает согласованную копию, даже пока сервер работает и пишет
// в журнал WAL — простое копирование vocab.db могло бы поймать базу посреди
// записи. Хранятся последние BACKUP_KEEP копий (по умолчанию 14).
//
// Переменные: DATABASE_PATH (как у сервера), BACKUP_DIR
// (по умолчанию ~/Backups/teach-me-norwegian), BACKUP_KEEP.
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.resolve(ROOT, process.env.DATABASE_PATH || './vocab.db');
const DIR = path.resolve(process.env.BACKUP_DIR || path.join(os.homedir(), 'Backups', 'teach-me-norwegian'));
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 14);

function stamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, err => (err ? reject(err) : resolve())));
}
function get(db, sql) {
    return new Promise((resolve, reject) => db.get(sql, (err, row) => (err ? reject(err) : resolve(row))));
}

async function main() {
    if (!fs.existsSync(DB_PATH)) {
        console.error(`Базы нет: ${DB_PATH}`);
        process.exit(1);
    }
    fs.mkdirSync(DIR, { recursive: true });
    // VACUUM INTO не перезаписывает существующий файл, а два бэкапа в одну
    // секунду (таймер + ручной запуск) дали бы одно имя.
    const base = `vocab-${stamp()}`;
    let target = path.join(DIR, `${base}.db`);
    for (let i = 1; fs.existsSync(target); i++) target = path.join(DIR, `${base}-${i}.db`);

    const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
    try {
        await run(db, 'VACUUM INTO ?', [target]);
    } finally {
        await new Promise(r => db.close(r));
    }

    // Проверяем, что копия читается и в ней есть слова.
    const copy = new sqlite3.Database(target, sqlite3.OPEN_READONLY);
    let count;
    try {
        count = (await get(copy, 'SELECT COUNT(*) AS n FROM words')).n;
    } finally {
        await new Promise(r => copy.close(r));
    }

    // Ротация: оставляем KEEP последних.
    const old = fs.readdirSync(DIR)
        .filter(f => /^vocab-\d{4}-\d{2}-\d{2}_\d{6}(-\d+)?\.db$/.test(f))
        .sort()
        .reverse()
        .slice(KEEP);
    for (const f of old) fs.rmSync(path.join(DIR, f));

    const kb = Math.round(fs.statSync(target).size / 1024);
    console.log(`Бэкап: ${target} (${count} слов, ${kb} КБ). Удалено старых: ${old.length}.`);
}

main().catch((err) => {
    console.error('Бэкап не удался:', err.message);
    process.exit(1);
});
