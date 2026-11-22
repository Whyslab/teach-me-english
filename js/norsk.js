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
    adj: 'прилагательное',
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

// Прилагательное: stor — stort (с существительным среднего рода) — store
// (множественное число и определённая форма: store hus, det store huset).
export const ADJ_FORMS = [
    ['neuter', 'intetkjønn', 'ср. род'],
    ['plural', 'flertall / bestemt', 'мн. ч. и опр.'],
];

export function formsFor(pos) {
    if (pos === 'noun') return NOUN_FORMS;
    if (pos === 'verb') return VERB_FORMS;
    if (pos === 'adj') return ADJ_FORMS;
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

// Прилагательные: stor → stort, store. Правила:
//   -ig, -isk, -sk, -e и уже на -t — в среднем роде не меняются (viktig, norsk, moderne, lett);
//   односложные на гласную — +tt (ny → nytt, blå → blått);
//   двойная согласная упрощается (grønn → grønt, grønne);
//   двусложные на -el/-en/-er теряют e во мн. ч. (gammel → gamle, sulten → sultne).
// Неправильные (liten → lite, små; god → godt) проверяй в Ordbøkene.
// Глаголам подсказки нет: надёжно угадывается только presens, а прошедшее
// время зависит от группы спряжения — такая «подсказка» чаще путала.
// Частые неправильные прилагательные — по правилам их не угадать.
const IRREGULAR_ADJ = {
    liten: { neuter: 'lite', plural: 'små' },
    glad: { neuter: 'glad', plural: 'glade' },
    egen: { neuter: 'eget', plural: 'egne' },
    annen: { neuter: 'annet', plural: 'andre' },
    blå: { neuter: 'blått', plural: 'blå' },
    grå: { neuter: 'grått', plural: 'grå' },
};
// Прилагательные национальности на -sk не меняются в среднем роде (et norsk ord),
// в отличие от прочих на -sk (frisk → friskt).
const NATIONALITY_SK = /^(norsk|svensk|dansk|engelsk|tysk|fransk|russisk|polsk|spansk|italiensk|amerikansk|finsk|islandsk)$/;

export function guessAdjForms(lemma) {
    const base = stripParticle(lemma).toLowerCase();
    if (!base || /\s/.test(base)) return null;
    if (IRREGULAR_ADJ[base]) return { ...IRREGULAR_ADJ[base] };
    const vowelEnd = /[aeiouyæøå]$/.test(base);
    const doubled = base.match(/([bdfgklmnprstv])\1$/);
    let neuter;
    if (/(ig|e)$/.test(base) || (/isk$/.test(base) && syllables(base) >= 2) || NATIONALITY_SK.test(base)) neuter = base;
    else if (/[aeiouyæøå]t$/.test(base)) neuter = base + 't';       // hvit → hvitt, søt → søtt
    else if (base.endsWith('t')) neuter = base;                       // svart, kort, lett
    else if (vowelEnd && syllables(base) === 1) neuter = base + 'tt';
    else if (doubled) neuter = base.slice(0, -1) + 't';
    else neuter = base + 't';

    let plural;
    if (base.endsWith('e') || base.endsWith('å')) plural = base;
    else if (syllables(base) >= 2 && /e[lnr]$/.test(base)) {
        const stem = base.slice(0, -2) + base.slice(-1);          // gammel → gamml
        plural = stem.replace(/([bdfgklmnprstv])\1(?=[lnr]$)/, '$1') + 'e';   // → gamle
    } else plural = base + 'e';
    return { neuter, plural };
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

// Одна правка: лишняя, пропущенная, заменённая буква или две соседние местами.
function oneEdit(a, b) {
    if (a === b) return false;
    if (Math.abs(a.length - b.length) > 1) return false;
    if (a.length === b.length) {
        const diff = [];
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
        if (diff.length === 1) return true;
        return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]];
    }
    const [s, l] = a.length < b.length ? [a, b] : [b, a];
    let i = 0;
    while (i < s.length && s[i] === l[i]) i++;
    return s.slice(i) === l.slice(i + 1);
}

