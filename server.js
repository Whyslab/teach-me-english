const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const rateLimit = require('express-rate-limit');
const app = express();
const PORT = Number(process.env.PORT) || 3000;
// Слушать только этот компьютер. Чтобы открыть приложение с телефона:
// HOST=0.0.0.0 в окружении службы плюс правило ufw на этот порт.
const HOST = process.env.HOST || '127.0.0.1';
// Overridable so tests can run against a throwaway database instead of
// the real library.
//
// Относительный путь разворачивается от каталога приложения, а не от текущего
// рабочего каталога. Иначе запуск не из корня проекта — а именно так делает
// systemd-юнит — создавал бы пустую vocab.db где-то ещё, и приложение
// стартовало бы с пустым словарём, ничего не сообщив.
const DB_PATH = path.resolve(__dirname, process.env.DATABASE_PATH || './vocab.db');

app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
    credentials: true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));
// Лимит был 50 МБ — ради фото в base64. Фото больше нет, а текстовый словарь
// даже на 10 000 слов укладывается в пару мегабайт.
app.use(express.json({ limit: '5mb' }));

// Раньше express.static раздавал весь каталог проекта: GET /vocab.db отдавал
// базу со словарём, GET /server.js — исходники, GET /deploy/... — скрипты.
// Теперь наружу видны только файлы, из которых состоит фронтенд.
const PUBLIC_FILES = new Set([
    'index.html', 'manifest.json', 'screenshot.png',
    ...[72, 96, 128, 144, 152, 192, 384, 512].map(n => `icon-${n}.png`)
]);
// Модули фронтенда, стили и колоды. Имя — только латиница, цифры и дефис,
// без подкаталогов и точек: путь не может выйти за пределы этих папок.
const PUBLIC_PATTERN = /^(?:js\/[a-z0-9-]+\.js|css\/[a-z0-9-]+\.css|decks\/[a-z0-9-]+\.txt)$/;

app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const name = req.path.replace(/^\/+/, '');
    if (!PUBLIC_FILES.has(name) && !PUBLIC_PATTERN.test(name)) return next();
    const headers = {};
    if (name === 'manifest.json') headers['Cache-Control'] = 'max-age=86400';
    else if (/^icon-\d+\.png$/.test(name)) headers['Cache-Control'] = 'max-age=604800, immutable';
    if (name.startsWith('decks/')) headers['Content-Type'] = 'text/plain; charset=utf-8';
    res.sendFile(path.join(__dirname, name), { headers, dotfiles: 'deny' }, (err) => {
        if (err && !res.headersSent) next();
    });
});

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests, please try again later.'
});

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error('Ошибка БД:', err.message);
    else if (process.env.NODE_ENV !== 'test') console.log(`Подключено к базе данных SQLite (${DB_PATH}).`);
});

