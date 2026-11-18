// Форма слова — одна разметка для добавления на главной и для окна
// редактирования. Раньше редактирование шло через contenteditable прямо в
// списке, и грамматические поля там было не показать.
import { GENDERS, POS, NOUN_FORMS, VERB_FORMS, ADJ_FORMS, formsFor, formsLine, guessNounForms, guessAdjForms } from './norsk.js';
import { sanitizeTags, escapeHtml } from './util.js';

const LETTERS = ['æ', 'ø', 'å'];

// Главное сверху: слово, перевод, пример. Часть речи, род, формы и теги
// подставляются сами и спрятаны в «Грамматика и теги» — раскрыть, чтобы
// проверить или поправить. В окне редактирования раскрыто сразу.
export function wordFormHtml(prefix, { open = false } = {}) {
    const p = prefix;
    const formInputs = (list, cls) => list.map(([key, no, ru]) => `
        <label class="form-field ${cls}">
            <span class="form-label">${no} <em>${ru}</em></span>
            <input type="text" id="${p}-form-${key}" lang="nb" maxlength="60" autocomplete="off" spellcheck="false">
        </label>`).join('');

    return `
    <div class="word-form" data-prefix="${p}">
        <div class="no-row">
            <input type="text" id="${p}-no" placeholder="слово по-норвежски: et land, å bo…" lang="nb" maxlength="70"
                   autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" aria-label="Норвежское слово">
            <span class="no-letters" aria-label="Норвежские буквы">
                ${LETTERS.map(ch => `<button type="button" class="no-letter-btn" data-action="insert-char" data-char="${ch}" title="${ch} (Shift — ${ch.toUpperCase()})" tabindex="-1">${ch}</button>`).join('')}
            </span>
        </div>
        <div class="word-preview" id="${p}-preview"></div>
        <input type="text" id="${p}-ru" placeholder="перевод" maxlength="500" aria-label="Перевод" enterkeyhint="done">
        <input type="text" id="${p}-example" placeholder="пример по-норвежски (необязательно)" lang="nb" aria-label="Пример">
        <input type="text" id="${p}-ex-ru" placeholder="перевод примера" aria-label="Перевод примера">

        <details class="more" id="${p}-more"${open ? ' open' : ''}>
            <summary>Грамматика и теги</summary>
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
                <button type="button" class="btn btn-ghost btn-sm" id="${p}-dict" data-action="dict-fill"
                        title="Часть речи, род и формы из официального словаря Ordbøkene">Из словаря</button>
                <button type="button" class="btn btn-ghost btn-sm" id="${p}-guess" data-action="guess-forms" hidden
                        title="Заполнить регулярные формы. Неправильные слова (bok → bøker, liten → små) проверь в Ordbøkene.">Формы по правилу</button>
            </div>
            <div class="forms-grid" id="${p}-forms-noun" hidden>${formInputs(NOUN_FORMS, 'noun')}</div>
            <div class="forms-grid" id="${p}-forms-verb" hidden>${formInputs(VERB_FORMS, 'verb')}</div>
            <div class="forms-grid" id="${p}-forms-adj" hidden>${formInputs(ADJ_FORMS, 'adj')}</div>
            <input type="text" id="${p}-tags" placeholder="теги через запятую: A1, familie, reise" aria-label="Теги">
        </details>
    </div>`;
}

const el = (p, id) => document.getElementById(`${p}-${id}`);

export function syncGrammarVisibility(p) {
    const pos = el(p, 'pos').value;
    el(p, 'gender-wrap').hidden = pos !== 'noun';
    el(p, 'forms-noun').hidden = pos !== 'noun';
    el(p, 'forms-verb').hidden = pos !== 'verb';
    el(p, 'forms-adj').hidden = pos !== 'adj';
    // Для глаголов подсказки нет: прошедшее время по правилу не угадать.
    el(p, 'guess').hidden = !(pos === 'noun' || pos === 'adj');
    renderPreview(p);
}

// Строка над переводом: род, часть речи и формы — видно, что подставилось,
// не раскрывая «Грамматику».
export function renderPreview(p) {
    const box = el(p, 'preview');
    if (!box) return;
    const pos = el(p, 'pos').value;
    const gender = selectedGender(p);
    const forms = {};
    for (const [key] of formsFor(pos)) {
        const v = el(p, `form-${key}`).value.trim();
        if (v) forms[key] = v;
    }
    const parts = [];
    if (pos === 'noun' && GENDERS[gender]) parts.push(`<span class="gram-chip g-${gender}">${GENDERS[gender].article}</span>`);
    if (pos) parts.push(`<span>${escapeHtml(POS[pos] || '')}</span>`);
    const line = formsLine({ pos, forms });
    if (line) parts.push(`<span class="forms-inline" lang="nb">${escapeHtml(line)}</span>`);
    box.innerHTML = parts.join('');
}

// Подсказка с сервера (/api/word/suggest) → поля формы. Заполняет только
// пустое: что пользователь уже вписал сам, не трогаем.
// Что подставила подсказка: при смене слова это убирается, а вписанное
// руками остаётся.
const autoFilled = {};

