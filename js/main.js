// Точка входа. Связывает модули и разметку.
//
// Разметка не вызывает функции напрямую (onclick="..."): у элементов есть
// data-action, а один обработчик ниже находит нужное действие в реестре.
// Так не нужны глобальные функции, и данные пользователя никогда не попадают
// внутрь JS-кода в атрибутах — именно там аудит нашёл XSS.
import {
    state, loadLocal, loadFromServer, saveWords, saveSettings, setSyncResultHandler,
    setWriteErrorHandler, hasPendingSync, beaconPayload, stateBeaconPayload, replaceActivity, refreshFromServer,
} from './store.js';
import { normalizeWord } from './srs.js';
import { stripParticle } from './norsk.js';
import { plural, escapeHtml } from './util.js';
import { $, showToast, showConfirm, openModal, closeModal, topModal, initSpeech, speak } from './ui.js';
import { applyTheme, setTheme } from './themes.js';
import { wordFormHtml, readWordForm, clearWordForm, syncGrammarVisibility, guessForms, insertChar, fillFromDictionary, applySuggestion, clearAutoFilled, renderPreview } from './wordform.js';
import { dedupeKey } from './format.js';
import { renderList, listActions, initList, onListRendered } from './list.js';
import { renderStats, showForgettingStats, showWordHistory } from './stats.js';
import { trainingActions, initTraining, handleTrainingKey, onTrainingFinished, isTraining } from './training.js';
import { ioActions, initIo } from './io.js';
import { shotActions, initShot } from './shot.js';
import { openTatoeba, tatoebaActions } from './tatoeba.js';

// ---------------------------------------------------------------------------
// Добавление слова
// ---------------------------------------------------------------------------
let adding = false;
async function addWord() {
    // Двойное нажатие, пока ждём подсказку или подтверждение, добавило бы слово дважды.
    if (adding) return;
    adding = true;
    try { await addWordOnce(); } finally { adding = false; }
}

async function addWordOnce() {
    // Подсказка ещё идёт — дождаться: иначе слово ушло бы без перевода,
    // а форма очистилась бы до её прихода.
    if (suggesting) await suggesting;
    // Пока ждали, окно закрыли — передумал.
    if (!$('add-modal').classList.contains('open')) return;
    settleWord();
    const data = readWordForm('add');
    if (!data.original || !data.translate) {
        if (data.original && !data.translate) {
            setAddStatus('Впиши перевод — подсказка не пришла', 'warn');
        } else {
            showToast('Заполни норвежское слово и перевод', 'info');
        }
        $(data.original ? 'add-ru' : 'add-no').focus();
        return;
    }
    const key = dedupeKey(data.original, data.pos);
    const dup = state.words.find(w => dedupeKey(w.original, w.pos) === key);
    if (dup) {
        const ok = await showConfirm(
            `<b lang="nb">${escapeHtml(dup.original)}</b> — ${escapeHtml(dup.translate)} уже есть в словаре.<br>Добавить ещё раз?`,
            'Добавить', 'Отмена');
        if (!ok) { $('add-no').focus(); return; }
        if (!$('add-modal').classList.contains('open')) return;
    }
    const now = Date.now();
    state.words.push(normalizeWord({ ...data, id: now, addedAt: now, nextReview: now, level: 0 }));
    saveWords();
    clearWordForm('add');
    lastSuggested = '';
    $('tatoeba-fetch-btn').hidden = true;
    renderList();
    // Окно остаётся открытым: слова обычно добавляют по несколько подряд.
    setAddStatus(`«${data.original}» добавлено. Следующее?`, 'ok');
    showToast(`«${data.original}» добавлено`, 'success', 1500);
    $('add-no').focus();
}

// ---------------------------------------------------------------------------
// Подсказка при добавлении: перевод, пример, род и формы (/api/word/suggest —
// ИИ на сервере и Ordbøkene). Запрос — когда слово дописано: Enter, уход из
// поля или пауза в наборе.
// ---------------------------------------------------------------------------
let suggesting = null;      // текущий запрос (промис) — addWord его ждёт
let lastSuggested = '';     // для какого написания уже спрашивали
let pendingWord = null;     // { typed, original }: поле ещё не переписано на словарное
const suggestCache = new Map();

