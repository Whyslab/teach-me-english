// === 1. ИНИЦИАЛИЗАЦИЯ И ПОИСК ЭЛЕМЕНТОВ ===
let timeLeft = 0; 
let timerId = null;
let myWords = [];
const inputRu = document.getElementById('input-ru');
const inputEn = document.getElementById('input-en');
const inputEx = document.getElementById('input-example');
const inputExRu = document.getElementById('input-ex-ru');
const inputTags = document.getElementById('input-tags');
const element = document.getElementById('cards-container');
const addBtn = document.getElementById('add-btn');
const clearBtn = document.getElementById('clear-all');
const searchInput = document.getElementById('search-input');

let isSpellingMode = false; 
const spellingArea = document.getElementById('spelling-area');
const spellingInput = document.getElementById('spelling-input');
const spellingFeedback = document.getElementById('spelling-feedback');
const toggleModeBtn = document.getElementById('toggle-mode-btn');

const progressBar = document.getElementById('progress-bar');
const progressPercent = document.getElementById('progress-percent');
const progressStat = document.getElementById('progress-stat');

const mainHeader = document.querySelector('h1');
const progressWrapper = document.querySelector('.progress-wrapper');
const muteBtn = document.getElementById('mute-btn');
const muteIcon = document.getElementById('mute-icon');

const startBtn = document.getElementById('start-training-btn');
const stopBtn = document.getElementById('stop-training');
const trainSect = document.getElementById('training-section');
const mainUI = document.getElementById('main-ui');
const flashcard = document.getElementById('flashcard');

const modal = document.getElementById('import-modal');
const closeBtn = document.querySelector('.close-modal');
const importBtn = document.getElementById('import-btn');
const importArea = document.getElementById('import-area');

const resetLearnedBtn = document.getElementById('reset-learned-btn');
const exportBtn = document.getElementById('export-btn');
const learningCurveEl = document.getElementById('learning-curve');
const activityHeatmapEl = document.getElementById('activity-heatmap');
const weeklyChartEl = document.getElementById('weekly-progress-chart');

function safeParseStorage(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return parsed ?? fallback;
    } catch (e) {
        console.warn(`Поврежден localStorage для ${key}, сбрасываем значение.`);
        return fallback;
    }
}
function sanitizeTags(rawTags = []) {
    const set = new Set();
    rawTags.forEach(tag => {
        const trimmed = String(tag || '').trim();
        if (trimmed) set.add(trimmed);
    });
    return [...set];
}

// Состояние
let mainQueue = [];      
let trainingHistory = []; 
let activePool = [];     
let currentWordIndex = 0;
let cardClickStage = 0;
let isMuted = localStorage.getItem('isMuted') === 'true'; 
let isLoaded = false; 
const POOL_LIMIT = 50;
let sessionCorrect = 0;
let sessionWrong = 0;   

let comboCount = 0;
let sessionBestCombo = 0;
let isAnswering = false;
let sessionStartTodayCount = 0;
let sessionStartStreakCount = 0;

function updateCombo(correct) {
    if (correct) {
        comboCount++;
        sessionBestCombo = Math.max(sessionBestCombo, comboCount);
        if (comboCount >= 3 && comboCount % 3 === 0) playSound('combo');
    } else {
        comboCount = 0;
    }
    const el = document.getElementById('combo-display');
    if (!el) return;
    if (comboCount >= 3) {
        el.style.display = 'inline';
        const fire = comboCount >= 10 ? '🔥🔥🔥' : comboCount >= 6 ? '🔥🔥' : '🔥';
        el.textContent = `${fire} ×${comboCount}`;
        el.style.animation = 'none';
        void el.offsetWidth;
        el.style.animation = 'comboPop 0.3s ease';
    } else {
        el.style.display = 'none';
    }
}

let streakData = safeParseStorage('streakData', {
    count: 0,
    lastDate: null,
    todayCount: 0
});

let dailyActivity = safeParseStorage('dailyActivity', {});

const INTERVALS = {
    0: 0,
    1: 24 * 60 * 60 * 1000,
    2: 3 * 24 * 60 * 60 * 1000,
    3: 7 * 24 * 60 * 60 * 1000,
    4: 14 * 24 * 60 * 60 * 1000,
    5: 30 * 24 * 60 * 60 * 1000
};
const FORGET_STEPS = [
    60 * 1000,
    10 * 60 * 1000
];

// ============================================================
// SM-2 АЛГОРИТМ (как в Anki)
// quality: 0=снова, 1=сложно, 2=хорошо, 3=легко
// ============================================================
function sm2(word, quality) {
    if (!word.sm2Interval) word.sm2Interval = 1;
    if (!word.sm2EF)       word.sm2EF = 2.5;
    if (!word.sm2Reps)     word.sm2Reps = 0;

    const DAY = 24 * 60 * 60 * 1000;

    if (quality === 0) {
        word.sm2Reps = 0;
        word.sm2Interval = 1;
        word.level = Math.max(0, (word.level || 0) - 1);
        word.nextReview = Date.now() + 10 * 60 * 1000;
        word.forgetStep = (word.forgetStep || 0) + 1;
    } else {
        const q = quality;
        word.sm2EF = Math.max(1.3, word.sm2EF + (0.1 - (3 - q) * (0.08 + (3 - q) * 0.02)));

        if (word.sm2Reps === 0)      word.sm2Interval = 1;
        else if (word.sm2Reps === 1) word.sm2Interval = 6;
        else                          word.sm2Interval = Math.round(word.sm2Interval * word.sm2EF);

        if (quality === 1) word.sm2Interval = Math.max(1, Math.round(word.sm2Interval * 0.5));
        if (quality === 3) word.sm2Interval = Math.round(word.sm2Interval * 1.3);

        word.sm2Reps++;
        word.forgetStep = 0;
        word.nextReview = Date.now() + word.sm2Interval * DAY;

        if (word.sm2Interval >= 21)      word.level = 5;
        else if (word.sm2Interval >= 10) word.level = 4;
        else if (word.sm2Interval >= 6)  word.level = 3;
        else if (word.sm2Interval >= 3)  word.level = 2;
        else                              word.level = 1;
    }
    return word;
}

const TRAINING_TIME = 60 * 60;
const API_BASE = window.location.origin;

function apiUrl(path) {
    return `${API_BASE}${path}`;
}

// ===== СИСТЕМА ПОЛЬЗОВАТЕЛЕЙ =====
// Однопользовательский режим — регистрация не нужна
const currentUserId = 'local-user-001';

function apiFetch(path, options = {}) {
    return fetch(apiUrl(path), {
        ...options,
        headers: {
            "Content-Type": "application/json",
            "X-User-Id": currentUserId || "",
            ...(options.headers || {})
        }
    });
}

// === 2. ОСНОВНЫЕ ФУНКЦИИ ===

async function loadWords() {
    const localData = safeParseStorage('myWords', []);
    if (localData.length > 0) {
        myWords = localData.map(word => ({
            ...word,
            example: word.example || "",
            exampleTranslate: word.exampleTranslate || "",
            forgetStep: Number(word.forgetStep) || 0,
            tags: sanitizeTags(word.tags || []),
            videoId: word.videoId || '',
            startTime: Number(word.startTime) || 0,
            endTime: Number(word.endTime) || 0,
            subtitleText: word.subtitleText || ''
        }));
        isLoaded = true;
        render();
    }

    try {
        const response = await apiFetch('/api/words');
        if (!response.ok) throw new Error('Сервер недоступен');
        const data = await response.json();
        if (Array.isArray(data) && data.length > 0) {
            myWords = data.map(word => ({
                ...word,
                example: word.example || "",
                exampleTranslate: word.exampleTranslate || "",
                forgetStep: Number(word.forgetStep) || 0,
                tags: sanitizeTags(word.tags || []),
                videoId: word.videoId || '',
                startTime: Number(word.startTime) || 0,
                endTime: Number(word.endTime) || 0,
                subtitleText: word.subtitleText || ''
            }));
            localStorage.setItem('myWords', JSON.stringify(myWords));
        }
        isLoaded = true;
        render();
    } catch (e) {
        console.log("Сервер недоступен, работаем офлайн (localStorage)");
        isLoaded = true;
        render();
    }
}

function safeSetClick(id, callback) {
    const el = document.getElementById(id);
    if (el) {
        el.onclick = callback;
    } else {
        console.warn(`Элемент с ID ${id} не найден!`);
    }
}

function speak(text) {
    if (!window.speechSynthesis || isMuted) return; 
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 0.9;
    window.speechSynthesis.speak(utterance);
}

// ── ВИРТУАЛИЗАЦИЯ списка слов ─────────────────────────
const VIRT_PAGE = 80;       // сколько карточек рендерим сразу
const VIRT_THRESH = 300;    // px до конца — подгружаем ещё
let virtRendered = VIRT_PAGE;
let virtWords = [];         // текущий отсортированный список

function getSortedWords() {
    const base = getFilteredWords();
    if (currentSort === 'default') return base;
    const arr = [...base];
    switch (currentSort) {
        case 'level-asc':  return arr.sort((a,b) => (a.level||0) - (b.level||0));
        case 'level-desc': return arr.sort((a,b) => (b.level||0) - (a.level||0));
        case 'alpha':      return arr.sort((a,b) => a.original.localeCompare(b.original));
        case 'review':     return arr.sort((a,b) => (a.nextReview||0) - (b.nextReview||0));
    }
    return arr;
}

function buildCardHTML(word, now) {
    const level = word.level || 0;
    const isMaxLevel = level === 5;
    const isReady = !word.nextReview || word.nextReview <= now;
    const reviewClass = (isReady && !isMaxLevel) ? 'needs-review' : '';
    const learnedStyle = isMaxLevel ? 'style="opacity: 0.5; background: rgba(40, 167, 69, 0.05);"' : '';
    const badge = `<span class="level-indicator">Ур. ${level}</span>`;
    const tagsBadges = (word.tags || []).map(t => `<span class="word-tag">${t}</span>`).join('');
    const isBulkSelected = selectedWordIds.has(word.id);
    const bulkClass = isBulkSelected ? ' bulk-selected' : '';
    const tatoebaBtn = `<button class="speak-btn" title="Tatoeba" onclick="event.stopPropagation();openTatoebaModal('${word.original.replace(/'/g,"\'")}')">📖</button>`;
    const hasVideo = word.videoId ? '<span style="font-size:10px;color:var(--accent-2);margin-left:4px">🎬</span>' : '';
    const hardWord = word.sm2EF && word.sm2EF < 2.0 ? '<span style="font-size:10px;color:var(--red);margin-left:4px" title="Трудное слово">⚠️</span>' : '';
    return `<div class="card ${reviewClass}${bulkClass}" data-id="${word.id}" data-word-id="${word.id}" ${learnedStyle} onclick="if(bulkSelectMode)toggleWordSelection(${word.id})">
        <div class="card-content">
            ${badge}
            <span class="original editable-text" contenteditable="${!bulkSelectMode}">${word.original}</span>
            <span class="arrow"> —> </span>
            <span class="translation hidden editable-text" contenteditable="${!bulkSelectMode}">${word.translate}</span>
            ${tagsBadges ? `<span style="margin-left:6px">${tagsBadges}</span>` : ''}
            ${hasVideo}${hardWord}
        </div>
        <div class="actions">
            <button class="speak-btn" title="Прослушать">🔊</button>
            ${tatoebaBtn}
            <button class="history-btn" title="История" onclick="event.stopPropagation();showWordHistory(${word.id})">📈</button>
            <button class="delete-btn" title="Удалить">&times;</button>
        </div>
    </div>`;
}

function renderVirtual(reset = false) {
    if (!element) return;
    const now = Date.now();
    if (reset) {
        virtWords = getSortedWords();
        virtRendered = Math.min(VIRT_PAGE, virtWords.length);
        element.innerHTML = virtWords.slice(0, virtRendered).map(w => buildCardHTML(w, now)).join('');
        // Счётчик "показано X из N"
        updateVirtCounter();
    } else {
        // Дозагружаем следующую порцию
        const prev = virtRendered;
        virtRendered = Math.min(virtRendered + VIRT_PAGE, virtWords.length);
        if (virtRendered > prev) {
            const frag = document.createDocumentFragment();
            virtWords.slice(prev, virtRendered).forEach(w => {
                const tmp = document.createElement('div');
                tmp.innerHTML = buildCardHTML(w, now);
                frag.appendChild(tmp.firstElementChild);
            });
            element.appendChild(frag);
            updateVirtCounter();
        }
    }
}

function updateVirtCounter() {
    let counter = document.getElementById('virt-counter');
    if (virtWords.length <= VIRT_PAGE) {
        if (counter) counter.remove();
        return;
    }
    if (!counter) {
        counter = document.createElement('div');
        counter.id = 'virt-counter';
        counter.style.cssText = 'text-align:center;font-size:11px;color:var(--text-3);padding:12px;';
        element.after(counter);
    }
    if (virtRendered < virtWords.length) {
        counter.textContent = `Показано ${virtRendered} из ${virtWords.length} слов — прокрути вниз для загрузки`;
    } else {
        counter.textContent = `Все ${virtWords.length} слов загружены`;
        setTimeout(() => counter.remove(), 3000);
    }
}

// Infinite scroll — подгружаем при приближении к концу списка
function initVirtScroll() {
    window.addEventListener('scroll', () => {
        if (document.getElementById('training-section')?.style.display === 'flex') return;
        if (virtRendered >= virtWords.length) return;
        const scrollBottom = window.scrollY + window.innerHeight;
        const docHeight = document.documentElement.scrollHeight;
        if (docHeight - scrollBottom < VIRT_THRESH) {
            renderVirtual(false);
        }
    }, { passive: true });
}
initVirtScroll();

function render() {
    if (!element) return;
    
    const now = Date.now();

    renderTagFilterBar();
    const sorted = getSortedWords();
    // Для маленьких словарей (≤80) — рендерим всё сразу (нет смысла виртуализировать)
    if (sorted.length <= VIRT_PAGE) {
        const cardsHTML = sorted.map(word => { 
        const level = word.level || 0;
        const isMaxLevel = level === 5;
        
        const isReady = !word.nextReview || word.nextReview <= now;
        const reviewClass = (isReady && !isMaxLevel) ? 'needs-review' : '';
        
        const learnedStyle = isMaxLevel ? 'style="opacity: 0.5; background: rgba(40, 167, 69, 0.05);"' : '';
        const badge = `<span class="level-indicator" style="font-size: 10px; color: #00d2ff; background: rgba(0, 210, 255, 0.1); padding: 2px 6px; border-radius: 4px; margin-right: 8px;">Ур. ${level}</span>`;
        const tagsBadges = (word.tags || []).map(t => `<span class="word-tag">${t}</span>`).join('');
        const hasVideo = word.videoId ? ' 🎬' : '';

        const isBulkSelected = selectedWordIds.has(word.id);
        const bulkClass = isBulkSelected ? ' bulk-selected' : '';
        const tatoebaBtn = `<button class="speak-btn" title="Найти примеры Tatoeba" onclick="event.stopPropagation();openTatoebaModal('${word.original.replace(/'/g,"\\'")}')">📖</button>`;

        return `
        <div class="card ${reviewClass}${bulkClass}" data-id="${word.id}" data-word-id="${word.id}" ${learnedStyle} onclick="if(bulkSelectMode)toggleWordSelection(${word.id})">
            <div class="card-content">
                ${badge}
                <span class="original editable-text" contenteditable="${!bulkSelectMode}">${word.original}</span>
                <span class="arrow" style="color: #999"> —> </span>
                <span class="translation hidden editable-text" contenteditable="${!bulkSelectMode}">${word.translate}</span>
                ${tagsBadges ? `<span style="margin-left:6px">${tagsBadges}</span>` : ''}
                ${hasVideo ? `<span style="font-size:10px;color:#b084f7;margin-left:4px;" title="Есть видео">${hasVideo}</span>` : ''}
                ${word.sm2EF && word.sm2EF < 2.0 ? `<span style="font-size:10px;color:#ff4d4d;margin-left:4px;" title="Трудное слово">⚠️</span>` : ''}
            </div>
            <div class="actions">
                <button class="speak-btn" title="Прослушать">🔊</button>
                ${tatoebaBtn}
                <button class="history-btn" title="История слова" onclick="event.stopPropagation();showWordHistory(${word.id})">📈</button>
                <button class="delete-btn" title="Удалить">&times;</button>
            </div>
        </div>`;
    }).join('');

        element.innerHTML = cardsHTML;
    } else {
        // Большой словарь — виртуализация
        renderVirtual(true);
    }
    updateOverallProgress();
    updateLevelStats();
    updateVisualProgress();
    updateTrainingBtnCount();
}

