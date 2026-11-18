// Подсказка при добавлении слова: ввёл «et land» — получаешь сразу
// «land», средний род, формы из Ordbøkene, перевод и простой пример.
//
// Раньше это были три отдельные вещи: кнопка «из словаря», автоперевод
// MyMemory (по умолчанию выключен — часто ошибался) и Tatoeba для примера.
// В итоге половина слов в словаре оказалась без примеров, с переводами вроде
// «å bo — житель» и с частью речи «существительное» у глаголов.
const express = require('express');
const rateLimit = require('express-rate-limit');
const ordbok = require('./ordbok');
const ai = require('./ai');
const lingu = require('./lingu');

const GENDER_OF = { en: 'm', ei: 'f', et: 'n' };

// Что видно по самому написанию: артикль, «å», фраза.
function guessFromSpelling(raw) {
    const word = String(raw || '').trim().replace(/\s+/g, ' ');
    const m = word.match(/^(en|ei|et)\s+(\S.*)$/i);
    if (m && !/\s/.test(m[2])) return { original: m[2], pos: 'noun', gender: GENDER_OF[m[1].toLowerCase()] };
    if (/^å\s+\S/i.test(word)) return { original: word.replace(/^å/i, 'å'), pos: 'verb', gender: '' };
    if (/\s|[!?.]/.test(word)) return { original: word, pos: 'other', gender: '' };
    return { original: word, pos: '', gender: '' };
}

const deps = {
    lookup: ordbok.lookup,
    describe: async (w) => (await ai.describeWords([w])).items[0],
    aiAvailable: ai.available,
    translate: lingu.translate,
};

// Общий срок ответа: клиент ждёт 50 с. Словарь, ИИ и переводчик идут
// параллельно; не успевший к сроку считается пустым.
const DEADLINE_MS = Number(process.env.SUGGEST_DEADLINE_MS) || 30000;
const within = (p, ms) => Promise.race([p.catch(() => null), new Promise(r => setTimeout(r, ms, null).unref?.())]);

async function suggest(raw) {
    const typed = String(raw || '').trim().replace(/\s+/g, ' ');
    const spelled = guessFromSpelling(typed);
    const useAi = deps.aiAvailable();
    const [dict, described, machine] = await Promise.all([
        within(deps.lookup(typed), DEADLINE_MS),
        useAi ? within(deps.describe(typed), DEADLINE_MS) : null,
        // Переводчик — запасной; без ИИ он главный. С ИИ спрашиваем его тоже
        // сразу, чтобы не ждать его после долгого отказа ИИ.
        within(deps.translate(spelled.original), DEADLINE_MS),
    ]);
    let translate = described?.translate || '';
    let source = translate ? 'ai' : '';
    if (!translate && machine) { translate = machine; source = 'translator'; }
    return {
        // Фразу оставляем как написана: словарь отдаёт её строчными
        // («lykke til!» вместо «Lykke til!»).
        original: (spelled.pos !== 'other' && dict?.original) || spelled.original,
        pos: dict?.pos || spelled.pos,
        gender: dict?.gender || spelled.gender,
        forms: dict?.forms || {},
        inDictionary: Boolean(dict),
        translate,
        example: described?.example || '',
        exampleTranslate: described?.exampleTranslate || '',
        source,
    };
}

const router = express.Router();
const limiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

router.post('/api/word/suggest', limiter, async (req, res) => {
    const w = typeof req.body?.word === 'string' ? req.body.word.trim() : '';
    if (!w || w.length > 70) return res.status(400).json({ error: 'word: слово или выражение, до 70 символов' });
    try {
        res.json(await suggest(w));
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

module.exports = { router, deps, suggest, guessFromSpelling };
