// Auth-Helper: Passwort-Hash, Sessions, Cookies, Rollenprüfung
// Verwendet Web Crypto (verfügbar in Cloudflare Workers/Pages Functions).

const COOKIE_NAME = 'aw_session';
const SESSION_TTL_DAYS = 30;
const PBKDF2_ITERATIONS = 100000;

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
  // Modul-Admins nach dem Muster des Abteilungsadmins: volle Rechte im
  // eigenen Modul, sonst nichts. admin_anwesenheit (Wehrführung) darf beide.
  ADMIN_ATEMSCHUTZ:         'admin_atemschutz',
  ADMIN_KLEIDUNG:           'admin_kleidung',
});

export const ALL_ROLES = Object.freeze(Object.values(ROLES));

// In dieser App relevante Rollen (für /me-Filter und Frontend-Anzeige).
// Wird in jeder Pages-Function-Kopie auf den App-spezifischen Wert gesetzt.
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

// --- Sessions in D1 ---
export async function createSession(env, userId) {
  const token = randomHex(32);
  const ttlMs = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`
  )
    .bind(token, userId, expiresAt)
    .run();
  return { token, expiresAt, maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 };
}

export async function deleteSession(env, token) {
  await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
}

export async function getUserFromRequest(request, env) {
  const cookies = parseCookies(request);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, s.expires_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ?`
  )
    .bind(token)
    .first();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await deleteSession(env, token).catch(() => {});
    return null;
  }
  const rolesRes = await env.DB.prepare(
    `SELECT role FROM user_roles WHERE user_id = ?`
  ).bind(row.id).all();
  const roles = rolesRes.results.map((r) => r.role);
  return { id: row.id, username: row.username, roles, token };
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

export function validateUsername(name) {
  if (typeof name !== 'string') return 'Benutzername fehlt';
  if (!USERNAME_RE.test(name)) return 'Benutzername: 3-32 Zeichen, A-Z, 0-9, . _ -';
  return null;
}

export function validatePassword(pw) {
  if (typeof pw !== 'string') return 'Passwort fehlt';
  if (pw.length < 6) return 'Passwort: mindestens 6 Zeichen';
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