// Подсказка по паузе в наборе не трогает само поле: человек ещё печатает
// («en hu» → «hu» стёрло бы артикль и сбило курсор). Словарное написание
// («en uttale» → «uttale») ставится на Enter, уходе из поля или добавлении.
function settleWord() {
    if (!pendingWord) return;
    const input = $('add-no');
    if (input.value.trim() === pendingWord.typed) {
        input.value = pendingWord.original;
        lastSuggested = pendingWord.original;
        renderPreview('add');
    }
    pendingWord = null;
}

function setAddStatus(text, kind = '', spin = false) {
    const box = $('add-status');
    if (!box) return;
    box.className = `add-status${kind ? ` ${kind}` : ''}`;
    box.innerHTML = `${spin ? '<span class="spinner"></span>' : ''}<span>${escapeHtml(text)}</span>`;
}

function fetchSuggestion(word) {
    if (!suggestCache.has(word)) {
        const job = fetch('/api/word/suggest', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ word }), signal: AbortSignal.timeout(50000),
        }).then(r => (r.ok ? r.json() : { failed: r.status })).catch(() => ({ failed: 0 }));
        suggestCache.set(word, job);
        job.then(d => { if (d.failed !== undefined) suggestCache.delete(word); });
        if (suggestCache.size > 100) suggestCache.delete(suggestCache.keys().next().value);
    }
    return suggestCache.get(word);
}

async function suggestForAdd({ typing = false } = {}) {
    const typed = $('add-no').value.trim();
    $('tatoeba-fetch-btn').hidden = !typed;
    if (!typing) settleWord();
    if (!typed || typed === lastSuggested) return;
    // Обрывок в паузе набора («en h») — не спрашивать.
    if (typing && typed.replace(/^(en|ei|et|å)\s+/i, '').length < 3) return;
    if (state.settings.smartAdd === false) {
        // Подсказка выключена — только грамматика из словаря, как раньше.
        lastSuggested = typed;
        if (!$('add-pos').value) fillFromDictionary('add');
        setAddStatus('Подсказка выключена в настройках — впиши перевод', '');
        return;
    }
    lastSuggested = typed;
    setAddStatus('Ищу перевод и пример…', '', true);
    const job = fetchSuggestion(typed);
    suggesting = job;
    const d = await job;
    if (suggesting === job) suggesting = null;
    // Пока ждали, слово поменяли — ответ уже не про него.
    if ($('add-no').value.trim() !== typed) return;
    if (d.failed !== undefined) {
        lastSuggested = '';   // следующий Enter или уход из поля спросят снова
        setAddStatus(d.failed === 429 ? 'Слишком много запросов — подожди минуту или впиши перевод сам'
            : d.failed ? 'Сервер не смог подсказать — впиши перевод сам или нажми Enter ещё раз'
                : 'Нет связи с сервером — впиши перевод сам', 'warn');
        return;
    }
    const focused = document.activeElement === $('add-no');
    applySuggestion('add', d, typed, { keepWord: typing && focused });
    if (typing && focused && d.original && d.original !== typed) {
        pendingWord = { typed, original: d.original };
        lastSuggested = typed;
    } else {
        lastSuggested = $('add-no').value.trim();
    }
    const what = d.source === 'ai' ? 'Перевод и пример подсказал ИИ' : d.source === 'translator' ? 'Перевод машинный' : 'Перевода не нашёл — впиши сам';
    setAddStatus(`${what}${d.inDictionary ? ' · род и формы из Ordbøkene' : ''}. Проверь и добавляй.`, d.translate ? 'ok' : 'warn');
}

function openAdd() {
    openModal('add-modal');
    if (!$('add-no').value.trim()) setAddStatus('Напиши слово — перевод, род и пример подставятся сами.');
    setTimeout(() => $('add-no').focus(), 60);
}

// ---------------------------------------------------------------------------
// Разделы: Сегодня · Слова · Прогресс (адрес #words, #progress)
// ---------------------------------------------------------------------------
const VIEWS = ['today', 'words', 'progress'];
function showView(name, { push = true, user = false } = {}) {
    const v = VIEWS.includes(name) ? name : 'today';
    for (const id of VIEWS) $(`view-${id}`).hidden = id !== v;
    document.querySelectorAll('[data-action="go"]').forEach(b => {
        b.classList.toggle('active', b.dataset.view === v);
        if (b.classList.contains('tab') || b.classList.contains('bn-item')) b.setAttribute('aria-current', b.dataset.view === v ? 'page' : 'false');
    });
    // Нажатие на вкладку — новая запись истории: «Назад» на Android
    // возвращает на прошлую вкладку, а не закрывает приложение.
    if (push && location.hash.slice(1) !== v) {
        const url = v === 'today' ? location.pathname + location.search : `#${v}`;
        if (user) history.pushState(null, '', url); else history.replaceState(null, '', url);
    }
    window.scrollTo(0, 0);
    // Холст недельного графика рисуется по размеру — перерисовать на видимом.
    if (v === 'progress') renderStats();
}

