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
import { wordFormHtml, readWordForm, clearWordForm, syncGrammarVisibility, guessForms, insertChar } from './wordform.js';
import { dedupeKey } from './format.js';
import { renderList, listActions, initList, onListRendered } from './list.js';
import { renderStats, showForgettingStats, showWordHistory } from './stats.js';
import { trainingActions, initTraining, handleTrainingKey, onTrainingFinished, isTraining } from './training.js';
import { ioActions, initIo } from './io.js';
import { openTatoeba, tatoebaActions } from './tatoeba.js';

// ---------------------------------------------------------------------------
// Добавление слова
// ---------------------------------------------------------------------------
async function addWord() {
    const data = readWordForm('add');
    if (!data.original || !data.translate) {
        showToast('Заполни норвежское слово и перевод', 'info');
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
    }
    const now = Date.now();
    state.words.push(normalizeWord({ ...data, id: now, addedAt: now, nextReview: now, level: 0 }));
    saveWords();
    clearWordForm('add');
    $('tatoeba-fetch-btn').hidden = true;
    renderList();
    showToast(`«${data.original}» добавлено`, 'success', 1500);
    $('add-no').focus();
}

// Автоперевод норвежский → русский при уходе из поля слова.
// По умолчанию выключен (⚙️ Настройки): для пары норвежский → русский MyMemory
// часто подставляет редкое значение или английское слово.
async function autoTranslate() {
    const no = $('add-no').value.trim();
    const ru = $('add-ru');
    $('tatoeba-fetch-btn').hidden = !no;
    if (!state.settings.autoTranslate || !no || ru.value.trim()) return;
    const query = stripParticle(no);
    ru.placeholder = '⏳ переводим…';
    try {
        const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(query)}&langpair=nb-NO|ru-RU`);
        const data = await res.json();
        const text = data?.responseStatus === 200 ? data.responseData?.translatedText : '';
        // MyMemory, не найдя перевода, возвращает исходное слово — такой «перевод» не нужен.
        if (text && !ru.value && text.toLowerCase() !== query.toLowerCase()) {
            ru.value = text;
            ru.classList.add('auto-filled');
            setTimeout(() => ru.classList.remove('auto-filled'), 1500);
        }
    } catch { /* офлайн — просто без подсказки */ }
    ru.placeholder = 'русский перевод';
}

// ---------------------------------------------------------------------------
// Настройки
// ---------------------------------------------------------------------------
function openSettings() {
    $('set-new').value = state.settings.newPerDay;
    $('set-goal').value = state.settings.dailyGoal;
    $('set-autospeak').checked = !!state.settings.autoSpeak;
    $('set-autotranslate').checked = !!state.settings.autoTranslate;
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
    if (!(n >= 0 && n <= 200) || !(g >= 1 && g <= 500)) {
        showToast('Новых слов: 0–200, цель дня: 1–500', 'warning');
        return;
    }
    Object.assign(state.settings, {
        newPerDay: n,
        dailyGoal: g,
        autoSpeak: $('set-autospeak').checked,
        autoTranslate: $('set-autotranslate').checked,
        cardsDir: $('set-cards-dir').value,
        speechRate: Number($('set-rate').value) || 1,
    });
    saveSettings();
    closeModal('settings-modal');
    renderAll();
    showToast('Настройки сохранены', 'success', 1500);
}

function renderMute() {
    $('mute-icon').textContent = state.settings.muted ? '🔇' : '🔊';
    $('mute-btn').setAttribute('aria-pressed', String(state.settings.muted));
}

// ---------------------------------------------------------------------------
// Реестр действий
// ---------------------------------------------------------------------------
const actions = {
    ...listActions,
    ...trainingActions,
    ...ioActions,
    ...tatoebaActions,
    'add-word'() { addWord(); },
    'insert-char'(el, e) { insertChar(el.dataset.char, e, $('add-no')); },
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
    'open-stats'() { showForgettingStats(); },
    'open-help'() { openModal('help-modal'); },
    'open-theme'() { openModal('theme-modal'); },
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
    $('edit-form').innerHTML = wordFormHtml('edit');
    for (const p of ['add', 'edit']) {
        $(`${p}-pos`).addEventListener('change', () => syncGrammarVisibility(p));
        syncGrammarVisibility(p);
    }
    $('add-no').addEventListener('blur', autoTranslate);
    $('set-rate').addEventListener('input', renderRateLabel);
    $('add-form').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing && e.target.matches('input')) {
            e.preventDefault();
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

// Раскрыта ли «Практика» — помним на этом устройстве.
function initPracticeToggle() {
    const box = $('practice-details');
    try { box.open = localStorage.getItem('practiceOpen') === '1'; } catch { /* приватный режим */ }
    box.addEventListener('toggle', () => {
        try { localStorage.setItem('practiceOpen', box.open ? '1' : '0'); } catch { /* ignore */ }
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
    onListRendered(renderStats);
    onTrainingFinished(renderAll);

    initPracticeToggle();
    renderAll();
    await loadFromServer();
    applyTheme();   // настройки могли прийти с сервера
    renderAll();

    // Ярлык из манифеста: /?action=train
    if (new URLSearchParams(location.search).get('action') === 'train') {
        actions['start-training']();
    }
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
