// Gemeinsamer Zugriff auf die Stammdaten-Tabellen in D1.
//
// Die Tabellen entstehen erst mit migrations/2026-10-02_stammdaten.sql. Wird
// der Code deployed, bevor die Migration gelaufen ist, fehlen sie — und beide
// Apps hätten schlagartig keine Teilnehmerliste mehr. Statt eines generischen
// 500 soll in diesem Fall eine Meldung kommen, die sagt, was zu tun ist.
import { json } from './auth.js';

export function istFehlendeTabelle(e) {
  return /no such table/i.test(String(e?.message || e));
}

export function migrationFehlt(tabelle) {
  return json({
    error: `Stammdaten-Tabelle „${tabelle}" fehlt — die Migration `
         + `2026-10-02_stammdaten.sql wurde noch nicht ausgeführt.`,
    migration_fehlt: true,
  }, { status: 503 });
}

// Führt eine Stammdaten-Abfrage aus und übersetzt die fehlende Tabelle in
// eine verständliche Antwort.
export async function mitStammdaten(tabelle, fn) {
  try {
    return await fn();
  } catch (e) {
    if (istFehlendeTabelle(e)) return migrationFehlt(tabelle);
    throw e;
  }
}