db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA busy_timeout = 5000;
`);

const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { if (err) reject(err); else resolve(this); });
});
const all = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});
const quiet = process.env.NODE_ENV === 'test';

// Колонки, которые остались в базах от английской версии (видеофрагменты и
// фото), и таблица settings от удалённого дневного таймера.
const LEGACY_COLUMNS = ['videoId', 'startTime', 'endTime', 'subtitleText', 'imageUrl'];

// Схема и миграции — строго по порядку. Запросы к словам ждут `ready`.
async function migrate() {
    await run(`CREATE TABLE IF NOT EXISTS words (
        id REAL,
        original TEXT,
        translate TEXT,
        example TEXT,
        exampleTranslate TEXT,
        level INTEGER,
        nextReview REAL,
        forgetStep INTEGER DEFAULT 0,
        tags TEXT DEFAULT '[]',
        sm2EF REAL DEFAULT 2.5,
        sm2Interval REAL DEFAULT 1,
        sm2Reps INTEGER DEFAULT 0,
        history TEXT DEFAULT '[]',
        addedAt REAL DEFAULT 0,
        pos TEXT DEFAULT '',
        gender TEXT DEFAULT '',
        forms TEXT DEFAULT '{}'
    )`);

    // Состояние SM-2 и история ответов раньше жили только в браузере:
    // /api/sync их не сохранял, а GET /api/words при следующей загрузке
    // перезаписывал локальные данные серверными — и интервалы каждого
    // слова откатывались к началу.
    const migrations = [
        ["forgetStep",  "ALTER TABLE words ADD COLUMN forgetStep INTEGER DEFAULT 0"],
        ["tags",        "ALTER TABLE words ADD COLUMN tags TEXT DEFAULT '[]'"],
        ["sm2EF",       "ALTER TABLE words ADD COLUMN sm2EF REAL DEFAULT 2.5"],
        ["sm2Interval", "ALTER TABLE words ADD COLUMN sm2Interval REAL DEFAULT 1"],
        ["sm2Reps",     "ALTER TABLE words ADD COLUMN sm2Reps INTEGER DEFAULT 0"],
        ["history",     "ALTER TABLE words ADD COLUMN history TEXT DEFAULT '[]'"],
        ["addedAt",     "ALTER TABLE words ADD COLUMN addedAt REAL DEFAULT 0"],
        ["pos",         "ALTER TABLE words ADD COLUMN pos TEXT DEFAULT ''"],
        ["gender",      "ALTER TABLE words ADD COLUMN gender TEXT DEFAULT ''"],
        ["forms",       "ALTER TABLE words ADD COLUMN forms TEXT DEFAULT '{}'"],
    ];
    const cols = new Set((await all("PRAGMA table_info(words)")).map(c => c.name));
    for (const [col, sql] of migrations) {
        if (cols.has(col)) continue;
        await run(sql);
        if (!quiet) console.log(`Колонка '${col}' добавлена`);
    }

    // Мёртвые данные английской версии. DROP COLUMN есть в SQLite с 3.35.
    for (const col of LEGACY_COLUMNS) {
        if (!cols.has(col)) continue;
        try {
            await run(`ALTER TABLE words DROP COLUMN ${col}`);
            if (!quiet) console.log(`Старая колонка '${col}' удалена`);
        } catch (err) {
            console.warn(`Не удалось удалить колонку '${col}':`, err.message);
        }
    }
    await run('DROP TABLE IF EXISTS settings');

    // Общее для всех устройств: настройки и счётчик ответов по дням (из него
    // считается серия дней). Раньше жило только в localStorage браузера —
    // очистка данных сайта стирала серию, а телефон видел свою отдельную.
    await run(`CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

    // Инкрементальная синхронизация обновляет слова по id, поэтому id должен
    // быть уникальным. Старая полная перезапись таблицы могла оставить дубли
    // только при сбое — оставляем самую свежую строку.
    await run('DELETE FROM words WHERE rowid NOT IN (SELECT MAX(rowid) FROM words GROUP BY id)');
    await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_words_id ON words(id)');
    await run('CREATE INDEX IF NOT EXISTS idx_words_next_review ON words(nextReview)');
    if (!quiet) console.log('База готова.');
}

const ready = migrate();
ready.catch(err => console.error('Миграция базы не удалась:', err.message));

// Запросы к словам ждут окончания миграции.
app.use(['/api/words', '/api/sync', '/api/state'], (req, res, next) => {
    ready.then(() => next(), (err) => res.status(500).json({ error: 'database not ready: ' + err.message }));
});

// SW — явный маршрут с правильным Content-Type и заголовками
// Раньше версию кеша в sw.js приходилось поднимать руками при каждом изменении
// фронтенда, а список файлов для кеша — дописывать. Забыл — и браузер ещё один
// запуск показывал старую версию. Теперь сервер подставляет и то и другое:
// версия — хеш содержимого всех файлов фронтенда, список — что лежит на диске.
function precacheList() {
    const list = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];
    for (const [dir, ext] of [['css', '.css'], ['js', '.js'], ['decks', '.txt']]) {
        const files = fs.readdirSync(path.join(__dirname, dir))
            .filter(f => f.endsWith(ext) && PUBLIC_PATTERN.test(`${dir}/${f}`))
            .sort();
        for (const f of files) list.push(`/${dir}/${f}`);
    }
    return list;
}

