// Тесты чистых функций из app.js.
//
// app.js писался как один браузерный скрипт без модульной системы, поэтому
// подключить его через require() нельзя: он сразу лезет в document. Вместо
// этого вырезаем нужные объявления функций по фигурным скобкам и исполняем их
// изолированно. Способ грубоватый, но он даёт покрытие ровно там, где раньше
// его не было вообще, не требуя переписывать весь фронтенд.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function extract(names) {
    let code = '';
    for (const name of names) {
        const start = SRC.indexOf(`function ${name}(`);
        assert.notStrictEqual(start, -1, `функция ${name} не найдена в app.js`);
        let i = SRC.indexOf('{', start);
        let depth = 0;
        do {
            if (SRC[i] === '{') depth++;
            else if (SRC[i] === '}') depth--;
            i++;
        } while (depth > 0);
        code += SRC.slice(start, i) + '\n';
    }
    code += `module.exports = {${names.join(',')}};`;
    const mod = { exports: {} };
    new Function('module', 'URLSearchParams', code)(mod, URLSearchParams);
    return mod.exports;
}

const { escapeHtml, escapeAttr, escapeJsString, buildClipEmbedUrl } =
    extract(['escapeHtml', 'escapeAttr', 'escapeJsString', 'buildClipEmbedUrl']);

test('escapeHtml neutralises a script tag', () => {
    assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('escapeHtml replaces the ampersand first, so nothing is double-encoded', () => {
    assert.equal(escapeHtml('&lt;'), '&amp;lt;');
});

test('escapeHtml survives null and undefined', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
});

test('escapeAttr closes the quote-breakout that escapeHtml alone leaves open', () => {
    assert.equal(escapeAttr('" onerror="alert(1)'), '&quot; onerror=&quot;alert(1)');
    assert.equal(escapeAttr("' onerror='alert(1)"), '&#39; onerror=&#39;alert(1)');
});

test('escapeJsString escapes quotes and backslashes', () => {
    assert.equal(escapeJsString("it's"), "it\\'s");
    assert.equal(escapeJsString('a\\b'), 'a\\\\b');
    assert.equal(escapeJsString('say "hi"'), 'say \\"hi\\"');
});

test('escapeJsString breaks up a closing script tag', () => {
    // Иначе строка внутри inline-обработчика могла бы закрыть сам <script>.
    assert.equal(escapeJsString('</script>'), '\\x3C/script>');
});

test('escapeJsString flattens newlines, which would end the statement', () => {
    assert.equal(escapeJsString('a\nb'), 'a b');
    assert.equal(escapeJsString('a\r\nb'), 'a b');
});

test('buildClipEmbedUrl uses the no-cookie domain and rounds the window outward', () => {
    const url = buildClipEmbedUrl({ videoId: 'dQw4w9WgXcQ', startTime: 12.7, endTime: 18.2 });
    assert.ok(url.startsWith('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?'));
    // Начало округляем вниз, конец вверх — иначе слово обрежется по краям.
    assert.match(url, /start=12/);
    assert.match(url, /end=19/);
});

test('buildClipEmbedUrl omits end when it is not after start', () => {
    const url = buildClipEmbedUrl({ videoId: 'dQw4w9WgXcQ', startTime: 30, endTime: 10 });
    assert.doesNotMatch(url, /end=/);
});

test('buildClipEmbedUrl clamps a negative start to zero', () => {
    const url = buildClipEmbedUrl({ videoId: 'dQw4w9WgXcQ', startTime: -5 });
    assert.match(url, /start=0/);
});

test('the clip badge is a real button, not an inert span', () => {
    // Регрессия: значок 🎬 годами рендерился как <span> без обработчика —
    // README обещал фрагменты видео, а нажать на них было нельзя.
    assert.ok(SRC.includes('openClipModal'), 'openClipModal не вызывается из разметки карточки');
    assert.match(SRC, /hasVideo[\s\S]{0,400}openClipModal/, 'значок 🎬 не открывает плеер');
});

test('the video id is validated before it reaches a URL', () => {
    assert.match(SRC, /\[A-Za-z0-9_-\]\{11\}/, 'нет проверки формата videoId');
});
