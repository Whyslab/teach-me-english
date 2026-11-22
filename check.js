// Проверка карточки: кнопка «🚩 Сомневаюсь». Перевод и пример проверяет ИИ,
// род и формы — словарь Ordbøkene. Модели в роде ошибаются: 22.11.2026 две из
// трёх назвали «en uttale» средним родом, поэтому род от ИИ не принимается.
// Ничего не меняет само: возвращает замечания и предложенную правку,
// применяет её пользователь.
const express = require('express');
const rateLimit = require('express-rate-limit');
const ordbok = require('./ordbok');
const ai = require('./ai');

// Проверено 22.11.2026 на «uttale — заявление»: deepseek-v4-flash нашёл ошибку
// перевода и не тронул род; mistral-large-3 и gpt-oss-120b — запасные.
const MODELS = (process.env.LLM_CHECK_MODELS || 'deepseek-v4-flash,mistral-large-3,mistral-medium-3.5,gpt-oss-120b')
    .split(',').map(s => s.trim()).filter(Boolean);

const PROMPT = `Ты — строгий редактор словаря норвежского (букмол) для русскоязычного ученика уровня A1–A2.
Проверь карточку слова:
- translate — верен ли русский перевод; главное частое значение должно идти первым; глагол — инфинитивом, существительное — в именительном падеже;
- example — правильное ли это норвежское предложение (букмол, без ошибок), есть ли в нём это слово, простое ли оно (до 10 слов);
- exampleTranslate — точно ли переведён пример.
Род и формы слова НЕ проверяй — их проверяет словарь.
Отмечай только явные ошибки: неверное значение, грамматическая ошибка в норвежском примере, перевод примера не совпадает по смыслу. НЕ предлагай синонимы и вкусовые правки, не меняй верный перевод на «более точный», не переводи названия (brunost — «бруност» — верно). Сомневаешься — считай, что верно.
Если всё верно — ok: true и пустые issues. Если нет — коротко опиши каждую ошибку по-русски и дай исправленные поля в fix (только те, что меняются; остальные — пустая строка). Пустой пример — не ошибка, но можешь предложить пример.
Ответь только JSON без пояснений: {"ok":true,"issues":[],"fix":{"translate":"","example":"","exampleTranslate":""}}
Карточка: `;

const str = (v, max) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const GENDER_RU = { m: 'en (мужской)', f: 'ei (женский)', n: 'et (средний)' };
const FORM_RU = { defSg: 'опр. ед.', indefPl: 'неопр. мн.', defPl: 'опр. мн.', present: 'настоящее', past: 'прошедшее', perfect: 'перфект', neuter: 'ср. род', plural: 'мн. ч.' };

const deps = {
    lookup: ordbok.lookup,
    aiAvailable: ai.available,
    ask: (content) => ai.ask(MODELS, content, (d) => d && typeof d === 'object' && typeof d.ok === 'boolean', { maxTokens: 700 }),
};

const within = (p, ms) => Promise.race([Promise.resolve(p).catch(() => null), new Promise(r => setTimeout(r, ms, null).unref?.())]);

// Слово для словаря: существительное — с артиклем, чтобы словарь взял нужное.
function queryOf(w) {
    const art = { m: 'en', f: 'ei', n: 'et' }[w.gender];
    return w.pos === 'noun' && art ? `${art} ${w.original}` : w.original;
}

async function checkWord(input) {
    const w = {
        original: str(input.original, 100), translate: str(input.translate, 300),
        example: str(input.example, 300), exampleTranslate: str(input.exampleTranslate, 300),
        pos: str(input.pos, 10), gender: str(input.gender, 1),
        forms: input.forms && typeof input.forms === 'object' ? input.forms : {},
    };
    const card = { original: w.original, translate: w.translate, example: w.example, exampleTranslate: w.exampleTranslate };
    const [dict, answer] = await Promise.all([
        within(deps.lookup(queryOf(w)), 20000),
        deps.aiAvailable() ? within(deps.ask(PROMPT + JSON.stringify(card)), 45000) : null,
    ]);

    const issues = [];
    const fix = {};
    if (answer?.data) {
        for (const s of Array.isArray(answer.data.issues) ? answer.data.issues : []) {
            const t = str(s, 200);
            if (t) issues.push(t);
        }
        for (const k of ['translate', 'example', 'exampleTranslate']) {
            const v = str(answer.data.fix?.[k], 300);
            if (v && v !== w[k]) fix[k] = v;
        }
        // Замечание без конкретной правки — шум («пример требует уточнения»):
        // проверено 22.11.2026 на колоде, такие жалобы были пустыми.
        if (!Object.keys(fix).length) issues.length = 0;
    }

    // Род и формы — по словарю. Существительное в букмоле: ei-слово можно
    // писать и как en, это не ошибка.
    if (dict) {
        if (w.pos === 'noun' && dict.gender && w.gender && dict.gender !== w.gender
            && !(w.gender === 'm' && dict.gender === 'f')) {
            issues.push(`Род по словарю — ${GENDER_RU[dict.gender]}, в карточке — ${GENDER_RU[w.gender] || 'не указан'}.`);
            fix.gender = dict.gender;
        }
        const wrongForms = {};
        for (const [k, v] of Object.entries(dict.forms || {})) {
            const mine = str(w.forms[k], 60).toLowerCase();
            // Ошибка — только если такого варианта в словаре нет вовсе.
            const ok = [String(v).toLowerCase(), ...(dict.allowedForms?.[k] || [])];
            if (v && mine && !ok.includes(mine)) wrongForms[k] = v;
        }
        if (Object.keys(wrongForms).length) {
            issues.push(`Формы по словарю: ${Object.entries(wrongForms).map(([k, v]) => `${FORM_RU[k] || k} — ${v}`).join(', ')}.`);
            fix.forms = wrongForms;   // только исправленные; клиент сливает с остальными
        }
    }

    return {
        ok: issues.length === 0,
        issues,
        fix,
        checkedBy: { ai: answer ? answer.model : '', dictionary: Boolean(dict) },
    };
}

const router = express.Router();
const limiter = rateLimit({ windowMs: 60 * 1000, max: 20 });

router.post('/api/word/check', limiter, async (req, res) => {
    const w = req.body?.word;
    if (!w || typeof w !== 'object' || !str(w.original, 100)) {
        return res.status(400).json({ error: 'word: карточка с полем original' });
    }
    try {
        res.json(await checkWord(w));
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

module.exports = { router, deps, checkWord, queryOf };
