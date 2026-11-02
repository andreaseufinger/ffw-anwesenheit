// POST /api/webhook/einsatz   Body (JSON oder Formular): { unit, keyword }
//
// Öffnet ein neues Einsatzprotokoll aus einem externen Alarmierungssystem heraus.
// Anschließend kann jeder eingeloggte Erfasser den Einsatz weiter befüllen
// (der Webhook legt nur den Grundeintrag mit Alarmzeit + Grund + Einheit an).
//
// Absicherung: Shared Secret gegen die Cloudflare-Environment-Variable
// WEBHOOK_TOKEN, nur im Header (SEC6):
//   1) X-Webhook-Token: <token>          (so sendet aPager PRO)
//   2) Authorization: Bearer <token>
// Ein Token in Adresse oder Body zählt nicht: Adressen landen in Protokollen
// und Verläufen. GET antwortet 405 und legt nichts an.
// unit/keyword dürfen auch in der Adresse stehen (Platzhalter von aPager).
// Ohne gesetzte Env-Var lehnt der Endpunkt jede Anfrage ab (fail-closed).
//
// Der eingefrorene Altstand (einsatzprotokoll/) nimmt bis zur Umstellung von
// Musterwehr weiter GET und ?token= an.
//
// Bündelung: Gibt es bereits einen offenen Einsatz, der noch keine Stunde
// offen ist, wird KEIN neuer Einsatz angelegt (z. B. Nachalarmierungen/
// Retries desselben Vorfalls). Stattdessen wird dessen ID zurückgegeben.
// Ist die alarmierte Einheit des eingehenden Alarms "Gesamtalarm" oder
// "Vollalarm", überschreibt dieser Alarm zusätzlich Stichwort, Einheit,
// Datum und Uhrzeit des vorhandenen offenen Einsatzes (eine große Alarmierung
// ersetzt die Info eines vorangegangenen kleineren Alarms zum selben Vorfall).
// Ist der vorhandene offene Einsatz bereits länger als eine Stunde offen,
// gilt er als eigenständiger, laufender Einsatz — es wird ein neuer angelegt.
//
// Response (200/201): { id, status: 'offen', duplicate: boolean }
// Fehler: 401 (falsches/fehlendes Token), 500 (WEBHOOK_TOKEN nicht konfiguriert)

import { json, err } from '../../_lib/auth.js';
import { fanoutEinsatzAngelegt } from '../../_lib/fanout.js';

const REOPEN_WINDOW_MINUTES = 60;
const GROSSALARM_EINHEITEN  = new Set(['gesamtalarm', 'vollalarm']);
const CREATED_BY_WEBHOOK    = 'webhook';
const FELD_MAX              = 200;

function nowInBerlin() {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit',  minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const g = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { datum: `${g.year}-${g.month}-${g.day}`, uhrzeit: `${g.hour}:${g.minute}` };
}

// D1/SQLite liefert CURRENT_TIMESTAMP als "YYYY-MM-DD HH:MM:SS" in UTC ohne
// Zeitzonen-Suffix — für Date.parse muss das ISO-konform ergänzt werden.
function ageMinutes(sqliteTimestamp) {
  const iso = String(sqliteTimestamp).replace(' ', 'T') + 'Z';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return Infinity;
  return (Date.now() - then) / 60_000;
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let res = 0;
  for (let i = 0; i < a.length; i++) res |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return res === 0;
}

async function readParams(request) {
  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams);
  if (request.method === 'POST') {
    const ct = request.headers.get('content-type') || '';
    try {
      if (ct.includes('application/json')) {
        Object.assign(params, await request.json());
      } else if (ct.includes('application/x-www-form-urlencoded')) {
        const body = await request.text();
        const form = new URLSearchParams(body);
        Object.assign(params, Object.fromEntries(form));
      }
    } catch { /* Body optional */ }
  }
  return params;
}

function extractToken(request) {
  const headerToken = request.headers.get('x-webhook-token');
  if (headerToken) return headerToken.trim();
  const auth = request.headers.get('authorization') || '';
  const bearer = auth.match(/^\s*Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  return '';
}

async function handle(context) {
  const { request, env } = context;
  if (!env.DB) return err('D1 not bound', 500);
  const expected = (env.WEBHOOK_TOKEN || '').trim();
  if (!expected) return err('WEBHOOK_TOKEN nicht konfiguriert', 500);

  const params = await readParams(request);
  const supplied = extractToken(request);
  if (!timingSafeEqual(supplied, expected)) return err('Ungültiges Token', 401);

  // Auf FELD_MAX Zeichen gekürzt (SEC6): ein Alarm-Stichwort ist kurz, ein
  // überlanger Wert ist ein Fehler oder Missbrauch und soll die Datenbank
  // und die Weiterleitungen nicht füllen.
  const feld = (v) => String(v || '').trim().slice(0, FELD_MAX) || null;
  const unit    = feld(params.unit);
  const keyword = feld(params.keyword);
  const isGrossalarm = unit !== null && GROSSALARM_EINHEITEN.has(unit.toLowerCase());

  // Cloudflare-Worker läuft in UTC — für die Alarmzeit brauchen wir aber
  // deutsche Zeit (CET/CEST). Europe/Berlin handhabt Sommer-/Winterzeit
  // korrekt.
  const { datum: alarmDatum, uhrzeit: alarmUhrzeit } = nowInBerlin();

  // Gibt es schon einen offenen Einsatz, der noch keine Stunde offen ist?
  const existing = await env.DB.prepare(
    `SELECT id, created_at FROM einsaetze
     WHERE status = 'offen'
     ORDER BY created_at DESC, id DESC LIMIT 1`
  ).first();

  if (existing && ageMinutes(existing.created_at) < REOPEN_WINDOW_MINUTES) {
    if (isGrossalarm) {
      await env.DB.prepare(
        `UPDATE einsaetze SET
           alarm_datum = ?, alarm_uhrzeit = ?, einsatzgrund = ?, alarmierte_einheit = ?,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).bind(alarmDatum, alarmUhrzeit, keyword, unit, existing.id).run();
    }
    return json({ id: existing.id, status: 'offen', duplicate: true }, { status: 200 });
  }

  const res = await env.DB.prepare(
    `INSERT INTO einsaetze
       (alarm_datum, alarm_uhrzeit, einsatzgrund, alarmierte_einheit,
        status, created_by, updated_at)
     VALUES (?, ?, ?, ?, 'offen', ?, CURRENT_TIMESTAMP)`
  ).bind(alarmDatum, alarmUhrzeit, keyword, unit, CREATED_BY_WEBHOOK).run();

  // Fan-out an weitere Ziele (Hausautomation o. ä.) — erst NACH dem
  // erfolgreichen Insert und ohne await, damit Statuscode, Body und
  // Antwortzeit für aPager unverändert bleiben. Bewusst nur beim tatsächlichen
  // Anlegen: eine gebündelte Nachalarmierung (duplicate) legt nichts an und
  // löst daher auch nichts aus.
  fanoutEinsatzAngelegt(context, {
    id: res.meta.last_row_id,
    keyword,
    unit,
    datum: alarmDatum,
    uhrzeit: alarmUhrzeit,
  });

  return json(
    { id: res.meta.last_row_id, status: 'offen', duplicate: false },
    { status: 201 }
  );
}

// Bewusst eigener Handler statt keiner: ohne ihn fiele GET auf die statischen
// Seiten durch. 405 sagt dem Absender klar, dass er POST nehmen muss.
export const onRequestGet = () => err('Nur POST mit Token im Header', 405);
export const onRequestPost = handle;
