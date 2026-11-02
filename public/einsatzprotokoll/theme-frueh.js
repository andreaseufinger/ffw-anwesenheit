// Darstellung vor dem ersten Zeichnen setzen. Gilt pro Gerät; Fahrzeug-
// Tablets (Geräte-Token vorhanden) starten ohne eigene Wahl in Dunkel.
// Wird im <head> ohne defer geladen; als Datei statt eingebettet, damit die
// Content-Security-Policy keine eingebetteten Skripte erlauben muss (SEC5).
try {
  var t = localStorage.getItem('ffwe_ep_theme');
  if (!t && localStorage.getItem('ep_device_token')) t = 'dark';
  document.documentElement.setAttribute('data-theme', t === 'light' || t === 'dark' ? t : 'auto');
} catch (e) { /* ohne localStorage: automatisch */ }
