// GET  /api/webhooks/secret — Status des als Secret hinterlegten Ziels (App-Admin)
// POST /api/webhooks/secret — Testaufruf dieses Ziels (App-Admin)
//
// HOMEY_WEBHOOK_BASE ist selbst das Geheimnis: wer die URL kennt, löst den
// Flow im Haus aus. Sie wird deshalb NIE an das Frontend ausgeliefert — weder
// hier noch in einer Fehlermeldung. Nach außen geht ausschließlich der
// Hostname (zur Wiedererkennung, welches Ziel konfiguriert ist) und der
// Statuscode des Testaufrufs.
//
// Dieser Pfad liegt bewusst als eigene Datei neben [id].js: statische
// Segmente haben in Pages Functions Vorrang vor dynamischen.
import { json, unauthorized, forbidden, isEpAdmin } from '../../_lib/auth.js';
import { buildTargetUrl } from '../../_lib/fanout.js';

const TEST_TIMEOUT_MS = 5000;

function requireAdmin(data) {
  if (!data.user) return unauthorized();
  if (!isEpAdmin(data.user)) return forbidden();
  return null;
}

// Nur der Host, nie Pfad oder Query — der Pfad enthält das Geheimnis.
function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

export async function onRequestGet({ env, data }) {
  const denied = requireAdmin(data); if (denied) return denied;

  const base = (env.HOMEY_WEBHOOK_BASE || '').trim();
  return json({
    konfiguriert: !!base,
    host: base ? hostOf(base) : null,
  });
}

export async function onRequestPost({ env, data }) {
  const denied = requireAdmin(data); if (denied) return denied;

  const base = (env.HOMEY_WEBHOOK_BASE || '').trim();
  if (!base) {
    return json({ konfiguriert: false, ok: false, status: 'nicht konfiguriert' });
  }

  // Exakt derselbe URL-Aufbau wie im Alarmfall, damit der Test auch wirklich
  // das prüft, was später passiert.
  const url = buildTargetUrl(base, {
    id: 0,
    keyword: 'H1 Türöffnung (Test)',
    unit: 'Test',
    datum: new Date().toISOString().slice(0, 10),
    uhrzeit: '00:00',
  });

  let status, ok;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
    status = String(res.status);
    ok = res.ok;
  } catch (e) {
    // Fehlertexte können die URL enthalten (z. B. "connect to host …") —
    // deshalb nur die Fehlerart nach außen geben, nie die Meldung selbst.
    status = e?.name === 'TimeoutError' || e?.name === 'AbortError'
      ? 'timeout'
      : 'nicht erreichbar';
    ok = false;
  }

  return json({ konfiguriert: true, host: hostOf(base), ok, status });
}
