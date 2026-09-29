#!/usr/bin/env node
// Поддельный piper для тестов: принимает те же аргументы (-m модель -f файл),
// читает текст из stdin и пишет «WAV» — заголовок RIFF и сам текст.
// Каждый вызов дописывает строку в журнал FAKE_PIPER_LOG, чтобы тест мог
// посчитать, сколько раз реально вызывался синтез.
const fs = require('fs');
const args = process.argv.slice(2);
const out = args[args.indexOf('-f') + 1];
let text = '';
process.stdin.on('data', d => { text += d; });
process.stdin.on('end', () => {
    if (text.includes('FAIL')) {
        process.stderr.write('fake failure\n');
        process.exit(3);
    }
    const body = Buffer.from(`FAKE-AUDIO:${text.trim()}`.padEnd(200, '.'));
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.write('WAVE', 8);
    fs.writeFileSync(out, Buffer.concat([header, body]));
    if (process.env.FAKE_PIPER_LOG) fs.appendFileSync(process.env.FAKE_PIPER_LOG, text.trim() + '\n');
});
