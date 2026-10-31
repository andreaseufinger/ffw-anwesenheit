// Namensvergleich für die Dublettenprüfung.
//
// Der Unique-Index auf personen fängt nur Groß-/Kleinschreibung. Die
// häufigeren Fälle sind Schreibvarianten: "Schuetz" statt "Schütz",
// "Mueller-Lüdenscheidt" statt "Müller-Lüdenscheidt", ein Leerzeichen zu viel.
// Dafür wird verglichen, was nach dem Falten übrig bleibt.
//
// Bewusst keine unscharfe Suche (Levenshtein o. ä.): bei sieben mehrfach
// vorkommenden Nachnamen im Bestand — "Jung" dreimal — würde die zu viele
// Fehlalarme erzeugen und damit ignoriert werden. Gefaltete Gleichheit ist
// streng genug, um ernst genommen zu werden.

// 'Schütz' -> 'schuetz', 'Weiß' -> 'weiss', ' Wart ' -> 'wart'
export function falteName(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    // Akzente abtrennen und verwerfen (é -> e)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    // alles, was nicht Buchstabe oder Ziffer ist, fällt weg: Bindestriche,
    // Punkte, Leerzeichen. "Wart, Jutta M." und "Wart Jutta M" werden gleich.
    .replace(/[^a-z0-9]/g, '');
}

export function falteNamenspaar(nachname, vorname) {
  return `${falteName(nachname)}|${falteName(vorname)}`;
}

// Bestehende Personen, deren gefalteter Name dem gesuchten entspricht.
// `ausser` schließt eine ID aus (beim Ändern die eigene).
export function findeAehnliche(personen, nachname, vorname, ausser = null) {
  const gesucht = falteNamenspaar(nachname, vorname);
  return personen.filter((p) =>
    p.id !== ausser && falteNamenspaar(p.nachname, p.vorname) === gesucht);
}
