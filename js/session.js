// Состояние тренировки и общие помощники. Режимы (mode-*.js) и ядро
// (training.js) работают с одним объектом `t`.
import { state, recordAnswer } from './store.js';
import { toDayKey } from './util.js';
import { $ } from './ui.js';

// Режимы одной карточной сессии — между ними переключает кнопка режима.
// Оценка в них идёт по SM-2 и двигает расписание.
export const CARD_MODES = ['cards', 'write-no-ru', 'write-ru-no', 'dictation'];
// Выбор варианта: «угадай из 4» (двигает SM-2), «угадай род» и «понимание
// на слух» (упражнения).
export const CHOICE_MODES = ['quiz', 'gender', 'listen'];
// Упражнения с вводом: формы слова и пропуск в предложении. Расписание не трогают.
export const DRILL_MODES = ['forms', 'cloze'];
// Режимы с полем ввода.
export const WRITE_MODES = ['write-no-ru', 'write-ru-no', 'dictation', ...DRILL_MODES];
// Режимы, где элемент очереди — вопрос { word, … }, а не само слово.
export const ITEM_MODES = [...DRILL_MODES, 'order'];
// Режимы, которые всегда практика: расписание не трогают.
export const EXERCISE_MODES = [...DRILL_MODES, 'gender', 'listen', 'order'];

export const MODE_LABEL = {
    'cards': '🎴 Карточки',
    'write-no-ru': '✍️ Письмо: NO → RU',
    'write-ru-no': '✍️ Письмо: RU → NO',
    'dictation': '🎧 Диктант',
    'quiz': '🎯 Угадай из 4',
    'gender': '🏷 Угадай род: en / ei / et',
    'forms': '🔤 Формы слов',
    'cloze': '🧩 Пропуск в предложении',
    'listen': '👂 Понимание на слух',
    'order': '🧱 Собери предложение',
};
export const SOURCE_LABEL = {
    due: '',
    marathon: '🏃 Марафон — без лимита новых слов',
    practice: '🧘 Практика — расписание не меняется',
    hard: '⚠️ Трудные слова · практика — расписание не меняется',
};

export const t = {
    active: false,
    mode: 'cards',
    source: 'due',
    // Практика: всё, кроме основной тренировки и марафона. Доступна всегда,
    // но SM-2 не трогает — иначе обходила бы дневной лимит и сбивала интервалы.
    practice: false,
    queue: [],        // слова (или вопросы для упражнений) в порядке показа
    current: null,
    flipped: false,
    noFront: true,    // на лицевой стороне карточки норвежское слово
    checked: null,    // результат проверки ввода: correct | letters | wrong | null
    answered: false,  // в режимах выбора ответ уже дан
    busy: false,
    correct: 0,
    wrong: 0,
    mistakes: new Map(),
    startedAt: 0,
    undo: [],
    options: [],
    autoNext: null,
};

// Ввод без оценки по SM-2: упражнения, а также письмо и диктант в практике.
// После проверки — просто «Дальше», без кнопок «Не помню / Помню»,
// которые в практике ничего бы не значили.
export function checksWithoutGrades() {
    return DRILL_MODES.includes(t.mode) || (t.practice && WRITE_MODES.includes(t.mode));
}

// В упражнениях с вопросами элемент очереди — { word, … }, в остальных — само слово.
export function word() {
    return ITEM_MODES.includes(t.mode) ? t.current?.word : t.current;
}

export function show(id, visible) {
    const el = $(id);
    if (el) el.hidden = !visible;
}

// Возвращает элемент в очередь через несколько карточек, чтобы он успел «остыть».
export function requeue(item) {
    t.queue.shift();
    const pos = Math.min(t.queue.length, 3 + Math.floor(Math.random() * 3));
    t.queue.splice(pos, 0, item);
}

export function tally(correct, w) {
    if (correct) t.correct++;
    else {
        t.wrong++;
        t.mistakes.set(w.id, (t.mistakes.get(w.id) || 0) + 1);
    }
    recordAnswer();
}

// Снимок для «← Отменить ответ»: очередь, счётчики и состояние SM-2 слова.
export function snapshot() {
    const w = word();
    return {
        queue: [...t.queue],
        correct: t.correct,
        wrong: t.wrong,
        mistakes: new Map(t.mistakes),
        activity: state.activity[toDayKey()] || 0,
        word: w && {
            id: w.id, level: w.level, nextReview: w.nextReview, forgetStep: w.forgetStep,
            sm2EF: w.sm2EF, sm2Interval: w.sm2Interval, sm2Reps: w.sm2Reps,
            history: [...(w.history || [])],
        },
    };
}

export function restore(s) {
    t.queue = s.queue;
    t.correct = s.correct;
    t.wrong = s.wrong;
    t.mistakes = s.mistakes;
    state.activity[toDayKey()] = s.activity;
    if (s.word) {
        const w = state.words.find(x => x.id === s.word.id);
        if (w) {
            const { id, ...rest } = s.word;
            Object.assign(w, rest);
        }
    }
}
