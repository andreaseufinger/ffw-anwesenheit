// Statusberechnung Kleidung (Modul Kleidung, Konzept PSA und Atemschutz).
//
// Ein Teil ist fällig, wenn seit der letzten Reinigung das Intervall seiner
// Artikelart abgelaufen ist. Die Reinigung ist zugleich die Prüfung.
//
// Stufen wie im Atemschutz, damit die AGT-Übersicht sie mischen kann:
//   rot: überfällig
//   gelb: höchstens 30 Tage bis fällig, oder gerade in der Reinigung
//   dunkelgruen: gültig (Kleidung kennt keine Häkchen, daher nie hellgrün)
//   unbekannt: noch keine Reinigung erfasst — zählt nicht in den Gesamtstatus,
//     sonst wäre nach dem ersten ZMS-Import jeder AGT rot, bevor der
//     Kleiderwart die bisherigen Reinigungsdaten nachgetragen hat.
//   ohne: Artikelart ohne Intervall, wird nur geführt.
import { tageBis, WARN_TAGE, schlechtester } from './agt.js';

export function faelligAm(letzte, intervallMonate) {
  if (!letzte || !intervallMonate) return null;
  const y = +letzte.slice(0, 4), m = +letzte.slice(5, 7) - 1, d = +letzte.slice(8, 10);
  // wie SQLite date(x, '+N months'): Monat weiter, Tag behalten, Überlauf rollt
  const t = new Date(Date.UTC(y, m + intervallMonate, d));
  return t.toISOString().slice(0, 10);
}

export function teilStatus({ letzte_reinigung, in_reinigung_seit, intervall_monate }, heute) {
  if (in_reinigung_seit) return 'gelb';
  if (!intervall_monate) return 'ohne';
  if (!letzte_reinigung) return 'unbekannt';
  const tage = tageBis(faelligAm(letzte_reinigung, intervall_monate), heute);
  if (tage < 0) return 'rot';
  if (tage <= WARN_TAGE) return 'gelb';
  return 'dunkelgruen';
}

// Kleidungsstatus einer Person für die AGT-Übersicht: das schlechteste der
// AGT-relevanten Teile. Nur Teile mit bekanntem Status zählen.
export function kleidungStatus(teile, heute) {
  const stati = teile.map((t) => teilStatus(t, heute))
    .filter((s) => s !== 'unbekannt' && s !== 'ohne');
  return {
    status: stati.length ? schlechtester(stati) : 'unbekannt',
    teile: teile.length,
    ohne_datum: teile.filter((t) => teilStatus(t, heute) === 'unbekannt').length,
    in_reinigung: teile.filter((t) => t.in_reinigung_seit).length,
  };
}
