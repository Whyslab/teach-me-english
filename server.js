const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

// Подключение к базе данных
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

// 1. Инициализация таблиц
db.serialize(() => {
    // Таблица настроек
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`, (err) => {
        if (!err) {
            db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('timeLeft', '600')");
        }
    });

    // Таблица слов
    db.run(`CREATE TABLE IF NOT EXISTS words (
        id REAL, 
        original TEXT,
        translate TEXT,
        example TEXT,
        exampleTranslate TEXT,
        level INTEGER,
        nextReview REAL
    )`, (err) => {
        if (err) console.error("Ошибка создания таблицы слов:", err.message);
        else console.log("Таблица слов готова: OK");
    });
    db.run("CREATE INDEX IF NOT EXISTS idx_words_next_review ON words(nextReview)");
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- API ДЛЯ ТАЙМЕРА ---

app.get('/api/timer', (req, res) => {
    db.get("SELECT value FROM settings WHERE key = 'timeLeft'", (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.json({ timeLeft: 600 }); // Подстраховка
        res.json({ timeLeft: parseInt(row.value) });
    });
});

app.post('/api/timer', (req, res) => {
    const { timeLeft } = req.body;
    db.run("UPDATE settings SET value = ? WHERE key = 'timeLeft'", [timeLeft], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ status: "success" });
    });
});

// --- API ДЛЯ СЛОВ ---

app.get('/api/words', (req, res) => {
    db.all("SELECT * FROM words", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/sync', (req, res) => {
    const words = req.body;
    if (!Array.isArray(words)) return res.status(400).json({ error: "Data is not an array" });

    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        db.run("DELETE FROM words");

        const stmt = db.prepare(`
            INSERT INTO words (id, original, translate, example, exampleTranslate, level, nextReview) 
            VALUES (?, ?, ?, ?, ?, ?, ?)
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
                    Number(w.nextReview) || Date.now()
                );
            }
        });

        stmt.finalize((err) => {
            if (err) {
                db.run("ROLLBACK");
                res.status(500).json({ error: "Ошибка финализации" });
            } else {
                db.run("COMMIT");
                console.log(`Синхронизировано слов: ${words.length}`);
                res.json({ status: "success", count: words.length });
            }
        });
    });
});

// Запуск
app.listen(PORT, '0.0.0.0', () => {
    console.log(`--- СЕРВЕР ЗАПУЩЕН ---`);
    console.log(`Адрес: http://localhost:${PORT}`);
});