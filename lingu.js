// Импорт слов со скриншота (приложение Lingu и похожие карточки).
//
// Основной путь (с 18.11.2026) — модель со зрением через ИИ-шлюз (ai.js): она
// читает и норвежский, и русский текст, берёт перевод со скриншота, если он
// там есть. Грамматику (род, формы) всё равно даёт Ordbøkene.
//
// Запасной путь, если шлюз недоступен:
// скриншот → текст через tesseract (локально, норвежская + русская модели) → карточки
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
const { spawn } = require('child_process');
const express = require('express');
const rateLimit = require('express-rate-limit');
const ordbok = require('./ordbok');
const ai = require('./ai');

const OCR_TIMEOUT_MS = 30000;
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_CARDS = 25;

const HEADER = /^(substantiv|substantiver|verb|verb[ae]r|adjektiv|adjektiver|adverb|adverber|preposisjon(er)?|pronomen|konjunksjon(er)?|subjunksjon(er)?|uttrykk|frase(r)?|interjeksjon(er)?|tallord|determinativ(er)?|ord)$/i;
const QUOTE_START = /^["“”„«'’‘]/;
const CLOSES_QUOTE = /["“”»'’‘]\s*$/;
const squash = (s) => s.toLowerCase().replace(/\s+/g, '');
// Строка по-русски: перевод или пояснение на скриншоте, а не норвежское слово.
const isCyrillic = (s) => (s.match(/\p{Script=Cyrillic}/gu) || []).length >= Math.max(2, (s.match(/\p{L}/gu) || []).length / 2);

function cleanSentence(line) {
    return line.replace(/^["“”„«'’‘\s]+/, '').replace(/["“”»'’‘\s]+$/, '').trim();
}

// Похоже на слово или короткое выражение, а не на мусор распознавания
// (кусок кнопки, номер страницы).
function looksLikeWord(line) {
    return line.length <= 60 && line.split(/\s+/).length <= 5 && /^[\p{L}][\p{L}\s'’-]*$/u.test(line);
}

// Текст распознавания → карточки { original, definition, example }.
//
// Опоры две. Слово карточки идёт дважды подряд (цветом и жирным) — так
// начало новой карточки видно, даже если у прошлой не нашёлся пример.
// Пример начинается с кавычки и может переноситься на следующие строки,
// пока не встретится закрывающая кавычка.
function parseCards(text) {
    const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean)
        .filter(l => !HEADER.test(l));
    const cards = [];
    let cur = null;
    let openExample = false;
    const finish = () => {
        if (cur) {
            cur.example = cleanSentence(cur.example);
            if (looksLikeWord(cur.original) && (cur.definition || cur.example || cur.translate)) cards.push(cur);
        }
        cur = null;
        openExample = false;
    };
    const startsCard = (i) => i + 1 < lines.length && squash(lines[i]) === squash(lines[i + 1]) &&
        !QUOTE_START.test(lines[i]);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Русская строка — перевод текущего слова (первая) или русская
        // половина примера: норвежской карточкой она не бывает.
        if (isCyrillic(line)) {
            if (cur && !cur.translate && !cur.example && !openExample && line.length <= 60) cur.translate = line.replace(/[«»"]/g, '').trim();
            continue;
        }
        if (startsCard(i)) {
            finish();
            // Дубль жирным иногда теряет пробел («enuttale») — берём вариант с пробелом.
            const a = line, b = lines[i + 1];
            cur = { original: (a.includes(' ') ? a : b).replace(/\s+/g, ' '), definition: '', example: '' };
            i++;
            continue;
        }
        if (openExample) {
            cur.example += ` ${line}`;
            if (CLOSES_QUOTE.test(line)) finish();
            continue;
        }
        if (QUOTE_START.test(line)) {
            if (!cur) continue;
            cur.example = line;
            if (CLOSES_QUOTE.test(line.slice(1))) finish();
            else openExample = true;
            continue;
        }
        if (!cur) {
            cur = { original: line.replace(/\s+/g, ' '), definition: '', example: '' };
        } else if (squash(line) === squash(cur.original)) {
            continue;
        } else if (cur.example) {
            continue;
        } else if (cur.definition && /^\p{Lu}.*[.!?]$/u.test(line)) {
            // Пример без кавычек: предложение с заглавной и точкой. Объяснения
            // в карточках пишутся со строчной.
            cur.example = line;
            finish();
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
// Какие языки есть у tesseract. Русская модель нужна для скриншотов с
// русским текстом: норвежская читала его как «Ha kakuXx A3blKaX». Нет её —
// работаем с одной норвежской, как раньше. TESSDATA_DIR — свой каталог
// моделей (без root), если системный пакет не поставлен.
const langCache = new Map();
function ocrArgs() {
    const dir = process.env.TESSDATA_DIR;
    return dir ? ['--tessdata-dir', dir] : [];
}
function ocrLangs(bin) {
    if (!langCache.has(bin)) {
        langCache.set(bin, new Promise((resolve) => {
            let out = '';
            const child = spawn(bin, [...ocrArgs(), '--list-langs'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
            child.stdout.on('data', (d) => { out += d; });
            child.stderr.on('data', (d) => { out += d; });   // старые версии пишут список в stderr
            child.on('error', () => resolve('nor'));
            child.on('close', () => resolve(/^rus$/m.test(out) && /^nor$/m.test(out) ? 'nor+rus' : 'nor'));
        }));
    }
    return langCache.get(bin);
}

async function ocr(image, { bin = process.env.TESSERACT_BIN || 'tesseract' } = {}) {
    const langs = await ocrLangs(bin);
    return new Promise((resolve, reject) => {
        // Не больше двух ядер: на ноутбуке с 8 ГБ tesseract на все ядра
        // заметно подвешивает остальное.
        const child = spawn(bin, [...ocrArgs(), 'stdin', 'stdout', '-l', langs], {
            stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, OMP_THREAD_LIMIT: '2' },
        });
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

// Google Translate (открытая точка gtx, без ключа). Для норвежский → русский
// заметно точнее MyMemory: «uttale» — «произношение», а не «заявление».
async function googleTranslate(q) {
    try {
        const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=no&tl=ru&dt=t&q=${encodeURIComponent(q)}`,
            { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return '';
        const data = await res.json();
        const text = (Array.isArray(data?.[0]) ? data[0] : []).map(part => (Array.isArray(part) ? part[0] : '')).join('').trim();
        return text && text.toLowerCase() !== q.toLowerCase() ? text.replace(/^чтобы\s+/i, '') : '';
    } catch {
        return '';
    }
}

// Перевод норвежский → русский (запасной путь, когда ИИ недоступен);
// при любой ошибке или таймауте — пустая строка.
async function translate(text) {
    // По символам, а не по UTF-16: срез посреди эмодзи ломал encodeURIComponent.
    const q = Array.from(String(text || '').trim()).slice(0, 450).join('');
    if (!q) return '';
    const google = await deps.google(q);
    if (google) return google;
    try {
        const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=nb-NO|ru-RU`,
            { signal: AbortSignal.timeout(10000) });
        if (!res.ok) return '';
        return pickTranslation(await res.json(), q);
    } catch {
        return '';
    }
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
    const [translateText, exampleTranslate] = await Promise.all([
        card.translate || tr(card.original),
        card.exampleTranslate || (card.example ? tr(card.example) : ''),
    ]);
    return {
        original: dict?.original || (m ? m[2] : card.original),
        translate: translateText,
        example: card.example || '',
        exampleTranslate,
        definition: card.definition || '',
        pos: dict?.pos || fallbackPos,
        gender: dict?.gender || (m ? { en: 'm', ei: 'f', et: 'n' }[m[1].toLowerCase()] : ''),
        forms: dict?.forms || {},
        inDictionary: Boolean(dict),
    };
}

// Ключ слова для «уже есть в словаре»: без артикля, но с «å» — иначе
// существительное «uttale» совпало бы с глаголом «å uttale».
const ARTICLE = /^(en|ei|et)\s+/i;
function wordKey(original) {
    return String(original || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(ARTICLE, '');
}

// Подменяются в тестах; knownWords задаёт server.js (у него база).
const deps = {
    lookup: ordbok.lookup, tr: translate, google: googleTranslate, knownWords: async () => new Set(),
    readScreenshot: ai.readScreenshot, describeWords: ai.describeWords, aiAvailable: ai.available,
};

// Карточки без перевода — одним запросом к ИИ: переводы и примеры
// точнее, чем у переводчика, и не 2×N запросов наружу. Ошибка — карточки
// остаются как были, перевод сделает enrich через переводчик.
async function fillWithAi(cards) {
    const need = cards.filter(c => !c.translate);
    if (!need.length || !deps.aiAvailable()) return;
    try {
        const { items } = await deps.describeWords(need.map(c => c.original));
        need.forEach((c, i) => {
            const it = items[i];
            if (!it) return;
            if (it.translate) c.translate = it.translate;
            if (c.example && !c.exampleTranslate && it.example === c.example) c.exampleTranslate = it.exampleTranslate;
            if (!c.example && it.example) { c.example = it.example; c.exampleTranslate = it.exampleTranslate; }
        });
    } catch { /* без ИИ — переводчик в enrich */ }
}

// Скриншот → карточки { original, definition, example, translate?, exampleTranslate? }.
// Сначала модель со зрением; не вышло — tesseract и разбор текста.
async function readCards(image, mime) {
    if (deps.aiAvailable()) {
        try {
            const { items } = await deps.readScreenshot(image, mime);
            if (items.length) {
                return {
                    via: 'ai',
                    cards: items.map(it => ({ original: it.word, definition: '', example: it.example,
                        translate: it.translate, exampleTranslate: it.exampleTranslate })),
                };
            }
        } catch { /* шлюз недоступен — tesseract */ }
    }
    // Распознавание идёт строго по одному: tesseract тяжёлый, а запросов с
    // одного телефона может прийти несколько подряд.
    const job = ocrQueue.then(() => ocr(image));
    ocrQueue = job.catch(() => {});
    const text = await job;
    return { via: 'ocr', text, cards: parseCards(text) };
}
let ocrQueue = Promise.resolve();

const router = express.Router();
const limiter = rateLimit({ windowMs: 60 * 1000, max: 20 });

router.post('/api/import/screenshot', limiter,
    express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: MAX_IMAGE }),
    async (req, res) => {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            return res.status(415).json({ error: 'Нужна картинка PNG, JPEG или WebP' });
        }
        let read;
        try {
            read = await readCards(req.body, req.get('Content-Type'));
        } catch (err) {
            return res.status(500).json({ error: `Не удалось распознать текст: ${err.message}` });
        }
        const { cards, text, via } = read;
        if (!cards.length) return res.json({ items: [], text, via });
        // Слова, которые уже есть, не тратят запросы к словарю и переводчику.
        let known = new Set();
        try { known = await deps.knownWords(); } catch { /* без проверки — просто медленнее */ }
        const isKnown = (c) => known.has(wordKey(c.original));
        await fillWithAi(cards.filter(c => !isKnown(c)));
        const items = await mapLimit(cards, 3, (c) => (isKnown(c)
            ? { original: c.original.replace(ARTICLE, ''), translate: '', example: c.example, exampleTranslate: '',
                definition: c.definition, pos: '', gender: '', forms: {}, known: true }
            : enrich(c, deps)));
        res.json({ items, via });
    });

module.exports = { router, deps, wordKey, parseCards, enrich, ocr, translate, pickTranslation, googleTranslate };
