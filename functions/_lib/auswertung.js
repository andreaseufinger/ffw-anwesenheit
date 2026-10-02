// Berechnung der Teilnahme- und Stundenauswertung über beide Apps.
//
// Bewusst in JavaScript und nicht als ein großes SQL: die Regeln unten
// (Dedup über Fahrzeuge, fehlende Endzeiten, Mitternacht) sind hier lesbar
// und testbar, in einem CTE-Konstrukt nicht. Bei rund 35 Personen und ~40
// Terminen im Jahr ist die Laufzeit ohnehin belanglos.

// --- Zeitrechnung ---------------------------------------------------------

// 'YYYY-MM-DD' + 'HH:MM' -> Minuten seit Epoche (UTC-neutral, da nur
// Differenzen gebildet werden).
export function zuMinuten(datum, uhrzeit) {
  if (!datum || !uhrzeit) return null;
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(datum));
  const t = /^(\d{1,2}):(\d{2})$/.exec(String(uhrzeit));
  if (!d || !t) return null;
  const ms = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]);
  return Number.isNaN(ms) ? null : Math.floor(ms / 60000);
}

// Dauer eines Ausbildungsabends. attendance_sessions hat kein Enddatum —
// endet der Abend nach Mitternacht, ist zeit_bis kleiner als zeit_von und
// es fehlt ein Tag.
export function dauerAbend(datum, von, bis) {
  const a = zuMinuten(datum, von);
  const b = zuMinuten(datum, bis);
  if (a === null || b === null) return null;
  return b >= a ? b - a : b - a + 24 * 60;
}

// Dauer eines Einsatzes für eine Person: Alarmzeit bis zum Ende IHRES
// Fahrzeugs. Ein Einsatzende auf Einsatzebene gibt es nicht; abgeschlossen_at
// ist der Zeitpunkt, an dem ein Admin das Protokoll geschlossen hat, und
// taugt dafür nicht.
export function dauerEinsatz(alarmDatum, alarmUhrzeit, endeDatum, endeUhrzeit) {
  const a = zuMinuten(alarmDatum, alarmUhrzeit);
  const b = zuMinuten(endeDatum, endeUhrzeit);
  if (a === null || b === null) return null;
  return b >= a ? b - a : null;   // Ende vor Alarm = Datenfehler, nicht raten
}

// --- Aggregation ---------------------------------------------------------

const KATEGORIEN = ['uebung', 'dienst', 'sonstiges'];

function leererBlock() {
  return { teilnahmen: 0, minuten: 0, ohne_zeit: 0 };
}
function leerePerson(person) {
  const p = {
    person_id: person?.id ?? null,
    name: person ? `${person.nachname}, ${person.vorname}` : 'nicht zuordenbar',
    aktiv: person ? !!person.aktiv : null,
  };
  for (const k of KATEGORIEN) p[k] = leererBlock();
  p.einsatz = leererBlock();
  p.gesamt  = leererBlock();
  return p;
}
function addiere(block, minuten) {
  block.teilnahmen += 1;
  if (minuten === null) block.ohne_zeit += 1;
  else block.minuten += minuten;
}

/**
 * @param rohdaten {{
 *   personen: Array, abende: Array, teilnehmer: Array,
 *   einsaetze: Array, besatzung: Array, pa: Array
 * }}
 * @param personIdFilter optionale Einschränkung auf eine Person
 */
