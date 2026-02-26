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

// Глобальная переменная для управления таймером

let isTrainingActive = localStorage.getItem('isTrainingActive') === 'true';

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
const topPanel = document.getElementById('top-panel') || document.querySelector('.top-panel');
const muteBtn = document.getElementById('mute-btn');
const muteIcon = document.getElementById('mute-icon');

const startBtn = document.getElementById('start-training-btn');
const stopBtn = document.getElementById('stop-training');
const trainSect = document.getElementById('training-section');
const mainUI = document.getElementById('main-ui');
const flashcard = document.getElementById('flashcard');

const modal = document.getElementById('import-modal');
const openBtn = document.getElementById('open-import-btn');
const closeBtn = document.querySelector('.close-modal');
const importBtn = document.getElementById('import-btn');
const importArea = document.getElementById('import-area');

const resetLearnedBtn = document.getElementById('reset-learned-btn');
const exportBtn = document.getElementById('export-btn');

// Состояние

let mainQueue = [];      
let trainingHistory = []; 
let activePool = [];     
let currentWordIndex = 0;
let cardClickStage = 0; // 0 - лицо, 1 - перевод, 2 - пример
let isMuted = localStorage.getItem('isMuted') === 'true'; 
let isLoaded = false; 
const POOL_LIMIT = 50;   

let streakData = JSON.parse(localStorage.getItem('streakData')) || {
    count: 0,
    lastDate: null,
    todayCount: 0
};

const INTERVALS = {
    0: 0,
    1: 24 * 60 * 60 * 1000,
    2: 3 * 24 * 60 * 60 * 1000,
    3: 7 * 24 * 60 * 60 * 1000,
    4: 14 * 24 * 60 * 60 * 1000,
    5: 30 * 24 * 60 * 60 * 1000
};

// === 2. ОСНОВНЫЕ ФУНКЦИИ ===

