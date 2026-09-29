// Тренировка: карточки, письмо в обе стороны, «угадай из 4», «угадай род», формы.
import { state, saveWords, saveSettings, recordAnswer, markIntroduced, introducedToday, displayedStreak } from './store.js';
import { sm2, selectSession, isHard, isDue } from './srs.js';
import { escapeHtml, shuffle, plural, toDayKey } from './util.js';
import { GENDERS, displayWord, formsLine, formsFor, lookupUrls, checkAnswer, checkGender } from './norsk.js';
import { $, showToast, openModal, playSound, speak, stopSpeech } from './ui.js';

// Режимы, между которыми переключается кнопка во время карточной сессии.
const CARD_MODES = ['cards', 'write-no-ru', 'write-ru-no'];
const MODE_LABEL = {
    'cards': '🎴 Карточки',
    'write-no-ru': '✍️ Письмо: NO → RU',
    'write-ru-no': '✍️ Письмо: RU → NO',
    'quiz': '🎯 Угадай из 4',
    'gender': '🏷 Угадай род: en / ei / et',
    'forms': '🔤 Формы слов',
};
const SOURCE_LABEL = { due: '', marathon: '🏃 Марафон', hard: '⚠️ Трудные слова' };

const t = {
    active: false,
    mode: 'cards',
    source: 'due',
    queue: [],        // слова (или вопросы для «форм») в порядке показа
    current: null,
    flipped: false,
    noFront: true,    // на лицевой стороне норвежское слово
    checked: null,    // результат проверки письма: correct | letters | wrong | null
    answered: false,  // в режимах выбора — ответ уже дан
    busy: false,
    correct: 0,
    wrong: 0,
    mistakes: new Map(),
    startedAt: 0,
    undo: [],
    options: [],
    autoNext: null,
};

let onFinish = () => {};
export function onTrainingFinished(fn) { onFinish = fn; }

export const isTraining = () => t.active;

// ---------------------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------------------
function buildQueue(source) {
    if (source === 'hard') return shuffle(state.words.filter(isHard));
    const { queue } = selectSession(state.words, {
        newLimit: state.settings.newPerDay,
        introducedToday: introducedToday(),
        ignoreLimit: source === 'marathon',
    });
    return queue;
}

export function startTraining({ mode = 'cards', source = 'due' } = {}) {
    let queue;
    if (mode === 'gender') {
        const nouns = state.words.filter(w => w.pos === 'noun' && GENDERS[w.gender]);
        if (nouns.length === 0) {
            showToast('Нет существительных с указанным родом. Укажи en/ei/et при добавлении слова или загрузи колоду A1.', 'info', 6000);
            return;
        }
        queue = shuffle(nouns).sort((a, b) => Number(isDue(b)) - Number(isDue(a))).slice(0, 20);
    } else if (mode === 'forms') {
        const withForms = state.words.filter(w => formsFor(w.pos).some(([k]) => w.forms?.[k]));
        if (withForms.length === 0) {
            showToast('Нет слов с формами. Заполни формы при добавлении (⚡ формы по правилу) или загрузи колоду A1.', 'info', 6000);
            return;
        }
        queue = shuffle(withForms).slice(0, 20).map(w => {
            const keys = formsFor(w.pos).filter(([k]) => w.forms?.[k]);
            const [key, no, ru] = keys[Math.floor(Math.random() * keys.length)];
            return { word: w, key, no, ru, expected: w.forms[key] };
        });
    } else {
        queue = buildQueue(source);
        if (mode === 'quiz') {
            if (state.words.length < 4) {
                showToast('Для «Угадай из 4» нужно хотя бы 4 слова в словаре.', 'info');
                return;
            }
        }
    }

    if (queue.length === 0) {
        const msg = source === 'hard'
            ? 'Трудных слов нет 🎉'
            : 'На сегодня всё повторено. Новые слова откроются завтра — или запусти «Марафон».';
        showToast(msg, 'info', 5000);
        return;
    }

    clearTimeout(t.autoNext);
    Object.assign(t, {
        active: true, mode, source, queue, current: null,
        correct: 0, wrong: 0, mistakes: new Map(), startedAt: Date.now(), undo: [],
    });
    document.body.classList.add('training-mode');
    $('training-section').hidden = false;
    $('main-content').hidden = true;
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
    t.flipped = false;
    t.checked = null;
    t.answered = false;
    render();
}

function word() {
    return t.mode === 'forms' ? t.current?.word : t.current;
}

