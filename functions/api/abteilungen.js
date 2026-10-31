// GET  /api/abteilungen — Abteilungen, auf die der Benutzer Zugriff hat
// POST /api/abteilungen — neue Abteilung anlegen (nur übergreifender Admin)
//
// Liefert dem Frontend alles, was es für den Umschalter in der Erfassung
// braucht: welche Abteilungen erlaubt sind, welche vorbelegt wird und mit
// welchen Zeiten. Nichts davon steht im Code — eine dritte Abteilung ist
// reine Datenpflege.
//
// Die Vorauswahl ist die niedrigste sort_order unter den erlaubten
// Abteilungen. Einsatzabteilung hat 10, Jugendfeuerwehr 20; damit ist die
// Einsatzabteilung vorbelegt, sobald jemand für beide berechtigt ist.
import {
  json, err, unauthorized, forbidden,
  isUebergreifenderAdmin, erlaubteAbteilungen,
} from '../_lib/auth.js';
import { mitStammdaten } from '../_lib/stammdaten.js';

const ZEIT = /^\d{2}:\d{2}$/;

export function validateAbteilung(body) {
  const name = String(body?.name || '').trim();
  if (!name) return { error: 'Name fehlt' };
  if (name.length > 80) return { error: 'Name zu lang (max. 80 Zeichen)' };

  const kurz = String(body?.kurz || '').trim() || null;
  if (kurz && kurz.length > 10) return { error: 'Kürzel zu lang (max. 10 Zeichen)' };

  const zeit = (v, feld) => {
    if (v === undefined || v === null || v === '') return { wert: null };
    const s = String(v).trim();
    if (!ZEIT.test(s)) return { error: `${feld} muss eine Uhrzeit sein (HH:MM)` };
    return { wert: s };
  };
  const von = zeit(body?.standard_zeit_von, 'Beginn'); if (von.error) return { error: von.error };
  const bis = zeit(body?.standard_zeit_bis, 'Ende');   if (bis.error) return { error: bis.error };

  // Kein Soll ist ausdrücklich erlaubt — die Jugendfeuerwehr hat keines.
  let soll = null;
  if (body?.uebung_soll_stunden !== undefined && body.uebung_soll_stunden !== null
      && body.uebung_soll_stunden !== '') {
    const n = Number(body.uebung_soll_stunden);
    if (!Number.isFinite(n) || n < 0) return { error: 'Stundensoll ungültig' };
    soll = n;
  }

  const sort = Number.isFinite(Number(body?.sort_order))
    ? Math.trunc(Number(body.sort_order)) : 100;

  return {
    value: {
      name, kurz,
      uebung_soll_stunden: soll,
      standard_zeit_von: von.wert,
      standard_zeit_bis: bis.wert,
      einsatzdienst: body?.einsatzdienst ? 1 : 0,
      sort_order: sort,
    },
  };
}

export async function onRequestGet({ env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  return mitStammdaten('abteilungen', async () => {
    const erlaubt = await erlaubteAbteilungen(env, data.user);

    const { results } = await env.DB.prepare(
      `SELECT id, name, kurz, uebung_soll_stunden,
              standard_zeit_von, standard_zeit_bis, einsatzdienst, sort_order
       FROM abteilungen
       ORDER BY sort_order, name COLLATE NOCASE`
    ).all();

    const meine = erlaubt === null
      ? results
      : results.filter((a) => erlaubt.includes(a.id));

    return json({
      abteilungen: meine,
      // Vorauswahl: niedrigste sort_order unter den erlaubten. Die Liste ist
      // schon sortiert, also das erste Element.
      vorauswahl_id: meine.length ? meine[0].id : null,
      uebergreifend: erlaubt === null,
      // Für den übergreifenden Admin zusätzlich alle, damit die Verwaltung
      // auch Abteilungen zeigt, in denen er nicht eingetragen ist.
      alle: isUebergreifenderAdmin(data.user) ? results : undefined,
    });
  });
}

export async function onRequestPost({ request, env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();
  // Abteilungen anlegen darf nur der übergreifende Admin — ein
  // Abteilungsadmin soll sich keine weitere Abteilung schaffen können.
  if (!isUebergreifenderAdmin(data.user)) return forbidden();

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  const { value, error } = validateAbteilung(body);
  if (error) return err(error);

  const vorhanden = await env.DB.prepare(
    `SELECT id FROM abteilungen WHERE name = ? COLLATE NOCASE`
  ).bind(value.name).first();
  if (vorhanden) return err('Diese Abteilung gibt es bereits', 409);

  const res = await env.DB.prepare(
    `INSERT INTO abteilungen
       (name, kurz, uebung_soll_stunden, standard_zeit_von, standard_zeit_bis,
        einsatzdienst, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(value.name, value.kurz, value.uebung_soll_stunden,
         value.standard_zeit_von, value.standard_zeit_bis,
         value.einsatzdienst, value.sort_order).run();

  return json({ id: res.meta.last_row_id, ...value }, { status: 201 });
}
