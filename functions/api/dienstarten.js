// GET  /api/dienstarten — Dienstarten (eingeloggte Benutzer)
// POST /api/dienstarten — neue Dienstart anlegen (Admin)
//
// Eigene Tabelle statt Freitext, weil die Freitext-Variante schon
// auseinandergelaufen war ("Veranstaltungen" neben "Veranstaltung"). Als
// Freitext zerfällt eine Dienstart in jeder Gruppierung in zwei Gruppen.
//
// kategorie trennt echte Übungen von Sitzungen und Veranstaltungen. Die
// Auswertung braucht diese Unterscheidung — ohne sie würde "Teilnahmen an
// Übungen" auch Versammlungen und Osterfeuer mitzählen.
import { json, err, unauthorized, forbidden, isAppAdmin } from '../_lib/auth.js';
import { mitStammdaten } from '../_lib/stammdaten.js';

export const KATEGORIEN = Object.freeze(['uebung', 'dienst', 'sonstiges']);

export function validateDienstart(body) {
  const name = String(body?.name || '').trim();
  if (!name) return { error: 'Name fehlt' };
  if (name.length > 80) return { error: 'Name zu lang (max. 80 Zeichen)' };

  const kategorie = String(body?.kategorie || 'sonstiges').trim();
  if (!KATEGORIEN.includes(kategorie)) {
    return { error: `kategorie muss eine von: ${KATEGORIEN.join(', ')}` };
  }
  const sort_order = Number.isFinite(Number(body?.sort_order))
    ? Math.trunc(Number(body.sort_order)) : 100;

  return { value: { name, kategorie, sort_order } };
}

export async function onRequestGet({ env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  return mitStammdaten('dienstarten', async () => {
    const { results } = await env.DB.prepare(
      `SELECT d.id, d.name, d.kategorie, d.sort_order,
              (SELECT COUNT(*) FROM themen t WHERE t.dienstart_id = d.id) AS themen_anzahl
       FROM dienstarten d
       ORDER BY d.sort_order, d.name COLLATE NOCASE`
    ).all();
    return json(results);
  });
}

export async function onRequestPost({ request, env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();
  if (!isAppAdmin(data.user)) return forbidden();

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  const { value, error } = validateDienstart(body);
  if (error) return err(error);

  const vorhanden = await env.DB.prepare(
    `SELECT id FROM dienstarten WHERE name = ? COLLATE NOCASE`
  ).bind(value.name).first();
  if (vorhanden) return err('Diese Dienstart gibt es bereits', 409);

  const res = await env.DB.prepare(
    `INSERT INTO dienstarten (name, kategorie, sort_order) VALUES (?, ?, ?)`
  ).bind(value.name, value.kategorie, value.sort_order).run();

  return json({ id: res.meta.last_row_id, ...value, themen_anzahl: 0 }, { status: 201 });
}
