// Режимы тренировки в браузере.
const test = require('node:test');
const assert = require('node:assert');
const { createServer, launch, openApp, importA1, waitSynced, goView, openAdd, openImport } = require('./helpers');

let server, browser;
test.before(async () => { server = await createServer(); browser = await launch(); });
test.after(async () => { await browser?.close(); await server?.cleanup(); });

const scheduleOf = (page) => page.evaluate(() =>
    JSON.parse(localStorage.getItem('myWords')).map(w => `${w.id}:${w.nextReview}:${w.sm2Reps}`).join(','));

async function closeResults(page) {
    if (await page.isVisible('#results-modal.open')) await page.click('[data-action="close-results"]');
}

test('the main training moves the schedule, practice does not', async () => {
    const { page, context, errors } = await openApp(browser, server);
    await importA1(page);
    await waitSynced(page);

    const before = await scheduleOf(page);
    await page.click('[data-action="start-quiz"]');
    assert.match(await page.textContent('#tr-source'), /Практика/);
    await page.keyboard.press('1');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    assert.match(await page.textContent('#results-note'), /расписание повторений не изменилось/);
    await closeResults(page);
    assert.equal(await scheduleOf(page), before, 'practice left every word untouched');

    await page.click('#start-training-btn');
    assert.equal(await page.isVisible('#tr-source'), false, 'no practice badge in the main training');
    await page.keyboard.press('Space');
    await page.keyboard.press('2');
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');
    await closeResults(page);
    assert.notEqual(await scheduleOf(page), before, 'the main training changed the schedule');
    assert.deepStrictEqual(errors, []);
    await context.close();
});

test('practice is available even when nothing is due', async () => {
    const { page, context } = await openApp(browser, server);
    await page.click('[data-action="open-settings"]');
    await page.fill('#set-new', '0');
    await page.click('[data-action="save-settings"]');
    // Всё, что было к повторению, отвечаем «Помню», чтобы на сегодня ничего не осталось.
    for (let i = 0; i < 30 && !(await page.textContent('#start-training-btn')).includes('всё'); i++) {
        await page.click('#start-training-btn');
        await page.keyboard.press('Space');
        await page.keyboard.press('2');
        await page.waitForTimeout(350);
        await page.keyboard.press('Escape');
        await closeResults(page);
    }
    assert.match(await page.textContent('#start-training-btn'), /всё/);
    await page.click('#start-training-btn');
    assert.equal(await page.isVisible('#training-section'), false, 'the main training has nothing to show');

    for (const action of ['start-write', 'start-dictation', 'start-quiz', 'start-gender', 'start-forms', 'start-cloze']) {
        await page.click(`[data-action="${action}"]`);
        assert.ok(await page.isVisible('#training-section'), `${action} works with nothing due`);
        await page.keyboard.press('Escape');
        await closeResults(page);
    }
    await page.click('[data-action="open-settings"]');
    await page.fill('#set-new', '15');
    await page.click('[data-action="save-settings"]');
    await context.close();
});

test('dictation plays the word first and checks the Norwegian spelling', async () => {
    const { page, context, errors } = await openApp(browser, server);
    await page.click('[data-action="start-dictation"]');
    assert.equal(await page.textContent('#card-front'), '🎧');
    await page.waitForFunction(() => window.__played.length > 0);
    const heard = (await page.evaluate(() => window.__played))[0];
    assert.equal(await page.getAttribute('#tr-links', 'data-conceal'), 'links', 'dictionary links hidden, listen button visible');

    await page.press('#tr-input', 'Tab');
    await page.waitForFunction(() => window.__played.length > 1);
    assert.equal((await page.evaluate(() => window.__played))[1], heard, 'Tab replays the same word');

    await page.fill('#tr-input', heard.replace(/^(en|ei|et|å) /, ''));
    await page.press('#tr-input', 'Enter');
    assert.match(await page.textContent('#tr-feedback'), /Верно/);
    assert.equal(await page.getAttribute('#tr-links', 'data-conceal'), '');
    assert.deepStrictEqual(errors, []);
    await context.close();
});

