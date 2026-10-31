// GET  /api/personen-rollen — Rollen, die einer Person je Abteilung zugewiesen
//                             werden können (alle angemeldeten Benutzer)
// POST /api/personen-rollen — neue Rolle anlegen (nur übergreifender Admin)
//
// Globale Liste; der Kontext kommt aus der Abteilung, in der sie zugewiesen
// wird. Eigene Tabelle und kein Freitext, weil an einem Freitextfeld die
// Gruppierung hier schon einmal auseinandergelaufen ist.
//
// Nicht zu verwechseln mit den Benutzerrollen (user_roles): hier geht es um
// die Funktion eines Mitglieds in der Abteilung, nicht um Rechte in der App.
import { json, err, unauthorized, forbidden, isUebergreifenderAdmin } from '../_lib/auth.js';
import { mitStammdaten } from '../_lib/stammdaten.js';

export function validatePersonenRolle(body) {
  const name = String(body?.name || '').trim();
  if (!name) return { error: 'Name fehlt' };
  if (name.length > 60) return { error: 'Name zu lang (max. 60 Zeichen)' };
  const sort_order = Number.isFinite(Number(body?.sort_order))
    ? Math.trunc(Number(body.sort_order)) : 100;
  return { value: { name, sort_order } };
}

export async function onRequestGet({ env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  return mitStammdaten('personen_rollen', async () => {
    const { results } = await env.DB.prepare(
      `SELECT r.id, r.name, r.sort_order,
              (SELECT COUNT(*) FROM personen_abteilungen pa WHERE pa.rolle_id = r.id) AS zuordnungen
       FROM personen_rollen r
       ORDER BY r.sort_order, r.name COLLATE NOCASE`
    ).all();
    return json(results);
  });
}

export async function onRequestPost({ request, env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();
  if (!isUebergreifenderAdmin(data.user)) return forbidden();

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  const { value, error } = validatePersonenRolle(body);
  if (error) return err(error);

  const vorhanden = await env.DB.prepare(
    `SELECT id FROM personen_rollen WHERE name = ? COLLATE NOCASE`
  ).bind(value.name).first();
  if (vorhanden) return err('Diese Rolle gibt es bereits', 409);

  const res = await env.DB.prepare(
    `INSERT INTO personen_rollen (name, sort_order) VALUES (?, ?)`
  ).bind(value.name, value.sort_order).run();

  return json({ id: res.meta.last_row_id, ...value, zuordnungen: 0 }, { status: 201 });
}
