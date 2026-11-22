// Тренировка: ядро. Запуск и остановка, показ вопроса, ответы, отмена,
// клавиатура. Сами режимы — в mode-card.js, mode-choice.js, mode-drill.js;
// состояние — в session.js.
import { state, saveWords, saveSettings, introducedToday } from './store.js';
import { sm2, selectSession, practiceQueue, isHard } from './srs.js';
import { displayWord, checkAnswer, grammarHint, GENDERS } from './norsk.js';
import { $, showToast, playSound, speak, stopSpeech, prefetchSpeech } from './ui.js';
import {
    t, word, show, requeue, tally, snapshot, restore, checksWithoutGrades, scheduled,
    CARD_MODES, CHOICE_MODES, DRILL_MODES, WRITE_MODES, ITEM_MODES, EXERCISE_MODES, MODE_LABEL, SOURCE_LABEL,
} from './session.js';
import { renderCard, renderIntro, renderLinks } from './mode-card.js';
import { buildLesson, followUp, canQuiz, LESSON_MAX, EASY_MODES } from './lesson.js';
import { genderQueue, renderQuiz, renderGender, evaluateChoice } from './mode-choice.js';
import { formsQueue, clozeQueue, renderForms, renderCloze, revealCloze } from './mode-drill.js';
import { showResults } from './results.js';
import {
    listenAvailable, listenQueue, renderListen, revealListen,
    orderQueue, renderOrder, pickToken, unpickToken, orderComplete, orderCorrect,
} from './mode-sentence.js';

// Режимы, где звучит и показывается пример, а не само слово.
const SENTENCE_MODES = ['cloze', 'listen', 'order'];

let onFinish = () => {};
export function onTrainingFinished(fn) { onFinish = fn; }

export const isTraining = () => t.active;

// ---------------------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------------------
const EMPTY_MESSAGE = {
    gender: 'Нет существительных с указанным родом. Укажи en/ei/et при добавлении слова или загрузи колоду A1.',
    forms: 'Нет слов с формами. Заполни формы при добавлении (⚡ формы по правилу) или загрузи колоду A1.',
    cloze: 'Нет слов с примерами, в которых встречается само слово. Добавь пример или загрузи колоду A1.',
    listen: 'Нужны хотя бы 4 слова с примером и его переводом. Загрузи колоду A1 или добавь примеры.',
    order: 'Нет примеров длиной 3–10 слов. Загрузи колоду A1 или добавь примеры.',
    hard: 'Трудных слов нет 🎉',
    practice: 'Словарь пуст — добавь слова или загрузи колоду A1.',
    due: 'На сегодня всё повторено. Новые слова откроются завтра — а «Другие режимы» доступны всегда.',
};

// Основная тренировка (source due/marathon) — по расписанию и с лимитом новых
// слов. Всё остальное — практика: доступна всегда, SM-2 не трогает.
function buildQueue(mode, source) {
    if (source === 'lesson') return buildLesson(sessionWords(), state.words).items;
    if (mode === 'gender') return genderQueue();
    if (mode === 'forms') return formsQueue();
    if (mode === 'cloze') return clozeQueue();
    if (mode === 'listen') return listenAvailable() ? listenQueue() : [];
    if (mode === 'order') return orderQueue();
    if (source === 'hard') return practiceQueue(state.words, { only: isHard });
    if (source === 'practice') return practiceQueue(state.words);
    return sessionWords({ ignoreLimit: source === 'marathon' });
}

function sessionWords({ ignoreLimit = false } = {}) {
    return selectSession(state.words, {
        newLimit: state.settings.newPerDay,
        introducedToday: introducedToday(),
        pauseNewAt: state.settings.pauseNewAt,
        ignoreLimit,
    }).queue;
}