// ---------------------------------------------------------------------------
// Настройки
// ---------------------------------------------------------------------------
function openSettings() {
    $('set-new').value = state.settings.newPerDay;
    $('set-pause').value = state.settings.pauseNewAt;
    $('set-goal').value = state.settings.dailyGoal;
    $('set-autospeak').checked = !!state.settings.autoSpeak;
    $('set-autotranslate').checked = state.settings.smartAdd !== false;
    $('set-cards-dir').value = state.settings.cardsDir || 'no-ru';
    $('set-rate').value = state.settings.speechRate || 1;
    renderRateLabel();
    openModal('settings-modal');
}

function renderRateLabel() {
    const r = Number($('set-rate').value);
    $('set-rate-label').textContent = r === 1 ? '×1 — как у голоса' : `×${r.toFixed(2)}${r < 1 ? ' — медленнее' : ' — быстрее'}`;
}

function saveSettingsForm() {
    const n = Math.round(Number($('set-new').value));
    const g = Math.round(Number($('set-goal').value));
    const pause = Math.round(Number($('set-pause').value));
    if (!(n >= 0 && n <= 200) || !(g >= 1 && g <= 500) || !(pause >= 0 && pause <= 2000)) {
        showToast('Новых слов: 0–200, цель дня: 1–500, пауза: 0–2000', 'warning');
        return;
    }
    Object.assign(state.settings, {
        newPerDay: n,
        pauseNewAt: pause,
        dailyGoal: g,
        autoSpeak: $('set-autospeak').checked,
        smartAdd: $('set-autotranslate').checked,
        cardsDir: $('set-cards-dir').value,
        speechRate: Number($('set-rate').value) || 1,
    });
    saveSettings();
    closeModal('settings-modal');
    renderAll();
    showToast('Настройки сохранены', 'success', 1500);
}

function renderMute() {
    $('mute-icon').setAttribute('href', state.settings.muted ? '#i-mute' : '#i-volume');
    $('mute-btn').setAttribute('aria-pressed', String(state.settings.muted));
}

// ---------------------------------------------------------------------------
// Реестр действий
// ---------------------------------------------------------------------------
const actions = {
    ...listActions,
    ...trainingActions,
    ...ioActions,
    ...shotActions,
    ...tatoebaActions,
    'add-word'() { addWord(); },
    'open-add'() { openAdd(); },
    'go'(el) { showView(el.dataset.view, { user: true }); },
    'insert-char'(el, e) { insertChar(el.dataset.char, e, $('add-no')); },
    async 'dict-fill'(el) {
        const p = el.closest('.word-form').dataset.prefix;
        if (!$(`${p}-no`).value.trim()) { showToast('Сначала введи норвежское слово', 'info'); return; }
        const d = await fillFromDictionary(p, { overwrite: true });
        if (!d) showToast('В Ordbøkene такого слова нет (или нет сети). Проверь написание.', 'info', 4000);
    },
    'guess-forms'(el) {
        const p = el.closest('.word-form').dataset.prefix;
        if (!guessForms(p)) showToast('Сначала введи слово, а для существительного — выбери род', 'info');
    },
    'tatoeba-add'() { openTatoeba($('add-no').value, 'add'); },
    'tatoeba-word'(el) {
        const w = state.words.find(x => String(x.id) === el.dataset.id);
        if (w) openTatoeba(w.original, 'add');
    },
    'tatoeba-edit'() { openTatoeba($('edit-no').value, 'edit'); },
    'history-word'(el) { showWordHistory(el.dataset.id); },
    'open-stats'() { closeModal('settings-modal'); showForgettingStats(); },
    'open-help'() { closeModal('settings-modal'); openModal('help-modal'); },
    'open-theme'() { openSettings(); },
    'set-theme'(el) { setTheme(el.dataset.theme); renderStats(); },
    'open-settings'() { openSettings(); },
    'save-settings'() { saveSettingsForm(); },
    'test-rate'() { speak('Hei! Jeg lærer norsk.', { rate: Number($('set-rate').value) }); },
    'close-modal'(el) { el.closest('.modal-overlay')?.classList.remove('open'); },
    'toggle-mute'() {
        state.settings.muted = !state.settings.muted;
        saveSettings({ shared: false });
        renderMute();
        if (state.settings.muted) window.speechSynthesis?.cancel();
    },
    async 'reset-progress'() {
        const ok = await showConfirm('Сбросить весь прогресс?<br><small>Уровни и расписание всех слов, стрик и активность обнулятся. Слова останутся.</small>', 'Сбросить', 'Отмена');
        if (!ok) return;
        const now = Date.now();
        for (const w of state.words) {
            Object.assign(w, { level: 0, nextReview: now, forgetStep: 0, sm2Reps: 0, sm2Interval: 1, sm2EF: 2.5, history: [] });
        }
        // Новая эпоха: иначе сервер и другие устройства вернули бы старую
        // активность при слиянии (берётся максимум).
        replaceActivity({});
        saveWords();
        renderAll();
        showToast('Прогресс сброшен', 'warning');
    },
    async 'clear-all'() {
        const n = state.words.length;
        const ok = await showConfirm(`Удалить все ${n} ${plural(n, ['слово', 'слова', 'слов'])}?<br><small>Отменить нельзя. Сначала сделай бэкап (📤 Экспорт).</small>`, 'Удалить всё', 'Отмена');
        if (!ok) return;
        state.words = [];
        saveWords();
        renderAll();
    },
    'close-results'() { closeModal('results-modal'); },
    'next-lesson'() { closeModal('results-modal'); actions['start-lesson'](); },
    'install-pwa'() { installPwa(); },
    'hide-install'() { $('pwa-install-banner').hidden = true; },
    'reload'() { location.reload(); },
};

