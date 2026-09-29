// Импорт, экспорт, бэкап, восстановление и встроенная колода A1.
import { state, saveWords, saveStreak, saveActivity, syncNow } from './store.js';
import { normalizeWord } from './srs.js';
import { parseImport, toTxtLine, toCsv, toAnki } from './format.js';
import { downloadFile, dateStamp, plural } from './util.js';
import { $, showToast, showConfirm, openModal, closeModal } from './ui.js';
import { renderList } from './list.js';

const wordsWord = (n) => plural(n, ['слово', 'слова', 'слов']);

function addParsed(parsed, extraTags = []) {
    const now = Date.now();
    parsed.forEach((w, i) => {
        state.words.push(normalizeWord({
            ...w,
            tags: [...w.tags, ...extraTags],
            id: now + i,
            addedAt: now + i,   // сохраняем порядок: новые слова идут на тренировку по порядку колоды
            level: 0,
            nextReview: now,
        }));
    });
    saveWords();
    renderList();
}

export function importText(text) {
    const { words, duplicates } = parseImport(text, state.words);
    if (words.length) addParsed(words);
    if (words.length && duplicates.length) {
        showToast(`Добавлено ${words.length} ${wordsWord(words.length)}, пропущено повторов: ${duplicates.length}`, 'success');
    } else if (words.length) {
        showToast(`Добавлено ${words.length} ${wordsWord(words.length)}`, 'success');
    } else if (duplicates.length) {
        showToast('Новых слов нет — все уже в словаре', 'info');
    } else {
        showToast('Не нашёл ни одной строки вида «слово|перевод»', 'warning');
    }
    return words.length;
}

// Колода лежит в decks/a1.txt в обычном формате импорта — её можно
// читать и править руками.
export async function importA1Deck() {
    let text;
    try {
        const res = await fetch('/decks/a1.txt');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = await res.text();
    } catch {
        showToast('Не удалось загрузить колоду A1. Проверь, что сервер запущен.', 'error');
        return;
    }
    const { words, duplicates } = parseImport(text, state.words);
    if (!words.length) {
        showToast('Все слова колоды A1 уже есть в словаре', 'info');
        return;
    }
    const ok = await showConfirm(
        `Добавить колоду <b>Norsk A1</b>: ${words.length} ${wordsWord(words.length)}` +
        (duplicates.length ? ` (${duplicates.length} уже есть)` : '') +
        `?<br><small>Новые слова открываются по ${state.settings.newPerDay} в день — лимит меняется в ⚙️ настройках.</small>`,
        'Добавить', 'Отмена');
    if (!ok) return;
    addParsed(words, ['A1']);
    closeModal('import-modal');
    showToast(`Колода A1: добавлено ${words.length} ${wordsWord(words.length)}`, 'success', 5000);
}

function exportTxt() {
    downloadFile(`norsk_${dateStamp()}.txt`, state.words.map(toTxtLine).join('\n'));
}

function exportCsv() {
    downloadFile(`norsk_${dateStamp()}.csv`, toCsv(state.words), 'text/csv;charset=utf-8');
    showToast('CSV сохранён', 'success');
}

function exportAnki() {
    downloadFile(`norsk_anki_${dateStamp()}.txt`, toAnki(state.words));
    showToast('Файл для Anki готов: File → Import, разделитель — табуляция, поля — HTML', 'success', 6000);
}

function backup() {
    const data = {
        app: 'teach-me-norwegian',
        version: 2,
        exportedAt: new Date().toISOString(),
        words: state.words,
        settings: state.settings,
        streak: state.streak,
        activity: state.activity,
    };
    downloadFile(`norsk_backup_${dateStamp()}.json`, JSON.stringify(data, null, 2), 'application/json');
    showToast('Резервная копия сохранена', 'success');
}

async function restore(file) {
    let data;
    try {
        data = JSON.parse(await file.text());
        if (!data || !Array.isArray(data.words)) throw new Error('нет массива words');
    } catch {
        showToast('Это не похоже на JSON-бэкап приложения', 'error');
        return;
    }
    const words = data.words
        .filter(w => w && typeof w === 'object' && w.original && w.translate)
        .map(normalizeWord);
    const ok = await showConfirm(
        `Восстановить ${words.length} ${wordsWord(words.length)} из бэкапа?<br><small>Текущий словарь будет заменён.</small>`,
        'Восстановить', 'Отмена');
    if (!ok) return;
    state.words = words;
    if (data.streak) { state.streak = { ...state.streak, ...data.streak }; saveStreak(); }
    if (data.activity && typeof data.activity === 'object') { state.activity = data.activity; saveActivity(); }
    saveWords();
    await syncNow();
    renderList();
    showToast(`Восстановлено ${words.length} ${wordsWord(words.length)}`, 'success');
}

export const ioActions = {
    'open-import'() { openModal('import-modal'); },
    'import-text'() {
        const area = $('import-area');
        if (importText(area.value) > 0) {
            area.value = '';
            $('file-name').textContent = '';
            closeModal('import-modal');
        }
    },
    'import-a1'() { importA1Deck(); },
    'open-export'() { openModal('export-modal'); },
    'export-txt'() { exportTxt(); closeModal('export-modal'); },
    'export-csv'() { exportCsv(); closeModal('export-modal'); },
    'export-anki'() { exportAnki(); closeModal('export-modal'); },
    'backup'() { backup(); closeModal('export-modal'); },
    'restore'() { $('restore-input').click(); },
};

export function initIo() {
    $('file-upload')?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        $('file-name').textContent = `📄 ${file.name}`;
        file.text().then(text => { $('import-area').value = text; })
            .catch(() => showToast('Не удалось прочитать файл', 'error'));
        e.target.value = '';
    });
    $('restore-input')?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) restore(file);
    });
}
