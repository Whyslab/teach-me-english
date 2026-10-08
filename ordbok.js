// Ordbøkene (ord.uib.no) — официальный словарь букмола: часть речи, род и
// формы слова. Нужен, чтобы при добавлении слова не заполнять формы руками
// и не угадывать по правилам (bok → bøker правилом не получить).
//
// API открытое, без ключа: /api/articles?w=… находит статьи, а
// /bm/article/<id>.json отдаёт парадигмы склонения. Разбор вынесен в чистые
// функции — они тестируются на сохранённых ответах без сети.
const express = require('express');
const rateLimit = require('express-rate-limit');

const HOST = 'ord.uib.no';
const TIMEOUT_MS = 8000;
const MAX_ARTICLES = 6;

// «en hus» → { lemma: 'hus', pos: 'noun', gender: 'm' }; «å snakke» → verb.
function parseQuery(raw) {
    const word = String(raw || '').trim().replace(/\s+/g, ' ');
    const m = word.match(/^(en|ei|et|å)\s+(.+)$/i);
    if (!m) return { lemma: word, pos: '', gender: '' };
    const p = m[1].toLowerCase();
    if (p === 'å') return { lemma: m[2], pos: 'verb', gender: '' };
    return { lemma: m[2], pos: 'noun', gender: { en: 'm', ei: 'f', et: 'n' }[p] };
}

const POS_OF = { NOUN: 'noun', VERB: 'verb', ADJ: 'adj' };
const GENDER_OF = { Masc: 'm', Fem: 'f', Neuter: 'n' };

const has = (tags, ...want) => want.every(t => tags.includes(t));
function formOf(paradigm, test) {
    const hit = (paradigm.inflection || []).find(i => i.word_form && test(i.tags || []));
    return hit ? hit.word_form : '';
}

// Парадигма → формы в том виде, в каком их хранит приложение (см. js/norsk.js).
function paradigmForms(paradigm) {
    const tags = paradigm.tags || [];
    const pos = POS_OF[tags[0]] || '';
    if (pos === 'noun') {
        return {
            pos,
            gender: GENDER_OF[tags.find(t => GENDER_OF[t])] || '',
            forms: {
                defSg: formOf(paradigm, t => has(t, 'Sing', 'Def')),
                indefPl: formOf(paradigm, t => has(t, 'Plur', 'Ind')),
                defPl: formOf(paradigm, t => has(t, 'Plur', 'Def')),
            },
        };
    }
    if (pos === 'verb') {
        const perf = formOf(paradigm, t => t.length === 1 && t[0] === '<PerfPart>');
        return {
            pos,
            gender: '',
            forms: {
                present: formOf(paradigm, t => has(t, 'Pres') && !t.includes('Pass')),
                past: formOf(paradigm, t => has(t, 'Past') && !t.includes('Pass')),
                perfect: perf ? `har ${perf}` : '',
            },
        };
    }
    if (pos === 'adj') {
        return {
            pos,
            gender: '',
            forms: {
                neuter: formOf(paradigm, t => has(t, 'Pos', 'Neuter', 'Ind', 'Sing')),
                plural: formOf(paradigm, t => has(t, 'Pos', 'Plur')),
            },
        };
    }
    return { pos: pos || 'other', gender: '', forms: {} };
}

// Из нескольких допустимых вариантов берём основной: формы на -a
// (snakka, husa) — радикальный вариант букмола, учебники и колоды
// приложения пишут snakket, husene. У существительных женского рода -a в
// определённой форме единственного числа (boka) — норма, её не штрафуем.
function radicalScore(result) {
    const f = result.forms;
    let score = 0;
    if (result.pos === 'verb' && /a$/.test(f.past || '')) score++;
    if (result.pos === 'noun' && /a$/.test(f.defPl || '')) score++;
    return score;
}

// Статьи → лучший разбор для запроса. articles — массив JSON-статей.
function pickParadigm(articles, query) {
    const lemma = query.lemma.toLowerCase();
    const candidates = [];
    articles.forEach((article, ai) => {
        for (const lem of article.lemmas || []) {
            if (String(lem.lemma || '').toLowerCase() !== lemma) continue;
            (lem.paradigm_info || []).forEach((paradigm, pi) => {
                if (paradigm.to) return;   // устаревшее написание
                const result = paradigmForms(paradigm);
                if (query.pos && result.pos !== query.pos) return;
                candidates.push({ result, lemma: String(lem.lemma), order: ai * 100 + pi });
            });
        }
    });
    if (!candidates.length) return null;
    const rank = (c) => (query.gender && c.result.gender !== query.gender ? 10 : 0) + radicalScore(c.result);
    candidates.sort((a, b) => rank(a) - rank(b) || a.order - b.order);
    const best = candidates[0].result;
    // Написание из словаря, а не из запроса: иначе кеш отдавал бы «Bok»
    // на «bok», если первым спросили с заглавной.
    const lemmaText = candidates[0].lemma;
    const forms = Object.fromEntries(Object.entries(best.forms).filter(([, v]) => v));
    // Род из запроса важнее словарного, если словарь его допускает:
    // «en bok» тоже правильно, хотя первой идёт «ei bok».
    const gender = best.pos === 'noun' && query.gender &&
        candidates.some(c => c.result.gender === query.gender) ? query.gender : best.gender;
    return {
        lemma: lemmaText,
        original: best.pos === 'verb' ? `å ${lemmaText}` : lemmaText,
        pos: best.pos,
        gender,
        forms,
    };
}

// Встроенный fetch с жёстким таймаутом: прежний https.get при обрыве
// посреди ответа не завершал промис никогда, и импорт со скриншота висел.
async function getJson(path) {
    const res = await fetch(`https://${HOST}${path}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ord.uib.no ответил ${res.status}`);
    return res.json();
}

// Кеш в памяти: одно и то же слово при импорте и добавлении ищется не раз.
const cache = new Map();
const CACHE_MAX = 1000;

async function lookup(raw, fetchJson = getJson) {
    const query = parseQuery(raw);
    if (!query.lemma || query.lemma.length > 60) return null;
    const key = `${query.pos}|${query.gender}|${query.lemma.toLowerCase()}`;
    if (cache.has(key)) return cache.get(key);
    const found = await fetchJson(`/api/articles?w=${encodeURIComponent(query.lemma)}&dict=bm&scope=e`);
    const ids = (found?.articles?.bm || []).slice(0, MAX_ARTICLES);
    const articles = await Promise.all(ids.map(id => fetchJson(`/bm/article/${Number(id)}.json`)));
    const result = pickParadigm(articles, query);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, result);
    return result;
}

const router = express.Router();
const limiter = rateLimit({ windowMs: 60 * 1000, max: 120 });

router.get('/api/ordbok', limiter, async (req, res) => {
    const w = String(req.query.w || '').trim();
    if (!w || w.length > 70) return res.status(400).json({ error: 'w: слово, до 70 символов' });
    try {
        const result = await lookup(w);
        if (!result) return res.status(404).json({ error: 'Слова нет в Ordbøkene' });
        res.json(result);
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

module.exports = { router, lookup, parseQuery, pickParadigm, paradigmForms };
