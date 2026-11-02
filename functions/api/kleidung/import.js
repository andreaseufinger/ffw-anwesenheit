// POST /api/kleidung/import — Export "persönliche Ausrüstung" aus Florix
// (ZMS-Hessen) übernehmen. Die CSV liest die App im Browser und schickt nur
// Zeilen mit Gemeinde-Inventarnummer (Barcode BRE…).
//
// Body: { zeilen: [{ identifikation, barcode, art, typ, groesse, person, standort }],
//         typen: { typ: artikelart_id | 0 }, namen: { name: person_id | 0 },
//         uebernehmen: bool, plan: Prüfsumme }
//
// Regeln (Konzept, Fassung 9):
// - Nur Barcode BRE…; nur Typen, die einer Artikelart zugeordnet sind (also
//   Schutzkleidung). Ob Schutzkleidung, entscheidet der Typ, nicht die
//   Florix-Spalte "Art". Unbekannte Typen fragt die Vorschau nach.
// - Abgleich nur über den Barcode (Inventarnummer): ein Teil, das bisher nur
//   in der App stand, wird so zum Florix-Teil; Florix gewinnt. Die
//   Florix-Identifikation ist ein Feld wie jedes andere. Hängt sie noch an
//   einem anderen Teil (neuer Barcode, Tausch), wird sie dort zuerst gelöscht.
// - Ein Barcode oder eine Identifikation zweimal im Export: 400.
// - "Ausgegeben an" ist "Vorname Nachname". Leer = nicht ausgegeben.
// - Teile, die im Export fehlen, verschwinden aus den Listen (im_bestand = 0);
//   ihre Reinigungshistorie bleibt.
//
// Ein Plan für Vorschau und Buchen (baueKleidungPlan): Die Vorschau liefert
// `aenderungen` (Liste der Einzelheiten) und `plan` (Prüfsumme dieser Liste),
// sobald nichts mehr offen ist. Buchen braucht diesen `plan` (sonst 400); der
// Server rechnet neu und antwortet bei abweichender Prüfsumme mit 409.
//
// Gebucht wird in EINEM env.DB.batch, also ganz oder gar nicht. Ein Import
// mit 300 neuen Teilen läuft lokal in einem Batch durch (tests/api/florix-import).
import { json, err, unauthorized, forbidden, darfKleidung } from '../../_lib/auth.js';
import { auditEintrag } from '../../_lib/audit.js';
import { planPruefsumme } from '../../_lib/importplan.js';
import { mitKleidung } from '../kleidung.js';

const s = (v) => String(v ?? '').trim();

const hat = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const nameVon = (p) => `${p.nachname}, ${p.vorname}`;

