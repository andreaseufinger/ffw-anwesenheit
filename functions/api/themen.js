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
import { erlaubteAbteilungen, darfAbteilung, darfVerwalten,
         darfIrgendwasVerwalten } from '../_lib/auth.js';
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

  let abteilung_id = null;
  if (body?.abteilung_id !== undefined && body.abteilung_id !== null && body.abteilung_id !== '') {
    const n = Number(body.abteilung_id);
    if (!Number.isFinite(n)) return { error: 'abteilung_id ungültig' };
    abteilung_id = Math.trunc(n);
  }

  return {
    value: {
      dienstart_id: Math.trunc(dienstart_id), thema, abteilung, abteilung_id, prioritaet,
      aktiv: body?.aktiv === undefined ? 1 : (body.aktiv ? 1 : 0),
    },
  };
}

export async function onRequestGet({ request, env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  const params = new URL(request.url).searchParams;
  const alle = params.get('alle') === '1';
  if (alle && !darfIrgendwasVerwalten(data.user)) return forbidden();

  const rohAbt = params.get('abteilung_id');
  let abteilungId = null;
  if (rohAbt !== null && rohAbt !== '') {
    const n = Number(rohAbt);
    if (!Number.isFinite(n)) return err('abteilung_id ungültig');
    abteilungId = Math.trunc(n);
    const erlaubt = await erlaubteAbteilungen(env, data.user);
    if (!darfAbteilung(erlaubt, abteilungId)) return forbidden();
  }

  return mitStammdaten('themen', async () => {
    const bedingungen = [];
    const binds = [];
    if (!alle) bedingungen.push('t.aktiv = 1');
    if (abteilungId !== null) { bedingungen.push('t.abteilung_id = ?'); binds.push(abteilungId); }
    const where = bedingungen.length ? 'WHERE ' + bedingungen.join(' AND ') : '';
    const { results } = await env.DB.prepare(
      `SELECT t.id, t.dienstart_id, d.name AS dienstart, d.kategorie,
              t.thema, t.abteilung, t.abteilung_id, t.prioritaet, t.aktiv
       FROM themen t
       JOIN dienstarten d ON d.id = t.dienstart_id
       ${where}
       ORDER BY d.sort_order, t.prioritaet, t.thema COLLATE NOCASE`
    ).bind(...binds).all();
    return json(results);
  });
}

export async function onRequestPost({ request, env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  const { value, error } = validateThema(body);
  if (error) return err(error);

  // Ein Thema gehört zu einer Abteilung — und nur dort darf es angelegt
  // werden. Ohne Angabe die einzige, für die der Benutzer zuständig ist.
  if (value.abteilung_id === null) {
    const erlaubt = await erlaubteAbteilungen(env, data.user);
    if (erlaubt !== null && erlaubt.length === 1) value.abteilung_id = erlaubt[0];
  }
  if (value.abteilung_id === null) return err('abteilung_id fehlt');
  if (!(await darfVerwalten(env, data.user, value.abteilung_id))) return forbidden();

  const da = await env.DB.prepare(`SELECT id FROM dienstarten WHERE id = ?`)
    .bind(value.dienstart_id).first();
  if (!da) return err('Dienstart nicht gefunden', 404);

  const vorhanden = await env.DB.prepare(
    `SELECT id FROM themen WHERE dienstart_id = ? AND thema = ? COLLATE NOCASE`
  ).bind(value.dienstart_id, value.thema).first();
  if (vorhanden) return err('Dieses Thema gibt es in dieser Dienstart bereits', 409);

  const res = await env.DB.prepare(
    `INSERT INTO themen (dienstart_id, thema, abteilung, prioritaet, aktiv, abteilung_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(value.dienstart_id, value.thema, value.abteilung, value.prioritaet,
         value.aktiv, value.abteilung_id).run();

  return json({ id: res.meta.last_row_id, ...value }, { status: 201 });
}
