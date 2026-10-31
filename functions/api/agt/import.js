// POST /api/agt/import — Export "Tauglichkeiten Atemschutz" aus ZMS-Hessen
// (Florix) übernehmen. Die CSV liest die App im Browser; hierher kommen nur
// Name, Organisation und die Daten je Nachweis. Geburtsdaten verlassen den
// Browser nicht.
//
// Body: { stichtag, zeilen: [{ name, organisation, lehrgang, strecke, g263,
//         unterweisung, einsatz, einsatzuebung }], zuordnung: { name: id|0 },
//         uebernehmen: bool }
// - uebernehmen=false: Vorschau (wer wird zugeordnet, wer ist offen, wer
//   fehlt im Export, wie viele Florix-Daten sind neu).
// - uebernehmen=true: AGT-Kennzeichen setzen, Florix-Nachweise anlegen und
//   "In Florix eingetragen" an allen Nachweisen setzen, die Florix abdeckt
//   (gleiche Art, Ablaufdatum bis einschließlich Florix-Datum).
// Personen, die nicht mehr im Export stehen, werden nur gemeldet.
import { json, err, unauthorized, forbidden, darfAtemschutz } from '../../_lib/auth.js';
import { auditEintrag } from '../../_lib/audit.js';
import { mitAtemschutz } from '../agt.js';

