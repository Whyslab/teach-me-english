// Импорт слов со скриншота (приложение Lingu и похожие карточки).
//
// Скриншот → текст через tesseract (локально, норвежская модель) → карточки
// { слово, объяснение по-норвежски, пример } → к каждой род и формы из
// Ordbøkene и перевод слова и примера на русский (MyMemory). Окончательное
// решение — за пользователем: браузер показывает список с галочками.
//
// Карточка Lingu на экране выглядит так (две колонки, разделы по частям речи):
//     Substantiv
//     en uttale              ← слово (цветом)
//     en uttale              ← оно же жирным — дубль
//     en måte å si noe på    ← объяснение
//     "Jeg øver på uttale."  ← пример
// Колонки tesseract читает вперемешку, поэтому заголовки разделов не
// используются: часть речи видна по самому слову (en/ei/et, å) и по словарю.
const https = require('https');
const { spawn } = require('child_process');
const express = require('express');
const rateLimit = require('express-rate-limit');
const ordbok = require('./ordbok');

const OCR_TIMEOUT_MS = 30000;
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_CARDS = 40;

const HEADER = /^(substantiv|substantiver|verb|verb[ae]r|adjektiv|adjektiver|adverb|adverber|preposisjon(er)?|pronomen|konjunksjon(er)?|subjunksjon(er)?|uttrykk|frase(r)?|interjeksjon(er)?|tallord|determinativ(er)?|ord)$/i;
const QUOTE_START = /^["“”„«'’‘]/;
const squash = (s) => s.toLowerCase().replace(/\s+/g, '');

function cleanSentence(line) {
    return line.replace(/^["“”„«'’‘\s]+/, '').replace(/["“”»'’‘\s]+$/, '').trim();
}

// Похоже на слово или короткое выражение, а не на мусор распознавания
// (кусок кнопки, номер страницы).
function looksLikeWord(line) {
    return line.length <= 60 && line.split(/\s+/).length <= 5 && /^[\p{L}][\p{L}\s'’-]*$/u.test(line);
}

// Текст распознавания → карточки { original, definition, example }.
function parseCards(text) {
    const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
    const cards = [];
    let cur = null;
    const finish = () => {
        if (cur && looksLikeWord(cur.original) && (cur.definition || cur.example)) cards.push(cur);
        cur = null;
    };
    for (const line of lines) {
        if (HEADER.test(line)) continue;
        if (QUOTE_START.test(line)) {
            if (cur) {
                cur.example = cleanSentence(line);
                finish();
            }
            continue;
        }
        if (!cur) {
            cur = { original: line.replace(/\s+/g, ' '), definition: '', example: '' };
        } else if (squash(line) === squash(cur.original)) {
            // Дубль жирным; распознавание иногда теряет в нём пробел («enuttale»).
            if (line.includes(' ') && !cur.original.includes(' ')) cur.original = line;
        } else if (!cur.definition) {
            cur.definition = line;
        } else {
            cur.definition += ` ${line}`;
        }
    }
    finish();
    // Одно слово на скриншоте могло попасться дважды.
    const seen = new Set();
    return cards.filter(c => !seen.has(squash(c.original)) && seen.add(squash(c.original))).slice(0, MAX_CARDS);
}

// Картинка → текст. tesseract читает со stdin и пишет в stdout — без
// временных файлов.
function ocr(image, { bin = process.env.TESSERACT_BIN || 'tesseract' } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, ['stdin', 'stdout', '-l', 'nor'], { stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('распознавание заняло слишком долго')); }, OCR_TIMEOUT_MS);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', (e) => { clearTimeout(timer); reject(e.code === 'ENOENT' ? new Error('tesseract не установлен') : e); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(out);
            else reject(new Error(`tesseract: ${err.trim().split('\n').pop() || `код ${code}`}`));
        });
        child.stdin.on('error', () => { /* процесс умер раньше — ошибку сообщит close */ });
        child.stdin.end(image);
    });
}

// Выбор перевода из ответа MyMemory. Основной ответ иногда мусор из чужой
// памяти переводов: на «å høre» однажды пришла длинная цитата. Поэтому
// кандидаты — основной ответ и варианты из matches, переводящие именно этот
// текст; берётся первый правдоподобный. Ничего подходящего или «перевод»,
// равный исходнику (MyMemory так отвечает, когда не знает), — пустая строка.
function pickTranslation(data, query) {
    const q = String(query).trim().toLowerCase();
    const isWord = q.split(/\s+/).length <= 3;
    const plausible = (t) => {
        const s = String(t || '').trim();
        if (!s || s.toLowerCase() === q || /[\[\]{}<>]/.test(s)) return false;
        if (isWord) return s.split(/\s+/).length <= 5 && s.length <= 60;
        return s.length <= q.length * 3 + 40;
    };
    const same = (seg) => String(seg || '').trim().toLowerCase() === q;
    const candidates = [
        data?.responseStatus === 200 ? data.responseData?.translatedText : '',
        ...[...(data?.matches || [])]
            .filter(m => same(m.segment))
            .sort((a, b) => (Number(b.match) || 0) - (Number(a.match) || 0))
            .map(m => m.translation),
    ];
    return String(candidates.find(plausible) || '').trim();
}

// Перевод норвежский → русский; при любой ошибке — пустая строка.
function translate(text) {
    const q = String(text || '').trim();
    if (!q) return Promise.resolve('');
    const path = `/get?q=${encodeURIComponent(q.slice(0, 450))}&langpair=nb-NO|ru-RU`;
    return new Promise((resolve) => {
        const req = https.get({ hostname: 'api.mymemory.translated.net', path, timeout: 10000 }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                try { resolve(pickTranslation(JSON.parse(body), q)); } catch { resolve(''); }
            });
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve(''));
    });
}

// Не больше n запросов наружу одновременно.
async function mapLimit(items, n, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
    return out;
}

// Карточка → слово для приложения. deps подменяются в тестах.
async function enrich(card, { lookup = ordbok.lookup, tr = translate } = {}) {
    let dict = null;
    try { dict = await lookup(card.original); } catch { /* словарь недоступен — без грамматики */ }
    const m = card.original.match(/^(en|ei|et)\s+(.+)$/i);
    const fallbackPos = /^å\s/i.test(card.original) ? 'verb' : m ? 'noun' : '';
    const [translateText, exampleTranslate] = await Promise.all([tr(card.original), tr(card.example)]);
    return {
        original: dict?.original || (m ? m[2] : card.original),
        translate: translateText,
        example: card.example,
        exampleTranslate,
        definition: card.definition,
        pos: dict?.pos || fallbackPos,
        gender: dict?.gender || (m ? { en: 'm', ei: 'f', et: 'n' }[m[1].toLowerCase()] : ''),
        forms: dict?.forms || {},
        inDictionary: Boolean(dict),
    };
}

const router = express.Router();
const limiter = rateLimit({ windowMs: 60 * 1000, max: 20 });

router.post('/api/import/screenshot', limiter,
    express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: MAX_IMAGE }),
    async (req, res) => {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            return res.status(415).json({ error: 'Нужна картинка PNG, JPEG или WebP' });
        }
        let text;
        try {
            text = await ocr(req.body);
        } catch (err) {
            return res.status(500).json({ error: `Не удалось распознать текст: ${err.message}` });
        }
        const cards = parseCards(text);
        if (!cards.length) return res.json({ items: [], text });
        const items = await mapLimit(cards, 3, (c) => enrich(c));
        res.json({ items });
    });

module.exports = { router, parseCards, enrich, ocr, translate, pickTranslation };
