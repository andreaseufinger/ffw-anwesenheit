// GET /api/auth/me -> aktuell eingeloggter User oder 401 / 403
import { json, unauthorized, forbidden, isAppMember } from '../../_lib/auth.js';

export async function onRequestGet({ data }) {
  if (!data.user) return unauthorized();
  if (!isAppMember(data.user)) return forbidden();
  return json({ username: data.user.username, roles: data.user.roles });
}