export function clearAutoFilled(p) {
    const auto = autoFilled[p];
    if (!auto) return;
    for (const [id, value] of Object.entries(auto.fields)) {
        const input = el(p, id);
        if (input && input.value === value) input.value = '';
    }
    if (auto.pos && el(p, 'pos').value === auto.pos) el(p, 'pos').value = '';
    if (auto.gender && selectedGender(p) === auto.gender) {
        document.querySelectorAll(`input[name="${p}-gender"]`).forEach(r => { r.checked = false; });
    }
    delete autoFilled[p];
    syncGrammarVisibility(p);
}

export function applySuggestion(p, d, query = '', { keepWord = false } = {}) {
    if (!d) return;
    // Кнопка «Из словаря» потом спросит то же, что спросила подсказка:
    // «en uttale», а не «uttale», которое словарь счёл бы глаголом.
    if (query && d.original) lastFill[p] = { original: d.original, query };
    const auto = autoFilled[p] = { fields: {}, pos: '', gender: '' };
    const fill = (id, value) => {
        const input = el(p, id);
        if (input && value && !input.value.trim()) {
            input.value = value;
            auto.fields[id] = value;
            input.classList.add('auto-filled');
            setTimeout(() => input.classList.remove('auto-filled'), 1500);
        }
    };
    if (d.original && !keepWord) el(p, 'no').value = d.original;
    if (d.pos && !el(p, 'pos').value) { el(p, 'pos').value = d.pos; auto.pos = d.pos; }
    if (d.gender && !selectedGender(p)) {
        auto.gender = d.gender;
        document.querySelectorAll(`input[name="${p}-gender"]`).forEach(r => { r.checked = r.value === d.gender; });
    }
    for (const [key, value] of Object.entries(d.forms || {})) fill(`form-${key}`, value);
    fill('ru', d.translate);
    if (!el(p, 'example').value.trim() && !el(p, 'ex-ru').value.trim()) {
        fill('example', d.example);
        fill('ex-ru', d.exampleTranslate);
    }
    syncGrammarVisibility(p);
}

function selectedGender(p) {
    return document.querySelector(`input[name="${p}-gender"]:checked`)?.value || '';
}

export function guessForms(p) {
    const pos = el(p, 'pos').value;
    const lemma = el(p, 'no').value;
    const guess = pos === 'noun' ? guessNounForms(lemma, selectedGender(p))
                : pos === 'adj' ? guessAdjForms(lemma) : null;
    if (!guess) return false;
    for (const [key, value] of Object.entries(guess)) {
        const input = el(p, `form-${key}`);
        if (input && !input.value.trim()) input.value = value;
    }
    return true;
}

// Часть речи, род и формы из Ordbøkene (через сервер, /api/ordbok).
// overwrite — по кнопке: заменить и то, что уже заполнено; при уходе из
// поля слова заполняются только пустые поля.
// Возвращает разбор словаря или null (нет слова, нет сети, слово успели поменять).
// Один запрос на одно слово: уход из поля и нажатие кнопки сразу за ним
// (фокус ещё в поле) не должны давать два запроса — и кнопка не должна
// «съедаться», как было, когда она блокировалась на время запроса.
const lookups = new Map();
function lookupWord(raw) {
    if (!lookups.has(raw)) {
        const job = fetch(`/api/ordbok?w=${encodeURIComponent(raw)}`, { signal: AbortSignal.timeout(15000) })
            .then(res => (res.ok ? res.json() : null))
            .catch(() => null);
        lookups.set(raw, job);
        // Неудачу (сеть) не запоминаем — следующая попытка спросит снова.
        job.then(d => { if (!d) lookups.delete(raw); });
        if (lookups.size > 200) lookups.delete(lookups.keys().next().value);
    }
    return lookups.get(raw);
}

// Какой запрос заполнил поле: «en uttale» превращается в «uttale», и
// повторный запрос по «uttale» без артикля вернул бы уже глагол.
const lastFill = {};

export async function fillFromDictionary(p, { overwrite = false } = {}) {
    const typed = el(p, 'no').value.trim();
    if (!typed) return null;
    const raw = lastFill[p]?.original === typed ? lastFill[p].query : typed;
    const d = await lookupWord(raw);
    if (!d) return null;
    // Пока шёл запрос, слово могли исправить — тогда ответ уже не про него.
    if (el(p, 'no').value.trim() !== typed) return null;
    if (!overwrite && el(p, 'pos').value && el(p, 'pos').value !== d.pos) return null;
    el(p, 'no').value = d.original;
    lastFill[p] = { original: d.original, query: raw };
    el(p, 'pos').value = d.pos;
    if (d.gender) {
        document.querySelectorAll(`input[name="${p}-gender"]`).forEach(r => { r.checked = r.value === d.gender; });
    }
    for (const [key, value] of Object.entries(d.forms || {})) {
        const input = el(p, `form-${key}`);
        if (input && (overwrite || !input.value.trim())) input.value = value;
    }
    syncGrammarVisibility(p);
    el(p, 'pos').classList.add('auto-filled');
    setTimeout(() => el(p, 'pos').classList.remove('auto-filled'), 1500);
    return d;
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
    for (const [key] of [...NOUN_FORMS, ...VERB_FORMS, ...ADJ_FORMS]) {
        el(p, `form-${key}`).value = (w.pos && w.forms?.[key]) || '';
    }
    syncGrammarVisibility(p);
}

export function clearWordForm(p) {
    delete autoFilled[p];
    // Часть речи раньше оставалась от прошлого слова «для удобства» — и глаголы,
    // добавленные после существительного, сохранялись как существительные.
    fillWordForm(p, {});
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

