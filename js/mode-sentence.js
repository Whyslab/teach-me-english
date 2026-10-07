// Режимы с целыми предложениями — то, чего не дают карточки отдельных слов:
// «Понимание на слух» (звучит пример, выбираешь перевод) и «Собери
// предложение» (порядок слов). Оба — практика, расписание SM-2 не трогают.
import { state } from './store.js';
import { escapeHtml, shuffle } from './util.js';
import { orderTokens, sameOrder } from './norsk.js';
import { $ } from './ui.js';
import { t } from './session.js';

const SIZE = 20;
const MIN_TOKENS = 3;
const MAX_TOKENS = 10;

const withExample = () => state.words.filter(w => w.example && w.exampleTranslate);

// Сколько разных переводов примеров есть — для «угадай» нужно хотя бы 4.
export function listenAvailable() {
    return new Set(withExample().map(w => w.exampleTranslate)).size >= 4;
}

// ---------------------------------------------------------------------------
// Понимание на слух. Элемент очереди — само слово, вопрос — его пример.
// ---------------------------------------------------------------------------
export function listenQueue() {
    return shuffle(withExample()).slice(0, SIZE);
}

const optionButton = (i, html) =>
    `<button class="quiz-option" data-action="tr-choose" data-index="${i}"><span class="opt-key">${i + 1}</span>${html}</button>`;

export function renderListen(w) {
    $('tr-prompt').innerHTML = `
        <div class="prompt-label">Что прозвучало?</div>
        <button class="listen-btn" data-action="tr-speak" aria-label="Прослушать ещё раз">🔊</button>
        <div class="prompt-sentence" id="listen-sentence" lang="nb" hidden>${escapeHtml(w.example)}</div>`;
    const pool = [...new Set(withExample().filter(x => x.id !== w.id).map(x => x.exampleTranslate))]
        .filter(tr => tr !== w.exampleTranslate);
    t.options = shuffle([w.exampleTranslate, ...shuffle(pool).slice(0, 3)]);
    $('tr-options').className = 'tr-options';
    $('tr-options').innerHTML = t.options.map((o, i) => optionButton(i, escapeHtml(o))).join('');
}

export function revealListen() {
    // Элемент создаётся в renderListen, поэтому ищем внутри вопроса.
    const el = $('tr-prompt').querySelector('#listen-sentence');
    if (el) el.hidden = false;
}

// ---------------------------------------------------------------------------
// Собери предложение. Элемент очереди — { word, answer, pool, picked }:
// pool — перемешанные слова, picked — индексы в pool в порядке выбора.
// ---------------------------------------------------------------------------
export function orderQueue() {
    const items = [];
    for (const w of shuffle(state.words.filter(x => x.example))) {
        const answer = orderTokens(w.example);
        if (answer.length < MIN_TOKENS || answer.length > MAX_TOKENS) continue;
        let pool = shuffle(answer);
        // Перемешивание могло оставить правильный порядок — тогда ещё раз.
        for (let i = 0; i < 5 && sameOrder(pool, answer); i++) pool = shuffle(answer);
        if (sameOrder(pool, answer)) continue;   // все слова одинаковые
        items.push({ word: w, answer, pool, picked: [] });
        if (items.length >= SIZE) break;
    }
    return items;
}

export function renderOrder() {
    const q = t.current;
    const picked = q.picked.map((idx, pos) =>
        `<button class="order-token placed" data-action="tr-unpick" data-index="${pos}" lang="nb">${escapeHtml(q.pool[idx])}</button>`).join('');
    const rest = q.pool.map((tok, idx) => q.picked.includes(idx) ? '' :
        `<button class="order-token" data-action="tr-pick" data-index="${idx}" lang="nb"><span class="opt-key">${idx + 1}</span>${escapeHtml(tok)}</button>`).join('');
    $('tr-prompt').innerHTML = `
        <div class="prompt-label">Собери предложение</div>
        ${q.word.exampleTranslate ? `<div class="prompt-sub">${escapeHtml(q.word.exampleTranslate)}</div>` : ''}
        <div class="order-line" aria-live="polite">${picked || '<span class="order-empty">нажимай слова по порядку</span>'}</div>
        <div class="order-pool">${rest}</div>
        ${t.checked !== null ? `<div class="prompt-sentence order-answer" lang="nb">${escapeHtml(q.word.example)}</div>` : ''}`;
}

export function pickToken(idx) {
    const q = t.current;
    if (t.checked !== null || !q.pool[idx] || q.picked.includes(idx)) return false;
    q.picked.push(idx);
    return true;
}

export function unpickToken(pos) {
    const q = t.current;
    if (t.checked !== null || pos < 0 || pos >= q.picked.length) return false;
    q.picked.splice(pos, 1);
    return true;
}

export function orderComplete() {
    return t.current.picked.length === t.current.pool.length;
}

export function orderCorrect() {
    const q = t.current;
    return sameOrder(q.picked.map(i => q.pool[i]), q.answer);
}
