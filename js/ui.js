// Общие элементы интерфейса: тосты, подтверждения, модальные окна, звук, речь.
import { escapeHtml } from './util.js';
import { state } from './store.js';

export const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Тосты. message — обычный текст; разметку передавать через { html }.
// ---------------------------------------------------------------------------
export function showToast(message, type = 'info', duration = 3500) {
    let container = $('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', 'status');
    toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span>${escapeHtml(message)}</span>`;
    toast.onclick = () => dismiss(toast);
    container.appendChild(toast);
    toast._timer = setTimeout(() => dismiss(toast), duration);
    return toast;
}

function dismiss(toast) {
    clearTimeout(toast._timer);
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 250);
}

// Подтверждение. messageHtml должен быть уже безопасным HTML.
export function showConfirm(messageHtml, confirmText = 'Подтвердить', cancelText = 'Отмена') {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';
        overlay.innerHTML = `
            <div class="confirm-box" role="alertdialog" aria-modal="true">
                <p>${messageHtml}</p>
                <div class="confirm-actions">
                    <button class="confirm-cancel">${escapeHtml(cancelText)}</button>
                    <button class="confirm-ok">${escapeHtml(confirmText)}</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const close = (val) => {
            overlay.remove();
            document.removeEventListener('keydown', onKey, true);
            resolve(val);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); close(false); }
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(true); }
        };
        overlay.querySelector('.confirm-ok').onclick = () => close(true);
        overlay.querySelector('.confirm-cancel').onclick = () => close(false);
        overlay.onclick = (e) => { if (e.target === overlay) close(false); };
        document.addEventListener('keydown', onKey, true);
        overlay.querySelector('.confirm-ok').focus();
    });
}

// ---------------------------------------------------------------------------
// Модальные окна: .modal-overlay с id. Закрываются по фону, крестику и Esc.
// ---------------------------------------------------------------------------
export function openModal(id) {
    const m = $(id);
    if (!m) return;
    m.classList.add('open');
    const focusable = m.querySelector('input, textarea, select, button:not(.modal-close)');
    if (focusable) setTimeout(() => focusable.focus(), 50);
}

export function closeModal(id) {
    $(id)?.classList.remove('open');
}

export function topModal() {
    const open = [...document.querySelectorAll('.modal-overlay.open')];
    return open[open.length - 1] || null;
}

document.addEventListener('click', (e) => {
    const overlay = e.target.classList?.contains('modal-overlay') ? e.target : null;
    if (overlay) overlay.classList.remove('open');
});

// ---------------------------------------------------------------------------
// Звуковые эффекты
// ---------------------------------------------------------------------------
let audioCtx = null;

export function playSound(type) {
    if (state.settings.muted) return;
    try {
        audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
        const ctx = audioCtx;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        const t = ctx.currentTime;
        const presets = {
            correct: { type: 'sine', f: [[440, 0], [660, 0.08]], g: 0.18, d: 0.35 },
            wrong:   { type: 'sawtooth', f: [[300, 0], [180, 0.15]], g: 0.12, d: 0.3 },
            flip:    { type: 'sine', f: [[800, 0]], g: 0.06, d: 0.08 },
        };
        const p = presets[type];
        if (!p) return;
        osc.type = p.type;
        p.f.forEach(([freq, at]) => osc.frequency.setValueAtTime(freq, t + at));
        gain.gain.setValueAtTime(p.g, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + p.d);
        osc.start(t);
        osc.stop(t + p.d);
    } catch { /* нет Web Audio — не страшно */ }
}

// ---------------------------------------------------------------------------
// Речь (букмол). Голос выбираем явно: одного lang мало — часть браузеров тогда
// читает норвежское слово английским голосом. nb/no/nn — разные коды одного
// языка у разных движков синтеза.
// ---------------------------------------------------------------------------
export const SPEECH_LANG = 'nb-NO';
let norwegianVoice = null;
let voiceWarningShown = false;

function pickNorwegianVoice() {
    if (!window.speechSynthesis) return null;
    const voices = window.speechSynthesis.getVoices();
    norwegianVoice =
        voices.find(v => /^nb([-_]|$)/i.test(v.lang)) ||
        voices.find(v => /^no([-_]|$)/i.test(v.lang)) ||
        voices.find(v => /^nn([-_]|$)/i.test(v.lang)) ||
        null;
    return norwegianVoice;
}

if (window.speechSynthesis) {
    pickNorwegianVoice();
    window.speechSynthesis.addEventListener?.('voiceschanged', pickNorwegianVoice);
}

// ---------------------------------------------------------------------------
// Основной путь — Piper на сервере (/api/tts): нейросетевой голос вместо
// роботизированного espeak, которым браузер на Linux озвучивает всё.
// Браузерная речь остаётся запасным вариантом, если Piper не установлен
// или сервер недоступен (офлайн).
// ---------------------------------------------------------------------------
let serverTts = null;          // null — ещё не проверяли, true/false — есть ли Piper
let currentAudio = null;
const ttsUrl = (text) => `/api/tts?text=${encodeURIComponent(String(text).trim())}`;

export async function initSpeech() {
    try {
        const res = await fetch('/api/tts/status');
        serverTts = res.ok && (await res.json()).available === true;
    } catch {
        serverTts = false;
    }
    return serverTts;
}

export function hasNeuralVoice() { return serverTts === true; }

// Готовит звук заранее (например, следующей карточки), чтобы он играл сразу.
const prefetched = new Set();
export function prefetchSpeech(text) {
    if (!serverTts || !text || prefetched.has(text)) return;
    prefetched.add(text);
    fetch(ttsUrl(text)).catch(() => prefetched.delete(text));
}

export function speak(text) {
    if (state.settings.muted || !text) return;
    stopSpeech();
    if (serverTts) {
        const audio = new Audio(ttsUrl(text));
        currentAudio = audio;
        audio.play().catch(() => {
            // Сервер не смог синтезировать — говорим браузерным голосом.
            if (currentAudio === audio) browserSpeak(text);
        });
        return;
    }
    browserSpeak(text);
}

function browserSpeak(text) {
    if (!window.speechSynthesis) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = SPEECH_LANG;
    const voice = norwegianVoice || pickNorwegianVoice();
    if (voice) {
        utterance.voice = voice;
    } else if (!voiceWarningShown && window.speechSynthesis.getVoices().length > 0) {
        voiceWarningShown = true;
        showToast('Нет норвежского голоса. Для качественной озвучки установи Piper: deploy/install-voice.sh', 'warning', 7000);
    }
    utterance.rate = 0.9;
    window.speechSynthesis.speak(utterance);
}

export function stopSpeech() {
    if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
    }
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
}