function assetVersion(list, swSource) {
    const hash = crypto.createHash('sha1').update(swSource);
    for (const url of list) {
        const file = url === '/' ? 'index.html' : url.slice(1);
        hash.update(url).update(fs.readFileSync(path.join(__dirname, file)));
    }
    return hash.digest('hex').slice(0, 12);
}

app.get('/sw.js', (req, res) => {
    const source = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');
    const list = precacheList();
    const body = source
        .replace('__ASSET_VERSION__', assetVersion(list, source))
        .replace('/*__PRECACHE__*/[]', JSON.stringify(list, null, 4));
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Service-Worker-Allowed', '/');
    res.send(body);
});

// Браузеры запрашивают /favicon.ico безусловно; отдаём PWA-иконку,
// чтобы запрос не превращался в 404 в логах.
app.get('/favicon.ico', (req, res) => {
    res.sendFile(path.join(__dirname, 'icon-96.png'));
});


// ============================================================
// TATOEBA PROXY — примеры предложений (обходим CORS)
// nob — норвежский букмол, rus — русский (коды ISO 639-3, как их ждёт Tatoeba).
// ============================================================
const TATOEBA_TIMEOUT = 8000;

app.get('/api/tatoeba', limiter, (req, res) => {
    const word = typeof req.query.word === 'string' ? req.query.word.trim() : '';
    if (!word || word.length > 100) return res.status(400).json({ error: 'Invalid word' });

    // Раньше ответ мог уйти дважды: таймаут отвечал 504, потом destroy() порождал
    // 'error', и обработчик пытался ответить 502 уже отправленному клиенту —
    // ERR_HTTP_HEADERS_SENT вылетал из колбэка и ронял весь сервер.
    let done = false;
    const reply = (status, body) => {
        if (done || res.headersSent) return;
        done = true;
        res.status(status).json(body);
    };

    const options = {
        hostname: 'tatoeba.org',
        path: `/en/api_v0/search?from=nob&to=rus&query=${encodeURIComponent(word)}&limit=6`,
        method: 'GET',
        headers: {
            'User-Agent': 'teach-me-norwegian/1.0 (self-hosted vocabulary trainer)',
            'Accept': 'application/json'
        },
        timeout: TATOEBA_TIMEOUT
    };

    let body = '';
    const proxyReq = https.request(options, (proxyRes) => {
        if (proxyRes.statusCode !== 200) {
            proxyRes.resume();
            return reply(502, { error: 'Service unavailable' });
        }
        proxyRes.setEncoding('utf8');
        proxyRes.on('data', chunk => {
            body += chunk;
            if (body.length > 1024 * 1024) { // 1MB limit
                reply(413, { error: 'Response too large' });
                proxyReq.destroy();
            }
        });
        proxyRes.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (!data.results || !Array.isArray(data.results)) {
                    throw new Error('Invalid response format');
                }
                reply(200, { results: data.results.slice(0, 10) });
            } catch (e) {
                reply(502, { error: 'Invalid response from service' });
            }
        });
    });

    proxyReq.on('error', (e) => {
        if (!done) console.error('Tatoeba proxy error:', e.message);
        reply(502, { error: 'Tatoeba unavailable' });
    });

    proxyReq.on('timeout', () => {
        reply(504, { error: 'timeout' });
        proxyReq.destroy();
    });

    proxyReq.end();
});

// Озвучка через Piper (см. tts.js).
app.use(require('./tts').router);
app.use(require('./ordbok').router);
const lingu = require('./lingu');
lingu.deps.knownWords = async () => {
    await ready;
    return new Set((await all('SELECT original FROM words')).map(r => lingu.wordKey(r.original)));
};
app.use(lingu.router);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- API ДЛЯ СЛОВ ---

const POS_VALUES = new Set(['', 'noun', 'verb', 'adj', 'other']);
const GENDER_VALUES = new Set(['', 'm', 'f', 'n']);
const FORM_KEYS = new Set(['defSg', 'indefPl', 'defPl', 'present', 'past', 'perfect', 'neuter', 'plural']);

