// Состояние приложения и его хранение: localStorage + синхронизация с сервером.
import { toDayKey, DAY_MS } from './util.js';
import { normalizeWord, isNew } from './srs.js';
import { computeChanges, applyConfirmed, snapshotFor, fingerprint, isEmpty, BEACON_LIMIT } from './sync.js';

export const DEFAULT_SETTINGS = {
    newPerDay: 15,     // лимит новых слов в день
    dailyGoal: 10,     // ответов в день для стрика
    theme: 'auto',
    spellingDir: 'no-ru', // направление режима письма: no-ru | ru-no
    autoSpeak: false,
    muted: false,
    speechRate: 1,         // скорость речи Piper/браузера: 0.6…1.4
    cardsDir: 'mixed',     // направление карточек: mixed | no-ru | ru-no
    autoTranslate: false,  // подсказка перевода от MyMemory при добавлении слова
};

export const state = {
    words: [],
    settings: { ...DEFAULT_SETTINGS },
    streak: { count: 0, lastDate: null, todayCount: 0 },
    activity: {},       // { 'YYYY-MM-DD': ответов }
    introduced: { day: '', ids: [] }, // новые слова, впервые отвеченные сегодня
    loaded: false,
    lastSyncError: null,
};

// Ключи старой версии, которые больше ничего не значат.
const LEGACY_KEYS = ['userXP', 'achievements', 'weeklyChallenge', 'timeLeft', 'lastVisit',
                     'timerPos', 'isTrainingActive', 'selectedTheme', 'themeId', 'isMuted'];

function read(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        return JSON.parse(raw) ?? fallback;
    } catch {
        return fallback;
    }
}

// Ошибку записи отдаём вызывающему через onError — модуль не знает про тосты.
let onWriteError = (e) => console.error('localStorage:', e);
export function setWriteErrorHandler(fn) { onWriteError = fn; }

function write(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
        onWriteError(e);
    }
}

export function loadLocal() {
    const legacyTheme = localStorage.getItem('themeId');
    const legacyMuted = localStorage.getItem('isMuted') === 'true';
    state.settings = { ...DEFAULT_SETTINGS, ...read('settings', {}) };
    if (!localStorage.getItem('settings')) {
        if (legacyMuted) state.settings.muted = true;
        if (legacyTheme) state.settings.theme = legacyTheme;
    }
    state.streak = { ...state.streak, ...read('streakData', {}) };
    state.activity = read('dailyActivity', {}) || {};
    state.introduced = read('introducedToday', { day: '', ids: [] });
    const words = read('myWords', []);
    state.words = Array.isArray(words) ? words.map(normalizeWord) : [];
    for (const k of LEGACY_KEYS) {
        try { localStorage.removeItem(k); } catch { /* приватный режим */ }
    }
    saveSettings();
}

export function saveSettings() { write('settings', state.settings); }
export function saveStreak() { write('streakData', state.streak); }
export function saveActivity() { write('dailyActivity', state.activity); }

