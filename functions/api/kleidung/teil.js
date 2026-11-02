// GET /api/kleidung/teil?code=… — Teil zu einem gescannten oder getippten
// Code. Der QR-Code enthält die Inventarnummer der Gemeinde (BRE…); falls er
// mehr Text trägt, wird die Nummer herausgelöst. Gesucht wird in Barcode und
// ZMS-Identifikation, auch bei Teilen, die nicht mehr im Bestand sind.
import { json, err, unauthorized, forbidden, darfKleidung } from '../../_lib/auth.js';
import { heuteBerlin } from '../../_lib/agt.js';
import { TEILE_SQL, teilAufbereiten, mitKleidung } from '../kleidung.js';

export function codeNormalisieren(roh) {
  const s = String(roh || '').trim();
  const bre = /BRE\d+/i.exec(s);
  return bre ? bre[0].toUpperCase() : s;
}

export async function onRequestGet({ request, env, data }) {
  if (!data.user) return unauthorized();
  if (!darfKleidung(data.user)) return forbidden();
  const code = codeNormalisieren(new URL(request.url).searchParams.get('code'));
  if (!code) return err('Code fehlt');
  return mitKleidung(async () => {
    const t = await env.DB.prepare(`${TEILE_SQL} WHERE t.barcode = ? COLLATE NOCASE OR t.identifikation = ?`)
      .bind(code, code).first();
    if (!t) return json({ error: 'Unbekannte Nummer', code }, { status: 404 });
    return json(teilAufbereiten(t, heuteBerlin()));
  });
}