export function startTraining({ mode = 'cards', source = 'due' } = {}) {
    if (mode === 'quiz' && state.words.length < 4) {
        showToast('Для «Угадай из 4» нужно хотя бы 4 слова в словаре.', 'info');
        return;
    }
    const lesson = source === 'lesson';
    const practice = !lesson && (!(source === 'due' || source === 'marathon') || EXERCISE_MODES.includes(mode));
    if (practice && source === 'due') source = 'practice';
    const queue = buildQueue(mode, source);
    if (queue.length === 0) {
        showToast(EMPTY_MESSAGE[mode] || EMPTY_MESSAGE[source] || EMPTY_MESSAGE.due, 'info', 6000);
        return;
    }

    clearTimeout(t.autoNext);
    Object.assign(t, {
        active: true, mode, source, practice, lesson, quizOk: canQuiz(state.words), queue, current: null,
        correct: 0, wrong: 0, mistakes: new Map(), startedAt: Date.now(), undo: [],
    });
    document.body.classList.add('training-mode');
    $('training-section').classList.toggle('practice', practice);
    $('training-section').hidden = false;
    $('main-content').hidden = true;
    document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    window.scrollTo(0, 0);
    next();
}

export function stopTraining() {
    if (!t.active) return;
    t.active = false;
    // Иначе автопереход из «угадай» срабатывал уже в следующей тренировке
    // и пропускал её первый вопрос.
    clearTimeout(t.autoNext);
    stopSpeech();
    document.body.classList.remove('training-mode');
    $('training-section').hidden = true;
    $('main-content').hidden = false;
    saveWords();
    if (t.correct + t.wrong > 0) showResults();
    onFinish();
}

// ---------------------------------------------------------------------------
// Показ вопроса
// ---------------------------------------------------------------------------
function next() {
    if (t.queue.length === 0) {
        stopTraining();
        return;
    }
    t.current = t.queue[0];
    if (t.lesson) t.mode = t.current.mode;
    t.flipped = false;
    t.checked = null;
    t.answered = false;
    if (t.mode === 'order') t.current.picked = [];
    render();
    // Пока отвечаешь на этот вопрос, сервер синтезирует звук следующих.
    for (const item of t.queue.slice(0, 3)) {
        const mode = t.lesson ? item.mode : t.mode;
        const w = t.lesson || ITEM_MODES.includes(mode) ? item.word : item;
        if (!w) continue;
        prefetchSpeech(SENTENCE_MODES.includes(mode) ? w.example : displayWord(w));
    }
}

// «Почти»: верно без æ ø å или с одной опечаткой.
const almost = () => t.checked === 'letters' || t.checked === 'typo';

// Счётчики ✓ ✗ и «осталось» — сразу после ответа, а не со следующим заданием.
function renderStats() {
    $('tr-left').textContent = t.queue.length;
    $('tr-correct').textContent = t.correct;
    $('tr-wrong').textContent = t.wrong;
}

function render() {
    const w = word();
    if (!w) return;
    const isCard = CARD_MODES.includes(t.mode);
    const isWrite = WRITE_MODES.includes(t.mode);
    const isChoice = CHOICE_MODES.includes(t.mode);
    const noGrades = checksWithoutGrades();

    $('tr-mode').textContent = MODE_LABEL[t.mode];
    $('tr-mode').disabled = !isCard || t.lesson;
    $('tr-source').textContent = SOURCE_LABEL[t.source] || '';
    $('tr-source').hidden = !SOURCE_LABEL[t.source];
    renderStats();
    $('training-section').dataset.mode = t.mode;
    // Полоса: сколько из очереди уже снято верным ответом. Ошибка возвращает
    // слово в очередь — полоса на месте, как в Duolingo.
    const fill = $('tr-progress-fill');
    if (fill) fill.style.width = `${Math.round(t.queue.length ? t.correct / (t.correct + t.queue.length) * 100 : 100)}%`;

    show('flashcard-wrap', isCard);
    show('tr-prompt', !isCard);
    show('tr-write', isWrite);
    show('tr-options', isChoice);
    show('tr-grades', t.mode === 'cards' || (isWrite && !noGrades && t.checked !== null));
    show('tr-write-btns', isWrite && t.checked === null);
    show('tr-next-btn', (noGrades && t.checked !== null) || (isChoice && t.answered) || (t.mode === 'order' && t.checked !== null) || t.mode === 'intro');
    show('tr-back-btn', t.undo.length > 0);
    $('tr-feedback').textContent = '';
    $('tr-feedback').className = 'tr-feedback';
    document.querySelectorAll('#tr-grades .grade-btn.suggested').forEach(b => b.classList.remove('suggested'));

    if (isCard) renderCard(w);
    else if (t.mode === 'intro') renderIntro(w);
    else if (t.mode === 'quiz') renderQuiz(w);
    else if (t.mode === 'gender') renderGender(w);
    else if (t.mode === 'forms') renderForms();
    else if (t.mode === 'cloze') renderCloze();
    else if (t.mode === 'listen') renderListen(w);
    else if (t.mode === 'order') renderOrder();
    renderLinks(w);

    if (isWrite) {
        const input = $('tr-input');
        input.value = '';
        input.disabled = false;
        const toNorwegian = t.mode !== 'write-no-ru';
        input.lang = toNorwegian ? 'nb' : 'ru';
        input.placeholder = t.mode === 'dictation' ? 'что прозвучало? ⏎'
            : toNorwegian ? 'по-норвежски ⏎' : 'перевод ⏎';
        show('tr-letters', toNorwegian);
        setTimeout(() => input.focus(), 30);
    }

    // Диктант и «на слух» всегда начинаются со звука — это и есть вопрос.
    if (t.mode === 'dictation') setTimeout(() => speak(displayWord(w)), 150);
    else if (t.mode === 'listen') setTimeout(() => speak(w.example), 150);
    else if (t.mode === 'intro') setTimeout(() => speak(displayWord(w)), 150);
    else if (state.settings.autoSpeak && !['write-ru-no', 'gender', 'cloze', 'order'].includes(t.mode)) {
        setTimeout(() => speak(displayWord(w)), 150);
    }
}

