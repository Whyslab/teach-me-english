// Окно «Итоги тренировки».
import { state, streakDays, answersToday, introducedToday } from './store.js';
import { selectSession } from './srs.js';
import { escapeHtml, plural } from './util.js';
import { displayWord } from './norsk.js';
import { $, openModal } from './ui.js';
import { t } from './session.js';

export function showResults() {
    const total = t.correct + t.wrong;
    const accuracy = total ? Math.round(t.correct / total * 100) : 0;
    const mins = Math.max(1, Math.round((Date.now() - t.startedAt) / 60000));
    $('results-emoji').textContent = accuracy >= 90 ? '🏆' : accuracy >= 70 ? '🎉' : accuracy >= 50 ? '💪' : '📚';
    const goal = state.settings.dailyGoal;
    const streak = streakDays();
    const today = answersToday();
    const cards = [
        [t.correct, 'Верно', 'ok'],
        [t.wrong, 'Ошибки', 'bad'],
        [`${accuracy}%`, 'Точность', accuracy >= 70 ? 'ok' : 'warn'],
        [`${mins} мин`, 'Время', ''],
        [`${Math.min(today, goal)}/${goal}`, 'Цель дня', today >= goal ? 'ok' : ''],
        [`${streak} 🔥`, plural(streak, ['день подряд', 'дня подряд', 'дней подряд']), 'streak'],
    ];
    $('results-grid').innerHTML = cards.map(([v, l, c]) =>
        `<div class="result-card ${c}"><div class="rc-value">${escapeHtml(String(v))}</div><div class="rc-label">${escapeHtml(l)}</div></div>`).join('');

    const hard = [...t.mistakes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([id, n]) => {
            const w = state.words.find(x => x.id === id);
            return w ? `<div class="results-hard-item"><span lang="nb">${escapeHtml(displayWord(w))}</span><span class="fst-trans">${escapeHtml(w.translate)}</span><span class="results-hard-cnt">${n}× ✗</span></div>` : '';
        }).join('');
    const note = $('results-note');
    note.hidden = !t.practice;
    note.textContent = t.practice
        ? 'Это была практика: расписание повторений не изменилось. Интервалы двигают «Продолжить» и «Карточки».'
        : '';

    const hardEl = $('results-hardest');
    hardEl.hidden = !hard;
    hardEl.innerHTML = hard ? `<div class="results-hard-title">Ошибки этой сессии</div>${hard}` : '';
    // После урока — «Ещё урок», если есть что повторять: подходит и на 2 минуты, и на час.
    const left = t.lesson ? selectSession(state.words, {
        newLimit: state.settings.newPerDay,
        introducedToday: introducedToday(),
        pauseNewAt: state.settings.pauseNewAt,
    }).queue.length : 0;
    $('results-more').hidden = !left;
    $('results-more').textContent = `Ещё урок · ${left}`;
    $('results-done').classList.toggle('btn-primary', !left);
    $('results-done').classList.toggle('btn-ghost', Boolean(left));
    $('results-title').textContent = t.lesson ? 'Урок пройден' : 'Итоги тренировки';
    $('results-modal').dataset.openedAt = String(Date.now());
    openModal('results-modal');
}