export function auswerten(rohdaten, personIdFilter = null) {
  const { personen, abende, teilnehmer, einsaetze, besatzung, pa } = rohdaten;

  const personenById = new Map(personen.map((p) => [p.id, p]));
  const abendeById   = new Map(abende.map((a) => [a.id, a]));
  const einsaetzeById = new Map(einsaetze.map((e) => [e.id, e]));

  // Ergebniszeilen entstehen erst bei Bedarf; Schlüssel null = nicht zuordenbar.
  const zeilen = new Map();
  const hole = (pid) => {
    if (!zeilen.has(pid)) zeilen.set(pid, leerePerson(pid === null ? null : personenById.get(pid)));
    return zeilen.get(pid);
  };

  const passt = (pid) => personIdFilter === null || pid === personIdFilter;

  let nichtZuordenbar = 0;
  // Welche Namen betroffen sind, nicht nur wie viele — sonst weiß niemand,
  // wo nachzubessern ist.
  const offeneNamen = new Map();   // "Nachname, Vorname" -> Anzahl
  const merkeOffen = (nachname, vorname) => {
    const key = `${nachname || '?'}, ${vorname || '?'}`;
    offeneNamen.set(key, (offeneNamen.get(key) || 0) + 1);
  };

  // --- Ausbildungsabende -------------------------------------------------
  // Teilnahme = status 'anwesend'. Die Dauer gilt für alle Anwesenden gleich.
  const dauerProAbend = new Map();
  for (const a of abende) {
    dauerProAbend.set(a.id, dauerAbend(a.datum, a.zeit_von, a.zeit_bis));
  }

  const teilnehmerProAbend = new Map();   // für den Durchschnitt
  for (const t of teilnehmer) {
    const abend = abendeById.get(t.session_id);
    if (!abend) continue;
    if (t.person_id === null) { nichtZuordenbar += 1; merkeOffen(t.nachname, t.vorname); }
    if (!passt(t.person_id)) continue;

    const kat = KATEGORIEN.includes(abend.kategorie) ? abend.kategorie : 'sonstiges';
    const dauer = dauerProAbend.get(abend.id) ?? null;
    const zeile = hole(t.person_id);
    addiere(zeile[kat], dauer);
    addiere(zeile.gesamt, dauer);

    if (!teilnehmerProAbend.has(abend.id)) teilnehmerProAbend.set(abend.id, new Set());
    teilnehmerProAbend.get(abend.id).add(t.person_id ?? `?${t.nachname},${t.vorname}`);
  }

  // --- Einsätze ----------------------------------------------------------
  // Eine Person kann auf mehreren Fahrzeugen eines Einsatzes stehen und
  // zusätzlich in der Atemschutzliste. Das ist EIN Einsatz; für die Stunden
  // zählt das späteste Fahrzeug-Ende.
  // einsatz_pa.dauer_minuten ist die PA-Tragezeit, NICHT die Einsatzdauer —
  // sie darf hier nicht einfließen.
  const proEinsatzPerson = new Map();   // "einsatzId|pid" -> { pid, ende: maxMinuten|null }

  const merke = (einsatzId, pid, kennung, endeMinuten) => {
    const key = `${einsatzId}|${pid ?? kennung}`;
    const vorhanden = proEinsatzPerson.get(key);
    if (!vorhanden) {
      proEinsatzPerson.set(key, { einsatzId, pid, kennung, ende: endeMinuten });
    } else if (endeMinuten !== null && (vorhanden.ende === null || endeMinuten > vorhanden.ende)) {
      vorhanden.ende = endeMinuten;
    }
  };

  for (const b of besatzung) {
    if (!einsaetzeById.has(b.einsatz_id)) continue;
    if (b.person_id === null) { nichtZuordenbar += 1; merkeOffen(b.person_nachname, b.person_vorname); }
    merke(b.einsatz_id, b.person_id, `?${b.person_nachname},${b.person_vorname}`,
          zuMinuten(b.ende_datum, b.ende_uhrzeit));
  }
  for (const p of pa) {
    if (!einsaetzeById.has(p.einsatz_id)) continue;
    if (p.person_id === null) { nichtZuordenbar += 1; merkeOffen(p.person_nachname, p.person_vorname); }
    // Ohne Fahrzeug gibt es keine Endzeit — Teilnahme ja, Stunden unbekannt.
    merke(p.einsatz_id, p.person_id, `?${p.person_nachname},${p.person_vorname}`, null);
  }

  const teilnehmerProEinsatz = new Map();
  for (const eintrag of proEinsatzPerson.values()) {
    const e = einsaetzeById.get(eintrag.einsatzId);
    if (!teilnehmerProEinsatz.has(e.id)) teilnehmerProEinsatz.set(e.id, new Set());
    teilnehmerProEinsatz.get(e.id).add(eintrag.pid ?? eintrag.kennung);

    if (!passt(eintrag.pid)) continue;
    const alarm = zuMinuten(e.alarm_datum, e.alarm_uhrzeit);
    const dauer = (alarm !== null && eintrag.ende !== null && eintrag.ende >= alarm)
      ? eintrag.ende - alarm
      : null;
    const zeile = hole(eintrag.pid);
    addiere(zeile.einsatz, dauer);
    addiere(zeile.gesamt, dauer);
  }

  // --- Durchschnitt: Teilnehmer pro Termin -------------------------------
  const mittel = (map, anzahlTermine) => {
    if (!anzahlTermine) return null;
    let summe = 0;
    for (const s of map.values()) summe += s.size;
    return Math.round((summe / anzahlTermine) * 10) / 10;
  };
  const uebungen = abende.filter((a) => a.kategorie === 'uebung');
  const uebungIds = new Set(uebungen.map((a) => a.id));
  const teilnehmerProUebung = new Map(
    [...teilnehmerProAbend].filter(([id]) => uebungIds.has(id))
  );

  const ergebnis = [...zeilen.values()].sort((a, b) => {
    if (a.person_id === null) return 1;
    if (b.person_id === null) return -1;
    return a.name.localeCompare(b.name, 'de');
  });

  return {
    personen: ergebnis,
    basis: {
      uebungen: uebungen.length,
      abende_gesamt: abende.length,
      einsaetze: einsaetze.length,
      aktive_personen: personen.filter((p) => p.aktiv).length,
    },
    durchschnitt: {
      personen_pro_uebung:  mittel(teilnehmerProUebung, uebungen.length),
      personen_pro_einsatz: mittel(teilnehmerProEinsatz, einsaetze.length),
    },
    nicht_zuordenbar: nichtZuordenbar,
    nicht_zuordenbar_namen: [...offeneNamen]
      .map(([name, anzahl]) => ({ name, anzahl }))
      .sort((a, b) => b.anzahl - a.anzahl || a.name.localeCompare(b.name, 'de')),
  };
}