// ---------------------------------------------------------------------------
// Ответы
// ---------------------------------------------------------------------------
function pushUndo() {
    t.undo.push(snapshot());
    if (t.undo.length > 50) t.undo.shift();
}

// quality 0..3 по SM-2. Для карточек, письма и диктанта.
export function grade(quality) {
    if (!t.active || t.busy || !CARD_MODES.includes(t.mode)) return;
    const w = word();
    if (!w) return;
    // В письме «верно, но без æ ø å» — это «помню, но с ошибкой»: и Enter,
    // и кнопка «Помню» дают одно и то же (интервал вдвое короче).
    if (quality === 2 && almost()) quality = 1;
    t.busy = true;
    pushUndo();

    if (scheduled()) {
        sm2(w, quality);
        saveWords();
    }
    tally(quality >= 2, w);
    playSound(quality >= 2 ? 'correct' : 'wrong');

    const item = t.current;
    if (quality >= 2) t.queue.shift();
    else requeue(item);
    addFollowUp(item, quality >= 2);

    $('flashcard').classList.add(quality >= 2 ? 'flash-correct' : 'flash-wrong');
    setTimeout(() => { t.busy = false; next(); }, 260);
}

export function flip() {
    if (!t.active || !CARD_MODES.includes(t.mode)) return;
    if (t.mode !== 'cards' && t.checked === null) return; // в письме сначала ответ
    t.flipped = !t.flipped;
    $('flashcard').classList.toggle('is-flipped', t.flipped);
    if (t.flipped) {
        playSound('flip');
        if (!state.settings.autoSpeak) speak(displayWord(word()));
    }
    renderLinks(word());
}

function expectedAnswer(w) {
    if (DRILL_MODES.includes(t.mode)) return t.current.expected;
    return t.mode === 'write-no-ru' ? w.translate : w.original;
}

