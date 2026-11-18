// Темы оформления. Было 16, осталось 4 — по итогам интервью (docs/ROADMAP.md).
import { state, saveSettings } from './store.js';
import { escapeHtml, escapeAttr } from './util.js';
import { $ } from './ui.js';

export const THEMES = [
    { id: 'auto', name: 'Системная', desc: 'Как в настройках ОС' },
    // bg — фон страницы, bg1 — карточки, bg2 — поля ввода, bg3/bg4 — наведение и дорожки.
    { id: 'dark', name: 'Тёмная', desc: 'Ночной фьорд',
      accent:'#5b7cfa', accent2:'#8fa3ff', glow:'rgba(91,124,250,0.35)', dim:'rgba(91,124,250,0.14)',
      bg:'#0b0d12', bg1:'#14171e', bg2:'#1b1f28', bg3:'#232835', bg4:'#2d3342',
      text:'#eef0f5', text2:'#a7adbb', text3:'#6f7686', border:'rgba(255,255,255,0.07)', borderHi:'rgba(255,255,255,0.14)' },
    { id: 'light', name: 'Светлая', desc: 'Чистый белый',
      accent:'#3f5ef0', accent2:'#3350d6', glow:'rgba(63,94,240,0.28)', dim:'rgba(63,94,240,0.09)',
      bg:'#f4f5f8', bg1:'#ffffff', bg2:'#f1f3f7', bg3:'#e7eaf0', bg4:'#d9dde6',
      text:'#11141b', text2:'#4a5163', text3:'#868d9c', border:'rgba(16,24,40,0.08)', borderHi:'rgba(16,24,40,0.16)' },
    { id: 'nord', name: 'Норд', desc: 'Светлая скандинавская',
      accent:'#5e81ac', accent2:'#4c6f99', glow:'rgba(94,129,172,0.28)', dim:'rgba(94,129,172,0.12)',
      bg:'#e5e9f0', bg1:'#eceff4', bg2:'#e2e7ef', bg3:'#d8dee9', bg4:'#c8d0dd',
      text:'#2e3440', text2:'#4c566a', text3:'#7b869c', border:'rgba(46,52,64,0.1)', borderHi:'rgba(46,52,64,0.18)' },
];

// Старые id тем (их было 16) сводим к новым, чтобы выбор пользователя не пропал.
const LEGACY = {
    violet: 'dark', midnight: 'dark', forest: 'dark', rose: 'dark', amber: 'dark', oled: 'dark',
    snow: 'light', cream: 'light', paper: 'light', mint: 'light', lavender: 'light',
    'rose-light': 'light', 'sky-light': 'light', sand: 'light', matcha: 'light', nord: 'nord',
};

const media = window.matchMedia?.('(prefers-color-scheme: light)');

function resolve(id) {
    if (id === 'auto') return THEMES.find(t => t.id === (media?.matches ? 'light' : 'dark'));
    return THEMES.find(t => t.id === id) || THEMES[1];
}

export function applyTheme(id = state.settings.theme) {
    const known = THEMES.some(t => t.id === id) ? id : (LEGACY[id] || 'auto');
    if (known !== state.settings.theme) {
        state.settings.theme = known;
        saveSettings();
    }
    const t = resolve(known);
    const r = document.documentElement;
    const vars = {
        '--accent': t.accent, '--accent-2': t.accent2, '--accent-glow': t.glow, '--accent-dim': t.dim,
        '--bg': t.bg, '--bg-1': t.bg1, '--bg-2': t.bg2, '--bg-3': t.bg3, '--bg-4': t.bg4,
        '--text': t.text, '--text-2': t.text2, '--text-3': t.text3,
        '--border': t.border, '--border-hi': t.borderHi,
    };
    for (const [k, v] of Object.entries(vars)) r.style.setProperty(k, v);
    r.dataset.scheme = t.id === 'dark' ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.bg);
    renderThemeGrid();
}

media?.addEventListener?.('change', () => {
    if (state.settings.theme === 'auto') applyTheme('auto');
});

export function setTheme(id) {
    state.settings.theme = id;
    saveSettings();
    applyTheme(id);
}

export function renderThemeGrid() {
    const grid = $('theme-grid');
    if (!grid) return;
    grid.innerHTML = THEMES.map(t => {
        const shown = resolve(t.id);
        return `
        <button class="theme-card ${t.id === state.settings.theme ? 'active' : ''}" data-action="set-theme" data-theme="${escapeAttr(t.id)}">
            <span class="theme-swatch">
                <span style="background:${shown.bg}"></span><span style="background:${shown.bg3}"></span>
                <span style="background:${shown.accent}"></span><span style="background:${shown.bg2}"></span>
            </span>
            <span class="theme-text">
                <span class="theme-name">${escapeHtml(t.name)}</span>
                <span class="theme-desc">${escapeHtml(t.desc)}</span>
            </span>
        </button>`;
    }).join('');
}
