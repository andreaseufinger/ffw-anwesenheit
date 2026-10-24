// PUT    /api/abteilungen/:id — Abteilung ändern (nur übergreifender Admin)
// DELETE /api/abteilungen/:id — Abteilung löschen (nur übergreifender Admin)
//
// Ein Abteilungsadmin darf hier nicht heran: er könnte sonst sein eigenes
// Stundensoll setzen oder sich den Einsatzdienst zuschalten.
import { json, err, unauthorized, forbidden, isUebergreifenderAdmin } from '../../_lib/auth.js';
import { validateAbteilung } from '../abteilungen.js';

function requireAdmin(data) {
  if (!data.user) return unauthorized();
  if (!isUebergreifenderAdmin(data.user)) return forbidden();
  return null;
}

async function loadAbteilung(env, params) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return { error: err('Ungültige ID') };
  const row = await env.DB.prepare(
    `SELECT id, name FROM abteilungen WHERE id = ?`
  ).bind(id).first();
  if (!row) return { error: err('Abteilung nicht gefunden', 404) };
  return { abteilung: row };
}

export async function onRequestPut({ request, env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  const denied = requireAdmin(data); if (denied) return denied;
  const { abteilung, error: notFound } = await loadAbteilung(env, params);
  if (notFound) return notFound;

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  const { value, error } = validateAbteilung(body);
  if (error) return err(error);

  const kollision = await env.DB.prepare(
    `SELECT id FROM abteilungen WHERE name = ? COLLATE NOCASE AND id != ?`
  ).bind(value.name, abteilung.id).first();
  if (kollision) return err('Eine andere Abteilung trägt diesen Namen bereits', 409);

  await env.DB.prepare(
    `UPDATE abteilungen SET name = ?, kurz = ?, uebung_soll_stunden = ?,
            standard_zeit_von = ?, standard_zeit_bis = ?, einsatzdienst = ?,
            sort_order = ?
     WHERE id = ?`
  ).bind(value.name, value.kurz, value.uebung_soll_stunden,
         value.standard_zeit_von, value.standard_zeit_bis,
         value.einsatzdienst, value.sort_order, abteilung.id).run();

  return json({ id: abteilung.id, ...value });
}

export async function onRequestDelete({ env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  const denied = requireAdmin(data); if (denied) return denied;
  const { abteilung, error } = await loadAbteilung(env, params);
  if (error) return error;

  // Die Fremdschlüssel stehen auf RESTRICT und würden das Löschen ohnehin
  // verhindern — aber mit einer Datenbankmeldung, die niemandem sagt, woran
  // es liegt. Deshalb vorher zählen und benennen.
  const n = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM personen_abteilungen WHERE abteilung_id = ?) AS personen,
       (SELECT COUNT(*) FROM themen WHERE abteilung_id = ?)               AS themen,
       (SELECT COUNT(*) FROM dienstarten WHERE abteilung_id = ?)          AS dienstarten,
       (SELECT COUNT(*) FROM attendance_sessions WHERE abteilung_id = ?)  AS termine,
       (SELECT COUNT(*) FROM user_abteilungen WHERE abteilung_id = ?)     AS benutzer`
  ).bind(abteilung.id, abteilung.id, abteilung.id, abteilung.id, abteilung.id).first();

  const haengt = (n?.personen ?? 0) + (n?.themen ?? 0) + (n?.dienstarten ?? 0)
               + (n?.termine ?? 0) + (n?.benutzer ?? 0);
  if (haengt > 0) {
    return json({
      error: `Abteilung „${abteilung.name}" ist noch in Benutzung und kann `
           + 'nicht gelöscht werden.',
      verwendung: n,
    }, { status: 409 });
  }

  await env.DB.prepare(`DELETE FROM abteilungen WHERE id = ?`).bind(abteilung.id).run();
  return json({ ok: true, id: abteilung.id, name: abteilung.name });
}
