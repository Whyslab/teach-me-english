// Тесты логики фронтенда. Модули в js/ — это ES-модули без DOM (кроме
// интерфейсных), поэтому чистые функции импортируются напрямую.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const load = (name) => import(path.join(ROOT, 'js', name));
const DAY = 24 * 60 * 60 * 1000;
// Без разброса интервала — чтобы тесты были детерминированными.
const NO_FUZZ = () => 0.5;

// ---------------------------------------------------------------------------
// util.js
// ---------------------------------------------------------------------------
test('escapeHtml neutralises a script tag and survives null', async () => {
    const { escapeHtml } = await load('util.js');
    assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
    assert.equal(escapeHtml('&lt;'), '&amp;lt;');
    assert.equal(escapeHtml(null), '');
});

test('escapeAttr closes the quote breakout', async () => {
    const { escapeAttr } = await load('util.js');
    assert.equal(escapeAttr('" onerror="x'), '&quot; onerror=&quot;x');
    assert.equal(escapeAttr("'"), '&#39;');
});

test('highlightMatch escapes both the text and the match', async () => {
    const { highlightMatch } = await load('util.js');
    assert.equal(highlightMatch('<b>hus</b>', 'hus'), '&lt;b&gt;<mark>hus</mark>&lt;/b&gt;');
    assert.equal(highlightMatch('a.b', '.'), 'a<mark>.</mark>b', 'regex specials are literal');
});

test('plural picks the Russian form', async () => {
    const { plural } = await load('util.js');
    const f = ['слово', 'слова', 'слов'];
    assert.deepStrictEqual([1, 2, 5, 11, 21, 22, 25, 111].map(n => plural(n, f)),
        ['слово', 'слова', 'слов', 'слов', 'слово', 'слова', 'слов', 'слов']);
});

// ---------------------------------------------------------------------------
// norsk.js
// ---------------------------------------------------------------------------
test('checkAnswer ignores case, spaces, ё/е and trailing punctuation', async () => {
    const { checkAnswer } = await load('norsk.js');
    assert.equal(checkAnswer('  Дом. ', 'дом'), 'correct');
    assert.equal(checkAnswer('еж', 'ёж'), 'correct');
});

test('checkAnswer accepts any of several translations', async () => {
    const { checkAnswer } = await load('norsk.js');
    assert.equal(checkAnswer('здание', 'дом, здание'), 'correct');
    assert.equal(checkAnswer('жильё', 'дом; жильё'), 'correct');
    assert.equal(checkAnswer('кот', 'дом, здание'), 'wrong');
    assert.equal(checkAnswer('', 'дом'), 'wrong');
});

test('checkAnswer: the Norwegian article and infinitive marker are optional', async () => {
    const { checkAnswer } = await load('norsk.js');
    assert.equal(checkAnswer('hus', 'et hus', { norwegian: true }), 'correct');
    assert.equal(checkAnswer('et hus', 'hus', { norwegian: true }), 'correct');
    assert.equal(checkAnswer('reise', 'å reise', { norwegian: true }), 'correct');
});

test('checkAnswer flags a missing æ ø å as "letters", not as correct', async () => {
    const { checkAnswer } = await load('norsk.js');
    assert.equal(checkAnswer('sko', 'skø', { norwegian: true }), 'letters');
    assert.equal(checkAnswer('kjokken', 'kjøkken', { norwegian: true }), 'letters');
    assert.equal(checkAnswer('gaa', 'gå', { norwegian: true }), 'wrong');
    assert.equal(checkAnswer('laerer', 'lærer', { norwegian: true }), 'letters');
});

test('checkGender accepts "en" for a feminine noun as an alternative', async () => {
    const { checkGender } = await load('norsk.js');
    assert.equal(checkGender('f', 'f'), 'correct');
    assert.equal(checkGender('m', 'f'), 'also');
    assert.equal(checkGender('n', 'f'), 'wrong');
    assert.equal(checkGender('f', 'm'), 'wrong');
});

test('guessNounForms follows the regular patterns', async () => {
    const { guessNounForms } = await load('norsk.js');
    assert.deepStrictEqual(guessNounForms('gutt', 'm'), { defSg: 'gutten', indefPl: 'gutter', defPl: 'guttene' });
    assert.deepStrictEqual(guessNounForms('jente', 'f'), { defSg: 'jenta', indefPl: 'jenter', defPl: 'jentene' });
    assert.deepStrictEqual(guessNounForms('eple', 'n'), { defSg: 'eplet', indefPl: 'epler', defPl: 'eplene' });
    // односложные среднего рода не меняются во мн. ч.
    assert.deepStrictEqual(guessNounForms('et hus', 'n'), { defSg: 'huset', indefPl: 'hus', defPl: 'husene' });
    assert.equal(guessNounForms('hus', ''), null, 'no gender — no guess');
});

test('guessAdjForms covers the regular patterns and the common irregulars', async () => {
    const { guessAdjForms } = await load('norsk.js');
    const cases = {
        stor: 'stort,store', gammel: 'gammelt,gamle', sulten: 'sultent,sultne', vakker: 'vakkert,vakre',
        ny: 'nytt,nye', blå: 'blått,blå', grønn: 'grønt,grønne', hvit: 'hvitt,hvite', svart: 'svart,svarte',
        viktig: 'viktig,viktige', praktisk: 'praktisk,praktiske', norsk: 'norsk,norske', frisk: 'friskt,friske',
        moderne: 'moderne,moderne', liten: 'lite,små', glad: 'glad,glade',
    };
    for (const [w, expected] of Object.entries(cases)) {
        const g = guessAdjForms(w);
        assert.equal(`${g.neuter},${g.plural}`, expected, w);
    }
});

