// Middleware für /api/* — hängt den angemeldeten Benutzer an `data.user` und
// wendet die zentrale Zugangsregel an (functions/_lib/zugang.js): ohne Rolle
// im jeweiligen Bereich (Anwesenheit oder Einsatzprotokoll) nur die
// öffentlichen Endpunkte (Anmeldung, Geräte, Alarm-Webhook). Feinere Rechte
// prüfen die einzelnen Routen.

import { getUserFromRequest } from '../_lib/auth.js';
import { zugangPruefen } from '../_lib/zugang.js';

export async function onRequest(context) {
  const { request, env, data, next } = context;
  data.user = null;
  if (env.DB) {
    try {
      data.user = await getUserFromRequest(request, env);
    } catch {
      data.user = null;
    }
  }
  const abgelehnt = zugangPruefen(request, data.user);
  if (abgelehnt) return abgelehnt;
  return next();
}