function updateTrainingBtnCount() {
    const btn = document.getElementById('start-training-btn');
    if (!btn) return;
    const now = Date.now();
    const readyCount = myWords.filter(w => !w.nextReview || w.nextReview <= now).length;
    if (readyCount > 0) {
        btn.textContent = `Начать тренировку (${readyCount} слов)`;
        btn.style.background = readyCount > 20 ? '#00bfff' : readyCount > 5 ? '#0099cc' : '#006b8f';
    } else {
        btn.textContent = 'Все слова повторены ✓';
        btn.style.background = 'rgba(40,167,69,0.4)';
    }
}

let _saveTimer = null;
async function save() {
    if (!isLoaded) return;
    localStorage.setItem('myWords', JSON.stringify(myWords));
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(async () => {
        try {
            await apiFetch('/api/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(myWords)
            });
        } catch (e) {}
    }, 1500);
}

function updateOverallProgress() {
    if (!progressBar) return;
    if (myWords.length === 0) {
        progressBar.style.width = '0%';
        progressPercent.innerText = '0%';
        progressStat.innerText = '0 / 0 слов';
        return;
    }
    const totalPossiblePoints = myWords.length * 5;
    const currentPoints = myWords.reduce((sum, w) => sum + (w.level || 0), 0);
    const percentage = Math.round((currentPoints / totalPossiblePoints) * 100);

    progressBar.style.width = `${percentage}%`;
    progressPercent.innerText = `${percentage}%`;
    progressStat.innerText = `${currentPoints} / ${totalPossiblePoints} опыта`;
}

// === 3. ЛОГИКА ТРЕНИРОВКИ ===

async function startTraining(mode) {
    // FIX: Если уже идет quiz-режим — сначала выходим из него
    if (isQuizMode) {
        restoreTrainingUI();
    }

    await dailyReset();
    try {
        await loadTimerFromServer();
    } catch (e) {}

    if (timeLeft <= 0) {
        timeLeft = TRAINING_TIME;
        await saveTimerToServer();
    }

    const now = Date.now();
    let wordsToReview;
    
    if (mode === 'mistakes') {
        // Только слова с ошибками (уровень 0 или те что ждут повтора)
        const mistakeIds = Object.keys(wordMistakes).map(Number);
        wordsToReview = myWords.filter(w => mistakeIds.includes(w.id) || (!w.nextReview || w.nextReview <= now));
    } else {
        wordsToReview = myWords.filter(w => !w.nextReview || w.nextReview <= now);
    }
    
    if (wordsToReview.length === 0) {
        showToast('Все слова уже повторены! Добавь новые или подожди следующего повторения.', 'info');
        return;
    }

    mainQueue = [...wordsToReview].sort(() => Math.random() - 0.5);
    activePool = [];
    currentWordIndex = 0;
    sessionCorrect = 0;
    sessionWrong = 0;
    comboCount = 0;
    sessionBestCombo = 0;
    sessionStartTodayCount = streakData.todayCount || 0;
    sessionStartStreakCount = streakData.count || 0;
    sessionStartTime = Date.now();
    wordMistakes = {};
    const comboEl = document.getElementById('combo-display');
    if (comboEl) comboEl.style.display = 'none';
    fillPool();

    // FIX: Останавливаем предыдущий таймер перед запуском нового
    if (timerId) {
        clearInterval(timerId);
        timerId = null;
    }

    timerId = setInterval(async () => {
        if (timeLeft <= 0) {
            clearInterval(timerId);
            timerId = null;
            await saveTimerToServer();
            finishDay();
            return;
        }
        timeLeft--;
        updateUI();
        if (timeLeft % 10 === 0) saveTimerToServer();
    }, 1000);

    document.getElementById('main-ui').style.display = 'none';
    document.getElementById('training-section').style.display = 'flex';

    const levelStats = document.getElementById('level-stats');
    if (levelStats) levelStats.style.display = 'none';
    if (mainHeader) mainHeader.style.display = 'none';
    if (progressWrapper) progressWrapper.style.display = 'none';

    // FIX: Убеждаемся что UI карточек восстановлен (не quiz)
    const fc = document.querySelector('.flashcard-container');
    const tb = document.querySelector('.training-buttons');
    const tg = document.getElementById('toggle-mode-btn');
    const qa = document.getElementById('quiz-area');
    if (fc) fc.style.display = '';
    if (tb) tb.style.display = '';
    if (tg) tg.style.display = '';
    if (qa) qa.style.display = 'none';
    isQuizMode = false;

    // FIX: Показываем кнопки Know/DontKnow, скрываем Next
    const btnKnow = document.getElementById('btn-know');
    const btnDontKnow = document.getElementById('btn-dont-know');
    const btnBack = document.getElementById('btn-back');
    const btnNext = document.getElementById('btn-next');
    if (btnKnow) btnKnow.style.display = 'block';
    if (btnDontKnow) btnDontKnow.style.display = 'block';
    if (btnNext) btnNext.style.display = 'none';
    if (btnBack) btnBack.classList.remove('full-width-btn');
    if (tg) tg.innerHTML = '<span>🎴</span> Режим: Карточки';
    isSpellingMode = false;
    if (spellingArea) spellingArea.style.display = 'none';

    updateFlashcard();
}

async function loadTimerFromServer() {
    const localTime = parseInt(localStorage.getItem('timeLeft')) || 0;
    if (localTime > 0) {
        timeLeft = localTime;
        updateUI();
    }

    try {
        const response = await apiFetch('/api/timer');
        if (!response.ok) throw new Error('Timer API unavailable');
        const data = await response.json();
        if (data.timeLeft > 0) {
            timeLeft = data.timeLeft;
            localStorage.setItem('timeLeft', String(timeLeft));
        }
        updateUI();
    } catch (e) {}
}

async function saveTimerToServer() {
    localStorage.setItem('timeLeft', String(timeLeft));
    try {
        await apiFetch('/api/timer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ timeLeft: timeLeft })
        });
    } catch (e) {}
}

async function addExtraTime(minutes) {
    timeLeft += minutes * 60;
    updateUI();
    await saveTimerToServer();

    const statusEl = document.getElementById('timer-status');
    if (statusEl) {
        statusEl.textContent = "Время добавлено";
        statusEl.style.color = "#00ffcc";
    }
}

function fillPool() {
    while (activePool.length < POOL_LIMIT && mainQueue.length > 0) {
        activePool.push(mainQueue.shift());
    }
}

async function dailyReset() {
    const lastVisit = localStorage.getItem('lastVisit');
    const today = new Date().toLocaleDateString();

    if (lastVisit !== today) {
        timeLeft = TRAINING_TIME;
        localStorage.setItem('lastVisit', today);
        await saveTimerToServer();
        return true;
    }
    return false;
}