test('cloze shows a sentence with a gap and fills it after the answer', async () => {
    const { page, context, errors } = await openApp(browser, server);
    await page.click('[data-action="start-cloze"]');
    const sentence = await page.textContent('.prompt-sentence');
    assert.match(sentence, /____/);
    assert.ok(await page.textContent('.prompt-label em'), 'the hint names the word');
    await page.fill('#tr-input', 'feil-svar');
    await page.press('#tr-input', 'Enter');
    assert.match(await page.textContent('#tr-feedback'), /Правильно/);
    const full = (await page.textContent('.prompt-sentence')).trim();
    assert.doesNotMatch(full, /____/, 'the gap is filled with the answer');
    // Звучит всё предложение целиком — ровно то, что теперь на экране.
    await page.waitForFunction((s) => window.__played.includes(s), full, { timeout: 5000 });
    assert.deepStrictEqual(errors, []);
    await context.close();
});

test('the example on the card back can be listened to', async () => {
    const { page, context } = await openApp(browser, server);
    await page.click('#start-training-btn');
    for (let i = 0; i < 10 && await page.isHidden('#card-example-block'); i++) {
        await page.keyboard.press('Space'); await page.keyboard.press('2'); await page.waitForTimeout(350);
    }
    await page.keyboard.press('Space');
    await page.waitForTimeout(600);
    const flippedBefore = await page.evaluate(() => document.getElementById('flashcard').classList.contains('is-flipped'));
    const example = await page.textContent('#card-example');
    await page.click('[data-action="tr-speak-example"]');
    await page.waitForFunction((ex) => window.__played.includes(ex), example);
    const flippedAfter = await page.evaluate(() => document.getElementById('flashcard').classList.contains('is-flipped'));
    assert.equal(flippedAfter, flippedBefore, 'clicking 🔊 does not flip the card');
    await page.keyboard.press('Escape');
    await context.close();
});

test('the card-direction setting fixes the question side', async () => {
    const { page, context } = await openApp(browser, server);
    await page.click('[data-action="open-settings"]');
    assert.equal(await page.inputValue('#set-cards-dir'), 'no-ru', 'Norwegian on the front is the default');
    await page.selectOption('#set-cards-dir', 'ru-no');
    await page.click('[data-action="save-settings"]');
    await page.click('[data-action="start-hard"]').catch(() => {});
    await closeResults(page);
    if (!(await page.isVisible('#training-section'))) await page.click('[data-action="start-marathon"]');
    for (let i = 0; i < 5; i++) {
        assert.equal(await page.getAttribute('#card-front', 'lang'), 'ru');
        await page.keyboard.press('Space'); await page.keyboard.press('2'); await page.waitForTimeout(350);
        if (!(await page.isVisible('#training-section'))) break;
    }
    await page.keyboard.press('Escape');
    await closeResults(page);
    await page.click('[data-action="open-settings"]');
    await page.selectOption('#set-cards-dir', 'no-ru');
    await page.click('[data-action="save-settings"]');
    await context.close();
});

test('the help explains levels and opens from the settings', async () => {
    const { page, context } = await openApp(browser, server);
    await page.click('[data-action="open-settings"]');
    await page.click('#settings-modal [data-action="open-help"]');
    assert.ok(await page.isVisible('#help-modal'));
    const text = await page.textContent('#help-modal');
    assert.match(text, /21 день/);
    assert.match(text, /4-м правильном ответе/);
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#help-modal'), false);
    await context.close();
});

test('separate modes are folded under «Другие режимы», can be opened, and the choice is remembered', async () => {
    const { page, context } = await openApp(browser, server, { practiceOpen: false });
    assert.ok(await page.isVisible('#lesson-btn'), 'one main button');
    assert.equal(await page.isVisible('[data-action="start-quiz"]'), false, 'folded by default');
    await page.click('#practice-details summary');
    assert.ok(await page.isVisible('[data-action="start-quiz"]'));
    assert.ok(await page.isVisible('#start-training-btn'), 'cards live under «Другие режимы»');
    await page.reload();
    await page.waitForTimeout(500);
    assert.ok(await page.isVisible('[data-action="start-quiz"]'), 'stays open after a reload');
    await page.click('#practice-details summary');
    await context.close();
});

