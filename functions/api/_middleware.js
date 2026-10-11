// Middleware für /api/* — fügt den eingeloggten User an `data.user` an.
// Erzwingt Auth NICHT global, das machen die einzelnen Routen (manche sind public).

import { getUserFromRequest } from '../_lib/auth.js';

export async function onRequest(context) {
  const { request, env, data, next } = context;
  if (env.DB) {
    try {
      data.user = await getUserFromRequest(request, env);
    } catch {
      data.user = null;
    }
  } else {
    data.user = null;
  }
  return next();
}