function parseForms(raw) {
    try {
        const v = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
        if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
        const out = {};
        for (const [k, val] of Object.entries(v)) {
            if (FORM_KEYS.has(k) && typeof val === 'string' && val) out[k] = val.slice(0, 60);
        }
        return out;
    } catch {
        return {};
    }
}

function parseJsonArray(raw) {
    try {
        const v = JSON.parse(raw || '[]');
        return Array.isArray(v) ? v : [];
    } catch {
        return [];
    }
}

// Отдаём только те поля, которые знает клиент. SELECT * тащил бы наружу
// и мёртвые колонки старой английской версии (видео, фото в base64).
function rowToWord(row) {
    return {
        id: row.id,
        original: row.original,
        translate: row.translate,
        example: row.example || '',
        exampleTranslate: row.exampleTranslate || '',
        level: Number(row.level) || 0,
        nextReview: Number(row.nextReview) || 0,
        forgetStep: Number(row.forgetStep) || 0,
        tags: parseJsonArray(row.tags),
        sm2EF: Number(row.sm2EF) || 2.5,
        sm2Interval: Number(row.sm2Interval) || 1,
        sm2Reps: Number(row.sm2Reps) || 0,
        history: parseJsonArray(row.history),
        addedAt: Number(row.addedAt) || 0,
        pos: POS_VALUES.has(row.pos) ? row.pos : '',
        gender: GENDER_VALUES.has(row.gender) ? row.gender : '',
        forms: parseForms(row.forms)
    };
}

app.get('/api/words', (req, res) => {
    db.all("SELECT * FROM words", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(rowToWord));
    });
});

function validateWord(w) {
    // tags are optional. The previous form ended with `w.tags?.every(...)`,
    // which evaluates to undefined when tags is absent — so a word without
    // tags failed validation, and because /api/sync validates with .every(),
    // a single such word rejected the entire deck with a 400.
    if (!w || typeof w !== 'object') return false;

    const tagsOk =
        w.tags === undefined ||
        w.tags === null ||
        (Array.isArray(w.tags) &&
            w.tags.every(t => typeof t === 'string' && t.length <= 50));

    const grammarOk =
        (w.pos === undefined || POS_VALUES.has(w.pos)) &&
        (w.gender === undefined || GENDER_VALUES.has(w.gender)) &&
        (w.forms === undefined || w.forms === null || (typeof w.forms === 'object' && !Array.isArray(w.forms)));

    const historyOk =
        w.history === undefined ||
        w.history === null ||
        (Array.isArray(w.history) && w.history.length <= 100);

    return Boolean(
        typeof w.id === 'number' && Number.isFinite(w.id) &&
        typeof w.original === 'string' && w.original.length <= 100 &&
        typeof w.translate === 'string' && w.translate.length <= 500 &&
        tagsOk && historyOk && grammarOk
    );
}

// Запись в базу — одна транзакция. Одновременные запросы раньше пытались
// открыть транзакцию внутри транзакции и падали с SQLITE_ERROR, поэтому все
// записи идут через очередь.
let writeQueue = Promise.resolve();

const UPSERT_SQL = `
    INSERT INTO words (id, original, translate, example, exampleTranslate, level,
                       nextReview, forgetStep, tags, sm2EF, sm2Interval, sm2Reps,
                       history, addedAt, pos, gender, forms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
        original = excluded.original, translate = excluded.translate,
        example = excluded.example, exampleTranslate = excluded.exampleTranslate,
        level = excluded.level, nextReview = excluded.nextReview,
        forgetStep = excluded.forgetStep, tags = excluded.tags,
        sm2EF = excluded.sm2EF, sm2Interval = excluded.sm2Interval,
        sm2Reps = excluded.sm2Reps, history = excluded.history,
        addedAt = excluded.addedAt, pos = excluded.pos,
        gender = excluded.gender, forms = excluded.forms`;

