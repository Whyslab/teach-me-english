// ИИ через OpenAI-совместимый шлюз (FreeLLMAPI на этом же сервере):
// перевод слова с примером и чтение скриншота со словами.
//
// Зачем: машинный переводчик (MyMemory) на пары норвежский → русский часто
// ошибался («å bo» — «житель», «uttale» — «заявление»), а tesseract читал
// русский текст скриншота норвежской моделью и выдавал мусор вроде
// «Ha kakuXx A3blKaX». Модель видит контекст и картинку целиком.
//
// Всё необязательное: нет ключа или шлюз не ответил — вызывающий код
// откатывается на словарь, переводчик и tesseract, как раньше.
const fs = require('fs');
const os = require('os');
const path = require('path');

const list = (v, def) => (v || def).split(',').map(s => s.trim()).filter(Boolean);

const config = {
    url: (process.env.LLM_URL || 'http://127.0.0.1:3001').replace(/\/+$/, ''),
    keyFile: process.env.LLM_KEY_FILE || path.join(os.homedir(), '.config/opencode/freellmapi.key'),
    // Проверено 18.11.2026 на словах пользователя: deepseek-v4-flash и
    // mistral-medium-3.5 дают точные переводы и простые примеры; модели
    // «с размышлением» (qwen3.8-flash) печатают рассуждения вместо JSON.
    textModels: list(process.env.LLM_TEXT_MODELS, 'deepseek-v4-flash,mistral-medium-3.5,gpt-oss-120b,llama-3.3-70b'),
    // mistral-medium-3.5 прочитал скриншоты Lingu и смешанные русско-норвежские
    // за 2 с; у Gemini бывает исчерпан дневной лимит — они запасные.
    visionModels: list(process.env.LLM_VISION_MODELS, 'mistral-medium-3.5,gemini-3.6-flash,gemini-3.5-flash,gemini-3-flash-preview,gemini-2.5-flash,qwen2.5-vl-72b'),
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 25000,
    // Общий срок на все модели по очереди: дольше пользователь ждать не станет.
    budgetMs: Number(process.env.LLM_BUDGET_MS) || 45000,
};

function readKey() {
    // Тесты выключают ИИ: на сервере ключ лежит по умолчанию, и тест
    // ходил бы в настоящий шлюз.
    if (process.env.LLM_DISABLED === '1') return '';
    try { return fs.readFileSync(config.keyFile, 'utf8').trim(); } catch { return ''; }
}

function available() { return Boolean(readKey()); }

// Ответ модели → объект. Модели любят обернуть JSON в ```json … ``` или
// дописать фразу до/после — берём от первой { до последней }.
function extractJson(text) {
    const s = String(text || '');
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('в ответе нет JSON');
    return JSON.parse(s.slice(a, b + 1));
}

// Подменяется в тестах.
const deps = { fetch: (...args) => fetch(...args) };

// Спрашивает модели по очереди, пока одна не вернёт разбираемый JSON,
// прошедший check. Возвращает { data, model } или бросает последнюю ошибку.
async function ask(models, content, check, { maxTokens = 2500 } = {}) {
    const key = readKey();
    if (!key) throw new Error('ИИ не настроен');
    const deadline = Date.now() + config.budgetMs;
    let lastErr = new Error('нет моделей');
    for (const model of models) {
        const left = deadline - Date.now();
        if (left < 3000) break;
        try {
            const res = await deps.fetch(`${config.url}/v1/chat/completions`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, temperature: 0.1, max_tokens: maxTokens, messages: [{ role: 'user', content }] }),
                signal: AbortSignal.timeout(Math.min(config.timeoutMs, left)),
            });
            if (!res.ok) throw new Error(`${model}: HTTP ${res.status}`);
            const body = await res.json();
            const data = extractJson(body?.choices?.[0]?.message?.content);
            if (!check(data)) throw new Error(`${model}: ответ не по форме`);
            return { data, model: res.headers?.get?.('x-routed-via') || model };
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr;
}

const str = (v, max) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');

