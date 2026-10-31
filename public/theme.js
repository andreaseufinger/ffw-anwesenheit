// Darstellung: dunkel, hell oder automatisch. Gilt nur für dieses Gerät
// (localStorage), nicht für das Konto. Aus dem Design-System "Einsatztafel"
// (snippets/theme.js), Schlüssel je App eindeutig.
const THEME_KEY = 'ffwe_anw_theme';
const THEME_BAR = { dark: '#171412', light: '#e9e7e4' }; // = --bg des jeweiligen Satzes
function getTheme() {
  try { const t = localStorage.getItem(THEME_KEY); return t === 'light' || t === 'dark' ? t : 'auto'; }
  catch (e) { return 'auto'; }
}
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const sysLight = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  const meta = document.getElementById('meta-theme');
  if (meta) meta.setAttribute('content', THEME_BAR[t === 'auto' ? (sysLight ? 'light' : 'dark') : t]);
}
function setTheme(t) { try { localStorage.setItem(THEME_KEY, t); } catch (e) {} applyTheme(t); }
try { window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => applyTheme(getTheme())); } catch (e) {}
['dark', 'light', 'auto'].forEach((t) => {
  const el = document.getElementById('theme-' + t);
  if (el) el.addEventListener('change', () => { if (el.checked) setTheme(t); });
});
applyTheme(getTheme());
