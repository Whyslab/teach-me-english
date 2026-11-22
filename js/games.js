// Игры на скорость: «Найди пары», «Молния 60 с», «Правда или ложь»,
// «Серия без ошибок». Логика — в game-logic.js, здесь экран и клавиши.
// Ответы двигают расписание как лёгкие задания урока (sm2 easy / «не помню»).
import { state, saveWords, saveSettings, recordAnswer } from './store.js';
import { sm2 } from './srs.js';
import { displayWord } from './norsk.js';
import { escapeHtml } from './util.js';
import { $, playSound, speak, showToast } from './ui.js';
import {
    GAMES, GAME_SECONDS, PAIRS_PER_ROUND, PAIRS_ROUNDS, MIN_POOL,
    gamePool, pairsRounds, pairsRound, quizQuestion, truthQuestion, isRecord, formatGameValue, schedulesGameAnswer,
} from './game-logic.js';

const g = {
    active: false, over: false, game: null, pool: [], score: 0, mistakes: 0,
    startedAt: 0, endsAt: 0, overAt: 0, timer: null, next: null,
    q: null, recent: [], locked: false,
    board: null, sel: { L: null, R: null }, round: 0, rounds: 0, done: new Set(),
};

let onExit = () => {};
export function onGameFinished(fn) { onExit = fn; }
export const isGame = () => g.active;

const timed = () => g.game === 'blitz' || g.game === 'truth';

// ---------------------------------------------------------------------------
// Запуск и выход
// ---------------------------------------------------------------------------
export function startGame(game) {
    if (!GAMES[game]) return;
    const pool = gamePool(state.words);
    if (pool.length < MIN_POOL) {
        showToast(`Для игр нужно хотя бы ${MIN_POOL} знакомых слова — сначала пройди урок.`, 'info', 6000);
        return;
    }
    clearTimeout(g.next);
    clearInterval(g.timer);
    Object.assign(g, {
        active: true, over: false, game, pool, score: 0, mistakes: 0,
        startedAt: Date.now(), endsAt: Date.now() + GAME_SECONDS * 1000,
        q: null, recent: [], locked: false, round: 0, rounds: pairsRounds(pool), done: new Set(),
        finishedAt: 0, pauses: 0,
    });
    document.body.classList.add('training-mode');
    $('main-content').hidden = true;
    $('game-section').hidden = false;
    $('game-title').textContent = GAMES[game].title;
    window.scrollTo(0, 0);
    g.timer = setInterval(tick, 100);
    if (game === 'pairs') nextRound(); else nextQuestion();
    tick();
}

export function stopGame() {
    if (!g.active) return;
    // Вышел посреди игры — счёт не засчитывается; ответы уже в расписании.
    g.active = false;
    clearInterval(g.timer);
    clearTimeout(g.next);
    document.body.classList.remove('training-mode');
    $('game-section').hidden = true;
    $('main-content').hidden = false;
    saveWords();
    onExit();
}

function tick() {
    if (!g.active || g.over) return;
    const now = Date.now();
    if (timed()) {
        const left = Math.max(0, g.endsAt - now);
        $('game-timer').textContent = `${Math.ceil(left / 1000)} с`;
        $('game-timer').classList.toggle('hurry', left < 10000);
        if (left <= 0) finish();
    } else if (g.game === 'pairs') {
        $('game-timer').textContent = `${((now - g.startedAt) / 1000).toFixed(1).replace('.', ',')} с`;
    } else {
        $('game-timer').textContent = '';
    }
    $('game-score').textContent = g.game === 'pairs'
        ? `${g.done.size} / ${g.rounds * Math.min(PAIRS_PER_ROUND, g.pool.length)}`
        : String(g.score);
}

// Ответ по слову — в расписание, как лёгкое задание урока. Но верный ответ
// двигает только слово, которое пора повторять: sm2 не знает, сколько прошло,
// и слово с интервалом 30 дней, угаданное на 3-й день, ушло бы на 30·EF.
// Ошибка считается всегда — забытое слово надо вернуть раньше.
function answer(word, ok) {
    const now = Date.now();
    if (schedulesGameAnswer(word, ok, now)) sm2(word, ok ? 2 : 0, now, Math.random, { easy: true });
    recordAnswer();
    saveWords();
    playSound(ok ? 'correct' : 'wrong');
}

// ---------------------------------------------------------------------------
// Молния, правда/ложь, серия
// ---------------------------------------------------------------------------
function nextQuestion() {
    if (!g.active || g.over) return;
    const kind = g.game === 'blitz' ? 'quiz' : g.game === 'truth' ? 'truth' : (Math.random() < 0.5 ? 'quiz' : 'truth');
    g.q = (kind === 'quiz' ? quizQuestion : truthQuestion)(g.pool, g.recent);
    g.recent = [g.q.word.id, ...g.recent].slice(0, Math.min(5, g.pool.length - 1));
    g.locked = false;
    renderQuestion();
}

