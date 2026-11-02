// POST   /api/einsaetze/:id/abschluss — Einsatz abschließen (Admin)
// DELETE /api/einsaetze/:id/abschluss — Einsatz wieder öffnen (Admin)
import { json, err, unauthorized, forbidden, isEpAdmin } from '../../../_lib/auth.js';
import { protokolliere, auditEintrag } from '../../../_lib/audit.js';

function requireAdmin(data) {
  if (!data.user) return unauthorized();
  if (!isEpAdmin(data.user)) return forbidden();
  return null;
}

export async function onRequestPost({ env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  const denied = requireAdmin(data); if (denied) return denied;

  const id = Number(params.id);
  if (!Number.isFinite(id)) return err('Ungültige ID');

  const e = await env.DB.prepare(`SELECT id, status FROM einsaetze WHERE id = ?`).bind(id).first();
  if (!e) return err('Nicht gefunden', 404);
  if (e.status === 'abgeschlossen') return err('Einsatz ist bereits abgeschlossen', 409);

  await env.DB.prepare(
    `UPDATE einsaetze
       SET status = 'abgeschlossen',
           abgeschlossen_at = CURRENT_TIMESTAMP,
           abgeschlossen_by = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).bind(data.user.username, id).run();

  await protokolliere(env, data.user, { bereich: 'einsatzprotokoll', aktion: 'abschliessen', objekt: 'einsatz', objektId: id });
  return json({ ok: true, status: 'abgeschlossen' });
}

export async function onRequestDelete({ env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  const denied = requireAdmin(data); if (denied) return denied;

  const id = Number(params.id);
  if (!Number.isFinite(id)) return err('Ungültige ID');

  const e = await env.DB.prepare(`SELECT id, status FROM einsaetze WHERE id = ?`).bind(id).first();
  if (!e) return err('Nicht gefunden', 404);
  if (e.status === 'offen') return err('Einsatz ist bereits offen', 409);

  await env.DB.prepare(
    `UPDATE einsaetze
       SET status = 'offen',
           abgeschlossen_at = NULL,
           abgeschlossen_by = NULL,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).bind(id).run();

  await protokolliere(env, data.user, { bereich: 'einsatzprotokoll', aktion: 'wieder_oeffnen', objekt: 'einsatz', objektId: id });
  return json({ ok: true, status: 'offen' });
}
