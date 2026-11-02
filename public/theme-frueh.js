// Darstellung (dunkel/hell/automatisch) vor dem ersten Zeichnen setzen, sonst
// blitzt der falsche Farbsatz auf. Gilt pro Gerät. Wird im <head> ohne defer
// geladen; als Datei statt eingebettet, damit die Content-Security-Policy
// keine eingebetteten Skripte erlauben muss (SEC5).
try {
  var t = localStorage.getItem('ffwe_anw_theme');
  document.documentElement.setAttribute('data-theme', t === 'light' || t === 'dark' ? t : 'auto');
} catch (e) { /* ohne localStorage: automatisch */ }
