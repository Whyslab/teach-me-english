// Синхронизация в настоящем браузере: изменения без сервера не теряются.
const test = require('node:test');
const assert = require('node:assert');
const { createServer, launch, openApp, importA1, waitSynced } = require('./helpers');

let server, browser;
test.before(async () => { server = await createServer(); browser = await launch(); });
test.after(async () => { await browser?.close(); await server?.cleanup(); });

test('only changed words are sent after an answer', async () => {
    const { page, context, errors } = await openApp(browser, server);
    await importA1(page);
    await waitSynced(page);
    assert.ok((await server.words()).length > 250);

    const bodies = [];
    page.on('request', r => { if (r.url().endsWith('/api/words/batch')) bodies.push(r.postData()); });
    await page.click('#start-training-btn');
    await page.keyboard.press('Space');
    await page.keyboard.press('3');
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');
    await waitSynced(page);
    const sent = JSON.parse(bodies[bodies.length - 1]);
    assert.equal(sent.upserts.length, 1, 'one answered word, not the whole deck');
    assert.ok(bodies[bodies.length - 1].length < 3000);
    assert.deepStrictEqual(errors, []);
    await context.close();
});

test('answers made while the server is down survive a reload', async () => {
    const { page, context, errors } = await openApp(browser, server);
    await waitSynced(page);
    const target = await page.evaluate(() => {
        const w = JSON.parse(localStorage.getItem('myWords')).find(x => x.original === 'hus');
        return w.id;
    });

    await server.stop();
    // Правим слово, пока сервер лежит.
    await page.click(`.card[data-id="${target}"] [data-action="edit-word"]`);
    await page.fill('#edit-ru', 'дом, здание (офлайн)');
    await page.click('[data-action="save-edit"]');
    await page.waitForTimeout(2000);   // синхронизация пыталась и не смогла
    const pending = await page.evaluate(() => JSON.parse(localStorage.getItem('pendingSync')));
    assert.ok(pending.ids.includes(target), 'the edit is remembered as unsynced');

    await server.start();
    await page.reload();
    await waitSynced(page);
    const onServer = (await server.words()).find(w => w.id === target);
    assert.equal(onServer.translate, 'дом, здание (офлайн)', 'the offline edit reached the server');
    const inBrowser = await page.evaluate(id => JSON.parse(localStorage.getItem('myWords')).find(x => x.id === id).translate, target);
    assert.equal(inBrowser, 'дом, здание (офлайн)', 'the reload did not overwrite it with the old server copy');
    assert.deepStrictEqual(errors, []);
    await context.close();
});

test('closing the tab right after an answer still saves it (sendBeacon)', async () => {
    const { page, context } = await openApp(browser, server);
    await waitSynced(page);
    await page.click('#start-training-btn');
    const answered = await page.evaluate(() => document.getElementById('card-front').textContent);
    await page.keyboard.press('Space');
    await page.keyboard.press('4');
    await page.waitForTimeout(150);          // отложенная синхронизация ещё не ушла
    await page.close({ runBeforeUnload: true });
    await new Promise(r => setTimeout(r, 800));
    const words = await server.words();
    const easy = words.filter(w => (w.history || []).some(h => h.q === 3));
    assert.equal(easy.length, 1, `the "easy" answer on «${answered}» must reach the server`);
    await context.close();
});

test('deleting a word deletes it on the server', async () => {
    const { page, context } = await openApp(browser, server);
    await waitSynced(page);
    const before = (await server.words()).length;
    await page.click('.card >> nth=0 >> [data-action="delete-word"]');
    await waitSynced(page);
    assert.equal((await server.words()).length, before - 1);
    await context.close();
});

test('re-importing A1 fills missing adjective forms, A2 adds new words', async () => {
    const { page, context, errors } = await openApp(browser, server);
    await importA1(page);
    await waitSynced(page);
    // Как у слов, добавленных до появления форм прилагательных: форм нет, прогресс есть.
    await page.evaluate(async () => {
        const { state, saveWords } = await import('/js/store.js');
        const w = state.words.find(x => x.original === 'stor');
        w.pos = ''; w.forms = {}; w.level = 3;
        saveWords();
    });
    await waitSynced(page);
    await page.click('[data-action="open-import"]');
    await page.click('#import-modal [data-action="import-a1"]');
    assert.match(await page.textContent('.confirm-box'), /дополнить/i);
    await page.click('.confirm-ok');
    await waitSynced(page);
    const stor = (await server.words()).find(w => w.original === 'stor');
    assert.equal(stor.pos, 'adj');
    assert.deepStrictEqual(stor.forms, { neuter: 'stort', plural: 'store' });
    assert.equal(stor.level, 3, 'progress is kept');

    const before = (await server.words()).length;
    await page.click('[data-action="open-import"]');
    await page.click('#import-modal [data-action="import-a2"]');
    await page.click('.confirm-ok');
    await waitSynced(page);
    const after = await server.words();
    assert.ok(after.length - before >= 300, `added ${after.length - before}`);
    assert.ok(after.some(w => w.tags.includes('A2')));
    assert.deepStrictEqual(errors, []);
    await context.close();
});
