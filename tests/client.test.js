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
