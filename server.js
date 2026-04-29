const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const https = require('https');
const http = require('http');
const app = express();
const PORT = 3000;

app.use(cors());
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

const db = new sqlite3.Database('./vocab.db', (err) => {
    if (err) console.error('Ошибка БД:', err.message);
    else console.log('Подключено к базе данных SQLite (vocab.db).');
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

// Явный маршрут для favicon (express.static иногда не подхватывает)
// SW — явный маршрут с правильным Content-Type и заголовками
app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Service-Worker-Allowed', '/');
    res.sendFile(path.join(__dirname, 'sw.js'));
});

app.get('/favicon.ico', (req, res) => {
    res.sendFile(path.join(__dirname, 'favicon.ico'), (err) => {
        if (err) res.status(204).end(); // No content если файл не найден
    });
});


// ============================================================
// TATOEBA PROXY — примеры предложений (обходим CORS)
// ============================================================
app.get('/api/tatoeba', (req, res) => {
    const word = req.query.word;
    if (!word) return res.status(400).json({ error: 'word required' });

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

    const proxyReq = https.request(options, (proxyRes) => {
        let body = '';
        proxyRes.on('data', chunk => body += chunk);
        proxyRes.on('end', () => {
            try {
                const data = JSON.parse(body);
                res.json(data);
            } catch (e) {
                res.status(500).json({ error: 'parse error' });
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
app.get('/api/word-image', (req, res) => {
    const word = req.query.word;
    if (!word) return res.status(400).json({ error: 'word required' });

    // Используем Picsum для демо (не требует API key)
    // Для продакшна замените на Unsplash API с ключом
    const seed = encodeURIComponent(word.toLowerCase().trim());
    // Ищем через DuckDuckGo image API (публичный, без ключа)
    const options = {
        hostname: 'source.unsplash.com',
        path: `/200x150/?${seed}`,
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 6000
    };

    let responded = false;
    const safeJson = (data) => { if (!responded) { responded = true; res.json(data); } };

    const proxyReq = https.request(options, (proxyRes) => {
        if (proxyRes.statusCode === 302 || proxyRes.statusCode === 301) {
            const location = proxyRes.headers.location;
            if (location) return safeJson({ url: location });
        }
        safeJson({ url: `https://source.unsplash.com/200x150/?${seed}` });
    });

    proxyReq.on('error', () => safeJson({ url: null }));
    proxyReq.on('timeout', () => { proxyReq.destroy(); safeJson({ url: null }); });
    proxyReq.end();
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
    const { timeLeft } = req.body;
    db.run("UPDATE settings SET value = ? WHERE key = 'timeLeft'", [timeLeft], (err) => {
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

app.post('/api/sync', (req, res) => {
    const words = req.body;
    if (!Array.isArray(words)) return res.status(400).json({ error: "Data is not an array" });

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
app.get('/api/youglish-proxy', (req, res) => {
    const word = (req.query.word || '').trim();
    if (!word) return res.status(400).send('Word required');

    const targetUrl = `https://youglish.com/pronounce/${encodeURIComponent(word)}/english`;

    const options = {
        hostname: 'youglish.com',
        path: `/pronounce/${encodeURIComponent(word)}/english`,
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'identity',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
        },
        timeout: 10000
    };

    const proxyReq = https.request(options, (proxyRes) => {
        // Убираем заголовки блокировки iframe
        const headers = { ...proxyRes.headers };
        delete headers['x-frame-options'];
        delete headers['content-security-policy'];
        delete headers['x-content-type-options'];

        // Фиксируем encoding чтобы не сломать текст
        delete headers['content-encoding'];
        delete headers['transfer-encoding'];

        let body = Buffer.alloc(0);

        proxyRes.on('data', (chunk) => {
            body = Buffer.concat([body, chunk]);
        });

        proxyRes.on('end', () => {
            let html = body.toString('utf8');

            // Патчим все абсолютные пути чтобы ресурсы грузились с оригинального сайта
            html = html.replace(/(href|src|action)=\"\//g, '$1="https://youglish.com/');
            html = html.replace(/(href|src|action)='\//g, "$1='https://youglish.com/");
            html = html.replace(/(href|src|action)=\//g, '$1=https://youglish.com/');

            // Inject base tag чтобы относительные ссылки работали
            html = html.replace('<head>', '<head><base href="https://youglish.com/">');

            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            Object.entries(headers).forEach(([key, val]) => {
                try { res.setHeader(key, val); } catch(e) {}
            });

            res.send(html);
        });
    });

    proxyReq.on('error', (e) => {
        console.error('YouGlish proxy error:', e.message);
        res.status(502).send(`
            <html><body style="font-family:sans-serif;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:16px;">
                <div style="font-size:2rem;">⚠️</div>
                <div>Не удалось загрузить YouGlish</div>
                <a href="${targetUrl}" target="_blank" style="color:#b084f7;padding:10px 20px;border:1px solid #b084f7;border-radius:8px;text-decoration:none;">Открыть напрямую →</a>
            </body></html>
        `);
    });

    proxyReq.on('timeout', () => {
        proxyReq.destroy();
        res.status(504).send('Timeout');
    });

    proxyReq.end();
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`--- СЕРВЕР ЗАПУЩЕН ---`);
    console.log(`Адрес: http://localhost:${PORT}`);
});