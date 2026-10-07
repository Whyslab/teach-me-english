// Слова со скриншота (Lingu и похожие карточки). Сервер распознаёт текст и
// готовит слова (POST /api/import/screenshot), здесь — окно проверки:
// галочки, правка перевода, уже имеющиеся слова отмечены и не добавляются.
import { state, saveWords } from './store.js';
import { normalizeWord } from './srs.js';
import { GENDERS, POS, displayWord } from './norsk.js';
import { dedupeKey } from './format.js';
import { escapeHtml, escapeAttr, plural } from './util.js';
import { $, showToast, openModal, closeModal } from './ui.js';
import { renderList } from './list.js';

const TAG = 'lingu';
const TYPES = ['image/png', 'image/jpeg', 'image/webp'];
let items = [];
let busy = false;

const wordsWord = (n) => plural(n, ['слово', 'слова', 'слов']);

// Есть ли слово уже в словаре (как при обычном добавлении: слово + часть речи).
function existing(item) {
    const key = dedupeKey(item.original, item.pos);
    return state.words.find(w => dedupeKey(w.original, w.pos) === key);
}

export async function importScreenshot(file) {
    if (busy) return;
    if (!file || !TYPES.includes(file.type)) {
        showToast('Нужна картинка PNG, JPEG или WebP', 'warning');
        return;
    }
    busy = true;
    closeModal('import-modal');
    $('shot-status').textContent = '⏳ Распознаю текст и ищу слова в словаре… (несколько секунд)';
    $('shot-list').innerHTML = '';
    $('shot-add').hidden = true;
    openModal('shot-modal');
    try {
        const res = await fetch('/api/import/screenshot', {
            method: 'POST', headers: { 'Content-Type': file.type }, body: file,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        items = (data.items || []).map(it => ({ ...it, dup: existing(it), checked: !existing(it) }));
        render();
    } catch (e) {
        $('shot-status').textContent = `Не получилось: ${e.message}. Сервер запущен?`;
    } finally {
        busy = false;
    }
}

function render() {
    const fresh = items.filter(it => !it.dup).length;
    $('shot-status').textContent = !items.length
        ? 'Слов не нашёл. Нужен скриншот карточек: слово, объяснение, пример в кавычках.'
        : `Нашёл ${items.length} ${wordsWord(items.length)}` +
          (items.length - fresh ? `, из них уже в словаре: ${items.length - fresh}` : '') +
          '. Проверь перевод — он машинный.';
    $('shot-list').innerHTML = items.map((it, i) => {
        const gram = it.pos === 'noun' && GENDERS[it.gender] ? `${GENDERS[it.gender].article} · ${POS.noun}` : (POS[it.pos] || '');
        const forms = Object.values(it.forms || {}).join(' · ');
        return `
        <div class="shot-row${it.dup ? ' dup' : ''}">
            <input type="checkbox" class="shot-check" data-index="${i}" ${it.checked ? 'checked' : ''} ${it.dup ? 'disabled' : ''} aria-label="Добавить">
            <div class="shot-body">
                <div class="shot-word"><b lang="nb">${escapeHtml(displayWord(it))}</b>
                    <span class="shot-gram">${escapeHtml(gram)}${it.dup ? ' · <em>уже есть</em>' : ''}</span></div>
                <input type="text" class="shot-tr" data-index="${i}" value="${escapeAttr(it.dup ? it.dup.translate : it.translate)}"
                       placeholder="перевод" ${it.dup ? 'disabled' : ''} aria-label="Перевод">
                ${forms ? `<div class="shot-meta" lang="nb">${escapeHtml(forms)}</div>` : ''}
                ${it.definition ? `<div class="shot-meta" lang="nb">💬 ${escapeHtml(it.definition)}</div>` : ''}
                ${it.example ? `<div class="shot-meta" lang="nb">“${escapeHtml(it.example)}”</div>` : ''}
                ${it.exampleTranslate ? `<div class="shot-meta">${escapeHtml(it.exampleTranslate)}</div>` : ''}
            </div>
        </div>`;
    }).join('');
    $('shot-add').hidden = !fresh;
    updateAddButton();
}

function updateAddButton() {
    const n = items.filter(it => it.checked && !it.dup).length;
    $('shot-add').textContent = n ? `Добавить ${n} ${wordsWord(n)}` : 'Ничего не выбрано';
    $('shot-add').disabled = !n;
}

function addChecked() {
    const chosen = items.filter(it => it.checked && !it.dup);
    const missing = chosen.filter(it => !it.translate.trim());
    if (missing.length) {
        showToast(`Впиши перевод: ${missing.map(it => it.original).join(', ')}`, 'warning', 5000);
        return;
    }
    const now = Date.now();
    chosen.forEach((it, k) => {
        state.words.push(normalizeWord({
            original: it.original, translate: it.translate.trim(),
            example: it.example, exampleTranslate: it.exampleTranslate,
            pos: it.pos, gender: it.gender, forms: it.forms, tags: [TAG],
            id: now + k, addedAt: now + k, nextReview: now, level: 0,
        }));
    });
    saveWords();
    renderList();
    closeModal('shot-modal');
    items = [];
    showToast(`Добавлено ${chosen.length} ${wordsWord(chosen.length)} с тегом «${TAG}»`, 'success');
}

export const shotActions = {
    'shot-add'() { addChecked(); },
};

// Картинка из буфера обмена (Ctrl+V), если в этот момент не печатают в поле.
function imageFromPaste(e) {
    for (const item of e.clipboardData?.items || []) {
        if (item.kind === 'file' && TYPES.includes(item.type)) return item.getAsFile();
    }
    return null;
}

export function initShot() {
    $('shot-upload')?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) importScreenshot(file);
    });
    $('shot-list')?.addEventListener('change', (e) => {
        const i = Number(e.target.dataset.index);
        if (!items[i]) return;
        if (e.target.matches('.shot-check')) items[i].checked = e.target.checked;
        updateAddButton();
    });
    $('shot-list')?.addEventListener('input', (e) => {
        const i = Number(e.target.dataset.index);
        if (items[i] && e.target.matches('.shot-tr')) items[i].translate = e.target.value;
    });
    document.addEventListener('paste', (e) => {
        if (e.target.matches?.('input, textarea')) return;
        const file = imageFromPaste(e);
        if (!file) return;
        e.preventDefault();
        importScreenshot(file);
    });
}
