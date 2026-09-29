#!/usr/bin/env node
// Поддельный piper для браузерных тестов: пишет настоящий WAV (0,3 с тона),
// чтобы браузер мог его проиграть. Журнал вызовов — в WAV_LOG.
const fs = require('fs');
const args = process.argv.slice(2);
const out = args[args.indexOf('-f') + 1];
let text = '';
process.stdin.on('data', d => { text += d; });
process.stdin.on('end', () => {
    const rate = 16000;
    const n = Math.round(rate * 0.3);
    const data = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(6000 * Math.sin(2 * Math.PI * 440 * i / rate)), i * 2);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(data.length, 40);
    fs.writeFileSync(out, Buffer.concat([h, data]));
    const ls = args.includes('--length-scale') ? args[args.indexOf('--length-scale') + 1] : '';
    if (process.env.WAV_LOG) fs.appendFileSync(process.env.WAV_LOG, `${text.trim()}${ls ? ' @' + ls : ''}\n`);
});
