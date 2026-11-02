// GET  /api/ffen — Stammdaten Liste (alle eingeloggten Benutzer)
// POST /api/ffen — neue Nachbar-FF anlegen (Admin)
import { json, err, unauthorized, forbidden, isEpAdmin } from '../_lib/auth.js';

function requireAdmin(data) {
  if (!data.user) return unauthorized();
  if (!isEpAdmin(data.user)) return forbidden();
  return null;
}

export async function onRequestGet({ env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  const { results } = await env.DB.prepare(
    `SELECT id, kuerzel, name, sort_order, aktiv
     FROM einsatz_ffen_stamm
     ORDER BY sort_order, name COLLATE NOCASE`
  ).all();
  return json(results);
}

export async function onRequestPost({ request, env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  const denied = requireAdmin(data); if (denied) return denied;

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  const kuerzel = String(body?.kuerzel || '').trim();
  const name = String(body?.name || '').trim();
  const sortOrder = Number.isFinite(body?.sort_order) ? Math.trunc(body.sort_order) : 100;
  const aktiv = body?.aktiv === false ? 0 : 1;

  if (!kuerzel) return err('Kürzel fehlt');
  if (!name) return err('Name fehlt');

  const existing = await env.DB.prepare(`SELECT id FROM einsatz_ffen_stamm WHERE kuerzel = ? COLLATE NOCASE`)
    .bind(kuerzel).first();
  if (existing) return err('Kürzel bereits vergeben', 409);

  const res = await env.DB.prepare(
    `INSERT INTO einsatz_ffen_stamm (kuerzel, name, sort_order, aktiv) VALUES (?, ?, ?, ?)`
  ).bind(kuerzel, name, sortOrder, aktiv).run();

  return json({ id: res.meta.last_row_id, kuerzel, name, sort_order: sortOrder, aktiv }, { status: 201 });
}
