// POST /api/kleidung/import — Export "persönliche Ausrüstung" aus ZMS-Hessen
// übernehmen. Die CSV liest die App im Browser und schickt nur Zeilen mit
// Gemeinde-Inventarnummer (Barcode BRE…).
//
// Body: { zeilen: [{ identifikation, barcode, art, typ, groesse, person, standort }],
//         typen: { typ: artikelart_id | 0 }, namen: { name: person_id | 0 },
//         uebernehmen: bool }
//
// Regeln (Konzept, Fassung 9):
// - Nur Barcode BRE…; nur Typen, die einer Artikelart zugeordnet sind (also
//   Schutzkleidung). Ob Schutzkleidung, entscheidet der Typ, nicht die
//   ZMS-Spalte "Art". Unbekannte Typen fragt die Vorschau nach.
// - Abgleich über die ZMS-Identifikation, sonst über den Barcode: ein Teil,
//   das bisher nur in der App stand, wird so zum ZMS-Teil; ZMS gewinnt.
// - "Ausgegeben an" ist "Vorname Nachname". Leer = nicht ausgegeben.
// - Teile, die im Export fehlen, verschwinden aus den Listen (im_bestand = 0);
//   ihre Reinigungshistorie bleibt.
import { json, err, unauthorized, forbidden, darfKleidung } from '../../_lib/auth.js';
import { auditEintrag } from '../../_lib/audit.js';
import { mitKleidung } from '../kleidung.js';

const s = (v) => String(v ?? '').trim();

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
  const typWahl = body?.typen && typeof body.typen === 'object' ? body.typen : {};
  const namenWahl = body?.namen && typeof body.namen === 'object' ? body.namen : {};
  const hat = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  return mitKleidung(async () => {
    const [typen, arten, personen, namen, teile] = await Promise.all([
      env.DB.prepare(`SELECT typ, artikelart_id FROM kleidung_typen`).all(),
      env.DB.prepare(`SELECT id, name FROM kleidung_artikelarten ORDER BY sort_order`).all(),
      env.DB.prepare(`SELECT id, nachname, vorname, aktiv FROM personen`).all(),
      env.DB.prepare(`SELECT name, person_id FROM kleidung_namen`).all(),
      env.DB.prepare(`SELECT id, identifikation, barcode, artikelart_id, groesse, person_id, standort, quelle, im_bestand FROM kleidung_teile`).all(),
    ]);
    const typMap = new Map(typen.results.map((t) => [t.typ.toLowerCase(), t.artikelart_id]));
    const namenMap = new Map(namen.results.map((n) => [n.name.toLowerCase(), n.person_id]));
    const byIdent = new Map(teile.results.filter((t) => t.identifikation).map((t) => [t.identifikation, t]));
    const byBarcode = new Map(teile.results.map((t) => [t.barcode.toUpperCase(), t]));

    // Typen auflösen
    const offeneTypen = new Map();
    const artVon = (typ, zmsArt) => {
      const k = typ.toLowerCase();
      if (hat(typWahl, typ)) return Number(typWahl[typ]) || null;
      if (typMap.has(k)) return typMap.get(k);
      if (!offeneTypen.has(typ)) offeneTypen.set(typ, { typ, zms_art: zmsArt, anzahl: 0 });
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

    const plan = { neu: [], geaendert: [], gleich: 0, aus_app: [], nicht_gefuehrt: 0 };
    const gesehen = new Set();
    for (const z of zeilen) {
      const aid = artVon(z.typ, z.art);
      const pid = personVon(z.person);
      if (aid === undefined || pid === undefined) continue;   // erst klären
      if (aid === null) { plan.nicht_gefuehrt++; continue; }
      const alt = (z.identifikation && byIdent.get(z.identifikation)) || byBarcode.get(z.barcode);
      const soll = { identifikation: z.identifikation, barcode: z.barcode, artikelart_id: aid, typ: z.typ,
                     groesse: z.groesse, person_id: pid, standort: z.standort };
      if (!alt) { plan.neu.push(soll); continue; }
      gesehen.add(alt.id);
      const unterschied = alt.quelle !== 'zms' || !alt.im_bestand
        || ['identifikation', 'barcode', 'artikelart_id', 'groesse', 'person_id', 'standort']
          .some((k) => (alt[k] ?? null) !== (soll[k] ?? null));
      if (alt.quelle === 'app') plan.aus_app.push({ id: alt.id, ...soll });
      else if (unterschied) plan.geaendert.push({ id: alt.id, ...soll });
      else plan.gleich++;
    }
    const fehlt = teile.results.filter((t) => t.quelle === 'zms' && t.im_bestand && !gesehen.has(t.id));

    if (!body?.uebernehmen || offeneTypen.size || offeneNamen.size) {
      if (body?.uebernehmen) return err('Noch offene Typen oder Namen');
      return json({
        zeilen: zeilen.length,
        neu: plan.neu.length, geaendert: plan.geaendert.length, gleich: plan.gleich,
        aus_app: plan.aus_app.length, nicht_gefuehrt: plan.nicht_gefuehrt, fehlt: fehlt.length,
        offene_typen: [...offeneTypen.values()],
        offene_namen: [...offeneNamen.values()],
        artikelarten: arten.results,
        personen: offeneNamen.size
          ? personen.results.filter((p) => p.aktiv)
              .map((p) => ({ id: p.id, name: `${p.nachname}, ${p.vorname}` }))
              .sort((a, b) => a.name.localeCompare(b.name, 'de'))
          : [],
      });
    }

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
    for (const t of plan.neu) st.push(ins.bind(t.identifikation, t.barcode, t.artikelart_id, t.typ, t.groesse, t.person_id, t.standort, data.user.username));
    for (const t of [...plan.geaendert, ...plan.aus_app]) st.push(upd.bind(t.identifikation, t.barcode, t.artikelart_id, t.typ, t.groesse, t.person_id, t.standort, t.id));
    for (const t of fehlt) st.push(env.DB.prepare(`UPDATE kleidung_teile SET im_bestand = 0 WHERE id = ?`).bind(t.id));
    const uebernommen = plan.neu.length + plan.geaendert.length + plan.aus_app.length + plan.gleich;
    st.push(env.DB.prepare(`INSERT INTO kleidung_importe (zeilen, uebernommen, importiert_by) VALUES (?, ?, ?)`)
      .bind(zeilen.length, uebernommen, data.user.username));
    st.push(auditEintrag(env, data.user, {
      bereich: 'kleidung', aktion: 'import', objekt: 'zms',
      details: { zeilen: zeilen.length, neu: plan.neu.length, geaendert: plan.geaendert.length,
                 aus_app: plan.aus_app.length, fehlt: fehlt.map((t) => t.id), nicht_gefuehrt: plan.nicht_gefuehrt },
    }));
    // D1 begrenzt die Anweisungen je Batch; in Blöcken senden
    for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
    return json({ ok: true, uebernommen, neu: plan.neu.length, geaendert: plan.geaendert.length, fehlt: fehlt.length });
  });
}