function updateUI() {
    const displayEl = document.getElementById('timer-display');
    if (!displayEl) return;
    const mins = Math.floor(timeLeft / 60);
    const secs = timeLeft % 60;
    displayEl.textContent = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

function updateFlashcard() {
    if (activePool.length === 0) {
        finishTraining();
        return;
    }

    cardClickStage = 0; 
    const word = activePool[currentWordIndex];
    
    if (spellingInput) {
        spellingInput.value = "";
        if (isSpellingMode) spellingInput.focus();
    }
    if (spellingFeedback) {
        spellingFeedback.innerText = "";
    }

    const cardFront = document.getElementById('card-front');
    const cardBackText = document.getElementById('card-back-text');
    const cardExample = document.getElementById('card-example');
    const cardExRu = document.getElementById('card-example-translate');
    const exampleBlock = document.getElementById('card-example-block');

    if (exampleBlock) exampleBlock.style.display = 'none';
    if (cardExample) cardExample.style.visibility = 'hidden';
    if (cardExRu) cardExRu.style.visibility = 'hidden';
    if (flashcard) flashcard.classList.remove('is-flipped');

    // В режиме письма — всегда англ→рус (видим слово, пишем перевод)
    // В остальных режимах — рандомно
    const isEnToRu = isSpellingMode ? true : Math.random() > 0.5;
    if (isEnToRu) {
        cardFront.innerText = word.original;
        cardBackText.innerText = word.translate;
        word.currentExpectedAnswer = word.translate;
    } else {
        cardFront.innerText = word.translate;
        cardBackText.innerText = word.original;
        word.currentExpectedAnswer = word.original;
    }

    cardExample.innerText = word.example || "";
    cardExRu.innerText = word.exampleTranslate || "";

    document.getElementById('total-remaining').innerText = mainQueue.length;
    document.getElementById('current-pool-count').innerText = `${currentWordIndex + 1}/${activePool.length}`;

    // Транскрипция и картинка (асинхронно, не блокируем рендер)
    loadCardImage(word);
}

flashcard.onclick = () => {
    if (isSpellingMode && !flashcard.classList.contains('is-flipped')) return;

    const word = activePool[currentWordIndex];
    const exampleBlock = document.getElementById('card-example-block');
    const cardExample = document.getElementById('card-example');
    const cardExRu = document.getElementById('card-example-translate');
    
    const hasExample = word && word.example && word.example.trim() !== "";

    if (cardClickStage === 0) {
        flashcard.classList.add('is-flipped');
        clearCardBlur(); // снимаем блюр (письмо/аудио режим)
        playSound('flip');
        if (!isMuted && word) speak(word.original);
        cardClickStage = 1;
    } else if (cardClickStage === 1 && hasExample) {
        if (exampleBlock) exampleBlock.style.display = 'block';
        if (cardExample) cardExample.style.visibility = 'visible';
        if (cardExRu) cardExRu.style.visibility = 'hidden';
        cardClickStage = 2;
    } else if (cardClickStage === 2 && hasExample) {
        if (cardExRu) cardExRu.style.visibility = 'visible';
        cardClickStage = 3;
    } else {
        resetCardView();
    }
};

function resetCardView() {
    cardClickStage = 0;
    if (flashcard) flashcard.classList.remove('is-flipped');
    
    setTimeout(() => {
        const exampleBlock = document.getElementById('card-example-block');
        const cardExample = document.getElementById('card-example');
        const cardExRu = document.getElementById('card-example-translate');
        
        if (exampleBlock) exampleBlock.style.display = 'none';
        if (cardExample) cardExample.style.visibility = 'hidden';
        if (cardExRu) cardExRu.style.visibility = 'hidden';
    }, 200);
}

function stopTraining() {
    clearInterval(timerId);
    timerId = null;
    document.body.classList.remove('training-mode');
    // Просим разрешение на уведомления после первой тренировки
    setTimeout(requestNotificationPermission, 2000);
    const mobileNav = document.getElementById('mobile-nav');
    if (mobileNav) mobileNav.style.display = '';
    saveTimerToServer();
    if (isQuizMode) restoreTrainingUI();
    finishTraining();
}

function finishDay() {
    clearInterval(timerId);
    timerId = null;
    finishTraining(); 
    showToast('Время тренировки вышло! На сегодня достаточно 💪', 'warning', 5000);
    
    const statusEl = document.getElementById('timer-status');
    if (statusEl) {
        statusEl.textContent = "Лимит исчерпан";
        statusEl.style.color = "#ff4444";
    }
}

function finishTraining() {
    // FIX: Всегда восстанавливаем UI если был quiz
    if (isQuizMode) restoreTrainingUI();
    
    const levelStats = document.getElementById('level-stats');
    const mainUI = document.getElementById('main-ui');
    const trainSect = document.getElementById('training-section');
    const mainHeader = document.querySelector('h1');
    const progressWrapper = document.querySelector('.progress-wrapper');

    if (trainSect) trainSect.style.display = 'none';
    if (mainUI) mainUI.style.display = 'block';
    if (mainHeader) mainHeader.style.display = 'block';
    if (progressWrapper) progressWrapper.style.display = 'block';
    if (levelStats) levelStats.style.display = 'flex';

    document.body.classList.remove('no-scroll');
    document.body.style.overflow = 'auto';

    // FIX: Переустанавливаем обработчик кнопки после возврата
    const startBtnEl = document.getElementById('start-training-btn');
    if (startBtnEl) startBtnEl.onclick = () => startTraining();

    render();

    if (sessionCorrect + sessionWrong > 0) {
        setTimeout(() => {
            showResults();
            checkAchievements();
        }, 300);
    }
}

function nextStep() {
    flashcard.classList.remove('is-flipped');
    clearCardBlur();
    setTimeout(() => {
        updateFlashcard();
        onNewCard();
    }, 300);
}

function flashCard(correct) {
    return new Promise(resolve => {
        const fc = document.getElementById('flashcard');
        if (!fc) { resolve(); return; }

        const sides = fc.querySelectorAll('.flashcard-front, .flashcard-back');
        const cls = correct ? 'flash-correct' : 'flash-wrong';

        sides.forEach(s => s.classList.add(cls));

        setTimeout(() => {
            sides.forEach(s => s.classList.remove(cls));
            resolve();
        }, 380);
    });
}

function updateSessionCounter() {
    let el = document.getElementById('session-counter');
    if (!el) return;
    el.innerHTML = `<span class="stat-correct">✓ ${sessionCorrect}</span> <span class="stat-wrong">✗ ${sessionWrong}</span>`;
}

function saveToHistory(wasRemoved = false) {
    const currentWord = activePool[currentWordIndex];
    trainingHistory.push({
        wordId: currentWord.id, indexInPool: currentWordIndex,
        oldLevel: currentWord.level, oldNextReview: currentWord.nextReview,
        oldForgetStep: currentWord.forgetStep || 0,
        wasRemoved: wasRemoved
    });
}

function applyForgetSchedule(word) {
    if (!word) return;

    const step = Number(word.forgetStep) || 0;
    const nextDelay = FORGET_STEPS[Math.min(step, FORGET_STEPS.length - 1)];

    word.level = 0;
    word.nextReview = Date.now() + nextDelay;

    if (step < FORGET_STEPS.length - 1) {
        word.forgetStep = step + 1;
    } else {
        word.forgetStep = 0;
    }
}

// ============================================================
// ОБРАБОТЧИКИ 4 КНОПОК SM-2
// ============================================================

async function handleSM2Answer(quality) {
    if (isAnswering) return;
    isAnswering = true;
    const word = activePool[currentWordIndex];
    if (!word) { isAnswering = false; return; }

    const isCorrect = quality >= 2; // хорошо или легко = правильно
    if (isCorrect) {
        sessionCorrect++;
        updateCombo(true);
    } else if (quality === 0) {
        sessionWrong++;
        updateCombo(false);
        wordMistakes[word.id] = (wordMistakes[word.id] || 0) + 1;
    } else {
        // quality=1 (сложно) — не считаем ни ошибкой ни правильным
        updateCombo(false);
    }
    updateSessionCounter();
    saveToHistory(isCorrect);

    await flashCard(isCorrect);
    playSound(isCorrect ? 'correct' : 'wrong');

    const mainWord = myWords.find(w => w.id === word.id);
    if (mainWord) {
        sm2(mainWord, quality);
        // Записываем историю ответа
        if (!mainWord.history) mainWord.history = [];
        mainWord.history.push({ ts: Date.now(), q: quality, ef: mainWord.sm2EF });
        if (mainWord.history.length > 30) mainWord.history = mainWord.history.slice(-30);

        if (isCorrect) {
            streakData.todayCount++;
            recordDailyLearn(1);
            if (streakData.todayCount === 10) launchConfetti();
            updateStreak();
            // XP за ответ
            const xpGain = quality === 3 ? XP_PER_EASY : quality === 1 ? XP_PER_HARD : XP_PER_CORRECT;
            addXP(xpGain);
        }
        await save();
        checkWeeklyChallenge();
    }

    if (quality >= 2) {
        // Правильно — убираем из пула
        activePool.splice(currentWordIndex, 1);
        fillPool();
        if (currentWordIndex >= activePool.length) currentWordIndex = 0;
    } else {
        // Неправильно/сложно — оставляем в пуле, переходим дальше
        currentWordIndex++;
        if (currentWordIndex >= activePool.length) currentWordIndex = 0;
    }

    checkAchievements();
    isAnswering = false;
    nextStep();
}

// Совместимость со старыми вызовами (spelling mode, quiz)
document.getElementById('btn-know').onclick = () => handleSM2Answer(2);
document.getElementById('btn-dont-know').onclick = () => handleSM2Answer(0);
document.getElementById('btn-hard')?.addEventListener('click', () => handleSM2Answer(1));
document.getElementById('btn-easy')?.addEventListener('click', () => handleSM2Answer(3));

document.getElementById('btn-back').onclick = () => {
    if (trainingHistory.length === 0) return;
    const lastState = trainingHistory.pop();
    const mainWord = myWords.find(w => w.id === lastState.wordId);
    if (mainWord) {
        mainWord.level = lastState.oldLevel;
        mainWord.nextReview = lastState.oldNextReview;
        mainWord.forgetStep = lastState.oldForgetStep || 0;
        save();
    }
    if (lastState.wasRemoved) activePool.splice(lastState.indexInPool, 0, mainWord);
    currentWordIndex = lastState.indexInPool;
    nextStep();
};

document.getElementById('btn-next').onclick = () => {
    const word = activePool[currentWordIndex];
    if (!word) return;

    saveToHistory(false); 

    const mainWord = myWords.find(w => w.id === word.id);
    if (mainWord) {
        applyForgetSchedule(mainWord);
        save();
    }

    currentWordIndex++;
    if (currentWordIndex >= activePool.length) {
        currentWordIndex = 0;
    }
    
    nextStep();
};

// === 4. ОБРАБОТЧИКИ СОБЫТИЙ ===

if (resetLearnedBtn) {
    resetLearnedBtn.onclick = async () => {
        if (await showConfirm("Сбросить весь прогресс?<br><small style='color:#888'>Уровни слов, стрик и счётчик за сегодня обнулятся</small>", "Сбросить", "Отмена")) {
            myWords.forEach(word => {
                word.level = 0;
                word.nextReview = Date.now();
                word.forgetStep = 0;
            });

            streakData = {
                count: 0,
                lastDate: new Date().toDateString(),
                todayCount: 0
            };

            localStorage.setItem('streakData', JSON.stringify(streakData));
            dailyActivity = {};
            localStorage.setItem('dailyActivity', JSON.stringify(dailyActivity));

            await save(); 

            if (typeof updateStreak === 'function') {
                updateStreak();
            }
            
            render();
            updateOverallProgress();
            
            showToast('Весь прогресс сброшен', 'warning');
        }
    };
}

if (muteBtn) {
    muteIcon.innerText = isMuted ? '🔇' : '🔊';
    muteBtn.onclick = () => {
        isMuted = !isMuted;
        localStorage.setItem('isMuted', isMuted);
        muteIcon.innerText = isMuted ? '🔇' : '🔊';
        if (isMuted) window.speechSynthesis.cancel();
    };
}

clearBtn.onclick = async () => {
    if (await showConfirm("Удалить все слова?<br><small style='color:#888'>Это действие нельзя отменить</small>", "Удалить всё", "Отмена")) {
        myWords = [];
        await save();
        render();
    }
};

function updateLevelStats() {
    const statsEl = document.getElementById('level-stats');
    if (!statsEl) return;

    const accentColor = getComputedStyle(document.documentElement)
                        .getPropertyValue('--accent-color').trim() || '#00d2ff';

    const counts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    myWords.forEach(w => {
        counts[w.level || 0]++;
    });

    let statsHTML = Object.entries(counts).map(([lvl, count]) => {
        const color = lvl == 5 ? '#28a745' : accentColor;
        
        return `
            <div class="stat-item" 
                 onclick="filterByLevel(${lvl})" 
                 style="background: rgba(255,255,255,0.05); padding: 10px; border-radius: 8px; min-width: 60px; border-bottom: 3px solid ${color}; cursor: pointer;">
                <div style="font-size: 22px; font-weight: bold; color: ${color}; line-height: 1;">${count}</div>
                <div style="font-size: 11px; color: #888; margin-top: 5px; text-transform: uppercase;">Ур. ${lvl}</div>
            </div>
        `;
    }).join('');

    statsHTML += `
        <div class="stat-item" 
             onclick="filterByLevel('all')" 
             style="background: rgba(255,255,255,0.1); padding: 10px; border-radius: 8px; min-width: 60px; border-bottom: 3px solid #fff; cursor: pointer;">
            <div style="font-size: 22px; font-weight: bold; color: #fff; line-height: 1;">${myWords.length}</div>
            <div style="font-size: 11px; color: #fff; margin-top: 5px; text-transform: uppercase;">Все</div>
        </div>
    `;

    statsEl.innerHTML = statsHTML;
}

toggleModeBtn.onclick = () => {
    isSpellingMode = !isSpellingMode;
    const btnKnow = document.getElementById('btn-know');
    const btnDontKnow = document.getElementById('btn-dont-know');
    const btnBack = document.getElementById('btn-back');
    const btnNext = document.getElementById('btn-next');

    const audioRow = document.getElementById('audio-mode-row');
    const spellingExtraBtns = document.getElementById('spelling-extra-btns');
    if (isSpellingMode) {
        toggleModeBtn.innerHTML = "<span>📝</span> Режим: Письмо";
        spellingArea.style.display = 'block';
        btnKnow.style.display = 'none';
        btnDontKnow.style.display = 'none';
        document.getElementById('btn-hard')?.style && (document.getElementById('btn-hard').style.display = 'none');
        document.getElementById('btn-easy')?.style && (document.getElementById('btn-easy').style.display = 'none');
        btnNext.style.display = 'block';
        btnBack.classList.add('full-width-btn');
        if (audioRow) audioRow.style.display = 'none';
        if (spellingExtraBtns) spellingExtraBtns.style.display = 'flex';
        spellingInput.focus();
        clearCardBlur();
        onNewCard();
    } else {
        toggleModeBtn.innerHTML = "<span>🎴</span> Режим: Карточки";
        spellingArea.style.display = 'none';
        btnKnow.style.display = 'block';
        btnDontKnow.style.display = 'block';
        document.getElementById('btn-hard')?.style && (document.getElementById('btn-hard').style.display = 'block');
        document.getElementById('btn-easy')?.style && (document.getElementById('btn-easy').style.display = 'block');
        btnNext.style.display = 'none';
        btnBack.classList.remove('full-width-btn');
        if (audioRow) audioRow.style.display = 'flex';
        if (spellingExtraBtns) spellingExtraBtns.style.display = 'none';
        clearCardBlur();
    }
};

spellingInput.onkeydown = (e) => {
    if (e.key !== 'Enter') return;

    if (flashcard.classList.contains('is-flipped')) {
        document.getElementById('btn-know').click();
        return;
    }

    const word = activePool[currentWordIndex];
    if (!word) return;

    const userValue = spellingInput.value.trim().toLowerCase();
    const correctAnswer = (word.currentExpectedAnswer || '').trim().toLowerCase();

    if (userValue === correctAnswer) {
        spellingFeedback.innerText = "✅ Верно!";
        spellingFeedback.style.color = "#28a745";
    } else {
        spellingFeedback.innerText = `❌ Правильно: ${correctAnswer}`;
        spellingFeedback.style.color = "#dc3545";
    }

    flashcard.classList.add('is-flipped');
    cardClickStage = 1;
};

function toDayKey(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function recordDailyLearn(count = 1) {
    const key = toDayKey();
    dailyActivity[key] = (dailyActivity[key] || 0) + count;
    localStorage.setItem('dailyActivity', JSON.stringify(dailyActivity));
}

function updateLearningCurve() {
    if (!learningCurveEl) return;

    const counts = [0, 0, 0, 0, 0, 0];
    myWords.forEach(w => {
        const lvl = Math.min(Math.max(Number(w.level) || 0, 0), 5);
        counts[lvl]++;
    });

    const maxCount = Math.max(...counts, 1);
    learningCurveEl.innerHTML = counts.map((count, lvl) => {
        const width = Math.round((count / maxCount) * 100);
        return `<div class="level-row">
            <span>Ур. ${lvl}</span>
            <div class="level-fill-wrap"><div class="level-fill" style="width:${width}%"></div></div>
            <strong>${count}</strong>
        </div>`;
    }).join('');
}

function updateActivityHeatmap() {
    if (!activityHeatmapEl) return;

    const days = 84;
    const cells = [];
    let maxCount = 0;

    for (let i = days - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = toDayKey(d);
        const count = Number(dailyActivity[key]) || 0;
        if (count > maxCount) maxCount = count;
        cells.push({ key, count, date: d });
    }

    activityHeatmapEl.innerHTML = cells.map(({ count, date }) => {
        const alpha = maxCount > 0 ? (count / maxCount) : 0;
        const accentHex = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#7c6af7';
        const bg = count === 0 ? 'rgba(255,255,255,0.04)' : accentHex;
        const cellOpacity = count === 0 ? 1 : Math.max(0.15, alpha);
        const title = `${date.toLocaleDateString()}: ${count} слов`;
        return `<div class="heat-cell" title="${title}" style="background:${bg};opacity:${cellOpacity}"></div>`;
    }).join('');
}

function updateWeeklyProgressChart() {
    if (!weeklyChartEl) return;
    const ctx = weeklyChartEl.getContext('2d');
    if (!ctx) return;

    const labels = [];
    const values = [];

    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = toDayKey(d);
        labels.push(d.toLocaleDateString('ru-RU', { weekday: 'short' }));
        values.push(Number(dailyActivity[key]) || 0);
    }

    const w = weeklyChartEl.width;
    const h = weeklyChartEl.height;
    ctx.clearRect(0, 0, w, h);

    const pad = { left: 24, right: 10, top: 10, bottom: 22 };
    const graphW = w - pad.left - pad.right;
    const graphH = h - pad.top - pad.bottom;
    const maxV = Math.max(...values, 1);

    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top + graphH);
    ctx.lineTo(w - pad.right, pad.top + graphH);
    ctx.stroke();

    ctx.strokeStyle = '#00d2ff';
    ctx.lineWidth = 2;
    ctx.beginPath();

    values.forEach((v, i) => {
        const x = pad.left + (graphW / (values.length - 1)) * i;
        const y = pad.top + graphH - (v / maxV) * graphH;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = '#00d2ff';
    values.forEach((v, i) => {
        const x = pad.left + (graphW / (values.length - 1)) * i;
        const y = pad.top + graphH - (v / maxV) * graphH;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#aaa';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(labels[i], x, h - 6);
        ctx.fillStyle = '#00d2ff';
    });
}

function updateVisualProgress() {
    updateLearningCurve();
    updateActivityHeatmap();
    updateWeeklyProgressChart();
}

function updateStreak() {
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();

    if (streakData.lastDate !== today) {
        if (streakData.lastDate === yesterday && streakData.todayCount >= 10) {
            streakData.count = (streakData.count || 0) + 1;
        } else if (streakData.lastDate !== yesterday) {
            streakData.count = 0;
        }
        streakData.todayCount = 0;
        streakData.lastDate = today;
    }

    const streakCountEl = document.getElementById('streak-count');
    const dailyCountEl = document.getElementById('daily-count');
    if (streakCountEl) streakCountEl.innerText = streakData.count;
    if (dailyCountEl) dailyCountEl.innerText = streakData.todayCount;

    const streakContainer = document.getElementById('streak-container');
    if (streakContainer) {
        const pct = Math.min(streakData.todayCount / 10, 1);
        streakContainer.style.background = `linear-gradient(90deg, rgba(0,210,255,0.15) ${pct*100}%, #1e1e1e ${pct*100}%)`;
        if (streakData.todayCount >= 10 && streakData.count > 0) {
            streakContainer.style.background = 'rgba(40,167,69,0.15)';
        }
    }

    localStorage.setItem('streakData', JSON.stringify(streakData));
}

// Видимая кнопка добавить слово (под формой)
document.addEventListener('DOMContentLoaded', () => {
    const addWordBtn = document.getElementById('add-word-btn');
    if (addWordBtn) addWordBtn.onclick = () => addBtn.click();
});

addBtn.onclick = async () => {
    const en = inputEn.value.trim();
    const ru = inputRu.value.trim();
    if (!en || !ru) return;

    // Проверка дубликата
    const duplicate = myWords.find(w =>
        w.original.toLowerCase() === en.toLowerCase() ||
        w.translate.toLowerCase() === ru.toLowerCase()
    );
    if (duplicate) {
        const existingLevel = duplicate.level || 0;
        const nextRev = duplicate.nextReview
            ? new Date(duplicate.nextReview).toLocaleDateString('ru-RU')
            : '—';
        const confirmed = await showConfirm(
            `Слово уже есть в словаре:<br><br>
            <b style="color:#fff">${duplicate.original}</b> — ${duplicate.translate}<br>
            <small style="color:#888">Уровень: ${existingLevel} · Повторение: ${nextRev}</small><br><br>
            Добавить ещё раз?`,
            'Добавить', 'Отмена'
        );
        if (!confirmed) { inputEn.focus(); return; }
    }

    const tags = sanitizeTags(inputTags ? inputTags.value.split(',') : []);
    myWords.push({
        id: Date.now(),
        original: en, translate: ru,
        example: inputEx.value.trim(),
        exampleTranslate: inputExRu.value.trim(),
        level: 0, nextReview: Date.now(), forgetStep: 0,
        tags, videoId: '', startTime: 0,
        addedAt: Date.now(),
        history: []
    });
    await save();
    render();
    renderTagFilterBar();
    inputEn.value = ''; inputRu.value = ''; inputEx.value = ''; inputExRu.value = '';
    if (inputTags) inputTags.value = '';
    inputEn.focus();
    checkAchievements();
    updateXP();
    checkWeeklyChallenge();
};

element.onclick = (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const id = Number(card.dataset.id);
    const wordObj = myWords.find(w => w.id === id);
    if (e.target.classList.contains('speak-btn')) {
        speak(wordObj.original);
        return; 
    }
    if (e.target.classList.contains('delete-btn')) {
        const idx = myWords.findIndex(w => w.id === id);
        const removed = myWords.splice(idx, 1)[0];
        save(); render();
        showUndoToast(removed, idx);
        return;
    }
    const trans = card.querySelector('.translation');
    if (trans) trans.classList.toggle('hidden');
};

element.addEventListener('blur', (e) => {
    if (!e.target.classList.contains('editable-text')) return;
    const card = e.target.closest('.card');
    if (!card) return;
    const id = Number(card.dataset.id);
    const word = myWords.find(w => w.id === id);
    if (!word) return;

    const newText = e.target.innerText.trim();
    if (!newText) { e.target.innerText = e.target.classList.contains('original') ? word.original : word.translate; return; }

    if (e.target.classList.contains('original')) {
        word.original = newText;
    } else if (e.target.classList.contains('translation')) {
        word.translate = newText;
    }
    save();
    e.target.style.color = '#28a745';
    setTimeout(() => { e.target.style.color = ''; }, 600);
}, true);

if (stopBtn) stopBtn.onclick = stopTraining;

if (closeBtn) closeBtn.onclick = () => modal.style.display = "none";

if (importBtn) importBtn.onclick = async () => {
    const text = importArea.value;
    const lines = text.split('\n');
    let importedCount = 0;
    let duplicateCount = 0;
    const duplicatesList = [];
    const existingWords = new Set(myWords.map(w => (w.original || '').toLowerCase()));

    lines.forEach(line => {
        const parts = line.split('|').map(p => p.trim());
        
        if (parts.length >= 2) {
            const originalText = parts[0];
            const translateText = parts[1];
            const originalKey = originalText.toLowerCase();

            if (existingWords.has(originalKey)) {
                duplicateCount++;
                if (duplicatesList.length < 20) duplicatesList.push(originalText);
            } else {
                existingWords.add(originalKey);
                const parsedTags = sanitizeTags((parts[4] || '').split(',').map(t => t.trim()).filter(Boolean));
                const parsedVideoId = (parts[5] || '').trim();
                const parsedStartTime = Number(parts[6]) || 0;
                myWords.push({
                    id: Date.now() + Math.random(),
                    original: originalText,
                    translate: translateText,
                    example: parts[2] || "",
                    exampleTranslate: parts[3] || "",
                    level: 0,
                    nextReview: Date.now(),
                    forgetStep: 0,
                    tags: parsedTags,
                    videoId: parsedVideoId,
                    startTime: parsedStartTime
                });
                importedCount++;
            }
        }
    });

    if (importedCount > 0) {
        await save();
        render();
    }

    if (duplicateCount > 0) {
        showToast(`Добавлено ${importedCount} слов, пропущено дубликатов: ${duplicateCount}`, 'success');
    } else if (importedCount > 0) {
        showToast(`Добавлено ${importedCount} слов!`, 'success');
    } else {
        showToast('Новых слов не найдено — все уже есть в словаре', 'info');
    }

    modal.style.display = 'none';
    importArea.value = '';
};

if (exportBtn) exportBtn.onclick = () => {
    const textToSave = myWords.map(w => `${w.original}|${w.translate}|${w.example || ''}|${w.exampleTranslate || ''}|${(w.tags || []).join(',')}|${w.videoId || ''}|${w.startTime || 0}`).join('\n');
    const blob = new Blob([textToSave], { type: 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `словарь_${new Date().toLocaleDateString('ru-RU').replace(/\./g,'-')}.txt`;
    link.click();
};

const backupBtn = document.getElementById('backup-btn');
if (backupBtn) backupBtn.onclick = () => {
    const backup = {
        version: 1,
        exportedAt: new Date().toISOString(),
        words: myWords,
        streak: streakData,
        activity: dailyActivity
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `backup_${new Date().toLocaleDateString('ru-RU').replace(/\./g,'-')}.json`;
    link.click();
    showToast('Резервная копия сохранена', 'success');
};

const restoreBtn = document.getElementById('restore-btn');
const restoreInput = document.getElementById('restore-input');
if (restoreBtn && restoreInput) {
    restoreBtn.onclick = () => restoreInput.click();
    restoreInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data.words || !Array.isArray(data.words)) throw new Error('Неверный формат');
            if (await showConfirm(`Восстановить ${data.words.length} слов из резервной копии?<br><small style='color:#888'>Текущий словарь будет заменён</small>`, 'Восстановить', 'Отмена')) {
                myWords = data.words;
                if (data.streak) { streakData = data.streak; }
                if (data.activity) { dailyActivity = data.activity; }
                await save();
                updateStreak();
                render();
                showToast(`Восстановлено ${myWords.length} слов`, 'success');
            }
        } catch(err) {
            showToast('Не удалось прочитать файл. Убедись что это JSON-бэкап.', 'error');
        }
        restoreInput.value = '';
    };
}

if (searchInput) searchInput.oninput = () => {
    const val = searchInput.value.trim().toLowerCase();
    const cards = document.querySelectorAll('.card');

    cards.forEach(card => {
        const originalSpan = card.querySelector('.original');
        const translationSpan = card.querySelector('.translation');
        
        const originalText = originalSpan.textContent;
        const translationText = translationSpan.textContent;

        if (val === "") {
            card.style.display = 'flex';
            originalSpan.innerHTML = originalText;
            translationSpan.innerHTML = translationText;
            return;
        }

        const matchOriginal = originalText.toLowerCase().includes(val);
        const matchTranslation = translationText.toLowerCase().includes(val);

        if (matchOriginal || matchTranslation) {
            card.style.display = 'flex';
            originalSpan.innerHTML = highlightMatch(originalText, val);
            translationSpan.innerHTML = highlightMatch(translationText, val);
        } else {
            card.style.display = 'none';
        }
    });
};

function highlightMatch(text, term) {
    const regex = new RegExp(`(${term})`, 'gi');
    return text.replace(regex, `<mark>$1</mark>`);
}

function filterByLevel(level) {
    const cards = document.querySelectorAll('.card');
    
    cards.forEach(card => {
        const levelBadge = card.querySelector('.level-indicator');
        if (!levelBadge) return;

        const cardLevel = levelBadge.innerText.replace('Ур. ', '');

        if (level === 'all') {
            card.style.display = 'flex';
        } else if (cardLevel == level) {
            card.style.display = 'flex';
        } else {
            card.style.display = 'none';
        }
    });
}

// ════════════════════════════════════
// ТЕМЫ
// ════════════════════════════════════
const THEMES = [
    // Тёмные
    { id:'violet',  name:'Фиолет',        desc:'Тёмный · По умолчанию',
      accent:'#7c6af7', accent2:'#a78bfa', glow:'rgba(124,106,247,0.25)', dim:'rgba(124,106,247,0.1)',
      bg:'#080810', bg1:'#0e0e18', bg2:'#14141f', bg3:'#1c1c2a', bg4:'#242436',
      text:'#eeeef5', text2:'#8888aa', text3:'#44445a', border:'rgba(255,255,255,0.06)', borderHi:'rgba(255,255,255,0.12)' },
    { id:'midnight', name:'Полночь',      desc:'Тёмный · Глубокий синий',
      accent:'#3b82f6', accent2:'#60a5fa', glow:'rgba(59,130,246,0.25)', dim:'rgba(59,130,246,0.1)',
      bg:'#020409', bg1:'#050c18', bg2:'#0a1428', bg3:'#111e38', bg4:'#182848',
      text:'#edf2ff', text2:'#7b9acc', text3:'#3d5a80', border:'rgba(96,165,250,0.08)', borderHi:'rgba(96,165,250,0.18)' },
    { id:'forest',  name:'Лес',           desc:'Тёмный · Зелёный',
      accent:'#10b981', accent2:'#34d399', glow:'rgba(16,185,129,0.25)', dim:'rgba(16,185,129,0.1)',
      bg:'#020c07', bg1:'#061410', bg2:'#0c1e17', bg3:'#132a20', bg4:'#1a382a',
      text:'#e8f5ee', text2:'#6aaa88', text3:'#2d5a42', border:'rgba(52,211,153,0.08)', borderHi:'rgba(52,211,153,0.18)' },
    { id:'rose',    name:'Ночная роза',   desc:'Тёмный · Красный',
      accent:'#f43f5e', accent2:'#fb7185', glow:'rgba(244,63,94,0.25)', dim:'rgba(244,63,94,0.1)',
      bg:'#0d0305', bg1:'#180608', bg2:'#230c10', bg3:'#30111a', bg4:'#3d1724',
      text:'#ffeef2', text2:'#cc7088', text3:'#6b2d3c', border:'rgba(248,113,113,0.08)', borderHi:'rgba(248,113,113,0.18)' },
    { id:'amber',   name:'Янтарь',        desc:'Тёмный · Золотой',
      accent:'#f59e0b', accent2:'#fbbf24', glow:'rgba(245,158,11,0.25)', dim:'rgba(245,158,11,0.1)',
      bg:'#0b0800', bg1:'#160f00', bg2:'#201600', bg3:'#2c1e00', bg4:'#382600',
      text:'#fff8e8', text2:'#b8952a', text3:'#5c4810', border:'rgba(251,191,36,0.08)', borderHi:'rgba(251,191,36,0.18)' },
    { id:'oled',    name:'OLED',          desc:'Чисто чёрный',
      accent:'#a78bfa', accent2:'#c4b5fd', glow:'rgba(167,139,250,0.25)', dim:'rgba(167,139,250,0.1)',
      bg:'#000000', bg1:'#050505', bg2:'#0a0a0a', bg3:'#111111', bg4:'#181818',
      text:'#ffffff', text2:'#888888', text3:'#444444', border:'rgba(255,255,255,0.06)', borderHi:'rgba(255,255,255,0.14)' },
    // Светлые
    { id:'snow',      name:'Снег',        desc:'Светлый · Чистый белый',
      accent:'#6366f1', accent2:'#818cf8', glow:'rgba(99,102,241,0.2)', dim:'rgba(99,102,241,0.08)',
      bg:'#fafbff', bg1:'#f2f4fc', bg2:'#e8ecf8', bg3:'#dde2f4', bg4:'#d2d8ef',
      text:'#1a1c2e', text2:'#5558a0', text3:'#9098c4', border:'rgba(0,0,0,0.07)', borderHi:'rgba(0,0,0,0.14)' },

    { id:'cream',     name:'Крем',        desc:'Светлый · Тёплый бежевый',
      accent:'#c2410c', accent2:'#ea580c', glow:'rgba(194,65,12,0.2)', dim:'rgba(194,65,12,0.08)',
      bg:'#fdf8f2', bg1:'#f7ede0', bg2:'#efe0cc', bg3:'#e4d0b8', bg4:'#d8bfa0',
      text:'#1c1208', text2:'#7a5830', text3:'#b8966a', border:'rgba(0,0,0,0.07)', borderHi:'rgba(0,0,0,0.14)' },

    { id:'paper',     name:'Бумага',      desc:'Светлый · Газетный',
      accent:'#374151', accent2:'#4b5563', glow:'rgba(55,65,81,0.2)', dim:'rgba(55,65,81,0.07)',
      bg:'#f5f0e8', bg1:'#ede7d9', bg2:'#e3dbc8', bg3:'#d6ccb4', bg4:'#c8bb9e',
      text:'#1a1614', text2:'#5c5040', text3:'#9e8e76', border:'rgba(0,0,0,0.08)', borderHi:'rgba(0,0,0,0.16)' },

    { id:'mint',      name:'Мята',        desc:'Светлый · Свежий зелёный',
      accent:'#059669', accent2:'#10b981', glow:'rgba(5,150,105,0.2)', dim:'rgba(5,150,105,0.08)',
      bg:'#f0fdf8', bg1:'#e0f7ef', bg2:'#ccf0e3', bg3:'#b3e8d4', bg4:'#96dfc4',
      text:'#052e1c', text2:'#166534', text3:'#4ade80', border:'rgba(0,0,0,0.07)', borderHi:'rgba(0,0,0,0.14)' },

    { id:'lavender',  name:'Лаванда',     desc:'Светлый · Нежно-фиолетовый',
      accent:'#7c3aed', accent2:'#8b5cf6', glow:'rgba(124,58,237,0.2)', dim:'rgba(124,58,237,0.08)',
      bg:'#faf5ff', bg1:'#f3e8ff', bg2:'#e9d5ff', bg3:'#ddb8fd', bg4:'#c084fc',
      text:'#1e0a3c', text2:'#6b21a8', text3:'#9f55d0', border:'rgba(0,0,0,0.07)', borderHi:'rgba(0,0,0,0.14)' },

    { id:'rose-light', name:'Роза',       desc:'Светлый · Нежно-розовый',
      accent:'#be185d', accent2:'#db2777', glow:'rgba(190,24,93,0.2)', dim:'rgba(190,24,93,0.08)',
      bg:'#fff1f5', bg1:'#ffe4ec', bg2:'#fecdd8', bg3:'#fba6bc', bg4:'#f9789c',
      text:'#2d0016', text2:'#9d174d', text3:'#db7aaa', border:'rgba(0,0,0,0.07)', borderHi:'rgba(0,0,0,0.14)' },

    { id:'sky-light',  name:'Небо',       desc:'Светлый · Голубой',
      accent:'#0369a1', accent2:'#0284c7', glow:'rgba(3,105,161,0.2)', dim:'rgba(3,105,161,0.08)',
      bg:'#f0f9ff', bg1:'#e0f2fe', bg2:'#bae6fd', bg3:'#7dd3fc', bg4:'#38bdf8',
      text:'#0c1a29', text2:'#075985', text3:'#0ea5e9', border:'rgba(0,0,0,0.07)', borderHi:'rgba(0,0,0,0.14)' },

    { id:'sand',       name:'Песок',      desc:'Светлый · Пустынный',
      accent:'#b45309', accent2:'#d97706', glow:'rgba(180,83,9,0.2)', dim:'rgba(180,83,9,0.08)',
      bg:'#fefce8', bg1:'#fef9c3', bg2:'#fde68a', bg3:'#fcd34d', bg4:'#f59e0b',
      text:'#1c1400', text2:'#78350f', text3:'#b45309', border:'rgba(0,0,0,0.07)', borderHi:'rgba(0,0,0,0.14)' },

    { id:'nord',       name:'Норд',       desc:'Светлый · Скандинавский',
      accent:'#5e81ac', accent2:'#81a1c1', glow:'rgba(94,129,172,0.2)', dim:'rgba(94,129,172,0.08)',
      bg:'#eceff4', bg1:'#e5e9f0', bg2:'#d8dee9', bg3:'#c8d0e0', bg4:'#b8c4d8',
      text:'#2e3440', text2:'#4c566a', text3:'#7b88a1', border:'rgba(0,0,0,0.08)', borderHi:'rgba(0,0,0,0.16)' },

    { id:'matcha',     name:'Матча',      desc:'Светлый · Японский чай',
      accent:'#3d6b35', accent2:'#4d8a43', glow:'rgba(61,107,53,0.2)', dim:'rgba(61,107,53,0.08)',
      bg:'#f4f7f0', bg1:'#e8eee3', bg2:'#d8e3d0', bg3:'#c4d4b8', bg4:'#aec4a0',
      text:'#1a2518', text2:'#3d6b35', text3:'#7a9e72', border:'rgba(0,0,0,0.07)', borderHi:'rgba(0,0,0,0.14)' },
];

let currentThemeId = localStorage.getItem('themeId') || 'violet';

function setTheme(themeId) {
    let theme = THEMES.find(t => t.id === themeId);
    if (!theme) theme = THEMES[0];
    currentThemeId = theme.id;
    localStorage.setItem('themeId', theme.id);
    const r = document.documentElement;
    r.style.setProperty('--accent',      theme.accent);
    r.style.setProperty('--accent-2',    theme.accent2);
    r.style.setProperty('--accent-glow', theme.glow);
    r.style.setProperty('--accent-dim',  theme.dim);
    r.style.setProperty('--bg',          theme.bg);
    r.style.setProperty('--bg-1',        theme.bg1);
    r.style.setProperty('--bg-2',        theme.bg2);
    r.style.setProperty('--bg-3',        theme.bg3);
    r.style.setProperty('--bg-4',        theme.bg4);
    r.style.setProperty('--text',        theme.text);
    r.style.setProperty('--text-2',      theme.text2);
    r.style.setProperty('--text-3',      theme.text3);
    r.style.setProperty('--border',      theme.border);
    r.style.setProperty('--border-hi',   theme.borderHi);
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) { meta = document.createElement('meta'); meta.name='theme-color'; document.head.appendChild(meta); }
    meta.content = theme.bg;
    document.body.dataset.theme = themeId;
    updateLevelStats();
    renderThemeGrid();
}

function openThemeModal() {
    const modal = document.getElementById('theme-modal');
    if (!modal) return;
    renderThemeGrid();
    modal.style.display = 'flex';
}

function renderThemeGrid() {
    const grid = document.getElementById('theme-grid');
    if (!grid) return;

    const dark  = THEMES.filter(t => t.bg < '#888');  // hex dark bg starts with 0
    const light = THEMES.filter(t => t.bg >= '#888'); // light bg starts with f/e/d

    const renderCard = t => `
        <div class="theme-card ${t.id === currentThemeId ? 'active' : ''}" onclick="setTheme('${t.id}')">
            <div class="theme-swatch">
                <div class="theme-swatch-inner">
                    <div style="background:${t.bg}"></div>
                    <div style="background:${t.bg3}"></div>
                    <div style="background:${t.accent}"></div>
                    <div style="background:${t.bg2}"></div>
                </div>
            </div>
            <div style="min-width:0">
                <div class="theme-name">${t.name}</div>
                <div class="theme-desc">${t.desc.replace(/Тёмный · |Светлый · /, '')}</div>
            </div>
        </div>`;

    grid.innerHTML =
        '<div class="theme-section-label">🌙 Тёмные</div>' +
        dark.map(renderCard).join('') +
        '<div class="theme-section-label">☀️ Светлые</div>' +
        light.map(renderCard).join('');
}

function closeThemeModal() {
    const m = document.getElementById('theme-modal');
    if (m) m.style.display = 'none';
}

function openImportModal() {
    const m = document.getElementById('import-modal');
    if (!m) return;
    m.style.display = 'flex';
    // Не делаем auto-focus — на iOS это вызывает проблемы с клавиатурой
}

// ============================================================
// СВАЙП КАРТОЧКИ
// ============================================================
(function initSwipe() {
    const fc = document.getElementById('flashcard');
    if (!fc) return;

    let startX = 0, startY = 0, isDragging = false;
    const THRESHOLD = 80;

    function onStart(x, y) {
        startX = x; startY = y;
        isDragging = true;
        fc.style.transition = 'none';
    }

    function onMove(x, y) {
        if (!isDragging) return;
        const dx = x - startX;
        const dy = y - startY;
        if (Math.abs(dy) > Math.abs(dx) + 10) { isDragging = false; fc.style.transform = ''; return; }
        const rotate = dx * 0.08;
        fc.style.transform = `translateX(${dx}px) rotate(${rotate}deg)`;
        const sides = fc.querySelectorAll('.flashcard-front, .flashcard-back');
        if (dx > 40) sides.forEach(s => { s.classList.remove('flash-wrong'); s.classList.add('flash-correct'); });
        else if (dx < -40) sides.forEach(s => { s.classList.remove('flash-correct'); s.classList.add('flash-wrong'); });
        else sides.forEach(s => { s.classList.remove('flash-correct', 'flash-wrong'); });
    }

    function onEnd(x) {
        if (!isDragging) return;
        isDragging = false;
        const dx = x - startX;
        fc.style.transition = 'transform 0.3s';

        if (dx > THRESHOLD) {
            fc.style.transform = 'translateX(120%) rotate(20deg)';
            setTimeout(() => {
                fc.style.transform = '';
                fc.style.transition = '';
                document.getElementById('btn-know').click();
            }, 280);
        } else if (dx < -THRESHOLD) {
            fc.style.transform = 'translateX(-120%) rotate(-20deg)';
            setTimeout(() => {
                fc.style.transform = '';
                fc.style.transition = '';
                document.getElementById('btn-dont-know').click();
            }, 280);
        } else {
            fc.style.transform = '';
            setTimeout(() => { fc.style.transition = ''; }, 300);
        }
    }

    fc.addEventListener('touchstart', e => {
        if (fc.classList.contains('is-flipped')) return;
        const t = e.touches[0];
        onStart(t.clientX, t.clientY);
    }, { passive: true });

    fc.addEventListener('touchmove', e => {
        const t = e.touches[0];
        onMove(t.clientX, t.clientY);
    }, { passive: true });

    fc.addEventListener('touchend', e => {
        const t = e.changedTouches[0];
        onEnd(t.clientX);
    });
})();


function launchConfetti() {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9999';
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const pieces = Array.from({length: 120}, () => ({
        x: Math.random() * canvas.width,
        y: -20 - Math.random() * 100,
        r: 4 + Math.random() * 6,
        d: 2 + Math.random() * 3,
        color: ['#00d2ff','#28a745','#f39c12','#e74c3c','#9b59b6','#fff'][Math.floor(Math.random()*6)],
        tilt: Math.random() * 10 - 5,
        tiltSpeed: 0.1 + Math.random() * 0.2,
        angle: 0
    }));

    let frame = 0;
    function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        pieces.forEach(p => {
            p.angle += p.tiltSpeed;
            p.y += p.d;
            p.x += Math.sin(p.angle) * 1.5;
            p.tilt = Math.sin(p.angle) * 12;
            ctx.beginPath();
            ctx.lineWidth = p.r;
            ctx.strokeStyle = p.color;
            ctx.moveTo(p.x + p.tilt + p.r / 2, p.y);
            ctx.lineTo(p.x + p.tilt, p.y + p.tilt + p.r / 2);
            ctx.stroke();
        });
        frame++;
        if (frame < 160) requestAnimationFrame(draw);
        else canvas.remove();
    }
    draw();
}


