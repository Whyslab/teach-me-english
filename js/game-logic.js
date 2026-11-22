// Игры на скорость: логика без DOM — тестируется напрямую.
// Играем только уже знакомыми словами: новые открывает урок, иначе игры
// обходили бы дневной лимит новых слов. Ответы двигают расписание, как
// лёгкие задания урока: верно — sm2 easy, ошибка — «не помню».
import { shuffle } from './util.js';
import { isNew } from './srs.js';

export const GAMES = {
    pairs:  { title: 'Найди пары',       hint: 'слово ↔ перевод на время', better: 'lower' },
    blitz:  { title: 'Молния 60 с',      hint: 'сколько успеешь за минуту', better: 'higher' },
    truth:  { title: 'Правда или ложь',  hint: 'верен ли перевод — 60 с',   better: 'higher' },
    streak: { title: 'Серия без ошибок', hint: 'до первой ошибки',          better: 'higher' },
};

export const GAME_SECONDS = 60;
export const PAIRS_PER_ROUND = 5;
export const PAIRS_ROUNDS = 3;

// Слова для игр: знакомые, с переводом; разные переводы, чтобы в вариантах
// не было двух одинаковых ответов. Сначала те, что пора повторить.
export function gamePool(words, now = Date.now()) {
    const seen = new Set();
    const out = [];
    const ranked = shuffle(words.filter(w => !isNew(w) && w.original && w.translate))
        .sort((a, b) => Number(!(a.nextReview <= now)) - Number(!(b.nextReview <= now)));
    for (const w of ranked) {
        const key = w.translate.trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(w);
    }
    return out;
}

export const MIN_POOL = 4;

// Сколько раундов пар выйдет из пула: от 1 до PAIRS_ROUNDS.
export function pairsRounds(pool) {
    return Math.max(1, Math.min(PAIRS_ROUNDS, Math.floor(pool.length / PAIRS_PER_ROUND)));
}

// Раунд пар: слева норвежские, справа переводы, каждая колонка перемешана.
export function pairsRound(words) {
    return {
        left: shuffle(words.map(w => ({ id: w.id, word: w }))),
        right: shuffle(words.map(w => ({ id: w.id, word: w }))),
    };
}

// Вопрос «выбери перевод»: слово и 4 варианта. recent — id последних слов,
// чтобы одно и то же не шло подряд.
export function quizQuestion(pool, recent = [], random = Math.random) {
    const fresh = pool.filter(w => !recent.includes(w.id));
    const from = fresh.length ? fresh : pool;
    const word = from[Math.floor(random() * from.length)];
    const others = shuffle(pool.filter(w => w.id !== word.id)).slice(0, 3).map(w => w.translate);
    return { kind: 'quiz', word, options: shuffle([word.translate, ...others]) };
}

// Вопрос «правда или ложь»: слово и перевод — свой или чужой, поровну.
export function truthQuestion(pool, recent = [], random = Math.random) {
    const q = quizQuestion(pool, recent, random);
    const truth = random() < 0.5;
    const wrong = q.options.find(o => o !== q.word.translate);
    return { kind: 'truth', word: q.word, shown: truth || !wrong ? q.word.translate : wrong, truth: truth || !wrong };
}

// Новый ли рекорд. Для пар лучше меньше (время), для остальных — больше.
export function isRecord(game, value, records = {}) {
    if (!(value > 0)) return false;
    const best = records[game];
    if (!(best > 0)) return true;
    return GAMES[game].better === 'lower' ? value < best : value > best;
}

// Время для пар: 47,3 с → «47,3 с».
export function formatGameValue(game, value) {
    if (game !== 'pairs') return String(Math.max(0, Number(value) || 0));
    if (!(value > 0)) return '—';
    return `${(value / 1000).toFixed(1).replace('.', ',')} с`;
}

// Двигает ли ответ в игре расписание. Ошибка — всегда; верный ответ — только
// если слово пора повторять: sm2 не знает, сколько прошло, и слово с интервалом
// 30 дней, угаданное на 3-й день, ушло бы на 30·EF без заслуги.
export function schedulesGameAnswer(word, ok, now = Date.now()) {
    return !ok || !word.nextReview || word.nextReview <= now;
}
