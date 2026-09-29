const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
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
    allowedHeaders: ['Content-Type', 'X-User-Id']
}));
// Лимит был 50 МБ — ради фото в base64. Фото больше нет, а текстовый словарь
// даже на 10 000 слов укладывается в пару мегабайт.
app.use(express.json({ limit: '5mb' }));

// Раньше express.static раздавал весь каталог проекта: GET /vocab.db отдавал
// базу со словарём, GET /server.js — исходники, GET /deploy/... — скрипты.
// Теперь наружу видны только файлы, из которых состоит фронтенд.
const PUBLIC_FILES = new Set([
    'index.html', 'app.js', 'manifest.json', 'screenshot.png',
    ...[72, 96, 128, 144, 152, 192, 384, 512].map(n => `icon-${n}.png`)
]);

app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const name = req.path.replace(/^\/+/, '');
    if (!PUBLIC_FILES.has(name)) return next();
    const headers = {};
    if (name === 'manifest.json') headers['Cache-Control'] = 'max-age=86400';
    else if (/^icon-\d+\.png$/.test(name)) headers['Cache-Control'] = 'max-age=604800, immutable';
    res.sendFile(path.join(__dirname, name), { headers, dotfiles: 'deny' });
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

// Инициализация таблиц
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`, (err) => {
        if (!err) {
            db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('timeLeft', '3600')");
        }
    });

    // Колонки videoId/startTime/endTime/subtitleText/imageUrl остались в старых
    // базах от английской версии (видеофрагменты и фото). Сервер их больше не
    // читает и не пишет; при следующей синхронизации они заполняются пустыми
    // значениями по умолчанию.
    db.run(`CREATE TABLE IF NOT EXISTS words (
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
        addedAt REAL DEFAULT 0
    )`, (err) => {
        if (err) console.error("Ошибка создания таблицы слов:", err.message);
        else {
            if (process.env.NODE_ENV !== 'test') console.log("Таблица слов готова: OK");

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
            ];

            db.all("PRAGMA table_info(words)", [], (err, cols) => {
                if (err) return;
                const existingCols = new Set(cols.map(c => c.name));
                migrations.forEach(([col, sql]) => {
                    if (!existingCols.has(col)) {
                        db.run(sql, (err) => {
                            if (!err && process.env.NODE_ENV !== 'test') console.log(`Колонка '${col}' добавлена`);
                        });
                    }
                });
            });
        }
    });

    db.run("CREATE INDEX IF NOT EXISTS idx_words_next_review ON words(nextReview)");
});

// SW — явный маршрут с правильным Content-Type и заголовками
app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Service-Worker-Allowed', '/');
    res.sendFile(path.join(__dirname, 'sw.js'));
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

// Верхняя граница таймера сессии — сутки. Больше не бывает осмысленным,
// а без границы в базу попадало любое число.
const MAX_TIMER_SECONDS = 24 * 60 * 60;

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- API ДЛЯ ТАЙМЕРА ---

app.get('/api/timer', (req, res) => {
    db.get("SELECT value FROM settings WHERE key = 'timeLeft'", (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        const timeLeft = row ? parseInt(row.value) : 3600;
        res.json({ timeLeft: timeLeft > 0 ? timeLeft : 3600 });
    });
});

app.post('/api/timer', (req, res) => {
    // Раньше значение писалось в базу как пришло. Строка, объект, отрицательное
    // число — всё сохранялось, и GET /api/timer потом отдавал NaN.
    const { timeLeft } = req.body ?? {};
    const seconds = Number(timeLeft);

    if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_TIMER_SECONDS) {
        return res.status(400).json({
            error: `timeLeft must be a number between 0 and ${MAX_TIMER_SECONDS}`
        });
    }

    db.run("UPDATE settings SET value = ? WHERE key = 'timeLeft'",
        [String(Math.floor(seconds))], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ status: "success" });
        });
});

// --- РЕГИСТРАЦИЯ ПОЛЬЗОВАТЕЛЯ (однопользовательский режим) ---
// Клиент вызывает POST /api/register чтобы получить стабильный userId.
// У нас один пользователь — просто возвращаем фиксированный ID.
app.post('/api/register', (req, res) => {
    res.json({ userId: 'local-user-001', status: 'ok' });
});

// --- API ДЛЯ СЛОВ ---

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
        addedAt: Number(row.addedAt) || 0
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

    const historyOk =
        w.history === undefined ||
        w.history === null ||
        (Array.isArray(w.history) && w.history.length <= 100);

    return Boolean(
        typeof w.id === 'number' && Number.isFinite(w.id) &&
        typeof w.original === 'string' && w.original.length <= 100 &&
        typeof w.translate === 'string' && w.translate.length <= 500 &&
        tagsOk && historyOk
    );
}

// Каждая синхронизация — это одна транзакция DELETE + INSERT. Два запроса,
// пришедшие одновременно, раньше пытались открыть вторую транзакцию внутри
// первой и падали с SQLITE_ERROR. Теперь они выстраиваются в очередь.
let syncQueue = Promise.resolve();

function replaceAllWords(words) {
    return new Promise((resolve, reject) => {
        let failed = null;
        const fail = (err) => { if (err && !failed) failed = err; };

        db.serialize(() => {
            db.run("BEGIN TRANSACTION", fail);
            db.run("DELETE FROM words", fail);

            const stmt = db.prepare(`
                INSERT INTO words (id, original, translate, example, exampleTranslate, level,
                                   nextReview, forgetStep, tags, sm2EF, sm2Interval, sm2Reps,
                                   history, addedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            words.forEach(w => {
                if (!w.original || !w.translate) return;
                stmt.run(
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
                    fail
                );
            });

            stmt.finalize((err) => {
                fail(err);
                if (failed) {
                    db.run("ROLLBACK", () => reject(failed));
                } else {
                    db.run("COMMIT", (commitErr) => commitErr ? reject(commitErr) : resolve());
                }
            });
        });
    });
}

app.post('/api/sync', (req, res) => {
    if (!Array.isArray(req.body)) {
        return res.status(400).json({ error: "Invalid request format" });
    }

    if (req.body.length > 10000) {
        return res.status(413).json({ error: "Payload too large" });
    }

    if (!req.body.every(validateWord)) {
        return res.status(400).json({ error: "Invalid word format" });
    }

    const words = req.body;
    const job = syncQueue.then(() => replaceAllWords(words));
    syncQueue = job.catch(() => {});

    job.then(() => {
        if (process.env.NODE_ENV !== 'test') console.log(`Синхронизировано слов: ${words.length}`);
        res.json({ status: "success", count: words.length });
    }).catch((err) => {
        console.error("Ошибка синхронизации:", err.message);
        res.status(500).json({ error: "Ошибка синхронизации" });
    });
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

module.exports = { app, db, validateWord };