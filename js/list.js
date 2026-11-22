// Список слов на главной: фильтры, сортировка, карточки, массовые действия.
import { state, saveWords, introducedToday } from './store.js';
import { selectSession, isNew, isHard, normalizeWord } from './srs.js';
import { escapeHtml, escapeAttr, highlightMatch, plural } from './util.js';
import { GENDERS, POS, displayWord, formsLine, lookupUrls } from './norsk.js';
import { $, showToast, showConfirm, openModal, closeModal, speak } from './ui.js';
import { fillWordForm, readWordForm, syncGrammarVisibility } from './wordform.js';

const PAGE = 100;

// Скрыть переводы в списке (самопроверка) — помним на этом устройстве.
function readHideTrans() {
    try { return localStorage.getItem('hideTranslations') === '1'; } catch { return false; }
}

export const view = {
    sort: 'newest',
    tag: null,
    level: 'all',
    search: '',
    shown: PAGE,
    bulk: false,
    selected: new Set(),
    hideTranslations: readHideTrans(),
};

// Группы уровней для фильтра: новое (ни разу не отвечали), учу (ур. 0–4),
// выучено (ур. 5 — интервал от 21 дня).
const LEVEL_GROUPS = [
    ['all', 'Все', () => true],
    ['new', 'Новые', (w) => isNew(w)],
    ['learning', 'Учу', (w) => !isNew(w) && (w.level || 0) < 5],
    ['learned', 'Выучено', (w) => !isNew(w) && (w.level || 0) >= 5],
];
const levelTest = (key) => (LEVEL_GROUPS.find(g => g[0] === key) || LEVEL_GROUPS[0])[2];

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
        if (view.level !== 'all' && !levelTest(view.level)(w)) return false;
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
function levelBars(w) {
    if (isNew(w)) return '<span class="level-indicator new">новое</span>';
    const level = Math.min(5, Math.max(0, w.level || 0));
    const bars = [1, 2, 3, 4, 5].map(i => `<i class="${i <= level ? 'on' : ''}"></i>`).join('');
    return `<span class="lvl${level === 5 ? ' done' : ''}" title="Уровень ${level} из 5">${bars}</span>`;
}