const ARTEN = ['lehrgang', 'strecke', 'g263', 'unterweisung', 'einsatz', 'einsatzuebung'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function teile(name) {
  const i = name.indexOf(',');
  if (i < 0) return null;
  return { nachname: name.slice(0, i).trim(), vorname: name.slice(i + 1).trim() };
}

export async function onRequestPost({ request, env, data }) {
  if (!data.user) return unauthorized();
  if (!darfAtemschutz(data.user)) return forbidden();
  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  const zeilen = (Array.isArray(body?.zeilen) ? body.zeilen : [])
    .map((z) => ({ ...z, name: String(z?.name || '').trim() }))
    .filter((z) => z.name);
  if (!zeilen.length) return err('Keine Zeilen im Import');
  const stichtag = ISO.test(String(body?.stichtag || '')) ? body.stichtag : null;
  const zuordnung = body?.zuordnung && typeof body.zuordnung === 'object' ? body.zuordnung : {};

  return mitAtemschutz(async () => {
    const [personen, gemerkt, florixDa] = await Promise.all([
      env.DB.prepare(`SELECT id, nachname, vorname, aktiv, agt FROM personen`).all(),
      env.DB.prepare(`SELECT name, person_id FROM agt_namen`).all(),
      env.DB.prepare(
        `SELECT person_id, art, quelle_ref FROM agt_nachweise WHERE quelle = 'florix'`
      ).all(),
    ]);
    const byId = new Map(personen.results.map((p) => [p.id, p]));
    const merk = new Map(gemerkt.results.map((g) => [g.name.toLowerCase(), g.person_id]));
    const vorhanden = new Set(florixDa.results.map((f) => `${f.person_id}|${f.art}|${f.quelle_ref}`));

    const zugeordnet = [];
    const offen = [];
    for (const z of zeilen) {
      let id;
      if (Object.prototype.hasOwnProperty.call(zuordnung, z.name)) {
        id = Number(zuordnung[z.name]) || 0;          // 0 = bewusst übersprungen
      } else if (merk.has(z.name.toLowerCase())) {
        id = merk.get(z.name.toLowerCase()) ?? 0;
      } else {
        const t = teile(z.name);
        const treffer = t ? personen.results.filter((p) =>
          p.nachname.toLowerCase() === t.nachname.toLowerCase()
          && p.vorname.toLowerCase() === t.vorname.toLowerCase()) : [];
        id = treffer.length === 1 ? treffer[0].id : undefined;
      }
      if (id === undefined) { offen.push({ name: z.name, organisation: z.organisation || '' }); continue; }
      if (id === 0) continue;
      const p = byId.get(id);
      if (!p) { offen.push({ name: z.name, organisation: z.organisation || '' }); continue; }
      const daten = {};
      let neu = 0;
      for (const art of ARTEN) {
        const v = z[art];
        if (!v || !ISO.test(String(v))) continue;
        daten[art] = String(v);
        if (!vorhanden.has(`${id}|${art}|${v}`)) neu++;
      }
      zugeordnet.push({ name: z.name, person_id: id, person: `${p.nachname}, ${p.vorname}`,
                        neu_agt: !p.agt, neue_daten: neu, daten });
    }
    const imExport = new Set(zugeordnet.map((z) => z.person_id));
    const nichtMehr = personen.results
      .filter((p) => p.agt && !imExport.has(p.id))
      .map((p) => ({ person_id: p.id, person: `${p.nachname}, ${p.vorname}` }));

    if (!body?.uebernehmen) {
      return json({
        stichtag,
        zeilen: zeilen.length,
        zugeordnet: zugeordnet.map(({ daten, ...rest }) => rest),
        offen,
        nicht_mehr: nichtMehr,
        neue_daten: zugeordnet.reduce((s, z) => s + z.neue_daten, 0),
        // Auswahl für offene Namen: alle aktiven Personen
        personen: offen.length
          ? personen.results.filter((p) => p.aktiv)
              .map((p) => ({ id: p.id, name: `${p.nachname}, ${p.vorname}` }))
              .sort((a, b) => a.name.localeCompare(b.name, 'de'))
          : [],
      });
    }
    if (offen.length) return err(`Noch ${offen.length} Name(n) ohne Zuordnung`);

    const st = [];
    // Bewusste Zuordnungen merken, auch "überspringen" (person_id NULL)
    for (const [name, id] of Object.entries(zuordnung)) {
      st.push(env.DB.prepare(
        `INSERT INTO agt_namen (name, person_id) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET person_id = excluded.person_id`
      ).bind(name, Number(id) || null));
    }
    const insert = env.DB.prepare(
      `INSERT OR IGNORE INTO agt_nachweise
         (person_id, art, datum, gueltig_bis, quelle, quelle_ref, florix, created_by)
       VALUES (?, ?, ?, ?, 'florix', ?, 1, ?)`
    );
    const haken = env.DB.prepare(
      `UPDATE agt_nachweise SET florix = 1
       WHERE person_id = ? AND art = ? AND florix = 0
         AND (gueltig_bis IS NULL OR gueltig_bis <= ?)`
    );
    for (const z of zugeordnet) {
      if (z.neu_agt) st.push(env.DB.prepare(`UPDATE personen SET agt = 1 WHERE id = ?`).bind(z.person_id));
      for (const [art, v] of Object.entries(z.daten)) {
        const lehrgang = art === 'lehrgang';
        st.push(insert.bind(z.person_id, art, lehrgang ? v : null, lehrgang ? null : v, v, data.user.username));
        st.push(haken.bind(z.person_id, art, lehrgang ? '9999-12-31' : v));
      }
    }
    st.push(env.DB.prepare(
      `INSERT INTO agt_importe (stichtag, zeilen, importiert_by) VALUES (?, ?, ?)`
    ).bind(stichtag, zeilen.length, data.user.username));
    st.push(auditEintrag(env, data.user, {
      bereich: 'atemschutz', aktion: 'import', objekt: 'florix',
      details: {
        stichtag, zeilen: zeilen.length, zugeordnet: zugeordnet.length,
        neue_agt: zugeordnet.filter((z) => z.neu_agt).map((z) => z.person_id),
        neue_daten: zugeordnet.reduce((s, z) => s + z.neue_daten, 0),
        nicht_mehr: nichtMehr.map((p) => p.person_id),
      },
    }));
    await env.DB.batch(st);
    return json({ ok: true, zugeordnet: zugeordnet.length, nicht_mehr: nichtMehr });
  });
}
