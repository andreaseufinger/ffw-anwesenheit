// PUT /api/attendance/:id/florix  { erfasst: true|false }
//
// Kennzeichen, dass der Termin in Florix übertragen ist. Setzen und
// zurücknehmen dürfen nur Admins: der übergreifende Admin und der
// Abteilungsadmin der Abteilung des Termins.
import { json, err, unauthorized, forbidden, darfVerwalten } from '../../../_lib/auth.js';
import { protokolliere } from '../../../_lib/audit.js';

export async function onRequestPut({ request, env, data, params }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  const id = Number(params.id);
  if (!Number.isFinite(id)) return err('Ungültige ID');
  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  if (typeof body?.erfasst !== 'boolean') return err('erfasst (true/false) fehlt');

  const s = await env.DB.prepare(
    `SELECT id, datum, thema, abteilung_id FROM attendance_sessions WHERE id = ?`
  ).bind(id).first();
  if (!s) return err('Nicht gefunden', 404);
  if (!(await darfVerwalten(env, data.user, s.abteilung_id))) return forbidden();

  if (body.erfasst) {
    await env.DB.prepare(
      `UPDATE attendance_sessions SET florix_erfasst_at = CURRENT_TIMESTAMP, florix_erfasst_by = ?
       WHERE id = ? AND florix_erfasst_at IS NULL`
    ).bind(data.user.username, id).run();
  } else {
    await env.DB.prepare(
      `UPDATE attendance_sessions SET florix_erfasst_at = NULL, florix_erfasst_by = NULL WHERE id = ?`
    ).bind(id).run();
  }
  await protokolliere(env, data.user, {
    bereich: 'anwesenheit', aktion: body.erfasst ? 'florix_erfasst' : 'florix_offen',
    objekt: 'attendance_session', objektId: id, details: { datum: s.datum, thema: s.thema },
  });

  const neu = await env.DB.prepare(
    `SELECT florix_erfasst_at, florix_erfasst_by FROM attendance_sessions WHERE id = ?`
  ).bind(id).first();
  return json(neu);
}
