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
let sessionCorrect = 0;
let sessionWrong = 0;   

let comboCount = 0;

function updateCombo(correct) {
    if (correct) {
        comboCount++;
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
        void el.offsetWidth; // reflow
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

const TRAINING_TIME = 60 * 60;
const API_BASE = window.location.origin;

function apiUrl(path) {
    return `${API_BASE}${path}`;
}

// ===== СИСТЕМА ПОЛЬЗОВАТЕЛЕЙ =====
let currentUserId = localStorage.getItem("userId") || null;

async function initUserId() {
    if (currentUserId) return;
    try {
        const res = await fetch(apiUrl("/api/register"), { method: "POST" });
        const data = await res.json();
        currentUserId = data.userId;
        localStorage.setItem("userId", currentUserId);
        console.log("Новый пользователь:", currentUserId.slice(0, 8) + "...");
    } catch (e) {
        console.error("Не удалось зарегистрироваться:", e);
    }
}

// Обёртка: автоматически добавляет X-User-Id в каждый запрос
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
    // Сначала грузим из localStorage — работает всегда (GitHub Pages, офлайн, телефон)
    const localData = safeParseStorage('myWords', []);
    if (localData.length > 0) {
        myWords = localData.map(word => ({
            ...word,
            example: word.example || "",
            exampleTranslate: word.exampleTranslate || "",
            forgetStep: Number(word.forgetStep) || 0
        }));
        isLoaded = true;
        render();
    }

    // Затем пробуем подтянуть с сервера (если он есть)
    try {
        const response = await apiFetch('/api/words');
        if (!response.ok) throw new Error('Сервер недоступен');
        const data = await response.json();
        if (Array.isArray(data) && data.length > 0) {
            myWords = data.map(word => ({
                ...word,
                example: word.example || "",
                exampleTranslate: word.exampleTranslate || "",
                forgetStep: Number(word.forgetStep) || 0
            }));
            // Синхронизируем серверные данные в localStorage
            localStorage.setItem('myWords', JSON.stringify(myWords));
        }
        isLoaded = true;
        render();
    } catch (e) {
        // Сервер недоступен (GitHub Pages) — работаем только на localStorage
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

function render() {
    if (!element) return;
    
    const now = Date.now();

    renderTagFilterBar();
    const base = getFilteredWords();
    const sorted = currentSort === 'default' ? base : (() => {
        const arr = [...base];
        switch (currentSort) {
            case 'level-asc':  return arr.sort((a,b) => (a.level||0) - (b.level||0));
            case 'level-desc': return arr.sort((a,b) => (b.level||0) - (a.level||0));
            case 'alpha':      return arr.sort((a,b) => a.original.localeCompare(b.original));
            case 'review':     return arr.sort((a,b) => (a.nextReview||0) - (b.nextReview||0));
        }
        return arr;
    })();
    const cardsHTML = sorted.map(word => { 
        const level = word.level || 0;
        const isMaxLevel = level === 5;
        
        const isReady = !word.nextReview || word.nextReview <= now;
        const reviewClass = (isReady && !isMaxLevel) ? 'needs-review' : '';
        
        const learnedStyle = isMaxLevel ? 'style="opacity: 0.5; background: rgba(40, 167, 69, 0.05);"' : '';
        const badge = `<span class="level-indicator" style="font-size: 10px; color: #00d2ff; background: rgba(0, 210, 255, 0.1); padding: 2px 6px; border-radius: 4px; margin-right: 8px;">Ур. ${level}</span>`;
        const tagsBadges = (word.tags || []).map(t => `<span class="word-tag">${t}</span>`).join('');

        return `
        <div class="card ${reviewClass}" data-id="${word.id}" ${learnedStyle}>
            <div class="card-content">
                ${badge}
                <span class="original editable-text" contenteditable="true">${word.original}</span>
                <span class="arrow" style="color: #999"> —> </span>
                <span class="translation hidden editable-text" contenteditable="true">${word.translate}</span>
                ${tagsBadges ? `<span style="margin-left:6px">${tagsBadges}</span>` : ''}
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

async function save() {
    if (!isLoaded) return;

    // Всегда сохраняем в localStorage — это основное хранилище
    localStorage.setItem('myWords', JSON.stringify(myWords));

    // Опционально синхронизируем с сервером (если он есть)
    try {
        await apiFetch('/api/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(myWords)
        });
    } catch (e) {
        // Сервер недоступен — не страшно, данные уже в localStorage
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

async function startTraining(mode) {
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
        showToast('Все слова уже повторены! Добавь новые или подожди следующего повторения.', 'info'); return;
        return;
    }

    // Переносим слова в очередь
    mainQueue = [...wordsToReview].sort(() => Math.random() - 0.5);
    activePool = [];
    currentWordIndex = 0;
    sessionCorrect = 0;
    sessionWrong = 0;
    comboCount = 0;
    sessionBestCombo = 0;
    sessionStartTime = Date.now();
    wordMistakes = {};
    const comboEl = document.getElementById('combo-display');
    if (comboEl) comboEl.style.display = 'none';
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
    // Сначала берём из localStorage
    const localTime = parseInt(localStorage.getItem('timeLeft')) || 0;
    if (localTime > 0) {
        timeLeft = localTime;
        updateUI();
    }

    // Пробуем подтянуть с сервера
    try {
        const response = await apiFetch('/api/timer');
        if (!response.ok) throw new Error('Timer API unavailable');
        const data = await response.json();
        if (data.timeLeft > 0) {
            timeLeft = data.timeLeft;
            localStorage.setItem('timeLeft', String(timeLeft));
        }
        updateUI();
    } catch (e) {
        // Сервер недоступен — используем localStorage значение
    }
}

async function saveTimerToServer() {
    // Всегда сохраняем в localStorage
    localStorage.setItem('timeLeft', String(timeLeft));

    // Опционально синхронизируем с сервером
    try {
        await apiFetch('/api/timer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ timeLeft: timeLeft })
        });
    } catch (e) {
        // Сервер недоступен — не страшно
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
    saveTimerToServer();
    finishTraining(); // возвращаемся на главный экран
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

    // Показываем итоги если было хоть одно слово
    if (sessionCorrect + sessionWrong > 0) {
        setTimeout(() => {
            showResults();
            checkAchievements();
        }, 300);
    }
}

function nextStep() {
    flashcard.classList.remove('is-flipped');
    setTimeout(updateFlashcard, 300);
}

// Мигает зелёным (верно) или красным (неверно)
function flashCard(correct) {
    return new Promise(resolve => {
        const fc = document.getElementById('flashcard');
        if (!fc) { resolve(); return; }

        // Вешаем класс на обе стороны — они имеют border-radius 25px
        const sides = fc.querySelectorAll('.flashcard-front, .flashcard-back');
        const cls = correct ? 'flash-correct' : 'flash-wrong';

        sides.forEach(s => s.classList.add(cls));

        setTimeout(() => {
            sides.forEach(s => s.classList.remove(cls));
            resolve();
        }, 380);
    });
}

// Обновляет счётчик сессии в шапке тренировки
function updateSessionCounter() {
    let el = document.getElementById('session-counter');
    if (!el) return;
    el.innerHTML = `<span style="color:#28a745">✓ ${sessionCorrect}</span> &nbsp; <span style="color:#ff4d4d">✗ ${sessionWrong}</span>`;
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
    sessionCorrect++;
    updateCombo(true);
    updateSessionCounter();
    saveToHistory(true);

    await flashCard(true);
    playSound('correct');

    const mainWord = myWords.find(w => w.id === word.id);
    if (mainWord) {
        mainWord.level = Math.min((mainWord.level || 0) + 1, 5);
        mainWord.nextReview = Date.now() + INTERVALS[mainWord.level];
        mainWord.forgetStep = 0;
        streakData.todayCount++;
        recordDailyLearn(1);

        // Конфетти когда выполнена дневная цель!
        if (streakData.todayCount === 10) {
            launchConfetti();
        }

        updateStreak();
        await save();
    }
    activePool.splice(currentWordIndex, 1);
    fillPool();
    if (currentWordIndex >= activePool.length) currentWordIndex = 0;
    checkAchievements();
    nextStep();
};

document.getElementById('btn-dont-know').onclick = async () => {
    sessionWrong++;
    updateCombo(false);
    updateSessionCounter();
    saveToHistory(false);

    await flashCard(false);
    playSound('wrong');

    const word = activePool[currentWordIndex];
    // Трекаем ошибки для топа сложных слов
    if (word) {
        wordMistakes[word.id] = (wordMistakes[word.id] || 0) + 1;
    }
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
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();

    if (streakData.lastDate !== today) {
        // Новый день
        if (streakData.lastDate === yesterday && streakData.todayCount >= 10) {
            // Вчера выполнили цель — стрик продолжается
            streakData.count = (streakData.count || 0) + 1;
        } else if (streakData.lastDate !== yesterday) {
            // Пропустили день — стрик сбрасывается
            streakData.count = 0;
        }
        streakData.todayCount = 0;
        streakData.lastDate = today;
    }

    const streakCountEl = document.getElementById('streak-count');
    const dailyCountEl = document.getElementById('daily-count');
    if (streakCountEl) streakCountEl.innerText = streakData.count;
    if (dailyCountEl) dailyCountEl.innerText = streakData.todayCount;

    // Подсвечиваем прогресс дневной цели
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

addBtn.onclick = async () => {
    const en = inputEn.value.trim();
    const ru = inputRu.value.trim();
    if (en && ru) {
        const tagsInput = document.getElementById('input-tags');
        const tags = tagsInput ? tagsInput.value.split(',').map(t => t.trim()).filter(Boolean) : [];
        myWords.push({
            id: Date.now(),
            original: en, translate: ru,
            example: inputEx.value.trim(),
            exampleTranslate: inputExRu.value.trim(),
            level: 0, nextReview: Date.now(), forgetStep: 0,
            tags
        });
        await save();
        render();
        renderTagFilterBar();
        inputEn.value = ''; inputRu.value = ''; inputEx.value = ''; inputExRu.value = '';
        if (tagsInput) tagsInput.value = '';
        inputEn.focus();
        checkAchievements();
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
        const idx = myWords.findIndex(w => w.id === id);
        const removed = myWords.splice(idx, 1)[0];
        save(); render();
        showUndoToast(removed, idx);
        return;
    }
    const trans = card.querySelector('.translation');
    if (trans) trans.classList.toggle('hidden');
};

// Сохраняем изменения при редактировании слова через contenteditable
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
    // Небольшая визуальная подсказка что сохранилось
    e.target.style.color = '#28a745';
    setTimeout(() => { e.target.style.color = ''; }, 600);
}, true);

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
    // Экспорт текста (.txt) — просто слова без прогресса
    const textToSave = myWords.map(w => `${w.original}|${w.translate}|${w.example || ''}|${w.exampleTranslate || ''}`).join('\n');
    const blob = new Blob([textToSave], { type: 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `словарь_${new Date().toLocaleDateString('ru-RU').replace(/\./g,'-')}.txt`;
    link.click();
};

// Резервная копия — полный JSON включая уровни и прогресс
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

// Восстановление из JSON
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


// ============================================================
// СВАЙП КАРТОЧКИ на телефоне
// влево = Не знаю, вправо = Знаю
// ============================================================
(function initSwipe() {
    const fc = document.getElementById('flashcard');
    if (!fc) return;

    let startX = 0, startY = 0, isDragging = false;
    const THRESHOLD = 80; // px для срабатывания

    function onStart(x, y) {
        startX = x; startY = y;
        isDragging = true;
        fc.style.transition = 'none';
    }

    function onMove(x, y) {
        if (!isDragging) return;
        const dx = x - startX;
        const dy = y - startY;
        // Если вертикальный скролл — не свайпаем карточку
        if (Math.abs(dy) > Math.abs(dx) + 10) { isDragging = false; fc.style.transform = ''; return; }
        const rotate = dx * 0.08;
        fc.style.transform = `translateX(${dx}px) rotate(${rotate}deg)`;
        // Цвет подсказки
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
            // Свайп вправо — Знаю
            fc.style.transform = 'translateX(120%) rotate(20deg)';
            setTimeout(() => {
                fc.style.transform = '';
                fc.style.transition = '';
                document.getElementById('btn-know').click();
            }, 280);
        } else if (dx < -THRESHOLD) {
            // Свайп влево — Не знаю
            fc.style.transform = 'translateX(-120%) rotate(-20deg)';
            setTimeout(() => {
                fc.style.transform = '';
                fc.style.transition = '';
                document.getElementById('btn-dont-know').click();
            }, 280);
        } else {
            // Не хватило — возвращаем на место
            fc.style.transform = '';
            setTimeout(() => { fc.style.transition = ''; }, 300);
        }
    }

    // Touch
    fc.addEventListener('touchstart', e => {
        // Не свайпаем если карточка уже перевёрнута (просматривают перевод)
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
// Пробел — перевернуть карточку
// → или L — Знаю
// ← или J — Не знаю
// ============================================================
document.addEventListener('keydown', (e) => {
    const trainSect = document.getElementById('training-section');
    if (!trainSect || trainSect.style.display === 'none') return;

    // Не перехватываем если фокус в input/textarea
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
let currentSort = 'default'; // default | level-asc | level-desc | alpha | review

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
    // Подсветить активную кнопку
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
// TOAST — красивые уведомления вместо alert()
// showToast(msg, type)  type: 'success' | 'error' | 'info' | 'warning'
// showConfirm(msg) => Promise<boolean>  — вместо confirm()
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
        // Затемнение
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
// ЗВУКОВЫЕ ЭФФЕКТЫ (AudioContext — без файлов)
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
            // Два восходящих тона — приятный аккорд
            osc.type = 'sine';
            osc.frequency.setValueAtTime(440, ctx.currentTime);
            osc.frequency.setValueAtTime(660, ctx.currentTime + 0.08);
            gain.gain.setValueAtTime(0.18, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.35);
        } else if (type === 'wrong') {
            // Нисходящий тон
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(300, ctx.currentTime);
            osc.frequency.setValueAtTime(180, ctx.currentTime + 0.15);
            gain.gain.setValueAtTime(0.12, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.3);
        } else if (type === 'flip') {
            // Тихий клик при перевороте
            osc.type = 'sine';
            osc.frequency.setValueAtTime(800, ctx.currentTime);
            gain.gain.setValueAtTime(0.06, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.08);
        } else if (type === 'combo') {
            // Восходящий аккорд для комбо
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(523, ctx.currentTime);
            osc.frequency.setValueAtTime(784, ctx.currentTime + 0.1);
            gain.gain.setValueAtTime(0.15, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.4);
        }
    } catch(e) { /* AudioContext недоступен */ }
}


// ============================================================
// ИТОГИ ТРЕНИРОВКИ
// ============================================================
let sessionBestCombo = 0;
let sessionStartTime = 0;
let wordMistakes = safeParseStorage('wordMistakes', {}); // { wordId: count }

function showResults() {
    const modal = document.getElementById('results-modal');
    if (!modal) return;

    const total = sessionCorrect + sessionWrong;
    const accuracy = total > 0 ? Math.round(sessionCorrect / total * 100) : 0;
    const mins = Math.round((Date.now() - sessionStartTime) / 60000);

    // Выбираем эмодзи по точности
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
            { value: streakData.count + ' 🔥', label: 'Стрик', color: '#ff6b35' },
        ].map(r => `
            <div class="result-card">
                <div class="rc-value" style="color:${r.color}">${r.value}</div>
                <div class="rc-label">${r.label}</div>
            </div>
        `).join('');
    }

    // Топ-3 сложных слова из текущей сессии
    const hardWords = Object.entries(wordMistakes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id, cnt]) => {
            const w = myWords.find(x => x.id == id);
            return w ? `<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><span>${w.original}</span><span style="color:#ff4d4d;font-weight:700">${cnt}× ❌</span></div>` : '';
        }).filter(Boolean).join('');

    const hardEl = document.getElementById('results-hardest');
    const hardList = document.getElementById('results-hardest-list');
    if (hardEl && hardList) {
        if (hardWords) {
            hardList.innerHTML = hardWords;
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
// АВТОПЕРЕВОД (MyMemory API — бесплатный, без ключа)
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

// Кнопка автоперевода на главной форме
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
// БЫСТРОЕ ДОБАВЛЕНИЕ ВО ВРЕМЯ ТРЕНИРОВКИ
// ============================================================
function openQuickAdd() {
    const m = document.getElementById('quick-add-modal');
    if (!m) return;
    m.style.display = 'flex';
    const enField = document.getElementById('qa-en');
    if (enField) { enField.value = ''; enField.focus(); }
    const ruField = document.getElementById('qa-ru');
    if (ruField) ruField.value = '';
}

function closeQuickAdd() {
    const m = document.getElementById('quick-add-modal');
    if (m) m.style.display = 'none';
}

document.getElementById('qa-translate-btn')?.addEventListener('click', async () => {
    const en = document.getElementById('qa-en')?.value.trim();
    if (!en) return;
    const btn = document.getElementById('qa-translate-btn');
    btn.textContent = '⏳';
    btn.style.pointerEvents = 'none';
    const translation = await autoTranslate(en);
    btn.textContent = '🔄';
    btn.style.pointerEvents = '';
    const ruField = document.getElementById('qa-ru');
    if (translation && ruField) ruField.value = translation;
});

document.getElementById('qa-save-btn')?.addEventListener('click', async () => {
    const en = document.getElementById('qa-en')?.value.trim();
    const ru = document.getElementById('qa-ru')?.value.trim();
    if (!en || !ru) return;
    myWords.push({ id: Date.now(), original: en, translate: ru, example: '', exampleTranslate: '', level: 0, nextReview: Date.now(), forgetStep: 0 });
    await save();
    closeQuickAdd();
    // Маленькое подтверждение
    showToast(`"${en}" добавлено!`, 'success', 2000);
    checkAchievements();
});

// Закрывать модалки по клику вне
document.getElementById('quick-add-modal')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('quick-add-modal')) closeQuickAdd();
});
document.getElementById('results-modal')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('results-modal')) closeResults();
});


// ============================================================
// ТЕГИ / ГРУППЫ
// ============================================================
let activeTagFilter = null; // null = все слова

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
    // Вставляем обратно на то же место
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
let quizWaiting = false; // ждём клика после ответа

function startQuizMode() {
    const now = Date.now();
    const pool = getFilteredWords().filter(w => !w.nextReview || w.nextReview <= now);
    if (pool.length < 4) {
        alert('Нужно минимум 4 слова для этого режима!');
        return;
    }
    isQuizMode = true;
    quizQueue = [...pool].sort(() => Math.random() - 0.5);
    quizIndex = 0;
    quizWaiting = false;
    sessionCorrect = 0; sessionWrong = 0;
    sessionBestCombo = 0; comboCount = 0;
    sessionStartTime = Date.now();
    wordMistakes = {};

    // Показываем тренировочный экран
    document.getElementById('main-ui').style.display = 'none';
    document.getElementById('training-section').style.display = 'flex';
    const levelStats = document.getElementById('level-stats');
    if (levelStats) levelStats.style.display = 'none';
    if (mainHeader) mainHeader.style.display = 'none';
    if (progressWrapper) progressWrapper.style.display = 'none';

    // Скрываем карточку, показываем quiz
    document.querySelector('.flashcard-container').style.display = 'none';
    document.getElementById('spelling-area').style.display = 'none';
    document.querySelector('.training-buttons').style.display = 'none';
    document.getElementById('toggle-mode-btn').style.display = 'none';
    document.getElementById('quiz-area').style.display = 'block';

    updateSessionCounter();
    showQuizQuestion();
}

function showQuizQuestion() {
    if (quizIndex >= quizQueue.length) {
        // Пройдены все — финиш
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

    // Собираем 3 случайных неправильных варианта из остальных слов
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

    // Подсвечиваем все кнопки
    btns.forEach(b => {
        b.disabled = true;
        const bText = b.textContent.trim();
        if (bText === correct) b.classList.add('correct');
        else if (b === btn && !isCorrect) b.classList.add('wrong');
    });

    const word = quizQueue[quizIndex];
    if (isCorrect) {
        sessionCorrect++;
        updateCombo(true);
        feedbackEl.textContent = '✅ Верно!';
        feedbackEl.style.color = '#28a745';
        // Повышаем уровень
        const mw = myWords.find(w => w.id === word.id);
        if (mw) {
            mw.level = Math.min((mw.level || 0) + 1, 5);
            mw.nextReview = Date.now() + INTERVALS[mw.level];
            mw.forgetStep = 0;
            streakData.todayCount++;
            recordDailyLearn(1);
            updateStreak();
            if (streakData.todayCount === 10) launchConfetti();
            save();
        }
    } else {
        sessionWrong++;
        updateCombo(false);
        wordMistakes[word.id] = (wordMistakes[word.id] || 0) + 1;
        feedbackEl.textContent = `❌ Правильно: ${correct}`;
        feedbackEl.style.color = '#ff4d4d';
        const mw = myWords.find(w => w.id === word.id);
        if (mw) { applyForgetSchedule(mw); save(); }
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
    if (fc) fc.style.display = '';
    if (tb) tb.style.display = '';
    if (tg) tg.style.display = '';
    if (qa) qa.style.display = 'none';
}

// ✅ DRAGGABLE TIMER
(function initDraggableTimer() {
    const card = document.getElementById('timer-container');
    if (!card) return;

    let isDragging = false;
    let startX, startY, origLeft, origTop;

    function isMobile() {
        return window.innerWidth <= 600;
    }

    function onStart(x, y) {
        if (isMobile()) return; // на мобиле не двигаем — он внизу по центру
        isDragging = true;
        startX = x;
        startY = y;
        const rect = card.getBoundingClientRect();
        origLeft = rect.left;
        origTop = rect.top;
        card.style.right = 'auto';
        card.style.transition = 'none';
    }

    function onMove(x, y) {
        if (!isDragging) return;
        const dx = x - startX;
        const dy = y - startY;
        let newLeft = origLeft + dx;
        let newTop = origTop + dy;

        // Держим в пределах экрана
        const maxX = window.innerWidth - card.offsetWidth - 8;
        const maxY = window.innerHeight - card.offsetHeight - 8;
        newLeft = Math.max(8, Math.min(newLeft, maxX));
        newTop = Math.max(8, Math.min(newTop, maxY));

        card.style.left = newLeft + 'px';
        card.style.top = newTop + 'px';
    }

    function onEnd() {
        isDragging = false;
        card.style.transition = '';
        // Сохраняем позицию
        localStorage.setItem('timerPos', JSON.stringify({
            left: card.style.left,
            top: card.style.top
        }));
    }

    // Восстанавливаем позицию
    const saved = localStorage.getItem('timerPos');
    if (saved && !isMobile()) {
        try {
            const pos = JSON.parse(saved);
            if (pos.left) { card.style.left = pos.left; card.style.right = 'auto'; }
            if (pos.top) card.style.top = pos.top;
        } catch(e) {}
    }

    // Mouse events
    card.addEventListener('mousedown', (e) => {
        if (e.target.id === 'add-time-btn') return;
        onStart(e.clientX, e.clientY);
    });
    document.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
    document.addEventListener('mouseup', onEnd);

    // Touch events
    card.addEventListener('touchstart', (e) => {
        if (e.target.id === 'add-time-btn') return;
        const t = e.touches[0];
        onStart(t.clientX, t.clientY);
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        const t = e.touches[0];
        onMove(t.clientX, t.clientY);
    }, { passive: true });
    document.addEventListener('touchend', onEnd);

    // При ресайзе сбрасываем позицию если вышло за экран
    window.addEventListener('resize', () => {
        if (isMobile()) {
            card.style.left = '';
            card.style.top = '';
            card.style.right = '';
        }
    });
})();
const fileUpload = document.getElementById('file-upload');
if (fileUpload) {
    fileUpload.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        // Показываем имя файла
        const fileNameEl = document.getElementById('file-name');
        if (fileNameEl) fileNameEl.textContent = `📄 ${file.name}`;

        const reader = new FileReader();
        reader.onload = (event) => {
            const text = event.target.result;
            // Вставляем содержимое файла в textarea
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

    // 1. Получаем/создаём уникальный ID пользователя (ПЕРВЫМ делом!)
    await initUserId();

    // 2. Загружаем данные
    await loadWords();
    
    // 3. Дневной сброс и таймер
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

// ===== PWA: Service Worker =====
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
}