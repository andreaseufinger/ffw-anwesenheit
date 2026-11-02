// PUT    /api/webhooks/:id — Webhook ändern (App-Admin)
// DELETE /api/webhooks/:id — Webhook löschen (App-Admin)
// POST   /api/webhooks/:id — Testaufruf (App-Admin)
//
// Der Testaufruf ist der einzige Ort, an dem auf das Ergebnis gewartet wird:
// hier will der Admin ja gerade wissen, ob das Ziel antwortet. Im Alarmfall
// läuft der Aufruf dagegen nachgelagert über _lib/fanout.js.
import { json, err, unauthorized, forbidden, isEpAdmin } from '../../_lib/auth.js';
import { buildTargetUrl } from '../../_lib/fanout.js';
import { validateWebhook, hostVon } from '../webhooks.js';
import { protokolliere, auditEintrag } from '../../_lib/audit.js';

const TEST_TIMEOUT_MS = 5000;

function requireAdmin(data) {
  if (!data.user) return unauthorized();
  if (!isEpAdmin(data.user)) return forbidden();
  return null;
}

async function loadWebhook(env, params) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return { error: err('Ungültige ID') };
  const row = await env.DB.prepare(
    `SELECT id, name, url FROM einsatz_webhooks WHERE id = ?`
  ).bind(id).first();
  if (!row) return { error: err('Webhook nicht gefunden', 404) };
  return { hook: row };
}

export async function onRequestPut({ request, env, params, data }) {
  const denied = requireAdmin(data); if (denied) return denied;
  const { hook, error: notFound } = await loadWebhook(env, params);
  if (notFound) return notFound;

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  const { value, error } = validateWebhook(body);
  if (error) return err(error);

  await env.DB.prepare(
    `UPDATE einsatz_webhooks SET name = ?, url = ?, aktiv = ?, sort_order = ? WHERE id = ?`
  ).bind(value.name, value.url, value.aktiv, value.sort_order, hook.id).run();

  await protokolliere(env, data.user, { bereich: 'webhooks', aktion: 'aendern', objekt: 'webhook', objektId: hook.id,
    details: { name: value.name, host: hostVon(value.url), aktiv: value.aktiv } });
  return json({ id: hook.id, ...value });
}

export async function onRequestDelete({ env, params, data }) {
  const denied = requireAdmin(data); if (denied) return denied;
  const { hook, error } = await loadWebhook(env, params);
  if (error) return error;

  await env.DB.prepare(`DELETE FROM einsatz_webhooks WHERE id = ?`).bind(hook.id).run();
  await protokolliere(env, data.user, { bereich: 'webhooks', aktion: 'loeschen', objekt: 'webhook', objektId: hook.id, details: { name: hook.name } });
  return json({ ok: true, id: hook.id, name: hook.name });
}

export async function onRequestPost({ env, params, data }) {
  const denied = requireAdmin(data); if (denied) return denied;
  const { hook, error } = await loadWebhook(env, params);
  if (error) return error;

  // Beispielwerte mit Leerzeichen und Umlaut — zeigt dem Admin direkt, ob die
  // Kodierung auf der Gegenseite stimmt.
  const url = buildTargetUrl(hook.url, {
    id: 0,
    keyword: 'H1 Türöffnung (Test)',
    unit: 'Test',
    datum: new Date().toISOString().slice(0, 10),
    uhrzeit: '00:00',
  });

  let status, ok;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
    status = String(res.status);
    ok = res.ok;
  } catch (e) {
    status = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : String(e).slice(0, 120);
    ok = false;
  }

  await env.DB.prepare(
    `UPDATE einsatz_webhooks SET last_status = ?, last_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(status, hook.id).run().catch(() => {});

  return json({ id: hook.id, name: hook.name, ok, status });
}