function show(id, visible) {
    const el = $(id);
    if (el) el.hidden = !visible;
}

function render() {
    const w = word();
    if (!w) return;
    const isCardMode = CARD_MODES.includes(t.mode);
    const isWrite = t.mode === 'write-no-ru' || t.mode === 'write-ru-no' || t.mode === 'forms';

    $('tr-mode').textContent = MODE_LABEL[t.mode];
    $('tr-mode').disabled = !isCardMode;
    $('tr-source').textContent = SOURCE_LABEL[t.source] || '';
    $('tr-source').hidden = !SOURCE_LABEL[t.source];
    $('tr-left').textContent = t.queue.length;
    $('tr-correct').textContent = t.correct;
    $('tr-wrong').textContent = t.wrong;

    show('flashcard-wrap', isCardMode);
    show('tr-prompt', !isCardMode);
    show('tr-write', isWrite);
    show('tr-options', t.mode === 'quiz' || t.mode === 'gender');
    show('tr-grades', t.mode === 'cards' || (isWrite && t.mode !== 'forms' && t.checked !== null));
    show('tr-write-btns', isWrite && t.checked === null);
    show('tr-next-btn', (t.mode === 'forms' && t.checked !== null) || ((t.mode === 'quiz' || t.mode === 'gender') && t.answered));
    show('tr-back-btn', t.undo.length > 0);
    $('tr-feedback').textContent = '';
    $('tr-feedback').className = 'tr-feedback';
    document.querySelectorAll('#tr-grades .grade-btn.suggested').forEach(b => b.classList.remove('suggested'));

    if (isCardMode) renderCard(w);
    else if (t.mode === 'quiz') renderQuiz(w);
    else if (t.mode === 'gender') renderGender(w);
    else if (t.mode === 'forms') renderForms();

    renderLinks(w);

    if (isWrite) {
        const input = $('tr-input');
        input.value = '';
        input.disabled = false;
        const toNorwegian = t.mode === 'write-ru-no' || t.mode === 'forms';
        input.lang = toNorwegian ? 'nb' : 'ru';
        input.placeholder = toNorwegian ? 'напиши по-норвежски и нажми Enter' : 'напиши перевод и нажми Enter';
        show('tr-letters', toNorwegian);
        setTimeout(() => input.focus(), 30);
    }

    const autoSpeak = state.settings.autoSpeak && t.mode !== 'write-ru-no' && t.mode !== 'gender';
    if (autoSpeak) setTimeout(() => speak(displayWord(w)), 150);
}

function renderCard(w) {
    const card = $('flashcard');
    card.classList.remove('is-flipped', 'flash-correct', 'flash-wrong');
    if (t.mode === 'cards') t.noFront = Math.random() < 0.5;
    else t.noFront = t.mode === 'write-no-ru';

    const no = displayWord(w);
    const front = $('card-front');
    const back = $('card-back-text');
    front.textContent = t.noFront ? no : w.translate;
    front.lang = t.noFront ? 'nb' : 'ru';
    back.textContent = t.noFront ? w.translate : no;
    back.lang = t.noFront ? 'ru' : 'nb';

    const forms = formsLine(w);
    $('card-forms').textContent = forms;
    $('card-forms').hidden = !forms;
    $('card-example').textContent = w.example || '';
    $('card-example-translate').textContent = w.exampleTranslate || '';
    $('card-example-block').hidden = !w.example;
    $('card-hint').textContent = t.mode === 'cards' ? 'нажми или пробел — перевернуть' : '';
}

function renderLinks(w) {
    const urls = lookupUrls(w.original);
    $('tr-forvo').href = urls.forvo;
    $('tr-ordbok').href = urls.ordbok;
    // В письме RU → NO и в «роде» ссылки выдали бы ответ до проверки.
    const spoiler = (t.mode === 'write-ru-no' && t.checked === null)
        || (t.mode === 'gender' && !t.answered)
        || (t.mode === 'cards' && !t.noFront && !t.flipped);
    $('tr-links').classList.toggle('concealed', spoiler);
}

function renderQuiz(w) {
    $('tr-prompt').innerHTML = `<div class="prompt-main" lang="nb">${escapeHtml(displayWord(w))}</div>`;
    const pool = [...new Set(state.words.filter(x => x.id !== w.id).map(x => x.translate))]
        .filter(tr => tr !== w.translate);
    const options = shuffle([w.translate, ...shuffle(pool).slice(0, 3)]);
    t.options = options;
    $('tr-options').className = 'tr-options grid-2';
    $('tr-options').innerHTML = options.map((o, i) =>
        `<button class="quiz-option" data-action="tr-choose" data-index="${i}"><span class="opt-key">${i + 1}</span>${escapeHtml(o)}</button>`).join('');
}

