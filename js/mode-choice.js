// Режимы выбора варианта: «Угадай из 4» и «Угадай род».
import { state } from './store.js';
import { isDue } from './srs.js';
import { escapeHtml, shuffle } from './util.js';
import { GENDERS, displayWord, checkGender } from './norsk.js';
import { $ } from './ui.js';
import { t } from './session.js';

export function genderQueue() {
    const nouns = state.words.filter(w => w.pos === 'noun' && GENDERS[w.gender]);
    // Сначала те, что пора повторять.
    return shuffle(nouns).sort((a, b) => Number(isDue(b)) - Number(isDue(a))).slice(0, 20);
}

const optionButton = (i, html, cls = '') =>
    `<button class="quiz-option ${cls}" data-action="tr-choose" data-index="${i}"><span class="opt-key">${i + 1}</span>${html}</button>`;

export function renderQuiz(w) {
    $('tr-prompt').innerHTML = `<div class="prompt-main" lang="nb">${escapeHtml(displayWord(w))}</div>`;
    // Дистракторы — уникальные переводы, не совпадающие с правильным.
    const pool = [...new Set(state.words.filter(x => x.id !== w.id).map(x => x.translate))]
        .filter(tr => tr !== w.translate);
    t.options = shuffle([w.translate, ...shuffle(pool).slice(0, 3)]);
    $('tr-options').className = 'tr-options grid-2';
    $('tr-options').innerHTML = t.options.map((o, i) => optionButton(i, escapeHtml(o))).join('');
}

export function renderGender(w) {
    $('tr-prompt').innerHTML = `
        <div class="prompt-label">Какой род?</div>
        <div class="prompt-main" lang="nb">___ ${escapeHtml(w.original)}</div>
        <div class="prompt-sub">${escapeHtml(w.translate)}</div>`;
    t.options = ['m', 'f', 'n'];
    $('tr-options').className = 'tr-options grid-3';
    $('tr-options').innerHTML = t.options.map((g, i) => optionButton(i, GENDERS[g].article, `gender g-${g}`)).join('');
}

// Оценивает выбор: { ok, isRight(i), feedback }.
export function evaluateChoice(w, index) {
    if (t.mode === 'listen') {
        const ok = t.options[index] === w.exampleTranslate;
        return {
            ok,
            isRight: (i) => t.options[i] === w.exampleTranslate,
            feedback: ok ? '✓ Верно!' : `✗ Правильно: ${w.exampleTranslate}`,
        };
    }
    if (t.mode === 'quiz') {
        const ok = t.options[index] === w.translate;
        return {
            ok,
            isRight: (i) => t.options[i] === w.translate,
            feedback: ok ? '✓ Верно!' : `✗ Правильно: ${w.translate}`,
        };
    }
    const result = checkGender(t.options[index], w.gender);
    const g = GENDERS[w.gender];
    return {
        ok: result !== 'wrong',
        isRight: (i) => t.options[i] === w.gender,
        feedback: result === 'correct' ? `✓ ${g.article} ${w.original} — ${g.ru} род`
            : result === 'also' ? `✓ Можно и так: в букмоле женский род допускает en. Словарная форма — ei ${w.original}`
            : `✗ ${g.article} ${w.original} — ${g.ru} род`,
    };
}
