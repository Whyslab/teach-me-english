// Список слов на главной: фильтры, сортировка, карточки, массовые действия.
import { state, saveWords, introducedToday } from './store.js';
import { selectSession, isNew, isHard, normalizeWord } from './srs.js';
import { escapeHtml, escapeAttr, highlightMatch, plural } from './util.js';
import { GENDERS, displayWord, formsLine, lookupUrls } from './norsk.js';
import { $, showToast, showConfirm, openModal, closeModal, speak } from './ui.js';
import { fillWordForm, readWordForm, syncGrammarVisibility } from './wordform.js';

const PAGE = 100;

export const view = {
    sort: 'default',
    tag: null,
    level: 'all',
    search: '',
    shown: PAGE,
    bulk: false,
    selected: new Set(),
    openTranslations: new Set(),
};

// Вызывается после любого изменения списка, чтобы обновить остальной экран.
let afterRender = () => {};
export function onListRendered(fn) { afterRender = fn; }

// ---------------------------------------------------------------------------
// Выборка
// ---------------------------------------------------------------------------
export function filteredWords() {
    const q = view.search;
    return state.words.filter(w => {
        if (view.tag && !(w.tags || []).includes(view.tag)) return false;
        if (view.level !== 'all' && (w.level || 0) !== view.level) return false;
        if (q) {
            const o = (w.original || '').toLowerCase();
            const t = (w.translate || '').toLowerCase();
            if (!o.includes(q) && !t.includes(q)) return false;
        }
        return true;
    });
}

function sortedWords() {
    const list = filteredWords();
    const collator = new Intl.Collator('nb');
    switch (view.sort) {
        case 'level-asc':  return [...list].sort((a, b) => (a.level || 0) - (b.level || 0));
        case 'level-desc': return [...list].sort((a, b) => (b.level || 0) - (a.level || 0));
        case 'alpha':      return [...list].sort((a, b) => collator.compare(a.original, b.original));
        case 'review':     return [...list].sort((a, b) => (a.nextReview || 0) - (b.nextReview || 0));
        case 'newest':     return [...list].sort((a, b) => (b.addedAt || b.id) - (a.addedAt || a.id));
        default:           return list;
    }
}