function cardHtml(w, now) {
    const level = w.level || 0;
    const due = !w.nextReview || w.nextReview <= now;
    const classes = ['card'];
    if (due && level < 5 && !isNew(w)) classes.push('needs-review');
    if (level === 5) classes.push('learned');
    if (view.selected.has(w.id)) classes.push('bulk-selected');

    const q = view.search;
    const wordHtml = q ? highlightMatch(w.original, q) : escapeHtml(w.original);
    const transHtml = q ? highlightMatch(w.translate, q) : escapeHtml(w.translate);
    const hideTrans = view.hideTranslations && !q;

    // Артикль — цветным чипом рода перед словом, а не текстом.
    const article = w.pos === 'noun' && GENDERS[w.gender]
        ? `<span class="gram-chip g-${w.gender}" title="${GENDERS[w.gender].ru} род">${GENDERS[w.gender].article}</span>`
        : '';
    const hard = isHard(w) ? '<span class="hard-mark" title="Трудное слово"><svg class="ic"><use href="#i-alert"/></svg></span>' : '';
    const tags = (w.tags || []).map(t => `<span class="word-tag">${escapeHtml(t)}</span>`).join('');
    const id = escapeAttr(w.id);

    return `
    <div class="${classes.join(' ')}" data-action="card" data-id="${id}">
        <div class="card-main">
            <div class="card-line">${article}<span class="original" lang="nb">${wordHtml}</span>${hard}${tags}</div>
            <div class="translation${hideTrans ? ' hidden' : ''}">${transHtml}</div>
        </div>
        <div class="card-side">
            ${levelBars(w)}
            <button class="icon-btn sm" data-action="speak-word" data-id="${id}" title="Прослушать" aria-label="Прослушать"><svg class="ic"><use href="#i-volume"/></svg></button>
            <button class="icon-btn sm" data-action="edit-word" data-id="${id}" title="Редактировать" aria-label="Редактировать"><svg class="ic"><use href="#i-pencil"/></svg></button>
        </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Окно слова: всё о слове и все действия с ним в одном месте вместо семи
// значков в каждой строке списка.
// ---------------------------------------------------------------------------
const DAY = 24 * 60 * 60 * 1000;
function whenText(ts) {
    if (!ts) return 'сейчас';
    const days = Math.round((ts - Date.now()) / DAY);
    if (days <= 0) return 'сегодня';
    if (days === 1) return 'завтра';
    return `через ${days} ${plural(days, ['день', 'дня', 'дней'])}`;
}

function openWord(id) {
    const w = findWord(id);
    if (!w) return;
    const sid = escapeAttr(w.id);
    const urls = lookupUrls(w.original);
    const gram = [
        w.pos === 'noun' && GENDERS[w.gender] ? `<span class="gram-chip g-${w.gender}">${GENDERS[w.gender].article}</span> ${GENDERS[w.gender].ru} род` : '',
        w.pos && POS[w.pos] && w.pos !== 'noun' ? POS[w.pos] : (w.pos === 'noun' && !GENDERS[w.gender] ? POS.noun : ''),
    ].filter(Boolean).join(' · ');
    const forms = formsLine(w);
    const answers = (w.history || []).length;
    $('wd-title').textContent = displayWord(w);
    $('wd-body').innerHTML = `
        <div class="wd-main">
            <div class="wd-translate">${escapeHtml(w.translate)}</div>
            ${gram ? `<div class="wd-gram">${gram}</div>` : ''}
            ${forms ? `<div class="wd-forms" lang="nb">${escapeHtml(forms)}</div>` : ''}
        </div>
        ${w.example ? `<div class="wd-example">
            <div class="ex-no" lang="nb"><span>${escapeHtml(w.example)}</span>
                <button class="icon-btn sm" data-action="speak-example" data-id="${sid}" aria-label="Прослушать пример"><svg class="ic"><use href="#i-volume"/></svg></button></div>
            ${w.exampleTranslate ? `<div class="ex-ru">${escapeHtml(w.exampleTranslate)}</div>` : ''}
        </div>` : ''}
        <div class="wd-stats">
            <div class="wd-stat"><b>${isNew(w) ? 'новое' : `${w.level || 0} / 5`}</b><span>уровень</span></div>
            <div class="wd-stat"><b>${isNew(w) ? '—' : whenText(w.nextReview)}</b><span>повтор</span></div>
            <div class="wd-stat"><b>${answers}</b><span>${plural(answers, ['ответ', 'ответа', 'ответов'])}</span></div>
        </div>
        <div class="wd-actions">
            <button class="btn btn-ghost" data-action="speak-word" data-id="${sid}"><svg class="ic"><use href="#i-volume"/></svg>Прослушать</button>
            <button class="btn btn-ghost" data-action="edit-word" data-id="${sid}"><svg class="ic"><use href="#i-pencil"/></svg>Изменить</button>
            <button class="btn btn-ghost" data-action="history-word" data-id="${sid}"><svg class="ic"><use href="#i-clock"/></svg>История</button>
            <button class="btn btn-ghost" data-action="tatoeba-word" data-id="${sid}"><svg class="ic"><use href="#i-book"/></svg>Примеры</button>
            <a class="btn btn-ghost" href="${escapeAttr(urls.ordbok)}" target="_blank" rel="noopener noreferrer"><svg class="ic"><use href="#i-external"/></svg>Ordbøkene</a>
            <a class="btn btn-ghost" href="${escapeAttr(urls.forvo)}" target="_blank" rel="noopener noreferrer"><svg class="ic"><use href="#i-external"/></svg>Forvo</a>
            <button class="btn btn-ghost danger" data-action="delete-word" data-id="${sid}"><svg class="ic"><use href="#i-trash"/></svg>Удалить</button>
        </div>`;
    openModal('word-modal');
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
            ? `<div class="empty-state"><b>Словарь пуст</b>Добавь первое слово — например, <span lang="nb">et hus</span> — или загрузи готовую колоду.
               <div class="buttons-row"><button class="btn btn-primary btn-sm" data-action="open-add">Добавить слово</button>
               <button class="btn btn-ghost btn-sm" data-action="import-a1">Колода A1</button></div></div>`
            : `<div class="empty-state">Ничего не найдено.
               <button class="btn btn-ghost btn-sm" data-action="reset-filters">Сбросить фильтры</button></div>`;
    } else {
        container.innerHTML = page.map(w => cardHtml(w, now)).join('');
    }

    const more = $('show-more');
    if (more) {
        const rest = list.length - page.length;
        more.hidden = rest <= 0;
        more.textContent = `Показать ещё ${Math.min(rest, PAGE)} из ${rest}`;
    }

    const cnt = $('words-count');
    if (cnt) cnt.textContent = state.words.length ? String(state.words.length) : '';
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
    el.innerHTML = LEVEL_GROUPS.map(([key, label, fits]) => `
        <button class="stat-item${view.level === key ? ' active' : ''}" data-action="filter-level" data-level="${key}">
            <span class="stat-label">${label}</span><span class="stat-value">${state.words.filter(fits).length}</span>
        </button>`).join('');
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
    $('progress-stat').textContent = state.words.length ? `${Math.round(learned / state.words.length * 100)}% словаря` : '';
    const kt = $('kpi-total');
    if (kt) kt.textContent = state.words.length;
    const kl = $('kpi-learned');
    if (kl) kl.textContent = learned;
}

function renderSortBar() {
    const sel = $('sort-select');
    if (sel) sel.value = view.sort;
    const hide = $('hide-trans');
    if (hide) hide.checked = view.hideTranslations;
}

export function sessionPreview() {
    return selectSession(state.words, {
        newLimit: state.settings.newPerDay,
        introducedToday: introducedToday(),
        pauseNewAt: state.settings.pauseNewAt,
    });
}

function renderStartButton() {
    const btn = $('start-training-btn');
    const lesson = $('lesson-btn');
    if (!btn || !lesson) return;
    const { reviews, fresh, paused } = sessionPreview();
    const total = reviews.length + fresh.length;
    const waiting = state.words.filter(isNew).length;
    const title = $('hero-title');
    if (total > 0) {
        btn.textContent = `Карточки · ${total}`;
        btn.classList.remove('done');
        lesson.textContent = `Продолжить · ${total}`;
        lesson.classList.remove('done');
        if (title) title.textContent = reviews.length ? 'Пора повторить' : 'Новые слова ждут';
    } else {
        btn.textContent = 'На сегодня всё';
        btn.classList.add('done');
        lesson.textContent = 'На сегодня всё';
        lesson.classList.add('done');
        if (title) title.textContent = state.words.length ? 'Всё повторено' : 'Добро пожаловать';
    }
    const due = $('hero-due');
    if (due) due.textContent = reviews.length ? `${reviews.length} ${plural(reviews.length, ['повторение', 'повторения', 'повторений'])}` : '';
    const nw = $('hero-new');
    if (nw) nw.textContent = fresh.length ? `${fresh.length} ${plural(fresh.length, ['новое', 'новых', 'новых'])}` : '';
    const date = $('hero-date');
    if (date) date.textContent = new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
    const hint = $('start-hint');
    if (hint) {
        const newLeft = Math.max(0, state.settings.newPerDay - introducedToday());
        hint.textContent = !state.words.length ? 'Добавь слова — и начнём.'
            : paused && waiting ? `Новые на паузе: к повторению ${state.settings.pauseNewAt} и больше — сначала разбери долг.`
            : waiting > fresh.length ? `Ещё ${waiting - fresh.length} ${plural(waiting - fresh.length, ['новое слово ждёт', 'новых слова ждут', 'новых слов ждут'])} · лимит ${state.settings.newPerDay} в день, сегодня осталось ${newLeft}`
            : total === 0 ? 'Новые слова откроются завтра. «Другие режимы» доступны всегда.' : '';
    }
}

function renderBulkBar() {
    const panel = $('bulk-actions-panel');
    const btn = $('bulk-select-btn');
    if (panel) panel.hidden = !view.bulk;
    if (btn) {
        btn.innerHTML = view.bulk ? '<svg class="ic"><use href="#i-x"/></svg>Отмена' : '<svg class="ic"><use href="#i-select"/></svg>Выбрать';
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
        openWord(id);
    },
    'speak-word'(el) {
        const w = findWord(el.dataset.id);
        if (w) speak(displayWord(w));
    },
    'edit-word'(el) { closeModal('word-modal'); openEdit(el.dataset.id); },
    'speak-example'(el) {
        const w = findWord(el.dataset.id);
        if (w?.example) speak(w.example);
    },
    'save-edit'() { saveEdit(); },
    'delete-word'(el) {
        const w = findWord(el.dataset.id);
        closeModal('word-modal');
        if (w) removeWords(new Set([w.id]));
    },
    'undo-delete'() { restoreDeleted(); },
    'filter-tag'(el) {
        view.tag = el.dataset.tag || null;
        view.shown = PAGE;
        renderList();
    },
    'filter-level'(el) {
        const next = el.dataset.level || 'all';
        view.level = view.level === next ? 'all' : next;
        view.shown = PAGE;
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
    $('sort-select')?.addEventListener('change', (e) => {
        view.sort = e.target.value;
        renderList();
    });
    $('hide-trans')?.addEventListener('change', (e) => {
        view.hideTranslations = e.target.checked;
        try { localStorage.setItem('hideTranslations', view.hideTranslations ? '1' : '0'); } catch { /* приватный режим */ }
        renderList();
    });
}

