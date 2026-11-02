// Zentrale Zugangsregel für /api/* (Review-Befund SEC2).
//
// Standard ist "abgelehnt": Jeder Endpunkt verlangt eine Sitzung MIT einer
// Rolle des Bereichs, zu dem er gehört. Ausgenommen sind nur die hier
// aufgeführten öffentlichen Endpunkte. Die feineren Rechte (Admin, Abteilung,
// Modul) prüfen die Endpunkte weiterhin selbst.
//
// Seit der Zusammenführung liegen Anwesenheit und Einsatzprotokoll in einer
// App mit einer Anmeldung. Getrennt bleiben die Bereiche über die Rollen:
//   - Einsatzprotokoll (EP_PFADE): admin/erfasser/leser_einsatzprotokoll.
//     Fahrzeug-Tablets haben nur erfasser_einsatzprotokoll.
//   - alles andere (Anwesenheit, Atemschutz, Kleidung): eine Rolle der
//     Anwesenheit (isAppMember).
// Ein Fahrzeug-Tablet kommt damit nicht an Personen, Themen, Abteilungen
// oder Atemschutz-Nachweise, ein reiner Erfasser der Anwesenheit nicht an
// Einsätze.
import { isAppMember, isEpMember, unauthorized, forbidden } from './auth.js';

// "METHODE /pfad" – ohne Anmeldung erreichbar
export const OEFFENTLICH = Object.freeze([
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'GET /api/auth/me',          // antwortet selbst mit 401/403
  'POST /api/auth/device',     // Gerätetoken
  'POST /api/auth/enroll',     // Einrichtungscode
  'GET /api/webhook/einsatz',  // Alarmierung, eigenes Token
  'POST /api/webhook/einsatz',
]);

// Pfade des Einsatzprotokolls: genau dieser Pfad oder alles darunter
export const EP_PFADE = Object.freeze([
  '/api/einsaetze',
  '/api/fahrzeuge',
  '/api/ffen',
  '/api/devices',
  '/api/webhooks',
  '/api/agt-status',
]);

const oeffentlich = new Set(OEFFENTLICH);

export function istEpPfad(pfad) {
  return EP_PFADE.some((p) => pfad === p || pfad.startsWith(p + '/'));
}

// null = durchlassen, sonst die Ablehnung
export function zugangPruefen(request, user) {
  const pfad = new URL(request.url).pathname.replace(/\/+$/, '');
  if (oeffentlich.has(`${request.method} ${pfad}`)) return null;
  if (!user) return unauthorized();
  const mitglied = istEpPfad(pfad) ? isEpMember(user) : isAppMember(user);
  if (!mitglied) return forbidden();
  return null;
}
