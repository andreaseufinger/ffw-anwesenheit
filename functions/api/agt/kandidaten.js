// GET /api/agt/kandidaten — aktive Mitglieder einer Abteilung mit
// Einsatzdienst, die noch kein AGT-Kennzeichen haben (Auswahl "+ AGT").
import { json, unauthorized, forbidden, darfAtemschutz } from '../../_lib/auth.js';
import { mitAtemschutz } from '../agt.js';

export async function onRequestGet({ env, data }) {
  if (!data.user) return unauthorized();
  if (!darfAtemschutz(data.user)) return forbidden();
  return mitAtemschutz(async () => {
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT p.id, p.nachname, p.vorname
       FROM personen p
       JOIN personen_abteilungen pa ON pa.person_id = p.id
       JOIN abteilungen a ON a.id = pa.abteilung_id AND a.einsatzdienst = 1
       WHERE p.aktiv = 1 AND p.agt = 0
       ORDER BY p.nachname COLLATE NOCASE, p.vorname COLLATE NOCASE`
    ).all();
    return json(results);
  });
}
