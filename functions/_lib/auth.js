// Auth-Helper: Passwort-Hash, Sessions, Cookies, Rollenprüfung
// Verwendet Web Crypto (verfügbar in Cloudflare Workers/Pages Functions).

const COOKIE_NAME = 'aw_session';
const SESSION_TTL_DAYS = 30;
// Geräte melden sich bei abgelaufener Session automatisch neu an (Device-Token
// im localStorage). Die längere TTL sorgt nur dafür, dass dieser Pfad selten
// überhaupt gebraucht wird — verloren gehen kann dadurch nichts.
const DEVICE_SESSION_TTL_DAYS = 180;
const PBKDF2_ITERATIONS = 100000;
const ENROLLMENT_TTL_MINUTES = 15;

// App-getrennte Rollen. Ein Benutzer kann mehrere Rollen halten.
export const ROLES = Object.freeze({
  ADMIN_ANWESENHEIT:        'admin_anwesenheit',
  // Admin innerhalb der zugewiesenen Abteilung(en): darf dort alle
  // Einträge sehen, bearbeiten und löschen sowie Themen, Personen und
  // Erfasser pflegen — aber nicht in fremde Abteilungen hinein.
  ABTEILUNGSADMIN_ANWESENHEIT: 'abteilungsadmin_anwesenheit',
  ADMIN_EINSATZPROTOKOLL:   'admin_einsatzprotokoll',
  ERFASSER_ANWESENHEIT:     'erfasser_anwesenheit',
  ERFASSER_EINSATZPROTOKOLL:'erfasser_einsatzprotokoll',
  LESER_EINSATZPROTOKOLL:   'leser_einsatzprotokoll',
  // Modul-Admins nach dem Muster des Abteilungsadmins: volle Rechte im
  // eigenen Modul, sonst nichts. admin_anwesenheit (Wehrführung) darf beide.
  ADMIN_ATEMSCHUTZ:         'admin_atemschutz',
  ADMIN_KLEIDUNG:           'admin_kleidung',
});

export const ALL_ROLES = Object.freeze(Object.values(ROLES));

// Rollen der Anwesenheit (mit den Modulen Atemschutz und Kleidung). Die
// Rollen des Einsatzprotokolls stehen in EP_ROLES; beide Bereiche liegen
// seit der Zusammenführung in einer App, die Rechte bleiben getrennt.
export const APP_ROLES = Object.freeze({
  ADMIN:            ROLES.ADMIN_ANWESENHEIT,
  ABTEILUNGSADMIN:  ROLES.ABTEILUNGSADMIN_ANWESENHEIT,
  ERFASSER:         ROLES.ERFASSER_ANWESENHEIT,
  ATEMSCHUTZ:       ROLES.ADMIN_ATEMSCHUTZ,
  KLEIDUNG:         ROLES.ADMIN_KLEIDUNG,
});

export function hasRole(user, role) {
  return !!user && Array.isArray(user.roles) && user.roles.includes(role);
}
export function hasAnyRole(user, ...roles) {
  return roles.some((r) => hasRole(user, r));
}
export function isAppAdmin(user)    { return hasRole(user, APP_ROLES.ADMIN); }
export function isAppErfasser(user) { return hasRole(user, APP_ROLES.ERFASSER); }
// In der jeweiligen App authorisiert — entscheidet, wer sich anmelden darf.
// Der Abteilungsadmin gehört dazu; isAppAdmin bleibt bewusst der
// übergreifenden Rolle vorbehalten.
export function isAppMember(user) {
  return hasAnyRole(user, APP_ROLES.ADMIN, APP_ROLES.ABTEILUNGSADMIN, APP_ROLES.ERFASSER,
                    APP_ROLES.ATEMSCHUTZ, APP_ROLES.KLEIDUNG);
}
// Modul Atemschutz: Wehrführung (übergreifender Admin) oder Atemschutz-Admin.
export function darfAtemschutz(user) {
  return hasAnyRole(user, ROLES.ADMIN_ANWESENHEIT, ROLES.ADMIN_ATEMSCHUTZ);
}
// Modul Kleidung: Wehrführung oder Kleidung-Admin.
export function darfKleidung(user) {
  return hasAnyRole(user, ROLES.ADMIN_ANWESENHEIT, ROLES.ADMIN_KLEIDUNG);
}