test('a lesson: a new word is introduced, then asked; the answer moves the schedule as an easy one', async () => {
    // Свой сервер с 6 новыми словами, чтобы урок начался со знакомства.
    const own = await createServer();
    const upserts = Array.from({ length: 6 }, (_, i) => ({
        id: 9000 + i, original: ['hus', 'bil', 'katt', 'hund', 'bok', 'stol'][i], translate: ['дом', 'машина', 'кот', 'собака', 'книга', 'стул'][i],
        level: 0, nextReview: 0, tags: [], history: [], addedAt: i + 1,
    }));
    const res = await fetch(`${own.url}/api/words/batch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upserts }),
    });
    assert.ok(res.ok, `seed: ${res.status}`);
    const { page, context, errors } = await openApp(browser, own, { practiceOpen: false });
    try {
    await page.waitForFunction(() => /Продолжить/.test(document.getElementById('lesson-btn')?.textContent));
    await page.click('#lesson-btn');
    assert.match(await page.textContent('#tr-prompt'), /дом|машина|кот|собака|книга|стул/, 'the translation is shown right away');
    assert.match(await page.textContent('#tr-mode'), /Новое слово/);
    assert.ok(await page.isDisabled('#tr-mode'), 'no mode switching inside a lesson');
    const first = await page.textContent('#tr-prompt .prompt-main');
    await page.keyboard.press('Enter');

    // До задания на это слово отвечаем на всё, что встретится (только выбор и знакомства).
    for (let i = 0; i < 12; i++) {
        const mode = await page.textContent('#tr-mode');
        if (/Угадай/.test(mode) && (await page.textContent('#tr-prompt .prompt-main')) === first) break;
        if (/Угадай/.test(mode)) { await page.keyboard.press('1'); await page.waitForTimeout(200); await page.keyboard.press('Enter'); }
        else await page.keyboard.press('Enter');
        await page.waitForTimeout(150);
    }
    assert.equal(await page.textContent('#tr-prompt .prompt-main'), first, 'the introduced word is asked');
    const right = await page.evaluate((w) => {
        const word = JSON.parse(localStorage.getItem('myWords')).find(x => x.original === w);
        return [...document.querySelectorAll('#tr-options .quiz-option')].findIndex(b => b.textContent.includes(word.translate));
    }, first);
    await page.keyboard.press(String(right + 1));
    await page.waitForTimeout(300);
    const w = await page.evaluate((o) => JSON.parse(localStorage.getItem('myWords')).find(x => x.original === o), first);
    assert.equal(w.history.at(-1).e, 1, 'an easy answer in the history');
    assert.equal(w.sm2EF, 2.5, 'EF untouched');
    assert.ok(w.nextReview > Date.now() + 60 * 60 * 1000, 'scheduled for later');

    await page.keyboard.press('Escape');
    assert.ok(await page.isVisible('#results-modal.open'));
    assert.ok(await page.isVisible('#results-more'), '«Ещё урок» while words wait');
    await page.waitForTimeout(700);
    await page.keyboard.press('Enter');
    assert.ok(await page.isVisible('#training-section'), 'Enter starts the next lesson');
    await page.keyboard.press('Escape');
    await closeResults(page);
    assert.deepStrictEqual(errors, []);
    } finally {
        await context.close();
        await own.cleanup();
    }
});

test('listening: a sentence plays, the translation is chosen, then the sentence is shown', async () => {
    const { page, context, errors } = await openApp(browser, server);
    await page.click('[data-action="start-listen"]');
    await page.waitForFunction(() => window.__played.length > 0);
    const heard = (await page.evaluate(() => window.__played))[0];
    assert.ok(heard.split(' ').length >= 2, `a whole sentence is played: «${heard}»`);
    assert.equal(await page.isVisible('#listen-sentence'), false, 'the text is hidden until the answer');
    const right = await page.evaluate((s) => JSON.parse(localStorage.getItem('myWords')).find(w => w.example === s).exampleTranslate, heard);
    const options = await page.$$eval('#tr-options .quiz-option', bs => bs.map(b => b.textContent.slice(1)));
    await page.keyboard.press(String(options.indexOf(right) + 1));
    assert.match(await page.textContent('#tr-feedback'), /Верно/);
    assert.ok(await page.isVisible('#listen-sentence'));
    assert.equal(await page.textContent('#tr-source'), 'Практика — расписание не меняется');
    assert.deepStrictEqual(errors, []);
    await page.keyboard.press('Escape');
    await context.close();
});

test('sentence order: picking the words in the right order is correct, a wrong order is not', async () => {
    const { page, context, errors } = await openApp(browser, server);
    await page.click('[data-action="start-order"]');
    const answerFor = () => page.evaluate(() => {
        const label = document.querySelector('#tr-prompt .prompt-sub')?.textContent;
        const w = JSON.parse(localStorage.getItem('myWords')).find(x => x.exampleTranslate === label);
        const pool = [...document.querySelectorAll('.order-pool .order-token')].map(b => b.lastChild.textContent);
        return { example: w.example, pool };
    });
    const { orderTokens } = await import('../../js/norsk.js');
    // Правильно.
    let { example, pool } = await answerFor();
    const answer = orderTokens(example);
    const used = new Set();
    for (const tok of answer) {
        const i = pool.findIndex((p, k) => !used.has(k) && p.toLowerCase() === tok.toLowerCase());
        used.add(i);
        await page.click(`.order-pool [data-index="${i}"]`);
    }
    assert.match(await page.textContent('#tr-feedback'), /Верно/);
    await page.keyboard.press('Enter');
    // Неправильно: правильный порядок, но два первых разных слова переставлены.
    ({ example, pool } = await answerFor());
    const right = orderTokens(example);
    const k = right.findIndex(tok => tok.toLowerCase() !== right[0].toLowerCase());
    const wrong = [...right];
    [wrong[0], wrong[k]] = [wrong[k], wrong[0]];
    const taken = new Set();
    for (const tok of wrong) {
        const i = pool.findIndex((p, j) => !taken.has(j) && p.toLowerCase() === tok.toLowerCase());
        taken.add(i);
        await page.click(`.order-pool [data-index="${i}"]`);
    }
    assert.match(await page.textContent('#tr-feedback'), /Порядок другой/);
    assert.ok(await page.isVisible('.order-answer'), 'the right sentence is shown after the check');
    assert.deepStrictEqual(errors, []);
    await page.keyboard.press('Escape');
    await context.close();
});

test('typing a word fills translation, example, gender and forms; Enter twice adds it', async () => {
    const { page, context, errors } = await openApp(browser, server);
    const asked = [];
    await page.route('**/api/word/suggest', (route) => {
        asked.push(JSON.parse(route.request().postData()).word);
        route.fulfill({ json: { original: 'uttale', pos: 'noun', gender: 'm', inDictionary: true,
            forms: { defSg: 'uttalen', indefPl: 'uttaler', defPl: 'uttalene' },
            translate: 'произношение', example: 'Uttalen er viktig.', exampleTranslate: 'Произношение важно.', source: 'ai' } });
    });
    await openAdd(page);
    await page.fill('#add-no', 'en uttale');
    await page.press('#add-no', 'Enter');
    await page.waitForFunction(() => document.getElementById('add-ru').value === 'произношение');
    assert.deepStrictEqual(asked, ['en uttale'], 'one request per word');
    assert.equal(await page.inputValue('#add-no'), 'uttale', 'the article becomes the gender');
    assert.ok(await page.isChecked('input[name="add-gender"][value="m"]'));
    assert.equal(await page.inputValue('#add-form-defPl'), 'uttalene');
    assert.equal(await page.inputValue('#add-example'), 'Uttalen er viktig.');
    assert.match(await page.textContent('#add-preview'), /uttalen/);

    await page.press('#add-no', 'Enter');   // второй Enter — добавить
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('myWords') || '[]').some(w => w.original === 'uttale'));
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('myWords')).find(w => w.original === 'uttale'));
    assert.deepStrictEqual([saved.translate, saved.pos, saved.gender, saved.example, saved.forms.defSg],
        ['произношение', 'noun', 'm', 'Uttalen er viktig.', 'uttalen']);
    assert.equal(await page.inputValue('#add-no'), '', 'the form is ready for the next word');
    assert.ok(await page.isVisible('#add-modal.open'), 'the window stays open for the next word');

    // Следующее слово не наследует часть речи прошлого (так глаголы становились существительными).
    await page.unroute('**/api/word/suggest');
    await page.route('**/api/word/suggest', (route) => route.fulfill({ json: { original: 'å bo', pos: 'verb', gender: '',
        forms: {}, translate: 'жить', example: '', exampleTranslate: '', source: 'ai', inDictionary: false } }));
    await page.fill('#add-no', 'å bo');
    await page.press('#add-no', 'Enter');
    await page.waitForFunction(() => document.getElementById('add-ru').value === 'жить');
    assert.equal(await page.inputValue('#add-pos'), 'verb');
    assert.deepStrictEqual(errors, []);
    await context.close();
});

test('changing the word clears what the suggestion filled, but keeps what was typed by hand', async () => {
    const { page, context } = await openApp(browser, server);
    await page.route('**/api/word/suggest', (route) => {
        const w = JSON.parse(route.request().postData()).word;
        route.fulfill({ json: { original: w, pos: 'adj', gender: '', forms: {}, translate: w === 'flink' ? 'способный' : 'приятный',
            example: '', exampleTranslate: '', source: 'ai', inDictionary: false } });
    });
    await openAdd(page);
    await page.fill('#add-no', 'flink');
    await page.press('#add-no', 'Enter');
    await page.waitForFunction(() => document.getElementById('add-ru').value === 'способный');
    await page.fill('#add-ex-ru', 'моё');
    await page.fill('#add-no', 'hyggelig');
    await page.press('#add-no', 'Enter');
    await page.waitForFunction(() => document.getElementById('add-ru').value === 'приятный');
    assert.equal(await page.inputValue('#add-ex-ru'), 'моё');
    await context.close();
});

test('a screenshot becomes a checklist; words already in the deck are not added again', async () => {
    const { page, context, errors } = await openApp(browser, server);
    await page.route('**/api/import/screenshot', (route) => route.fulfill({ json: { items: [
        { original: 'konsonant', translate: 'согласный', pos: 'noun', gender: 'm', forms: { defSg: 'konsonanten' },
          example: 'Bokstaven B er en konsonant.', exampleTranslate: 'Буква B — согласная.', definition: 'en bokstav' },
        { original: 'å uttrykke', translate: '', pos: 'verb', gender: '', forms: {}, example: 'Han uttrykker seg godt.', exampleTranslate: '', definition: 'å si' },
        { original: 'hus', translate: 'дом', pos: 'noun', gender: 'n', forms: {}, example: '', exampleTranslate: '', definition: '' },
    ] } }));
    // «hus» уже есть: колода A1 загружена первым тестом.
    await openImport(page);
    await page.setInputFiles('#shot-upload', require('node:path').join(__dirname, '..', 'fixtures', 'lingu-sample.png'));
    await page.waitForSelector('#shot-list .shot-row');
    assert.equal(await page.locator('.shot-row').count(), 3);
    assert.ok(await page.isDisabled('.shot-row.dup .shot-check'), 'the word already in the deck cannot be ticked');
    assert.match(await page.textContent('#shot-add'), /Добавить 2/);

    await page.click('#shot-add');
    assert.match(await page.textContent('#toast-container'), /Впиши перевод: å uttrykke/, 'an empty translation is not saved');
    await page.fill('.shot-tr[data-index="1"]', 'выражать');
    await page.click('#shot-add');
    const added = await page.evaluate(() => JSON.parse(localStorage.getItem('myWords'))
        .filter(w => w.tags.includes('lingu')).map(w => [w.original, w.translate, w.gender, w.example]));
    assert.deepStrictEqual(added, [
        ['konsonant', 'согласный', 'm', 'Bokstaven B er en konsonant.'],
        ['å uttrykke', 'выражать', '', 'Han uttrykker seg godt.'],
    ]);
    assert.deepStrictEqual(errors, []);
    await context.close();
});

test('the dictionary button after the automatic fill keeps the noun the article asked for', async () => {
    const { page, context } = await openApp(browser, server);
    const asked = [];
    await page.route('**/api/ordbok?**', (route) => {
        const w = new URL(route.request().url()).searchParams.get('w');
        asked.push(w);
        route.fulfill({ json: w === 'en uttale'
            ? { lemma: 'uttale', original: 'uttale', pos: 'noun', gender: 'm', forms: { defSg: 'uttalen' } }
            : { lemma: 'uttale', original: 'å uttale', pos: 'verb', gender: '', forms: { past: 'uttalte' } } });
    });
    await page.route('**/api/word/suggest', (route) => route.fulfill({ json: { original: 'uttale', pos: 'noun', gender: 'm',
        forms: { defSg: 'uttalen' }, translate: 'произношение', example: '', exampleTranslate: '', source: 'ai', inDictionary: true } }));
    await openAdd(page);
    await page.fill('#add-no', 'en uttale');
    await page.press('#add-no', 'Enter');
    await page.waitForFunction(() => document.getElementById('add-pos').value === 'noun');
    await page.click('#add-more summary');
    await page.click('#add-dict');
    await page.waitForTimeout(300);
    assert.equal(await page.inputValue('#add-pos'), 'noun');
    assert.equal(await page.inputValue('#add-no'), 'uttale');
    assert.deepStrictEqual(asked, ['en uttale'], 'the button reuses the query that filled the field');
    await context.close();
});

test('a pause while typing does not rewrite the word; Enter does; a double tap adds once', async () => {
    const { page, context, errors } = await openApp(browser, server);
    await page.route('**/api/word/suggest', (route) => route.fulfill({ json: { original: 'uttale', pos: 'noun', gender: 'm',
        forms: {}, translate: 'произношение', example: '', exampleTranslate: '', source: 'ai', inDictionary: true } }));
    await openAdd(page);
    await page.type('#add-no', 'en uttale');
    await page.waitForFunction(() => document.getElementById('add-ru').value === 'произношение');
    assert.equal(await page.inputValue('#add-no'), 'en uttale', 'still typing — the article stays');
    const count = () => page.evaluate(() => JSON.parse(localStorage.getItem('myWords')).filter(w => w.original === 'uttale').length);
    const before = await count();
    await page.press('#add-no', 'Enter');   // перевод уже виден — Enter добавляет, артикль уходит в род
    await page.waitForTimeout(300);
    if (await page.isVisible('.confirm-box')) await page.keyboard.press('Enter');
    assert.equal(await count(), before + 1);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('myWords')).filter(w => w.original === 'uttale').pop());
    assert.equal(saved.gender, 'm');

    await page.fill('#add-no', 'en uttale');
    await page.press('#add-no', 'Enter');
    await page.waitForFunction(() => document.getElementById('add-ru').value === 'произношение');
    // Два нажатия подряд, пока первое ждёт подтверждения про дубль.
    await page.evaluate(() => { const b = document.querySelector('#add-modal [data-action="add-word"]'); b.click(); b.click(); });
    await page.waitForTimeout(400);
    if (await page.isVisible('.confirm-box')) await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    assert.equal(await page.isVisible('.confirm-box'), false, 'one confirm, closed by one Enter');
    assert.equal(await count(), before + 2);
    assert.deepStrictEqual(errors, []);
    await context.close();
});
