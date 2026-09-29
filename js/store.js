// Состояние приложения и его хранение: localStorage + синхронизация с сервером.
import { toDayKey, DAY_MS } from './util.js';
import { normalizeWord, isNew } from './srs.js';

export const DEFAULT_SETTINGS = {
    newPerDay: 15,     // лимит новых слов в день
    dailyGoal: 10,     // ответов в день для стрика
    theme: 'auto',
    spellingDir: 'no-ru', // направление режима письма: no-ru | ru-no
    autoSpeak: false,
    muted: false,
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

export async function loadFromServer() {
    try {
        const res = await api('/api/words');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        // Пустой ответ сервера не затирает локальный словарь: сервер мог
        // только что появиться с новой базой, а слова живут в браузере.
        if (Array.isArray(data) && data.length > 0) {
            state.words = data.map(normalizeWord);
            write('myWords', state.words);
        }
        return true;
    } catch {
        return false;
    } finally {
        state.loaded = true;
    }
}

let syncTimer = null;
let onSyncResult = () => {};
export function setSyncResultHandler(fn) { onSyncResult = fn; }

// Сохраняет словарь локально сразу, на сервер — с задержкой, одним запросом
// на серию быстрых изменений.
export function saveWords() {
    if (!state.loaded) return;
    write('myWords', state.words);
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncNow, 1500);
}

export function hasPendingSync() {
    return syncTimer !== null;
}

export async function syncNow() {
    clearTimeout(syncTimer);
    syncTimer = null;
    try {
        const res = await api('/api/sync', { method: 'POST', body: JSON.stringify(state.words) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        state.lastSyncError = null;
        onSyncResult(null);
    } catch (e) {
        state.lastSyncError = e;
        onSyncResult(e);
    }
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
