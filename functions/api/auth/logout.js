// POST /api/auth/logout -> löscht Session und Cookie
import { deleteSession, buildClearCookie, json } from '../../_lib/auth.js';

export async function onRequestPost({ request, env, data }) {
  if (env.DB && data.user) {
    await deleteSession(env, data.user.token).catch(() => {});
  }
  return json({ ok: true }, { headers: { 'Set-Cookie': buildClearCookie(request) } });
}
