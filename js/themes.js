// Темы оформления. Было 16, осталось 4 — по итогам интервью (docs/ROADMAP.md).
import { state, saveSettings } from './store.js';
import { escapeHtml, escapeAttr } from './util.js';
import { $ } from './ui.js';

export const THEMES = [
    { id: 'auto', name: 'Системная', desc: 'Как в настройках ОС' },
    { id: 'dark', name: 'Тёмная', desc: 'По умолчанию',
      accent:'#7c6af7', accent2:'#a78bfa', glow:'rgba(124,106,247,0.25)', dim:'rgba(124,106,247,0.1)',
      bg:'#080810', bg1:'#0e0e18', bg2:'#14141f', bg3:'#1c1c2a', bg4:'#242436',
      text:'#eeeef5', text2:'#8888aa', text3:'#5c5c78', border:'rgba(255,255,255,0.06)', borderHi:'rgba(255,255,255,0.12)' },
    { id: 'light', name: 'Светлая', desc: 'Чистый белый',
      accent:'#6366f1', accent2:'#4f46e5', glow:'rgba(99,102,241,0.2)', dim:'rgba(99,102,241,0.08)',
      bg:'#fafbff', bg1:'#f2f4fc', bg2:'#e8ecf8', bg3:'#dde2f4', bg4:'#d2d8ef',
      text:'#1a1c2e', text2:'#4a4d8a', text3:'#6b70a8', border:'rgba(0,0,0,0.08)', borderHi:'rgba(0,0,0,0.16)' },
    { id: 'nord', name: 'Норд', desc: 'Светлая скандинавская',
      accent:'#5e81ac', accent2:'#4c6f99', glow:'rgba(94,129,172,0.2)', dim:'rgba(94,129,172,0.1)',
      bg:'#eceff4', bg1:'#e5e9f0', bg2:'#d8dee9', bg3:'#ccd3e0', bg4:'#bcc6d8',
      text:'#2e3440', text2:'#4c566a', text3:'#616e88', border:'rgba(0,0,0,0.08)', borderHi:'rgba(0,0,0,0.16)' },
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