function renderGender(w) {
    const bare = displayWord({ ...w, pos: '' });
    $('tr-prompt').innerHTML = `
        <div class="prompt-label">Какой род?</div>
        <div class="prompt-main" lang="nb">___ ${escapeHtml(bare)}</div>
        <div class="prompt-sub">${escapeHtml(w.translate)}</div>`;
    t.options = ['m', 'f', 'n'];
    $('tr-options').className = 'tr-options grid-3';
    $('tr-options').innerHTML = t.options.map((g, i) =>
        `<button class="quiz-option gender g-${g}" data-action="tr-choose" data-index="${i}"><span class="opt-key">${i + 1}</span>${GENDERS[g].article}</button>`).join('');
}

function renderForms() {
    const q = t.current;
    $('tr-prompt').innerHTML = `
        <div class="prompt-main" lang="nb">${escapeHtml(displayWord(q.word))}</div>
        <div class="prompt-sub">${escapeHtml(q.word.translate)}</div>
        <div class="prompt-label">→ ${escapeHtml(q.no)} <em>${escapeHtml(q.ru)}</em></div>`;
}

// ---------------------------------------------------------------------------
// Ответы
// ---------------------------------------------------------------------------
function snapshot() {
    const w = word();
    const today = toDayKey();
    return {
        queue: [...t.queue],
        mode: t.mode,
        correct: t.correct,
        wrong: t.wrong,
        mistakes: new Map(t.mistakes),
        todayCount: state.streak.todayCount,
        activity: state.activity[today] || 0,
        introduced: [...(state.introduced.ids || [])],
        word: w && {
            id: w.id, level: w.level, nextReview: w.nextReview, forgetStep: w.forgetStep,
            sm2EF: w.sm2EF, sm2Interval: w.sm2Interval, sm2Reps: w.sm2Reps,
            history: [...(w.history || [])],
        },
    };
}

// Возвращает слово в очередь через несколько карточек, чтобы оно успело «остыть».
function requeue(item) {
    t.queue.shift();
    const pos = Math.min(t.queue.length, 3 + Math.floor(Math.random() * 3));
    t.queue.splice(pos, 0, item);
}

function tally(correct, w) {
    if (correct) t.correct++;
    else {
        t.wrong++;
        t.mistakes.set(w.id, (t.mistakes.get(w.id) || 0) + 1);
    }
    recordAnswer(correct);
}