// ============================================================
// ГОРЯЧИЕ КЛАВИШИ
// ============================================================
document.addEventListener('keydown', (e) => {
    const trainSect = document.getElementById('training-section');
    if (!trainSect || trainSect.style.display === 'none') return;

    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (e.code === 'Space') {
        e.preventDefault();
        flashcard.click();
    } else if (e.code === 'ArrowRight' || e.code === 'KeyL') {
        e.preventDefault();
        document.getElementById('btn-know')?.click();
    } else if (e.code === 'ArrowLeft' || e.code === 'KeyJ') {
        e.preventDefault();
        document.getElementById('btn-dont-know')?.click();
    } else if (e.code === 'ArrowDown' || e.code === 'KeyS') {
        e.preventDefault();
        document.getElementById('btn-back')?.click();
    }
});


// ============================================================
// СОРТИРОВКА СПИСКА
// ============================================================
let currentSort = 'default';

function getSortedWords() {
    const arr = [...myWords];
    switch (currentSort) {
        case 'level-asc':  return arr.sort((a,b) => (a.level||0) - (b.level||0));
        case 'level-desc': return arr.sort((a,b) => (b.level||0) - (a.level||0));
        case 'alpha':      return arr.sort((a,b) => a.original.localeCompare(b.original));
        case 'review':     return arr.sort((a,b) => (a.nextReview||0) - (b.nextReview||0));
        default:           return arr;
    }
}

