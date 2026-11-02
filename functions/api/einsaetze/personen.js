// GET /api/personen — Teilnehmerliste (eingeloggte Benutzer)
//
// Liest aus der geteilten Tabelle `personen` in D1. Früher lag hier eine
// eigene Kopie von functions/_data/personen.json, die mit der Kopie der
// Anwesenheit-App manuell synchron gehalten werden musste — genau das soll
// die gemeinsame Tabelle überflüssig machen.
//
// Gepflegt wird die Liste im Admin-Bereich der Anwesenheit-App.
// Ausgetretene Personen (aktiv = 0) werden hier nicht ausgeliefert, bleiben
// aber in bestehenden Protokollen stehen.
//
// Seit es mehrere Abteilungen gibt (Jugendfeuerwehr), werden hier nur
// Mitglieder von Abteilungen mit einsatzdienst = 1 geliefert. Jugendliche
// haben in der Besatzungs- und Atemschutzauswahl nichts zu suchen — in einem
// Dokument, das festhält, wer im Einsatz war, ist das nicht bloß unsauber.
//
// Gefiltert wird über das Kennzeichen, nicht über einen Abteilungsnamen: eine
// Alters- und Ehrenabteilung bekäme einsatzdienst = 0 und fiele automatisch
// heraus, eine zweite Einsatzabteilung käme automatisch dazu.
//
// von/bis an der Zuordnung werden berücksichtigt, falls gesetzt — jemand, der
// zum 1.7. in die Einsatzabteilung übergetreten ist, erscheint erst danach.
import { json, err, unauthorized } from '../../_lib/auth.js';
import { mitStammdaten } from '../../_lib/stammdaten.js';

export async function onRequestGet({ env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  return mitStammdaten('personen', async () => {
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT p.id, p.nachname, p.vorname
       FROM personen p
       JOIN personen_abteilungen pa ON pa.person_id = p.id
       JOIN abteilungen a ON a.id = pa.abteilung_id
       WHERE p.aktiv = 1
         AND a.einsatzdienst = 1
         AND (pa.von IS NULL OR pa.von <= DATE('now'))
         AND (pa.bis IS NULL OR pa.bis >= DATE('now'))
       ORDER BY p.nachname COLLATE NOCASE, p.vorname COLLATE NOCASE`
    ).all();
    return json(results);
  });
}