function renderQuestion() {
    // Фокус от прошлой кнопки иначе рисует рамку на новой, будто она выбрана.
    document.activeElement?.blur?.();
    const q = g.q;
    const word = escapeHtml(displayWord(q.word));
    if (q.kind === 'quiz') {
        $('game-stage').innerHTML = `
            <div class="prompt-main" lang="nb">${word}</div>
            <div class="tr-options grid-2 game-options">${q.options.map((o, i) =>
                `<button class="quiz-option" data-action="game-choose" data-index="${i}"><span class="opt-key">${i + 1}</span>${escapeHtml(o)}</button>`).join('')}</div>`;
        $('game-hint').textContent = '1–4 — вариант · Esc — выйти';
    } else {
        $('game-stage').innerHTML = `
            <div class="prompt-main" lang="nb">${word}</div>
            <div class="truth-shown">= ${escapeHtml(q.shown)}</div>
            <div class="tr-options grid-2 game-options">
                <button class="quiz-option truth-no" data-action="game-truth" data-value="0"><span class="opt-key">← 1</span>✗ Неверно</button>
                <button class="quiz-option truth-yes" data-action="game-truth" data-value="1"><span class="opt-key">→ 2</span>✓ Верно</button>
            </div>`;
        $('game-hint').textContent = '← или 1 — неверно · → или 2 — верно · Esc — выйти';
    }
}

function settle(ok, rightIndex, chosenIndex) {
    g.locked = true;
    answer(g.q.word, ok);
    const buttons = [...$('game-stage').querySelectorAll('.quiz-option')];
    buttons.forEach(b => { b.disabled = true; });
    if (buttons[rightIndex]) buttons[rightIndex].classList.add('correct');
    if (!ok && buttons[chosenIndex]) buttons[chosenIndex].classList.add('wrong');
    if (ok) g.score++;
    else g.mistakes++;
    if (!ok && g.game === 'streak') {
        g.next = setTimeout(finish, 1100);
        return;
    }
    g.next = setTimeout(nextQuestion, ok ? 250 : 900);
    tick();
}

function choose(index) {
    if (!g.q || g.locked || g.q.kind !== 'quiz' || !g.q.options[index]) return;
    const right = g.q.options.indexOf(g.q.word.translate);
    settle(index === right, right, index);
}

