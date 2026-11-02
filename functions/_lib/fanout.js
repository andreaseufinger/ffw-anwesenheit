// Fan-out ausgehender Webhooks nach dem Anlegen eines Einsatzes.
//
// Hintergrund: aPager PRO kann nur EIN Ziel aufrufen. Dessen Webhook zeigt
// unverändert auf /api/webhook/einsatz. Alles Weitere (Hausautomation usw.)
// wird hier verteilt — strikt nachgelagert.
//
// Der Alarmweg ist der kritische Pfad einer Feuerwehralarmierung. Deshalb gilt
// ohne Ausnahme:
//   * Kein await vor der Antwort an aPager — der Aufruf läuft in waitUntil.
//   * Kein throw — jeder Fehler wird geschluckt und geloggt.
//   * Timeout je Ziel, damit ein hängender Socket die Invocation nicht hält.
//   * Kein Retry — die Gegenstelle hat ihr eigenes Auffangnetz.
// Ein nicht erreichbares Ziel darf das Anlegen des Einsatzes niemals
// verzögern oder scheitern lassen.

const TIMEOUT_MS = 3000;

// Platzhalter in der konfigurierten URL. Enthält eine URL gar keinen
// Platzhalter, wird `tag` als Query-Parameter angehängt — so genügt es, die
// blanke Homey-Basis-URL einzutragen (…/einsatz → …/einsatz?tag=B3%20Brand).
const PLATZHALTER = ['keyword', 'unit', 'id', 'datum', 'uhrzeit'];

export function buildTargetUrl(template, ctx) {
  const roh = String(template || '').trim();
  if (!roh) return null;

  const genutzt = PLATZHALTER.filter((k) => roh.includes(`{${k}}`));
  let url = roh;
  for (const k of genutzt) {
    // Pflicht: Stichworte wie "B3 Zimmerbrand" oder "H1 Türöffnung" enthalten
    // Leerzeichen und Umlaute.
    url = url.replaceAll(`{${k}}`, encodeURIComponent(ctx[k] ?? ''));
  }
  if (genutzt.length) return url;

  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}tag=${encodeURIComponent(ctx.keyword ?? '')}`;
}

async function callOne(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { ok: res.ok, status: String(res.status) };
  } catch (e) {
    const name = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : String(e);
    return { ok: false, status: name.slice(0, 120) };
  }
}

// Ruft alle Ziele NACHEINANDER auf. Bewusst sequenziell: die Reihenfolge ist
// im Admin konfigurierbar, und parallele Aufrufe brächten hier nichts —
// niemand wartet auf das Ergebnis.
async function pushAll(env, ctx) {
  // 1) Das als Secret hinterlegte Ziel zuerst. Es bleibt bewusst außerhalb der
  //    Datenbank, damit die URL (ein Bearer-Geheimnis) nicht in der Admin-
  //    Oberfläche sichtbar wird. Ist sie nicht gesetzt, entfällt sie still.
  if (env.HOMEY_WEBHOOK_BASE) {
    const url = buildTargetUrl(env.HOMEY_WEBHOOK_BASE, ctx);
    const r = await callOne(url);
    console.log('homey-push', r.status);
  }

  // 2) Danach die im Admin gepflegten Ziele, in ihrer Sortierreihenfolge.
  let ziele = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, name, url FROM einsatz_webhooks
       WHERE aktiv = 1
       ORDER BY sort_order, id`
    ).all();
    ziele = results || [];
  } catch (e) {
    // Fehlt die Tabelle (Migration noch nicht gelaufen), ist das kein Grund,
    // irgendetwas kaputtgehen zu lassen.
    console.log('webhook-fanout: Ziele nicht lesbar', String(e));
    return;
  }

  for (const ziel of ziele) {
    const url = buildTargetUrl(ziel.url, ctx);
    if (!url) continue;
    const r = await callOne(url);
    console.log('webhook-push', ziel.name, r.status);
    try {
      await env.DB.prepare(
        `UPDATE einsatz_webhooks SET last_status = ?, last_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).bind(r.status, ziel.id).run();
    } catch { /* Protokollierung ist Beiwerk, nie ein Grund zu scheitern */ }
  }
}

// Einstiegspunkt: niemals awaiten, immer über context.waitUntil.
export function fanoutEinsatzAngelegt(context, ctx) {
  const { env } = context;
  if (!env?.DB && !env?.HOMEY_WEBHOOK_BASE) return;
  context.waitUntil(
    pushAll(env, ctx).catch((e) => console.log('webhook-fanout fehlgeschlagen', String(e)))
  );
}