test('there is no form guessing for verbs (it was wrong more often than right)', async () => {
    const norsk = await load('norsk.js');
    assert.equal(norsk.guessVerbForms, undefined);
});

test('displayWord adds the article for nouns only', async () => {
    const { displayWord } = await load('norsk.js');
    assert.equal(displayWord({ original: 'hus', pos: 'noun', gender: 'n' }), 'et hus');
    assert.equal(displayWord({ original: 'jente', pos: 'noun', gender: 'f' }), 'ei jente');
    assert.equal(displayWord({ original: 'å reise', pos: 'verb' }), 'å reise');
    assert.equal(displayWord({ original: 'hus', pos: 'noun', gender: '' }), 'hus');
});

test('lookupUrls strip the particle and encode the word', async () => {
    const { lookupUrls } = await load('norsk.js');
    const u = lookupUrls('å gå');
    assert.equal(u.forvo, 'https://forvo.com/word/g%C3%A5/#no');
    assert.equal(u.ordbok, 'https://ordbokene.no/nob/bm/g%C3%A5');
});

// ---------------------------------------------------------------------------
// srs.js
// ---------------------------------------------------------------------------
test('sm2: "again" schedules in 10 minutes and resets repetitions', async () => {
    const { sm2, AGAIN_DELAY_MS } = await load('srs.js');
    const w = { sm2Reps: 3, sm2Interval: 15, sm2EF: 2.5, level: 4 };
    sm2(w, 0, 1000);
    assert.equal(w.sm2Reps, 0);
    assert.equal(w.nextReview, 1000 + AGAIN_DELAY_MS);
    assert.equal(w.level, 3);
    assert.equal(w.history.length, 1);
});

test('sm2: "again" lowers the ease factor, but never below 1.3', async () => {
    const { sm2 } = await load('srs.js');
    const w = { sm2EF: 2.5, sm2Reps: 1, history: [{ ts: 0, q: 2 }] };
    sm2(w, 0, DAY);
    assert.equal(w.sm2EF, 2.3);
    for (let i = 2; i < 12; i++) sm2(w, 0, i * DAY);
    assert.equal(w.sm2EF, 1.3);
});

test('sm2: four "good" answers in a row make a word learned (level 5)', async () => {
    // Это же написано в окне «Как это работает»: 1 → 6 → 15 → 38 дней.
    const { sm2 } = await load('srs.js');
    const w = {};
    const path = [];
    for (let i = 0; i < 4; i++) { sm2(w, 2, i * DAY, NO_FUZZ); path.push([w.sm2Interval, w.level]); }
    assert.deepStrictEqual(path, [[1, 1], [6, 3], [15, 4], [38, 5]]);
});

// Повтор в тот же день — доучивание, расписание он не двигает.
// Раньше «не помню», а через 10 секунд «помню» отправляли слово сразу на 6 дней.
test('sm2: only the first answer of the day moves the schedule', async () => {
    const { sm2 } = await load('srs.js');
    const w = {};
    sm2(w, 0, 1000);                     // новое слово — не помню
    sm2(w, 0, 1000 + 60_000);            // и снова не помню
    assert.equal(w.sm2EF, 2.5, 'a new word is not penalised, repeats are not counted');
    sm2(w, 2, 1000 + 120_000);           // вспомнил в той же тренировке
    assert.equal(w.sm2Interval, 1);
    assert.equal(w.sm2Reps, 1);
    assert.equal(w.nextReview, 1000 + 120_000 + DAY, 'comes back tomorrow, not in 6 days');
    assert.deepStrictEqual(w.history.map(h => [h.q, h.r || 0]), [[0, 0], [2, 1]],
        'only the relearning answer is kept, marked as a repeat');
    sm2(w, 2, 1000 + 180_000);
    assert.equal(w.history.length, 2, 'later repeats are not recorded');
    sm2(w, 2, 1000 + DAY + 1000, NO_FUZZ); // завтра помню
    assert.equal(w.sm2Interval, 6);
});

test('sm2: a forgotten word that was known loses ease only once a day', async () => {
    const { sm2 } = await load('srs.js');
    const w = { sm2EF: 2.5, sm2Reps: 3, sm2Interval: 15, level: 4, history: [{ ts: 0, q: 2 }] };
    for (let i = 0; i < 6; i++) sm2(w, 0, 20 * DAY + i * 30_000);
    assert.equal(w.sm2EF, 2.3);
    assert.equal(w.level, 3);
});

test('fuzzInterval spreads long intervals by about 10% and keeps short ones', async () => {
    const { fuzzInterval } = await load('srs.js');
    assert.equal(fuzzInterval(1, () => 0), 1);
    assert.equal(fuzzInterval(2, () => 0.99), 2);
    assert.equal(fuzzInterval(6, () => 0), 5);
    assert.equal(fuzzInterval(6, () => 0.999), 7);
    assert.equal(fuzzInterval(30, () => 0), 27);
    assert.equal(fuzzInterval(30, () => 0.5), 30);
});

