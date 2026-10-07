#!/usr/bin/env node
// deploy/recompute-schedule.mjs — пересчёт расписания всех слов по истории
// ответов, по нынешним правилам (в расписание идёт первый ответ за день).
//
// Нужен один раз после исправления октября 2026: раньше каждый повтор внутри
// тренировки считался отдельным днём, и интервалы с EF получились неверными.
//
//   node deploy/recompute-schedule.mjs                 — только показать, что изменится
//   node deploy/recompute-schedule.mjs --write         — записать в базу
//   --from=<файл бэкапа>  — взять историю из бэкапа, а записать в рабочую базу
//   --hard-as=again | hard — чем считать старое «Сложно» (по умолчанию again,
//                            то есть «не помню»: им пользовались именно так)
//
// Перед --write сделай бэкап (node deploy/backup.js) и закрой вкладку
// приложения: открытая вкладка держит старое расписание в памяти и при
// следующем ответе отправит его обратно на сервер.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayHistory, normalizeWord } from '../js/srs.js';
import { toDayKey, DAY_MS } from '../js/util.js';

const require = createRequire(import.meta.url);
const sqlite3 = require('sqlite3');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.resolve(ROOT, process.env.DATABASE_PATH || './vocab.db');
const args = process.argv.slice(2);
const write = args.includes('--write');
const from = args.find(a => a.startsWith('--from='))?.slice('--from='.length);
const hardAs = (args.find(a => a.startsWith('--hard-as=')) || '--hard-as=again').split('=')[1];
if (!['again', 'hard'].includes(hardAs)) {
    console.error('--hard-as: again или hard');
    process.exit(2);
}
// Старые оценки: 0 снова, 1 сложно, 2 хорошо, 3 легко.
const mapQuality = (q) => (q === 1 && hardAs === 'again' ? 0 : q);

const db = new sqlite3.Database(DB_PATH, write ? sqlite3.OPEN_READWRITE : sqlite3.OPEN_READONLY);
const all = (sql) => new Promise((res, rej) => db.all(sql, (e, r) => (e ? rej(e) : res(r))));
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, (e) => (e ? rej(e) : res())));

function summary(words) {
    const levels = [0, 0, 0, 0, 0, 0];
    let ef = 0, studied = 0;
    const tomorrow = toDayKey(Date.now() + DAY_MS);
    let dueTomorrow = 0, dueNow = 0;
    for (const w of words) {
        if (!w.history.length) continue;
        studied++;
        levels[w.level]++;
        ef += w.sm2EF;
        if (w.nextReview <= Date.now()) dueNow++;
        else if (toDayKey(w.nextReview) === tomorrow) dueTomorrow++;
    }
    return { studied, levels: levels.join(' / '), avgEF: (ef / (studied || 1)).toFixed(2), dueNow, dueTomorrow };
}

let rows;
if (from) {
    const src = new sqlite3.Database(path.resolve(from), sqlite3.OPEN_READONLY);
    rows = await new Promise((res, rej) => src.all('SELECT * FROM words', (e, r) => (e ? rej(e) : res(r))));
    src.close();
    const live = new Set((await all('SELECT id FROM words')).map(r => r.id));
    rows = rows.filter(r => live.has(r.id));
    console.log(`История взята из: ${path.resolve(from)}`);
} else {
    rows = await all('SELECT * FROM words');
}
const before = rows.map(r => normalizeWord({
    ...r, tags: JSON.parse(r.tags || '[]'), history: JSON.parse(r.history || '[]'), forms: JSON.parse(r.forms || '{}'),
}));
const after = before.map(w => (w.history.length ? replayHistory(w, mapQuality) : w));

console.log(`База: ${DB_PATH}`);
console.log(`«Сложно» считается как: ${hardAs === 'again' ? '«не помню»' : '«помню с трудом»'}`);
console.log('уровни 0/1/2/3/4/5 у начатых слов, средний EF, пора сейчас, придут завтра:');
console.log('  было:  ', JSON.stringify(summary(before)));
console.log('  станет:', JSON.stringify(summary(after)));

if (write) {
    await run('BEGIN IMMEDIATE');
    try {
        for (const w of after) {
            if (!w.history.length) continue;
            await run(`UPDATE words SET level = ?, nextReview = ?, forgetStep = ?, sm2EF = ?,
                       sm2Interval = ?, sm2Reps = ?, history = ? WHERE id = ?`,
                [w.level, w.nextReview, w.forgetStep, w.sm2EF, w.sm2Interval, w.sm2Reps, JSON.stringify(w.history), w.id]);
        }
        await run('COMMIT');
    } catch (e) {
        await run('ROLLBACK').catch(() => {});
        throw e;
    }
    console.log('Записано.');
} else {
    console.log('Ничего не записано (пробный запуск). Записать: --write');
}
db.close();
