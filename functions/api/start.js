// GET /api/start — Fälligkeiten für die Startseite, je nach Rolle aus
// Atemschutz und Kleidung. Rot und gelb wie in den Modulen (gelb = höchstens
// 30 Tage bis zum Ablauf). Fehlen die Tabellen eines Moduls, bleibt sein Teil
// weg, statt die ganze Startseite scheitern zu lassen.
import { json, unauthorized, forbidden, isAppMember, darfAtemschutz, darfKleidung } from '../_lib/auth.js';
import { istFehlendeTabelle } from '../_lib/stammdaten.js';
import { heuteBerlin, SPALTEN } from '../_lib/agt.js';
import { agtUebersicht } from './agt.js';
import { TEILE_SQL, teilAufbereiten } from './kleidung.js';
import { vorschlaege } from './kleidung/vorschlaege.js';

const RANG = { rot: 0, gelb: 1 };

async function atemschutz(env) {
  const u = await agtUebersicht(env);
  const aktiv = u.personen.filter((p) => p.aktiv);
  let eintragFehlt = 0;
  const personen = [];
  for (const p of aktiv) {
    const punkte = [];
    for (const sp of SPALTEN) {
      const z = p.spalten[sp.key];
      if (z.status === 'hellgruen') eintragFehlt++;
      if (z.status === 'rot' || z.status === 'gelb') {
        punkte.push({ key: sp.key, status: z.status, gueltig_bis: z.nachweis?.gueltig_bis || null,
                      fehlt: !z.nachweis });
      }
    }
    if (p.kleidung.status === 'rot' || p.kleidung.status === 'gelb') {
      punkte.push({ key: 'kleidung', status: p.kleidung.status, gueltig_bis: null, fehlt: false });
    }
    if (punkte.length) personen.push({ id: p.id, name: p.name, status: p.gesamt, punkte });
  }
  // Rot zuerst, dann nach dem frühesten Ablauf
  const frueh = (p) => p.punkte.map((x) => x.gueltig_bis || '9999').sort()[0];
  personen.sort((a, b) => (RANG[a.status] ?? 2) - (RANG[b.status] ?? 2)
    || frueh(a).localeCompare(frueh(b)) || a.name.localeCompare(b.name, 'de'));
  return {
    agt: aktiv.length,
    tauglich: aktiv.filter((p) => p.tauglich).length,
    eintrag_fehlt: eintragFehlt,
    florix_stand: u.florix_stand?.stichtag || null,
    personen,
  };
}

async function kleidung(env) {
  const heute = heuteBerlin();
  const [teile, stand, offen] = await Promise.all([
    env.DB.prepare(`${TEILE_SQL} WHERE t.im_bestand = 1 AND t.artikelart_id IS NOT NULL`).all(),
    env.DB.prepare(`SELECT importiert_at FROM kleidung_importe ORDER BY id DESC LIMIT 1`).first(),
    vorschlaege(env),
  ]);
  const alle = teile.results.map((t) => teilAufbereiten(t, heute));
  const inReinigung = alle.filter((t) => t.in_reinigung_seit);
  // Fällig: überfällig oder bald fällig, aber nicht schon in der Reinigung
  const faellig = alle.filter((t) => !t.in_reinigung_seit && (t.status === 'rot' || t.status === 'gelb'));
  const jePerson = new Map();
  for (const t of faellig) {
    const k = t.person_id ?? 0;
    if (!jePerson.has(k)) jePerson.set(k, { name: t.person || 'ohne Zuordnung', agt: t.agt, rot: 0, gelb: 0, naechst: null });
    const p = jePerson.get(k);
    p[t.status]++;
    if (!p.naechst || t.faellig_am < p.naechst) p.naechst = t.faellig_am;
  }
  const personen = [...jePerson.values()].sort((a, b) =>
    (b.rot > 0) - (a.rot > 0) || (a.naechst || '').localeCompare(b.naechst || '') || a.name.localeCompare(b.name, 'de'));
  return {
    teile: alle.length,
    ueberfaellig: faellig.filter((t) => t.status === 'rot').length,
    gueltig: alle.filter((t) => t.status === 'dunkelgruen').length,
    bald: faellig.filter((t) => t.status === 'gelb').length,
    in_reinigung: inReinigung.length,
    in_reinigung_seit: inReinigung.map((t) => t.in_reinigung_seit).filter(Boolean).sort()[0] || null,
    ohne_datum: alle.filter((t) => t.status === 'unbekannt').length,
    vorschlaege: offen.length,
    zms_stand: stand?.importiert_at?.slice(0, 10) || null,
    personen,
  };
}

async function teil(fn, env) {
  try {
    return await fn(env);
  } catch (e) {
    if (istFehlendeTabelle(e) || /no such column/i.test(String(e?.message))) return { fehlt: true };
    throw e;
  }
}

export async function onRequestGet({ env, data }) {
  if (!data.user) return unauthorized();
  if (!isAppMember(data.user)) return forbidden();
  const [a, k] = await Promise.all([
    darfAtemschutz(data.user) ? teil(atemschutz, env) : null,
    darfKleidung(data.user) ? teil(kleidung, env) : null,
  ]);
  const antwort = { heute: heuteBerlin() };
  if (a) antwort.atemschutz = a;
  if (k) antwort.kleidung = k;
  return json(antwort);
}
