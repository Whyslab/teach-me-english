// Статистика: стрик, графики боковой панели, прогноз, окна статистики и истории.
import { state, displayedStreak } from './store.js';
import { isNew, isHard } from './srs.js';
import { escapeHtml, toDayKey, DAY_MS } from './util.js';
import { displayWord } from './norsk.js';
import { $, openModal } from './ui.js';
import { findWord } from './list.js';

export function renderStreak() {
    const goal = state.settings.dailyGoal;
    const today = state.streak.todayCount || 0;
    $('streak-count').textContent = displayedStreak();
    $('daily-count').textContent = today;
    $('daily-goal').textContent = goal;
    const pct = Math.min(1, today / goal);
    const box = $('streak-container');
    box.style.setProperty('--goal-pct', `${Math.round(pct * 100)}%`);
    box.classList.toggle('goal-done', today >= goal);
}

function renderLearningCurve() {
    const el = $('learning-curve');
    if (!el) return;
    const counts = [0, 0, 0, 0, 0, 0];
    for (const w of state.words) counts[Math.min(5, Math.max(0, w.level || 0))]++;
    const max = Math.max(...counts, 1);
    el.innerHTML = counts.map((c, lvl) => `
        <div class="level-row">
            <span>Ур. ${lvl}</span>
            <div class="level-fill-wrap"><div class="level-fill" style="width:${Math.round(c / max * 100)}%"></div></div>
            <strong>${c}</strong>
        </div>`).join('');
}

function renderHeatmap() {
    const el = $('activity-heatmap');
    if (!el) return;
    const days = 84;
    const cells = [];
    let max = 0;
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * DAY_MS);
        const count = Number(state.activity[toDayKey(d)]) || 0;
        max = Math.max(max, count);
        cells.push({ count, d });
    }
    el.innerHTML = cells.map(({ count, d }) => {
        const opacity = count === 0 ? 1 : Math.max(0.2, count / max);
        const cls = count === 0 ? 'heat-cell empty' : 'heat-cell';
        return `<div class="${cls}" style="opacity:${opacity}" title="${d.toLocaleDateString('ru-RU')}: ${count}"></div>`;
    }).join('');
}