function setSortMode(mode) {
    currentSort = mode;
    document.querySelectorAll('.sort-btn').forEach(b => {
        b.style.background = b.dataset.sort === mode
            ? 'rgba(0,210,255,0.2)'
            : 'rgba(255,255,255,0.05)';
        b.style.borderColor = b.dataset.sort === mode
            ? 'var(--accent-color)'
            : 'rgba(255,255,255,0.1)';
    });
    render();
}


// ============================================================
// TOAST — уведомления
// ============================================================
function showToast(message, type = 'info', duration = 3500) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }

    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    const colors = {
        success: 'rgba(40,167,69,0.15)',
        error:   'rgba(220,53,69,0.15)',
        warning: 'rgba(243,156,18,0.15)',
        info:    'rgba(0,210,255,0.12)'
    };
    const borders = {
        success: 'rgba(40,167,69,0.4)',
        error:   'rgba(220,53,69,0.4)',
        warning: 'rgba(243,156,18,0.4)',
        info:    'rgba(0,210,255,0.35)'
    };

    const toast = document.createElement('div');
    toast.style.cssText = `
        display:flex;align-items:flex-start;gap:10px;
        background:${colors[type]};
        border:1px solid ${borders[type]};
        backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
        padding:12px 16px;border-radius:14px;
        color:#fff;font-size:14px;line-height:1.4;
        box-shadow:0 4px 20px rgba(0,0,0,0.4);
        max-width:320px;word-break:break-word;
        animation:toastIn 0.3s ease;
        cursor:pointer;
    `;
    toast.innerHTML = `<span style="font-size:16px;flex-shrink:0">${icons[type]}</span><span>${message}</span>`;
    toast.onclick = () => dismissToast(toast);
    container.appendChild(toast);

    const timer = setTimeout(() => dismissToast(toast), duration);
    toast._timer = timer;

    return toast;
}

function dismissToast(toast) {
    clearTimeout(toast._timer);
    toast.style.animation = 'toastOut 0.25s ease forwards';
    setTimeout(() => toast.remove(), 250);
}

function showConfirm(message, confirmText = 'Подтвердить', cancelText = 'Отмена') {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';

        const box = document.createElement('div');
        box.style.cssText = 'background:#1e1e1e;border:1px solid rgba(255,255,255,0.1);border-radius:20px;padding:28px 24px;max-width:320px;width:90%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.6);animation:toastIn 0.2s ease;';
        box.innerHTML = `
            <p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:#eee">${message}</p>
            <div style="display:flex;gap:10px;justify-content:center">
                <button id="confirm-cancel" style="all:unset;padding:10px 22px;border-radius:12px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);color:#aaa;cursor:pointer;font-size:14px;">${cancelText}</button>
                <button id="confirm-ok" style="all:unset;padding:10px 22px;border-radius:12px;background:rgba(220,53,69,0.2);border:1px solid rgba(220,53,69,0.4);color:#ff6b6b;cursor:pointer;font-size:14px;font-weight:600;">${confirmText}</button>
            </div>
        `;
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const close = (val) => { overlay.remove(); resolve(val); };
        box.querySelector('#confirm-ok').onclick     = () => close(true);
        box.querySelector('#confirm-cancel').onclick = () => close(false);
        overlay.onclick = (e) => { if (e.target === overlay) close(false); };
    });
}


// ============================================================
// ЗВУКОВЫЕ ЭФФЕКТЫ
// ============================================================
let audioCtx = null;

function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
}

function playSound(type) {
    if (isMuted) return;
    try {
        const ctx = getAudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        if (type === 'correct') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(440, ctx.currentTime);
            osc.frequency.setValueAtTime(660, ctx.currentTime + 0.08);
            gain.gain.setValueAtTime(0.18, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.35);
        } else if (type === 'wrong') {
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(300, ctx.currentTime);
            osc.frequency.setValueAtTime(180, ctx.currentTime + 0.15);
            gain.gain.setValueAtTime(0.12, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.3);
        } else if (type === 'flip') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(800, ctx.currentTime);
            gain.gain.setValueAtTime(0.06, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.08);
        } else if (type === 'combo') {
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(523, ctx.currentTime);
            osc.frequency.setValueAtTime(784, ctx.currentTime + 0.1);
            gain.gain.setValueAtTime(0.15, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.4);
        }
    } catch(e) {}
}


// ============================================================
// ИТОГИ ТРЕНИРОВКИ
// ============================================================
let sessionStartTime = 0;
let wordMistakes = {}; // per-session only

function showResults() {
    const modal = document.getElementById('results-modal');
    if (!modal) return;

    const total = sessionCorrect + sessionWrong;
    const accuracy = total > 0 ? Math.round(sessionCorrect / total * 100) : 0;
    const mins = Math.max(1, Math.round((Date.now() - sessionStartTime) / 60000));
    const gainedToday = Math.max(0, (streakData.todayCount || 0) - sessionStartTodayCount);
    const gainedStreak = Math.max(0, (streakData.count || 0) - sessionStartStreakCount);

    const emoji = accuracy >= 90 ? '🏆' : accuracy >= 70 ? '🎉' : accuracy >= 50 ? '💪' : '📚';
    const emojiEl = document.getElementById('results-emoji');
    if (emojiEl) emojiEl.textContent = emoji;

    const grid = document.getElementById('results-grid');
    if (grid) {
        grid.innerHTML = [
            { value: sessionCorrect, label: 'Верно', color: '#28a745' },
            { value: sessionWrong,   label: 'Ошибки', color: '#ff4d4d' },
            { value: accuracy + '%', label: 'Точность', color: accuracy >= 70 ? '#00d2ff' : '#f39c12' },
            { value: sessionBestCombo + '×', label: 'Макс. комбо', color: '#f39c12' },
            { value: mins + ' мин',  label: 'Время', color: '#aaa' },
            { value: `+${gainedToday}`, label: 'Сегодня изучено', color: '#00d2ff' },
            { value: `${streakData.count} 🔥${gainedStreak > 0 ? ` (+${gainedStreak})` : ''}`, label: 'Стрик', color: '#ff6b35' },
        ].map(r => `
            <div class="result-card">
                <div class="rc-value" style="color:${r.color}">${r.value}</div>
                <div class="rc-label">${r.label}</div>
            </div>
        `).join('');
    }

    const hardEntries = Object.entries(wordMistakes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id, cnt]) => {
            const w = myWords.find(x => x.id == id);
            return w ? `<div class="results-hard-item"><span class="results-hard-word">${w.original}</span><span class="results-hard-cnt">${cnt}x X</span></div>` : '';
        }).filter(Boolean).join('');

    const hardEl = document.getElementById('results-hardest');
    if (hardEl) {
        if (hardEntries) {
            hardEl.innerHTML = '<div class="results-hard-title">Сложные слова</div>' + hardEntries;
            hardEl.className = 'results-hard-block';
            hardEl.style.display = 'block';
        } else {
            hardEl.style.display = 'none';
        }
    }

    modal.style.display = 'flex';
}

function closeResults() {
    const modal = document.getElementById('results-modal');
    if (modal) modal.style.display = 'none';
}

// ============================================================
// СТАТИСТИКА ЗАБЫВАЕМОСТИ
// ============================================================
function showForgettingStats() {
    const modal = document.getElementById('forgetting-stats-modal');
    if (!modal) return;

    // Топ "трудных" слов: много forgetStep или много ошибок в сессии
    const hardWords = [...myWords]
        .filter(w => (w.forgetStep || 0) > 0 || (w.sm2EF || 2.5) < 2.0)
        .map(w => ({
            ...w,
            difficulty: (w.forgetStep || 0) * 2 + Math.max(0, (2.5 - (w.sm2EF || 2.5)) * 5)
        }))
        .sort((a, b) => b.difficulty - a.difficulty)
        .slice(0, 20);

    // Слова выученные недавно (level 5)
    const mastered = myWords.filter(w => w.level >= 5).length;
    const total = myWords.length;
    const avgEF = myWords.length
        ? (myWords.reduce((s, w) => s + (w.sm2EF || 2.5), 0) / myWords.length).toFixed(2)
        : '—';

    const nextReviewDist = { today: 0, week: 0, month: 0, later: 0 };
    const now = Date.now();
    myWords.forEach(w => {
        const diff = (w.nextReview || 0) - now;
        if (diff <= 0) nextReviewDist.today++;
        else if (diff <= 7 * 86400000) nextReviewDist.week++;
        else if (diff <= 30 * 86400000) nextReviewDist.month++;
        else nextReviewDist.later++;
    });

    const container = document.getElementById('forgetting-stats-content');
    container.innerHTML = `
        <div class="fst-grid">
            <div class="fst-card">
                <div class="fst-val">${nextReviewDist.today}</div>
                <div class="fst-label">Повторить сегодня</div>
            </div>
            <div class="fst-card">
                <div class="fst-val">${nextReviewDist.week}</div>
                <div class="fst-label">На этой неделе</div>
            </div>
            <div class="fst-card">
                <div class="fst-val">${mastered}</div>
                <div class="fst-label">Выучено (ур.5)</div>
            </div>
            <div class="fst-card">
                <div class="fst-val" style="color: ${avgEF < 2.0 ? '#ff4d4d' : avgEF >= 2.4 ? '#28a745' : '#f39c12'}">${avgEF}</div>
                <div class="fst-label">Средний EF (≥2.5 хорошо)</div>
            </div>
        </div>

        <div class="fst-section-title">📅 Расписание повторений</div>
        <div class="fst-schedule">
            ${[
                { label: 'Сегодня', val: nextReviewDist.today, color: '#ff4d4d' },
                { label: 'На неделе', val: nextReviewDist.week, color: '#f39c12' },
                { label: 'В месяц', val: nextReviewDist.month, color: '#b084f7' },
                { label: 'Позже', val: nextReviewDist.later, color: '#28a745' }
            ].map(({ label, val, color }) => {
                const pct = total ? Math.round(val / total * 100) : 0;
                return `<div class="fst-bar-row">
                    <div class="fst-bar-label">${label}</div>
                    <div class="fst-bar-wrap"><div class="fst-bar-fill" style="width:${pct}%;background:${color}"></div></div>
                    <div class="fst-bar-count">${val}</div>
                </div>`;
            }).join('')}
        </div>

        ${hardWords.length > 0 ? `
        <div class="fst-section-title">🔥 Проблемные слова (чаще всего забываются)</div>
        <div class="fst-hard-list">
            ${hardWords.map(w => {
                const ef = (w.sm2EF || 2.5).toFixed(1);
                const efColor = ef < 1.8 ? '#ff4d4d' : ef < 2.2 ? '#f39c12' : '#b084f7';
                return `<div class="fst-hard-item">
                    <div>
                        <span class="fst-word">${w.original}</span>
                        <span class="fst-trans">${w.translate}</span>
                    </div>
                    <div style="display:flex;gap:8px;align-items:center;">
                        <span class="fst-tag" style="color:${efColor}">EF ${ef}</span>
                        ${w.forgetStep > 0 ? `<span class="fst-tag" style="color:#ff4d4d">Забыто ${w.forgetStep}×</span>` : ''}
                    </div>
                </div>`;
            }).join('')}
        </div>` : '<div style="color:#555;text-align:center;padding:16px;">Проблемных слов нет 🎉</div>'}
    `;

    modal.style.display = 'flex';
}

