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

const { escapeHtml, escapeAttr, escapeJsString, jsAttr, normalizeAnswer, isSpellingMatch } =
    extract(['escapeHtml', 'escapeAttr', 'escapeJsString', 'jsAttr', 'normalizeAnswer', 'isSpellingMatch']);

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

test('jsAttr keeps a double quote from closing the onclick attribute', () => {
    // escapeJsString даёт \" — для HTML это не экранирование, атрибут закрывался.
    assert.ok(!jsAttr('a"b').includes('"'));
    assert.ok(!jsAttr("a'b").includes("'"));
    assert.ok(!jsAttr('<img>').includes('<'));
});

test('isSpellingMatch ignores case, extra spaces and trailing punctuation', () => {
    assert.ok(isSpellingMatch('  Дом. ', 'дом'));
    assert.ok(isSpellingMatch('ДОМ', 'дом'));
});

test('isSpellingMatch treats ё and е as the same letter', () => {
    assert.ok(isSpellingMatch('еж', 'ёж'));
});

test('isSpellingMatch accepts any of several listed translations', () => {
    assert.ok(isSpellingMatch('здание', 'дом, здание'));
    assert.ok(isSpellingMatch('жильё', 'дом; жильё'));
    assert.ok(isSpellingMatch('дом', 'дом / здание'));
});

test('isSpellingMatch rejects a wrong or empty answer', () => {
    assert.ok(!isSpellingMatch('кот', 'дом, здание'));
    assert.ok(!isSpellingMatch('', 'дом'));
    assert.ok(!isSpellingMatch('   ', 'дом'));
});

test('normalizeAnswer collapses whitespace', () => {
    assert.equal(normalizeAnswer('  god   morgen  '), 'god morgen');
});

// ---------------------------------------------------------------------------
// Регрессии, найденные при аудите. app.js — один скрипт без модулей, поэтому
// часть проверок — статические, по исходнику.
// ---------------------------------------------------------------------------
test('no function is declared twice (a later copy silently overrides the first)', () => {
    // Вторая getSortedWords перекрывала первую и выбрасывала фильтр по тегу.
    const names = [...SRC.matchAll(/^(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map(m => m[1]);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    assert.deepStrictEqual(dupes, []);
});

test('every onclick handler in index.html refers to a function that exists', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const called = new Set([...html.matchAll(/on(?:click|keydown|input)="(?:[^"]*?[;(])?\s*([A-Za-z_$][\w$]*)\(/g)].map(m => m[1]));
    const inlineScript = html.slice(html.lastIndexOf('<script>'));
    const builtins = new Set(['if', 'setTimeout', 'prompt', 'speak', 'event']);
    const missing = [...called].filter(fn =>
        !builtins.has(fn) &&
        !new RegExp(`function\\s+${fn}\\s*\\(`).test(SRC) &&
        !new RegExp(`function\\s+${fn}\\s*\\(`).test(inlineScript));
    assert.deepStrictEqual(missing, [], 'closeBulkTagModal когда-то вызывался, но не существовал');
});

test('speech is Norwegian Bokmål', () => {
    assert.match(SRC, /SPEECH_LANG\s*=\s*'nb-NO'/);
    assert.doesNotMatch(SRC, /en-US/);
});

test('the photo, video clip and YouGlish features are gone', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    for (const needle of ['imageUrl', 'loadCardImage', 'upload-image-btn', 'openClipModal', 'youglish', 'YouGlish']) {
        assert.ok(!SRC.includes(needle), `app.js still mentions ${needle}`);
        assert.ok(!html.includes(needle), `index.html still mentions ${needle}`);
    }
});