// Проверка ввода (Enter). Второй Enter — дальше.
export function checkWritten() {
    if (!t.active) return;
    if (t.checked !== null) {
        // Оценка берётся из проверки: раньше здесь всегда нажималось «Хорошо»,
        // даже после неверного ответа.
        if (checksWithoutGrades()) return advance();
        return grade(t.checked === 'correct' ? 2 : almost() ? 1 : 0);
    }
    const w = word();
    const input = $('tr-input');
    const toNorwegian = t.mode !== 'write-no-ru';
    const expected = expectedAnswer(w);
    // Опечатку прощаем везде, кроме форм: там одна буква и есть ошибка (huset/husen).
    t.checked = checkAnswer(input.value, expected, { norwegian: toNorwegian, typos: !DRILL_MODES.includes(t.mode) });
    input.disabled = true;

    const shown = DRILL_MODES.includes(t.mode) ? expected : toNorwegian ? displayWord(w) : expected;
    const fb = $('tr-feedback');
    if (t.checked === 'correct') {
        fb.textContent = 'Верно!';
        fb.className = 'tr-feedback ok';
    } else if (t.checked === 'letters') {
        fb.textContent = `Почти — проверь æ ø å: ${shown}`;
        fb.className = 'tr-feedback almost';
    } else if (t.checked === 'typo') {
        fb.textContent = `Опечатка — правильно: ${shown}`;
        fb.className = 'tr-feedback almost';
    } else {
        fb.textContent = `Правильно: ${shown}`;
        fb.className = 'tr-feedback bad';
        if (t.mode === 'forms') grammarMistake(w, 'forms', t.current.key, input.value, expected);
    }

    if (checksWithoutGrades()) {
        pushUndo();
        if (t.lesson && scheduled()) {
            sm2(w, t.checked === 'correct' ? 2 : almost() ? 1 : 0);
            saveWords();
        }
        // В уроке «верно, но без æ ø å» засчитано и в расписание (интервал вдвое
        // короче), поэтому и здесь это верный ответ, а не повтор.
        const ok = t.checked === 'correct' || (t.lesson && almost());
        tally(ok, w);
        renderStats();
        playSound(ok ? 'correct' : 'wrong');
        const item = t.current;
        if (ok) t.queue.shift(); else requeue(item);
        addFollowUp(item, ok);
        if (t.mode === 'cloze') {
            revealCloze();
            speak(w.example);
        } else if (DRILL_MODES.includes(t.mode)) {
            speak(expected);
        } else {
            t.flipped = true;
            $('flashcard').classList.add('is-flipped');
            speak(displayWord(w));
        }
    } else {
        t.flipped = true;
        $('flashcard').classList.add('is-flipped');
        speak(displayWord(w));
        // Подсказка, какую кнопку нажмёт второй Enter.
        const suggested = t.checked === 'wrong' ? '0' : '2';
        document.querySelectorAll('#tr-grades .grade-btn').forEach(b => b.classList.toggle('suggested', b.dataset.grade === suggested));
    }
    show('tr-write-btns', false);
    show('tr-grades', !checksWithoutGrades());
    show('tr-next-btn', checksWithoutGrades());
    renderLinks(w);
}

// «Не знаю» — это «не вспомнил».
export function revealWritten() {
    if (t.checked !== null) return;
    $('tr-input').value = '';
    checkWritten();
}

function choose(index) {
    if (!t.active || t.answered || !CHOICE_MODES.includes(t.mode)) return;
    const w = word();
    const { ok, isRight, feedback } = evaluateChoice(w, index);
    t.answered = true;
    pushUndo();

    document.querySelectorAll('#tr-options .quiz-option').forEach((b, i) => {
        b.disabled = true;
        if (isRight(i)) b.classList.add('correct');
        else if (i === index && !ok) b.classList.add('wrong');
    });
    const fb = $('tr-feedback');
    fb.textContent = feedback;
    fb.className = `tr-feedback ${ok ? 'ok' : 'bad'}`;
    if (t.mode === 'gender' && !ok) {
        grammarMistake(w, 'gender', '', GENDERS[t.options[index]]?.article || '', GENDERS[w.gender]?.article || '');
    }

    if (t.mode === 'quiz' && scheduled()) {
        // «Угадай из 4» внутри основной тренировки двигает расписание, как карточки.
        // В уроке — как лёгкое задание: вдвое меньше (sm2 easy).
        sm2(w, ok ? 2 : 0, undefined, undefined, { easy: t.lesson && EASY_MODES.includes(t.mode) });
        saveWords();
    }
    tally(ok, w);
    renderStats();
    playSound(ok ? 'correct' : 'wrong');
    const item = t.current;
    if (ok) t.queue.shift(); else requeue(item);
    addFollowUp(item, ok);
    show('tr-next-btn', true);
    renderLinks(w);
    if (t.mode === 'listen') {
        // Предложение надо дослушать и прочитать — дальше только по Enter.
        revealListen();
        speak(w.example);
        return;
    }
    speak(displayWord(w));
    // Дальше — по «Дальше»/Enter, как в письменных заданиях: прежний автопереход
    // через секунду только мелькал ответом и не давал нажать «Сомневаюсь».
}

// «Собери предложение»: выбор слова, отмена, проверка.
function pick(idx) {
    if (!t.active || t.mode !== 'order' || !pickToken(idx)) return;
    renderOrder();
    if (orderComplete()) checkOrder();
}

