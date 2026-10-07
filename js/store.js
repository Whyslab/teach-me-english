// Состояние приложения и его хранение: localStorage + синхронизация с сервером.
import { toDayKey, DAY_MS } from './util.js';
import { normalizeWord } from './srs.js';
import { computeChanges, applyConfirmed, snapshotFor, fingerprint, isEmpty, BEACON_LIMIT } from './sync.js';

export const DEFAULT_SETTINGS = {
    newPerDay: 15,     // лимит новых слов в день
    dailyGoal: 10,     // ответов в день для стрика
    theme: 'auto',
    spellingDir: 'no-ru', // направление режима письма: no-ru | ru-no
    autoSpeak: false,
    muted: false,
    speechRate: 1,         // скорость речи Piper/браузера: 0.6…1.4
    cardsDir: 'no-ru',     // направление карточек: no-ru | ru-no | mixed
    autoTranslate: false,  // подсказка перевода от MyMemory при добавлении слова
};

export const state = {
    words: [],
    settings: { ...DEFAULT_SETTINGS },
    activity: {},       // { 'YYYY-MM-DD': ответов } — общий с сервером, из него считается серия
    activityEpoch: 0,   // время последнего сброса активности (см. POST /api/state)
    loaded: false,
    lastSyncError: null,
};

// Ключи старой версии, которые больше ничего не значат.
const LEGACY_KEYS = ['userXP', 'achievements', 'weeklyChallenge', 'timeLeft', 'lastVisit',
                     'timerPos', 'isTrainingActive', 'selectedTheme', 'themeId', 'isMuted',
                     // Серия и «введено сегодня» теперь считаются из активности и истории слов.
                     'streakData', 'introducedToday'];

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
    const stored = read('settings', null);
    state.settings = { ...DEFAULT_SETTINGS, ...(stored || {}) };
    if (!localStorage.getItem('settings')) {
        if (legacyMuted) state.settings.muted = true;
        if (legacyTheme) state.settings.theme = legacyTheme;
    }
    migrateSettings(state.settings);
    // Настройки, сохранённые до того, как они стали общими, — настоящие,
    // а не значения по умолчанию свежего устройства. Метка времени даёт им
    // победить при первой встрече с сервером. У свежего устройства — 0:
    // любые настройки с сервера новее.
    if (!stored) state.settings.updatedAt = 0;
    else if (!('updatedAt' in stored)) state.settings.updatedAt = Date.now();
    state.activity = read('dailyActivity', {}) || {};
    state.activityEpoch = Number(read('activityEpoch', 0)) || 0;
    const words = read('myWords', []);
    state.words = Array.isArray(words) ? words.map(normalizeWord) : [];
    for (const k of LEGACY_KEYS) {
        try { localStorage.removeItem(k); } catch { /* приватный режим */ }
    }
    write('settings', state.settings);
}

// Разовые переделки сохранённых настроек. version растёт с каждой.
export const SETTINGS_VERSION = 2;
export function migrateSettings(s) {
    const v = Number(s.version) || 1;
    // 2: «вперемешку» было значением по умолчанию — оно путало, легко слово
    // или трудно. Теперь по умолчанию норвежское слово → перевод.
    if (v < 2 && s.cardsDir === 'mixed') s.cardsDir = 'no-ru';
    s.version = SETTINGS_VERSION;
    return s;
}

// Изменение настроек пользователем: время правки решает, чьи настройки
// новее — этого устройства или сервера.
// shared = false — правка, которую не надо раздавать другим устройствам
// (звук, последнее направление письма). Иначе устройство, давно не
// видевшее сервер, перезаписало бы общие настройки своими старыми,
// просто потому что у его правки время новее.
export function saveSettings({ shared = true } = {}) {
    if (shared) state.settings.updatedAt = Date.now();
    write('settings', state.settings);
    // Сразу, без задержки: настройки меняются редко, а вкладку после
    // «Сохранить» часто закрывают — отложенная отправка не успела бы.
    if (shared && state.loaded) pushState().catch(() => scheduleStatePush());
}
export function saveActivity() {
    write('dailyActivity', state.activity);
    scheduleStatePush();
}

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
        // Настройки и активность. Их сбой не должен ломать загрузку слов.
        try {
            await pushState();
        } catch (e) {
            console.warn('Состояние не синхронизировано:', e);
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

// Обновление при возврате на вкладку (телефон держит приложение открытым
// днями). В отличие от loadFromServer при старте, приложение в этот момент
// живое: пока идёт запрос, можно ответить, поправить слово или начать
// тренировку. Поэтому серверная копия принимается, только если за время
// запроса слова не менялись, всё отправлено и isBusy() ложно; иначе
// обновление просто пропускается — следующее возвращение повторит попытку.
export async function refreshFromServer(isBusy = () => false) {
    if (!state.loaded) return false;
    try {
        await syncNow();
        if (syncing || !isEmpty(pendingChanges())) return false;
        const gen = wordsGen;
        const res = await api('/api/words');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) return false;
        if (gen !== wordsGen || isBusy() || syncing || !isEmpty(pendingChanges())) return false;
        state.words = data.map(normalizeWord);
        write('myWords', state.words);
        rememberServerState(state.words);
        persistPending(pendingChanges());
        try {
            await pushState();
        } catch (e) {
            console.warn('Состояние не синхронизировано:', e);
        }
        state.lastSyncError = null;
        return true;
    } catch (e) {
        state.lastSyncError = e;
        return false;
    }
}

