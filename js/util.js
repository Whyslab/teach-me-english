// Общие помощники без зависимостей от DOM.

// ---------------------------------------------------------------------------
// Экранирование
//
// Интерфейс местами собирается строками и пишется через innerHTML. Слово,
// перевод, теги и примеры с Tatoeba — данные пользователя или стороннего
// сервиса; без экранирования они становятся разметкой.
// ---------------------------------------------------------------------------
export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function escapeAttr(value) {
    return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Текст с подсвеченными вхождениями term. Возвращает безопасный HTML.
export function highlightMatch(text, term) {
    const s = String(text ?? '');
    if (!term) return escapeHtml(s);
    const re = new RegExp(escapeRegex(term), 'gi');
    let out = '';
    let last = 0;
    for (const m of s.matchAll(re)) {
        if (!m[0]) break;
        out += escapeHtml(s.slice(last, m.index)) + `<mark>${escapeHtml(m[0])}</mark>`;
        last = m.index + m[0].length;
    }
    return out + escapeHtml(s.slice(last));
}

// ---------------------------------------------------------------------------
// Даты
// ---------------------------------------------------------------------------
export const DAY_MS = 24 * 60 * 60 * 1000;

export function toDayKey(date = new Date()) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// Разное
// ---------------------------------------------------------------------------
export function sanitizeTags(rawTags = []) {
    const set = new Set();
    for (const tag of rawTags) {
        const trimmed = String(tag || '').trim().slice(0, 50);
        if (trimmed) set.add(trimmed);
    }
    return [...set];
}

// 1 слово, 2 слова, 5 слов
export function plural(n, [one, few, many]) {
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 19) return many;
    const r = n % 10;
    if (r === 1) return one;
    if (r >= 2 && r <= 4) return few;
    return many;
}

export function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

export function downloadFile(filename, content, type = 'text/plain;charset=utf-8') {
    const blob = new Blob([content], { type });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

export function dateStamp() {
    return new Date().toLocaleDateString('ru-RU').replace(/\./g, '-');
}
