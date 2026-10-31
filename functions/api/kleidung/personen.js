// GET /api/kleidung/personen — aktive Personen für die Zuordnung von Teilen
// und Namen aus ZMS (der Kleidung-Admin hat keine Personenverwaltung).
import { json, unauthorized, forbidden, darfKleidung } from '../../_lib/auth.js';

export async function onRequestGet({ env, data }) {
  if (!data.user) return unauthorized();
  if (!darfKleidung(data.user)) return forbidden();
  const { results } = await env.DB.prepare(
    `SELECT id, nachname, vorname, agt FROM personen WHERE aktiv = 1
     ORDER BY nachname COLLATE NOCASE, vorname COLLATE NOCASE`
  ).all();
  return json(results.map((p) => ({ id: p.id, name: `${p.nachname}, ${p.vorname}`, agt: !!p.agt })));
}
