// Норвежский (букмол): грамматика, проверка ответов, ссылки на словари.
// Модуль без DOM — его функции тестируются напрямую.

export const GENDERS = {
    m: { article: 'en', label: 'hankjønn', ru: 'мужской' },
    f: { article: 'ei', label: 'hunkjønn', ru: 'женский' },
    n: { article: 'et', label: 'intetkjønn', ru: 'средний' },
};

export const POS = {
    noun: 'существительное',
    verb: 'глагол',
    other: 'другое',
};

// Подписи форм. Порядок важен: так формы хранятся и импортируются.
export const NOUN_FORMS = [
    ['defSg',   'bestemt entall',   'опр. ед.'],
    ['indefPl', 'ubestemt flertall', 'неопр. мн.'],
    ['defPl',   'bestemt flertall', 'опр. мн.'],
];
export const VERB_FORMS = [
    ['present', 'presens',    'настоящее'],
    ['past',    'preteritum', 'прошедшее'],
    ['perfect', 'perfektum',  'перфект'],
];

export function formsFor(pos) {
    if (pos === 'noun') return NOUN_FORMS;
    if (pos === 'verb') return VERB_FORMS;
    return [];
}

const VOWELS = /[aeiouyæøå]+/gi;

// Убирает ведущий артикль (en/ei/et) или частицу инфинитива (å).
export function stripParticle(word) {
    return String(word || '').trim().replace(/^(?:en|ei|et|å)\s+/i, '');
}

// Слово с артиклем для показа: «et hus», «å reise».
export function displayWord(word) {
    const base = String(word?.original || '').trim();
    if (word?.pos === 'noun' && GENDERS[word.gender]) {
        return `${GENDERS[word.gender].article} ${stripParticle(base)}`;
    }
    return base;
}

// Строка форм для обратной стороны карточки:
// «huset · hus · husene», «reiser · reiste · har reist».
export function formsLine(word) {
    const forms = word?.forms || {};
    return formsFor(word?.pos)
        .map(([key]) => forms[key])
        .filter(Boolean)
        .join(' · ');
}

// ---------------------------------------------------------------------------
// Подсказка форм по правилам
//
// Только регулярные случаи — неправильных слов в норвежском много (bok → bøker,
// mann → menn). Интерфейс подаёт результат как подсказку, которую надо
// проверить в Ordbøkene, а не как истину.
// ---------------------------------------------------------------------------
function syllables(word) {
    return (word.match(VOWELS) || []).length;
}

export function guessNounForms(lemma, gender) {
    const base = stripParticle(lemma).toLowerCase();
    if (!base || !GENDERS[gender] || /\s/.test(base)) return null;
    const endsE = base.endsWith('e');

    let defSg;
    if (gender === 'm') defSg = endsE ? base + 'n' : base + 'en';
    else if (gender === 'f') defSg = endsE ? base.slice(0, -1) + 'a' : base + 'a';
    else defSg = endsE ? base + 't' : base + 'et';

    let indefPl;
    if (gender === 'n' && !endsE && syllables(base) === 1) indefPl = base;
    else indefPl = endsE ? base + 'r' : base + 'er';

    const defPl = endsE ? base + 'ne' : base + 'ene';
    return { defSg, indefPl, defPl };
}

// Для глаголов надёжно угадывается только presens: инфинитив + r.
// Прошедшее время зависит от группы спряжения (-et, -te, -dde, сильные).
export function guessVerbForms(lemma) {
    const base = stripParticle(lemma).toLowerCase();
    if (!base || /\s/.test(base)) return null;
    return { present: base + 'r' };
}

// ---------------------------------------------------------------------------
// Проверка ответа
// ---------------------------------------------------------------------------
export function normalizeAnswer(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[’`´]/g, "'")
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.!?…]+$/, '')
        .trim();
}

// æ → ae, ø → o, å → a: чтобы отличить «почти верно, но без норвежских букв».
export function foldNorwegian(value) {
    return normalizeAnswer(value)
        .replace(/æ/g, 'ae')
        .replace(/[øö]/g, 'o')
        .replace(/[åä]/g, 'a');
}

function variants(expected) {
    const whole = normalizeAnswer(expected);
    const parts = String(expected || '')
        .split(/[,;/]/)
        .map(normalizeAnswer)
        .filter(Boolean);
    return [...new Set([whole, ...parts].filter(Boolean))];
}

// Результат: 'correct' | 'letters' (верно, если не считать æ ø å) | 'wrong'.
// Перевод часто перечисляет варианты через запятую — засчитывается любой.
// Для норвежского ответа артикль и «å» необязательны: «hus» = «et hus».
export function checkAnswer(input, expected, { norwegian = false } = {}) {
    const answer = normalizeAnswer(input);
    if (!answer) return 'wrong';

    const expectedList = variants(expected);
    const strip = norwegian ? stripParticle : (s) => s;
    const a = strip(answer);
    if (expectedList.some(v => v === answer || strip(v) === a)) return 'correct';

    if (norwegian) {
        const fa = foldNorwegian(a);
        if (expectedList.some(v => foldNorwegian(strip(v)) === fa)) return 'letters';
    }
    return 'wrong';
}

export function isSpellingMatch(input, expected, opts) {
    return checkAnswer(input, expected, opts) === 'correct';
}

// Род: для женского рода в букмоле допустим и «en» (en jente = ei jente).
export function checkGender(chosen, gender) {
    if (chosen === gender) return 'correct';
    if (gender === 'f' && chosen === 'm') return 'also';
    return 'wrong';
}

// ---------------------------------------------------------------------------
// Словари
// ---------------------------------------------------------------------------
export function lookupUrls(original) {
    const w = encodeURIComponent(stripParticle(original).toLowerCase());
    return {
        forvo: `https://forvo.com/word/${w}/#no`,
        ordbok: `https://ordbokene.no/nob/bm/${w}`,
    };
}
