// Упражнения с вводом, которые не двигают расписание SM-2:
// «Формы» (напиши bestemt flertall от et hus) и «Пропуск в предложении».
import { state } from './store.js';
import { escapeHtml, shuffle } from './util.js';
import { displayWord, formsFor, makeCloze } from './norsk.js';
import { $ } from './ui.js';
import { t } from './session.js';

const SIZE = 20;

export function formsQueue() {
    const withForms = state.words.filter(w => formsFor(w.pos).some(([k]) => w.forms?.[k]));
    return shuffle(withForms).slice(0, SIZE).map(w => {
        const keys = formsFor(w.pos).filter(([k]) => w.forms?.[k]);
        const [key, no, ru] = keys[Math.floor(Math.random() * keys.length)];
        return { word: w, key, no, ru, expected: w.forms[key] };
    });
}

export function clozeQueue() {
    const items = [];
    for (const w of shuffle(state.words)) {
        const cloze = makeCloze(w);
        if (cloze) items.push({ word: w, ...cloze, expected: cloze.answer });
        if (items.length >= SIZE) break;
    }
    return items;
}

export function renderForms() {
    const q = t.current;
    $('tr-prompt').innerHTML = `
        <div class="prompt-main" lang="nb">${escapeHtml(displayWord(q.word))}</div>
        <div class="prompt-sub">${escapeHtml(q.word.translate)}</div>
        <div class="prompt-label">→ ${escapeHtml(q.no)} <em>${escapeHtml(q.ru)}</em></div>`;
}

export function renderCloze() {
    const q = t.current;
    $('tr-prompt').innerHTML = `
        <div class="prompt-sentence" lang="nb">${escapeHtml(q.before)}<span class="gap">____</span>${escapeHtml(q.after)}</div>
        ${q.word.exampleTranslate ? `<div class="prompt-sub">${escapeHtml(q.word.exampleTranslate)}</div>` : ''}
        <div class="prompt-label">подсказка: <em lang="nb">${escapeHtml(displayWord(q.word))}</em> — ${escapeHtml(q.word.translate)}</div>`;
}

// После проверки показываем предложение целиком, с подсвеченным словом.
export function revealCloze() {
    const q = t.current;
    const gap = $('tr-prompt').querySelector('.gap');
    if (gap) {
        gap.textContent = q.answer;
        gap.classList.add('filled');
    }
}