// --- Einsatzprotokoll ----------------------------------------------------
//
// Fahrzeug-Tablets sind Erfasser des Einsatzprotokolls und haben keine Rolle
// der Anwesenheit; die Zugangsregel (zugang.js) hält sie damit aus allem
// anderen heraus.
export const EP_ROLES = Object.freeze({
  ADMIN:    ROLES.ADMIN_EINSATZPROTOKOLL,
  ERFASSER: ROLES.ERFASSER_EINSATZPROTOKOLL,
  LESER:    ROLES.LESER_EINSATZPROTOKOLL,
});
export function isEpAdmin(user)    { return hasRole(user, EP_ROLES.ADMIN); }
export function isEpErfasser(user) { return hasRole(user, EP_ROLES.ERFASSER); }
export function isEpLeser(user)    { return hasRole(user, EP_ROLES.LESER); }
// Darf schreiben (offene Einsätze bearbeiten): Admin oder Erfasser.
export function isEpWriter(user)   { return hasAnyRole(user, EP_ROLES.ADMIN, EP_ROLES.ERFASSER); }
// Darf ALLE Einsätze lesen (Liste + Detail, auch fremde/abgeschlossene): Admin oder Leser.
export function isEpReaderAll(user) { return hasAnyRole(user, EP_ROLES.ADMIN, EP_ROLES.LESER); }
// Irgendeine Rolle im Einsatzprotokoll
export function isEpMember(user)   { return hasAnyRole(user, EP_ROLES.ADMIN, EP_ROLES.ERFASSER, EP_ROLES.LESER); }

// --- Abteilungen ---------------------------------------------------------
//
// Welche Abteilungen ein Benutzer anfassen darf, steht in user_abteilungen —
// nicht im Rollennamen und nirgends als Abteilungsname im Code. Eine dritte
// Abteilung ist damit reine Datenpflege.
//
// admin_anwesenheit ist übergreifend und braucht keinen Eintrag.
// abteilungsadmin_anwesenheit und erfasser_anwesenheit wirken nur in ihren
// zugewiesenen Abteilungen.

export function isUebergreifenderAdmin(user) {
  return hasRole(user, ROLES.ADMIN_ANWESENHEIT);
}
export function isAbteilungsAdmin(user) {
  return hasRole(user, ROLES.ABTEILUNGSADMIN_ANWESENHEIT);
}

// Abteilungs-IDs, in denen der Benutzer arbeiten darf. null bedeutet
// "alle" — der übergreifende Admin ist nicht eingeschränkt. Ein leeres Array
// bedeutet "keine"; der Benutzer kann dann nichts erfassen.
export async function erlaubteAbteilungen(env, user) {
  if (!user) return [];
  if (isUebergreifenderAdmin(user)) return null;
  const { results } = await env.DB.prepare(
    `SELECT ua.abteilung_id AS id
     FROM user_abteilungen ua
     JOIN abteilungen a ON a.id = ua.abteilung_id
     WHERE ua.user_id = ?
     ORDER BY a.sort_order, a.id`
  ).bind(user.id).all();
  return results.map((r) => r.id);
}

// Darf der Benutzer in dieser Abteilung arbeiten?
export function darfAbteilung(erlaubt, abteilungId) {
  if (erlaubt === null) return true;           // übergreifender Admin
  if (abteilungId === null || abteilungId === undefined) return false;
  return erlaubt.includes(Number(abteilungId));
}