// Rechnet aus Body und Datenbank den vollständigen Plan: Offenes, Änderungsliste
// und die Teile, die gebucht werden.
async function baueKleidungPlan(env, { zeilen, typWahl, namenWahl }) {
  const [typen, arten, personen, namen, teile] = await Promise.all([
    env.DB.prepare(`SELECT typ, artikelart_id FROM kleidung_typen`).all(),
    env.DB.prepare(`SELECT id, name FROM kleidung_artikelarten ORDER BY sort_order`).all(),
    env.DB.prepare(`SELECT id, nachname, vorname, aktiv FROM personen`).all(),
    env.DB.prepare(`SELECT name, person_id FROM kleidung_namen`).all(),
    env.DB.prepare(`SELECT id, identifikation, barcode, artikelart_id, typ, groesse, person_id, standort, quelle, im_bestand FROM kleidung_teile`).all(),
  ]);
  const typMap = new Map(typen.results.map((t) => [t.typ.toLowerCase(), t.artikelart_id]));
  const namenMap = new Map(namen.results.map((n) => [n.name.toLowerCase(), n.person_id]));
  const byIdent = new Map(teile.results.filter((t) => t.identifikation).map((t) => [t.identifikation, t]));
  const byBarcode = new Map(teile.results.map((t) => [t.barcode.toUpperCase(), t]));
  const personName = new Map(personen.results.map((p) => [p.id, nameVon(p)]));
  const artName = new Map(arten.results.map((a) => [a.id, a.name]));
  const pn = (id) => (id ? personName.get(id) || `Person ${id}` : null);
  const an = (id) => (id ? artName.get(id) || `Art ${id}` : null);

  // Typen auflösen
  const offeneTypen = new Map();
  const artVon = (typ, florixArt) => {
    const k = typ.toLowerCase();
    if (hat(typWahl, typ)) return Number(typWahl[typ]) || null;
    if (typMap.has(k)) return typMap.get(k);
    if (!offeneTypen.has(typ)) offeneTypen.set(typ, { typ, zms_art: florixArt, anzahl: 0 });
    offeneTypen.get(typ).anzahl++;
    return undefined;
  };
  // Personen auflösen: "Vorname Nachname"
  const offeneNamen = new Map();
  const personVon = (name) => {
    if (!name) return null;
    const k = name.toLowerCase();
    if (hat(namenWahl, name)) return Number(namenWahl[name]) || null;
    if (namenMap.has(k)) return namenMap.get(k);
    const treffer = personen.results.filter((p) => `${p.vorname} ${p.nachname}`.toLowerCase() === k);
    if (treffer.length === 1) return treffer[0].id;
    if (!offeneNamen.has(name)) offeneNamen.set(name, { name, anzahl: 0 });
    offeneNamen.get(name).anzahl++;
    return undefined;
  };

  const FELDER = [
    ['identifikation', 'Identifikation', (v) => v || null],
    ['barcode', 'Barcode', (v) => v || null],
    ['artikelart_id', 'Artikelart', an],
    ['groesse', 'Größe', (v) => v || null],
    ['person_id', 'Ausgegeben an', pn],
    ['standort', 'Standort', (v) => v || null],
  ];
  const unterschiede = (alt, soll) => FELDER
    .filter(([k]) => (alt[k] ?? null) !== (soll[k] ?? null))
    .map(([k, bez, f]) => ({ feld: bez, alt: f(alt[k] ?? null), neu: f(soll[k] ?? null) }));

  const plan = { neu: [], geaendert: [], gleich: 0, aus_app: [], nicht_gefuehrt: 0 };
  const liste = { neu: [], geaendert: [], aus_app: [], identifikation_wechsel: [] };
  const gesehen = new Set();
  const anspruch = new Map();   // Identifikation → { teil_id (null = neues Teil), barcode }
  for (const z of zeilen) {
    const aid = artVon(z.typ, z.art);
    const pid = personVon(z.person);
    if (aid === undefined || pid === undefined) continue;   // erst klären
    if (aid === null) { plan.nicht_gefuehrt++; continue; }
    const alt = byBarcode.get(z.barcode);
    if (z.identifikation) anspruch.set(z.identifikation, { teil_id: alt?.id ?? null, barcode: z.barcode });
    const soll = { identifikation: z.identifikation, barcode: z.barcode, artikelart_id: aid, typ: z.typ,
                   groesse: z.groesse, person_id: pid, standort: z.standort };
    if (!alt) {
      plan.neu.push(soll);
      liste.neu.push({ barcode: z.barcode, typ: z.typ, groesse: z.groesse, person: pn(pid) });
      continue;
    }
    gesehen.add(alt.id);
    const felder = unterschiede(alt, soll);
    if (alt.quelle === 'zms' && !alt.im_bestand) felder.push({ feld: 'Bestand', alt: 'nicht mehr im Export', neu: 'im Bestand' });
    const eintrag = { barcode: z.barcode, typ: z.typ, felder };
    if (alt.quelle === 'app') {
      plan.aus_app.push({ id: alt.id, ...soll });
      liste.aus_app.push(eintrag);
    } else if (felder.length || !alt.im_bestand) {
      plan.geaendert.push({ id: alt.id, ...soll });
      liste.geaendert.push(eintrag);
    } else plan.gleich++;
  }
  const fehlt = teile.results.filter((t) => t.quelle === 'zms' && t.im_bestand && !gesehen.has(t.id));
  // Identifikationen, die ein anderes Teil bekommt, am bisherigen Teil lösen.
  // Ist das bisherige Teil selbst im Export, zeigt es den Wechsel in seinen Feldern.
  const frei = [];
  for (const [ident, a] of anspruch) {
    const halter = byIdent.get(ident);
    if (!halter || halter.id === a.teil_id) continue;
    frei.push(halter.id);
    if (!gesehen.has(halter.id)) liste.identifikation_wechsel.push({ identifikation: ident, von: halter.barcode, an: a.barcode });
  }

  const nachBarcode = (a, b) => a.barcode.localeCompare(b.barcode, 'de', { numeric: true });
  const aenderungen = {
    neu: liste.neu.sort(nachBarcode),
    geaendert: liste.geaendert.sort(nachBarcode),
    aus_app: liste.aus_app.sort(nachBarcode),
    verschwindet: fehlt.map((t) => ({ barcode: t.barcode, typ: t.typ, person: pn(t.person_id) })).sort(nachBarcode),
    identifikation_wechsel: liste.identifikation_wechsel.sort((a, b) => a.identifikation.localeCompare(b.identifikation, 'de', { numeric: true })),
    zuordnungen: {
      typen: Object.entries(typWahl)
        .map(([typ, id]) => ({ typ, artikelart_id: Number(id) || null, artikelart: an(Number(id) || null) }))
        .filter((t) => !typMap.has(t.typ.toLowerCase()) || typMap.get(t.typ.toLowerCase()) !== t.artikelart_id)
        .sort((a, b) => a.typ.localeCompare(b.typ, 'de')),
      namen: Object.entries(namenWahl)
        .map(([name, id]) => ({ name, person_id: Number(id) || null, person: pn(Number(id) || null) }))
        .filter((n) => (namenMap.has(n.name.toLowerCase()) ? namenMap.get(n.name.toLowerCase()) : undefined) !== n.person_id)
        .sort((a, b) => a.name.localeCompare(b.name, 'de')),
    },
    gleich: plan.gleich,
    nicht_gefuehrt: plan.nicht_gefuehrt,
  };
  return { plan, fehlt, frei, offeneTypen, offeneNamen, aenderungen, arten: arten.results, personen: personen.results };
}