// ---------------------------------------------------------------------------
// Разметка карточки
// ---------------------------------------------------------------------------
function cardHtml(w, now) {
    const level = w.level || 0;
    const due = !w.nextReview || w.nextReview <= now;
    const classes = ['card'];
    if (due && level < 5 && !isNew(w)) classes.push('needs-review');
    if (level === 5) classes.push('learned');
    if (view.selected.has(w.id)) classes.push('bulk-selected');

    const q = view.search;
    // Артикль показываем цветным чипом рода перед словом, а не текстом.
    const wordHtml = q ? highlightMatch(w.original, q) : escapeHtml(w.original);
    const transHtml = q ? highlightMatch(w.translate, q) : escapeHtml(w.translate);
    const showTrans = q || view.openTranslations.has(w.id);

    const article = w.pos === 'noun' && GENDERS[w.gender]
        ? `<span class="gram-chip g-${w.gender}" title="${GENDERS[w.gender].ru} род">${GENDERS[w.gender].article}</span> `
        : '';
    const gram = w.pos === 'verb' ? ' <span class="gram-chip g-v" title="глагол">verb</span>' : '';
    const forms = formsLine(w);
    const tags = (w.tags || []).map(t => `<span class="word-tag">${escapeHtml(t)}</span>`).join('');
    const badge = isNew(w)
        ? '<span class="level-indicator new">новое</span>'
        : `<span class="level-indicator">Ур. ${level}</span>`;
    const hard = isHard(w) ? '<span class="hard-mark" title="Трудное слово">⚠️</span>' : '';
    const urls = lookupUrls(w.original);
    const id = escapeAttr(w.id);

    return `
    <div class="${classes.join(' ')}" data-action="card" data-id="${id}">
        <div class="card-content">
            ${badge}
            <span class="original" lang="nb">${article}${wordHtml}</span>${gram}${hard}
            <span class="arrow">→</span>
            <span class="translation${showTrans ? '' : ' hidden'}">${transHtml}</span>
            ${showTrans && forms ? `<span class="forms-inline" lang="nb">${escapeHtml(forms)}</span>` : ''}
            ${tags ? `<span class="card-tags">${tags}</span>` : ''}
        </div>
        <div class="actions">
            <button class="icon-btn" data-action="speak-word" data-id="${id}" title="Прослушать (синтез речи)" aria-label="Прослушать">🔊</button>
            <a class="icon-btn" href="${escapeAttr(urls.forvo)}" target="_blank" rel="noopener noreferrer" title="Живое произношение на Forvo" aria-label="Forvo">🗣</a>
            <a class="icon-btn" href="${escapeAttr(urls.ordbok)}" target="_blank" rel="noopener noreferrer" title="Род и формы в Ordbøkene" aria-label="Ordbøkene">📘</a>
            <button class="icon-btn" data-action="tatoeba-word" data-id="${id}" title="Примеры с Tatoeba" aria-label="Примеры">📖</button>
            <button class="icon-btn" data-action="edit-word" data-id="${id}" title="Редактировать" aria-label="Редактировать">✏️</button>
            <button class="icon-btn" data-action="history-word" data-id="${id}" title="История ответов" aria-label="История">📈</button>
            <button class="icon-btn danger" data-action="delete-word" data-id="${id}" title="Удалить" aria-label="Удалить">✕</button>
        </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Рендер
// ---------------------------------------------------------------------------
export function renderList() {
    const container = $('cards-container');
    if (!container) return;
    const now = Date.now();
    const list = sortedWords();
    const page = list.slice(0, view.shown);

    if (list.length === 0) {
        container.innerHTML = state.words.length === 0
            ? `<div class="empty-state">Словарь пуст. Добавь первое слово — например, <b lang="nb">et hus</b> — дом —
               или <button class="outline-btn small" data-action="import-a1">загрузи колоду A1</button>.</div>`
            : `<div class="empty-state">Ничего не найдено.
               <button class="outline-btn small" data-action="reset-filters">Сбросить фильтры</button></div>`;
    } else {
        container.innerHTML = page.map(w => cardHtml(w, now)).join('');
    }

    const more = $('show-more');
    if (more) {
        const rest = list.length - page.length;
        more.hidden = rest <= 0;
        more.textContent = `Показать ещё ${Math.min(rest, PAGE)} из ${rest}`;
    }

    renderTagBar();
    renderLevelStats();
    renderProgress();
    renderSortBar();
    renderStartButton();
    renderBulkBar();
    afterRender();
}

function renderTagBar() {
    const bar = $('tag-filter-bar');
    const chips = $('tag-chips');
    if (!bar || !chips) return;
    const tags = [...new Set(state.words.flatMap(w => w.tags || []))].sort((a, b) => a.localeCompare(b, 'nb'));
    bar.hidden = tags.length === 0;
    chips.innerHTML = `
        <button class="tag-chip${!view.tag ? ' active' : ''}" data-action="filter-tag" data-tag="">Все</button>
        ${tags.map(t => `<button class="tag-chip${view.tag === t ? ' active' : ''}" data-action="filter-tag" data-tag="${escapeAttr(t)}">${escapeHtml(t)}</button>`).join('')}`;
}

function renderLevelStats() {
    const el = $('level-stats');
    if (!el) return;
    const counts = [0, 0, 0, 0, 0, 0];
    let fresh = 0;
    for (const w of state.words) {
        if (isNew(w)) fresh++;
        else counts[Math.min(5, Math.max(0, w.level || 0))]++;
    }
    const item = (value, label, level, extra = '') => `
        <button class="stat-item${view.level === level ? ' active' : ''} ${extra}" data-action="filter-level" data-level="${level}">
            <span class="stat-value">${value}</span><span class="stat-label">${label}</span>
        </button>`;
    el.innerHTML =
        counts.map((c, lvl) => item(c, lvl === 0 && fresh ? `Ур. 0 · +${fresh} нов.` : `Ур. ${lvl}`, lvl, lvl === 5 ? 'lvl5' : '')).join('') +
        item(state.words.length, 'Все', 'all', 'all');
}

function renderProgress() {
    const bar = $('progress-bar');
    if (!bar) return;
    const total = state.words.length * 5;
    const points = state.words.reduce((s, w) => s + (w.level || 0), 0);
    const pct = total ? Math.round(points / total * 100) : 0;
    bar.style.width = `${pct}%`;
    $('progress-percent').textContent = `${pct}%`;
    const learned = state.words.filter(w => (w.level || 0) >= 5).length;
    $('progress-stat').textContent = `выучено ${learned} из ${state.words.length}`;
}

function renderSortBar() {
    document.querySelectorAll('[data-action="sort"]').forEach(b => {
        b.classList.toggle('active', b.dataset.sort === view.sort);
    });
}

export function sessionPreview() {
    return selectSession(state.words, {
        newLimit: state.settings.newPerDay,
        introducedToday: introducedToday(),
    });
}

function renderStartButton() {
    const btn = $('start-training-btn');
    if (!btn) return;
    const { reviews, fresh } = sessionPreview();
    const hint = $('start-hint');
    if (reviews.length + fresh.length > 0) {
        btn.textContent = `Начать тренировку · ${reviews.length + fresh.length}`;
        btn.classList.remove('done');
    } else {
        btn.textContent = 'На сегодня всё ✓';
        btn.classList.add('done');
    }
    if (hint) {
        const newLeft = Math.max(0, state.settings.newPerDay - introducedToday());
        const waiting = state.words.filter(isNew).length;
        hint.textContent = `повторить: ${reviews.length} · новых: ${fresh.length}` +
            (waiting > fresh.length ? ` (ещё ${waiting - fresh.length} ждут; лимит ${state.settings.newPerDay}/день, осталось ${newLeft})` : '');
    }
}

function renderBulkBar() {
    const panel = $('bulk-actions-panel');
    const btn = $('bulk-select-btn');
    if (panel) panel.hidden = !view.bulk;
    if (btn) {
        btn.textContent = view.bulk ? '✕ Отмена' : '☑ Выбрать';
        btn.classList.toggle('active', view.bulk);
    }
    const cnt = $('bulk-count');
    if (cnt) cnt.textContent = view.selected.size ? `${view.selected.size} выбрано` : 'Выбери слова';
}

// ---------------------------------------------------------------------------
// Удаление и отмена
// ---------------------------------------------------------------------------
let undo = null;

function showUndo(words, positions) {
    undo = { words, positions };
    const toast = $('undo-toast');
    $('undo-text').textContent = words.length === 1
        ? `«${words[0].original}» удалено`
        : `Удалено ${words.length} ${plural(words.length, ['слово', 'слова', 'слов'])}`;
    toast.hidden = false;
    clearTimeout(showUndo.timer);
    showUndo.timer = setTimeout(() => { toast.hidden = true; undo = null; }, 6000);
}

function restoreDeleted() {
    if (!undo) return;
    const pairs = undo.words.map((w, i) => [undo.positions[i], w]).sort((a, b) => a[0] - b[0]);
    for (const [pos, w] of pairs) state.words.splice(Math.min(pos, state.words.length), 0, w);
    undo = null;
    $('undo-toast').hidden = true;
    saveWords();
    renderList();
}

function removeWords(ids) {
    const removed = [];
    const positions = [];
    state.words = state.words.filter((w, i) => {
        if (ids.has(w.id)) { removed.push(w); positions.push(i); return false; }
        return true;
    });
    saveWords();
    renderList();
    if (removed.length) showUndo(removed, positions);
}

// ---------------------------------------------------------------------------
// Редактирование
// ---------------------------------------------------------------------------
let editingId = null;

function openEdit(id) {
    const w = findWord(id);
    if (!w) return;
    editingId = w.id;
    fillWordForm('edit', w);
    openModal('edit-modal');
}

function saveEdit() {
    const w = findWord(editingId);
    if (!w) return;
    const data = readWordForm('edit');
    if (!data.original || !data.translate) {
        showToast('Слово и перевод не могут быть пустыми', 'warning');
        return;
    }
    Object.assign(w, normalizeWord({ ...w, ...data }));
    saveWords();
    closeModal('edit-modal');
    renderList();
    showToast('Сохранено', 'success', 1500);
}

export function findWord(id) {
    return state.words.find(w => String(w.id) === String(id));
}

// ---------------------------------------------------------------------------
// Действия (data-action)
// ---------------------------------------------------------------------------
export const listActions = {
    'card'(el) {
        const id = Number(el.dataset.id);
        if (view.bulk) {
            if (view.selected.has(id)) view.selected.delete(id); else view.selected.add(id);
            el.classList.toggle('bulk-selected', view.selected.has(id));
            renderBulkBar();
            return;
        }
        if (view.openTranslations.has(id)) view.openTranslations.delete(id);
        else view.openTranslations.add(id);
        renderList();
    },
    'speak-word'(el) {
        const w = findWord(el.dataset.id);
        if (w) speak(displayWord(w));
    },
    'edit-word'(el) { openEdit(el.dataset.id); },
    'save-edit'() { saveEdit(); },
    'delete-word'(el) {
        const w = findWord(el.dataset.id);
        if (w) removeWords(new Set([w.id]));
    },
    'undo-delete'() { restoreDeleted(); },
    'filter-tag'(el) {
        view.tag = el.dataset.tag || null;
        view.shown = PAGE;
        renderList();
    },
    'filter-level'(el) {
        const lvl = el.dataset.level;
        const next = lvl === 'all' ? 'all' : Number(lvl);
        view.level = view.level === next ? 'all' : next;
        view.shown = PAGE;
        renderList();
    },
    'sort'(el) {
        view.sort = el.dataset.sort;
        renderList();
    },
    'show-more'() {
        view.shown += PAGE;
        renderList();
    },
    'reset-filters'() {
        view.tag = null;
        view.level = 'all';
        view.search = '';
        const s = $('search-input');
        if (s) s.value = '';
        renderList();
    },
    'bulk-toggle'() {
        view.bulk = !view.bulk;
        view.selected.clear();
        renderList();
    },
    'bulk-select-all'() {
        filteredWords().forEach(w => view.selected.add(w.id));
        renderList();
    },
    'bulk-clear'() {
        view.selected.clear();
        renderList();
    },
    'bulk-tag'() {
        if (!view.selected.size) return;
        $('bulk-tag-input').value = '';
        openModal('bulk-tag-modal');
    },
    'bulk-tag-apply'() {
        const tag = $('bulk-tag-input').value.trim().slice(0, 50);
        if (!tag) return;
        for (const w of state.words) {
            if (view.selected.has(w.id) && !w.tags.includes(tag)) w.tags.push(tag);
        }
        saveWords();
        closeModal('bulk-tag-modal');
        showToast(`Тег «${tag}» добавлен к ${view.selected.size} ${plural(view.selected.size, ['слову', 'словам', 'словам'])}`, 'success');
        view.selected.clear();
        view.bulk = false;
        renderList();
    },
    async 'bulk-reset'() {
        if (!view.selected.size) return;
        if (!await showConfirm(`Сбросить прогресс у ${view.selected.size} ${plural(view.selected.size, ['слова', 'слов', 'слов'])}?`, 'Сбросить')) return;
        for (const w of state.words) {
            if (!view.selected.has(w.id)) continue;
            Object.assign(w, { level: 0, nextReview: Date.now(), forgetStep: 0, sm2Reps: 0, sm2Interval: 1, sm2EF: 2.5, history: [] });
        }
        saveWords();
        view.selected.clear();
        view.bulk = false;
        renderList();
    },
    async 'bulk-delete'() {
        if (!view.selected.size) return;
        if (!await showConfirm(`Удалить ${view.selected.size} ${plural(view.selected.size, ['слово', 'слова', 'слов'])}?`, 'Удалить')) return;
        const ids = new Set(view.selected);
        view.selected.clear();
        view.bulk = false;
        removeWords(ids);
    },
};

export function initList() {
    const search = $('search-input');
    let t = null;
    search?.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => {
            view.search = search.value.trim().toLowerCase();
            view.shown = PAGE;
            renderList();
        }, 120);
    });
    $('edit-pos')?.addEventListener('change', () => syncGrammarVisibility('edit'));
}

