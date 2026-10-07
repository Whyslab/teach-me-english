// Интервальное повторение: SM-2, нормализация слов, выбор слов на сессию.
// Модуль без DOM — тестируется напрямую.
import { DAY_MS, sanitizeTags, shuffle, toDayKey } from './util.js';
import { POS, GENDERS, formsFor } from './norsk.js';

// Через сколько повторить «Не помню».
export const AGAIN_DELAY_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// SM-2 (как в Anki). quality: 0 — «не помню», 2 — «помню».
// 1 — «помню, но с ошибкой» (в письме забыл æ ø å), кнопки для него нет.
// 3 — «легко»: кнопки больше нет, но значение осталось в старой истории.
// ---------------------------------------------------------------------------
export function levelFromInterval(days) {
    if (days >= 21) return 5;
    if (days >= 10) return 4;
    if (days >= 6) return 3;
    if (days >= 3) return 2;
    return 1;
}

// Ответ на слово уже был сегодня. Тогда это повтор внутри тренировки:
// слово доучивается, но расписание не двигается.
export function answeredOnDay(word, now = Date.now()) {
    const last = word.history?.[word.history.length - 1];
    return Boolean(last) && toDayKey(last.ts) === toDayKey(now);
}

// Разброс интервала, чтобы слова, выученные в один день, не приходили потом
// одной пачкой (как в Anki). До 3 дней — без разброса, дальше ±10 %, минимум ±1.
export function fuzzInterval(days, random = Math.random) {
    if (days < 3) return days;
    const spread = Math.max(1, Math.round(days * 0.1));
    return Math.max(1, days + Math.round((random() * 2 - 1) * spread));
}

export function sm2(word, quality, now = Date.now(), random = Math.random) {
    if (!word.sm2Interval) word.sm2Interval = 1;
    if (!word.sm2EF) word.sm2EF = 2.5;
    if (!word.sm2Reps) word.sm2Reps = 0;

    // В расписание идёт только первый ответ за день. Раньше каждый повтор
    // в тренировке считался отдельным днём: «не помню» и через 10 секунд
    // «помню» отправляли слово сразу на 6 дней, а шесть «не помню» подряд
    // за две минуты роняли EF до минимума.
    if (answeredOnDay(word, now)) {
        if (quality === 0) {
            word.nextReview = now + AGAIN_DELAY_MS;
        } else if (word.sm2Reps === 0) {
            // Вспомнил после ошибки — слово доучено сегодня, проверка завтра.
            // Это единственный повтор, который меняет состояние, поэтому он
            // пишется в историю (с пометкой r) — иначе пересчёт по истории
            // его бы не увидел.
            word.sm2Reps = 1;
            word.sm2Interval = 1;
            word.level = levelFromInterval(1);
            word.nextReview = now + DAY_MS;
            pushHistory(word, { ts: now, q: quality, ef: Math.round(word.sm2EF * 100) / 100, r: 1 });
        } else {
            word.nextReview = now + word.sm2Interval * DAY_MS;
        }
        return word;
    }

    if (quality === 0) {
        // Забытое слово становится «тяжелее»: дальше его интервалы растут
        // медленнее. Как в Anki: −0,2. Новое слово при первом показе не
        // штрафуется — не знать его нормально.
        if (!isNew(word)) word.sm2EF = Math.max(1.3, word.sm2EF - 0.2);
        word.sm2Reps = 0;
        word.sm2Interval = 1;
        word.level = Math.max(0, (word.level || 0) - 1);
        word.nextReview = now + AGAIN_DELAY_MS;
        word.forgetStep = (word.forgetStep || 0) + 1;
    } else {
        const q = quality;
        word.sm2EF = Math.max(1.3, word.sm2EF + (0.1 - (3 - q) * (0.08 + (3 - q) * 0.02)));

        if (word.sm2Reps === 0) word.sm2Interval = 1;
        else if (word.sm2Reps === 1) word.sm2Interval = 6;
        else word.sm2Interval = Math.round(word.sm2Interval * word.sm2EF);

        if (quality === 1) word.sm2Interval = Math.max(1, Math.round(word.sm2Interval * 0.5));
        if (quality === 3) word.sm2Interval = Math.round(word.sm2Interval * 1.3);
        word.sm2Interval = fuzzInterval(word.sm2Interval, random);

        word.sm2Reps++;
        word.forgetStep = 0;
        word.nextReview = now + word.sm2Interval * DAY_MS;
        word.level = levelFromInterval(word.sm2Interval);
    }

    pushHistory(word, { ts: now, q: quality, ef: Math.round(word.sm2EF * 100) / 100 });
    return word;
}

function pushHistory(word, entry) {
    if (!Array.isArray(word.history)) word.history = [];
    word.history.push(entry);
    if (word.history.length > 30) word.history = word.history.slice(-30);
}

// Последний ответ, который двигал расписание (не повтор в тот же день).
export function lastReview(word) {
    const h = word.history || [];
    for (let i = h.length - 1; i >= 0; i--) if (!h[i].r) return h[i];
    return undefined;
}

