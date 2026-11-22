// Кнопка «🚩 Сомневаюсь»: перепроверка карточки (POST /api/word/check).
// Перевод и пример проверяет ИИ, род и формы — словарь Ordbøkene.
// Само ничего не меняет: показывает замечания и правку «было → станет»,
// применяет пользователь.
import { state, saveWords } from './store.js';
import { normalizeWord } from './srs.js';
import { GENDERS, displayWord } from './norsk.js';
import { escapeHtml } from './util.js';
import { $, openModal, closeModal, showToast } from './ui.js';
import { readWordForm, fillWordForm } from './wordform.js';
import { t, word } from './session.js';

let onApplied = () => {};
export function onCheckApplied(fn) { onApplied = fn; }

let pending = null;   // { id, fix, toForm }
let request = 0;      // номер запроса: ответ на старый не перерисует окно

const FIELD = { translate: 'Перевод', example: 'Пример', exampleTranslate: 'Перевод примера', gender: 'Род', forms: 'Формы' };
const show = (key, v) => key === 'gender' ? (GENDERS[v]?.article || '—')
    : key === 'forms' ? Object.values(v || {}).filter(Boolean).join(' · ') || '—'
    : (v || '—');

// toForm — из окна редактирования: проверяется то, что в форме (с несохранёнными
// правками), и правка кладётся в форму, а сохраняет пользователь.
export async function checkWord(id, { toForm = false } = {}) {
    const saved = state.words.find(x => String(x.id) === String(id));
    if (!saved) return;
    const w = toForm ? { ...saved, ...readWordForm('edit') } : saved;
    const my = ++request;
    pending = null;
    $('check-title').textContent = displayWord(w);
    $('check-body').innerHTML = '<div class="check-wait">Проверяю перевод, пример и род… до минуты</div>';
    $('check-apply').hidden = true;
    openModal('check-modal');
    let r;
    try {
        const res = await fetch('/api/word/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ word: w }),
            signal: AbortSignal.timeout(70000),
        });
        if (!res.ok) throw new Error(`сервер ответил ${res.status}`);
        r = await res.json();
    } catch (err) {
        if (my !== request) return;
        $('check-body').innerHTML = `<div class="check-bad">Не удалось проверить: ${escapeHtml(err.message)}. Нужна сеть.</div>`;
        return;
    }
    if (my !== request) return;
    const by = [r.checkedBy?.ai && 'ИИ', r.checkedBy?.dictionary && 'словарь Ordbøkene'].filter(Boolean).join(' и ');
    if (!by) {
        $('check-body').innerHTML = '<div class="check-bad">Не удалось проверить: ни ИИ, ни словарь не ответили. Попробуй позже.</div>';
        return;
    }
    const fixKeys = Object.keys(r.fix || {}).filter(k => FIELD[k]);
    if (r.ok || !fixKeys.length && !r.issues?.length) {
        $('check-body').innerHTML = `<div class="check-ok">✓ Ошибок не нашёл</div><div class="muted check-by">Проверили: ${escapeHtml(by)}</div>`;
        return;
    }
    const issues = (r.issues || []).map(s => `<li>${escapeHtml(s)}</li>`).join('');
    const rows = fixKeys.map(k => `
        <div class="check-row">
            <div class="check-field">${FIELD[k]}</div>
            <div class="check-old">${escapeHtml(show(k, w[k]))}</div>
            <div class="check-new">${escapeHtml(show(k, k === 'forms' ? { ...w.forms, ...r.fix.forms } : r.fix[k]))}</div>
        </div>`).join('');
    $('check-body').innerHTML = `
        <ul class="check-issues">${issues}</ul>
        ${rows ? `<div class="check-diff"><div class="check-row head"><div></div><div>сейчас</div><div>станет</div></div>${rows}</div>` : ''}
        <div class="muted check-by">Проверили: ${escapeHtml(by)}. ИИ тоже ошибается — смотри сам.</div>`;
    if (rows) {
        pending = { id: w.id, toForm, base: w, fix: Object.fromEntries(fixKeys.map(k => [k, k === 'forms' ? { ...w.forms, ...r.fix.forms } : r.fix[k]])) };
        $('check-apply').hidden = false;
    }
}

function apply() {
    if (!pending) return;
    if (pending.toForm) {
        fillWordForm('edit', { ...pending.base, ...pending.fix });
        pending = null;
        closeModal('check-modal');
        showToast('Правка в форме — проверь и нажми «Сохранить»', 'info', 3000);
        return;
    }
    const w = state.words.find(x => x.id === pending.id);
    if (!w) return;
    Object.assign(w, normalizeWord({ ...w, ...pending.fix }));
    saveWords();
    pending = null;
    closeModal('check-modal');
    showToast('Карточка исправлена', 'success', 1800);
    onApplied(w);
}

export const checkActions = {
    // В тренировке — текущее слово (кнопка спрятана, пока ответ не дан).
    'check-word-current'() { const w = t.active && word(); if (w) checkWord(w.id); },
    'check-word'(el) { checkWord(el.dataset.id, { toForm: el.id === 'edit-check' }); },
    'check-apply'() { apply(); },
};
