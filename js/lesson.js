// Урок — одна кнопка «Продолжить», как в Duolingo. Тренажёр сам берёт слова
// по расписанию и сам выбирает задание для каждого: чем увереннее слово
// выучено, тем труднее задание. Модуль без DOM — тестируется напрямую.
//
// Элемент урока — { mode, word, primary, … }:
//   primary — первое задание слова за урок, оно двигает расписание SM-2;
//   остальные (знакомство, закрепление, повтор после ошибки) — практика.
import { shuffle } from './util.js';
import { GENDERS, formsFor, makeCloze, orderTokens, sameOrder } from './norsk.js';
import { isNew } from './srs.js';

// Сколько «очков» слов берёт урок: повторение — 1, новое слово — 2
// (знакомство + задание). Вместе с закреплениями выходит 10–15 заданий, 3–5 минут.
export const LESSON_BUDGET = 8;
// Больше заданий в уроке не бывает — закрепления сверх этого не добавляются.
export const LESSON_MAX = 15;

// Лёгкие задания: выбрать из вариантов. В расписании весят меньше (sm2 easy).
export const EASY_MODES = ['quiz'];

// Сколько последних ответов подряд верные. По этой серии, а не по уровню,
// выбирается трудность: уровень 3 — это интервал от 6 дней, до него недели,
// и первые уроки состояли бы из одного узнавания.
export function streak(word) {
    const h = word.history || [];
    let n = 0;
    for (let i = h.length - 1; i >= 0 && h[i].q > 0; i--) n++;
    return n;
}

// Хватает ли разных переводов, чтобы дать 4 варианта.
export function canQuiz(words) {
    return new Set(words.map(w => w.translate)).size >= 4;
}

const pick = (arr, random) => arr[Math.floor(random() * arr.length)];

// Основное задание слова — двигает расписание.
//   новое и серия 0–1 — узнать (выбор из 4);
//   серия 2           — вспомнить перевод (карточка или письмо NO → RU);
//   серия 3 и больше  — вспомнить и написать по-норвежски (письмо RU → NO, диктант).
export function primaryMode(word, { quizOk = true, random = Math.random } = {}) {
    const s = isNew(word) ? 0 : streak(word);
    if (s <= 1) return quizOk ? 'quiz' : 'cards';
    if (s === 2) return pick(['cards', 'write-no-ru'], random);
    return pick(['write-ru-no', 'dictation'], random);
}

// Задание «Собери предложение» для слова или null, если пример не подходит.
export function orderItem(word) {
    if (!word.example) return null;
    const answer = orderTokens(word.example);
    if (answer.length < 3 || answer.length > 9) return null;
    let pool = shuffle(answer);
    for (let i = 0; i < 5 && sameOrder(pool, answer); i++) pool = shuffle(answer);
    if (sameOrder(pool, answer)) return null;
    return { mode: 'order', word, answer, pool, picked: [] };
}

function formsItem(word, random) {
    const keys = formsFor(word.pos).filter(([k]) => word.forms?.[k]);
    if (!keys.length) return null;
    const [key, no, ru] = pick(keys, random);
    return { mode: 'forms', word, key, no, ru, expected: word.forms[key] };
}

function clozeItem(word) {
    const cloze = makeCloze(word);
    return cloze ? { mode: 'cloze', word, ...cloze, expected: cloze.answer } : null;
}

// Закрепление после верного основного ответа: то же слово, но задание
// труднее — так сложность растёт и внутри одного урока. Грамматика (род,
// формы) — только для слов, которые уже узнаются. Если у слова нет примера
// или форм, берётся то, что есть; нечего дать — null.
export function followUp(item, { random = Math.random } = {}) {
    const w = item.word;
    if (item.mode === 'quiz') return { mode: 'write-no-ru', word: w };
    const options = [];
    if (item.mode === 'cards' || item.mode === 'write-no-ru') options.push(() => ({ mode: 'write-ru-no', word: w }));
    if (w.pos === 'noun' && GENDERS[w.gender]) options.push(() => ({ mode: 'gender', word: w }));
    options.push(() => clozeItem(w), () => orderItem(w), () => formsItem(w, random));
    for (const make of shuffle(options)) {
        const it = make();
        if (it) return it;
    }
    return null;
}

// Повтор после ошибки — задание полегче. Для основного задания флаг
// primary остаётся: второй ответ за день расписание почти не двигает
// (см. sm2), но «вспомнил после ошибки» доучивает новое слово.
export function retryItem(item, { quizOk = true } = {}) {
    if (!item.primary) return { ...item, retry: true };
    const mode = item.mode !== 'quiz' && quizOk ? 'quiz' : item.mode;
    return { mode, word: item.word, primary: true, retry: true };
}

// Собирает урок из слов сессии (повторения, потом новые — как selectSession).
// Новое слово: знакомство, через одно задание — выбор из 4.
// Возвращает { items, words } — words: сколько слов вошло.
export function buildLesson(sessionWords, allWords, { random = Math.random, budget = LESSON_BUDGET } = {}) {
    const quizOk = canQuiz(allWords);
    const items = [];
    const pending = [];   // основные задания новых слов — после следующего элемента
    let used = 0, count = 0;
    for (const w of sessionWords) {
        const cost = isNew(w) ? 2 : 1;
        if (used + cost > budget && count > 0) break;
        used += cost;
        count++;
        if (pending.length) items.push(pending.shift());
        if (isNew(w)) {
            items.push({ mode: 'intro', word: w });
            pending.push({ mode: quizOk ? 'quiz' : 'cards', word: w, primary: true });
        } else {
            items.push({ mode: primaryMode(w, { quizOk, random }), word: w, primary: true });
        }
    }
    items.push(...pending);
    return { items: spreadModes(items), words: count };
}

// Два одинаковых задания подряд скучно — разводим. Каждый раз берётся
// первое оставшееся задание другого режима (порядок в целом сохраняется:
// повторения раньше новых). Задание нового слова — только после его знакомства.
export function spreadModes(items) {
    const rest = [...items];
    const out = [];
    const ready = (it) => !(it.primary && rest.some(x => x.mode === 'intro' && x.word === it.word));
    while (rest.length) {
        const last = out[out.length - 1]?.mode;
        let i = rest.findIndex(it => ready(it) && it.mode !== last);
        if (i < 0) i = rest.findIndex(ready);
        const [it] = rest.splice(i, 1);
        out.push(it);
    }
    return out;
}