// Результат: 'correct' | 'letters' (верно, если не считать æ ø å)
// | 'typo' (одна опечатка; только с typos: true) | 'wrong'.
// Опечатка — в словах от 5 букв (норвежских — от 6): в коротких одна буква
// меняет слово (hus/hos, кот/кит).
// Перевод часто перечисляет варианты через запятую — засчитывается любой.
// Для норвежского ответа артикль и «å» необязательны: «hus» = «et hus».
export function checkAnswer(input, expected, { norwegian = false, typos = false } = {}) {
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
    if (typos) {
        const min = norwegian ? 6 : 5;
        if (expectedList.some(v => strip(v).length >= min && oneEdit(a, strip(v)))) return 'typo';
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
// Предложение с пропуском
//
// Ищет в примере само слово или любую его форму («Boka ligger på bordet» для
// ei bok → «Boka»; «Vi går hjem» для å gå → «går») и вырезает его.
// Возвращает { before, answer, after } или null, если слова в примере нет.
// ---------------------------------------------------------------------------
function escapeForRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function makeCloze(word) {
    const sentence = String(word?.example || '');
    if (!sentence) return null;
    const candidates = [...new Set([stripParticle(word.original), ...Object.values(word.forms || {})]
        .map(s => String(s || '').trim())
        .filter(Boolean))]
        .sort((a, b) => b.length - a.length);   // «har reist» раньше, чем «reist»
    for (const c of candidates) {
        const re = new RegExp(`(^|[^\\p{L}])(${escapeForRegex(c)})(?![\\p{L}])`, 'iu');
        const m = sentence.match(re);
        if (!m) continue;
        const start = m.index + m[1].length;
        return {
            before: sentence.slice(0, start),
            answer: sentence.slice(start, start + m[2].length),
            after: sentence.slice(start + m[2].length),
        };
    }
    return null;
}

// ---------------------------------------------------------------------------
// «Собери предложение»
// ---------------------------------------------------------------------------
// Слова предложения без знаков препинания. Первое слово — со строчной буквы:
// заглавная сразу выдала бы, с чего начинается предложение, а весь смысл
// упражнения — порядок слов (I dag går jeg, а не I dag jeg går).
export function orderTokens(sentence) {
    const words = String(sentence || '').trim().split(/\s+/)
        .map(w => w.replace(/^[«"'(\[]+|[.,!?:;…»"')\]]+$/gu, ''))
        .filter(Boolean);
    const first = words[0];
    if (first && first.slice(1) === first.slice(1).toLowerCase()) {
        words[0] = first.charAt(0).toLowerCase() + first.slice(1);
    }
    return words;
}

// Совпадает ли собранный порядок с правильным. Одинаковые слова
// взаимозаменяемы, регистр не важен.
export function sameOrder(picked, answer) {
    const norm = (list) => list.map(w => String(w).toLowerCase()).join(' ');
    return picked.length === answer.length && norm(picked) === norm(answer);
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

// ---------------------------------------------------------------------------
// Подсказка-правило после ошибки в роде или форме — одна-две строки.
// Грамматика идёт через слова: правило показывается на том слове, где ошибся.
// kind: 'gender' | 'forms'; key — какая форма (defSg, past, neuter…).
// ---------------------------------------------------------------------------
export function grammarHint(word, kind, key = '') {
    const lemma = stripParticle(word.original || '').toLowerCase();
    if (kind === 'gender') {
        if (/(het|sjon|ing|dom|skap)$/.test(lemma) && word.gender !== 'n') {
            return 'Слова на -het, -sjon, -dom почти всегда en; на -ing — en или ei.';
        }
        if (/(um|ment|eri)$/.test(lemma) && word.gender === 'n') return 'Слова на -um, -ment, -eri обычно et.';
        if (word.gender === 'n') return `et-слово: определённая форма на -et (${lemma}et), учи вместе с артиклем: «et ${lemma}».`;
        if (word.gender === 'f') return `ei-слово: определённая форма на -a (${lemma.replace(/e$/, '')}a). Можно и как en — это не ошибка.`;
        if (word.gender === 'm') return `en-слово: определённая форма на -en (${lemma.replace(/e$/, '')}en). Большинство слов — en.`;
        return '';
    }
    if (word.pos === 'noun') {
        if (key === 'defSg') {
            return word.gender === 'n' ? 'Определённая форма et-слова: + -et (et hus → huset).'
                : word.gender === 'f' ? 'Определённая форма ei-слова: + -a (ei jente → jenta).'
                : 'Определённая форма en-слова: + -en (en bil → bilen).';
        }
        if (key === 'indefPl') {
            return word.gender === 'n' && syllables(lemma) <= 1
                ? 'Односложное et-слово во мн. ч. без окончания: et hus → hus.'
                : 'Неопределённое мн. ч.: + -er (en bil → biler). Односложные et-слова — без окончания.';
        }
        if (key === 'defPl') return 'Определённое мн. ч.: + -ene (bilene, husene). Исключения: barna, beina.';
    }
    if (word.pos === 'verb') {
        if (key === 'present') return 'Настоящее время: инфинитив + -r (å lese → leser), одна форма для всех лиц.';
        if (key === 'past' || key === 'perfect') {
            return 'Прошедшее зависит от группы: -et/-a (snakket), -te (spiste), -de (prøvde), -dde (bodde) или сильный глагол (drakk) — учи вместе с глаголом.';
        }
    }
    if (word.pos === 'adj') {
        if (key === 'neuter') return 'С et-словом прилагательное получает -t: stor → et stort hus.';
        if (key === 'plural') return 'Мн. ч. и определённая форма: + -e (store hus, det store huset).';
    }
    return '';
}