// quality 0..3 по SM-2. Для карточек и письма.
export function grade(quality) {
    if (!t.active || t.busy || !CARD_MODES.includes(t.mode)) return;
    const w = word();
    if (!w) return;
    t.busy = true;
    t.undo.push(snapshot());
    if (t.undo.length > 50) t.undo.shift();

    markIntroduced(w);
    sm2(w, quality);
    tally(quality >= 2, w);
    playSound(quality >= 2 ? 'correct' : 'wrong');
    saveWords();

    if (quality >= 2) t.queue.shift();
    else requeue(w);

    const card = $('flashcard');
    card.classList.add(quality >= 2 ? 'flash-correct' : 'flash-wrong');
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

// Проверка в режимах письма и форм (Enter).
export function checkWritten() {
    if (!t.active) return;
    const input = $('tr-input');
    if (t.checked !== null) {
        // Второй Enter — дальше. Оценка берётся из проверки: раньше здесь
        // всегда нажималось «Хорошо», даже после неверного ответа.
        if (t.mode === 'forms') return advanceChoice();
        return grade(t.checked === 'correct' ? 2 : t.checked === 'letters' ? 1 : 0);
    }
    const w = word();
    const toNorwegian = t.mode !== 'write-no-ru';
    const expected = t.mode === 'forms' ? t.current.expected
                   : toNorwegian ? w.original : w.translate;
    t.checked = checkAnswer(input.value, expected, { norwegian: toNorwegian });
    input.disabled = true;

    const fb = $('tr-feedback');
    const shownExpected = t.mode === 'forms' ? expected : toNorwegian ? displayWord(w) : expected;
    if (t.checked === 'correct') {
        fb.textContent = '✅ Верно!';
        fb.className = 'tr-feedback ok';
    } else if (t.checked === 'letters') {
        fb.textContent = `🟡 Почти — проверь æ ø å: ${shownExpected}`;
        fb.className = 'tr-feedback almost';
    } else {
        fb.textContent = `❌ Правильно: ${shownExpected}`;
        fb.className = 'tr-feedback bad';
    }

    if (t.mode === 'forms') {
        t.undo.push(snapshot());
        tally(t.checked === 'correct', w);
        playSound(t.checked === 'correct' ? 'correct' : 'wrong');
        if (t.checked === 'correct') t.queue.shift(); else requeue(t.current);
        speak(expected);
    } else {
        t.flipped = true;
        $('flashcard').classList.add('is-flipped');
        speak(displayWord(w));
    }
    show('tr-write-btns', false);
    show('tr-grades', t.mode !== 'forms');
    show('tr-next-btn', t.mode === 'forms');
    renderLinks(w);
    // Подсказка, какую кнопку нажмёт второй Enter.
    if (t.mode !== 'forms') {
        const suggested = t.checked === 'correct' ? '2' : t.checked === 'letters' ? '1' : '0';
        document.querySelectorAll('#tr-grades .grade-btn').forEach(b => b.classList.toggle('suggested', b.dataset.grade === suggested));
    }
}

// «Показать ответ» в письме — это «не вспомнил».
export function revealWritten() {
    if (t.checked !== null) return;
    $('tr-input').value = '';
    checkWritten();
}

function choose(index) {
    if (!t.active || t.answered) return;
    const w = word();
    let result;
    if (t.mode === 'quiz') {
        result = t.options[index] === w.translate ? 'correct' : 'wrong';
    } else if (t.mode === 'gender') {
        result = checkGender(t.options[index], w.gender);
    } else return;

    t.answered = true;
    t.undo.push(snapshot());
    const ok = result !== 'wrong';
    const buttons = [...document.querySelectorAll('#tr-options .quiz-option')];
    buttons.forEach((b, i) => {
        b.disabled = true;
        const isRight = t.mode === 'quiz' ? t.options[i] === w.translate : t.options[i] === w.gender;
        if (isRight) b.classList.add('correct');
        else if (i === index && !ok) b.classList.add('wrong');
    });

    const fb = $('tr-feedback');
    if (t.mode === 'quiz') {
        fb.textContent = ok ? '✓ Верно!' : `✗ Правильно: ${w.translate}`;
        // Угадай из 4 двигает расписание так же, как карточки.
        markIntroduced(w);
        sm2(w, ok ? 2 : 0);
        saveWords();
    } else {
        const g = GENDERS[w.gender];
        fb.textContent = result === 'correct' ? `✓ ${g.article} ${w.original} — ${g.ru} род`
            : result === 'also' ? `✓ Можно и так: в букмоле женский род допускает en. Словарная форма — ei ${w.original}`
            : `✗ ${g.article} ${w.original} — ${g.ru} род`;
    }
    fb.className = `tr-feedback ${ok ? 'ok' : 'bad'}`;
    tally(ok, w);
    playSound(ok ? 'correct' : 'wrong');
    if (ok) t.queue.shift(); else requeue(w);
    speak(displayWord(w));
    show('tr-next-btn', true);
    renderLinks(w);
    t.autoNext = setTimeout(advanceChoice, ok ? 1100 : 2600);
}

function advanceChoice() {
    clearTimeout(t.autoNext);
    if (t.active) next();
}

export function undoLast() {
    const s = t.undo.pop();
    if (!s) return;
    clearTimeout(t.autoNext);
    t.queue = s.queue;
    t.correct = s.correct;
    t.wrong = s.wrong;
    t.mistakes = s.mistakes;
    state.streak.todayCount = s.todayCount;
    state.activity[toDayKey()] = s.activity;
    state.introduced.ids = s.introduced;
    if (s.word) {
        const w = state.words.find(x => x.id === s.word.id);
        if (w) {
            const { id, ...rest } = s.word;
            Object.assign(w, rest);
        }
    }
    saveWords();
    next();
}

function cycleMode() {
    if (!CARD_MODES.includes(t.mode)) return;
    t.mode = CARD_MODES[(CARD_MODES.indexOf(t.mode) + 1) % CARD_MODES.length];
    if (t.mode !== 'cards') {
        state.settings.spellingDir = t.mode === 'write-ru-no' ? 'ru-no' : 'no-ru';
        saveSettings();
    }
    t.checked = null;
    t.flipped = false;
    render();
}

// ---------------------------------------------------------------------------
// Итоги
// ---------------------------------------------------------------------------
function showResults() {
    const total = t.correct + t.wrong;
    const accuracy = total ? Math.round(t.correct / total * 100) : 0;
    const mins = Math.max(1, Math.round((Date.now() - t.startedAt) / 60000));
    $('results-emoji').textContent = accuracy >= 90 ? '🏆' : accuracy >= 70 ? '🎉' : accuracy >= 50 ? '💪' : '📚';
    const goal = state.settings.dailyGoal;
    const cards = [
        [t.correct, 'Верно', 'ok'],
        [t.wrong, 'Ошибки', 'bad'],
        [`${accuracy}%`, 'Точность', accuracy >= 70 ? 'ok' : 'warn'],
        [`${mins} мин`, 'Время', ''],
        [`${Math.min(state.streak.todayCount, goal)}/${goal}`, 'Цель дня', state.streak.todayCount >= goal ? 'ok' : ''],
        [`${displayedStreak()} 🔥`, plural(displayedStreak(), ['день подряд', 'дня подряд', 'дней подряд']), 'streak'],
    ];
    $('results-grid').innerHTML = cards.map(([v, l, c]) =>
        `<div class="result-card ${c}"><div class="rc-value">${escapeHtml(String(v))}</div><div class="rc-label">${escapeHtml(l)}</div></div>`).join('');

    const hard = [...t.mistakes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([id, n]) => {
            const w = state.words.find(x => x.id === id);
            return w ? `<div class="results-hard-item"><span lang="nb">${escapeHtml(displayWord(w))}</span><span class="fst-trans">${escapeHtml(w.translate)}</span><span class="results-hard-cnt">${n}× ✗</span></div>` : '';
        }).join('');
    const hardEl = $('results-hardest');
    hardEl.hidden = !hard;
    hardEl.innerHTML = hard ? `<div class="results-hard-title">Ошибки этой сессии</div>${hard}` : '';
    openModal('results-modal');
}

// ---------------------------------------------------------------------------
// Клавиатура и свайпы
// ---------------------------------------------------------------------------
export function handleTrainingKey(e) {
    if (!t.active) return false;
    const inInput = e.target.matches?.('input, textarea');
    if (e.key === 'Escape') { stopTraining(); return true; }
    if (inInput) return false;

    const isCard = CARD_MODES.includes(t.mode);
    const writing = isCard && t.mode !== 'cards';
    if ((e.code === 'Space' || e.key === 'Enter') && t.mode === 'cards') { flip(); return true; }
    if (e.key === 'Enter' && ((t.mode === 'quiz' || t.mode === 'gender') && t.answered)) { advanceChoice(); return true; }
    if (e.key === 'Enter' && (writing || t.mode === 'forms') && t.checked !== null) { checkWritten(); return true; }
    if (/^[1-4]$/.test(e.key)) {
        const n = Number(e.key);
        if (t.mode === 'cards' || (writing && t.checked !== null)) { grade(n - 1); return true; }
        if ((t.mode === 'quiz' || t.mode === 'gender') && n <= t.options.length) { choose(n - 1); return true; }
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
    'start-training'() { startTraining({ mode: 'cards', source: 'due' }); },
    'start-write'() { startTraining({ mode: state.settings.spellingDir === 'ru-no' ? 'write-ru-no' : 'write-no-ru', source: 'due' }); },
    'start-marathon'() { startTraining({ mode: 'cards', source: 'marathon' }); },
    'start-hard'() { startTraining({ mode: 'cards', source: 'hard' }); },
    'start-quiz'() { startTraining({ mode: 'quiz', source: 'due' }); },
    'start-gender'() { startTraining({ mode: 'gender' }); },
    'start-forms'() { startTraining({ mode: 'forms' }); },
    'stop-training'() { stopTraining(); },
    'flip'() { flip(); },
    'grade'(el) { grade(Number(el.dataset.grade)); },
    'tr-check'() { checkWritten(); },
    'tr-reveal'() { revealWritten(); },
    'tr-next'() { advanceChoice(); },
    'tr-choose'(el) { choose(Number(el.dataset.index)); },
    'tr-undo'() { undoLast(); },
    'tr-mode'() { cycleMode(); },
    'tr-speak'() { const w = word(); if (w) speak(displayWord(w)); },
};

export function initTraining() {
    initSwipe();
    $('tr-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); checkWritten(); }
    });
}
