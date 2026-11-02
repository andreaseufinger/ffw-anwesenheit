// POST /api/agt/import — Export "Tauglichkeiten Atemschutz" aus Florix
// (ZMS-Hessen) übernehmen. Die CSV liest die App im Browser; hierher kommen nur
// Name, Organisation und die Daten je Nachweis. Geburtsdaten verlassen den
// Browser nicht.
//
// Body: { stichtag, zeilen: [{ name, organisation, lehrgang, strecke, g263,
//         unterweisung, einsatz, einsatzuebung }], zuordnung: { name: id|0 },
//         uebernehmen: bool, plan: Prüfsumme }
// Ein Plan für Vorschau und Buchen (baueAgtPlan): Er enthält die Änderungsliste
// und die daraus folgenden Anweisungen.
// - uebernehmen=false: Vorschau mit `aenderungen` (Liste, siehe baueAgtPlan)
//   und `plan` (Prüfsumme der Liste). Solange Namen offen sind, gibt es beides
//   noch nicht.
// - uebernehmen=true: braucht `plan` aus der Vorschau (sonst 400). Der Server
//   rechnet den Plan neu; weicht die Prüfsumme ab, antwortet er 409. Dann
//   werden AGT-Kennzeichen gesetzt, Florix-Nachweise angelegt und "In Florix
//   eingetragen" an allen Nachweisen gesetzt, die Florix abdeckt (gleiche Art,
//   Ablaufdatum bis einschließlich Florix-Datum).
// Personen, die nicht mehr im Export stehen, werden nur gemeldet.
import { json, err, unauthorized, forbidden, darfAtemschutz } from '../../_lib/auth.js';
import { auditEintrag } from '../../_lib/audit.js';
import { planPruefsumme } from '../../_lib/importplan.js';
import { mitAtemschutz } from '../agt.js';

const ARTEN = ['lehrgang', 'strecke', 'g263', 'unterweisung', 'einsatz', 'einsatzuebung'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function teile(name) {
  const i = name.indexOf(',');
  if (i < 0) return null;
  return { nachname: name.slice(0, i).trim(), vorname: name.slice(i + 1).trim() };
}

const nameVon = (p) => `${p.nachname}, ${p.vorname}`;
const nachName = (a, b) => a.person.localeCompare(b.person, 'de') || (a.art || '').localeCompare(b.art || '');

// Rechnet aus Body und Datenbank den vollständigen Plan: offene Namen, die
// Änderungsliste und alles, was zum Buchen nötig ist.
async function baueAgtPlan(env, { zeilen, zuordnung }) {
  const [personen, gemerkt, florixDa, ohneHaken] = await Promise.all([
    env.DB.prepare(`SELECT id, nachname, vorname, aktiv, agt FROM personen`).all(),
    env.DB.prepare(`SELECT name, person_id FROM agt_namen`).all(),
    env.DB.prepare(
      `SELECT person_id, art, quelle_ref FROM agt_nachweise WHERE quelle = 'florix'`
    ).all(),
    env.DB.prepare(
      `SELECT person_id, art, gueltig_bis FROM agt_nachweise WHERE florix = 0`
    ).all(),
  ]);
  const byId = new Map(personen.results.map((p) => [p.id, p]));
  const merk = new Map(gemerkt.results.map((g) => [g.name.toLowerCase(), g.person_id]));
  const vorhanden = new Set(florixDa.results.map((f) => `${f.person_id}|${f.art}|${f.quelle_ref}`));
  const letztes = new Map();      // bisheriges Florix-Datum je Person und Art
  for (const f of florixDa.results) {
    const k = `${f.person_id}|${f.art}`;
    if (!letztes.has(k) || f.quelle_ref > letztes.get(k)) letztes.set(k, f.quelle_ref);
  }

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
    zugeordnet.push({ name: z.name, person_id: id, person: nameVon(p),
                      neu_agt: !p.agt, neue_daten: neu, daten });
  }
  const imExport = new Set(zugeordnet.map((z) => z.person_id));
  const nichtMehr = personen.results
    .filter((p) => p.agt && !imExport.has(p.id))
    .map((p) => ({ person_id: p.id, person: nameVon(p) }));

  // Änderungsliste (genau das, was beim Buchen geschieht)
  const aenderungen = {
    neue_geraetetraeger: zugeordnet.filter((z) => z.neu_agt)
      .map((z) => ({ person_id: z.person_id, person: z.person })).sort(nachName),
    neue_daten: [], haken: [], zuordnungen: [],
    nicht_mehr: [...nichtMehr].sort(nachName),
    unveraendert: 0,
  };
  for (const z of zugeordnet) {
    for (const [art, v] of Object.entries(z.daten)) {
      if (vorhanden.has(`${z.person_id}|${art}|${v}`)) aenderungen.unveraendert++;
      else aenderungen.neue_daten.push({ person_id: z.person_id, person: z.person, art,
        alt: letztes.get(`${z.person_id}|${art}`) || null, neu: v });
      // Der Haken gilt für bestehende Nachweise ohne Haken, die Florix abdeckt.
      const bis = art === 'lehrgang' ? '9999-12-31' : v;
      const anzahl = ohneHaken.results.filter((n) => n.person_id === z.person_id && n.art === art
        && (n.gueltig_bis == null || n.gueltig_bis <= bis)).length;
      if (anzahl) aenderungen.haken.push({ person_id: z.person_id, person: z.person, art, anzahl });
    }
  }
  for (const [name, wert] of Object.entries(zuordnung)) {
    const id = Number(wert) || null;
    const bisher = merk.has(name.toLowerCase()) ? merk.get(name.toLowerCase()) : undefined;
    if (bisher === id) continue;
    aenderungen.zuordnungen.push({ name, person_id: id, person: id && byId.get(id) ? nameVon(byId.get(id)) : null });
  }
  aenderungen.neue_daten.sort(nachName);
  aenderungen.haken.sort(nachName);
  aenderungen.zuordnungen.sort((a, b) => a.name.localeCompare(b.name, 'de'));

  return { personen: personen.results, zugeordnet, offen, nichtMehr, aenderungen };
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
    const { personen, zugeordnet, offen, nichtMehr, aenderungen } = await baueAgtPlan(env, { zeilen, zuordnung });
    const plan = offen.length ? null : await planPruefsumme(aenderungen);

    if (!body?.uebernehmen) {
      return json({
        stichtag,
        zeilen: zeilen.length,
        zugeordnet: zugeordnet.map(({ daten, ...rest }) => rest),
        offen,
        nicht_mehr: nichtMehr,
        neue_daten: zugeordnet.reduce((s, z) => s + z.neue_daten, 0),
        aenderungen: offen.length ? null : aenderungen,
        plan,
        // Auswahl für offene Namen: alle aktiven Personen
        personen: offen.length
          ? personen.filter((p) => p.aktiv)
              .map((p) => ({ id: p.id, name: nameVon(p) }))
              .sort((a, b) => a.name.localeCompare(b.name, 'de'))
          : [],
      });
    }
    if (offen.length) return err(`Noch ${offen.length} Name(n) ohne Zuordnung`);
    if (!body?.plan) return err('Der Import braucht die Vorschau (plan fehlt)');
    if (body.plan !== plan) {
      return err('Der Stand hat sich seit der Vorschau geändert', 409);
    }

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
        plan,
      },
    }));
    await env.DB.batch(st);
    return json({ ok: true, zugeordnet: zugeordnet.length, nicht_mehr: nichtMehr });
  });
}
