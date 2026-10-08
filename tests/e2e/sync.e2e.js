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
    await page.keyboard.press('2');
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

    // Ловушка для редкой гонки (октябрь 2026: ~1 падение на 10–15 полных
    // прогонов под нагрузкой, причина не найдена). Если правка не дошла до
    // сервера, тест выводит хронологию запросов — по ней видно, кто и когда
    // прислал старую версию слова.
    const log = [];
    page.on('request', r => { if (r.url().includes('/api/')) log.push(`${Date.now() % 100000} REQ ${r.method()} ${r.url().split('/api/')[1]} ${(r.postData() || '').includes('офлайн') ? 'NEW' : (r.postData() || '').includes(String(target)) ? 'OLD!' : ''}`); });
    page.on('response', r => { if (r.url().includes('/api/')) log.push(`${Date.now() % 100000} RES ${r.status()} ${r.url().split('/api/')[1]}`); });
    page.on('console', m => log.push(`console ${m.type()} ${m.text()}`));
    await server.start();
    log.push(`${Date.now() % 100000} started; pending=${await page.evaluate(() => localStorage.getItem('pendingSync'))}`);
    await page.reload();
    log.push(`${Date.now() % 100000} reloaded; pending=${await page.evaluate(() => localStorage.getItem('pendingSync'))}`);
    await waitSynced(page);
    const onServer = (await server.words()).find(w => w.id === target);
    if (onServer.translate !== 'дом, здание (офлайн)') {
        throw new Error(`the offline edit did not reach the server; timeline:\n${log.join('\n')}`);
    }
    const inBrowser = await page.evaluate(id => JSON.parse(localStorage.getItem('myWords')).find(x => x.id === id).translate, target);
    assert.equal(inBrowser, 'дом, здание (офлайн)', 'the reload did not overwrite it with the old server copy');
    assert.deepStrictEqual(errors, []);
    await context.close();
});

test('closing the tab right after an answer still saves it (sendBeacon)', async () => {
    const { page, context } = await openApp(browser, server);
    await waitSynced(page);
    const rememberedBefore = (await server.words()).filter(w => (w.history || []).some(h => h.q === 2)).length;
    await page.click('#start-training-btn');
    const answered = await page.evaluate(() => document.getElementById('card-front').textContent);
    await page.keyboard.press('Space');
    await page.keyboard.press('2');
    await page.waitForTimeout(150);          // отложенная синхронизация ещё не ушла
    await page.close({ runBeforeUnload: true });
    await new Promise(r => setTimeout(r, 800));
    const words = await server.words();
    const remembered = words.filter(w => (w.history || []).some(h => h.q === 2));
    assert.equal(remembered.length, rememberedBefore + 1, `the "remember" answer on «${answered}» must reach the server`);
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

// Телефон и компьютер — два разных браузера с общим сервером.
test('settings and answers made on one device show up on another', async () => {
    const a = await openApp(browser, server);
    await waitSynced(a.page);
    await a.page.click('[data-action="open-settings"]');
    await a.page.fill('#set-goal', '7');
    await a.page.click('[data-action="save-settings"]');
    await a.page.click('#start-training-btn');
    await a.page.keyboard.press('Space');
    await a.page.keyboard.press('2');
    await a.page.waitForTimeout(400);
    await a.page.keyboard.press('Escape');
    const answered = await a.page.evaluate(() => Number(document.getElementById('daily-count').textContent));
    await a.page.waitForResponse(r => r.url().endsWith('/api/state'), { timeout: 5000 });

    const b = await openApp(browser, server);   // свой контекст — пустой localStorage
    await waitSynced(b.page);
    // Ловушка для той же редкой гонки: при падении — что видят сервер и оба устройства.
    try {
        await b.page.waitForFunction(() => document.getElementById('daily-goal').textContent === '7', null, { timeout: 8000 });
    } catch (e) {
        const srv = await (await fetch(`${server.url}/api/state`)).json();
        const bs = await b.page.evaluate(() => localStorage.getItem('settings'));
        const as = await a.page.evaluate(() => localStorage.getItem('settings'));
        throw new Error(`device B did not get the settings: server=${JSON.stringify(srv.settings)} B=${bs} A=${as} errorsB=${JSON.stringify(b.errors)}`);
    }
    assert.equal(await b.page.evaluate(() => Number(document.getElementById('daily-count').textContent)), answered,
        'today\'s answers come from the server');
    assert.deepStrictEqual([...a.errors, ...b.errors], []);
    await a.context.close();
    await b.context.close();
});