export async function onRequestPost({ request, env, data }) {
  if (!data.user) return unauthorized();
  if (!darfKleidung(data.user)) return forbidden();
  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  const roh = Array.isArray(body?.zeilen) ? body.zeilen : [];
  const zeilen = roh.map((z) => ({
    identifikation: s(z.identifikation) || null, barcode: s(z.barcode).toUpperCase(),
    art: s(z.art), typ: s(z.typ), groesse: s(z.groesse) || null,
    person: s(z.person), standort: s(z.standort) || null,
  })).filter((z) => /^BRE\d+$/.test(z.barcode));
  if (!zeilen.length) return err('Keine Zeilen mit Inventarnummer BRE… im Import');
  for (const k of ['barcode', 'identifikation']) {
    const da = new Set();
    for (const z of zeilen) {
      if (!z[k]) continue;
      if (da.has(z[k])) return err(`${z[k]} steht mehrfach im Export`);
      da.add(z[k]);
    }
  }
  const typWahl = body?.typen && typeof body.typen === 'object' ? body.typen : {};
  const namenWahl = body?.namen && typeof body.namen === 'object' ? body.namen : {};

  return mitKleidung(async () => {
    const { plan, fehlt, frei, offeneTypen, offeneNamen, aenderungen, arten, personen } =
      await baueKleidungPlan(env, { zeilen, typWahl, namenWahl });
    const offen = offeneTypen.size > 0 || offeneNamen.size > 0;
    const pruefsumme = offen ? null : await planPruefsumme(aenderungen);

    if (!body?.uebernehmen) {
      return json({
        zeilen: zeilen.length,
        neu: plan.neu.length, geaendert: plan.geaendert.length, gleich: plan.gleich,
        aus_app: plan.aus_app.length, nicht_gefuehrt: plan.nicht_gefuehrt, fehlt: fehlt.length,
        offene_typen: [...offeneTypen.values()],
        offene_namen: [...offeneNamen.values()],
        artikelarten: arten,
        aenderungen: offen ? null : aenderungen,
        plan: pruefsumme,
        personen: offeneNamen.size
          ? personen.filter((p) => p.aktiv)
              .map((p) => ({ id: p.id, name: nameVon(p) }))
              .sort((a, b) => a.name.localeCompare(b.name, 'de'))
          : [],
      });
    }
    if (offen) return err('Noch offene Typen oder Namen');
    if (!body?.plan) return err('Der Import braucht die Vorschau (plan fehlt)');
    if (body.plan !== pruefsumme) return err('Der Stand hat sich seit der Vorschau geändert', 409);

    const st = [];
    for (const [typ, id] of Object.entries(typWahl)) {
      st.push(env.DB.prepare(`INSERT INTO kleidung_typen (typ, artikelart_id) VALUES (?, ?)
        ON CONFLICT(typ) DO UPDATE SET artikelart_id = excluded.artikelart_id`).bind(typ, Number(id) || null));
    }
    for (const [name, id] of Object.entries(namenWahl)) {
      st.push(env.DB.prepare(`INSERT INTO kleidung_namen (name, person_id) VALUES (?, ?)
        ON CONFLICT(name) DO UPDATE SET person_id = excluded.person_id`).bind(name, Number(id) || null));
    }
    const ins = env.DB.prepare(
      `INSERT INTO kleidung_teile (identifikation, barcode, artikelart_id, typ, groesse, person_id, standort, quelle, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'zms', ?)`);
    const upd = env.DB.prepare(
      `UPDATE kleidung_teile SET identifikation = ?, barcode = ?, artikelart_id = ?, typ = ?, groesse = ?,
              person_id = ?, standort = ?, quelle = 'zms', im_bestand = 1 WHERE id = ?`);
    // erst lösen, sonst stößt das Setzen an UNIQUE(identifikation)
    for (const id of frei) st.push(env.DB.prepare(`UPDATE kleidung_teile SET identifikation = NULL WHERE id = ?`).bind(id));
    for (const t of plan.neu) st.push(ins.bind(t.identifikation, t.barcode, t.artikelart_id, t.typ, t.groesse, t.person_id, t.standort, data.user.username));
    for (const t of [...plan.geaendert, ...plan.aus_app]) st.push(upd.bind(t.identifikation, t.barcode, t.artikelart_id, t.typ, t.groesse, t.person_id, t.standort, t.id));
    for (const t of fehlt) st.push(env.DB.prepare(`UPDATE kleidung_teile SET im_bestand = 0 WHERE id = ?`).bind(t.id));
    const uebernommen = plan.neu.length + plan.geaendert.length + plan.aus_app.length + plan.gleich;
    st.push(env.DB.prepare(`INSERT INTO kleidung_importe (zeilen, uebernommen, importiert_by) VALUES (?, ?, ?)`)
      .bind(zeilen.length, uebernommen, data.user.username));
    st.push(auditEintrag(env, data.user, {
      bereich: 'kleidung', aktion: 'import', objekt: 'zms',
      details: { zeilen: zeilen.length, neu: plan.neu.length, geaendert: plan.geaendert.length,
                 aus_app: plan.aus_app.length, fehlt: fehlt.map((t) => t.id), nicht_gefuehrt: plan.nicht_gefuehrt,
                 plan: pruefsumme },
    }));
    await env.DB.batch(st);
    return json({ ok: true, uebernommen, neu: plan.neu.length, geaendert: plan.geaendert.length, fehlt: fehlt.length });
  });
}