// Пункт ответа модели → поля слова. Кавычки вокруг примеров убираем: в
// карточках Lingu пример взят в кавычки, и модель иногда их переносит.
function cleanItem(it) {
    const unquote = (s) => s.replace(/^["“”„«'’‘]+|["“”»'’‘]+$/g, '').trim();
    return {
        word: str(it?.word, 100),
        translate: str(it?.translate, 200),
        example: unquote(str(it?.example, 300)),
        exampleTranslate: unquote(str(it?.exampleTranslate, 300)),
    };
}

const itemsOk = (d) => Array.isArray(d?.items) && d.items.every(it => it && typeof it === 'object');

const WORDS_PROMPT = `Ты — словарь норвежского (букмол) для русскоязычного ученика уровня A1–A2.
Для каждого слова или выражения из списка дай:
- translate — точный короткий перевод на русский: 1–3 самых частых значения через запятую, главное первым. Глагол — инфинитивом («жить», а не «чтобы жить»), прилагательное — в мужском роде, существительное — в именительном падеже, без «один/одна».
- example — короткое простое предложение (4–8 слов) с этим словом, как в учебнике A1.
- exampleTranslate — перевод примера на русский.
Если слово написано с ошибкой — переводи то, что имелось в виду.
Ответь только JSON без пояснений: {"items":[{"word":"…","translate":"…","example":"…","exampleTranslate":"…"}]}
Слова: `;

// Перевод и пример для нескольких слов одним запросом.
// words — массив строк; ответ — { model, items }, items той же длины, что
// words (пустые поля, если модель слово пропустила).
async function describeWords(words) {
    const clean = words.map(w => str(w, 100)).filter(Boolean);
    if (!clean.length) return { model: '', items: [] };
    const { data, model } = await ask(config.textModels, WORDS_PROMPT + JSON.stringify(clean),
        (d) => itemsOk(d) && d.items.length > 0, { maxTokens: 300 + 160 * clean.length });
    const items = data.items.map(cleanItem);
    // Модель может переставить слова, пропустить или убрать артикль
    // («en uttale» → «uttale»). Сопоставляем по слову без артикля; по порядку —
    // только пункт без слова. Иначе карточка получила бы чужой перевод.
    const norm = (s) => s.toLowerCase().replace(/^(en|ei|et|å)\s+/, '').replace(/[!?.,]+$/, '').trim();
    return {
        model,
        items: clean.map((w, i) => items.find(it => it.word && norm(it.word) === norm(w))
            || (items[i] && !items[i].word ? { ...items[i], word: w } : null)
            || { word: w, translate: '', example: '', exampleTranslate: '' }),
    };
}

const SHOT_PROMPT = `На картинке — скриншот из приложения или учебника норвежского языка (букмол).
Найди норвежские слова и выражения, которые ученик учит на этом экране (обычно выделены цветом или жирным; заголовки разделов вроде «Substantiv», «Verb», номера уроков, кнопки и меню — не слова). Если на экране целые предложения без выделенных слов — возьми из них полезные слова.
Для каждого:
- word — как написано на скриншоте, с en/ei/et или å, если они есть;
- translate — русский перевод: возьми со скриншота, если он там есть, иначе дай сам (1–3 коротких значения);
- example — норвежское предложение-пример со скриншота, если есть, иначе пустая строка;
- exampleTranslate — русский перевод примера (со скриншота или свой).
Не выдумывай слов, которых нет на картинке. Не больше 25 слов.
Ответь только JSON без пояснений: {"items":[{"word":"","translate":"","example":"","exampleTranslate":""}]}`;

// Скриншот → карточки { word, translate, example, exampleTranslate }.
async function readScreenshot(image, mime) {
    const url = `data:${mime || 'image/png'};base64,${Buffer.from(image).toString('base64')}`;
    const { data, model } = await ask(config.visionModels, [
        { type: 'text', text: SHOT_PROMPT },
        { type: 'image_url', image_url: { url } },
    ], itemsOk, { maxTokens: 4000 });
    const items = data.items.map(cleanItem).filter(it => it.word && /\p{L}/u.test(it.word)).slice(0, 25);
    return { model, items };
}

module.exports = { config, deps, available, ask, extractJson, describeWords, readScreenshot, cleanItem };