async function loadWords() {
    try {
        const response = await fetch('http://localhost:3000/api/words');
        if (!response.ok) throw new Error('Ошибка сети');
        const data = await response.json();
        
        // Мапим данные, чтобы у каждого слова ТОЧНО были нужные поля
        myWords = (Array.isArray(data) ? data : []).map(word => ({
            ...word,
            example: word.example || "",
            exampleTranslate: word.exampleTranslate || ""
        }));

        isLoaded = true; 
        render();
    } catch (e) {
        console.error("Ошибка загрузки сервера!", e);
    }
}
// Используем функцию-безопасник, чтобы не ловить ошибки null
function safeSetClick(id, callback) {
    const el = document.getElementById(id);
    if (el) {
        el.onclick = callback;
    } else {
        console.warn(`Элемент с ID ${id} не найден!`);
    }
}

    safeSetClick('mute-btn', () => {
        isMuted = !isMuted;
        localStorage.setItem('isMuted', isMuted);
        if (muteIcon) muteIcon.innerText = isMuted ? '🔇' : '🔊';
        if (isMuted) window.speechSynthesis.cancel();
    });

    // Кнопка закрытия внутри модалки (если у неё есть класс .close-modal)
   
    if (closeBtn) {
        closeBtn.onclick = () => modal.style.display = "none";
    }

    // Остальные твои вызовы (loadWords и т.д.)
    loadWords();
    updateStreak();
    
    const savedTheme = localStorage.getItem('selectedTheme');
    if (savedTheme) setTheme(savedTheme);

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
    element.innerHTML = ''; 
    const now = Date.now(); // Текущее время

    myWords.forEach(word => { 
        const level = word.level || 0;
        const isMaxLevel = level === 5;
        
        // ПРОВЕРКА: Пора ли повторять?
        const isReady = !word.nextReview || word.nextReview <= now;
        const reviewClass = (isReady && !isMaxLevel) ? 'needs-review' : '';
        
        const learnedStyle = isMaxLevel ? 'style="opacity: 0.5; background: rgba(40, 167, 69, 0.05);"' : '';
        const badge = `<span class="level-indicator" style="font-size: 10px; color: #00d2ff; background: rgba(0, 210, 255, 0.1); padding: 2px 6px; border-radius: 4px; margin-right: 8px;">Ур. ${level}</span>`;

        element.innerHTML += `
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
    });
    updateOverallProgress();
    updateLevelStats(); // Вызываем новую функцию статистики
}

async function save() {
    if (!isLoaded) return;
    try {
        await fetch('http://localhost:3000/api/sync', {
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

// === УМНЫЙ ЗАПУСК ТРЕНИРОВКИ ===
async function startTraining() {
    // 1. Сначала объявляем время, чтобы фильтр слов его видел
    const now = Date.now(); 

    // 2. Синхронизируем время с сервером
    try {
        await loadTimerFromServer();
    } catch (e) {
        console.error("Не удалось подтянуть время, работаем на локальном");
    }

    // 3. Проверка: timeLeft должна быть объявлена в самом верху app.js как let
    if (timeLeft <= 0) {
        alert("Время вышло! Нажми '+5 мин'.");
        return;
    }

    // 4. Фильтруем слова (теперь 'now' определен!)
    const wordsToReview = myWords.filter(w => !w.nextReview || w.nextReview <= now);
    
    if (myWords.filter(w => !w.nextReview || w.nextReview <= Date.now()).length === 0) {
        alert("Все слова повторены!");
        return;
    }

    // 5. Переносим локальные слова в глобальную очередь
    mainQueue = [...wordsToReview].sort(() => Math.random() - 0.5);
    activePool = [];
    currentWordIndex = 0;
    fillPool();

    // 6. Логика таймера
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

    // 7. Визуальное переключение
    document.getElementById('main-ui').style.display = 'none';
    document.getElementById('training-section').style.display = 'flex';
    updateFlashcard();
}
async function loadTimerFromServer() {
    try {
        const response = await fetch('http://localhost:3000/api/timer');
        const data = await response.json();
        timeLeft = data.timeLeft;
        updateUI(); // Обновляем цифры на экране
    } catch (e) {
        console.error("Ошибка загрузки таймера с сервера");
    }
}
async function saveTimerToServer() {
    try {
        await fetch('http://localhost:3000/api/timer', {
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
    await saveTimerToServer(); // Сохраняем в БД сразу

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

// 2. Сброс таймера каждый новый день
function dailyReset() {
    const lastVisit = localStorage.getItem('lastVisit');
    const today = new Date().toLocaleDateString();

    if (lastVisit !== today) {
        timeLeft = TRAINING_TIME;
        localStorage.setItem('timeLeft', timeLeft);
        localStorage.setItem('lastVisit', today);
    }
}
// 2. Умный запуск таймера

// 3. Форматирование времени
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
    
    // --- ОЧИСТКА ПОЛЕЙ РЕЖИМА ПИСЬМА ---
    const spellingInput = document.getElementById('spelling-input');
    const spellingFeedback = document.getElementById('spelling-feedback');
    
    if (spellingInput) {
        spellingInput.value = ""; // Очищаем поле ввода
        spellingInput.focus();    // Ставим фокус для следующего слова
    }
    if (spellingFeedback) {
        spellingFeedback.innerText = ""; // Убираем надпись "Верно!"
    }
    // ----------------------------------

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

    // ШАГ 1: Переворачиваем карточку
    if (cardClickStage === 0) {
        flashcard.classList.add('is-flipped');
        if (!isMuted && word) speak(word.original);
        cardClickStage = 1;
    } 
    // ШАГ 2: Показываем блок примера и САМ ПРИМЕР (En)
    else if (cardClickStage === 1 && hasExample) {
        if (exampleBlock) exampleBlock.style.display = 'block';
        if (cardExample) cardExample.style.visibility = 'visible';
        if (cardExRu) cardExRu.style.visibility = 'hidden'; // Перевод пока спит
        cardClickStage = 2;
    } 
    // ШАГ 3: Показываем ПЕРЕВОД примера (Ru)
    else if (cardClickStage === 2 && hasExample) {
        if (cardExRu) cardExRu.style.visibility = 'visible';
        cardClickStage = 3;
    } 
    // ШАГ 4: Если кликнуть еще раз — сброс (или если примера вообще нет)
    else {
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
// 1. При запуске тренировки — скрываем уровни

function stopTraining() {
    clearInterval(timerId);
    timerId = null;
    isTrainingActive = false;
    localStorage.setItem('isTrainingActive', 'false');
    
    const statusEl = document.getElementById('timer-status');
    if (statusEl) statusEl.textContent = "На паузе";
}
function finishDay() {
    // 1. Останавливаем таймер
    clearInterval(timerId);
    timerId = null;

    // 2. Выходим из режима тренировки в главное меню
    finishTraining(); 

    // 3. Показываем уведомление
    alert("Время тренировки вышло! На сегодня достаточно. Но ты можешь продолжить работу со словарем в обычном режиме.");
    
    // 4. Опционально: меняем статус таймера
    const statusEl = document.getElementById('timer-status');
    if (statusEl) {
        statusEl.textContent = "Лимит исчерпан";
        statusEl.style.color = "#ff4444";
    }
}
// 2. При завершении — ОБЯЗАТЕЛЬНО показываем обратно
function finishTraining() {
    const levelStats = document.getElementById('level-stats');
    const mainUI = document.getElementById('main-ui');
    const trainSect = document.getElementById('training-section');
    
    // Новые элементы, которые нужно вернуть:
    const mainHeader = document.querySelector('h1');
    const progressWrapper = document.querySelector('.progress-wrapper');
    const topPanel = document.getElementById('top-panel') || document.querySelector('.top-panel');

    // Прячем экран тренировки, показываем главный экран
    if (trainSect) trainSect.style.display = 'none';
    if (mainUI) mainUI.style.display = 'block';
    
    // ВОЗВРАЩАЕМ ЗАГОЛОВОК И ПРОГРЕСС
    if (mainHeader) mainHeader.style.display = 'block';
    if (progressWrapper) progressWrapper.style.display = 'block';
    if (topPanel) topPanel.style.display = 'flex'; // Панель обычно flex
    
    // Возвращаем статистику уровней
    if (levelStats) levelStats.style.display = 'flex'; 

    // Возвращаем скролл страницы
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
        wasRemoved: wasRemoved
    });
}

document.getElementById('btn-know').onclick = async () => {
    const word = activePool[currentWordIndex];
    saveToHistory(true); 
    const mainWord = myWords.find(w => w.id === word.id);
    if (mainWord) {
        mainWord.level = Math.min((mainWord.level || 0) + 1, 5);
        mainWord.nextReview = Date.now() + INTERVALS[mainWord.level];
        streakData.todayCount++;
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
        mainWord.level = 0;
        mainWord.nextReview = Date.now();
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
        save();
    }
    if (lastState.wasRemoved) activePool.splice(lastState.indexInPool, 0, mainWord);
    currentWordIndex = lastState.indexInPool;
    nextStep();
};

// === 4. ОБРАБОТЧИКИ СОБЫТИЙ ===


if (resetLearnedBtn) {
    resetLearnedBtn.onclick = async () => {
        if (confirm("Вы уверены? Это обнулит уровни слов, стрик и счетчик за сегодня!")) {
            
            // 1. Сбрасываем уровни слов
            myWords.forEach(word => {
                word.level = 0;
                word.nextReview = Date.now();
            });

            // 2. Полностью обнуляем объект стрика
            streakData = {
                count: 0,        // Огонь (дни подряд)
                lastDate: new Date().toDateString(), // Сегодняшняя дата
                todayCount: 0    // Твои "17 / 10" превратятся в "0 / 10"
            };

            // 3. Сохраняем обнуленные данные в локальную память браузера
            localStorage.setItem('streakData', JSON.stringify(streakData));

            // 4. Отправляем пустые уровни на сервер
            await save(); 

            // 5. ОБНОВЛЯЕМ ЭКРАН
            if (typeof updateStreak === 'function') {
                updateStreak(); // Эта функция обновит текст "0 / 10"
            }
            
            render();                // Перерисует список слов
            updateOverallProgress(); // Сбросит общую полосу прогресса
            
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

    // 1. Берем текущий акцентный цвет из CSS-переменной
    const accentColor = getComputedStyle(document.documentElement)
                        .getPropertyValue('--accent-color').trim() || '#00d2ff';

    const counts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    myWords.forEach(w => {
        counts[w.level || 0]++;
    });

    // 2. Генерируем карточки уровней
    let statsHTML = Object.entries(counts).map(([lvl, count]) => {
        // Уровень 5 всегда зеленый (успех), остальные — в цвет темы
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

    // 3. Кнопка "Все" (белая подложка для контраста)
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
    const btnNext = document.getElementById('btn-next'); // Находим нашу новую кнопку

    if (isSpellingMode) {
        toggleModeBtn.innerHTML = "<span>📝</span> Режим: Письмо";
        spellingArea.style.display = 'block';
        
        // В режиме ПИСЬМА:
        btnKnow.style.display = 'none';      // Прячем "Знаю"
        btnDontKnow.style.display = 'none';  // Прячем "Не знаю"
        btnNext.style.display = 'block';     // ПОКАЗЫВАЕМ "Вперед"
        
        btnBack.classList.add('full-width-btn');
        spellingInput.focus();
    } else {
        toggleModeBtn.innerHTML = "<span>🎴</span> Режим: Карточки";
        spellingArea.style.display = 'none';
        
        // В режиме КАРТОЧЕК:
        btnKnow.style.display = 'block';     // Показываем "Знаю"
        btnDontKnow.style.display = 'block'; // Показываем "Не знаю"
        btnNext.style.display = 'none';      // ПРЯЧЕМ "Вперед"
        
        btnBack.classList.remove('full-width-btn');
    }
};
spellingInput.onkeydown = (e) => {
    if (e.key === 'Enter') {
    // Если карточка уже открыта, второй Enter переводит к следующему слову
    if (flashcard.classList.contains('is-flipped')) {
        document.getElementById('btn-know').click();
        return;
    }
    // ... остальной код проверки слова ...
}
    if (e.key === 'Enter') {
        const word = activePool[currentWordIndex];
        const userValue = spellingInput.value.trim().toLowerCase();
        const correctAnswer = word.currentExpectedAnswer.trim().toLowerCase();

        if (userValue === correctAnswer) {
            spellingFeedback.innerText = "✅ Верно!";
            spellingFeedback.style.color = "#28a745";
            flashcard.classList.add('is-flipped');
            cardClickStage = 1; // Теперь ты можешь кликать и смотреть примеры
        } else {
            spellingFeedback.innerText = `❌ Правильно: ${correctAnswer}`;
            spellingFeedback.style.color = "#dc3545";
            flashcard.classList.add('is-flipped');
            cardClickStage = 1;
        }
        // ТАЙМЕР УДАЛЕН. Теперь переход только по кнопке или Enter еще раз.
    }
};

function resetSpelling() {
    spellingInput.value = '';
    spellingFeedback.innerText = '';
    setTimeout(() => spellingInput.focus(), 100);
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
            level: 0, nextReview: Date.now()
        });
        await save();
        render();
        inputEn.value = ''; inputRu.value = ''; inputEx.value = ''; inputExRu.value = '';
        inputEn.focus();
    }
};
document.getElementById('btn-next').onclick = () => {
    // В режиме письма эта кнопка работает как "Не знаю"
    const word = activePool[currentWordIndex];
    if (!word) return;

    // 1. Сохраняем состояние в историю (чтобы можно было нажать "Назад")
    saveToHistory(false); 

    // 2. Находим слово в основной базе и сбрасываем уровень
    const mainWord = myWords.find(w => w.id === word.id);
    if (mainWord) {
        mainWord.level = 0;
        mainWord.nextReview = Date.now();
        save(); // Отправляем на сервер
    }

    // 3. Двигаемся к следующему слову
    currentWordIndex++;
    if (currentWordIndex >= activePool.length) {
        currentWordIndex = 0;
    }
    
    nextStep();
};
function handleDontKnow() {
    const word = activePool[currentWordIndex];
    if (!word) return;

    // Сбрасываем уровень прогресса слова (логика зависит от твоего приложения)
    word.level = 0;
    word.nextReview = Date.now() + 60000; // Повтор через минуту

    // Перемещаем слово в конец очереди или просто идем дальше
    // Вызываем твою стандартную функцию перехода
    nextStep(); 
    
    // Сохраняем изменения на сервер
    save(); 
}
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

stopBtn.onclick = finishTraining;
openBtn.onclick = () => {
    modal.style.display = "block";
    setTimeout(() => importArea.focus(), 100); // Фокус на поле импорта
};
closeBtn.onclick = () => modal.style.display = "none";

importBtn.onclick = async () => {
    const text = importArea.value;
    const lines = text.split('\n');
    let importedCount = 0;
    let duplicateCount = 0;
    let duplicatesList = [];

    lines.forEach(line => {
        const parts = line.split('|').map(p => p.trim());
        
        // Проверяем, что в строке есть хотя бы оригинал и перевод
        if (parts.length >= 2) {
            const originalText = parts[0];
            const translateText = parts[1];

            // ПРОВЕРКА НА ДУБЛИКАТ
            // Ищем в myWords слово с таким же оригиналом (без учета регистра)
            const isDuplicate = myWords.some(w => 
                w.original.toLowerCase() === originalText.toLowerCase()
            );

            if (isDuplicate) {
                duplicateCount++;
                duplicatesList.push(originalText);
            } else {
                // Если слова нет — добавляем
                myWords.push({
                    id: Date.now() + Math.random(), // Уникальный ID
                    original: originalText,
                    translate: translateText,
                    example: parts[2] || "",
                    exampleTranslate: parts[3] || "",
                    level: 0,
                    nextReview: Date.now()
                });
                importedCount++;
            }
        }
    });

    if (importedCount > 0) {
        await save(); // Сохраняем в SQLite через твой API
        render();     // Перерисовываем список на экране
    }

    // Оповещение пользователя
    if (duplicateCount > 0) {
        alert(`Импорт завершен!
✅ Добавлено новых слов: ${importedCount}
⚠️ Пропущено дубликатов: ${duplicateCount}
(Слова уже в словаре: ${duplicatesList.join(', ')})`);
    } else if (importedCount > 0) {
        alert(`Успешно добавлено ${importedCount} слов!`);
    } else {
        alert("Новых слов для добавления не найдено.");
    }

    // Закрываем модалку и чистим поле
    modal.style.display = 'none';
    importArea.value = '';
};
exportBtn.onclick = () => {
    const textToSave = myWords.map(w => `${w.original}|${w.translate}|${w.example}|${w.exampleTranslate}`).join('\n');
    const blob = new Blob([textToSave], { type: 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `vocab_backup.txt`;
    link.click();
};

searchInput.oninput = () => {
    const val = searchInput.value.trim().toLowerCase();
    const cards = document.querySelectorAll('.card');

    cards.forEach(card => {
        const originalSpan = card.querySelector('.original');
        const translationSpan = card.querySelector('.translation');
        
        // Получаем чистый текст без старой подсветки
        const originalText = originalSpan.textContent;
        const translationText = translationSpan.textContent;

        if (val === "") {
            // Если поиск пустой, возвращаем всё как было
            card.style.display = 'flex';
            originalSpan.innerHTML = originalText;
            translationSpan.innerHTML = translationText;
            return;
        }

        const matchOriginal = originalText.toLowerCase().includes(val);
        const matchTranslation = translationText.toLowerCase().includes(val);

        if (matchOriginal || matchTranslation) {
            card.style.display = 'flex';
            // Подсвечиваем совпадения
            originalSpan.innerHTML = highlightMatch(originalText, val);
            translationSpan.innerHTML = highlightMatch(translationText, val);
        } else {
            card.style.display = 'none';
        }
    });
};

// Вспомогательная функция для замены текста на текст с тегом <mark>
function highlightMatch(text, term) {
    const regex = new RegExp(`(${term})`, 'gi');
    return text.replace(regex, `<mark>$1</mark>`);
}
function filterByLevel(level) {
    const cards = document.querySelectorAll('.card');
    
    cards.forEach(card => {
        // Находим индикатор уровня внутри карточки (мы его добавили в render)
        const levelBadge = card.querySelector('.level-indicator');
        if (!levelBadge) return;

        // Извлекаем число из текста "Ур. X"
        const cardLevel = levelBadge.innerText.replace('Ур. ', '');

        if (level === 'all') {
            card.style.display = 'flex'; // Показываем все
        } else if (cardLevel == level) {
            card.style.display = 'flex'; // Показываем только совпадения
        } else {
            card.style.display = 'none'; // Скрываем остальные
        }
    });

    // Визуальный отклик: можно добавить уведомление или просто прокрутить к списку
    console.log(`Фильтр: Уровень ${level}`);
}
function setTheme(color) {
    // Устанавливаем основную переменную
    document.documentElement.style.setProperty('--accent-color', color);
    
    // Создаем цвет для свечения (с прозрачностью)
    const glowColor = color + '4D'; // Добавляем 4D (это ~30% прозрачности в HEX)
    document.documentElement.style.setProperty('--accent-glow', glowColor);
    
    // Сохраняем выбор пользователя
    localStorage.setItem('selectedTheme', color);
    
    // Перерисовываем статистику, так как там цвета прописаны в JS
    updateLevelStats();
}
// Находим кнопку импорта по новому ID
const openImportBtn = document.getElementById('open-import-btn');
const importModal = document.getElementById('import-modal');

if (openImportBtn && importModal) {
    openImportBtn.onclick = () => {
        importModal.style.display = 'flex';
    };
}

// Когда страница загрузилась
window.addEventListener('DOMContentLoaded', async () => {
    // 1. ЗАГРУЗКА ДАННЫХ (оставляем как было)
    await loadTimerFromServer(); 
    await loadWords(); 

    // 2. СБРОС СОСТОЯНИЙ (перенесли из шага 4)
    localStorage.removeItem('isTrainingActive');
    if (timerId) {
        clearInterval(timerId);
        timerId = null;
    }

    // 3. ОБРАБОТЧИКИ КНОПОК
    safeSetClick('start-training-btn', startTraining);
    safeSetClick('add-time-btn', () => addExtraTime(5));
    safeSetClick('open-import-btn', openImportModal); // если есть такая функция

    // 4. ВОЗВРАТ ИНТЕРФЕЙСА (перенесли из шага 4)
    const trainSect = document.getElementById('training-section');
    const mainUI = document.getElementById('main-ui');
    if (trainSect) trainSect.style.display = 'none';
    if (mainUI) mainUI.style.display = 'block';

    const statusEl = document.getElementById('timer-status');
    if (statusEl) statusEl.textContent = "В ожидании";

    // 5. ИНИЦИАЛИЗАЦИЯ ВИЗУАЛА
    updateStreak();
    dailyReset();
    updateUI(); // Показываем время на экране
    
    const savedTheme = localStorage.getItem('selectedTheme');
    if (savedTheme) setTheme(savedTheme);

    console.log("Приложение полностью готово к работе");
});

dailyReset();
updateUI();}
