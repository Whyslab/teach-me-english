// === 1. ИНИЦИАЛИЗАЦИЯ И ПОИСК ЭЛЕМЕНТОВ ===
let timeLeft = 0; 
let timerId = null;
let myWords = [];
const inputRu = document.getElementById('input-ru');
const inputEn = document.getElementById('input-en');
const inputEx = document.getElementById('input-example');
const inputExRu = document.getElementById('input-ex-ru');
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

// Состояние
let mainQueue = [];      
let trainingHistory = []; 
let activePool = [];     
let currentWordIndex = 0;
let cardClickStage = 0;
let isMuted = localStorage.getItem('isMuted') === 'true'; 
let isLoaded = false; 
const POOL_LIMIT = 50;   

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

const TRAINING_TIME = 60 * 60;
const API_BASE = window.location.origin;

function apiUrl(path) {
    return `${API_BASE}${path}`;
}

// === 2. ОСНОВНЫЕ ФУНКЦИИ ===

async function loadWords() {
    try {
        const response = await fetch(apiUrl('/api/words'));
        if (!response.ok) throw new Error('Ошибка сети');
        const data = await response.json();
        
        myWords = (Array.isArray(data) ? data : []).map(word => ({
            ...word,
            example: word.example || "",
            exampleTranslate: word.exampleTranslate || "",
            forgetStep: Number(word.forgetStep) || 0
        }));

        isLoaded = true; 
        render();
    } catch (e) {
        console.error("Ошибка загрузки сервера!", e);
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

function render() {
    if (!element) return;
    
    const now = Date.now();

    const cardsHTML = myWords.map(word => { 
        const level = word.level || 0;
        const isMaxLevel = level === 5;
        
        const isReady = !word.nextReview || word.nextReview <= now;
        const reviewClass = (isReady && !isMaxLevel) ? 'needs-review' : '';
        
        const learnedStyle = isMaxLevel ? 'style="opacity: 0.5; background: rgba(40, 167, 69, 0.05);"' : '';
        const badge = `<span class="level-indicator" style="font-size: 10px; color: #00d2ff; background: rgba(0, 210, 255, 0.1); padding: 2px 6px; border-radius: 4px; margin-right: 8px;">Ур. ${level}</span>`;

        return `
        <div class="card ${reviewClass}" data-id="${word.id}" ${learnedStyle}>
            <div class="card-content">
                ${badge}
                <span class="original editable-text" contenteditable="true">${word.original}</span>
                <span class="arrow" style="color: #999"> —> </span>
                <span class="translation hidden editable-text" contenteditable="true">${word.translate}</span>
            </div>
            <div class="actions">
                <button class="speak-btn" title="Прослушать">🔊</button>
                <button class="delete-btn" title="Удалить">&times;</button>
            </div>
        </div>`;
    }).join('');

    element.innerHTML = cardsHTML;
    updateOverallProgress();
    updateLevelStats();
    updateVisualProgress();
}

async function save() {
    if (!isLoaded) return;
    try {
        await fetch(apiUrl('/api/sync'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(myWords)
        });
    } catch (e) {
        console.error("Ошибка сохранения", e);
    }
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

async function startTraining() {
    // 1. Ежедневный сброс таймера если нужно
    await dailyReset();

    // 2. Подгружаем актуальное время с сервера
    try {
        await loadTimerFromServer();
    } catch (e) {
        console.error("Не удалось подтянуть время, работаем на локальном");
    }

    // ✅ ИСПРАВЛЕНО: если timeLeft = 0, даём время автоматически вместо блокировки
    if (timeLeft <= 0) {
        timeLeft = TRAINING_TIME;
        await saveTimerToServer();
    }

    const now = Date.now();

    // ✅ ИСПРАВЛЕНО: фильтруем слова один раз и проверяем корректно
    const wordsToReview = myWords.filter(w => !w.nextReview || w.nextReview <= now);
    
    if (wordsToReview.length === 0) {
        alert("Все слова уже повторены! Добавь новые или подожди следующего повторения.");
        return;
    }

    // Переносим слова в очередь
    mainQueue = [...wordsToReview].sort(() => Math.random() - 0.5);
    activePool = [];
    currentWordIndex = 0;
    fillPool();

    // Запускаем таймер если он ещё не идёт
    if (!timerId) {
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
    }

    // Визуальное переключение
    document.getElementById('main-ui').style.display = 'none';
    document.getElementById('training-section').style.display = 'flex';

    const levelStats = document.getElementById('level-stats');
    if (levelStats) levelStats.style.display = 'none';
    if (mainHeader) mainHeader.style.display = 'none';
    if (progressWrapper) progressWrapper.style.display = 'none';

    updateFlashcard();
}

async function loadTimerFromServer() {
    try {
        const response = await fetch(apiUrl('/api/timer'));
        if (!response.ok) throw new Error('Timer API unavailable');
        const data = await response.json();
        // ✅ ИСПРАВЛЕНО: не перезаписываем timeLeft нулём с сервера
        if (data.timeLeft > 0) {
            timeLeft = data.timeLeft;
        }
        updateUI();
    } catch (e) {
        console.warn("Ошибка загрузки таймера с сервера, используем локальное значение");
    }
}

async function saveTimerToServer() {
    try {
        await fetch(apiUrl('/api/timer'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ timeLeft: timeLeft })
        });
    } catch (e) {
        console.warn("Не удалось синхронизировать время с сервером");
    }
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

    const isEnToRu = Math.random() > 0.5;
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
    
    const statusEl = document.getElementById('timer-status');
    if (statusEl) statusEl.textContent = "На паузе";
}

function finishDay() {
    clearInterval(timerId);
    timerId = null;

    finishTraining(); 

    alert("Время тренировки вышло! На сегодня достаточно. Но ты можешь продолжить работу со словарем в обычном режиме.");
    
    const statusEl = document.getElementById('timer-status');
    if (statusEl) {
        statusEl.textContent = "Лимит исчерпан";
        statusEl.style.color = "#ff4444";
    }
}

function finishTraining() {
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

    render(); 
}

function nextStep() {
    flashcard.classList.remove('is-flipped');
    setTimeout(updateFlashcard, 300);
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

document.getElementById('btn-know').onclick = async () => {
    const word = activePool[currentWordIndex];
    if (!word) return;
    saveToHistory(true); 
    const mainWord = myWords.find(w => w.id === word.id);
    if (mainWord) {
        mainWord.level = Math.min((mainWord.level || 0) + 1, 5);
        mainWord.nextReview = Date.now() + INTERVALS[mainWord.level];
        mainWord.forgetStep = 0;
        streakData.todayCount++;
        recordDailyLearn(1);
        updateStreak();
        await save();
    }
    activePool.splice(currentWordIndex, 1);
    fillPool();
    if (currentWordIndex >= activePool.length) currentWordIndex = 0;
    nextStep();
};

document.getElementById('btn-dont-know').onclick = () => {
    saveToHistory(false); 
    const word = activePool[currentWordIndex];
    const mainWord = myWords.find(w => w.id === word.id);
    if (mainWord) {
        applyForgetSchedule(mainWord);
        save();
    }
    currentWordIndex++;
    if (currentWordIndex >= activePool.length) currentWordIndex = 0;
    nextStep();
};

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
        if (confirm("Вы уверены? Это обнулит уровни слов, стрик и счетчик за сегодня!")) {
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
            
            alert("Весь прогресс, включая дневной счетчик, сброшен!");
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
    if (confirm("Удалить все слова?")) {
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

    if (isSpellingMode) {
        toggleModeBtn.innerHTML = "<span>📝</span> Режим: Письмо";
        spellingArea.style.display = 'block';
        btnKnow.style.display = 'none';
        btnDontKnow.style.display = 'none';
        btnNext.style.display = 'block';
        btnBack.classList.add('full-width-btn');
        spellingInput.focus();
    } else {
        toggleModeBtn.innerHTML = "<span>🎴</span> Режим: Карточки";
        spellingArea.style.display = 'none';
        btnKnow.style.display = 'block';
        btnDontKnow.style.display = 'block';
        btnNext.style.display = 'none';
        btnBack.classList.remove('full-width-btn');
    }
};

// ✅ ИСПРАВЛЕНО: убран дублирующий обработчик Enter, логика объединена корректно
spellingInput.onkeydown = (e) => {
    if (e.key !== 'Enter') return;

    // Если карточка уже перевёрнута — второй Enter переходит к следующему слову
    if (flashcard.classList.contains('is-flipped')) {
        document.getElementById('btn-know').click();
        return;
    }

    // Проверяем введённый ответ
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
        const bg = count === 0 ? 'rgba(255,255,255,0.08)' : `rgba(0, 210, 255, ${Math.max(0.2, alpha)})`;
        const title = `${date.toLocaleDateString()}: ${count} слов`;
        return `<div class="heat-cell" title="${title}" style="background:${bg}"></div>`;
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
    const now = new Date();
    const today = now.toDateString();
    
    if (streakData.lastDate !== today) {
        streakData.todayCount = 0;
        streakData.lastDate = today;
    }

    const streakCountEl = document.getElementById('streak-count');
    const dailyCountEl = document.getElementById('daily-count');

    if (streakCountEl) streakCountEl.innerText = streakData.count;
    if (dailyCountEl) dailyCountEl.innerText = streakData.todayCount;
    
    localStorage.setItem('streakData', JSON.stringify(streakData));
}

addBtn.onclick = async () => {
    const en = inputEn.value.trim();
    const ru = inputRu.value.trim();
    if (en && ru) {
        myWords.push({
            id: Date.now(),
            original: en, translate: ru,
            example: inputEx.value.trim(),
            exampleTranslate: inputExRu.value.trim(),
            level: 0, nextReview: Date.now(), forgetStep: 0
        });
        await save();
        render();
        inputEn.value = ''; inputRu.value = ''; inputEx.value = ''; inputExRu.value = '';
        inputEn.focus();
    }
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
        myWords = myWords.filter(w => w.id !== id);
        save(); render();
        return;
    }
    const trans = card.querySelector('.translation');
    if (trans) trans.classList.toggle('hidden');
};

if (stopBtn) stopBtn.onclick = finishTraining;

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
                myWords.push({
                    id: Date.now() + Math.random(),
                    original: originalText,
                    translate: translateText,
                    example: parts[2] || "",
                    exampleTranslate: parts[3] || "",
                    level: 0,
                    nextReview: Date.now(),
                    forgetStep: 0
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
        const duplicatePreview = duplicatesList.join(', ');
        const duplicateTail = duplicateCount > duplicatesList.length ? ', ...' : '';
        alert(`Импорт завершен!\n✅ Добавлено новых слов: ${importedCount}\n⚠️ Пропущено дубликатов: ${duplicateCount}\n(Первые дубликаты: ${duplicatePreview}${duplicateTail})`);
    } else if (importedCount > 0) {
        alert(`Успешно добавлено ${importedCount} слов!`);
    } else {
        alert("Новых слов для добавления не найдено.");
    }

    modal.style.display = 'none';
    importArea.value = '';
};

if (exportBtn) exportBtn.onclick = () => {
    const textToSave = myWords.map(w => `${w.original}|${w.translate}|${w.example}|${w.exampleTranslate}`).join('\n');
    const blob = new Blob([textToSave], { type: 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `vocab_backup.txt`;
    link.click();
};

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

function setTheme(color) {
    document.documentElement.style.setProperty('--accent-color', color);
    const glowColor = color + '4D';
    document.documentElement.style.setProperty('--accent-glow', glowColor);
    localStorage.setItem('selectedTheme', color);
    updateLevelStats();
}

function openImportModal() {
    if (!modal) return;
    modal.style.display = 'flex';
    if (importArea) {
        setTimeout(() => importArea.focus(), 100);
    }
}

// ✅ ИСПРАВЛЕНО: favicon 404 — добавляем программно чтобы не было ошибки
(function addFavicon() {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = 'data:,'; // пустая иконка, убирает 404
    document.head.appendChild(link);
})();

// === 5. ИНИЦИАЛИЗАЦИЯ ===
window.addEventListener('DOMContentLoaded', async () => {
    // Сбрасываем состояние тренировки при загрузке
    localStorage.removeItem('isTrainingActive');
    if (timerId) {
        clearInterval(timerId);
        timerId = null;
    }

    // Загружаем данные
    await loadWords();
    
    // Сначала делаем дневной сброс, потом подгружаем время
    await dailyReset();
    await loadTimerFromServer();

    // ✅ ИСПРАВЛЕНО: единственное место назначения обработчиков кнопок
    safeSetClick('start-training-btn', startTraining);
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
});