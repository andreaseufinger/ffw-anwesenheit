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
import { erlaubteAbteilungen, darfAbteilung } from '../_lib/auth.js';
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

  // null = gilt für alle Abteilungen; gesetzt = nur dort (z. B. eine
  // Jugend-eigene "Zeltlager"-Dienstart, die in der Einsatzabteilung nicht
  // auftauchen soll).
  let abteilung_id = null;
  if (body?.abteilung_id !== undefined && body.abteilung_id !== null && body.abteilung_id !== '') {
    const n = Number(body.abteilung_id);
    if (!Number.isFinite(n)) return { error: 'abteilung_id ungültig' };
    abteilung_id = Math.trunc(n);
  }

  return { value: { name, kategorie, sort_order, abteilung_id } };
}

export async function onRequestGet({ request, env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  const rohAbt = new URL(request.url).searchParams.get('abteilung_id');
  let abteilungId = null;
  if (rohAbt !== null && rohAbt !== '') {
    const n = Number(rohAbt);
    if (!Number.isFinite(n)) return err('abteilung_id ungültig');
    abteilungId = Math.trunc(n);
    const erlaubt = await erlaubteAbteilungen(env, data.user);
    if (!darfAbteilung(erlaubt, abteilungId)) return forbidden();
  }

  return mitStammdaten('dienstarten', async () => {
    // abteilung_id IS NULL heißt "gilt für alle Abteilungen" — diese
    // Dienstarten erscheinen immer mit.
    const where = abteilungId !== null
      ? 'WHERE d.abteilung_id IS NULL OR d.abteilung_id = ?' : '';
    const binds = abteilungId !== null ? [abteilungId] : [];
    const { results } = await env.DB.prepare(
      `SELECT d.id, d.name, d.kategorie, d.sort_order, d.abteilung_id,
              (SELECT COUNT(*) FROM themen t WHERE t.dienstart_id = d.id) AS themen_anzahl
       FROM dienstarten d
       ${where}
       ORDER BY d.sort_order, d.name COLLATE NOCASE`
    ).bind(...binds).all();
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

  if (value.abteilung_id !== null) {
    const abt = await env.DB.prepare(`SELECT id FROM abteilungen WHERE id = ?`)
      .bind(value.abteilung_id).first();
    if (!abt) return err('Abteilung nicht gefunden', 404);
  }

  const res = await env.DB.prepare(
    `INSERT INTO dienstarten (name, kategorie, sort_order, abteilung_id) VALUES (?, ?, ?, ?)`
  ).bind(value.name, value.kategorie, value.sort_order, value.abteilung_id).run();

  return json({ id: res.meta.last_row_id, ...value, themen_anzahl: 0 }, { status: 201 });
}
