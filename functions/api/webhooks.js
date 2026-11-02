// GET  /api/webhooks — ausgehende Webhooks auflisten (App-Admin)
// POST /api/webhooks — neuen Webhook anlegen (App-Admin)
//
// Diese Ziele werden nach dem Anlegen eines Einsatzes der Reihe nach
// aufgerufen (siehe _lib/fanout.js). Sie liegen in D1 und sind damit für
// jeden App-Admin lesbar — ein Ziel, dessen URL selbst das Geheimnis ist,
// gehört stattdessen als Secret in HOMEY_WEBHOOK_BASE.
import { json, err, unauthorized, forbidden, isEpAdmin } from '../_lib/auth.js';
import { protokolliere, auditEintrag } from '../_lib/audit.js';

function requireAdmin(data) {
  if (!data.user) return unauthorized();
  if (!isEpAdmin(data.user)) return forbidden();
  return null;
}

// Nur http(s) und keine internen Adressen: der Worker soll nicht als Proxy ins
// Cloudflare-interne Netz oder auf localhost missbraucht werden können.
const VERBOTENE_HOSTS = /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?)/i;

// Nur der Host für das Audit: Pfad und Abfrage enthalten oft das Geheimnis.
export function hostVon(url) {
  try { return new URL(String(url).replace(/\{[a-z]+\}/g, 'x')).host; } catch { return null; }
}

export function validateWebhook(body) {
  const name = String(body?.name || '').trim();
  const url  = String(body?.url  || '').trim();
  if (!name) return { error: 'Name fehlt' };
  if (name.length > 80) return { error: 'Name zu lang (max. 80 Zeichen)' };
  if (!url) return { error: 'URL fehlt' };
  if (url.length > 500) return { error: 'URL zu lang (max. 500 Zeichen)' };

  // Platzhalter vor der Prüfung neutralisieren, sonst scheitert new URL().
  const pruefbar = url.replace(/\{(keyword|unit|id|datum|uhrzeit)\}/g, 'x');
  let parsed;
  try { parsed = new URL(pruefbar); } catch { return { error: 'URL ist ungültig' }; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: 'Nur http:// oder https:// erlaubt' };
  }
  if (VERBOTENE_HOSTS.test(parsed.hostname)) {
    return { error: 'Interne Adressen sind nicht erlaubt' };
  }

  const aktiv = body?.aktiv === undefined ? 1 : (body.aktiv ? 1 : 0);
  const sort  = Number.isFinite(Number(body?.sort_order)) ? Math.trunc(Number(body.sort_order)) : 100;
  return { value: { name, url, aktiv, sort_order: sort } };
}

export async function onRequestGet({ env, data }) {
  const denied = requireAdmin(data); if (denied) return denied;

  const { results } = await env.DB.prepare(
    `SELECT id, name, url, aktiv, sort_order, created_at, created_by, last_status, last_at
     FROM einsatz_webhooks
     ORDER BY sort_order, id`
  ).all();
  return json(results);
}

export async function onRequestPost({ request, env, data }) {
  const denied = requireAdmin(data); if (denied) return denied;

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  const { value, error } = validateWebhook(body);
  if (error) return err(error);

  const res = await env.DB.prepare(
    `INSERT INTO einsatz_webhooks (name, url, aktiv, sort_order, created_by)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(value.name, value.url, value.aktiv, value.sort_order, data.user.username).run();

  await protokolliere(env, data.user, { bereich: 'webhooks', aktion: 'anlegen', objekt: 'webhook', objektId: res.meta.last_row_id,
    details: { name: value.name, host: hostVon(value.url), aktiv: value.aktiv } });
  return json({ id: res.meta.last_row_id, ...value }, { status: 201 });
}
