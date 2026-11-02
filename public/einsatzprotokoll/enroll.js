// Tauscht den Einmal-Code aus dem QR gegen den langlebigen Device-Token.
// Der Token landet im localStorage und dient ausschließlich dazu, sich
// beim App-Start still neu anzumelden, wenn das Session-Cookie fehlt.
const DEVICE_TOKEN_KEY = 'ep_device_token';

(async function enroll() {
  const statusEl = document.getElementById('enroll-status');
  const errorEl  = document.getElementById('enroll-error');
  const fail = (msg) => {
    statusEl.textContent = 'Einrichtung fehlgeschlagen.';
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
  };

  const code = new URLSearchParams(location.search).get('code');
  if (!code) return fail('Kein Einrichtungs-Code in der Adresse. Bitte den QR-Code erneut scannen.');

  let res, data;
  try {
    res = await fetch('/api/auth/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    return fail('Keine Verbindung zum Server. Bitte Netz prüfen und erneut scannen.');
  }

  if (!res.ok) {
    return fail(data.error || 'Der Einrichtungs-Code ist ungültig oder abgelaufen.');
  }

  try {
    localStorage.setItem(DEVICE_TOKEN_KEY, data.token);
  } catch {
    // Ohne localStorage funktioniert nur die Cookie-Session — die App
    // läuft, verliert aber die automatische Wiederanmeldung.
    return fail(
      'Der Token konnte nicht gespeichert werden (privater Modus?). ' +
      'Bitte ein normales Safari-Fenster verwenden und erneut scannen.'
    );
  }

  statusEl.textContent = `Fertig — dieses Gerät ist jetzt als „${data.username}" angemeldet.`;
  // Adresse säubern, damit der Code nicht im Verlauf stehen bleibt.
  history.replaceState(null, '', '/einsatzprotokoll/enroll');
  setTimeout(() => { location.href = '/einsatzprotokoll/'; }, 1200);
})();