test('replayHistory rebuilds the schedule with one answer per day', async () => {
    const { replayHistory } = await load('srs.js');
    // Как «fordi» в настоящей базе: шесть «сложно» за две минуты, потом «хорошо».
    const t0 = new Date(2026, 9, 3, 12).getTime();
    const history = [1, 1, 1, 1, 1, 1, 2].map((q, i) => ({ ts: t0 + i * 20_000, q, ef: 2 }));
    const w = replayHistory({ id: 1, original: 'fordi', translate: 'потому что', history, sm2Reps: 7, sm2EF: 1.66 },
        (q) => (q === 1 ? 0 : q));
    assert.equal(w.sm2Reps, 1);
    assert.equal(w.sm2Interval, 1);
    assert.equal(w.sm2EF, 2.5);
    assert.equal(w.history.length, 2);
    assert.equal(w.nextReview, t0 + 6 * 20_000 + DAY);
    assert.equal(w.original, 'fordi', 'other fields are kept');
    // Пересчёт пересчитанного ничего не меняет — история сохраняет всё нужное.
    const again = replayHistory(w);
    for (const k of ['level', 'nextReview', 'sm2EF', 'sm2Interval', 'sm2Reps', 'forgetStep']) {
        assert.equal(again[k], w[k], k);
    }
    assert.deepStrictEqual(again.history, w.history);
});

test('a word relearned today is still hard until it is remembered on another day', async () => {
    const { sm2, isHard } = await load('srs.js');
    const w = { sm2EF: 2.5, sm2Reps: 3, sm2Interval: 15, history: [{ ts: 0, q: 2 }] };
    sm2(w, 0, 20 * DAY);
    sm2(w, 2, 20 * DAY + 60_000);
    assert.equal(isHard(w), true);
    sm2(w, 2, 21 * DAY, NO_FUZZ);
    assert.equal(isHard(w), w.sm2EF < 2.2);
});

test('streakDays counts days in a row with the goal met, today only once met', async () => {
    const { streakDays } = await load('store.js');
    const { toDayKey } = await load('util.js');
    const now = new Date(2026, 9, 7, 9).getTime();
    const day = (n) => toDayKey(now - n * DAY);
    assert.equal(streakDays({ [day(1)]: 10, [day(2)]: 12, [day(3)]: 3 }, 10, now), 2, 'today not met yet — the streak is not broken');
    assert.equal(streakDays({ [day(0)]: 10, [day(1)]: 10, [day(2)]: 12 }, 10, now), 3);
    assert.equal(streakDays({ [day(0)]: 15, [day(2)]: 12 }, 10, now), 1, 'a missed day breaks it');
    assert.equal(streakDays({}, 10, now), 0);
});

test('introducedToday counts words whose first answer is today', async () => {
    const { introducedToday } = await load('store.js');
    const now = new Date(2026, 9, 7, 20).getTime();
    const words = [
        { history: [{ ts: now - 60_000, q: 0 }, { ts: now - 30_000, q: 2, r: 1 }] },
        { history: [{ ts: now - 3 * DAY, q: 2 }, { ts: now - 1000, q: 2 }] },
        { history: [] },
    ];
    assert.equal(introducedToday(words, now), 1);
});

test('practiceQueue prefers due words, then hard ones, and never exceeds the size', async () => {
    const { practiceQueue } = await load('srs.js');
    const now = 1000;
    const studied = (id, due, ef) => ({ id, history: [{ q: 2 }], sm2Reps: 1, nextReview: due ? 0 : now + 1, sm2EF: ef });
    const words = [studied(1, false, 2.5), studied(2, true, 2.5), studied(3, false, 1.5), studied(4, true, 1.9),
                   { id: 5, history: [], sm2Reps: 0 }];
    const q = practiceQueue(words, { now, size: 3 });
    assert.deepStrictEqual(q.map(w => w.id), [4, 2, 3], 'due first (harder first), then the hardest of the rest');
    assert.ok(!practiceQueue(words, { now }).some(w => w.id === 5), 'new words are skipped while enough are studied');
    assert.deepStrictEqual(practiceQueue(words, { now, only: w => w.id === 5 }).map(w => w.id), [5]);
});

test('sm2: intervals grow 1 → 6 → ×EF on "good"', async () => {
    const { sm2 } = await load('srs.js');
    const w = {};
    sm2(w, 2, 0, NO_FUZZ); assert.equal(w.sm2Interval, 1);
    sm2(w, 2, DAY, NO_FUZZ); assert.equal(w.sm2Interval, 6);
    sm2(w, 2, 2 * DAY, NO_FUZZ); assert.equal(w.sm2Interval, Math.round(6 * w.sm2EF));
});

test('sm2 keeps at most 30 history entries', async () => {
    const { sm2 } = await load('srs.js');
    const w = {};
    for (let i = 0; i < 40; i++) sm2(w, 2, i * DAY);
    assert.equal(w.history.length, 30);
});

test('normalizeWord drops legacy photo/video fields and invalid grammar', async () => {
    const { normalizeWord } = await load('srs.js');
    const w = normalizeWord({
        id: 1, original: 'hus', translate: 'дом', imageUrl: 'data:image/png;base64,AAAA', videoId: 'x',
        pos: 'noun', gender: 'x', forms: { defSg: 'huset', present: 'nope' },
    });
    assert.ok(!('imageUrl' in w) && !('videoId' in w));
    assert.equal(w.gender, '');
    assert.deepStrictEqual(w.forms, { defSg: 'huset' });
    assert.equal(normalizeWord({ original: 'a', translate: 'b', pos: 'verb', gender: 'n' }).gender, '');
});

