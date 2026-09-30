// Карточка: обычные карточки, письмо в обе стороны и диктант.
import { state } from './store.js';
import { displayWord, formsLine, lookupUrls } from './norsk.js';
import { $ } from './ui.js';
import { t } from './session.js';

// Какая сторона сверху. В карточках — по настройке «сторона вопроса»,
// в письме и диктанте — по смыслу режима.
function norwegianOnFront() {
    switch (t.mode) {
        case 'write-no-ru': return true;
        case 'write-ru-no': return false;
        case 'dictation': return false;       // сверху — значок наушников, слово на обороте
        default: {
            const dir = state.settings.cardsDir;
            if (dir === 'no-ru') return true;
            if (dir === 'ru-no') return false;
            return Math.random() < 0.5;
        }
    }
}

export function renderCard(w) {
    const card = $('flashcard');
    card.classList.remove('is-flipped', 'flash-correct', 'flash-wrong');
    t.noFront = norwegianOnFront();

    const no = displayWord(w);
    const front = $('card-front');
    const back = $('card-back-text');
    if (t.mode === 'dictation') {
        front.textContent = '🎧';
        front.lang = '';
        back.textContent = `${no} — ${w.translate}`;
        back.lang = 'nb';
    } else {
        front.textContent = t.noFront ? no : w.translate;
        front.lang = t.noFront ? 'nb' : 'ru';
        back.textContent = t.noFront ? w.translate : no;
        back.lang = t.noFront ? 'ru' : 'nb';
    }

    const forms = formsLine(w);
    $('card-forms').textContent = forms;
    $('card-forms').hidden = !forms;
    $('card-example').textContent = w.example || '';
    $('card-example-translate').textContent = w.exampleTranslate || '';
    $('card-example-block').hidden = !w.example;
    $('card-hint').textContent =
        t.mode === 'cards' ? 'нажми или пробел — перевернуть'
        : t.mode === 'dictation' ? 'слушай и пиши по-норвежски · Tab — ещё раз'
        : '';
}

// Ссылки под карточкой. До ответа они выдали бы слово, поэтому прячутся:
// «all» — всё, включая «прослушать»; «links» — только Forvo и Ordbøkene
// (в диктанте прослушивание и есть задание).
export function renderLinks(w) {
    const urls = lookupUrls(w.original);
    $('tr-forvo').href = urls.forvo;
    $('tr-ordbok').href = urls.ordbok;
    let conceal = '';
    if (t.mode === 'write-ru-no' && t.checked === null) conceal = 'all';
    else if (t.mode === 'gender' && !t.answered) conceal = 'links';
    else if (t.mode === 'dictation' && t.checked === null) conceal = 'links';
    else if (t.mode === 'cloze' && t.checked === null) conceal = 'all';
    else if (t.mode === 'cards' && !t.noFront && !t.flipped) conceal = 'all';
    $('tr-links').dataset.conceal = conceal;
}