// Darf der Benutzer die Stammdaten dieser Abteilung verwalten? Der
// übergreifende Admin immer, der Abteilungsadmin in seinen Abteilungen.
// Ein Erfasser nie — er erfasst, er pflegt nicht.
export async function darfVerwalten(env, user, abteilungId) {
  if (isUebergreifenderAdmin(user)) return true;
  if (!isAbteilungsAdmin(user)) return false;
  const erlaubt = await erlaubteAbteilungen(env, user);
  return darfAbteilung(erlaubt, abteilungId);
}

// Darf der Benutzer überhaupt verwalten (irgendeine Abteilung)? Für die
// Sichtbarkeit von Listen, bevor eine konkrete Abteilung bekannt ist.
export function darfIrgendwasVerwalten(user) {
  return isUebergreifenderAdmin(user) || isAbteilungsAdmin(user);
}

// SQL-Fragment für "nur erlaubte Abteilungen". Gibt Klausel und Bindewerte
// zurück, damit die Aufrufer keine IDs in Strings kleben müssen.
export function abteilungsFilter(erlaubt, spalte) {
  if (erlaubt === null) return { klausel: '', binds: [] };
  if (!erlaubt.length) return { klausel: ' AND 1 = 0 ', binds: [] };
  return {
    klausel: ` AND ${spalte} IN (${erlaubt.map(() => '?').join(', ')}) `,
    binds: [...erlaubt],
  };
}