test('selectSession caps new words per day but never caps reviews', async () => {
    const { selectSession } = await load('srs.js');
    const now = 1_000_000;
    const reviews = Array.from({ length: 30 }, (_, i) => ({ id: i, history: [{ q: 2 }], sm2Reps: 1, nextReview: now - 1 }));
    const future = { id: 99, history: [{ q: 2 }], sm2Reps: 1, nextReview: now + 1 };
    const fresh = Array.from({ length: 40 }, (_, i) => ({ id: 100 + i, history: [], sm2Reps: 0, nextReview: 0, addedAt: i }));
    const s = selectSession([...reviews, future, ...fresh], { now, newLimit: 15, introducedToday: 5 });
    assert.equal(s.reviews.length, 30);
    assert.equal(s.fresh.length, 10, '15 per day minus 5 already introduced');
    assert.deepStrictEqual(s.fresh.map(w => w.id), fresh.slice(0, 10).map(w => w.id), 'new words in deck order');
    assert.equal(s.queue.length, 40);
    const m = selectSession([...reviews, ...fresh], { now, newLimit: 15, introducedToday: 15, ignoreLimit: true });
    assert.equal(m.fresh.length, 40, 'marathon ignores the limit');
});

test('selectSession pauses new words while the review backlog is large', async () => {
    const { selectSession } = await load('srs.js');
    const now = 1_000_000;
    const reviews = Array.from({ length: 30 }, (_, i) => ({ id: i, history: [{ q: 2 }], sm2Reps: 1, nextReview: now - 1 }));
    const fresh = Array.from({ length: 5 }, (_, i) => ({ id: 100 + i, history: [], sm2Reps: 0, nextReview: 0, addedAt: i }));
    const words = [...reviews, ...fresh];
    const s = selectSession(words, { now, newLimit: 15, pauseNewAt: 30 });
    assert.equal(s.paused, true);
    assert.equal(s.fresh.length, 0);
    assert.equal(s.reviews.length, 30, 'reviews are never cut');
    assert.equal(selectSession(words, { now, newLimit: 15, pauseNewAt: 31 }).fresh.length, 5, 'below the threshold');
    assert.equal(selectSession(words, { now, newLimit: 15, pauseNewAt: 0 }).fresh.length, 5, '0 turns the pause off');
    assert.equal(selectSession(words, { now, newLimit: 15, pauseNewAt: 30, ignoreLimit: true }).fresh.length, 5, 'the marathon ignores it');
});

test('orderTokens strips punctuation and hides the capital of the first word', async () => {
    const { orderTokens, sameOrder } = await load('norsk.js');
    assert.deepStrictEqual(orderTokens('I dag går jeg på jobb.'), ['i', 'dag', 'går', 'jeg', 'på', 'jobb']);
    assert.deepStrictEqual(orderTokens('«Hva heter du?»'), ['hva', 'heter', 'du']);
    assert.deepStrictEqual(orderTokens('NAV, hjelper deg!'), ['NAV', 'hjelper', 'deg'], 'an abbreviation keeps its capitals');
    assert.ok(sameOrder(['Jeg', 'bor', 'her'], ['jeg', 'bor', 'her']));
    assert.ok(!sameOrder(['bor', 'jeg', 'her'], ['jeg', 'bor', 'her']));
    assert.ok(!sameOrder(['jeg', 'bor'], ['jeg', 'bor', 'her']));
});

// ---------------------------------------------------------------------------
// sync.js
// ---------------------------------------------------------------------------
test('computeChanges finds new, changed and deleted words', async () => {
    const { computeChanges, fingerprint } = await load('sync.js');
    const a = { id: 1, original: 'hus', level: 0 };
    const b = { id: 2, original: 'bok', level: 0 };
    const synced = new Map([[1, fingerprint(a)], [2, fingerprint(b)], [3, fingerprint({ id: 3 })]]);
    const changedB = { ...b, level: 2 };
    const c = { id: 4, original: 'katt' };
    const ch = computeChanges([a, changedB, c], synced);
    assert.deepStrictEqual(ch.upserts.map(w => w.id), [2, 4]);
    assert.deepStrictEqual(ch.deletes, [3]);
});

test('applyConfirmed keeps a word dirty if it changed while the request was in flight', async () => {
    const { computeChanges, applyConfirmed, snapshotFor, isEmpty } = await load('sync.js');
    const w = { id: 1, level: 0 };
    const synced = new Map();
    const sent = snapshotFor(computeChanges([w], synced));
    w.level = 1;                       // ответ, пока запрос в пути
    applyConfirmed(synced, sent);
    assert.equal(isEmpty(computeChanges([w], synced)), false, 'the newer version must still be sent');
    applyConfirmed(synced, snapshotFor(computeChanges([w], synced)));
    assert.equal(isEmpty(computeChanges([w], synced)), true);
});

test('one answer produces a payload far below the sendBeacon limit', async () => {
    const { computeChanges, fingerprint, BEACON_LIMIT } = await load('sync.js');
    const { parseImport } = await load('format.js');
    const { normalizeWord, sm2 } = await load('srs.js');
    const { words } = parseImport(fs.readFileSync(path.join(ROOT, 'decks', 'a1.txt'), 'utf8'));
    const deck = words.map((w, i) => normalizeWord({ ...w, id: i + 1 }));
    for (const w of deck) for (let k = 0; k < 30; k++) sm2(w, 2, k * DAY);
    const synced = new Map(deck.map(w => [w.id, fingerprint(w)]));
    assert.ok(JSON.stringify(deck).length > BEACON_LIMIT, 'the whole deck does not fit — that was the bug');
    sm2(deck[0], 3, 31 * DAY);
    const body = JSON.stringify(computeChanges(deck, synced));
    assert.ok(body.length < 3000, `one answer is ${body.length} bytes`);
});