function closeForgettingStats() {
    const modal = document.getElementById('forgetting-stats-modal');
    if (modal) modal.style.display = 'none';
}


// ============================================================
// ДОСТИЖЕНИЯ
// ============================================================
const ACHIEVEMENTS = [
    { id: 'words10',    icon: '🌱', title: 'Первые шаги',    desc: '10 слов в словаре',        check: () => myWords.length >= 10 },
    { id: 'words100',   icon: '📚', title: 'Библиотека',     desc: '100 слов в словаре',       check: () => myWords.length >= 100 },
    { id: 'words500',   icon: '🧠', title: 'Эрудит',         desc: '500 слов в словаре',       check: () => myWords.length >= 500 },
    { id: 'streak3',    icon: '🔥', title: 'На волне',       desc: '3 дня подряд',             check: () => streakData.count >= 3 },
    { id: 'streak7',    icon: '⚡', title: 'Недельный воин', desc: '7 дней подряд',            check: () => streakData.count >= 7 },
    { id: 'streak30',   icon: '💎', title: 'Легенда',        desc: '30 дней подряд',           check: () => streakData.count >= 30 },
    { id: 'combo10',    icon: '🎯', title: 'Снайпер',        desc: 'Комбо ×10',                check: () => sessionBestCombo >= 10 },
    { id: 'accuracy100',icon: '✨', title: 'Идеальная',      desc: 'Тренировка без ошибок',    check: () => sessionCorrect >= 5 && sessionWrong === 0 },
    { id: 'lvl5first',  icon: '🏅', title: 'Мастер слова',  desc: 'Первое слово на ур. 5',     check: () => myWords.some(w => w.level >= 5) },
];

let unlockedAchievements = safeParseStorage('achievements', []);

function checkAchievements() {
    ACHIEVEMENTS.forEach(ach => {
        if (!unlockedAchievements.includes(ach.id) && ach.check()) {
            unlockedAchievements.push(ach.id);
            localStorage.setItem('achievements', JSON.stringify(unlockedAchievements));
            showAchievementToast(ach);
        }
    });
}

function showAchievementToast(ach) {
    const toast = document.getElementById('achievement-toast');
    if (!toast) return;
    document.getElementById('ach-icon').textContent = ach.icon;
    document.getElementById('ach-title').textContent = ach.title;
    document.getElementById('ach-desc').textContent = ach.desc;
    toast.style.display = 'block';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.display = 'none'; }, 4000);
}

// ============================================================
// АВТОПЕРЕВОД
// ============================================================
async function autoTranslate(word) {
    if (!word) return '';
    try {
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(word)}&langpair=en|ru`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.responseStatus === 200) {
            return data.responseData.translatedText;
        }
    } catch (e) {}
    return '';
}

document.getElementById('input-en')?.addEventListener('blur', async () => {
    const en = document.getElementById('input-en')?.value.trim();
    const ruField = document.getElementById('input-ru');
    if (!en || !ruField || ruField.value.trim()) return;
    ruField.placeholder = '⏳ Переводим...';
    const translation = await autoTranslate(en);
    ruField.placeholder = 'русский перевод';
    if (translation && !ruField.value) ruField.value = translation;
});


// ============================================================
// ТЕГИ / ГРУППЫ
// ============================================================
let activeTagFilter = null;

function getAllTags() {
    const set = new Set();
    myWords.forEach(w => (w.tags || []).forEach(t => set.add(t)));
    return [...set].sort();
}

function renderTagFilterBar() {
    const bar = document.getElementById('tag-filter-bar');
    const chips = document.getElementById('tag-chips');
    if (!bar || !chips) return;
    const tags = getAllTags();
    if (tags.length === 0) { bar.style.display = 'none'; return; }
    bar.style.display = 'block';
    chips.innerHTML = `
        <button class="tag-chip${!activeTagFilter ? ' active' : ''}" onclick="setTagFilter(null)">Все</button>
        ${tags.map(t => `<button class="tag-chip${activeTagFilter === t ? ' active' : ''}" onclick="setTagFilter('${t}')">${t}</button>`).join('')}
    `;
}

function setTagFilter(tag) {
    activeTagFilter = tag;
    renderTagFilterBar();
    render();
}

function getFilteredWords() {
    if (!activeTagFilter) return myWords;
    return myWords.filter(w => (w.tags || []).includes(activeTagFilter));
}

// ============================================================
// UNDO УДАЛЕНИЯ
// ============================================================
let undoTimer = null;
let undoWord = null;
let undoIndex = -1;

function showUndoToast(word, index) {
    undoWord = word;
    undoIndex = index;
    const toast = document.getElementById('undo-toast');
    const text = document.getElementById('undo-text');
    if (!toast || !text) return;
    text.textContent = `"${word.original}" удалено`;
    toast.style.display = 'flex';
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => {
        toast.style.display = 'none';
        undoWord = null;
    }, 5000);
}

document.getElementById('undo-btn')?.addEventListener('click', async () => {
    if (!undoWord) return;
    clearTimeout(undoTimer);
    myWords.splice(Math.min(undoIndex, myWords.length), 0, undoWord);
    undoWord = null;
    document.getElementById('undo-toast').style.display = 'none';
    await save();
    render();
});

// ============================================================
// РЕЖИМ QUIZ — УГАДАЙ ИЗ 4
// ============================================================
let isQuizMode = false;
let quizQueue = [];
let quizIndex = 0;
let quizWaiting = false;

function normalizeText(value) {
    return String(value || '').trim().toLowerCase();
}

function startQuizMode() {
    const now = Date.now();
    const pool = getFilteredWords().filter(w => !w.nextReview || w.nextReview <= now);
    if (pool.length < 4) {
        showToast('Нужно минимум 4 слова для этого режима!', 'warning');
        return;
    }
    isQuizMode = true;
    quizQueue = [...pool].sort(() => Math.random() - 0.5);
    quizIndex = 0;
    quizWaiting = false;
    sessionCorrect = 0; sessionWrong = 0;
    sessionBestCombo = 0; comboCount = 0;
    sessionStartTodayCount = streakData.todayCount || 0;
    sessionStartStreakCount = streakData.count || 0;
    sessionStartTime = Date.now();
    wordMistakes = {};

    document.getElementById('main-ui').style.display = 'none';
    document.getElementById('training-section').style.display = 'flex';
    const levelStats = document.getElementById('level-stats');
    if (levelStats) levelStats.style.display = 'none';
    if (mainHeader) mainHeader.style.display = 'none';
    if (progressWrapper) progressWrapper.style.display = 'none';
    document.body.classList.add('training-mode');
    window.scrollTo(0, 0);
    const mobileNav = document.getElementById('mobile-nav');
    if (mobileNav) mobileNav.style.display = 'none';

    // FIX: Скрываем кнопку "Назад" в quiz-режиме (она не имеет смысла)
    const btnBack = document.getElementById('btn-back');
    if (btnBack) btnBack.style.display = 'none';

    document.querySelector('.flashcard-container').style.display = 'none';
    document.getElementById('spelling-area').style.display = 'none';
    document.querySelector('.training-buttons').style.display = 'none';
    document.getElementById('toggle-mode-btn').style.display = 'none';
    document.getElementById('quiz-area').style.display = 'block';

    updateSessionCounter();

    // Запускаем таймер (как в обычной тренировке)
    if (timerId) { clearInterval(timerId); timerId = null; }
    timerId = setInterval(async () => {
        if (timeLeft <= 0) {
            clearInterval(timerId); timerId = null;
            await saveTimerToServer();
            finishDay();
            return;
        }
        timeLeft--;
        updateUI();
        if (timeLeft % 10 === 0) saveTimerToServer();
    }, 1000);

    showQuizQuestion();
}

function showQuizQuestion() {
    if (quizIndex >= quizQueue.length) {
        restoreTrainingUI();
        finishTraining();
        return;
    }
    quizWaiting = false;
    const word = quizQueue[quizIndex];
    const wordEl = document.getElementById('quiz-word');
    const optionsEl = document.getElementById('quiz-options');
    const feedbackEl = document.getElementById('quiz-feedback');
    if (!wordEl || !optionsEl) return;

    wordEl.textContent = word.original;
    feedbackEl.textContent = '';
    // Произносим слово если не мут
    if (!isMuted) { window.speechSynthesis.cancel(); setTimeout(() => speak(word.original), 100); }

    const others = myWords.filter(w => w.id !== word.id);
    const wrong3 = others.sort(() => Math.random() - 0.5).slice(0, 3).map(w => w.translate);
    const options = [...wrong3, word.translate].sort(() => Math.random() - 0.5);

    optionsEl.innerHTML = options.map(opt => `
        <button class="quiz-option" onclick="handleQuizAnswer(this, '${word.translate.replace(/'/g, "\\'")}', '${opt.replace(/'/g, "\\'")}')">
            ${opt}
        </button>
    `).join('');

    document.getElementById('total-remaining').textContent = quizQueue.length - quizIndex;
    document.getElementById('current-pool-count').textContent = `${quizIndex + 1}/${quizQueue.length}`;
}

function handleQuizAnswer(btn, correct, chosen) {
    if (quizWaiting) return;
    quizWaiting = true;

    const isCorrect = chosen === correct;
    const feedbackEl = document.getElementById('quiz-feedback');
    const btns = document.querySelectorAll('.quiz-option');

    btns.forEach(b => {
        b.disabled = true;
        const bText = b.textContent.trim();
        if (bText === correct) b.classList.add('correct');
        else if (b === btn && !isCorrect) b.classList.add('wrong');
    });

    const word = quizQueue[quizIndex];
    const mw = myWords.find(w => w.id === word.id);

    if (isCorrect) {
        sessionCorrect++;
        updateCombo(true);
        feedbackEl.textContent = '✓ Верно!';
        feedbackEl.style.color = 'var(--green)';
        if (mw) {
            // Правильный ответ в квизе = quality 2 (Хорошо) в SM-2
            sm2(mw, 2);
            if (!mw.history) mw.history = [];
            mw.history.push({ ts: Date.now(), q: 2, ef: mw.sm2EF });
            if (mw.history.length > 30) mw.history = mw.history.slice(-30);
            streakData.todayCount++;
            recordDailyLearn(1);
            updateStreak();
            if (streakData.todayCount === 10) launchConfetti();
            save();
            addXP(XP_PER_CORRECT);
            checkWeeklyChallenge();
        }
    } else {
        sessionWrong++;
        updateCombo(false);
        wordMistakes[word.id] = (wordMistakes[word.id] || 0) + 1;
        feedbackEl.textContent = `✗ Правильно: ${correct}`;
        feedbackEl.style.color = 'var(--red)';
        if (mw) {
            // Ошибка в квизе = quality 0 (Снова) в SM-2
            sm2(mw, 0);
            if (!mw.history) mw.history = [];
            mw.history.push({ ts: Date.now(), q: 0, ef: mw.sm2EF });
            if (mw.history.length > 30) mw.history = mw.history.slice(-30);
            save();
        }
    }
    updateSessionCounter();
    checkAchievements();

    setTimeout(() => {
        quizIndex++;
        showQuizQuestion();
    }, 900);
}

function restoreTrainingUI() {
    isQuizMode = false;
    const fc = document.querySelector('.flashcard-container');
    const tb = document.querySelector('.training-buttons');
    const tg = document.getElementById('toggle-mode-btn');
    const qa = document.getElementById('quiz-area');
    const btnBack = document.getElementById('btn-back');
    if (fc) fc.style.display = '';
    if (tb) tb.style.display = '';
    if (tg) tg.style.display = '';
    if (qa) qa.style.display = 'none';
    // FIX: Восстанавливаем кнопку "Назад"
    if (btnBack) btnBack.style.display = '';
}


// ============================================================
// БРАУЗЕРНЫЕ УВЕДОМЛЕНИЯ — напоминание о повторении
// ============================================================
async function requestNotificationPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') return;
    if (Notification.permission === 'denied') return;
    // Просим разрешение после первой тренировки — не сразу при входе
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
        scheduleReviewReminder();
        showToast('Уведомления включены — напомним когда придёт время повторять', 'success');
    }
}

function scheduleReviewReminder() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    // Считаем слова к повторению
    const due = myWords.filter(w => (w.nextReview || 0) <= Date.now()).length;
    if (due === 0) return;
    // Показываем уведомление (если вкладка в фоне)
    if (document.hidden) {
        new Notification('Легкий Словарь 📚', {
            body: `${due} ${pluralWords(due)} ждут повторения!`,
            icon: '/icon-192.png',
            badge: '/icon-96.png',
            tag: 'review-reminder',
        });
    }
}

function pluralWords(n) {
    if (n % 100 >= 11 && n % 100 <= 19) return 'слов';
    const r = n % 10;
    if (r === 1) return 'слово';
    if (r >= 2 && r <= 4) return 'слова';
    return 'слов';
}

// Проверяем слова к повторению при возвращении на вкладку
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleReviewReminder();
});

// ── DRAGGABLE TIMER (fixed position)
(function initDraggableTimer() {
    const card = document.getElementById('timer-container');
    if (!card) return;

    let dragging = false, ox, oy, cx, cy;

    function start(px, py) {
        dragging = true;
        const rect = card.getBoundingClientRect();
        ox = px - rect.left;
        oy = py - rect.top;
        card.style.transition = 'none';
        card.style.cursor = 'grabbing';
        // Переключаемся с right/bottom на left/top
        card.style.right = 'auto';
        card.style.bottom = 'auto';
        card.style.left = rect.left + 'px';
        card.style.top  = rect.top  + 'px';
    }

    function move(px, py) {
        if (!dragging) return;
        const maxX = window.innerWidth  - card.offsetWidth  - 4;
        const maxY = window.innerHeight - card.offsetHeight - 4;
        cx = Math.max(4, Math.min(px - ox, maxX));
        cy = Math.max(4, Math.min(py - oy, maxY));
        card.style.left = cx + 'px';
        card.style.top  = cy + 'px';
    }

    function end() {
        if (!dragging) return;
        dragging = false;
        card.style.cursor = 'grab';
        card.style.transition = '';
        try { localStorage.setItem('timerPos', JSON.stringify({ left: cx, top: cy })); } catch(e) {}
    }

    // Restore saved position
    try {
        const saved = JSON.parse(localStorage.getItem('timerPos') || 'null');
        if (saved && saved.left != null) {
            card.style.right = 'auto';
            card.style.bottom = 'auto';
            card.style.left = Math.min(saved.left, window.innerWidth  - 120) + 'px';
            card.style.top  = Math.min(saved.top,  window.innerHeight - 120) + 'px';
        }
    } catch(e) {}

    card.addEventListener('mousedown', e => {
        if (e.target.id === 'add-time-btn') return;
        e.preventDefault();
        start(e.clientX, e.clientY);
    });
    window.addEventListener('mousemove', e => move(e.clientX, e.clientY));
    window.addEventListener('mouseup', end);

    card.addEventListener('touchstart', e => {
        if (e.target.id === 'add-time-btn') return;
        const t = e.touches[0];
        start(t.clientX, t.clientY);
    }, { passive: true });
    window.addEventListener('touchmove', e => {
        if (!dragging) return;
        const t = e.touches[0];
        move(t.clientX, t.clientY);
    }, { passive: true });
    window.addEventListener('touchend', end);

    // Reset on resize
    window.addEventListener('resize', () => {
        card.style.left = '';
        card.style.top = '';
        card.style.right = '24px';
        card.style.bottom = '24px';
        try { localStorage.removeItem('timerPos'); } catch(e) {}
    });
})();

const fileUpload = document.getElementById('file-upload');
if (fileUpload) {
    fileUpload.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const fileNameEl = document.getElementById('file-name');
        if (fileNameEl) fileNameEl.textContent = `📄 ${file.name}`;

        const reader = new FileReader();
        reader.onload = (event) => {
            const text = event.target.result;
            if (importArea) {
                importArea.value = text;
            }
        };
        reader.onerror = () => {
            showToast('Не удалось прочитать файл. Попробуй другой.', 'error');
        };
        reader.readAsText(file, 'UTF-8');
    };
}

(function addFavicon() {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = 'data:,';
    document.head.appendChild(link);
})();

// === 5. ИНИЦИАЛИЗАЦИЯ ===
window.addEventListener('DOMContentLoaded', async () => {
    localStorage.removeItem('isTrainingActive');
    if (timerId) {
        clearInterval(timerId);
        timerId = null;
    }


    await loadWords();
    await dailyReset();
    await loadTimerFromServer();

    // FIX: Устанавливаем обработчик через safeSetClick И через onclick для надёжности
    const startBtnEl = document.getElementById('start-training-btn');
    if (startBtnEl) startBtnEl.onclick = () => startTraining();
    
    safeSetClick('add-time-btn', () => addExtraTime(5));
    safeSetClick('open-import-btn', openImportModal);


    // Восстанавливаем главный экран
    const trainSect = document.getElementById('training-section');
    const mainUI = document.getElementById('main-ui');
    const levelStats = document.getElementById('level-stats');
    const mainHeader = document.querySelector('h1');
    const progressWrapper = document.querySelector('.progress-wrapper');

    if (trainSect) trainSect.style.display = 'none';
    if (mainUI) mainUI.style.display = 'block';
    if (mainHeader) mainHeader.style.display = 'block';
    if (progressWrapper) progressWrapper.style.display = 'block';
    if (levelStats) levelStats.style.display = 'flex';

    const statusEl = document.getElementById('timer-status');
    if (statusEl) statusEl.textContent = "В ожидании";

    updateStreak();
    updateUI();
    
    const savedTheme = localStorage.getItem('selectedTheme');
    if (savedTheme) setTheme(savedTheme);

    console.log("Приложение полностью готово к работе");
    setTheme(currentThemeId);
    renderXPBar();
    renderWeeklyChallenge();
    renderForecast();
    checkWeekReset();
});

// ============================================================
// АУДИО-РЕЖИМ
// Карточки: кнопка-переключатель — при ВКЛ произносит слово
//           автоматически при каждой новой карточке
// Письмо:   блюрит карточку, произносит слово, убирает блюр при флипе
// ============================================================
let isAudioMode = false;

function toggleAudioMode() {
    isAudioMode = !isAudioMode;
    const btn = document.getElementById('btn-audio-mode');
    if (btn) {
        btn.innerHTML = isAudioMode ? '🔊 Авто-озвучка: ВКЛ' : '🔊 Авто-озвучка: ВЫКЛ';
        btn.style.background = isAudioMode ? 'rgba(176,132,247,0.3)' : '';
        btn.style.borderColor = isAudioMode ? '#b084f7' : '';
        btn.style.color = isAudioMode ? '#b084f7' : '';
    }
    // Сразу произнести текущее слово если включили
    if (isAudioMode && !isMuted) {
        const word = activePool[currentWordIndex];
        if (word) { window.speechSynthesis.cancel(); setTimeout(() => speak(word.original), 100); }
    }
}

// Вызывается из nextStep при каждой новой карточке
function onNewCard() {
    const word = activePool[currentWordIndex];
    if (!word) return;

    if (isSpellingMode) {
        // Режим письма: блюрим карточку и произносим
        const cardFront = document.getElementById('card-front');
        if (cardFront) cardFront.style.filter = 'blur(10px)';
        if (!isMuted) { window.speechSynthesis.cancel(); setTimeout(() => speak(word.original), 150); }
    } else if (isAudioMode && !isMuted) {
        // Режим карточек + авто-озвучка включена
        window.speechSynthesis.cancel();
        setTimeout(() => speak(word.original), 150);
    }
}

// Убираем блюр при флипе карточки (для режима письма)
function clearCardBlur() {
    const cardFront = document.getElementById('card-front');
    if (cardFront) cardFront.style.filter = '';
}

// Показать перевод в режиме письма
function revealTranslation() {
    const word = activePool[currentWordIndex];
    if (!word) return;
    clearCardBlur();
    // Переворачиваем карточку чтобы показать перевод
    if (!flashcard.classList.contains('is-flipped')) {
        flashcard.classList.add('is-flipped');
        playSound('flip');
    }
    const exampleBlock = document.getElementById('card-example-block');
    const cardExample = document.getElementById('card-example');
    const cardExRu = document.getElementById('card-example-translate');
    if (exampleBlock && word.example) {
        exampleBlock.style.display = 'block';
        if (cardExample) cardExample.style.visibility = 'visible';
        if (cardExRu) cardExRu.style.visibility = 'visible';
    }
}

// ============================================================
// ГРУППОВОЕ РЕДАКТИРОВАНИЕ СЛОВ
// ============================================================
let selectedWordIds = new Set();
let bulkSelectMode = false;

function toggleBulkSelectMode() {
    bulkSelectMode = !bulkSelectMode;
    selectedWordIds.clear();
    const btn = document.getElementById('bulk-select-btn');
    const panel = document.getElementById('bulk-actions-panel');
    if (btn) {
        btn.innerHTML = bulkSelectMode ? '✕ Отмена' : '☑ Выбрать';
        btn.style.background = bulkSelectMode ? 'rgba(255,77,77,0.2)' : '';
    }
    if (panel) panel.style.display = bulkSelectMode ? 'flex' : 'none';
    render();
}

function toggleWordSelection(id) {
    if (!bulkSelectMode) return;
    if (selectedWordIds.has(id)) selectedWordIds.delete(id);
    else selectedWordIds.add(id);
    updateBulkCount();
    // Обновляем только стиль карточки без полного ре-рендера
    const card = document.querySelector(`[data-word-id="${id}"]`);
    if (card) {
        card.classList.toggle('bulk-selected', selectedWordIds.has(id));
    }
}

function selectAllWords() {
    getFilteredWords().forEach(w => selectedWordIds.add(w.id));
    updateBulkCount();
    document.querySelectorAll('[data-word-id]').forEach(el => el.classList.add('bulk-selected'));
}

function deselectAllWords() {
    selectedWordIds.clear();
    updateBulkCount();
    document.querySelectorAll('[data-word-id]').forEach(el => el.classList.remove('bulk-selected'));
}

function updateBulkCount() {
    const cnt = document.getElementById('bulk-count');
    if (cnt) cnt.textContent = selectedWordIds.size > 0 ? `${selectedWordIds.size} выбрано` : 'Выбери слова';
}

async function bulkDelete() {
    if (selectedWordIds.size === 0) return;
    if (!await showConfirm(`Удалить ${selectedWordIds.size} слов?`, 'Удалить', 'Отмена')) return;
    myWords = myWords.filter(w => !selectedWordIds.has(w.id));
    selectedWordIds.clear();
    await save();
    toggleBulkSelectMode();
    render();
    showToast(`Удалено`, 'success');
}

async function bulkResetLevel() {
    if (selectedWordIds.size === 0) return;
    myWords.forEach(w => {
        if (selectedWordIds.has(w.id)) {
            w.level = 0;
            w.nextReview = Date.now();
            w.forgetStep = 0;
            w.sm2Reps = 0;
            w.sm2Interval = 1;
            w.sm2EF = 2.5;
        }
    });
    await save();
    showToast(`Уровень сброшен у ${selectedWordIds.size} слов`, 'info');
    selectedWordIds.clear();
    toggleBulkSelectMode();
    render();
}

function showBulkTagModal() {
    if (selectedWordIds.size === 0) return;
    const modal = document.getElementById('bulk-tag-modal');
    if (modal) modal.style.display = 'flex';
    const inp = document.getElementById('bulk-tag-input');
    if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 100); }
}

async function applyBulkTag() {
    const inp = document.getElementById('bulk-tag-input');
    const tag = inp?.value.trim();
    if (!tag) return;
    myWords.forEach(w => {
        if (selectedWordIds.has(w.id)) {
            w.tags = sanitizeTags([...(w.tags || []), tag]);
        }
    });
    await save();
    document.getElementById('bulk-tag-modal').style.display = 'none';
    showToast(`Тег «${tag}» добавлен к ${selectedWordIds.size} словам`, 'success');
    selectedWordIds.clear();
    toggleBulkSelectMode();
    render();
}

// ============================================================
// ЭКСПОРТ CSV / ANKI
// ============================================================
function exportCSV() {
    const header = 'Слово,Перевод,Пример,Перевод примера,Теги,Уровень,Следующее повторение';
    const rows = myWords.map(w => {
        const esc = s => `"${(s||'').replace(/"/g,'""')}"`;
        const nextRev = w.nextReview ? new Date(w.nextReview).toLocaleDateString('ru-RU') : '';
        return [esc(w.original), esc(w.translate), esc(w.example), esc(w.exampleTranslate), esc((w.tags||[]).join(';')), w.level||0, nextRev].join(',');
    });
    const csv = [header, ...rows].join("\n");
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `словарь_${new Date().toLocaleDateString('ru-RU').replace(/\./g,'-')}.csv`;
    link.click();
    showToast('CSV экспортирован', 'success');
}

