// GET /api/auth/me -> aktuell eingeloggter User oder 401 / 403
// 403 nur ohne jede Rolle in Anwesenheit und Einsatzprotokoll. Welche
// Bereiche das Frontend zeigt, entscheidet es anhand der Rollen.
import { json, unauthorized, forbidden, isAppMember, isEpMember } from '../../_lib/auth.js';

export async function onRequestGet({ data }) {
  if (!data.user) return unauthorized();
  if (!isAppMember(data.user) && !isEpMember(data.user)) return forbidden();
  return json({
    username: data.user.username,
    roles: data.user.roles,
    is_device: !!data.user.isDevice,
  });
}
