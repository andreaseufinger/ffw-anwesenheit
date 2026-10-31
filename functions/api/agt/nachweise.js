// POST /api/agt/nachweise — Nachweis von Hand eintragen, auch für mehrere
// Personen auf einmal (Sammeleintrag nach einem Streckendurchgang).
//
// Body: { person_ids: [..], art, datum?, gueltig_bis?, bemerkung? }
// - Arten mit Frist: gueltig_bis = datum + Frist - 1 Tag (12 Monate:
//   22.05.2026 -> 21.05.2027). Ein mitgegebenes gueltig_bis geht vor.
// - Ohne Frist (G 26.3, solange in den Einstellungen leer): gueltig_bis ist
//   Pflicht (Datum der nächsten Untersuchung laut Bescheinigung), datum optional.
// - Lehrgang: datum ist Pflicht, unbefristet.
import { json, err, unauthorized, forbidden, darfAtemschutz } from '../../_lib/auth.js';
import { auditEintrag } from '../../_lib/audit.js';
import { mitAtemschutz } from '../agt.js';
import { GUELTIG_SQL } from '../../_lib/agt.js';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function onRequestPost({ request, env, data }) {
  if (!data.user) return unauthorized();
  if (!darfAtemschutz(data.user)) return forbidden();

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  const ids = [...new Set((Array.isArray(body?.person_ids) ? body.person_ids : [])
    .map(Number).filter(Number.isInteger))];
  if (!ids.length) return err('Keine Person gewählt');
  const datum = body?.datum ? String(body.datum) : null;
  const bisRoh = body?.gueltig_bis ? String(body.gueltig_bis) : null;
  if (datum && !ISO.test(datum)) return err('Datum ungültig');
  if (bisRoh && !ISO.test(bisRoh)) return err('Gültig bis ungültig');
  const bemerkung = String(body?.bemerkung || '').trim() || null;

  return mitAtemschutz(async () => {
    const art = await env.DB.prepare(
      `SELECT art, name, frist_monate FROM agt_arten WHERE art = ?`
    ).bind(String(body?.art || '')).first();
    if (!art) return err('Unbekannte Nachweisart');

    let gueltigBis = null;
    if (art.art === 'lehrgang') {
      if (!datum) return err('Für den Lehrgang ist das Abschlussdatum nötig');
    } else if (bisRoh) {
      gueltigBis = bisRoh;
    } else if (art.frist_monate) {
      if (!datum) return err('Datum der Durchführung fehlt');
      const r = await env.DB.prepare(`SELECT ${GUELTIG_SQL('?', '?')} AS bis`)
        .bind(datum, art.frist_monate).first();
      gueltigBis = r.bis;
    } else {
      if (!bisRoh) return err('Gültig bis fehlt (Datum der nächsten Untersuchung)');
      gueltigBis = bisRoh;
    }

    const agt = await env.DB.prepare(
      `SELECT id FROM personen WHERE agt = 1 AND id IN (${ids.map(() => '?').join(', ')})`
    ).bind(...ids).all();
    if (agt.results.length !== ids.length) return err('Nur Personen mit AGT-Kennzeichen');

    const stmt = env.DB.prepare(
      `INSERT INTO agt_nachweise (person_id, art, datum, gueltig_bis, quelle, bemerkung, created_by)
       VALUES (?, ?, ?, ?, 'manuell', ?, ?)`
    );
    await env.DB.batch([
      ...ids.map((id) => stmt.bind(id, art.art, datum, gueltigBis, bemerkung, data.user.username)),
      auditEintrag(env, data.user, {
        bereich: 'atemschutz', aktion: 'anlegen', objekt: 'nachweis',
        details: { art: art.art, datum, gueltig_bis: gueltigBis, person_ids: ids },
      }),
    ]);
    return json({ ok: true, anzahl: ids.length, gueltig_bis: gueltigBis }, { status: 201 });
  });
}
