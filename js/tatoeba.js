// Примеры предложений с Tatoeba (букмол ↔ русский) через прокси на сервере.
import { escapeHtml, escapeAttr } from './util.js';
import { stripParticle } from './norsk.js';
import { $, showToast, openModal, closeModal } from './ui.js';

let target = 'add';     // в какую форму подставлять пример: add | edit
let results = [];

export async function openTatoeba(word, formPrefix = 'add') {
    const query = stripParticle(word);
    if (!query) {
        showToast('Сначала введи норвежское слово', 'info');
        return;
    }
    target = formPrefix;
    $('tatoeba-word-title').textContent = query;
    openModal('tatoeba-modal');
    const box = $('tatoeba-results');
    box.innerHTML = '<div class="fst-note center">🔍 Ищем примеры…</div>';
    try {
        const res = await fetch(`/api/tatoeba?word=${encodeURIComponent(query)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.status);
        results = (data.results || []).map(r => ({
            no: r.text || '',
            ru: r.translations?.flat?.()?.find(x => x?.text)?.text || '',
        })).filter(r => r.no);
        box.innerHTML = results.length
            ? results.map((r, i) => `
                <button class="tatoeba-item" data-action="tatoeba-use" data-index="${i}">
                    <span class="tatoeba-no" lang="nb">${escapeHtml(r.no)}</span>
                    ${r.ru ? `<span class="tatoeba-ru">${escapeHtml(r.ru)}</span>` : '<span class="tatoeba-ru muted">без перевода</span>'}
                    <span class="tatoeba-use">Подставить в форму →</span>
                </button>`).join('')
            : `<div class="fst-note center">Примеров не нашлось. Tatoeba ищет точное написание — попробуй другую форму слова.
               <br><a href="https://tatoeba.org/nob/sentences/search?from=nob&to=rus&query=${escapeAttr(encodeURIComponent(query))}" target="_blank" rel="noopener noreferrer">Открыть поиск на tatoeba.org ↗</a></div>`;
    } catch {
        box.innerHTML = '<div class="fst-note center">Tatoeba сейчас недоступна. Проверь интернет или попробуй позже.</div>';
    }
}

export const tatoebaActions = {
    'tatoeba-use'(el) {
        const r = results[Number(el.dataset.index)];
        if (!r) return;
        $(`${target}-example`).value = r.no;
        $(`${target}-ex-ru`).value = r.ru;
        closeModal('tatoeba-modal');
        showToast('Пример подставлен в форму', 'success', 1500);
    },
};
