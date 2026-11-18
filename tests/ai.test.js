// ИИ-подсказка и чтение скриншота: шлюз подменён, наружу запросов нет.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ai = require('../ai.js');
const suggest = require('../suggest.js');
const lingu = require('../lingu.js');

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmn-ai-'));
const keyFile = path.join(keyDir, 'key');
fs.writeFileSync(keyFile, 'test-key\n');
const savedConfig = { ...ai.config };
const savedFetch = ai.deps.fetch;
test.before(() => { delete process.env.LLM_DISABLED; ai.config.keyFile = keyFile; ai.config.textModels = ['m1', 'm2']; });
test.after(() => { Object.assign(ai.config, savedConfig); ai.deps.fetch = savedFetch; fs.rmSync(keyDir, { recursive: true, force: true }); });

// Ответ шлюза: по модели — текст ответа или код ошибки.
function gateway(byModel) {
    const calls = [];
    ai.deps.fetch = async (url, opts) => {
        const body = JSON.parse(opts.body);
        calls.push({ url, model: body.model, auth: opts.headers.Authorization, content: body.messages[0].content });
        const r = byModel[body.model];
        if (typeof r === 'number') return { ok: false, status: r };
        return { ok: true, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content: r } }] }) };
    };
    return calls;
}

test('extractJson takes the object out of a chatty or fenced answer', () => {
    assert.deepStrictEqual(ai.extractJson('Вот:\n```json\n{"items":[]}\n```\nГотово.'), { items: [] });
    assert.throws(() => ai.extractJson('думаю…'), /нет JSON/);
});

test('describeWords falls through a failing model, sends the key and matches answers by word', async () => {
    const calls = gateway({
        m1: 429,
        m2: '{"items":[{"word":"flink","translate":"способный, умелый","example":"«Hun er flink.»","exampleTranslate":"Она способная."},'
            + '{"word":"å bo","translate":"жить","example":"Jeg bor i Oslo.","exampleTranslate":"Я живу в Осло."}]}',
    });
    const { model, items } = await ai.describeWords(['å bo', 'flink', 'ukjent']);
    assert.equal(model, 'm2');
    assert.deepStrictEqual(calls.map(c => c.model), ['m1', 'm2']);
    assert.equal(calls[0].auth, 'Bearer test-key');
    assert.deepStrictEqual(items.map(i => i.translate), ['жить', 'способный, умелый', ''], 'order follows the request, not the answer');
    assert.equal(items[1].example, 'Hun er flink.', 'quotes around the example are dropped');
});

test('without a key the AI is off and asks nobody', async () => {
    const calls = gateway({});
    process.env.LLM_DISABLED = '1';
    try {
        assert.equal(ai.available(), false);
        await assert.rejects(ai.describeWords(['hus']), /не настроен/);
        assert.equal(calls.length, 0);
    } finally { delete process.env.LLM_DISABLED; }
});

test('readScreenshot drops items without letters and sends the picture', async () => {
    ai.config.visionModels = ['v1'];
    const calls = gateway({ v1: '{"items":[{"word":"et hus","translate":"дом","example":"","exampleTranslate":""},{"word":"12:45","translate":""}]}' });
    const { items } = await ai.readScreenshot(Buffer.from('png'), 'image/png');
    assert.deepStrictEqual(items.map(i => i.word), ['et hus']);
    assert.match(calls[0].content[1].image_url.url, /^data:image\/png;base64,/);
});

test('guessFromSpelling: article → noun with gender, å → verb, phrase → other', () => {
    assert.deepStrictEqual(suggest.guessFromSpelling('et  land'), { original: 'land', pos: 'noun', gender: 'n' });
    assert.deepStrictEqual(suggest.guessFromSpelling('Å bo'), { original: 'å bo', pos: 'verb', gender: '' });
    assert.equal(suggest.guessFromSpelling('Lykke til!').pos, 'other');
    assert.equal(suggest.guessFromSpelling('flink').pos, '');
});