function wordParams(w) {
    return [
        w.id,
        String(w.original),
        String(w.translate),
        String(w.example || ''),
        String(w.exampleTranslate || ''),
        parseInt(w.level) || 0,
        Number(w.nextReview) || Date.now(),
        parseInt(w.forgetStep) || 0,
        JSON.stringify(Array.isArray(w.tags) ? w.tags : []),
        Number(w.sm2EF) || 2.5,
        Number(w.sm2Interval) || 1,
        parseInt(w.sm2Reps) || 0,
        JSON.stringify(Array.isArray(w.history) ? w.history.slice(-30) : []),
        Number(w.addedAt) || 0,
        POS_VALUES.has(w.pos) ? (w.pos || '') : '',
        w.pos === 'noun' ? (w.gender || '') : '',
        JSON.stringify(parseForms(w.forms)),
    ];
}

// { replaceAll, upserts, deletes } → одна транзакция.
function writeWords({ replaceAll = false, upserts = [], deletes = [] }) {
    const job = writeQueue.then(async () => {
        await run('BEGIN IMMEDIATE');
        try {
            if (replaceAll) await run('DELETE FROM words');
            for (const id of deletes) await run('DELETE FROM words WHERE id = ?', [id]);
            for (const w of upserts) {
                if (w.original && w.translate) await run(UPSERT_SQL, wordParams(w));
            }
            await run('COMMIT');
        } catch (err) {
            await run('ROLLBACK').catch(() => {});
            throw err;
        }
    });
    writeQueue = job.catch(() => {});
    return job;
}

const MAX_WORDS = 10000;

// Инкрементальная синхронизация: только изменённые и удалённые слова.
app.post('/api/words/batch', async (req, res) => {
    const { upserts = [], deletes = [] } = req.body ?? {};
    if (!Array.isArray(upserts) || !Array.isArray(deletes)) {
        return res.status(400).json({ error: 'upserts and deletes must be arrays' });
    }
    if (upserts.length > MAX_WORDS || deletes.length > MAX_WORDS) {
        return res.status(413).json({ error: 'Payload too large' });
    }
    if (!upserts.every(validateWord)) {
        return res.status(400).json({ error: 'Invalid word format' });
    }
    if (!deletes.every(id => typeof id === 'number' && Number.isFinite(id))) {
        return res.status(400).json({ error: 'Invalid id in deletes' });
    }
    try {
        await writeWords({ upserts, deletes });
        if (!quiet && (upserts.length || deletes.length)) {
            console.log(`Синхронизировано: изменено ${upserts.length}, удалено ${deletes.length}`);
        }
        res.json({ status: 'success', upserted: upserts.length, deleted: deletes.length });
    } catch (err) {
        console.error('Ошибка синхронизации:', err.message);
        res.status(500).json({ error: 'Ошибка синхронизации' });
    }
});

// Полная замена словаря. Новый клиент им не пользуется, но страница, открытая
// до обновления (или закешированная service worker'ом), ещё может его вызвать.
app.post('/api/sync', async (req, res) => {
    if (!Array.isArray(req.body)) {
        return res.status(400).json({ error: "Invalid request format" });
    }
    if (req.body.length > MAX_WORDS) {
        return res.status(413).json({ error: "Payload too large" });
    }
    if (!req.body.every(validateWord)) {
        return res.status(400).json({ error: "Invalid word format" });
    }
    try {
        await writeWords({ replaceAll: true, upserts: req.body });
        if (!quiet) console.log(`Синхронизировано слов (полная замена): ${req.body.length}`);
        res.json({ status: "success", count: req.body.length });
    } catch (err) {
        console.error("Ошибка синхронизации:", err.message);
        res.status(500).json({ error: "Ошибка синхронизации" });
    }
});