// --- bytes <-> hex ---
function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error('hex length odd');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function randomHex(byteLen) {
  const buf = new Uint8Array(byteLen);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

// --- Passwort-Hashing ---
export async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = hexToBytes(saltHex);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

export async function createPasswordHash(password) {
  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  return { hash, salt };
}

function timingSafeEqual(aHex, bHex) {
  if (aHex.length !== bHex.length) return false;
  let res = 0;
  for (let i = 0; i < aHex.length; i++) res |= aHex.charCodeAt(i) ^ bHex.charCodeAt(i);
  return res === 0;
}

export async function verifyPassword(password, expectedHashHex, saltHex) {
  const computed = await hashPassword(password, saltHex);
  return timingSafeEqual(computed, expectedHashHex);
}

// --- Cookies ---
export function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

function isSecureRequest(request) {
  try {
    const url = new URL(request.url);
    if (url.protocol === 'https:') return true;
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return false;
    return true;
  } catch {
    return true;
  }
}

export function buildSessionCookie(token, request, maxAgeSec) {
  const secure = isSecureRequest(request) ? '; Secure' : '';
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
}

export function buildClearCookie(request) {
  return buildSessionCookie('', request, 0);
}

// --- Geräte-Token (Fahrzeug-Tablets) ---
// Device-Token und Enrollment-Codes sind 32 zufällige Bytes, also hochentropisch.
// Dafür ist ein langsames KDF wie PBKDF2 unnötig (und auf Workers teuer) —
// ein einfacher SHA-256 schützt einen Datenbank-Dump genauso zuverlässig.
export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export function newDeviceToken()     { return randomHex(32); }
export function newEnrollmentCode()  { return randomHex(32); }
export function enrollmentExpiresAt() {
  return new Date(Date.now() + ENROLLMENT_TTL_MINUTES * 60 * 1000).toISOString();
}
export { ENROLLMENT_TTL_MINUTES };

// --- Sessions in D1 ---
//
// Der Browser bekommt das Token, die Datenbank nur "h:" + SHA-256 davon
// (Review-Befund SEC3/D7). Ein Datenbank-Export reicht damit nicht mehr, um
// sich als angemeldeter Benutzer auszugeben. Ältere Sitzungen mit Klartext-
// Token werden beim nächsten Aufruf umgestellt (siehe getUserFromRequest);
// übrig gebliebene löscht später die Migration
// 2026-11-01_sitzungen_klartext.sql (einige Tage nach dem Deploy).
export async function sitzungsSchluessel(token) {
  return 'h:' + await sha256Hex(token);
}

export async function createSession(env, userId, { isDevice = false } = {}) {
  const token = randomHex(32);
  const ttlDays = isDevice ? DEVICE_SESSION_TTL_DAYS : SESSION_TTL_DAYS;
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`
  )
    .bind(await sitzungsSchluessel(token), userId, expiresAt)
    .run();
  return { token, expiresAt, maxAge: ttlDays * 24 * 60 * 60 };
}

// Alle Sessions eines Benutzers beenden — beim Sperren eines Geräts und beim
// Ausstellen eines neuen Device-Tokens (der alte darf dann nicht weiterlaufen).
export async function deleteSessionsForUser(env, userId) {
  await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run();
}

// „Zuletzt gesehen" für Geräte mitschreiben, damit ein Gerät, das sich aus
// einem unerwarteten Netz meldet, in der Admin-Liste auffällt.
export async function touchDeviceSeen(env, userId, request) {
  const ip = request.headers.get('CF-Connecting-IP') || null;
  await env.DB.prepare(
    `UPDATE users SET last_seen_at = CURRENT_TIMESTAMP, last_seen_ip = ? WHERE id = ?`
  ).bind(ip, userId).run();
}

// schluessel = gespeicherter Wert (user.token aus getUserFromRequest)
export async function deleteSession(env, schluessel) {
  await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(schluessel).run();
}

// Alle Sitzungen eines Benutzers beenden, auf Wunsch bis auf eine (die
// eigene beim Passwortwechsel). Als vorbereitete Anweisung für einen Batch.
export function sitzungenBeenden(env, userId, ausser = null) {
  return ausser
    ? env.DB.prepare(`DELETE FROM sessions WHERE user_id = ? AND token <> ?`).bind(userId, ausser)
    : env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId);
}

export async function getUserFromRequest(request, env) {
  const cookies = parseCookies(request);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const schluessel = await sitzungsSchluessel(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.is_device, u.device_revoked_at, s.expires_at, s.token AS gespeichert
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token IN (?, ?)`
  )
    .bind(schluessel, token)
    .first();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await deleteSession(env, row.gespeichert).catch(() => {});
    return null;
  }
  // Alte Sitzung mit Klartext-Token: auf den Hash umstellen
  if (row.gespeichert !== schluessel) {
    await env.DB.prepare(`UPDATE sessions SET token = ? WHERE token = ?`)
      .bind(schluessel, row.gespeichert).run().catch(() => {});
  }
  // Ein gesperrtes Gerät verliert sofort den Zugriff, auch mit gültiger Session.
  if (row.is_device && row.device_revoked_at) {
    await deleteSessionsForUser(env, row.id).catch(() => {});
    return null;
  }
  const rolesRes = await env.DB.prepare(
    `SELECT role FROM user_roles WHERE user_id = ?`
  ).bind(row.id).all();
  const roles = rolesRes.results.map((r) => r.role);
  return { id: row.id, username: row.username, isDevice: !!row.is_device, roles, token: schluessel };
}

// --- Bremse gegen Durchprobieren von Passwörtern (SEC3) ------------------
//
// Fehlversuche stehen in login_fehlversuche (gemeinsam für beide Apps).
// Gesperrt wird ein Benutzername nach LOGIN_MAX_BENUTZER Fehlversuchen, eine
// Adresse nach LOGIN_MAX_IP, jeweils für LOGIN_FENSTER_MINUTEN. Fehlt die
// Tabelle (Code vor der Migration ausgeliefert), bremst nichts, die
// Anmeldung funktioniert aber weiter.
export const LOGIN_MAX_BENUTZER = 5;
export const LOGIN_MAX_IP = 30;
export const LOGIN_FENSTER_MINUTEN = 15;

const fehlendeTabelle = (e) => /no such table: login_fehlversuche/i.test(String(e?.message));

export function anfrageIp(request) {
  return request.headers.get('CF-Connecting-IP') || null;
}

