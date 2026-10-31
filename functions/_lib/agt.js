// Statusberechnung Atemschutz (Modul Atemschutz, Konzept PSA und Atemschutz).
//
// Bewusst als reine Funktionen ohne Datenbank: die Regeln sind die, nach
// denen Florix "alle Auflagen erfüllt" rechnet, und müssen sich gegen den
// Export prüfen lassen.
//
// Regeln:
// - Je Art zählt der Nachweis mit dem spätesten gueltig_bis (der Lehrgang ist
//   unbefristet, dort zählt das späteste Datum).
// - Tauglich: alle Pflichtarten gültig UND mindestens eine Wahlpflichtart
//   gültig UND Lehrgang vorhanden.
// - Status je Spalte: rot (fehlt/abgelaufen) < gelb (<= 30 Tage) <
//   hellgruen (gültig, ein Häkchen fehlt) < dunkelgruen (gültig, im
//   Atemschutzpass UND in Florix eingetragen). Welche Häkchen eine Art
//   braucht, steht in agt_arten (pass_pflicht, florix_pflicht; Einstellungen
//   -> Tauglichkeiten verwalten); ohne Angabe beide.
// - Selbst berechnete Gültigkeit: Datum + Frist - 1 Tag (12 Monate:
//   22.05.2026 -> 21.05.2027), siehe GUELTIG_SQL.

export const WARN_TAGE = 30;
export const STUFEN = ['rot', 'gelb', 'hellgruen', 'dunkelgruen'];

// Spalten der Übersicht. Die Wahlpflicht fasst Einsatzübung und Einsatz zusammen.
export const SPALTEN = [
  { key: 'lehrgang', arten: ['lehrgang'], name: 'Lehrgang' },
  { key: 'strecke', arten: ['strecke'], name: 'Strecke' },
  { key: 'g263', arten: ['g263'], name: 'G 26.3' },
  { key: 'unterweisung', arten: ['unterweisung'], name: 'Unterweisung' },
  { key: 'wahlpflicht', arten: ['einsatzuebung', 'einsatz'], name: 'Einsatz oder Einsatzübung' },
];

export function tageBis(isoDatum, heute) {
  const a = Date.UTC(+heute.slice(0, 4), +heute.slice(5, 7) - 1, +heute.slice(8, 10));
  const b = Date.UTC(+isoDatum.slice(0, 4), +isoDatum.slice(5, 7) - 1, +isoDatum.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

// Vergleichsschlüssel: unbefristet (null) gilt als "am weitesten".
function reichweite(n) {
  return n.gueltig_bis ?? '9999-12-31';
}

// Maßgeblicher Nachweis unter mehreren: am weitesten gültig, bei Gleichstand
// der mit mehr Häkchen (ein Florix-Import und ein manueller Eintrag mit
// gleichem Datum sollen nicht hellgrün zeigen, nur weil einer leer ist).
export function massgeblich(nachweise) {
  let best = null;
  for (const n of nachweise) {
    if (!best) { best = n; continue; }
    const a = reichweite(n), b = reichweite(best);
    if (a > b || (a === b && (n.pass + n.florix) > (best.pass + best.florix))
        || (a === b && !n.gueltig_bis && (n.datum || '') > (best.datum || ''))) best = n;
  }
  return best;
}

// SQL-Ausdruck für "gültig bis" aus Datum und Frist in Monaten
export const GUELTIG_SQL = (datum, monate) => `date(${datum}, '+' || ${monate} || ' months', '-1 day')`;

// regel: { pass, florix } — welche Häkchen die Art braucht (Vorgabe beide)
export function statusVon(n, heute, regel = {}) {
  if (!n) return 'rot';
  if (n.gueltig_bis) {
    const tage = tageBis(n.gueltig_bis, heute);
    if (tage < 0) return 'rot';
    if (tage <= WARN_TAGE) return 'gelb';
  }
  const passOk = regel.pass === false || !!n.pass;
  const florixOk = regel.florix === false || !!n.florix;
  return passOk && florixOk ? 'dunkelgruen' : 'hellgruen';
}

export function schlechtester(stati) {
  let i = STUFEN.length - 1;
  for (const s of stati) i = Math.min(i, STUFEN.indexOf(s));
  return STUFEN[i];
}

// Regeln je Art aus den Zeilen von agt_arten
export function regelnAus(arten) {
  return Object.fromEntries((arten || []).map((a) => [a.art, {
    pass: a.pass_pflicht === undefined ? true : !!a.pass_pflicht,
    florix: a.florix_pflicht === undefined ? true : !!a.florix_pflicht,
  }]));
}

// Eine Zeile der Übersicht für eine Person. regeln: Ergebnis von regelnAus.
export function personStatus(nachweise, heute, regeln = {}) {
  const spalten = {};
  for (const sp of SPALTEN) {
    const kandidaten = nachweise.filter((n) => sp.arten.includes(n.art));
    const n = massgeblich(kandidaten);
    spalten[sp.key] = { nachweis: n, status: statusVon(n, heute, n ? regeln[n.art] : undefined) };
  }
  const gesamt = schlechtester(SPALTEN.map((sp) => spalten[sp.key].status));
  return { spalten, gesamt, tauglich: gesamt !== 'rot' };
}

// 'TT.MM.JJJJ' -> 'JJJJ-MM-TT' oder null
export function isoAusDeutsch(s) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(s || '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// Heute in Europe/Berlin als 'JJJJ-MM-TT'
export function heuteBerlin(d = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(d);
}
