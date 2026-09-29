// Инфраструктура браузерных тестов: сервер в отдельном процессе с временной
// базой и поддельным Piper, плюс Chromium через Playwright.
//
// Запуск: npm run test:e2e
// Нужен Chromium для Playwright: npx playwright install chromium
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

// Сервер, который можно остановить и поднять снова на той же базе и порту —
// так проверяется работа без сервера.
async function createServer() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tme-e2e-'));
    const port = await freePort();
    fs.writeFileSync(path.join(dir, 'voice.onnx'), 'fake');
    const env = {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(port),
        HOST: '127.0.0.1',
        DATABASE_PATH: path.join(dir, 'vocab.db'),
        PIPER_BIN: path.join(__dirname, 'wav-piper.js'),
        PIPER_WORKER: '',
        PIPER_MODEL: path.join(dir, 'voice.onnx'),
        TTS_CACHE_DIR: path.join(dir, 'tts-cache'),
        WAV_LOG: path.join(dir, 'piper.log'),
        ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
    };
    let child = null;

    const server = {
        url: `http://127.0.0.1:${port}`,
        dir,
        async start() {
            child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
            let log = '';
            child.stdout.on('data', d => { log += d; });
            child.stderr.on('data', d => { log += d; });
            for (let i = 0; i < 100; i++) {
                try {
                    const res = await fetch(`${server.url}/api/words`);
                    if (res.ok) return;
                } catch { /* ещё не слушает */ }
                await new Promise(r => setTimeout(r, 100));
            }
            throw new Error(`server did not start:\n${log}`);
        },
        async stop() {
            if (!child) return;
            const done = new Promise(r => child.once('exit', r));
            child.kill();
            await done;
            child = null;
        },
        async words() {
            return (await fetch(`${server.url}/api/words`)).json();
        },
        piperCalls() {
            try { return fs.readFileSync(env.WAV_LOG, 'utf8').trim().split('\n').filter(Boolean); }
            catch { return []; }
        },
        async cleanup() {
            await server.stop();
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
    await server.start();
    return server;
}

async function launch() {
    return chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
}

// Страница с перехватом звука: какие фразы проиграны с сервера и какие
// ушли в браузерный синтез речи.
async function openApp(browser, server, { context } = {}) {
    const ctx = context || await browser.newContext();
    await ctx.addInitScript(() => {
        window.__played = [];
        window.__browserSpeech = [];
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
            const p = play.call(this);
            const text = decodeURIComponent((this.src.split('text=')[1] || '').split('&')[0]);
            p.then(() => window.__played.push(text), () => window.__played.push('FAILED ' + text));
            return p;
        };
        if (window.speechSynthesis) {
            window.speechSynthesis.speak = (u) => window.__browserSpeech.push(u.text);
        }
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(server.url);
    await page.waitForFunction(() => document.getElementById('start-training-btn')?.textContent.length > 0);
    await page.waitForTimeout(300);
    return { page, context: ctx, errors };
}

async function importA1(page) {
    await page.click('[data-action="open-import"]');
    await page.click('#import-modal [data-action="import-a1"]');
    await page.click('.confirm-ok');
    await page.waitForSelector('#import-modal:not(.open)', { state: 'hidden' });
}

// Ждёт, пока все изменения дойдут до сервера.
async function waitSynced(page) {
    await page.waitForFunction(() => {
        const p = JSON.parse(localStorage.getItem('pendingSync') || '{"ids":[],"deleted":[]}');
        return p.ids.length === 0 && p.deleted.length === 0;
    }, null, { timeout: 10000 });
}

module.exports = { createServer, launch, openApp, importA1, waitSynced, ROOT };