// ---------------------------------------------------------------------------
// format.js
// ---------------------------------------------------------------------------
test('parseImportLine reads gender and forms', async () => {
    const { parseImportLine } = await load('format.js');
    assert.deepStrictEqual(parseImportLine('hus|дом|||A1|et|huset,hus,husene'), {
        original: 'hus', translate: 'дом', example: '', exampleTranslate: '', tags: ['A1'],
        pos: 'noun', gender: 'n', forms: { defSg: 'huset', indefPl: 'hus', defPl: 'husene' },
    });
    const v = parseImportLine('å reise|путешествовать||||v|reiser,reiste,har reist');
    assert.equal(v.pos, 'verb');
    assert.deepStrictEqual(v.forms, { present: 'reiser', past: 'reiste', perfect: 'har reist' });
});

test('parseImportLine reads adjective forms', async () => {
    const { parseImportLine, toTxtLine } = await load('format.js');
    const w = parseImportLine('stor|большой|||adj|a|stort,store');
    assert.equal(w.pos, 'adj');
    assert.deepStrictEqual(w.forms, { neuter: 'stort', plural: 'store' });
    assert.equal(toTxtLine(w), 'stor|большой|||adj|a|stort,store');
});

test('parseImportLine infers the gender from a leading article', async () => {
    const { parseImportLine } = await load('format.js');
    const w = parseImportLine('ei jente|девочка');
    assert.equal(w.original, 'jente');
    assert.equal(w.gender, 'f');
    assert.equal(parseImportLine('å bo|жить').pos, 'verb');
    assert.equal(parseImportLine('bare one field'), null);
});

test('parseImport skips duplicates but keeps homonyms of different kinds', async () => {
    const { parseImport } = await load('format.js');
    const { words, duplicates } = parseImport('tre|три\ntre|дерево|||x|et\nTRE|три\n# comment\n\nhus|дом', [{ original: 'hus', pos: '' }]);
    assert.deepStrictEqual(words.map(w => w.translate), ['три', 'дерево']);
    assert.deepStrictEqual(duplicates, ['TRE', 'hus']);
});

test('toTxtLine round-trips through parseImportLine', async () => {
    const { toTxtLine, parseImportLine } = await load('format.js');
    const w = { original: 'bok', translate: 'книга', example: 'Boka er fin.', exampleTranslate: 'Книга хорошая.',
                tags: ['A1', 'skole'], pos: 'noun', gender: 'f', forms: { defSg: 'boka', indefPl: 'bøker', defPl: 'bøkene' } };
    assert.equal(toTxtLine(w), 'bok|книга|Boka er fin.|Книга хорошая.|A1,skole|ei|boka,bøker,bøkene');
    assert.deepStrictEqual(parseImportLine(toTxtLine(w)), w);
    assert.equal(toTxtLine({ original: 'ja', translate: 'да', tags: [] }), 'ja|да');
    assert.equal(toTxtLine({ original: 'a|b', translate: 'x\ny', tags: [] }), 'a b|x y', 'separators in data are neutralised');
});

test('toAnki escapes HTML and adds the article', async () => {
    const { toAnki } = await load('format.js');
    const line = toAnki([{ original: 'hus', translate: '<b>дом</b>', tags: [], pos: 'noun', gender: 'n', forms: {} }]);
    assert.equal(line, 'et hus\t&lt;b&gt;дом&lt;/b&gt;');
});

for (const [deck, min] of [['a1', 250], ['a2', 300]]) {
    test(`the bundled ${deck.toUpperCase()} deck parses cleanly, with grammar on every noun, verb and adjective`, async () => {
        const { parseImport } = await load('format.js');
        const text = fs.readFileSync(path.join(ROOT, 'decks', `${deck}.txt`), 'utf8');
        const { words, duplicates } = parseImport(text);
        assert.deepStrictEqual(duplicates, []);
        assert.ok(words.length >= min, `only ${words.length} words`);
        for (const w of words) {
            assert.ok(w.example, `${w.original}: no example`);
            if (w.pos === 'noun') {
                assert.ok(w.gender, `${w.original}: noun without gender`);
                assert.ok(w.forms.defSg, `${w.original}: noun without the definite form`);
            }
            if (w.pos === 'verb') assert.equal(Object.keys(w.forms).length, 3, `${w.original}: verb needs 3 forms`);
            if (w.pos === 'adj') assert.equal(Object.keys(w.forms).length, 2, `${w.original}: adjective needs 2 forms`);
        }
    });
}

test('the A2 deck does not repeat A1 words', async () => {
    const { parseImport } = await load('format.js');
    const read = (d) => fs.readFileSync(path.join(ROOT, 'decks', `${d}.txt`), 'utf8');
    const a1 = parseImport(read('a1')).words;
    const { duplicates } = parseImport(read('a2'), a1);
    assert.deepStrictEqual(duplicates, []);
});

test('enrichFromDeck fills missing grammar without touching progress', async () => {
    const { enrichFromDeck, parseImport } = await load('format.js');
    const deck = parseImport('stor|большой|et stort hus|большой дом|adj|a|stort,store\n' +
        'hus|дом|||x|et|huset,hus,husene\nnorsk|норвежский|||x|a|norsk,norske').words;
    const stor = { original: 'stor', translate: 'большой', pos: '', gender: '', forms: {}, example: '', level: 4, sm2Reps: 5 };
    const hus = { original: 'hus', translate: 'дом', pos: 'noun', gender: 'n', forms: { defSg: 'huset' }, example: 'Mitt hus.' };
    const norsk = { original: 'norsk', translate: 'норвежский', pos: 'adj', gender: '', forms: { neuter: 'norsk' }, example: 'x' };
    const updates = enrichFromDeck([stor, hus, norsk], deck);
    assert.equal(updates.length, 1, 'words with their own forms and examples stay as they are');
    const [w, patch] = updates[0];
    assert.equal(w, stor);
    assert.deepStrictEqual(patch, { pos: 'adj', forms: { neuter: 'stort', plural: 'store' },
        example: 'et stort hus', exampleTranslate: 'большой дом' });
    assert.ok(!('level' in patch) && !('sm2Reps' in patch));
});