document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const fn = actions[el.dataset.action];
    if (!fn) {
        console.warn('Нет действия', el.dataset.action);
        return;
    }
    if (el.tagName !== 'A') e.preventDefault();
    fn(el, e);
});

// Кнопки æ ø å не должны забирать фокус у поля ввода.
document.addEventListener('mousedown', (e) => {
    if (e.target.closest('.no-letter-btn')) e.preventDefault();
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const m = topModal();
        if (m) { m.classList.remove('open'); return; }
    }
    // В итогах Enter — «Ещё урок», если он есть, иначе «Готово»: на компьютере
    // урок за уроком идут с клавиатуры. Повтор зажатого Enter не считается.
    if (e.key === 'Enter' && !e.repeat && topModal()?.id === 'results-modal') {
        e.preventDefault();
        // Двойной Enter на последнем задании не должен проскочить итоги.
        if (Date.now() - Number($('results-modal').dataset.openedAt || 0) < 600) return;
        actions[$('results-more').hidden ? 'close-results' : 'next-lesson']();
        return;
    }
    if (topModal()) return;
    if (isTraining() && handleTrainingKey(e)) e.preventDefault();
});

// ---------------------------------------------------------------------------
// Рендер и запуск
// ---------------------------------------------------------------------------
function renderAll() {
    renderList();   // renderStats вызывается из onListRendered
    renderMute();
}

function initAddForm() {
    $('add-form').innerHTML = wordFormHtml('add');
    $('edit-form').innerHTML = wordFormHtml('edit', { open: true });
    for (const p of ['add', 'edit']) {
        $(`${p}-pos`).addEventListener('change', () => syncGrammarVisibility(p));
        $(`${p}-form`).addEventListener('input', () => renderPreview(p));
        $(`${p}-form`).addEventListener('change', () => renderPreview(p));
        syncGrammarVisibility(p);
    }
    let typingTimer = null;
    $('add-no').addEventListener('input', () => {
        clearTimeout(typingTimer);
        // Слово поменяли — подставленное для прошлого слова больше не про него.
        if (lastSuggested && $('add-no').value.trim() !== lastSuggested) {
            clearAutoFilled('add');
            lastSuggested = '';
        }
        pendingWord = null;
        typingTimer = setTimeout(() => suggestForAdd({ typing: true }), 1300);
    });
    $('add-no').addEventListener('blur', () => { clearTimeout(typingTimer); suggestForAdd(); });
    $('set-rate').addEventListener('input', renderRateLabel);
    $('add-form').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing && e.target.matches('input')) {
            e.preventDefault();
            // В поле слова Enter сначала ищет перевод, второй Enter — добавляет.
            if (e.target.id === 'add-no' && pendingWord && $('add-ru').value.trim()) settleWord();
            if (e.target.id === 'add-no' && (!$('add-ru').value.trim() || $('add-no').value.trim() !== lastSuggested)) {
                clearTimeout(typingTimer);
                suggestForAdd();
                return;
            }
            addWord();
        }
    });
    $('edit-form').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing && e.target.matches('input')) {
            e.preventDefault();
            actions['save-edit']();
        }
    });
}

