// Интервальное повторение: SM-2, нормализация слов, выбор слов на сессию.
// Модуль без DOM — тестируется напрямую.
import { DAY_MS, sanitizeTags, shuffle } from './util.js';
import { POS, GENDERS, formsFor } from './norsk.js';

// Через сколько повторить «Снова».
export const AGAIN_DELAY_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// SM-2 (как в Anki). quality: 0 — снова, 1 — сложно, 2 — хорошо, 3 — легко.
// ---------------------------------------------------------------------------
export function levelFromInterval(days) {
    if (days >= 21) return 5;
    if (days >= 10) return 4;
    if (days >= 6) return 3;
    if (days >= 3) return 2;
    return 1;
}

export function sm2(word, quality, now = Date.now()) {
    if (!word.sm2Interval) word.sm2Interval = 1;
    if (!word.sm2EF) word.sm2EF = 2.5;
    if (!word.sm2Reps) word.sm2Reps = 0;

    if (quality === 0) {
        // Забытое слово становится «тяжелее»: дальше его интервалы растут
        // медленнее. Раньше EF при «Снова» не менялся, и слово, забытое пять
        // раз, росло так же быстро, как ни разу не забытое. Как в Anki: −0,2.
        word.sm2EF = Math.max(1.3, word.sm2EF - 0.2);
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

        word.sm2Reps++;
        word.forgetStep = 0;
        word.nextReview = now + word.sm2Interval * DAY_MS;
        word.level = levelFromInterval(word.sm2Interval);
    }

    if (!Array.isArray(word.history)) word.history = [];
    word.history.push({ ts: now, q: quality, ef: Math.round(word.sm2EF * 100) / 100 });
    if (word.history.length > 30) word.history = word.history.slice(-30);
    return word;
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

// Трудное слово: низкий EF или последний ответ — «Снова».
export function isHard(word) {
    if (isNew(word)) return false;
    const last = word.history?.[word.history.length - 1];
    return (word.sm2EF || 2.5) < 2.2 || last?.q === 0 || (word.forgetStep || 0) > 0;
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
// Возвращает { reviews, fresh, queue }: queue — перемешанные повторения,
// после них новые слова в порядке добавления.
export function selectSession(words, { now = Date.now(), newLimit = 15, introducedToday = 0, ignoreLimit = false } = {}) {
    const reviews = words.filter(w => !isNew(w) && isDue(w, now));
    const allNew = words
        .filter(w => isNew(w))
        .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0) || a.id - b.id);
    const room = ignoreLimit ? allNew.length : Math.max(0, newLimit - introducedToday);
    const fresh = allNew.slice(0, room);
    return { reviews, fresh, queue: [...shuffle(reviews), ...fresh] };
}
