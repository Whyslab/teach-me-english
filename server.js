const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const https = require('https');
const http = require('http');
const rateLimit = require('express-rate-limit');
const app = express();
const PORT = Number(process.env.PORT) || 3000;
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
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname), {
    setHeaders: (res, filePath) => {
        // Service Worker — no cache, чтобы всегда получать свежую версию
        if (filePath.endsWith('sw.js')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Service-Worker-Allowed', '/');
        }
        // Манифест — короткий кеш
        else if (filePath.endsWith('manifest.json')) {
            res.setHeader('Cache-Control', 'max-age=86400');
        }
        // Иконки — долгий кеш
        else if (filePath.match(/icon-\d+\.png$/)) {
            res.setHeader('Cache-Control', 'max-age=604800, immutable');
        }
    }
}));

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
        videoId TEXT DEFAULT '',
        startTime REAL DEFAULT 0,
        endTime REAL DEFAULT 0,
        subtitleText TEXT DEFAULT '',
        imageUrl TEXT DEFAULT ''
    )`, (err) => {
        if (err) console.error("Ошибка создания таблицы слов:", err.message);
        else {
            console.log("Таблица слов готова: OK");

            const migrations = [
                ["forgetStep",    "ALTER TABLE words ADD COLUMN forgetStep INTEGER DEFAULT 0"],
                ["tags",          "ALTER TABLE words ADD COLUMN tags TEXT DEFAULT '[]'"],
                ["videoId",       "ALTER TABLE words ADD COLUMN videoId TEXT DEFAULT ''"],
                ["startTime",     "ALTER TABLE words ADD COLUMN startTime REAL DEFAULT 0"],
                ["endTime",       "ALTER TABLE words ADD COLUMN endTime REAL DEFAULT 0"],
                ["subtitleText",  "ALTER TABLE words ADD COLUMN subtitleText TEXT DEFAULT ''"],
                ["imageUrl",      "ALTER TABLE words ADD COLUMN imageUrl TEXT DEFAULT ''"],
            ];

            db.all("PRAGMA table_info(words)", [], (err, cols) => {
                if (err) return;
                const existingCols = new Set(cols.map(c => c.name));
                migrations.forEach(([col, sql]) => {
                    if (!existingCols.has(col)) {
                        db.run(sql, (err) => {
                            if (!err) console.log(`Колонка '${col}' добавлена`);
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
// ============================================================
app.get('/api/tatoeba', limiter, (req, res) => {
    const word = req.query.word;
    if (!word || word.length > 100) return res.status(400).json({ error: 'Invalid word' });

    const options = {
        hostname: 'tatoeba.org',
        path: `/en/api_v0/search?from=eng&to=rus&query=${encodeURIComponent(word)}&limit=6`,
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
            'Accept': 'application/json'
        },
        timeout: 8000
    };

    let body = '';
    const proxyReq = https.request(options, (proxyRes) => {
        if (proxyRes.statusCode !== 200) {
            return res.status(proxyRes.statusCode).json({ error: 'Service unavailable' });
        }
        
        proxyRes.on('data', chunk => {
            body += chunk;
            if (body.length > 1024 * 1024) { // 1MB limit
                proxyReq.abort();
                res.status(413).json({ error: 'Response too large' });
            }
        });
        
        proxyRes.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (!data.results || !Array.isArray(data.results)) {
                    throw new Error('Invalid response format');
                }
                res.json({ results: data.results.slice(0, 10) }); // Лимитируем результаты
            } catch (e) {
                res.status(502).json({ error: 'Invalid response from service' });
            }
        });
    });

    proxyReq.on('error', (e) => {
        console.error('Tatoeba proxy error:', e.message);
        res.status(502).json({ error: e.message });
    });

    proxyReq.on('timeout', () => {
        proxyReq.destroy();
        res.status(504).json({ error: 'timeout' });
    });

    proxyReq.end();
});


// ============================================================
// UNSPLASH PROXY — картинки к словам
// ============================================================
// ---------------------------------------------------------------------------
// Картинка к слову.
//
// Раньше здесь проксировался source.unsplash.com. Unsplash этот эндпоинт
// закрыл — он отвечает 503, — а код не проверял статус ответа и в любом случае
// возвращал клиенту ссылку на мёртвый адрес. Наружу это выглядело как "функция
// работает, просто картинка не грузится".
//
// Теперь: Openverse (агрегатор Flickr/Wikimedia, ключ не нужен), с откатом на
// Wikimedia Commons. Анонимный лимит Openverse — 200 запросов в сутки, поэтому
// найденный адрес сохраняется в колонку words.imageUrl и повторно не ищется.
// ---------------------------------------------------------------------------

// Верхняя граница таймера сессии — сутки. Больше не бывает осмысленным,
// а без границы в базу попадало любое число.
const MAX_TIMER_SECONDS = 24 * 60 * 60;

const IMAGE_LOOKUP_TIMEOUT = 8000;

function fetchJson(url, headers = {}) {
    return new Promise((resolve) => {
        const req = https.request(url, {
            method: 'GET',
            headers: { 'User-Agent': 'teach-me-english/1.0 (self-hosted vocabulary trainer)', ...headers },
            timeout: IMAGE_LOOKUP_TIMEOUT
        }, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.resume();
                return resolve(null);
            }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                body += chunk;
                // Ответ поиска не бывает большим; обрываем явную аномалию.
                if (body.length > 2 * 1024 * 1024) { req.destroy(); resolve(null); }
            });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
    });
}

async function lookupOpenverse(word) {
    const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(word)}` +
                '&page_size=1&license_type=all&mature=false';
    const data = await fetchJson(url);
    const hit = data?.results?.[0];
    return hit?.thumbnail || hit?.url || null;
}