test('suggest joins the dictionary and the AI; a phrase keeps its capital letter', async () => {
    const saved = { ...suggest.deps };
    try {
        Object.assign(suggest.deps, {
            lookup: async (w) => (w === 'et land' ? { original: 'land', pos: 'noun', gender: 'n', forms: { defSg: 'landet' } }
                : w === 'Lykke til!' ? { original: 'lykke til', pos: 'other', gender: '', forms: {} } : null),
            aiAvailable: () => true,
            describe: async (w) => ({ word: w, translate: w === 'et land' ? 'страна' : 'удачи!', example: 'Norge er et land.', exampleTranslate: 'Норвегия — страна.' }),
            translate: async () => 'машинный перевод',
        });
        const land = await suggest.suggest('et land');
        assert.deepStrictEqual([land.original, land.pos, land.gender, land.forms.defSg, land.translate, land.source, land.inDictionary],
            ['land', 'noun', 'n', 'landet', 'страна', 'ai', true]);
        assert.equal((await suggest.suggest('Lykke til!')).original, 'Lykke til!');
        // ИИ молчит — берётся переводчик, спрошенный параллельно.
        suggest.deps.describe = async () => { throw new Error('gateway down'); };
        const fallback = await suggest.suggest('et land');
        assert.deepStrictEqual([fallback.translate, fallback.source], ['машинный перевод', 'translator']);
    } finally { Object.assign(suggest.deps, saved); }
});

test('suggest falls back to the translator when the AI is unavailable', async () => {
    const saved = { ...suggest.deps };
    try {
        Object.assign(suggest.deps, {
            lookup: async () => null,
            aiAvailable: () => false,
            describe: async () => { throw new Error('not called'); },
            translate: async (w) => (w === 'å bo' ? 'жить' : ''),
        });
        const d = await suggest.suggest('å bo');
        assert.deepStrictEqual([d.original, d.pos, d.translate, d.source, d.example], ['å bo', 'verb', 'жить', 'translator', '']);
    } finally { Object.assign(suggest.deps, saved); }
});

test('parseCards takes a Russian line as the translation instead of reading it as Norwegian', () => {
    const cards = lingu.parseCards('et hus\net hus\nдом, здание\n"Huset er stort."');
    assert.equal(cards.length, 1);
    assert.equal(cards[0].original, 'et hus');
    assert.equal(cards[0].translate, 'дом, здание');
    assert.equal(cards[0].example, 'Huset er stort.');
});

test('a bare word prefers a noun or adjective over a verb, and the regular plural over the zero one', () => {
    const { pickParadigm } = require('../ordbok.js');
    const art = (lemma, ...paradigms) => ({ lemmas: [{ lemma, paradigm_info: paradigms }] });
    const verb = { tags: ['VERB'], inflection: [{ word_form: 'uttaler', tags: ['Pres'] }] };
    const noun = { tags: ['NOUN', 'Masc'], inflection: [{ word_form: 'uttalen', tags: ['Sing', 'Def'] }, { word_form: 'uttaler', tags: ['Plur', 'Ind'] }] };
    assert.equal(pickParadigm([art('uttale', verb), art('uttale', noun)], { lemma: 'uttale', pos: '', gender: '' }).pos, 'noun');
    assert.equal(pickParadigm([art('uttale', verb), art('uttale', noun)], { lemma: 'uttale', pos: 'verb', gender: '' }).original, 'å uttale');
    const adj = { tags: ['ADJ'], inflection: [{ word_form: 'fransk', tags: ['Pos', 'Neuter', 'Ind', 'Sing'] }, { word_form: 'franske', tags: ['Pos', 'Plur'] }] };
    const lang = { tags: ['NOUN', 'Masc'], inflection: [{ word_form: 'fransken', tags: ['Sing', 'Def'] }] };
    assert.equal(pickParadigm([art('fransk', lang), art('fransk', adj)], { lemma: 'fransk', pos: '', gender: '' }).pos, 'adj');
    const pl = (indef) => ({ tags: ['NOUN', 'Neuter'], inflection: [{ word_form: 'eksempelet', tags: ['Sing', 'Def'] }, { word_form: indef, tags: ['Plur', 'Ind'] }] });
    assert.equal(pickParadigm([art('eksempel', pl('eksempel'), pl('eksempler'))], { lemma: 'eksempel', pos: '', gender: '' }).forms.indefPl, 'eksempler');
});

test('describeWords never gives a card another word\'s translation when the model reorders and drops articles', async () => {
    gateway({ m1: '{"items":[{"word":"hus","translate":"дом"},{"word":"uttale","translate":"произношение"}]}' });
    const { items } = await ai.describeWords(['en uttale', 'et hus', 'ukjent']);
    assert.deepStrictEqual(items.map(i => i.translate), ['произношение', 'дом', '']);
    gateway({ m1: '{"items":[{"word":"bil","translate":"машина"},{"word":"båt","translate":"лодка"}]}' });
    const other = await ai.describeWords(['hus', 'bok']);
    assert.deepStrictEqual(other.items.map(i => i.translate), ['', ''], 'no positional guess');
    assert.deepStrictEqual(await ai.describeWords([]), { model: '', items: [] });
});
