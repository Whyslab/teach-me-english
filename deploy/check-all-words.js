#!/usr/bin/env node
// Разовая проверка всей колоды тем же способом, что кнопка «🚩 Сомневаюсь»:
// перевод и пример — ИИ, род и формы — словарь. Только читает: слова берёт
// с сервера (GET /api/words), ничего не меняет. Печатает отчёт в Markdown —
// спорные карточки с предложенной правкой; применять — в приложении.
//
//   node deploy/check-all-words.js [--url http://127.0.0.1:3000] [--limit N] > отчёт.md
const check = require('../check');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const url = opt('--url', 'http://127.0.0.1:3000');
const limit = Number(opt('--limit', 0)) || Infinity;

const FIELD = { translate: 'перевод', example: 'пример', exampleTranslate: 'перевод примера', gender: 'род', forms: 'формы' };
const show = (k, v) => k === 'forms' ? Object.values(v || {}).join(' · ') : k === 'gender' ? ({ m: 'en', f: 'ei', n: 'et' }[v] || '—') : (v || '—');

(async () => {
    const words = (await (await fetch(`${url}/api/words`)).json()).slice(0, limit);
    const bad = [];
    let unchecked = 0;
    for (const [i, w] of words.entries()) {
        process.stderr.write(`\r${i + 1}/${words.length} ${w.original}            `);
        let r;
        try { r = await check.checkWord(w); } catch (e) { r = { ok: true, checkedBy: {}, error: e.message }; }
        if (!r.checkedBy?.ai && !r.checkedBy?.dictionary) { unchecked++; continue; }
        if (!r.ok) bad.push({ w, r });
    }
    process.stderr.write('\n');
    const out = [];
    out.push(`# Проверка колоды — ${new Date().toLocaleString('ru-RU')}`, '');
    out.push(`Слов: ${words.length}. Спорных: ${bad.length}. Не удалось проверить: ${unchecked}.`, '');
    out.push('Перевод и пример проверял ИИ, род и формы — словарь Ordbøkene. ИИ тоже ошибается: правку применять в приложении кнопкой «🚩 Сомневаюсь» (у слова в разделе «Слова»), если согласен.', '');
    for (const { w, r } of bad) {
        out.push(`## ${w.original} — ${w.translate}`);
        for (const s of r.issues) out.push(`- ${s}`);
        for (const [k, v] of Object.entries(r.fix || {})) out.push(`- **${FIELD[k] || k}:** ${show(k, w[k])} → ${show(k, v)}`);
        out.push('');
    }
    console.log(out.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