async function lookupWikimedia(word) {
    const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json' +
                '&generator=search&gsrnamespace=6&gsrlimit=1' +
                `&gsrsearch=${encodeURIComponent(word)}` +
                '&prop=imageinfo&iiprop=url&iiurlwidth=320';
    const data = await fetchJson(url);
    const pages = data?.query?.pages;
    if (!pages) return null;
    for (const page of Object.values(pages)) {
        const thumb = page?.imageinfo?.[0]?.thumburl;
        if (thumb) return thumb;
    }
    return null;
}

app.get('/api/word-image', limiter, async (req, res) => {
    const word = typeof req.query.word === 'string' ? req.query.word.trim() : '';
    if (!word || word.length > 100) {
        return res.status(400).json({ error: 'word required' });
    }

    // 1. Кеш: уже искали для этого слова — отдаём сохранённое.
    const cached = await new Promise((resolve) => {
        db.get(
            "SELECT imageUrl FROM words WHERE lower(original) = lower(?) AND imageUrl IS NOT NULL AND imageUrl != '' LIMIT 1",
            [word],
            (err, row) => resolve(err ? null : row?.imageUrl || null)
        );
    });
    if (cached) return res.json({ url: cached, cached: true });

    // 2. Ищем во внешних источниках.
    let url = null;
    try {
        url = await lookupOpenverse(word);
        if (!url) url = await lookupWikimedia(word);
    } catch {
        url = null;
    }

    if (!url) {
        // Честный ответ: ничего не нашли. Клиент показывает это явно,
        // а не оставляет пустую рамку.
        return res.json({ url: null });
    }

    // 3. Запоминаем, чтобы больше не тратить дневной лимит на это слово.
    db.run(
        "UPDATE words SET imageUrl = ? WHERE lower(original) = lower(?) AND (imageUrl IS NULL OR imageUrl = '')",
        [url, word],
        (err) => { if (err) console.error('Не удалось закешировать картинку:', err.message); }
    );

    res.json({ url, cached: false });
});

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

app.get('/api/words', (req, res) => {
    db.all("SELECT * FROM words", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const safeRows = rows.map(row => ({
            ...row,
            forgetStep: Number(row.forgetStep) || 0,
            example: row.example || "",
            exampleTranslate: row.exampleTranslate || "",
            tags: (() => { try { return JSON.parse(row.tags || '[]'); } catch { return []; } })(),
            videoId: row.videoId || '',
            startTime: Number(row.startTime) || 0,
            endTime: Number(row.endTime) || 0,
            subtitleText: row.subtitleText || '',
            imageUrl: row.imageUrl || ''
        }));
        res.json(safeRows);
    });
});

function validateWord(w) {
    // tags are optional. The previous form ended with `w.tags?.every(...)`,
    // which evaluates to undefined when tags is absent — so a word without
    // tags failed validation, and because /api/sync validates with .every(),
    // a single such word rejected the entire deck with a 400.
    const tagsOk =
        w.tags === undefined ||
        w.tags === null ||
        (Array.isArray(w.tags) &&
            w.tags.every(t => typeof t === 'string' && t.length <= 50));

    return Boolean(
        w &&
        typeof w.id === 'number' &&
        typeof w.original === 'string' && w.original.length <= 100 &&
        typeof w.translate === 'string' && w.translate.length <= 500 &&
        tagsOk
    );
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

    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        db.run("DELETE FROM words");

        const stmt = db.prepare(`
            INSERT INTO words (id, original, translate, example, exampleTranslate, level, nextReview, forgetStep, tags, videoId, startTime, endTime, subtitleText, imageUrl)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        words.forEach(w => {
            if (w.original && w.translate) {
                stmt.run(
                    Number(w.id) || Date.now(),
                    String(w.original),
                    String(w.translate),
                    String(w.example || ''),
                    String(w.exampleTranslate || ''),
                    parseInt(w.level) || 0,
                    Number(w.nextReview) || Date.now(),
                    parseInt(w.forgetStep) || 0,
                    JSON.stringify(Array.isArray(w.tags) ? w.tags : []),
                    String(w.videoId || ''),
                    Number(w.startTime) || 0,
                    Number(w.endTime) || 0,
                    String(w.subtitleText || ''),
                    String(w.imageUrl || '')
                );
            }
        });

        stmt.finalize((err) => {
            if (err) {
                db.run("ROLLBACK");
                console.error("Ошибка финализации:", err.message);
                res.status(500).json({ error: "Ошибка финализации" });
            } else {
                db.run("COMMIT");
                console.log(`Синхронизировано слов: ${words.length}`);
                res.json({ status: "success", count: words.length });
            }
        });
    });
});

// ============================================================
// YOUGLISH PROXY — обходим X-Frame-Options через сервер
// ============================================================
// /api/youglish-proxy удалён.
//
// Эндпоинт скачивал страницу youglish.com и вырезал из ответа заголовки
// X-Frame-Options и Content-Security-Policy, чтобы чужой сайт можно было
// показать в iframe. Клиент его никогда не вызывал — произношение открывается
// обычным window.open на youglish.com (см. app.js). То есть 76 строк кода
// обходили защиту стороннего сайта от встраивания и при этом не использовались.

module.exports = { app, db, validateWord };