// Пересчёт расписания слова по его истории — по нынешним правилам: из ответов
// за один день в расписание идёт первый, остальные — повторы. mapQuality
// переводит старые оценки в нынешние (например, «Сложно» → «не помню»).
// Разброс интервала при пересчёте не нужен — история уже прошла.
export function replayHistory(word, mapQuality = (q) => q) {
    const out = {
        ...word, level: 0, nextReview: 0, forgetStep: 0,
        sm2EF: 2.5, sm2Interval: 1, sm2Reps: 0, history: [],
    };
    const entries = [...(word.history || [])].sort((a, b) => a.ts - b.ts);
    for (const h of entries) sm2(out, mapQuality(h.q), h.ts, () => 0.5);
    return out;
}

// ---------------------------------------------------------------------------
// Нормализация
//
// Приводит слово к форме, которую ждут интерфейс и сервер. Заодно выбрасывает
// поля старой английской версии — видеофрагменты и фото (фото лежали в base64
// и раздували localStorage).
// ---------------------------------------------------------------------------
function normalizeForms(pos, forms) {
    const out = {};
    if (!forms || typeof forms !== 'object') return out;
    for (const [key] of formsFor(pos)) {
        const v = String(forms[key] ?? '').trim().slice(0, 60);
        if (v) out[key] = v;
    }
    return out;
}

export function normalizeWord(word) {
    const id = Number(word.id);
    const pos = POS[word.pos] ? word.pos : '';
    return {
        id: Number.isFinite(id) ? id : Date.now() + Math.random(),
        original: String(word.original ?? '').trim().slice(0, 100),
        translate: String(word.translate ?? '').trim().slice(0, 500),
        example: String(word.example || ''),
        exampleTranslate: String(word.exampleTranslate || ''),
        level: Math.min(5, Math.max(0, Number(word.level) || 0)),
        nextReview: Number(word.nextReview) || 0,
        forgetStep: Number(word.forgetStep) || 0,
        tags: sanitizeTags(word.tags || []),
        sm2EF: Number(word.sm2EF) || 2.5,
        sm2Interval: Number(word.sm2Interval) || 1,
        sm2Reps: Number(word.sm2Reps) || 0,
        history: Array.isArray(word.history) ? word.history.slice(-30) : [],
        addedAt: Number(word.addedAt) || 0,
        pos,
        gender: pos === 'noun' && GENDERS[word.gender] ? word.gender : '',
        forms: normalizeForms(pos, word.forms),
    };
}

// ---------------------------------------------------------------------------
// Выбор слов на сессию
// ---------------------------------------------------------------------------

// Новое слово — ни разу не отвеченное.
export function isNew(word) {
    return !(word.history && word.history.length) && !word.sm2Reps;
}

export function isDue(word, now = Date.now()) {
    return !word.nextReview || word.nextReview <= now;
}

// Трудное слово: низкий EF или последний ответ — «Не помню».
export function isHard(word) {
    if (isNew(word)) return false;
    return (word.sm2EF || 2.5) < 2.2 || lastReview(word)?.q === 0 || (word.forgetStep || 0) > 0;
}

// Слова для практики (письмо, диктант, «угадай», трудные — всё, кроме основной
// тренировки). Практика доступна всегда и расписание не трогает, поэтому
// берёт любые слова: сначала те, что пора повторять, потом самые трудные
// (низкий EF), потом остальные. Новые — только если изученных мало.
export function practiceQueue(words, { now = Date.now(), size = 20, only = null } = {}) {
    let pool = only ? words.filter(only) : words;
    const studied = pool.filter(w => !isNew(w));
    if (!only && studied.length >= Math.min(size, 4)) pool = studied;
    const rank = (w) => (isDue(w, now) ? 0 : 1);
    return shuffle(pool)
        .sort((a, b) => rank(a) - rank(b) || (a.sm2EF || 2.5) - (b.sm2EF || 2.5))
        .slice(0, size);
}

// Слова для обычной тренировки. Повторения — все просроченные; новые —
// не больше дневного лимита (как в Anki). Без лимита импорт колоды A1 из
// 300 слов через неделю превращался бы в завал из сотен повторений в день.
//
// Защита от завала: если повторений накопилось pauseNewAt и больше, новые
// слова не даются вовсе, пока долг не уменьшится (0 — без паузы). Каждое
// новое слово в ближайшие дни вернётся ещё несколько раз, так что новые
// поверх большого долга только раздувают его.
//
// Возвращает { reviews, fresh, queue, paused }: queue — перемешанные
// повторения, после них новые слова в порядке добавления.
export function selectSession(words, { now = Date.now(), newLimit = 15, introducedToday = 0, ignoreLimit = false, pauseNewAt = 0 } = {}) {
    const reviews = words.filter(w => !isNew(w) && isDue(w, now));
    const allNew = words
        .filter(w => isNew(w))
        .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0) || a.id - b.id);
    const paused = !ignoreLimit && pauseNewAt > 0 && reviews.length >= pauseNewAt;
    const room = ignoreLimit ? allNew.length : paused ? 0 : Math.max(0, newLimit - introducedToday);
    const fresh = allNew.slice(0, room);
    return { reviews, fresh, queue: [...shuffle(reviews), ...fresh], paused };
}