test('enrichFromDeck resolves homonyms by translation and skips ambiguous ones', async () => {
    const { enrichFromDeck, parseImport } = await load('format.js');
    const deck = parseImport('tre|три|Jeg har tre katter.|У меня три кошки.|x\ntre|дерево|Et høyt tre.|Высокое дерево.|x|et|treet,trær,trærne').words;
    const tree = { original: 'tre', translate: 'дерево', pos: '', gender: '', forms: {}, example: '' };
    const other = { original: 'tre', translate: 'что-то ещё', pos: '', gender: '', forms: {}, example: '' };
    const updates = enrichFromDeck([tree, other], deck);
    assert.equal(updates.length, 1);
    assert.equal(updates[0][0], tree);
    assert.equal(updates[0][1].pos, 'noun');
    assert.equal(updates[0][1].gender, 'n');
    assert.equal(updates[0][1].forms.indefPl, 'trær');
});

// ---------------------------------------------------------------------------
// Статические проверки разметки
// ---------------------------------------------------------------------------
test('every data-action in the markup has a handler', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const jsFiles = fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js'));
    const js = jsFiles.map(f => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')).join('\n');
    const used = new Set([...(html + js).matchAll(/data-action="([a-z0-9-]+)"/g)].map(m => m[1]));
    const missing = [...used].filter(a => !new RegExp(`['"]${a}['"]\\s*(?:\\(|:)`).test(js));
    assert.deepStrictEqual(missing, []);
});

test('index.html has no inline handlers or inline scripts', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /\son[a-z]+="/i, 'inline on*= handler');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'inline <script>');
});

test('every element id the modules look up exists in the markup', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
    const generated = /^(add|edit)-/; // поля формы слова создаются из js/wordform.js
    const skip = new Set(['toast-container']);
    const missing = [];
    for (const f of fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
        for (const [, id] of src.matchAll(/\$\('([a-z0-9-]+)'\)/g)) {
            if (!ids.has(id) && !generated.test(id) && !skip.has(id)) missing.push(`${f}: ${id}`);
        }
    }
    assert.deepStrictEqual(missing, []);
});

