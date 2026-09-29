// Озвучка в браузере: звук с сервера (Piper), скорость речи, предзагрузка.
const test = require('node:test');
const assert = require('node:assert');
const { createServer, launch, openApp, importA1, waitSynced } = require('./helpers');

let server, browser;
test.before(async () => { server = await createServer(); browser = await launch(); });
test.after(async () => { await browser?.close(); await server?.cleanup(); });

test('words are spoken by the server voice, not by browser speech', async () => {
    const { page, context, errors } = await openApp(browser, server);
    await importA1(page);
    await waitSynced(page);
    await page.click('.card >> nth=0 >> [data-action="speak-word"]');
    await page.waitForFunction(() => window.__played.length > 0);
    const played = await page.evaluate(() => window.__played);
    assert.deepStrictEqual(played, ['en mann']);
    assert.deepStrictEqual(await page.evaluate(() => window.__browserSpeech), []);
    assert.deepStrictEqual(errors, []);
    await context.close();
});

test('the next cards are synthesized ahead of time', async () => {
    const { page, context } = await openApp(browser, server);
    await page.click('#start-training-btn');
    await page.waitForTimeout(1500);
    const calls = server.piperCalls();
    assert.ok(calls.length >= 3, `expected prefetch of the next cards, piper was called ${calls.length}×`);
    await context.close();
});

test('the speech-rate slider changes the synthesized speed', async () => {
    const { page, context } = await openApp(browser, server);
    await page.click('[data-action="open-settings"]');
    await page.locator('#set-rate').fill('0.8');
    assert.match(await page.textContent('#set-rate-label'), /0\.80.*медленнее/);
    await page.click('[data-action="test-rate"]');
    await page.waitForFunction(() => window.__played.some(t => t.startsWith('Hei!')));
    assert.ok(server.piperCalls().includes('Hei! Jeg lærer norsk. @1.25'), 'rate 0.8 → length_scale 1.25');
    await page.click('[data-action="save-settings"]');

    await page.click('.card >> nth=1 >> [data-action="speak-word"]');
    await page.waitForTimeout(800);
    assert.ok(server.piperCalls().some(c => c.startsWith('ei kvinne @1.25')), 'saved rate is used for words');
    await context.close();
});

test('without Piper the app falls back to browser speech', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const model = path.join(server.dir, 'voice.onnx');
    fs.renameSync(model, model + '.off');       // сервер больше не видит модель
    try {
        const { page, context } = await openApp(browser, server);
        await page.click('.card >> nth=0 >> [data-action="speak-word"]');
        await page.waitForTimeout(300);
        assert.deepStrictEqual(await page.evaluate(() => window.__browserSpeech), ['en mann']);
        await context.close();
    } finally {
        fs.renameSync(model + '.off', model);
    }
});
