#!/usr/bin/env node
// Поддельный tts_worker.py: тот же построчный JSON-протокол.
// Текст «CRASH» роняет процесс, «ERROR» — отвечает ошибкой.
// Журнал в FAKE_WORKER_LOG: 'start' при каждом запуске и текст каждого синтеза.
const fs = require('fs');
const readline = require('readline');
const log = (s) => process.env.FAKE_WORKER_LOG && fs.appendFileSync(process.env.FAKE_WORKER_LOG, s + '\n');

log('start');
if (process.env.FAKE_WORKER_BROKEN) process.exit(1);
process.stdout.write(JSON.stringify({ ready: true }) + '\n');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const req = JSON.parse(line);
    if (req.text === 'CRASH') process.exit(2);
    if (req.text === 'ERROR') {
        process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: 'bad text' }) + '\n');
        return;
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.write('WAVE', 8);
    fs.writeFileSync(req.out, Buffer.concat([header, Buffer.from(`WORKER:${req.text}:${req.length_scale}`.padEnd(200, '.'))]));
    log(`${req.text} @${req.length_scale}`);
    process.stdout.write(JSON.stringify({ id: req.id, ok: true }) + '\n');
});
