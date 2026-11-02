// GET /api/agt-status — Atemschutztauglichkeit für die PA-Liste.
//
// Das Einsatzprotokoll zeigt neben einem PA-Träger einen Hinweis, wenn er
// nicht tauglich ist oder kein AGT-Kennzeichen hat. Der Hinweis blockiert
// nie: im Einsatz entscheidet der Einsatzleiter, nicht die App.
//
// Die Daten pflegt das Modul Atemschutz der Anwesenheit (gemeinsame D1).
// Fehlen dessen Tabellen, liefert der Endpunkt "nicht aktiv" statt eines
// Fehlers, damit die PA-Liste auf dem Alarmweg nie daran hängt.
import { json, err, unauthorized } from '../_lib/auth.js';
import { personStatus, heuteBerlin } from '../_lib/agt.js';

export async function onRequestGet({ env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();
  try {
    const [personen, nachweise] = await Promise.all([
      env.DB.prepare(`SELECT id, nachname, vorname FROM personen WHERE agt = 1`).all(),
      env.DB.prepare(
        `SELECT n.person_id, n.art, n.datum, n.gueltig_bis, n.pass, n.florix
         FROM agt_nachweise n JOIN personen p ON p.id = n.person_id
         WHERE p.agt = 1 AND n.verworfen = 0`
      ).all(),
    ]);
    if (!personen.results.length) return json({ aktiv: false, personen: [] });
    const heute = heuteBerlin();
    // Nur ob, nicht was: welcher Nachweis fehlt (etwa die G 26.3, ein
    // Gesundheitsdatum), gehört nicht auf die Tablets in den Fahrzeugen.
    // Die Einzelheiten stehen im Modul Atemschutz der Anwesenheit (SEC4).
    return json({
      aktiv: true,
      personen: personen.results.map((p) => {
        const st = personStatus(nachweise.results.filter((n) => n.person_id === p.id), heute);
        return {
          name: `${p.vorname} ${p.nachname}`,
          tauglich: st.tauglich,
          bald: Object.values(st.spalten).some((z) => z.status === 'gelb'),
        };
      }),
    });
  } catch (e) {
    if (/no such (table|column)/i.test(String(e?.message))) return json({ aktiv: false, personen: [] });
    throw e;
  }
}
