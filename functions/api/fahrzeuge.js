// GET  /api/fahrzeuge — Stammdaten Liste (alle eingeloggten Benutzer)
// POST /api/fahrzeuge — neues Fahrzeug anlegen (Admin)
import { json, err, unauthorized, forbidden, isEpAdmin } from '../_lib/auth.js';

function requireAdmin(data) {
  if (!data.user) return unauthorized();
  if (!isEpAdmin(data.user)) return forbidden();
  return null;
}

function parsePositionen(raw) {
  if (!Array.isArray(raw)) return null;
  const cleaned = raw
    .map((p) => String(p || '').trim())
    .filter(Boolean);
  if (!cleaned.length) return null;
  if (new Set(cleaned).size !== cleaned.length) return null;
  return cleaned;
}

export async function onRequestGet({ env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  const { results } = await env.DB.prepare(
    `SELECT id, kennung, name, positionen, sort_order, aktiv
     FROM einsatz_fahrzeuge_stamm
     ORDER BY sort_order, name COLLATE NOCASE`
  ).all();

  for (const r of results) {
    try { r.positionen = JSON.parse(r.positionen); } catch { r.positionen = []; }
  }
  return json(results);
}

export async function onRequestPost({ request, env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  const denied = requireAdmin(data);
  if (denied) return denied;

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  const kennung = String(body?.kennung || '').trim();
  const name = String(body?.name || '').trim();
  const positionen = parsePositionen(body?.positionen);
  const sortOrder = Number.isFinite(body?.sort_order) ? Math.trunc(body.sort_order) : 100;
  const aktiv = body?.aktiv === false ? 0 : 1;

  if (!kennung) return err('Kennung fehlt');
  if (!name) return err('Name fehlt');
  if (!positionen) return err('Positionen müssen ein nicht-leeres Array eindeutiger Werte sein');

  const existing = await env.DB.prepare(`SELECT id FROM einsatz_fahrzeuge_stamm WHERE kennung = ?`)
    .bind(kennung).first();
  if (existing) return err('Kennung bereits vergeben', 409);

  const res = await env.DB.prepare(
    `INSERT INTO einsatz_fahrzeuge_stamm (kennung, name, positionen, sort_order, aktiv)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(kennung, name, JSON.stringify(positionen), sortOrder, aktiv).run();

  return json({ id: res.meta.last_row_id, kennung, name, positionen, sort_order: sortOrder, aktiv }, { status: 201 });
}
