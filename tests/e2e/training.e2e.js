// Режимы тренировки в браузере.
const test = require('node:test');
const assert = require('node:assert');
const { createServer, launch, openApp, importA1, waitSynced } = require('./helpers');

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

test('the help explains levels and opens from the stats row', async () => {
    const { page, context } = await openApp(browser, server);
    await page.click('.levels-hint [data-action="open-help"]');
    assert.ok(await page.isVisible('#help-modal'));
    const text = await page.textContent('#help-modal');
    assert.match(text, /21 день/);
    assert.match(text, /4-м правильном ответе/);
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#help-modal'), false);
    await context.close();
});

test('practice modes are tucked away until opened, and the choice is remembered', async () => {
    const { page, context } = await openApp(browser, server, { practiceOpen: false });
    assert.equal(await page.isVisible('[data-action="start-quiz"]'), false);
    await page.click('#practice-details summary');
    assert.ok(await page.isVisible('[data-action="start-quiz"]'));
    await page.reload();
    assert.ok(await page.isVisible('[data-action="start-quiz"]'), 'stays open after a reload');
    await context.close();
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
    assert.equal(await page.textContent('#tr-source'), '🧘 Практика — расписание не меняется');
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
    // Неправильно: слова в выданном (перемешанном) порядке, но первое — последним.
    ({ pool } = await answerFor());
    const order = [...pool.keys()];
    order.push(order.shift());
    for (const i of order) await page.click(`.order-pool [data-index="${i}"]`);
    const fb = await page.textContent('#tr-feedback');
    // Перемешанный порядок мог случайно совпасть с правильным — тогда «верно» честно.
    assert.match(fb, /Верно|Порядок другой/);
    assert.ok(await page.isVisible('.order-answer'), 'the right sentence is shown after the check');
    assert.deepStrictEqual(errors, []);
    await page.keyboard.press('Escape');
    await context.close();
});

test('typing a word and leaving the field fills part of speech, gender and forms from Ordbøkene', async () => {
    const { page, context, errors } = await openApp(browser, server);
    let asked = '';
    await page.route('**/api/ordbok?**', (route) => {
        asked = new URL(route.request().url()).searchParams.get('w');
        route.fulfill({ json: { lemma: 'uttale', original: 'uttale', pos: 'noun', gender: 'm',
            forms: { defSg: 'uttalen', indefPl: 'uttaler', defPl: 'uttalene' } } });
    });
    await page.fill('#add-no', 'en uttale');
    await page.click('#add-ru');
    await page.waitForFunction(() => document.getElementById('add-pos').value === 'noun');
    assert.equal(asked, 'en uttale');
    assert.equal(await page.inputValue('#add-no'), 'uttale', 'the article becomes the gender');
    assert.ok(await page.isChecked('input[name="add-gender"][value="m"]'));
    assert.equal(await page.inputValue('#add-form-defPl'), 'uttalene');
    assert.deepStrictEqual(errors, []);
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
    await page.click('[data-action="open-import"]');
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
