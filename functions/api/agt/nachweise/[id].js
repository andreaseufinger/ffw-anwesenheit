// PUT    /api/agt/nachweise/:id — Häkchen setzen (pass, florix), bei
//        manuellen Einträgen auch Datum, Gültigkeit und Bemerkung ändern.
// DELETE /api/agt/nachweise/:id — manuelle Einträge werden gelöscht.
//        Automatische (Anwesenheit, Einsatzprotokoll) werden zurückgenommen
//        (verworfen = 1), sonst legte der nächste Abgleich sie wieder an.
//        Florix-Einträge kommen aus dem Import und bleiben.
//        PUT { verworfen: false } stellt einen zurückgenommenen wieder her.
import { json, err, unauthorized, forbidden, darfAtemschutz } from '../../../_lib/auth.js';
import { auditEintrag } from '../../../_lib/audit.js';
import { mitAtemschutz } from '../../agt.js';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

async function lade(env, id) {
  return env.DB.prepare(`SELECT * FROM agt_nachweise WHERE id = ?`).bind(id).first();
}

export async function onRequestPut({ request, env, params, data }) {
  if (!data.user) return unauthorized();
  if (!darfAtemschutz(data.user)) return forbidden();
  const id = Number(params.id);
  if (!Number.isInteger(id)) return err('Ungültige ID');
  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  return mitAtemschutz(async () => {
    const alt = await lade(env, id);
    if (!alt) return err('Nachweis nicht gefunden', 404);

    const neu = {};
    for (const k of ['pass', 'florix']) {
      if (k in body) neu[k] = body[k] ? 1 : 0;
    }
    const manuell = alt.quelle === 'manuell';
    for (const k of ['datum', 'gueltig_bis']) {
      if (!(k in body)) continue;
      if (!manuell) return err('Datum nur bei manuell eingetragenen Nachweisen änderbar');
      const v = body[k] ? String(body[k]) : null;
      if (v && !ISO.test(v)) return err(`${k} ungültig`);
      neu[k] = v;
    }
    if ('bemerkung' in body) neu.bemerkung = String(body.bemerkung || '').trim() || null;
    if ('verworfen' in body) {
      if (!['anwesenheit', 'einsatz'].includes(alt.quelle)) return err('Nur automatische Nachweise lassen sich zurücknehmen');
      neu.verworfen = body.verworfen ? 1 : 0;
    }

    const geaendert = Object.keys(neu).filter((k) => neu[k] !== alt[k]);
    if (!geaendert.length) return json({ ok: true, unveraendert: true });

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE agt_nachweise SET ${geaendert.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`
      ).bind(...geaendert.map((k) => neu[k]), id),
      auditEintrag(env, data.user, {
        bereich: 'atemschutz', aktion: 'aendern', objekt: 'nachweis', objektId: id,
        details: Object.fromEntries(geaendert.map((k) => [k, { alt: alt[k], neu: neu[k] }])),
      }),
    ]);
    return json({ ok: true });
  });
}

export async function onRequestDelete({ env, params, data }) {
  if (!data.user) return unauthorized();
  if (!darfAtemschutz(data.user)) return forbidden();
  const id = Number(params.id);
  if (!Number.isInteger(id)) return err('Ungültige ID');

  return mitAtemschutz(async () => {
    const alt = await lade(env, id);
    if (!alt) return err('Nachweis nicht gefunden', 404);
    if (alt.quelle === 'florix') {
      return err('Nachweise aus dem Florix-Import lassen sich nicht löschen.');
    }
    if (alt.quelle !== 'manuell') {
      await env.DB.batch([
        env.DB.prepare(`UPDATE agt_nachweise SET verworfen = 1 WHERE id = ?`).bind(id),
        auditEintrag(env, data.user, {
          bereich: 'atemschutz', aktion: 'aendern', objekt: 'nachweis', objektId: id,
          details: { verworfen: { alt: alt.verworfen, neu: 1 }, quelle: alt.quelle },
        }),
      ]);
      return json({ ok: true, verworfen: true });
    }
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM agt_nachweise WHERE id = ?`).bind(id),
      auditEintrag(env, data.user, {
        bereich: 'atemschutz', aktion: 'loeschen', objekt: 'nachweis', objektId: id,
        details: { person_id: alt.person_id, art: alt.art, datum: alt.datum, gueltig_bis: alt.gueltig_bis },
      }),
    ]);
    return json({ ok: true });
  });
}