// ---------------------------------------------------------------------------
// Общее состояние: настройки и активность по дням
//
// POST /api/state присылает то, что знает браузер, и получает слияние:
// активность — максимум по каждому дню (каждое устройство считает свои
// ответы, сумма посчитала бы одни и те же дважды при повторной отправке),
// настройки — более поздние по updatedAt.
//
// activityEpoch — время последнего сброса активности (сброс прогресса,
// восстановление из бэкапа). Пришла эпоха новее серверной — активность
// заменяется присланной; старше — присланное игнорируется (это устройство
// ещё не знает о сбросе и вернуло бы старые дни); равная — максимум по дням.
// ---------------------------------------------------------------------------
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ACTIVITY_DAYS = 5000;

function validActivity(a) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
    const entries = Object.entries(a);
    return entries.length <= MAX_ACTIVITY_DAYS && entries.every(([k, v]) =>
        DAY_KEY.test(k) && Number.isInteger(v) && v >= 0 && v <= 100000);
}

function validSettings(s) {
    return Boolean(s) && typeof s === 'object' && !Array.isArray(s) && JSON.stringify(s).length <= 10000;
}

async function readState() {
    const rows = await all('SELECT key, value FROM app_state');
    const out = { settings: null, activity: {}, activityEpoch: 0 };
    for (const { key, value } of rows) {
        try {
            if (key === 'settings') out.settings = JSON.parse(value);
            if (key === 'activity') out.activity = JSON.parse(value);
            if (key === 'activityEpoch') out.activityEpoch = Number(JSON.parse(value)) || 0;
        } catch { /* битое значение — как будто его нет */ }
    }
    return out;
}

app.get('/api/state', async (req, res) => {
    try {
        res.json(await readState());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/state', async (req, res) => {
    const { settings, activity, activityEpoch = 0 } = req.body ?? {};
    if (typeof activityEpoch !== 'number' || !Number.isFinite(activityEpoch) || activityEpoch < 0) {
        return res.status(400).json({ error: 'Invalid activityEpoch' });
    }
    if (settings !== undefined && !validSettings(settings)) {
        return res.status(400).json({ error: 'Invalid settings' });
    }
    if (activity !== undefined && !validActivity(activity)) {
        return res.status(400).json({ error: 'Invalid activity' });
    }
    // Через ту же очередь, что и слова: чтение-слияние-запись не должны
    // перемешаться с соседним запросом.
    const job = writeQueue.then(async () => {
        const cur = await readState();
        const put = (key, value) => run(
            'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            [key, JSON.stringify(value)]);
        if (activity && activityEpoch >= cur.activityEpoch) {
            const merged = activityEpoch > cur.activityEpoch ? {} : { ...cur.activity };
            for (const [day, n] of Object.entries(activity)) merged[day] = Math.max(merged[day] || 0, n);
            cur.activity = merged;
            await put('activity', merged);
            if (activityEpoch > cur.activityEpoch) {
                cur.activityEpoch = activityEpoch;
                await put('activityEpoch', activityEpoch);
            }
        }
        if (settings && (!cur.settings || (Number(settings.updatedAt) || 0) > (Number(cur.settings.updatedAt) || 0))) {
            cur.settings = settings;
            await put('settings', settings);
        }
        return cur;
    });
    writeQueue = job.catch(() => {});
    try {
        res.json(await job);
    } catch (err) {
        console.error('Ошибка сохранения состояния:', err.message);
        res.status(500).json({ error: 'Ошибка сохранения состояния' });
    }
});

// Слушать порт только при прямом запуске (`node server.js`).
// При импорте из тестов сервер подниматься не должен.
//
// 12.09.2026: вызов восстановлен. Он был с первого коммита, потом его обернули
// в эту проверку, а коммит 11e2a90 «add a deployment path» от 26.08.2026 снёс
// его целиком. С тех пор `npm start` и служба systemd молча завершались за
// треть секунды с кодом 0 — база подключалась, маршруты настраивались, порт
// никто не слушал. Приложением поэтому ни разу и не пользовались.
if (require.main === module) {
    app.listen(PORT, HOST, () => {
        console.log(`--- СЕРВЕР ЗАПУЩЕН ---`);
        console.log(`Адрес: http://localhost:${PORT}`);
    });
}

module.exports = { app, db, validateWord, ready };