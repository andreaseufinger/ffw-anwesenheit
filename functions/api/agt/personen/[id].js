// GET /api/agt/personen/:id — alle Nachweise einer Person (für das Untermenü)
// PUT /api/agt/personen/:id { agt: true|false } — AGT-Kennzeichen setzen.
//     Beim Entfernen bleiben die Nachweise erhalten.
import { json, err, unauthorized, forbidden, darfAtemschutz } from '../../../_lib/auth.js';
import { auditEintrag } from '../../../_lib/audit.js';
import { mitAtemschutz } from '../../agt.js';

export async function onRequestGet({ env, params, data }) {
  if (!data.user) return unauthorized();
  if (!darfAtemschutz(data.user)) return forbidden();
  const id = Number(params.id);
  if (!Number.isInteger(id)) return err('Ungültige ID');

  return mitAtemschutz(async () => {
    const person = await env.DB.prepare(
      `SELECT id, nachname, vorname, aktiv, agt FROM personen WHERE id = ?`
    ).bind(id).first();
    if (!person) return err('Person nicht gefunden', 404);
    const { results } = await env.DB.prepare(
      `SELECT id, art, datum, gueltig_bis, quelle, quelle_ref, pass, florix, bemerkung,
              verworfen, created_by, created_at
       FROM agt_nachweise WHERE person_id = ?
       ORDER BY art, COALESCE(gueltig_bis, '9999-12-31') DESC, id DESC`
    ).bind(id).all();
    return json({ person, nachweise: results });
  });
}

export async function onRequestPut({ request, env, params, data }) {
  if (!data.user) return unauthorized();
  if (!darfAtemschutz(data.user)) return forbidden();
  const id = Number(params.id);
  if (!Number.isInteger(id)) return err('Ungültige ID');
  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  if (typeof body?.agt !== 'boolean') return err('agt fehlt');

  return mitAtemschutz(async () => {
    const p = await env.DB.prepare(`SELECT id, agt FROM personen WHERE id = ?`).bind(id).first();
    if (!p) return err('Person nicht gefunden', 404);
    const neu = body.agt ? 1 : 0;
    if (p.agt === neu) return json({ ok: true, unveraendert: true });
    await env.DB.batch([
      env.DB.prepare(`UPDATE personen SET agt = ? WHERE id = ?`).bind(neu, id),
      auditEintrag(env, data.user, {
        bereich: 'atemschutz', aktion: 'aendern', objekt: 'person', objektId: id,
        details: { agt: { alt: p.agt, neu } },
      }),
    ]);
    return json({ ok: true });
  });
}