function unpick(pos) {
    if (!t.active || t.mode !== 'order' || !unpickToken(pos)) return;
    renderOrder();
}

function checkOrder() {
    const w = word();
    const ok = orderCorrect();
    t.checked = ok ? 'correct' : 'wrong';
    pushUndo();
    tally(ok, w);
    renderStats();
    playSound(ok ? 'correct' : 'wrong');
    if (ok) t.queue.shift(); else requeue(t.current);
    renderOrder();
    const fb = $('tr-feedback');
    fb.textContent = ok ? 'Верно!' : 'Порядок другой — правильно так:';
    fb.className = `tr-feedback ${ok ? 'ok' : 'bad'}`;
    speak(w.example);
    show('tr-next-btn', true);
    renderLinks(w);
}

// Ошибка в роде или форме: правило в одну строку под ответом и запись
// на сервер — репетитор видит её в `norsk-ord --list` и знает, что объяснять.
// Без сети запись теряется: это подсказка, а не прогресс.
function grammarMistake(w, kind, key, given, expected) {
    const hint = grammarHint(w, kind, key);
    if (hint) {
        const el = document.createElement('span');
        el.className = 'tr-hint';
        el.textContent = `💡 ${hint}`;
        $('tr-feedback').appendChild(el);
    }
    fetch('/api/grammar-mistakes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: w.id, original: w.original, kind, key, given: String(given).slice(0, 60), expected: String(expected).slice(0, 60) }),
    }).catch(() => {});
}

// Закрепление в уроке: после верного основного ответа то же слово ещё раз,
// но заданием потруднее — через пару заданий.
function addFollowUp(item, ok) {
    if (!t.lesson || !ok || !item?.primary || item.retry) return;
    if (t.correct + t.wrong + t.queue.length >= LESSON_MAX) return;
    const extra = followUp(item);
    if (!extra) return;
    const pos = Math.min(t.queue.length, 2 + Math.floor(Math.random() * 2));
    t.queue.splice(pos, 0, extra);
}

function advance() {
    clearTimeout(t.autoNext);
    if (!t.active) return;
    // Знакомство с новым словом ответа не ждёт: «Дальше» просто снимает его.
    if (t.mode === 'intro' && t.queue[0] === t.current) t.queue.shift();
    next();
}

export function undoLast() {
    const s = t.undo.pop();
    if (!s) return;
    clearTimeout(t.autoNext);
    restore(s);
    saveWords();
    next();
}

function cycleMode() {
    if (!CARD_MODES.includes(t.mode) || t.lesson) return;
    t.mode = CARD_MODES[(CARD_MODES.indexOf(t.mode) + 1) % CARD_MODES.length];
    if (t.mode === 'write-no-ru' || t.mode === 'write-ru-no') {
        state.settings.spellingDir = t.mode === 'write-ru-no' ? 'ru-no' : 'no-ru';
        saveSettings({ shared: false });
    }
    t.checked = null;
    t.flipped = false;
    render();
}

function speakCurrent() {
    const w = word();
    if (!w) return;
    const sentence = t.mode === 'listen' || (SENTENCE_MODES.includes(t.mode) && t.checked !== null);
    speak(sentence ? w.example : displayWord(w));
}

