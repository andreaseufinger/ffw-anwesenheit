// GET /api/export — alle Anwesenheiten inkl. Teilnehmer + Tags als JSON (Admin)
// Wird vom Frontend in eine XLSX-Datei umgewandelt.
import { json, err, unauthorized, forbidden, isAppAdmin } from '../_lib/auth.js';

export async function onRequestGet({ env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();
  if (!isAppAdmin(data.user)) return forbidden();

  const { results: sessions } = await env.DB.prepare(
    `SELECT id, datum, zeit_von, zeit_bis, dienstart, thema, ausbilder,
            bemerkung, created_by, created_at
     FROM attendance_sessions
     ORDER BY datum DESC, id DESC`
  ).all();

  const { results: entries } = await env.DB.prepare(
    `SELECT id, session_id, nachname, vorname, status, bemerkung
     FROM attendance_entries
     ORDER BY session_id DESC, vorname COLLATE NOCASE, nachname COLLATE NOCASE`
  ).all();

  const { results: tags } = await env.DB.prepare(
    `SELECT id, name, sort_order FROM tags
     ORDER BY sort_order ASC, name COLLATE NOCASE ASC`
  ).all();

  const { results: entryTags } = await env.DB.prepare(
    `SELECT entry_id, tag_id FROM attendance_entry_tags`
  ).all();

  return json({ sessions, entries, tags, entryTags });
}
