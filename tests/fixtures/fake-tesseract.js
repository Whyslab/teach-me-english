#!/usr/bin/env node
// Поддельный tesseract для тестов: читает картинку со stdin и печатает
// текст из FAKE_OCR_TEXT (или падает, если FAKE_OCR_FAIL=1).
process.stdin.resume();
process.stdin.on('end', () => {
    if (process.env.FAKE_OCR_FAIL === '1') {
        process.stderr.write('Error in pixReadMem\n');
        process.exit(1);
    }
    process.stdout.write(process.env.FAKE_OCR_TEXT || '');
});
