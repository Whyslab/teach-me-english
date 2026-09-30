// Тесты логики фронтенда. Модули в js/ — это ES-модули без DOM (кроме
// интерфейсных), поэтому чистые функции импортируются напрямую.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const load = (name) => import(path.join(ROOT, 'js', name));

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

test('guessVerbForms only guesses the present tense', async () => {
    const { guessVerbForms } = await load('norsk.js');
    assert.deepStrictEqual(guessVerbForms('å reise'), { present: 'reiser' });
    assert.deepStrictEqual(guessVerbForms('å bo'), { present: 'bor' });
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
    const w = { sm2EF: 2.5 };
    sm2(w, 0, 0);
    assert.equal(w.sm2EF, 2.3);
    for (let i = 0; i < 10; i++) sm2(w, 0, 0);
    assert.equal(w.sm2EF, 1.3);
});

test('sm2: four "good" answers in a row make a word learned (level 5)', async () => {
    // Это же написано в окне «Как это работает»: 1 → 6 → 15 → 38 дней.
    const { sm2 } = await load('srs.js');
    const w = {};
    const path = [];
    for (let i = 0; i < 4; i++) { sm2(w, 2, 0); path.push([w.sm2Interval, w.level]); }
    assert.deepStrictEqual(path, [[1, 1], [6, 3], [15, 4], [38, 5]]);
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
    sm2(w, 2, 0); assert.equal(w.sm2Interval, 1);
    sm2(w, 2, 0); assert.equal(w.sm2Interval, 6);
    sm2(w, 2, 0); assert.equal(w.sm2Interval, Math.round(6 * w.sm2EF));
});

test('sm2 keeps at most 30 history entries', async () => {
    const { sm2 } = await load('srs.js');
    const w = {};
    for (let i = 0; i < 40; i++) sm2(w, 2, i);
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
    for (const w of deck) for (let k = 0; k < 30; k++) sm2(w, 2, k);
    const synced = new Map(deck.map(w => [w.id, fingerprint(w)]));
    assert.ok(JSON.stringify(deck).length > BEACON_LIMIT, 'the whole deck does not fit — that was the bug');
    sm2(deck[0], 3, 99);
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

test('the bundled A1 deck parses cleanly, with grammar on every noun and verb', async () => {
    const { parseImport } = await load('format.js');
    const text = fs.readFileSync(path.join(ROOT, 'decks', 'a1.txt'), 'utf8');
    const { words, duplicates } = parseImport(text);
    assert.deepStrictEqual(duplicates, []);
    assert.ok(words.length >= 250, `only ${words.length} words`);
    for (const w of words) {
        if (w.pos === 'noun') {
            assert.ok(w.gender, `${w.original}: noun without gender`);
            assert.ok(w.forms.defSg, `${w.original}: noun without the definite form`);
        }
        if (w.pos === 'verb') assert.equal(Object.keys(w.forms).length, 3, `${w.original}: verb needs 3 forms`);
    }
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
