// GET  /api/themen — Themenliste (eingeloggte Benutzer)
//                    ?alle=1 liefert auch deaktivierte (nur Admin)
// POST /api/themen — neues Thema anlegen (Admin)
//
// Lag früher als Static-Asset unter public/data/themen.json und war damit
// öffentlich abrufbar. Jetzt in D1 und nur für Angemeldete.
//
// Die Antwort enthält `dienstart` als Namen, damit das Frontend wie bisher
// nach Dienstart gruppieren kann, ohne die Dienstarten separat zu laden.
import { json, err, unauthorized, forbidden, isAppAdmin } from '../_lib/auth.js';
import { mitStammdaten } from '../_lib/stammdaten.js';

export function validateThema(body) {
  const thema = String(body?.thema || '').trim();
  if (!thema) return { error: 'Thema fehlt' };
  if (thema.length > 200) return { error: 'Thema zu lang (max. 200 Zeichen)' };

  const dienstart_id = Number(body?.dienstart_id);
  if (!Number.isFinite(dienstart_id)) return { error: 'Dienstart fehlt' };

  const abteilung = String(body?.abteilung || '').trim() || null;
  if (abteilung && abteilung.length > 120) return { error: 'Abteilung zu lang (max. 120 Zeichen)' };

  const prioritaet = Number.isFinite(Number(body?.prioritaet))
    ? Math.trunc(Number(body.prioritaet)) : 1;

  return {
    value: {
      dienstart_id: Math.trunc(dienstart_id), thema, abteilung, prioritaet,
      aktiv: body?.aktiv === undefined ? 1 : (body.aktiv ? 1 : 0),
    },
  };
}

export async function onRequestGet({ request, env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  const alle = new URL(request.url).searchParams.get('alle') === '1';
  if (alle && !isAppAdmin(data.user)) return forbidden();

  return mitStammdaten('themen', async () => {
    const { results } = await env.DB.prepare(
      `SELECT t.id, t.dienstart_id, d.name AS dienstart, d.kategorie,
              t.thema, t.abteilung, t.prioritaet, t.aktiv
       FROM themen t
       JOIN dienstarten d ON d.id = t.dienstart_id
       ${alle ? '' : 'WHERE t.aktiv = 1'}
       ORDER BY d.sort_order, t.prioritaet, t.thema COLLATE NOCASE`
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

  const { value, error } = validateThema(body);
  if (error) return err(error);

  const da = await env.DB.prepare(`SELECT id FROM dienstarten WHERE id = ?`)
    .bind(value.dienstart_id).first();
  if (!da) return err('Dienstart nicht gefunden', 404);

  const vorhanden = await env.DB.prepare(
    `SELECT id FROM themen WHERE dienstart_id = ? AND thema = ? COLLATE NOCASE`
  ).bind(value.dienstart_id, value.thema).first();
  if (vorhanden) return err('Dieses Thema gibt es in dieser Dienstart bereits', 409);

  const res = await env.DB.prepare(
    `INSERT INTO themen (dienstart_id, thema, abteilung, prioritaet, aktiv)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(value.dienstart_id, value.thema, value.abteilung, value.prioritaet, value.aktiv).run();

  return json({ id: res.meta.last_row_id, ...value }, { status: 201 });
}
