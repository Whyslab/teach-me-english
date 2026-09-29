// Форма слова — одна разметка для добавления на главной и для окна
// редактирования. Раньше редактирование шло через contenteditable прямо в
// списке, и грамматические поля там было не показать.
import { GENDERS, POS, NOUN_FORMS, VERB_FORMS, formsFor, guessNounForms, guessVerbForms } from './norsk.js';
import { sanitizeTags } from './util.js';

const LETTERS = ['æ', 'ø', 'å'];

export function wordFormHtml(prefix) {
    const p = prefix;
    const formInputs = (list, cls) => list.map(([key, no, ru]) => `
        <label class="form-field ${cls}">
            <span class="form-label">${no} <em>${ru}</em></span>
            <input type="text" id="${p}-form-${key}" lang="nb" maxlength="60" autocomplete="off" spellcheck="false">
        </label>`).join('');

    return `
    <div class="word-form" data-prefix="${p}">
        <div class="no-row">
            <input type="text" id="${p}-no" placeholder="норвежское слово (bokmål)" lang="nb" maxlength="100"
                   autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Норвежское слово">
            <span class="no-letters" aria-label="Норвежские буквы">
                ${LETTERS.map(ch => `<button type="button" class="no-letter-btn" data-action="insert-char" data-char="${ch}" title="${ch} (Shift — ${ch.toUpperCase()})" tabindex="-1">${ch}</button>`).join('')}
            </span>
        </div>
        <input type="text" id="${p}-ru" placeholder="русский перевод" maxlength="500" aria-label="Перевод">

        <div class="grammar-row">
            <select id="${p}-pos" aria-label="Часть речи" data-change="pos">
                <option value="">часть речи —</option>
                ${Object.entries(POS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
            </select>
            <span class="gender-pick" id="${p}-gender-wrap" hidden>
                ${Object.entries(GENDERS).map(([k, g]) => `
                    <label class="gender-opt" title="${g.label} — ${g.ru}">
                        <input type="radio" name="${p}-gender" value="${k}" data-change="gender"><span>${g.article}</span>
                    </label>`).join('')}
            </span>
            <button type="button" class="outline-btn small" id="${p}-guess" data-action="guess-forms" hidden
                    title="Заполнить регулярные формы. Неправильные слова (bok → bøker) проверь в Ordbøkene.">⚡ формы по правилу</button>
        </div>
        <div class="forms-grid" id="${p}-forms-noun" hidden>${formInputs(NOUN_FORMS, 'noun')}</div>
        <div class="forms-grid" id="${p}-forms-verb" hidden>${formInputs(VERB_FORMS, 'verb')}</div>

        <input type="text" id="${p}-example" placeholder="пример на норвежском (необязательно)" lang="nb" aria-label="Пример">
        <input type="text" id="${p}-ex-ru" placeholder="перевод примера" aria-label="Перевод примера">
        <input type="text" id="${p}-tags" placeholder="теги: A1, familie, reise" aria-label="Теги">
    </div>`;
}

const el = (p, id) => document.getElementById(`${p}-${id}`);

export function syncGrammarVisibility(p) {
    const pos = el(p, 'pos').value;
    el(p, 'gender-wrap').hidden = pos !== 'noun';
    el(p, 'forms-noun').hidden = pos !== 'noun';
    el(p, 'forms-verb').hidden = pos !== 'verb';
    el(p, 'guess').hidden = !(pos === 'noun' || pos === 'verb');
}

function selectedGender(p) {
    return document.querySelector(`input[name="${p}-gender"]:checked`)?.value || '';
}

export function guessForms(p) {
    const pos = el(p, 'pos').value;
    const lemma = el(p, 'no').value;
    const guess = pos === 'noun' ? guessNounForms(lemma, selectedGender(p))
                : pos === 'verb' ? guessVerbForms(lemma) : null;
    if (!guess) return false;
    for (const [key, value] of Object.entries(guess)) {
        const input = el(p, `form-${key}`);
        if (input && !input.value.trim()) input.value = value;
    }
    return true;
}

export function readWordForm(p) {
    const pos = el(p, 'pos').value;
    const forms = {};
    for (const [key] of formsFor(pos)) {
        const v = el(p, `form-${key}`).value.trim();
        if (v) forms[key] = v;
    }
    return {
        original: el(p, 'no').value.trim(),
        translate: el(p, 'ru').value.trim(),
        example: el(p, 'example').value.trim(),
        exampleTranslate: el(p, 'ex-ru').value.trim(),
        tags: sanitizeTags(el(p, 'tags').value.split(',')),
        pos,
        gender: pos === 'noun' ? selectedGender(p) : '',
        forms,
    };
}

export function fillWordForm(p, w = {}) {
    el(p, 'no').value = w.original || '';
    el(p, 'ru').value = w.translate || '';
    el(p, 'example').value = w.example || '';
    el(p, 'ex-ru').value = w.exampleTranslate || '';
    el(p, 'tags').value = (w.tags || []).join(', ');
    el(p, 'pos').value = w.pos || '';
    document.querySelectorAll(`input[name="${p}-gender"]`).forEach(r => { r.checked = r.value === w.gender; });
    for (const [key] of [...NOUN_FORMS, ...VERB_FORMS]) {
        el(p, `form-${key}`).value = (w.pos && w.forms?.[key]) || '';
    }
    syncGrammarVisibility(p);
}

export function clearWordForm(p) {
    // Часть речи оставляем: слова часто добавляют подряд одного типа.
    const pos = el(p, 'pos').value;
    fillWordForm(p, { pos });
}

// Кнопки æ ø å вставляют символ в последнее поле, где был курсор.
let lastTextInput = null;
document.addEventListener('focusin', (e) => {
    if (e.target.matches?.('input[type="text"], textarea')) lastTextInput = e.target;
});

export function insertChar(ch, event, fallback) {
    const target = (lastTextInput && document.body.contains(lastTextInput)) ? lastTextInput : fallback;
    if (!target) return;
    const text = event?.shiftKey ? ch.toUpperCase() : ch;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    target.setRangeText(text, start, end, 'end');
    target.focus();
    target.dispatchEvent(new Event('input', { bubbles: true }));
}

