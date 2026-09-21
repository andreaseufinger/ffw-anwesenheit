// GET /api/personen — Liste der Teilnehmer (nur eingeloggte Benutzer)
// Die Datei wird zur Build-Zeit aus functions/_data/personen.json gebündelt
// und nie als öffentlich abrufbares Static-Asset ausgeliefert.
import personen from '../_data/personen.json';
import { json, unauthorized } from '../_lib/auth.js';

export async function onRequestGet({ data }) {
  if (!data.user) return unauthorized();
  return json(personen);
}
