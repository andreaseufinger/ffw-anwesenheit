// Alle Tabellen, die über person_id auf eine Person verweisen (außer
// personen_abteilungen, die beim Zusammenführen eigene Regeln hat).
//
// Zusammenführen und Löschen von Personen leiten sich aus dieser Liste ab.
// Kommt ein Modul mit einer neuen person_id-Spalte dazu, muss es hier
// eingetragen werden; tests/api/personen.test.mjs vergleicht die Liste mit
// dem Schema und schlägt sonst fehl. Vorher gingen beim Zusammenführen die
// Atemschutz- und Kleidungsdaten der Dublette verloren (Review-Befund D1).
//
//   historie: zählt als Nachweis, dass es die Person gab. Eine Person mit
//             Historie wird nicht gelöscht, sondern auf "nicht aktiv" gesetzt.
//             Reine Namenszuordnungen für Importe zählen nicht.
export const PERSONENBEZUG = [
  { tabelle: 'attendance_entries', name: 'Abende', historie: true },
  { tabelle: 'einsatz_besatzung', name: 'Besatzungseinträge', historie: true },
  { tabelle: 'einsatz_pa', name: 'Atemschutzeinsätze', historie: true },
  { tabelle: 'agt_nachweise', name: 'Atemschutz-Nachweise', historie: true },
  { tabelle: 'agt_planung', name: 'Streckenplanungen', historie: false },
  { tabelle: 'agt_namen', name: 'Florix-Namen', historie: false },
  { tabelle: 'kleidung_teile', name: 'Kleidungsteile', historie: true },
  { tabelle: 'kleidung_namen', name: 'ZMS-Namen', historie: false },
];

// Je Tabelle die Anzahl Zeilen einer Person. Eine fehlende Tabelle (Modul
// nicht migriert) zählt als 0.
export async function bezuegeZaehlen(env, personId) {
  const zahlen = {};
  for (const b of PERSONENBEZUG) {
    try {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${b.tabelle} WHERE person_id = ?`)
        .bind(personId).first();
      zahlen[b.tabelle] = row?.n ?? 0;
    } catch (e) {
      if (/no such table/i.test(String(e?.message))) zahlen[b.tabelle] = 0;
      else throw e;
    }
  }
  return zahlen;
}

// "3 Abende, 1 Atemschutz-Nachweise" – nur Einträge mit Anzahl > 0.
export function bezuegeText(zahlen, { nurHistorie = false } = {}) {
  return PERSONENBEZUG
    .filter((b) => (!nurHistorie || b.historie) && zahlen[b.tabelle] > 0)
    .map((b) => `${zahlen[b.tabelle]} ${b.name}`)
    .join(', ');
}