function exportAnki() {
    // Anki import format: front TAB back [TAB tags]
    const rows = myWords.map(w => {
        const front = w.example
            ? `${w.original}<br><small style='color:#aaa'>${w.example}</small>`
            : w.original;
        const back = w.exampleTranslate
            ? `${w.translate}<br><small style='color:#aaa'>${w.exampleTranslate}</small>`
            : w.translate;
        const tags = (w.tags||[]).join(' ');
        return `${front}	${back}${tags ? '	' + tags : ''}`;
    });
    const text = rows.join("\n");
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `anki_import_${new Date().toLocaleDateString('ru-RU').replace(/\./g,'-')}.txt`;
    link.click();
    showToast('Anki файл готов! Импортируй через File → Import в Anki', 'success', 5000);
}

function showExportModal() {
    const modal = document.getElementById('export-modal');
    if (modal) modal.style.display = 'flex';
}
function closeExportModal() {
    const modal = document.getElementById('export-modal');
    if (modal) modal.style.display = 'none';
}

// ============================================================
// TATOEBA — примеры предложений
// ============================================================
async function fetchTatoebaExamples(word) {
    const container = document.getElementById('tatoeba-results');
    if (!container) return;
    container.innerHTML = '<div style="color:#555;font-size:13px;text-align:center;padding:16px;">🔍 Ищем примеры...</div>';

    try {
        const url = `/api/tatoeba?word=${encodeURIComponent(word)}`;
        const res = await fetch(url);
        const data = await res.json();
        const results = data.results || [];

        if (results.length === 0) {
            container.innerHTML = '<div style="color:#555;font-size:13px;text-align:center;padding:16px;">Примеры не найдены</div>';
            return;
        }

        container.innerHTML = results.map((r, i) => {
            const trans = r.translations?.[0]?.[0];
            const ruText = trans?.text || '';
            const enText = r.text || '';
            return `<div class="tatoeba-item" onclick="useTatoebaExample('${enText.replace(/'/g,"\'")}', '${ruText.replace(/'/g,"\'")}')">
                <div class="tatoeba-en">${enText}</div>
                ${ruText ? `<div class="tatoeba-ru">${ruText}</div>` : ''}
                <div class="tatoeba-use">Использовать →</div>
            </div>`;
        }).join('');
    } catch (e) {
        container.innerHTML = '<div style="color:#555;font-size:13px;text-align:center;padding:16px;">Ошибка загрузки примеров</div>';
    }
}

function openTatoebaModal(word) {
    const modal = document.getElementById('tatoeba-modal');
    if (!modal) return;
    const titleEl = document.getElementById('tatoeba-word-title');
    if (titleEl) titleEl.textContent = word || '';
    modal.setAttribute('data-word', word || '');
    modal.style.display = 'flex';
    fetchTatoebaExamples(word);
}

function closeTatoebaModal() {
    const modal = document.getElementById('tatoeba-modal');
    if (modal) modal.style.display = 'none';
}

function useTatoebaExample(en, ru) {
    const exInput = document.getElementById('input-example');
    const exRuInput = document.getElementById('input-ex-ru');
    if (exInput) exInput.value = en;
    if (exRuInput) exRuInput.value = ru;
    closeTatoebaModal();
    showToast('Пример добавлен в форму', 'success');
}

// Кнопка "Найти примеры" в форме добавления слов
document.getElementById('input-en')?.addEventListener('blur', () => {
    const word = document.getElementById('input-en')?.value.trim();
    const btn = document.getElementById('tatoeba-fetch-btn');
    if (btn) btn.style.display = word ? 'inline-flex' : 'none';
});


// ============================================================
// XP И УРОВНИ ПОЛЬЗОВАТЕЛЯ
// ============================================================
const XP_PER_CORRECT   = 10;
const XP_PER_EASY      = 15;
const XP_PER_HARD      = 5;
const XP_PER_ADD_WORD  = 3;

const USER_LEVELS = [
    { level: 1,  title: 'Новичок',        xp: 0,     icon: '🌱' },
    { level: 2,  title: 'Ученик',         xp: 200,   icon: '📖' },
    { level: 3,  title: 'Студент',        xp: 500,   icon: '✏️' },
    { level: 4,  title: 'Знаток',         xp: 1000,  icon: '🎓' },
    { level: 5,  title: 'Грамотей',       xp: 2000,  icon: '📚' },
    { level: 6,  title: 'Эрудит',         xp: 4000,  icon: '🧠' },
    { level: 7,  title: 'Полиглот',       xp: 7000,  icon: '🌍' },
    { level: 8,  title: 'Лингвист',       xp: 11000, icon: '⚡' },
    { level: 9,  title: 'Мастер слов',    xp: 16000, icon: '🏆' },
    { level: 10, title: 'Легенда',        xp: 25000, icon: '💎' },
];

let userXP = safeParseStorage('userXP', 0);

function getUserLevel() {
    let cur = USER_LEVELS[0];
    for (const l of USER_LEVELS) {
        if (userXP >= l.xp) cur = l;
    }
    return cur;
}