function judge(sayTrue) {
    if (!g.q || g.locked || g.q.kind !== 'truth') return;
    const right = g.q.truth ? 1 : 0;
    settle(sayTrue === g.q.truth, right, sayTrue ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Пары
// ---------------------------------------------------------------------------
function nextRound() {
    const size = Math.min(PAIRS_PER_ROUND, g.pool.length);
    const words = g.pool.slice(g.round * size, g.round * size + size);
    g.board = pairsRound(words);
    g.sel = { L: null, R: null };
    g.locked = false;
    renderPairs();
}

function renderPairs() {
    const col = (side, items, keys) => items.map((it, i) => {
        const matched = g.done.has(it.id);
        const text = side === 'L' ? displayWord(it.word) : it.word.translate;
        const selected = g.sel[side] === i;
        return `<button class="pair-tile${matched ? ' matched' : ''}${selected ? ' selected' : ''}" data-action="game-pair" data-side="${side}" data-index="${i}" ${matched ? 'disabled' : ''} ${side === 'L' ? 'lang="nb"' : ''}><span class="opt-key">${keys[i]}</span>${escapeHtml(text)}</button>`;
    }).join('');
    $('game-stage').innerHTML = `
        <div class="prompt-label">Раунд ${g.round + 1} из ${g.rounds}</div>
        <div class="pairs-board">
            <div class="pairs-col">${col('L', g.board.left, ['1', '2', '3', '4', '5'])}</div>
            <div class="pairs-col">${col('R', g.board.right, ['6', '7', '8', '9', '0'])}</div>
        </div>`;
    $('game-hint').textContent = '1–5 — слово слева · 6–0 — перевод справа · Esc — выйти';
}

function pickPair(side, index) {
    if (g.locked || !g.board) return;
    const items = side === 'L' ? g.board.left : g.board.right;
    if (!items[index] || g.done.has(items[index].id)) return;
    g.sel[side] = g.sel[side] === index ? null : index;
    if (g.sel.L === null || g.sel.R === null) { renderPairs(); return; }

    const left = g.board.left[g.sel.L];
    const right = g.board.right[g.sel.R];
    const ok = left.id === right.id;
    answer(left.word, ok);
    if (ok) {
        g.done.add(left.id);
        speak(displayWord(left.word));
        g.sel = { L: null, R: null };
        renderPairs();
        const roundDone = g.board.left.every(it => g.done.has(it.id));
        if (roundDone) {
            g.round++;
            g.finishedAt = Date.now();   // без паузы перед следующим раундом
            g.locked = true;
            // Пауза между раундами не идёт во время.
            g.next = setTimeout(() => {
                if (g.round >= g.rounds) return finish();
                g.pauses += Date.now() - g.finishedAt;
                nextRound();
            }, 350);
        }
    } else {
        g.mistakes++;
        renderPairs();
        $('game-stage').querySelectorAll('.pair-tile.selected').forEach(b => b.classList.add('wrong'));
        g.locked = true;
        g.next = setTimeout(() => { g.sel = { L: null, R: null }; g.locked = false; renderPairs(); }, 450);
    }
    tick();
}

// ---------------------------------------------------------------------------
// Конец игры и рекорды
// ---------------------------------------------------------------------------
function finish() {
    if (g.over) return;
    g.over = true;
    g.overAt = Date.now();
    clearInterval(g.timer);
    clearTimeout(g.next);
    const value = g.game === 'pairs' ? (g.finishedAt || Date.now()) - g.startedAt - g.pauses : g.score;
    // Рекорд пар — только за полную игру (3 раунда), иначе время несравнимо.
    const counts = g.game !== 'pairs' || g.rounds === PAIRS_ROUNDS;
    const records = state.settings.records || {};
    const record = counts && isRecord(g.game, value, records);
    if (record) {
        state.settings.records = { ...records, [g.game]: value };
        saveSettings();
    }
    const best = state.settings.records?.[g.game];
    $('game-timer').textContent = '';
    $('game-stage').innerHTML = `
        <div class="game-over">
            <div class="game-emoji">${record ? '🏆' : g.mistakes === 0 ? '🎉' : '💪'}</div>
            <div class="game-value">${escapeHtml(formatGameValue(g.game, value))}</div>
            <div class="prompt-sub">${escapeHtml(resultLine(value))}</div>
            <div class="game-record">${record ? 'Новый рекорд!' : best ? `Рекорд: ${escapeHtml(formatGameValue(g.game, best))}` : ''}</div>
            ${!counts ? '<div class="prompt-sub">Для рекорда нужно 15 знакомых слов — сейчас меньше.</div>' : ''}
            <div class="game-actions">
                <button class="btn btn-primary btn-lg" data-action="game-again">Ещё раз ⏎</button>
                <button class="btn btn-ghost btn-lg" data-action="game-stop">Выйти</button>
            </div>
        </div>`;
    $('game-hint').textContent = 'Enter — ещё раз · Esc — выйти';
    saveWords();
    if (record) playSound('correct');
}

function resultLine(value) {
    const m = g.mistakes ? ` · ошибок: ${g.mistakes}` : ' · без ошибок';
    if (g.game === 'pairs') return `${g.done.size} пар${m}`;
    if (g.game === 'streak') return `${value} подряд`;
    return `верных ответов за ${GAME_SECONDS} с${m}`;
}

// Рекорды на плитках главной.
export function renderGameRecords() {
    const records = state.settings.records || {};
    for (const game of Object.keys(GAMES)) {
        const el = $(`rec-${game}`);
        if (el) el.textContent = records[game] ? `рекорд ${formatGameValue(game, records[game])}` : GAMES[game].hint;
    }
}

// ---------------------------------------------------------------------------
// Клавиши и действия
// ---------------------------------------------------------------------------
export function handleGameKey(e) {
    if (!g.active) return false;
    if (e.key === 'Escape') { stopGame(); return true; }
    if (g.over) {
        // Пауза после конца: Enter, нажатый на последний вопрос, не перезапускает игру.
        if (e.key === 'Enter' && !e.repeat && Date.now() - g.overAt > 600) startGame(g.game);
        return e.key === 'Enter';
    }
    if (e.repeat) return true;
    if (g.game === 'pairs') {
        const L = '12345'.indexOf(e.key);
        const R = '67890'.indexOf(e.key);
        if (L >= 0) { pickPair('L', L); return true; }
        if (R >= 0) { pickPair('R', R); return true; }
        return false;
    }
    if (g.q?.kind === 'quiz' && /^[1-4]$/.test(e.key)) { choose(Number(e.key) - 1); return true; }
    if (g.q?.kind === 'truth') {
        if (e.key === 'ArrowLeft' || e.key === '1') { judge(false); return true; }
        if (e.key === 'ArrowRight' || e.key === '2') { judge(true); return true; }
    }
    return false;
}

export const gameActions = {
    'start-game'(el) { startGame(el.dataset.game); },
    'game-stop'() { stopGame(); },
    'game-again'() { if (g.game) startGame(g.game); },
    'game-choose'(el) { choose(Number(el.dataset.index)); },
    'game-truth'(el) { judge(el.dataset.value === '1'); },
    'game-pair'(el) { pickPair(el.dataset.side, Number(el.dataset.index)); },
};