// true = gesperrt
export async function loginGesperrt(env, username, ip) {
  try {
    const row = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM login_fehlversuche WHERE username = ? COLLATE NOCASE
            AND zeit > datetime('now', ?)) AS benutzer,
         (SELECT COUNT(*) FROM login_fehlversuche WHERE ? IS NOT NULL AND ip = ?
            AND zeit > datetime('now', ?)) AS adresse`
    ).bind(username, `-${LOGIN_FENSTER_MINUTEN} minutes`, ip, ip, `-${LOGIN_FENSTER_MINUTEN} minutes`).first();
    return (row?.benutzer ?? 0) >= LOGIN_MAX_BENUTZER || (row?.adresse ?? 0) >= LOGIN_MAX_IP;
  } catch (e) {
    if (fehlendeTabelle(e)) return false;
    throw e;
  }
}

export async function loginFehlschlag(env, username, ip) {
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO login_fehlversuche (username, ip) VALUES (?, ?)`).bind(username, ip),
      env.DB.prepare(`DELETE FROM login_fehlversuche WHERE zeit < datetime('now', '-1 day')`),
    ]);
  } catch (e) {
    if (!fehlendeTabelle(e)) throw e;
  }
}

export async function loginErfolg(env, username) {
  try {
    await env.DB.prepare(`DELETE FROM login_fehlversuche WHERE username = ? COLLATE NOCASE`).bind(username).run();
  } catch (e) {
    if (!fehlendeTabelle(e)) throw e;
  }
}

export function zuVieleVersuche() {
  return json({ error: `Zu viele Fehlversuche. Bitte in ${LOGIN_FENSTER_MINUTEN} Minuten erneut versuchen.` },
    { status: 429, headers: { 'Retry-After': String(LOGIN_FENSTER_MINUTEN * 60) } });
}

// Gleiche Rechenzeit für unbekannte Benutzernamen, damit die Antwortzeit
// nicht verrät, welche Namen es gibt.
export async function passwortPruefenOhneKonto(password) {
  await hashPassword(password, '00000000000000000000000000000000');
  return false;
}

// --- Response Helpers ---
export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(init.headers || {}) },
    status: init.status || 200,
  });
}

export function err(message, status = 400) {
  return json({ error: message }, { status });
}

export function unauthorized() {
  return json({ error: 'Nicht angemeldet' }, { status: 401 });
}

export function forbidden() {
  return json({ error: 'Keine Berechtigung' }, { status: 403 });
}

// --- Username/Passwort-Validierung ---
const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;
// Geräte tragen die Fahrzeugkennung als Namen, und die ist oft nur zweistellig
// (GW, LF, RW). Deshalb hier ab 2 Zeichen — persönliche Konten bleiben bei 3.
const DEVICE_NAME_RE = /^[A-Za-z0-9._-]{2,32}$/;

export function validateUsername(name) {
  if (typeof name !== 'string') return 'Benutzername fehlt';
  if (!USERNAME_RE.test(name)) return 'Benutzername: 3-32 Zeichen, A-Z, 0-9, . _ -';
  return null;
}

export function validateDeviceName(name) {
  if (typeof name !== 'string') return 'Gerätename fehlt';
  if (!DEVICE_NAME_RE.test(name)) return 'Gerätename: 2-32 Zeichen, A-Z, 0-9, . _ -';
  return null;
}

export function validatePassword(pw) {
  if (typeof pw !== 'string') return 'Passwort fehlt';
  // Mindestlänge 10 (SEC3). Gilt für neu gesetzte Passwörter; bestehende
  // bleiben gültig, bis sie geändert werden.
  if (pw.length < 10) return 'Passwort: mindestens 10 Zeichen';
  if (pw.length > 200) return 'Passwort zu lang';
  return null;
}

export function validateRoles(roles) {
  if (!Array.isArray(roles)) return 'roles muss ein Array sein';
  if (!roles.length) return 'mindestens eine Rolle erforderlich';
  for (const r of roles) {
    if (!ALL_ROLES.includes(r)) return `unbekannte Rolle: ${r}`;
  }
  return null;
}