// Раскрыты ли «Другие режимы» — помним на этом устройстве. По умолчанию свёрнуто:
// главное — одна кнопка «Продолжить». Ключ новый (раньше practiceOpen,
// раскрыто по умолчанию), чтобы старое «раскрыто» не перекрывало новый вид.
function initPracticeToggle() {
    const box = $('practice-details');
    try { box.open = localStorage.getItem('moreOpen') === '1'; } catch { /* приватный режим */ }
    box.addEventListener('toggle', () => {
        try { localStorage.setItem('moreOpen', box.open ? '1' : '0'); } catch { /* ignore */ }
    });
}

async function init() {
    setWriteErrorHandler((e) => {
        console.error(e);
        showToast(e?.name === 'QuotaExceededError'
            ? 'Хранилище браузера переполнено — сделай бэкап и удали лишнее.'
            : 'Не удалось сохранить данные в браузере.', 'error', 6000);
    });
    let syncWarned = false;
    setSyncResultHandler((err) => {
        if (err && !syncWarned) {
            syncWarned = true;
            showToast('Сервер недоступен — изменения сохранены в браузере и уйдут на сервер позже.', 'warning', 5000);
        }
        if (!err) syncWarned = false;
    });

    loadLocal();
    initSpeech();   // есть ли на сервере Piper — не ждём, это не блокирует интерфейс
    applyTheme();
    initAddForm();
    initList();
    initTraining();
    initIo();
    initShot();
    onListRendered(renderStats);
    onTrainingFinished(renderAll);

    initPracticeToggle();
    showView(location.hash.slice(1), { push: false });
    window.addEventListener('hashchange', () => showView(location.hash.slice(1), { push: false }));
    renderAll();
    await loadFromServer();
    applyTheme();   // настройки могли прийти с сервера
    renderAll();

    // Ярлык из манифеста: /?action=train
    const shortcut = new URLSearchParams(location.search).get('action');
    if (shortcut === 'train') actions['start-lesson']();
    if (shortcut === 'add') openAdd();
}

// ---------------------------------------------------------------------------
// PWA
// ---------------------------------------------------------------------------
let deferredInstall = null;

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    if (!window.matchMedia('(display-mode: standalone)').matches) $('pwa-install-banner').hidden = false;
});

async function installPwa() {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    $('pwa-install-banner').hidden = true;
}

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').then(reg => {
            reg.addEventListener('updatefound', () => {
                const sw = reg.installing;
                sw?.addEventListener('statechange', () => {
                    if (sw.state === 'installed' && navigator.serviceWorker.controller) {
                        $('update-toast').hidden = false;
                    }
                });
            });
        }).catch(err => console.warn('[PWA] SW:', err));
    });
}

// Если вкладку закрыли в течение 1,5 с после ответа, отложенная синхронизация
// не успела бы уйти. sendBeacon отправляет её при закрытии — только разницу:
// у sendBeacon лимит 64 КБ, а весь словарь A1 весит 100–400 КБ (раньше из-за
// этого отправка не срабатывала никогда). Если не дошло и так — изменения
// лежат в localStorage и уйдут при следующем открытии.
window.addEventListener('pagehide', () => {
    if (!state.loaded) return;
    const body = hasPendingSync() ? beaconPayload() : null;
    const stateBody = stateBeaconPayload();
    try {
        // Состояние маленькое — первым: у браузера общий лимит на beacon'ы
        // около 64 КБ, и после большого пакета слов оно могло бы не влезть.
        if (stateBody) navigator.sendBeacon?.('/api/state', new Blob([stateBody], { type: 'application/json' }));
        if (body) navigator.sendBeacon?.('/api/words/batch', new Blob([body], { type: 'application/json' }));
    } catch { /* ignore */ }
});

// Приложение на телефоне висит открытым днями. Когда к нему возвращаешься,
// подтягиваем то, что за это время сделано на другом устройстве, — иначе
// показывались бы слова, которые уже повторены на компьютере.
let hiddenAt = 0;
document.addEventListener('visibilitychange', async () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (!state.loaded || isTraining() || Date.now() - hiddenAt < 60_000) return;
    // Пока ждём сервер, могла начаться тренировка — тогда её слова не трогаем.
    if (await refreshFromServer(isTraining)) {
        applyTheme();
        renderAll();
    }
});

init();
