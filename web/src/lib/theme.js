// Applies Settings > Theme / Fonts to CSS variables. Google Fonts are loaded on demand;
// uploaded fonts (Media Library) are registered with @font-face.
const loaded = new Set();

export function loadFont(spec) {
  if (!spec?.family) return null;
  const key = `${spec.source}:${spec.family}:${spec.mediaUrl || ''}`;
  if (loaded.has(key)) return spec.family;
  loaded.add(key);
  if (spec.source === 'custom' && spec.mediaUrl) {
    const style = document.createElement('style');
    style.textContent = `@font-face{font-family:'${spec.family.replace(/'/g, '')}';src:url('${spec.mediaUrl}');font-display:swap;}`;
    document.head.appendChild(style);
  } else {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(spec.family).replace(/%20/g, '+')}:wght@400;500;600;700;800;900&display=swap`;
    document.head.appendChild(link);
  }
  return spec.family;
}

export function applyFont(surface, fonts) {
  const spec = fonts?.[surface];
  const fam = loadFont(spec);
  if (fam) document.documentElement.style.setProperty('--font', `'${fam}', 'Noto Sans Thai', system-ui, sans-serif`);
  for (const [k, v] of Object.entries(fonts || {})) {
    if (k === 'receipt' || k === 'a4') { const f = loadFont(v); if (f) document.documentElement.style.setProperty(`--${k}-font`, `'${f}'`); }
  }
}

function contrastText(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.62 ? '#111' : '#fff';
}

export function applyTheme(theme = {}, mode) {
  const r = document.documentElement;
  if (theme.primary) { r.style.setProperty('--primary', theme.primary); r.style.setProperty('--primary-contrast', contrastText(theme.primary)); }
  if (theme.secondary) r.style.setProperty('--secondary', theme.secondary);
  if (theme.accent) r.style.setProperty('--accent', theme.accent);
  if (theme.radius != null) { r.style.setProperty('--radius', `${theme.radius}px`); r.style.setProperty('--radius-sm', `${Math.max(4, theme.radius - 4)}px`); }
  r.dataset.button = theme.buttonStyle || 'solid';
  const m = mode || localStorage.getItem('sc.mode') || theme.defaultMode || 'light';
  r.dataset.theme = m === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : m;
  if (theme.background && r.dataset.theme !== 'dark') r.style.setProperty('--bg', theme.background); else r.style.removeProperty('--bg');
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme.primary || '#6D28D9');
}

export function toggleMode(theme) {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('sc.mode', next);
  applyTheme(theme, next);
  return next;
}

export async function resolveFontUrls(fonts, mediaLookup) {
  const out = structuredClone(fonts || {});
  for (const v of Object.values(out)) if (v?.source === 'custom' && v.mediaId && mediaLookup) v.mediaUrl = await mediaLookup(v.mediaId);
  return out;
}

export function setFavicon(url) {
  if (!url) return;
  let link = document.querySelector('link[rel=icon]');
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
  link.href = url;
}
