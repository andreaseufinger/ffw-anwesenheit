// GET /api/audit?bereich=&limit= — Änderungsprotokoll (nur übergreifender Admin)
//
// Liest audit_log, das beide Apps schreiben: Benutzer, Rollen, Personen,
// Abteilungen, Löschungen, Abschluss im Einsatzprotokoll, Geräte, Webhooks,
// Atemschutz und Kleidung (Review-Befund SEC8). Neueste zuerst.
import { json, err, forbidden, isUebergreifenderAdmin } from '../_lib/auth.js';

export const AUDIT_LIMIT_MAX = 500;

export async function onRequestGet({ request, env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!isUebergreifenderAdmin(data.user)) return forbidden();

  const p = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(Number(p.get('limit')) || 200, 1), AUDIT_LIMIT_MAX);
  const bereich = p.get('bereich');

  const { results } = await env.DB.prepare(
    `SELECT id, zeit, benutzer, bereich, aktion, objekt, objekt_id, details
     FROM audit_log
     WHERE ? IS NULL OR bereich = ?
     ORDER BY id DESC
     LIMIT ?`
  ).bind(bereich, bereich, limit).all();

  return json(results.map((r) => {
    let details = null;
    try { details = r.details ? JSON.parse(r.details) : null; } catch { details = r.details; }
    return { ...r, details };
  }));
}