function renderWeekChart() {
    const canvas = $('weekly-progress-chart');
    const ctx = canvas?.getContext?.('2d');
    if (!ctx) return;
    const labels = [];
    const values = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(Date.now() - i * DAY_MS);
        labels.push(d.toLocaleDateString('ru-RU', { weekday: 'short' }));
        values.push(Number(state.activity[toDayKey(d)]) || 0);
    }
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--accent').trim() || '#7c6af7';
    const muted = css.getPropertyValue('--text-3').trim() || '#888';
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    const pad = { left: 16, right: 16, top: 12, bottom: 26 };
    const gw = w - pad.left - pad.right;
    const gh = h - pad.top - pad.bottom;
    const max = Math.max(...values, 1);
    const pt = (v, i) => [pad.left + gw / (values.length - 1) * i, pad.top + gh - v / max * gh];

    ctx.strokeStyle = muted;
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top + gh);
    ctx.lineTo(w - pad.right, pad.top + gh);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    values.forEach((v, i) => { const [x, y] = pt(v, i); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();

    ctx.font = '22px sans-serif';
    ctx.textAlign = 'center';
    values.forEach((v, i) => {
        const [x, y] = pt(v, i);
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = muted;
        ctx.fillText(labels[i], x, h - 4);
    });
}

function renderForecast() {
    const el = $('forecast-chart');
    if (!el) return;
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const days = [];
    for (let i = 0; i < 7; i++) {
        const from = startOfToday.getTime() + i * DAY_MS;
        const to = from + DAY_MS;
        const count = state.words.filter(w => {
            if (isNew(w)) return false;
            const r = w.nextReview || 0;
            return i === 0 ? r < to : r >= from && r < to;
        }).length;
        const d = new Date(from);
        const label = i === 0 ? 'Сег' : i === 1 ? 'Завт' : ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'][d.getDay()];
        days.push({ count, label });
    }
    const max = Math.max(...days.map(d => d.count), 1);
    el.innerHTML = days.map((d, i) => `
        <div class="forecast-col" title="${d.count}">
            <div class="forecast-val">${d.count}</div>
            <div class="forecast-bar-wrap"><div class="forecast-bar-fill${i === 0 ? ' today' : ''}" style="height:${Math.round(d.count / max * 100)}%"></div></div>
            <div class="forecast-label">${d.label}</div>
        </div>`).join('');
}

export function renderStats() {
    renderStreak();
    renderLearningCurve();
    renderHeatmap();
    renderWeekChart();
    renderForecast();
}

// ---------------------------------------------------------------------------
// Окно «Статистика»
// ---------------------------------------------------------------------------
export function showForgettingStats() {
    const now = Date.now();
    const words = state.words;
    const hard = words.filter(isHard)
        .map(w => ({ w, score: (w.forgetStep || 0) * 2 + Math.max(0, (2.5 - (w.sm2EF || 2.5)) * 5) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 20);
    const learned = words.filter(w => (w.level || 0) >= 5).length;
    const studied = words.filter(w => !isNew(w));
    const avgEF = studied.length
        ? (studied.reduce((s, w) => s + (w.sm2EF || 2.5), 0) / studied.length).toFixed(2)
        : '—';
    const dist = { today: 0, week: 0, month: 0, later: 0 };
    for (const w of studied) {
        const diff = (w.nextReview || 0) - now;
        if (diff <= 0) dist.today++;
        else if (diff <= 7 * DAY_MS) dist.week++;
        else if (diff <= 30 * DAY_MS) dist.month++;
        else dist.later++;
    }
    const nouns = words.filter(w => w.pos === 'noun');
    const withGender = nouns.filter(w => w.gender).length;
    const total = studied.length || 1;

    $('forgetting-stats-content').innerHTML = `
        <div class="fst-grid">
            <div class="fst-card"><div class="fst-val">${dist.today}</div><div class="fst-label">Повторить сегодня</div></div>
            <div class="fst-card"><div class="fst-val">${words.filter(isNew).length}</div><div class="fst-label">Новых в очереди</div></div>
            <div class="fst-card"><div class="fst-val">${learned}</div><div class="fst-label">Выучено (ур. 5)</div></div>
            <div class="fst-card"><div class="fst-val">${avgEF}</div><div class="fst-label">Средний EF (≥2.5 — хорошо)</div></div>
        </div>
        <div class="fst-section-title">Расписание повторений</div>
        <div class="fst-schedule">
            ${[['Сегодня', dist.today], ['7 дней', dist.week], ['30 дней', dist.month], ['Позже', dist.later]].map(([label, v]) => `
                <div class="fst-bar-row">
                    <div class="fst-bar-label">${label}</div>
                    <div class="fst-bar-wrap"><div class="fst-bar-fill" style="width:${Math.round(v / total * 100)}%"></div></div>
                    <div class="fst-bar-count">${v}</div>
                </div>`).join('')}
        </div>
        ${nouns.length ? `<div class="fst-section-title">Грамматика</div>
        <div class="fst-note">Существительных: ${nouns.length}, с указанным родом: ${withGender}.
        ${withGender < nouns.length ? 'Род без артикля не выучить — добавь en/ei/et через ✏️.' : ''}</div>` : ''}
        ${hard.length ? `
        <div class="fst-section-title">Трудные слова</div>
        <div class="fst-hard-list">
            ${hard.map(({ w }) => `
                <div class="fst-hard-item">
                    <div><span class="fst-word" lang="nb">${escapeHtml(displayWord(w))}</span>
                         <span class="fst-trans">${escapeHtml(w.translate)}</span></div>
                    <div class="fst-tags">
                        <span class="fst-tag">EF ${(w.sm2EF || 2.5).toFixed(1)}</span>
                        ${w.forgetStep > 0 ? `<span class="fst-tag bad">забыто ${w.forgetStep}×</span>` : ''}
                    </div>
                </div>`).join('')}
        </div>` : '<div class="fst-note center">Трудных слов нет 🎉</div>'}`;
    openModal('forgetting-stats-modal');
}

// ---------------------------------------------------------------------------
// Окно «История слова»
// ---------------------------------------------------------------------------
const Q_LABEL = { 0: '🔄 Не помню', 1: '😅 С трудом', 2: '👍 Помню', 3: '⚡ Легко' };

export function showWordHistory(id) {
    const w = findWord(id);
    if (!w) return;
    const history = w.history || [];
    // Точность — по первым ответам дня; «вспомнил после ошибки» её не завышает.
    const reviews = history.filter(h => !h.r);
    const good = reviews.filter(h => h.q >= 2).length;
    const accuracy = reviews.length ? Math.round(good / reviews.length * 100) : 0;
    const date = (ts) => ts ? new Date(ts).toLocaleDateString('ru-RU') : '—';

    $('wh-title').textContent = displayWord(w);
    $('wh-translate').textContent = w.translate;
    $('wh-content').innerHTML = `
        <div class="fst-grid three">
            <div class="fst-card"><div class="fst-val">${w.level || 0}/5</div><div class="fst-label">Уровень</div></div>
            <div class="fst-card"><div class="fst-val">${accuracy}%</div><div class="fst-label">Точность</div></div>
            <div class="fst-card"><div class="fst-val">${w.sm2Interval || 1} д</div><div class="fst-label">Интервал</div></div>
        </div>
        <div class="fst-grid">
            <div class="fst-card"><div class="fst-val small">${(w.sm2EF || 2.5).toFixed(2)}</div><div class="fst-label">EF</div></div>
            <div class="fst-card"><div class="fst-val small">${isNew(w) ? 'новое' : date(w.nextReview)}</div><div class="fst-label">След. повторение</div></div>
        </div>
        <div class="fst-section-title">Добавлено: ${date(w.addedAt)} · Ответов: ${history.length}</div>
        ${history.length ? `<div class="wh-timeline">
            ${[...history].reverse().slice(0, 15).map(h => `
                <div class="wh-item q${h.q}">
                    <span>${h.r ? '↩ Вспомнил после ошибки' : (Q_LABEL[h.q] || h.q)}</span>
                    <span class="wh-date">${date(h.ts)} · EF ${(h.ef || 2.5).toFixed(1)}</span>
                </div>`).join('')}
        </div>` : '<div class="fst-note center">Ещё нет ответов</div>'}`;
    openModal('word-history-modal');
}
