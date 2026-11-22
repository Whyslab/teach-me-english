// Проверка карточки «🚩 Сомневаюсь»: ИИ — перевод и пример, словарь — род и формы.
const test = require('node:test');
const assert = require('node:assert');
process.env.LLM_DISABLED = '1';
const check = require('../check.js');

const card = { original: 'uttale', pos: 'noun', gender: 'm', translate: 'заявление',
    example: 'Uttalen er vanskelig.', exampleTranslate: 'Произношение трудное.', forms: { defSg: 'uttalen' } };

function stub({ dict = null, ai = null } = {}) {
    check.deps.lookup = async () => dict;
    check.deps.aiAvailable = () => Boolean(ai);
    check.deps.ask = async () => ai;
}

test('a wrong translation comes back as an issue with a fix; nothing else is touched', async () => {
    stub({
        dict: { pos: 'noun', gender: 'm', forms: { defSg: 'uttalen' } },
        ai: { model: 'm1', data: { ok: false, issues: ['Перевод неверен: это «произношение»'], fix: { translate: 'произношение', example: 'Uttalen er vanskelig.', exampleTranslate: '' } } },
    });
    const r = await check.checkWord(card);
    assert.equal(r.ok, false);
    assert.deepStrictEqual(r.fix, { translate: 'произношение' }, 'unchanged fields are not "fixed"');
    assert.equal(r.checkedBy.ai, 'm1');
});

test('gender and forms are judged by the dictionary, not by the model', async () => {
    stub({ dict: { pos: 'noun', gender: 'n', forms: { defSg: 'huset', indefPl: 'hus' } }, ai: { model: 'm', data: { ok: true, issues: [], fix: {} } } });
    const r = await check.checkWord({ ...card, original: 'hus', gender: 'm', forms: { defSg: 'husen' } });
    assert.equal(r.fix.gender, 'n');
    assert.deepStrictEqual(r.fix.forms, { defSg: 'huset' });
    assert.equal(r.issues.length, 2);
});

test('en for an ei-word is not an error', async () => {
    stub({ dict: { pos: 'noun', gender: 'f', forms: {} }, ai: null });
    const r = await check.checkWord({ ...card, original: 'jente', gender: 'm', forms: {} });
    assert.equal(r.ok, true);
    assert.equal(r.checkedBy.ai, '');
});

test('the dictionary is asked with the article', async () => {
    assert.equal(check.queryOf({ original: 'hus', pos: 'noun', gender: 'n' }), 'et hus');
    assert.equal(check.queryOf({ original: 'å bo', pos: 'verb' }), 'å bo');
});