// ---------------------------------------------------------------------------
// Клавиатура и свайпы
// ---------------------------------------------------------------------------
export function handleTrainingKey(e) {
    if (!t.active) return false;
    const inInput = e.target.matches?.('input, textarea');
    if (e.key === 'Escape') { stopTraining(); return true; }
    if (inInput) return false;

    const writing = WRITE_MODES.includes(t.mode) && !checksWithoutGrades();
    if ((e.code === 'Space' || e.key === 'Enter') && t.mode === 'cards') { flip(); return true; }
    // Зажатый Enter не должен пролистать знакомства, не дав прочитать слово.
    if ((e.code === 'Space' || e.key === 'Enter') && t.mode === 'intro') { if (!e.repeat) advance(); return true; }
    if (e.key === 'Enter' && CHOICE_MODES.includes(t.mode) && t.answered) { advance(); return true; }
    if (t.mode === 'order') {
        if (e.key === 'Enter' && t.checked !== null) { advance(); return true; }
        if (/^[1-9]$/.test(e.key)) { pick(Number(e.key) - 1); return true; }
        // Backspace — убрать последнее слово. Дальше в отмену ответа он не
        // проваливается: зажатый Backspace откатил бы десятки ответов.
        // Отменить ответ — стрелка вниз или кнопка.
        if (e.key === 'Backspace' && t.checked === null) {
            if (t.current.picked.length && !e.repeat) unpick(t.current.picked.length - 1);
            return true;
        }
    }
    if (e.key === 'Enter' && WRITE_MODES.includes(t.mode) && t.checked !== null) { checkWritten(); return true; }
    if (/^[1-4]$/.test(e.key)) {
        const n = Number(e.key);
        // Две оценки: 1 — «не помню», 2 — «помню».
        if (t.mode === 'cards' || (writing && t.checked !== null)) {
            if (n <= 2) grade(n === 1 ? 0 : 2);
            return true;
        }
        if (CHOICE_MODES.includes(t.mode) && n <= t.options.length) { choose(n - 1); return true; }
    }
    if (t.mode === 'cards' && e.key === 'ArrowRight') { grade(2); return true; }
    if (t.mode === 'cards' && e.key === 'ArrowLeft') { grade(0); return true; }
    if (e.key === 'Backspace' || e.key === 'ArrowDown') { undoLast(); return true; }
    return false;
}

function initSwipe() {
    const fc = $('flashcard');
    if (!fc) return;
    let x0 = 0, y0 = 0, dragging = false;
    fc.addEventListener('touchstart', e => {
        if (t.mode !== 'cards') return;
        x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dragging = true;
        fc.style.transition = 'none';
    }, { passive: true });
    fc.addEventListener('touchmove', e => {
        if (!dragging) return;
        const dx = e.touches[0].clientX - x0;
        const dy = e.touches[0].clientY - y0;
        if (Math.abs(dy) > Math.abs(dx) + 10) { dragging = false; fc.style.transform = ''; return; }
        fc.style.transform = `translateX(${dx}px) rotate(${dx * 0.06}deg)`;
    }, { passive: true });
    fc.addEventListener('touchend', e => {
        if (!dragging) return;
        dragging = false;
        const dx = e.changedTouches[0].clientX - x0;
        fc.style.transition = '';
        fc.style.transform = '';
        if (dx > 80) grade(2);
        else if (dx < -80) grade(0);
    });
}

export const trainingActions = {
    'start-lesson'() { startTraining({ source: 'lesson' }); },
    'start-training'() { startTraining({ mode: 'cards', source: 'due' }); },
    'start-write'() { startTraining({ mode: state.settings.spellingDir === 'ru-no' ? 'write-ru-no' : 'write-no-ru', source: 'practice' }); },
    'start-dictation'() { startTraining({ mode: 'dictation', source: 'practice' }); },
    'start-marathon'() { startTraining({ mode: 'cards', source: 'marathon' }); },
    'start-hard'() { startTraining({ mode: 'cards', source: 'hard' }); },
    'start-quiz'() { startTraining({ mode: 'quiz', source: 'practice' }); },
    'start-gender'() { startTraining({ mode: 'gender' }); },
    'start-forms'() { startTraining({ mode: 'forms' }); },
    'start-cloze'() { startTraining({ mode: 'cloze' }); },
    'start-listen'() { startTraining({ mode: 'listen' }); },
    'start-order'() { startTraining({ mode: 'order' }); },
    'tr-pick'(el) { pick(Number(el.dataset.index)); },
    'tr-unpick'(el) { unpick(Number(el.dataset.index)); },
    'stop-training'() { stopTraining(); },
    'flip'() { flip(); },
    'grade'(el) { grade(Number(el.dataset.grade)); },
    'tr-check'() { checkWritten(); },
    'tr-reveal'() { revealWritten(); },
    'tr-next'() { advance(); },
    'tr-choose'(el) { choose(Number(el.dataset.index)); },
    'tr-undo'() { undoLast(); },
    'tr-mode'() { cycleMode(); },
    'tr-speak'() { speakCurrent(); },
    'tr-speak-example'() { const w = word(); if (w?.example) speak(w.example); },
};

export function initTraining() {
    initSwipe();
    $('tr-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); checkWritten(); }
        // В диктанте Tab — прослушать ещё раз, не уходя из поля ввода.
        if (e.key === 'Tab' && t.mode === 'dictation') { e.preventDefault(); speakCurrent(); }
    });
}