let syncTimer = null;
let syncing = null;
// Растёт при каждом изменении слов — так refreshFromServer видит, что слова
// поменялись, пока шёл запрос.
let wordsGen = 0;
let onSyncResult = () => {};
export function setSyncResultHandler(fn) { onSyncResult = fn; }

// Сохраняет словарь локально сразу, на сервер — с задержкой, одним запросом
// на серию быстрых изменений.
export function saveWords() {
    wordsGen++;
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
//
// Всё выводится из данных, а не хранится отдельно: «введено сегодня» — из
// истории слов, серия — из ответов по дням. Раньше это были отдельные
// счётчики в localStorage: на телефоне и компьютере они расходились, и
// каждое устройство давало свои 15 новых слов в день.
// ---------------------------------------------------------------------------

// Новые слова, впервые отвеченные сегодня (для дневного лимита).
export function introducedToday(words = state.words, now = Date.now()) {
    const today = toDayKey(now);
    return words.filter(w => w.history?.length && toDayKey(w.history[0].ts) === today).length;
}

export function recordAnswer() {
    const key = toDayKey();
    state.activity[key] = (Number(state.activity[key]) || 0) + 1;
    saveActivity();
}

export function answersToday() {
    return Number(state.activity[toDayKey()]) || 0;
}

// Серия: дни подряд, когда выполнена цель по ответам. Сегодняшний день
// засчитывается, когда цель выполнена; пока нет — серия не обрывается.
export function streakDays(activity = state.activity, goal = state.settings.dailyGoal, now = Date.now()) {
    const met = (t) => (Number(activity[toDayKey(t)]) || 0) >= goal;
    let n = met(now) ? 1 : 0;
    // Шаг по полудням: переход на летнее время не сбивает счёт дней.
    const noon = new Date(now);
    noon.setHours(12, 0, 0, 0);
    for (let t = noon.getTime() - DAY_MS; met(t); t -= DAY_MS) n++;
    return n;
}

// ---------------------------------------------------------------------------
// Общее состояние на сервере: настройки и активность (см. POST /api/state)
// ---------------------------------------------------------------------------
// Звук выключают на конкретном устройстве — его не переносим.
const LOCAL_ONLY_SETTINGS = ['muted'];

function statePayload(extra = {}) {
    const settings = { ...state.settings };
    for (const k of LOCAL_ONLY_SETTINGS) delete settings[k];
    // Сервер отвергнет запрос целиком из-за одной кривой записи — отсеиваем.
    const activity = {};
    for (const [day, n] of Object.entries(state.activity || {})) {
        const v = Math.round(Number(n));
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(v) && v > 0) activity[day] = Math.min(v, 100000);
    }
    return { settings, activity, activityEpoch: state.activityEpoch, ...extra };
}

// Активность: если на сервере был сброс новее нашего — берём серверную как
// есть, иначе максимум по дням. Просто принять серверную нельзя: ответ,
// данный, пока запрос был в пути, пропал бы.
function adoptState(remote) {
    if (remote.activity && typeof remote.activity === 'object') {
        const epoch = Number(remote.activityEpoch) || 0;
        if (epoch > state.activityEpoch) {
            state.activity = { ...remote.activity };
            state.activityEpoch = epoch;
            write('activityEpoch', epoch);
        } else {
            for (const [day, n] of Object.entries(remote.activity)) {
                state.activity[day] = Math.max(Number(state.activity[day]) || 0, Number(n) || 0);
            }
        }
        write('dailyActivity', state.activity);
    }
    const s = remote.settings;
    if (s && (Number(s.updatedAt) || 0) > (Number(state.settings.updatedAt) || 0)) {
        const local = Object.fromEntries(LOCAL_ONLY_SETTINGS.map(k => [k, state.settings[k]]));
        state.settings = migrateSettings({ ...DEFAULT_SETTINGS, ...s, ...local });
        write('settings', state.settings);
    }
}

let statePushTimer = null;
function scheduleStatePush() {
    if (!state.loaded) return;
    clearTimeout(statePushTimer);
    statePushTimer = setTimeout(() => pushState().catch(() => {}), 2000);
}

// Сброс или восстановление активности: новая эпоха. Сервер заменит свою
// активность нашей, а устройства со старой эпохой перестанут её возвращать.
// Если сервер сейчас недоступен — эпоха сохранена и уйдёт со следующей отправкой.
export function replaceActivity(activity) {
    state.activity = { ...activity };
    state.activityEpoch = Date.now();
    write('activityEpoch', state.activityEpoch);
    write('dailyActivity', state.activity);
    return pushState().catch(() => {});
}

// Отправляет своё, получает слияние.
export async function pushState(extra = {}) {
    clearTimeout(statePushTimer);
    statePushTimer = null;
    const res = await api('/api/state', { method: 'POST', body: JSON.stringify(statePayload(extra)) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    adoptState(await res.json());
}

export function stateBeaconPayload() {
    return statePushTimer ? JSON.stringify(statePayload()) : null;
}