// ---------------------------------------------------------------------------
// Сервер
// ---------------------------------------------------------------------------
function api(path, options = {}) {
    return fetch(path, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
}

// ---------------------------------------------------------------------------
// Синхронизация (см. js/sync.js)
//
// synced — версии слов, которые сервер подтвердил. Разница между ними и
// state.words — это то, что ещё не дошло до сервера. Её список (id изменённых
// и удалённых) хранится в localStorage под ключом pendingSync и переживает
// перезагрузку: при следующем открытии он уходит на сервер раньше, чем
// серверная копия подтягивается в браузер.
// ---------------------------------------------------------------------------
const synced = new Map();

function persistPending(changes) {
    write('pendingSync', { ids: changes.upserts.map(w => w.id), deleted: changes.deletes });
}

export function pendingChanges() {
    return computeChanges(state.words, synced);
}

async function pushChanges(changes) {
    const sent = snapshotFor(changes);
    const res = await api('/api/words/batch', {
        method: 'POST',
        body: JSON.stringify({ upserts: changes.upserts, deletes: changes.deletes }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    applyConfirmed(synced, sent);
    persistPending(pendingChanges());
}

function rememberServerState(words) {
    synced.clear();
    for (const w of words) synced.set(w.id, fingerprint(w));
}

export async function loadFromServer() {
    const pending = read('pendingSync', { ids: [], deleted: [] });
    try {
        // 1. Сначала отправляем то, что не успело уйти в прошлый раз. Сервер
        //    знает всё, кроме этих слов, — так и считаем.
        const dirty = new Set(pending.ids || []);
        const deleted = pending.deleted || [];
        if (dirty.size || deleted.length) {
            rememberServerState(state.words.filter(w => !dirty.has(w.id)));
            for (const id of deleted) synced.set(id, '');
            await pushChanges(pendingChanges());
        }

        // 2. Теперь серверная копия — самая свежая.
        const res = await api('/api/words');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('bad response');

        if (data.length === 0 && state.words.length > 0) {
            // Новая пустая база на сервере, а слова живут в браузере — отдаём их.
            synced.clear();
            await pushChanges(pendingChanges());
        } else {
            state.words = data.map(normalizeWord);
            write('myWords', state.words);
            rememberServerState(state.words);
            persistPending(pendingChanges());
        }
        state.lastSyncError = null;
        return true;
    } catch (e) {
        // Сервер недоступен: работаем с локальной копией. Неотправленное
        // остаётся в pendingSync и уйдёт, когда сервер появится.
        state.lastSyncError = e;
        if (!synced.size) {
            const dirty = new Set(pending.ids || []);
            rememberServerState(state.words.filter(w => !dirty.has(w.id)));
            for (const id of pending.deleted || []) synced.set(id, '');
        }
        return false;
    } finally {
        state.loaded = true;
    }
}

let syncTimer = null;
let syncing = null;
let onSyncResult = () => {};
export function setSyncResultHandler(fn) { onSyncResult = fn; }

// Сохраняет словарь локально сразу, на сервер — с задержкой, одним запросом
// на серию быстрых изменений.
export function saveWords() {
    if (!state.loaded) return;
    write('myWords', state.words);
    persistPending(pendingChanges());
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncNow, 1500);
}

export function hasPendingSync() {
    return !isEmpty(pendingChanges());
}

export async function syncNow() {
    clearTimeout(syncTimer);
    syncTimer = null;
    if (syncing) return syncing;   // один запрос за раз; остальное уйдёт следующим
    const changes = pendingChanges();
    if (isEmpty(changes)) return;
    syncing = pushChanges(changes)
        .then(() => {
            state.lastSyncError = null;
            onSyncResult(null);
            // Пока запрос шёл, могли появиться новые изменения.
            if (!isEmpty(pendingChanges())) syncTimer = setTimeout(syncNow, 300);
        })
        .catch((e) => {
            state.lastSyncError = e;
            onSyncResult(e);
            syncTimer = setTimeout(syncNow, 30000);  // повторим позже
        })
        .finally(() => { syncing = null; });
    return syncing;
}

// Для закрытия вкладки: только разница, чтобы уложиться в лимит sendBeacon.
export function beaconPayload() {
    const changes = pendingChanges();
    if (isEmpty(changes)) return null;
    const body = JSON.stringify({ upserts: changes.upserts, deletes: changes.deletes });
    return body.length <= BEACON_LIMIT ? body : null;
}

// ---------------------------------------------------------------------------
// Дневные счётчики
// ---------------------------------------------------------------------------
function rollIntroduced() {
    const today = toDayKey();
    if (state.introduced.day !== today) state.introduced = { day: today, ids: [] };
}

export function introducedToday() {
    rollIntroduced();
    return state.introduced.ids.length;
}

// Вызывается перед оценкой ответа: если слово новое — оно «введено» сегодня.
export function markIntroduced(word) {
    if (!isNew(word)) return;
    rollIntroduced();
    if (!state.introduced.ids.includes(word.id)) {
        state.introduced.ids.push(word.id);
        write('introducedToday', state.introduced);
    }
}

export function recordAnswer(correct) {
    const key = toDayKey();
    state.activity[key] = (Number(state.activity[key]) || 0) + 1;
    saveActivity();
    rollStreak();
    if (correct) state.streak.todayCount++;
    saveStreak();
}

// Стрик растёт, если вчера дневная цель была выполнена.
export function rollStreak() {
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - DAY_MS).toDateString();
    const s = state.streak;
    if (s.lastDate !== today) {
        s.count = (s.lastDate === yesterday && s.todayCount >= state.settings.dailyGoal)
            ? (s.count || 0) + 1
            : 0;
        s.todayCount = 0;
        s.lastDate = today;
        saveStreak();
    }
}

// Текущий стрик с учётом сегодняшнего дня, если цель уже выполнена.
export function displayedStreak() {
    rollStreak();
    const s = state.streak;
    return s.count + (s.todayCount >= state.settings.dailyGoal ? 1 : 0);
}
