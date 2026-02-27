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
            // ✅ ИСПРАВЛЕНО: увеличен дефолт до 3600 секунд (1 час)
            db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('timeLeft', '3600')");
        }
    });

    // ✅ ИСПРАВЛЕНО: добавлена колонка forgetStep которой не было раньше
    db.run(`CREATE TABLE IF NOT EXISTS words (
        id REAL, 
        original TEXT,
        translate TEXT,
        example TEXT,
        exampleTranslate TEXT,
        level INTEGER,
        nextReview REAL,
        forgetStep INTEGER DEFAULT 0
    )`, (err) => {
        if (err) console.error("Ошибка создания таблицы слов:", err.message);
        else {
            console.log("Таблица слов готова: OK");

            // ✅ ИСПРАВЛЕНО: если таблица уже существует без forgetStep — добавляем колонку
            db.run("ALTER TABLE words ADD COLUMN forgetStep INTEGER DEFAULT 0", (alterErr) => {
                if (alterErr && !alterErr.message.includes('duplicate column')) {
                    // Не логируем ошибку "duplicate column" — это нормально если колонка уже есть
                    console.log("forgetStep колонка уже существует или добавлена");
                } else if (!alterErr) {
                    console.log("Колонка forgetStep успешно добавлена в существующую таблицу");
                }
            });
        }
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
        // ✅ ИСПРАВЛЕНО: если нет записи или значение 0 — возвращаем 3600
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

// --- API ДЛЯ СЛОВ ---

app.get('/api/words', (req, res) => {
    db.all("SELECT * FROM words", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        // ✅ ИСПРАВЛЕНО: гарантируем что forgetStep всегда есть в ответе
        const safeRows = rows.map(row => ({
            ...row,
            forgetStep: Number(row.forgetStep) || 0,
            example: row.example || "",
            exampleTranslate: row.exampleTranslate || ""
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

        // ✅ ИСПРАВЛЕНО: добавлен forgetStep в INSERT
        const stmt = db.prepare(`
            INSERT INTO words (id, original, translate, example, exampleTranslate, level, nextReview, forgetStep) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
                    parseInt(w.forgetStep) || 0   // ✅ новое поле
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

// Запуск
app.listen(PORT, '0.0.0.0', () => {
    console.log(`--- СЕРВЕР ЗАПУЩЕН ---`);
    console.log(`Адрес: http://localhost:${PORT}`);
});