test('speech is Norwegian and the removed features stay removed', () => {
    const js = fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js'))
        .map(f => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')).join('\n');
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.match(js, /SPEECH_LANG\s*=\s*'nb-NO'/);
    for (const needle of ['en-US', 'imageUrl =', 'openClipModal', 'youglish', 'launchConfetti', 'ACHIEVEMENTS', 'XP_PER', '/api/timer']) {
        assert.ok(!js.includes(needle), `js mentions ${needle}`);
        assert.ok(!html.includes(needle), `index.html mentions ${needle}`);
    }
});

// ---------------------------------------------------------------------------
// store.js: обновление при возврате на вкладку
// ---------------------------------------------------------------------------
// Приложение живое, пока идёт запрос: ответ или правка в это время не должны
// затереться серверной копией.
test('refreshFromServer keeps local changes made while the request was in flight', async () => {
    const mem = new Map();
    globalThis.localStorage = {
        getItem: (k) => (mem.has(k) ? mem.get(k) : null),
        setItem: (k, v) => mem.set(k, String(v)),
        removeItem: (k) => mem.delete(k),
    };
    let release;
    let serverWords = [{ id: 1, original: 'hus', translate: 'дом (с сервера)' }];
    globalThis.fetch = async (url) => {
        const json = (body) => ({ ok: true, json: async () => body });
        if (url === '/api/words') {
            await new Promise((r) => { release = r; });
            return json(serverWords);
        }
        if (url === '/api/state') return json({ activity: {}, activityEpoch: 0, settings: null });
        return json({ status: 'success' });
    };
    const store = await load('store.js');
    const { state } = store;
    state.words = [{ id: 1, original: 'hus', translate: 'дом' }];
    state.loaded = true;
    await store.syncNow();

    // 1. Пока GET в пути, слово правят.
    const p1 = store.refreshFromServer();
    await new Promise((r) => setTimeout(r, 10));
    state.words[0].translate = 'дом (правка)';
    store.saveWords();
    release();
    assert.equal(await p1, false);
    assert.equal(state.words[0].translate, 'дом (правка)', 'the local edit survives');
    await store.syncNow();

    // 2. Пока GET в пути, началась тренировка.
    const p2 = store.refreshFromServer(() => true);
    await new Promise((r) => setTimeout(r, 10));
    release();
    assert.equal(await p2, false);
    assert.equal(state.words[0].translate, 'дом (правка)');

    // 3. Ничего не менялось — берётся серверная копия.
    serverWords = [{ id: 1, original: 'hus', translate: 'дом (с сервера)' }];
    const p3 = store.refreshFromServer();
    await new Promise((r) => setTimeout(r, 10));
    release();
    assert.equal(await p3, true);
    assert.equal(state.words[0].translate, 'дом (с сервера)');
    delete globalThis.fetch;
    delete globalThis.localStorage;
});

// ---------------------------------------------------------------------------
// Урок: лёгкие задания в SM-2 и сборка урока (lesson.js)
// ---------------------------------------------------------------------------
const fresh = (id, extra = {}) => ({ id, original: `ord${id}`, translate: `слово${id}`, level: 0, nextReview: 0,
    sm2EF: 2.5, sm2Interval: 1, sm2Reps: 0, history: [], addedAt: id, ...extra });

test('an easy answer moves the word half as far and keeps EF', async () => {
    const { sm2 } = await load('srs.js');
    const easy = fresh(1), normal = fresh(2);
    sm2(easy, 2, 0, NO_FUZZ, { easy: true });
    sm2(normal, 2, 0, NO_FUZZ);
    assert.equal(easy.sm2EF, 2.5, 'EF is not touched');
    assert.equal(easy.history[0].e, 1, 'marked as easy in the history');
    sm2(easy, 2, DAY, NO_FUZZ, { easy: true });
    sm2(normal, 2, DAY, NO_FUZZ);
    assert.equal(normal.sm2Interval, 6);
    assert.equal(easy.sm2Interval, 3, 'half of 6');
    assert.equal(easy.sm2EF, 2.5);
});

test('a wrong easy answer is a plain "do not remember"', async () => {
    const { sm2 } = await load('srs.js');
    const a = fresh(1), b = fresh(2);
    for (const w of [a, b]) { sm2(w, 2, 0, NO_FUZZ); sm2(w, 2, DAY, NO_FUZZ); }
    sm2(a, 0, 8 * DAY, NO_FUZZ, { easy: true });
    sm2(b, 0, 8 * DAY, NO_FUZZ);
    const { history: ha, ...ra } = a; const { history: hb, ...rb } = b;
    assert.deepStrictEqual({ ...ra, id: 0, original: '', translate: '', addedAt: 0 }, { ...rb, id: 0, original: '', translate: '', addedAt: 0 });
    assert.equal(ha.at(-1).e, undefined);
});

test('replaying the history keeps easy answers easy', async () => {
    const { sm2, replayHistory } = await load('srs.js');
    const w = fresh(1);
    sm2(w, 2, 0, NO_FUZZ, { easy: true });
    sm2(w, 2, DAY, NO_FUZZ, { easy: true });
    sm2(w, 2, 4 * DAY, NO_FUZZ);
    const r = replayHistory(w);
    assert.equal(r.sm2Interval, w.sm2Interval);
    assert.equal(r.sm2EF, w.sm2EF);
    assert.equal(r.nextReview, w.nextReview);
});

test('streak counts the correct answers at the end of the history', async () => {
    const { streak } = await load('lesson.js');
    assert.equal(streak(fresh(1)), 0);
    assert.equal(streak(fresh(1, { history: [{ q: 2 }, { q: 0 }, { q: 2 }, { q: 1 }] })), 2);
    assert.equal(streak(fresh(1, { history: [{ q: 2 }, { q: 0 }] })), 0);
});

test('the task gets harder as the streak grows', async () => {
    const { primaryMode } = await load('lesson.js');
    const h = (n) => fresh(1, { sm2Reps: n, history: Array.from({ length: n }, () => ({ q: 2 })) });
    assert.equal(primaryMode(fresh(1)), 'quiz');
    assert.equal(primaryMode(h(1)), 'quiz');
    assert.equal(primaryMode(fresh(1), { quizOk: false }), 'cards', 'without 4 translations — a card');
    for (let i = 0; i < 10; i++) {
        assert.ok(['cards', 'write-no-ru'].includes(primaryMode(h(2))));
        assert.ok(['write-ru-no', 'dictation'].includes(primaryMode(h(3))));
    }
});

test('a lesson introduces a new word and asks it one task later', async () => {
    const { buildLesson } = await load('lesson.js');
    const studied = (id) => fresh(id, { sm2Reps: 2, history: [{ q: 2 }, { q: 2 }] });
    const all = [studied(1), studied(2), studied(3), fresh(4), fresh(5)];
    const { items, words } = buildLesson(all, all);
    assert.equal(words, 5);
    for (const id of [4, 5]) {
        const intro = items.findIndex(x => x.mode === 'intro' && x.word.id === id);
        const ask = items.findIndex(x => x.primary && x.word.id === id);
        assert.ok(intro >= 0 && ask > intro, `word ${id}: intro before the task`);
        assert.equal(items[ask].mode, 'quiz');
    }
    assert.equal(items.filter(x => x.primary).length, 5, 'one scheduled task per word');
    assert.ok(!items.some(x => x.mode === 'intro' && x.primary), 'an intro never moves the schedule');
});

test('a lesson stays within its budget and never starts empty', async () => {
    const { buildLesson, LESSON_BUDGET } = await load('lesson.js');
    const many = Array.from({ length: 40 }, (_, i) => fresh(i + 1));
    const { items, words } = buildLesson(many, many);
    assert.equal(words, LESSON_BUDGET / 2, 'a new word costs two');
    assert.equal(items.length, LESSON_BUDGET);
    assert.equal(buildLesson([], many).items.length, 0);
    assert.equal(buildLesson(many.slice(0, 1), many, { budget: 1 }).words, 1, 'at least one word even over budget');
});

test('a lesson avoids the same task twice in a row when it can', async () => {
    const { spreadModes } = await load('lesson.js');
    const w = (id) => fresh(id);
    const items = [
        { mode: 'quiz', word: w(1), primary: true }, { mode: 'quiz', word: w(2), primary: true },
        { mode: 'cards', word: w(3), primary: true }, { mode: 'quiz', word: w(4), primary: true },
        { mode: 'cards', word: w(5), primary: true },
    ];
    const out = spreadModes(items);
    for (let i = 1; i < out.length; i++) assert.notEqual(out[i].mode, out[i - 1].mode, out.map(x => x.mode).join());
    assert.equal(out.length, items.length);
});

test('after a correct answer the follow-up is harder; a wrong one gets an easier retry', async () => {
    const { followUp, retryItem } = await load('lesson.js');
    const bare = fresh(1);
    assert.equal(followUp({ mode: 'quiz', word: bare, primary: true }).mode, 'write-no-ru');
    assert.equal(followUp({ mode: 'cards', word: bare, primary: true }).mode, 'write-ru-no');
    assert.equal(followUp({ mode: 'write-ru-no', word: bare, primary: true }), null, 'nothing harder without example or forms');
    const noun = fresh(2, { original: 'hus', pos: 'noun', gender: 'n' });
    assert.equal(followUp({ mode: 'dictation', word: noun, primary: true }).mode, 'gender');

    const retry = retryItem({ mode: 'write-ru-no', word: bare, primary: true });
    assert.deepStrictEqual([retry.mode, retry.primary, retry.retry], ['quiz', true, true]);
    assert.equal(retryItem({ mode: 'write-ru-no', word: bare, primary: true }, { quizOk: false }).mode, 'write-ru-no');
    assert.equal(retryItem({ mode: 'gender', word: noun }).primary, undefined, 'a follow-up stays practice');
});

// ---------------------------------------------------------------------------
// Игры (game-logic.js)
// ---------------------------------------------------------------------------
const known = (id, translate = `слово${id}`, extra = {}) =>
    ({ id, original: `ord${id}`, translate, sm2Reps: 1, history: [{ ts: 0, q: 2 }], nextReview: 0, ...extra });

test('games use only known words with distinct translations', async () => {
    const { gamePool } = await load('game-logic.js');
    const pool = gamePool([known(1, 'дом'), known(2, 'Дом'), known(3, 'кот'), { id: 4, original: 'ny', translate: 'новое', history: [] }]);
    assert.equal(pool.length, 2, 'the new word and the duplicate translation are left out');
    assert.ok(!pool.some(w => w.id === 4));
});

test('a quiz question has the right answer among 4 different options', async () => {
    const { quizQuestion, truthQuestion } = await load('game-logic.js');
    const pool = Array.from({ length: 8 }, (_, i) => known(i + 1));
    for (let i = 0; i < 30; i++) {
        const q = quizQuestion(pool, [1, 2]);
        assert.equal(q.options.length, 4);
        assert.equal(new Set(q.options).size, 4);
        assert.ok(q.options.includes(q.word.translate));
        assert.ok(![1, 2].includes(q.word.id), 'recent words are skipped');
        const t = truthQuestion(pool);
        assert.equal(t.truth, t.shown === t.word.translate);
    }
});

test('pairs: rounds depend on the pool; both columns hold the same words', async () => {
    const { pairsRounds, pairsRound } = await load('game-logic.js');
    const mk = (n) => Array.from({ length: n }, (_, i) => known(i + 1));
    assert.deepStrictEqual([4, 5, 9, 10, 15, 40].map(n => pairsRounds(mk(n))), [1, 1, 1, 2, 3, 3]);
    const r = pairsRound(mk(5));
    assert.deepStrictEqual(r.left.map(x => x.id).sort(), r.right.map(x => x.id).sort());
});

test('a record: lower time for pairs, higher score for the rest', async () => {
    const { isRecord, formatGameValue } = await load('game-logic.js');
    assert.ok(isRecord('pairs', 30000, {}));
    assert.ok(isRecord('pairs', 30000, { pairs: 40000 }));
    assert.ok(!isRecord('pairs', 50000, { pairs: 40000 }));
    assert.ok(isRecord('blitz', 12, { blitz: 10 }));
    assert.ok(!isRecord('blitz', 0, {}), 'zero is not a record');
    assert.equal(formatGameValue('pairs', 47321), '47,3 с');
    assert.equal(formatGameValue('streak', 7), '7');
});

test('a grammar hint follows the word: gender rules and form endings', async () => {
    const { grammarHint } = await load('norsk.js');
    assert.match(grammarHint({ original: 'frihet', pos: 'noun', gender: 'm' }, 'gender'), /-het/);
    assert.match(grammarHint({ original: 'hus', pos: 'noun', gender: 'n' }, 'gender'), /huset/);
    assert.match(grammarHint({ original: 'hus', pos: 'noun', gender: 'n' }, 'forms', 'indefPl'), /без окончания/);
    assert.match(grammarHint({ original: 'bil', pos: 'noun', gender: 'm' }, 'forms', 'defSg'), /-en/);
    assert.match(grammarHint({ original: 'å lese', pos: 'verb' }, 'forms', 'present'), /\+ -r/);
    assert.match(grammarHint({ original: 'stor', pos: 'adj' }, 'forms', 'neuter'), /-t/);
    assert.equal(grammarHint({ original: 'og', pos: 'other' }, 'forms', 'x'), '');
});

test('a correct game answer moves only a word that is due; a mistake always counts', async () => {
    const { schedulesGameAnswer } = await load('game-logic.js');
    const now = 100 * DAY;
    assert.equal(schedulesGameAnswer({ nextReview: now - 1 }, true, now), true, 'due');
    assert.equal(schedulesGameAnswer({ nextReview: now + 10 * DAY }, true, now), false, 'not due yet — no reward');
    assert.equal(schedulesGameAnswer({ nextReview: now + 10 * DAY }, false, now), true, 'a mistake brings it back');
});
