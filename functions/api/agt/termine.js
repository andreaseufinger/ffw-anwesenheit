// GET  /api/agt/termine — alle Termine der Atemschutzstrecke mit Zahl der
//      geplanten AGT.
// POST /api/agt/termine — { termine: [{ datum, uhrzeit, kunden, art }] }
//      legt Termine an (einzeln oder aus der eingefügten Jahresliste).
//      Vorhandene (gleiches Datum und gleiche Uhrzeit) bleiben unverändert.
import { json, err, unauthorized, forbidden, darfAtemschutz } from '../../_lib/auth.js';
import { auditEintrag } from '../../_lib/audit.js';
import { mitAtemschutz } from '../agt.js';

export const TERMIN_ARTEN = ['eigen', 'ausweich', 'weitere'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const UHR = /^\d{2}:\d{2}$/;

export function terminPruefen(t) {
  const datum = String(t?.datum || '');
  if (!ISO.test(datum)) return { fehler: 'Datum fehlt oder ungültig' };
  const uhrzeit = t?.uhrzeit ? String(t.uhrzeit) : null;
  if (uhrzeit && !UHR.test(uhrzeit)) return { fehler: 'Uhrzeit ungültig (HH:MM)' };
  const art = TERMIN_ARTEN.includes(t?.art) ? t.art : 'weitere';
  const kunden = String(t?.kunden || '').trim() || null;
  return { datum, uhrzeit, kunden, art };
}

export async function onRequestGet({ env, data }) {
  if (!data.user) return unauthorized();
  if (!darfAtemschutz(data.user)) return forbidden();
  return mitAtemschutz(async () => {
    const { results } = await env.DB.prepare(
      `SELECT t.id, t.datum, t.uhrzeit, t.kunden, t.art,
              (SELECT COUNT(*) FROM agt_planung p WHERE p.termin_id = t.id) AS geplant
       FROM agt_strecke_termine t ORDER BY t.datum, t.uhrzeit`
    ).all();
    return json(results);
  });
}

export async function onRequestPost({ request, env, data }) {
  if (!data.user) return unauthorized();
  if (!darfAtemschutz(data.user)) return forbidden();
  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  const liste = Array.isArray(body?.termine) ? body.termine : [];
  if (!liste.length) return err('Keine Termine');
  const geprueft = liste.map(terminPruefen);
  const fehler = geprueft.find((t) => t.fehler);
  if (fehler) return err(fehler.fehler);

  return mitAtemschutz(async () => {
    const ins = env.DB.prepare(
      `INSERT OR IGNORE INTO agt_strecke_termine (datum, uhrzeit, kunden, art) VALUES (?, ?, ?, ?)`);
    const res = await env.DB.batch([
      ...geprueft.map((t) => ins.bind(t.datum, t.uhrzeit, t.kunden, t.art)),
      auditEintrag(env, data.user, {
        bereich: 'atemschutz', aktion: 'anlegen', objekt: 'strecke-termin',
        details: { anzahl: geprueft.length, von: geprueft[0].datum, bis: geprueft[geprueft.length - 1].datum },
      }),
    ]);
    const neu = res.slice(0, geprueft.length).reduce((s, r) => s + (r.meta?.changes || 0), 0);
    return json({ ok: true, neu, vorhanden: geprueft.length - neu }, { status: 201 });
  });
}