function getNextLevel() {
    const cur = getUserLevel();
    return USER_LEVELS.find(l => l.level === cur.level + 1) || null;
}

function updateXP(amount = 0) {
    if (amount > 0) {
        const prevLevel = getUserLevel();
        userXP += amount;
        localStorage.setItem('userXP', JSON.stringify(userXP));
        const newLevel = getUserLevel();
        if (newLevel.level > prevLevel.level) {
            showLevelUpToast(newLevel);
        }
    }
    renderXPBar();
}

function addXP(amount) { updateXP(amount); }

function renderXPBar() {
    const bar = document.getElementById('xp-bar-fill');
    const label = document.getElementById('xp-label');
    const levelIcon = document.getElementById('xp-level-icon');
    if (!bar) return;
    const cur = getUserLevel();
    const next = getNextLevel();
    const xpInLevel = userXP - cur.xp;
    const xpNeeded = next ? next.xp - cur.xp : 1;
    const pct = next ? Math.min(100, Math.round(xpInLevel / xpNeeded * 100)) : 100;
    bar.style.width = pct + '%';
    if (label) label.textContent = next
        ? `${cur.title} · ${xpInLevel}/${xpNeeded} XP`
        : `${cur.title} · Макс. уровень!`;
    if (levelIcon) levelIcon.textContent = cur.icon + ' ' + cur.level;
}

function showLevelUpToast(level) {
    showToast(`${level.icon} Новый уровень: ${level.title}!`, 'success', 5000);
    launchConfetti();
}

// ============================================================
// РЕЖИМ МАРАФОН (без таймера, до конца всех слов)
// ============================================================
let isMarathonMode = false;

async function startMarathon() {
    isMarathonMode = true;
    const now = Date.now();
    const words = getFilteredWords().filter(w => !w.nextReview || w.nextReview <= now);
    if (words.length === 0) {
        showToast('Нет слов для повторения!', 'info');
        isMarathonMode = false;
        return;
    }

    // Останавливаем таймер — в марафоне он не нужен
    if (timerId) { clearInterval(timerId); timerId = null; }

    // Прячем таймер
    const timerContainer = document.getElementById('timer-container');
    if (timerContainer) timerContainer.style.display = 'none';

    mainQueue = [...words].sort(() => Math.random() - 0.5);
    activePool = [];
    currentWordIndex = 0;
    sessionCorrect = 0; sessionWrong = 0;
    comboCount = 0; sessionBestCombo = 0;
    sessionStartTodayCount = streakData.todayCount || 0;
    sessionStartStreakCount = streakData.count || 0;
    sessionStartTime = Date.now();
    wordMistakes = {};
    fillPool();

    document.getElementById('main-ui').style.display = 'none';
    document.getElementById('training-section').style.display = 'flex';
    const levelStats = document.getElementById('level-stats');
    if (levelStats) levelStats.style.display = 'none';
    if (mainHeader) mainHeader.style.display = 'none';
    if (progressWrapper) progressWrapper.style.display = 'none';
    document.body.classList.add('training-mode');
    window.scrollTo(0, 0);
    const mobileNav = document.getElementById('mobile-nav');
    if (mobileNav) mobileNav.style.display = 'none';

    const fc = document.querySelector('.flashcard-container');
    const tb = document.querySelector('.training-buttons');
    const tg = document.getElementById('toggle-mode-btn');
    const qa = document.getElementById('quiz-area');
    if (fc) fc.style.display = '';
    if (tb) tb.style.display = '';
    if (tg) tg.style.display = '';
    if (qa) qa.style.display = 'none';
    isQuizMode = false;

    const btnKnow = document.getElementById('btn-know');
    const btnDontKnow = document.getElementById('btn-dont-know');
    const btnNext = document.getElementById('btn-next');
    const btnBack = document.getElementById('btn-back');
    const btnHard = document.getElementById('btn-hard');
    const btnEasy = document.getElementById('btn-easy');
    if (btnKnow) btnKnow.style.display = 'block';
    if (btnDontKnow) btnDontKnow.style.display = 'block';
    if (btnHard) btnHard.style.display = 'block';
    if (btnEasy) btnEasy.style.display = 'block';
    if (btnNext) btnNext.style.display = 'none';
    if (btnBack) btnBack.classList.remove('full-width-btn');
    if (tg) tg.innerHTML = '<span>🎴</span> Режим: Карточки';
    isSpellingMode = false;
    if (spellingArea) spellingArea.style.display = 'none';

    const spellingExtraBtns = document.getElementById('spelling-extra-btns');
    const audioRow = document.getElementById('audio-mode-row');
    if (spellingExtraBtns) spellingExtraBtns.style.display = 'none';
    if (audioRow) audioRow.style.display = 'flex';

    // Показываем марафон-бейдж
    const badge = document.getElementById('marathon-badge');
    if (badge) { badge.style.display = 'inline-flex'; badge.textContent = `🏃 Марафон · ${words.length} слов`; }

    updateFlashcard();
}

function stopMarathon() {
    isMarathonMode = false;
    const timerContainer = document.getElementById('timer-container');
    if (timerContainer) timerContainer.style.display = '';
    const badge = document.getElementById('marathon-badge');
    if (badge) badge.style.display = 'none';
}

// ============================================================
// ПРОГНОЗ НАГРУЗКИ НА НЕДЕЛЮ
// ============================================================
function getForecast() {
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const days = [];
    for (let i = 0; i < 7; i++) {
        const dayStart = now + i * DAY;
        const dayEnd = dayStart + DAY;
        const count = myWords.filter(w => {
            const r = w.nextReview || 0;
            return r >= dayStart && r < dayEnd;
        }).length;
        // День 0 — сегодня, включаем уже просроченные
        const overdue = i === 0 ? myWords.filter(w => (w.nextReview || 0) < now).length : 0;
        days.push({ count: count + overdue, label: i === 0 ? 'Сег' : i === 1 ? 'Завт' : getDayName(i) });
    }
    return days;
}

function getDayName(offset) {
    const d = new Date(Date.now() + offset * 24 * 60 * 60 * 1000);
    return ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'][d.getDay()];
}

function renderForecast() {
    const container = document.getElementById('forecast-chart');
    if (!container) return;
    const days = getForecast();
    const max = Math.max(...days.map(d => d.count), 1);
    container.innerHTML = days.map((d, i) => {
        const pct = Math.round(d.count / max * 100);
        const color = i === 0 ? '#ff4d4d' : i === 1 ? '#f39c12' : '#b084f7';
        return `<div class="forecast-col">
            <div class="forecast-val">${d.count}</div>
            <div class="forecast-bar-wrap">
                <div class="forecast-bar-fill" style="height:${pct}%;background:${color};"></div>
            </div>
            <div class="forecast-label">${d.label}</div>
        </div>`;
    }).join('');
}

// ============================================================
// ИСТОРИЯ ПРОГРЕССА ПО СЛОВУ
// ============================================================
function showWordHistory(wordId) {
    const word = myWords.find(w => w.id === wordId);
    if (!word) return;
    const modal = document.getElementById('word-history-modal');
    if (!modal) return;

    const history = word.history || [];
    const ef = (word.sm2EF || 2.5).toFixed(2);
    const interval = word.sm2Interval || 1;
    const nextRev = word.nextReview ? new Date(word.nextReview).toLocaleDateString('ru-RU') : '—';
    const addedAt = word.addedAt ? new Date(word.addedAt).toLocaleDateString('ru-RU') : '—';
    const totalAnswers = history.length;
    const goodAnswers = history.filter(h => h.q >= 2).length;
    const accuracy = totalAnswers ? Math.round(goodAnswers / totalAnswers * 100) : 0;

    const qLabel = { 0: '🔄 Снова', 1: '😅 Сложно', 2: '👍 Хорошо', 3: '⚡ Легко' };
    const qColor = { 0: '#ff4d4d', 1: '#f39c12', 2: '#28a745', 3: '#2980b9' };

    document.getElementById('wh-title').textContent = word.original;
    document.getElementById('wh-translate').textContent = word.translate;

    document.getElementById('wh-content').innerHTML = `
        <div class="fst-grid" style="grid-template-columns:repeat(3,1fr)">
            <div class="fst-card"><div class="fst-val">${word.level || 0}/5</div><div class="fst-label">Уровень</div></div>
            <div class="fst-card"><div class="fst-val">${accuracy}%</div><div class="fst-label">Точность</div></div>
            <div class="fst-card"><div class="fst-val">${interval}д</div><div class="fst-label">Интервал</div></div>
        </div>
        <div class="fst-grid" style="grid-template-columns:repeat(2,1fr);margin-top:0">
            <div class="fst-card"><div class="fst-val" style="font-size:18px">${ef}</div><div class="fst-label">EF (≥2.5 хорошо)</div></div>
            <div class="fst-card"><div class="fst-val" style="font-size:18px">${nextRev}</div><div class="fst-label">След. повторение</div></div>
        </div>
        <div class="fst-section-title">Добавлено: ${addedAt} · Ответов: ${totalAnswers}</div>
        ${history.length > 0 ? `
        <div class="wh-timeline">
            ${[...history].reverse().slice(0, 15).map(h => `
                <div class="wh-item">
                    <span style="color:${qColor[h.q]};font-size:13px;font-weight:600;">${qLabel[h.q]}</span>
                    <span style="color:#555;font-size:11px;">${new Date(h.ts).toLocaleDateString('ru-RU')} · EF ${(h.ef||2.5).toFixed(1)}</span>
                </div>
            `).join('')}
        </div>` : '<div style="color:#555;text-align:center;padding:16px;">Ещё нет истории ответов</div>'}
    `;
    modal.style.display = 'flex';
}

function closeWordHistory() {
    const modal = document.getElementById('word-history-modal');
    if (modal) modal.style.display = 'none';
}

// ============================================================

// ============================================================
// КАРТИНКИ К СЛОВАМ (Unsplash)
// ============================================================
const UNSPLASH_ACCESS_KEY = 'SB_demo'; // демо-режим через прокси на сервере

async function fetchWordImage(word) {
    try {
        const res = await fetch(`/api/word-image?word=${encodeURIComponent(word)}`);
        const data = await res.json();
        return data.url || null;
    } catch { return null; }
}

async function loadCardImage(word) {
    const el = document.getElementById('card-image');
    if (!el) return;
    if (!word || !word.original) { el.style.display = 'none'; return; }
    // Только для слов без примера, чтобы не перегружать карточку
    const img = await fetchWordImage(word.original);
    if (img) {
        el.src = img;
        el.style.display = 'block';
        el.onerror = () => { el.style.display = 'none'; };
    } else {
        el.style.display = 'none';
    }
}

// ============================================================
// НЕДЕЛЬНЫЙ ЧЕЛЛЕНДЖ
// ============================================================
let weeklyChallenge = safeParseStorage('weeklyChallenge', {
    goal: 50,
    progress: 0,
    weekStart: getWeekStart(),
    completed: false
});

function getWeekStart() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay() + 1); // Пн
    return d.getTime();
}

function checkWeekReset() {
    const ws = getWeekStart();
    if (weeklyChallenge.weekStart !== ws) {
        // Новая неделя
        weeklyChallenge = { goal: weeklyChallenge.goal, progress: 0, weekStart: ws, completed: false };
        localStorage.setItem('weeklyChallenge', JSON.stringify(weeklyChallenge));
    }
}

function checkWeeklyChallenge() {
    checkWeekReset();
    weeklyChallenge.progress++;
    localStorage.setItem('weeklyChallenge', JSON.stringify(weeklyChallenge));
    if (!weeklyChallenge.completed && weeklyChallenge.progress >= weeklyChallenge.goal) {
        weeklyChallenge.completed = true;
        localStorage.setItem('weeklyChallenge', JSON.stringify(weeklyChallenge));
        showToast(`🏆 Недельный челлендж выполнен! ${weeklyChallenge.goal} повторений за неделю!`, 'success', 6000);
        launchConfetti();
    }
    renderWeeklyChallenge();
}

function renderWeeklyChallenge() {
    checkWeekReset();
    const bar = document.getElementById('weekly-challenge-bar');
    const label = document.getElementById('weekly-challenge-label');
    const pct = Math.min(100, Math.round(weeklyChallenge.progress / weeklyChallenge.goal * 100));
    if (bar) bar.style.width = pct + '%';
    if (label) label.textContent = `${weeklyChallenge.progress} / ${weeklyChallenge.goal} повторений`;
}

function setWeeklyGoal(val) {
    const n = parseInt(val);
    if (!n || n < 1) return;
    weeklyChallenge.goal = n;
    localStorage.setItem('weeklyChallenge', JSON.stringify(weeklyChallenge));
    renderWeeklyChallenge();
    showToast(`Цель на неделю: ${n} повторений`, 'info');
}

// ============================================================
// YOUGLISH — открываем слово в popup-окне браузера
// ============================================================

let youglishWindow = null;

function openYouglish() {
    // Если идёт тренировка — берём текущее слово и сразу открываем
    const trainSect = document.getElementById('training-section');
    const isTraining = trainSect && trainSect.style.display !== 'none';

    if (isTraining && activePool && activePool[currentWordIndex]) {
        const word = activePool[currentWordIndex].original || '';
        if (word) {
            launchYouglish(word);
            return;
        }
    }

    // Иначе показываем пикер слова
    showYouglishPicker();
}

function launchYouglish(word) {
    if (!word || !word.trim()) return;
    const url = `https://youglish.com/pronounce/${encodeURIComponent(word.trim())}/english`;

    // Открываем popup — выглядит как отдельное окно, не новая вкладка
    const w = Math.min(1100, window.screen.availWidth - 40);
    const h = Math.min(800, window.screen.availHeight - 60);
    const left = Math.round((window.screen.availWidth - w) / 2);
    const top = Math.round((window.screen.availHeight - h) / 2);

    if (youglishWindow && !youglishWindow.closed) {
        youglishWindow.location.href = url;
        youglishWindow.focus();
    } else {
        youglishWindow = window.open(
            url,
            'YouGlish',
            `width=${w},height=${h},left=${left},top=${top},toolbar=0,menubar=0,location=1,status=0,scrollbars=1,resizable=1`
        );
    }

    // Обновляем badge в пикере если он открыт
    const badge = document.getElementById('youglish-word-badge');
    if (badge) badge.textContent = word.trim();
}

function showYouglishPicker() {
    const modal = document.getElementById('youglish-modal');
    if (!modal) return;
    renderYouglishWordPills();
    modal.style.display = 'flex';
    const input = document.getElementById('youglish-search-input');
    if (input) { input.value = ''; setTimeout(() => input.focus(), 100); }
}

function closeYouglish() {
    const modal = document.getElementById('youglish-modal');
    if (modal) modal.style.display = 'none';
}

function youglishSearch() {
    const input = document.getElementById('youglish-search-input');
    if (!input || !input.value.trim()) return;
    launchYouglish(input.value.trim());
}

function youglishSearchEnter(e) {
    if (e.key === 'Enter') youglishSearch();
}

function renderYouglishWordPills(filter = '') {
    const container = document.getElementById('youglish-word-pills');
    if (!container) return;
    const words = [...myWords]
        .sort((a, b) => (a.level || 0) - (b.level || 0))
        .filter(w => !filter || w.original.toLowerCase().includes(filter.toLowerCase()) || (w.translate||'').toLowerCase().includes(filter.toLowerCase()));
    container.innerHTML = words.map(w => {
        const safe = w.original.replace(/'/g, "\'").replace(/"/g, '&quot;');
        const lvlColor = w.level >= 4 ? '#28a745' : w.level >= 2 ? '#f39c12' : '#b084f7';
        return `<button class="yg-pill" style="border-color:${lvlColor}33;color:${lvlColor};" onclick="launchYouglish('${safe}'); document.getElementById('youglish-search-input').value='${safe}'; document.getElementById('youglish-word-badge').textContent='${safe}';">${w.original}</button>`;
    }).join('');
}


// ===== PWA: Service Worker =====
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
}