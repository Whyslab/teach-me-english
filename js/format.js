// Текстовые форматы словаря: импорт, TXT, CSV, Anki. Без DOM — тестируется напрямую.
//
// Строка импорта/экспорта TXT:
//   слово|перевод|пример|перевод примера|теги|грамматика|формы
// грамматика: en / ei / et — существительное этого рода, v — глагол, пусто — нет.
// формы: через запятую, в порядке formsFor(pos):
//   существительное — опр. ед., неопр. мн., опр. мн.   (huset, hus, husene)
//   глагол          — presens, preteritum, perfektum   (reiser, reiste, har reist)
// Обязательны только первые два поля.
import { GENDERS, formsFor, stripParticle } from './norsk.js';
import { sanitizeTags, escapeHtml } from './util.js';

const ARTICLE_TO_GENDER = Object.fromEntries(Object.entries(GENDERS).map(([g, v]) => [v.article, g]));

function parseGrammar(field) {
    const f = String(field || '').trim().toLowerCase();
    if (ARTICLE_TO_GENDER[f]) return { pos: 'noun', gender: ARTICLE_TO_GENDER[f] };
    if (f === 'n' || f === 'noun' || f === 'subst') return { pos: 'noun', gender: '' };
    if (f === 'v' || f === 'verb') return { pos: 'verb', gender: '' };
    if (f === 'other' || f === '-') return { pos: 'other', gender: '' };
    return { pos: '', gender: '' };
}

function grammarField(w) {
    if (w.pos === 'noun') return GENDERS[w.gender]?.article || 'noun';
    if (w.pos === 'verb') return 'v';
    return '';
}

export function parseImportLine(line) {
    const parts = String(line).split('|').map(p => p.trim());
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    let { pos, gender } = parseGrammar(parts[5]);
    let original = parts[0].slice(0, 100);

    // «et hus|дом» без шестого поля — род понятен из артикля.
    const article = original.match(/^(en|ei|et)\s+(\S.*)$/i);
    if (article && !pos) {
        pos = 'noun';
        gender = ARTICLE_TO_GENDER[article[1].toLowerCase()];
    }
    if (pos === 'noun') original = stripParticle(original);
    if (!pos && /^å\s+\S/i.test(original)) pos = 'verb';

    const forms = {};
    const values = String(parts[6] || '').split(',').map(s => s.trim());
    formsFor(pos).forEach(([key], i) => { if (values[i]) forms[key] = values[i].slice(0, 60); });

    return {
        original,
        translate: parts[1].slice(0, 500),
        example: parts[2] || '',
        exampleTranslate: parts[3] || '',
        tags: sanitizeTags((parts[4] || '').split(',')),
        pos, gender, forms,
    };
}

// Ключ повтора: написание без артикля и без учёта регистра плюс «существительное
// или нет». Иначе омонимы вроде «et tre» (дерево) и «tre» (три) склеивались бы.
export function dedupeKey(original, pos = '') {
    return `${stripParticle(original).toLowerCase()}|${pos === 'noun' ? 'n' : ''}`;
}

// Разбирает текст импорта. Слова, уже существующие в словаре, и повторы
// внутри текста пропускаются. existing — слова ({original, pos}) или строки.
export function parseImport(text, existing = []) {
    const seen = new Set([...existing].map(w => typeof w === 'string' ? dedupeKey(w) : dedupeKey(w.original, w.pos)));
    const words = [];
    const duplicates = [];
    for (const line of String(text).split(/\r?\n/)) {
        if (!line.trim() || line.trim().startsWith('#')) continue;
        const w = parseImportLine(line);
        if (!w) continue;
        const key = dedupeKey(w.original, w.pos);
        if (seen.has(key)) { duplicates.push(w.original); continue; }
        seen.add(key);
        words.push(w);
    }
    return { words, duplicates };
}

const clean = (s) => String(s ?? '').replace(/[|\r\n]+/g, ' ').trim();

export function toTxtLine(w) {
    const forms = formsFor(w.pos).map(([k]) => clean(w.forms?.[k]).replace(/,/g, ' ')).join(',');
    const fields = [
        clean(w.original), clean(w.translate), clean(w.example), clean(w.exampleTranslate),
        (w.tags || []).map(clean).join(','), grammarField(w), forms.replace(/,+$/, ''),
    ];
    while (fields.length > 2 && !fields[fields.length - 1]) fields.pop();
    return fields.join('|');
}

export function toCsv(words) {
    const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const header = ['Слово', 'Род/часть речи', 'Перевод', 'Формы', 'Пример', 'Перевод примера', 'Теги', 'Уровень', 'Следующее повторение'];
    const rows = words.map(w => [
        esc(w.original), esc(grammarField(w)), esc(w.translate),
        esc(formsFor(w.pos).map(([k]) => w.forms?.[k]).filter(Boolean).join(', ')),
        esc(w.example), esc(w.exampleTranslate), esc((w.tags || []).join('; ')),
        w.level || 0, w.nextReview ? new Date(w.nextReview).toLocaleDateString('ru-RU') : '',
    ].join(','));
    // BOM — чтобы Excel открыл UTF-8 с русскими и норвежскими буквами.
    return '﻿' + [header.map(esc).join(','), ...rows].join('\n');
}

// Anki: «лицо<TAB>оборот<TAB>теги». Поля — HTML, поэтому данные экранируются.
export function toAnki(words) {
    const c = (s) => escapeHtml(String(s ?? '').replace(/[\t\r\n]+/g, ' '));
    return words.map(w => {
        const article = w.pos === 'noun' && GENDERS[w.gender] ? GENDERS[w.gender].article + ' ' : '';
        const forms = formsFor(w.pos).map(([k]) => w.forms?.[k]).filter(Boolean).join(' · ');
        let front = c(article + w.original);
        if (forms) front += `<br><small>${c(forms)}</small>`;
        if (w.example) front += `<br><small><i>${c(w.example)}</i></small>`;
        let back = c(w.translate);
        if (w.exampleTranslate) back += `<br><small><i>${c(w.exampleTranslate)}</i></small>`;
        const tags = (w.tags || []).map(t => t.replace(/\s+/g, '_')).join(' ');
        return `${front}\t${back}${tags ? '\t' + c(tags) : ''}`;
    }).join('\n');
}
