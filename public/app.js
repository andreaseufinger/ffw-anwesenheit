// Anwesenheit — Frontend mit Login/Rollen

// App-spezifische Konstanten — diese App kennt nur ihre eigenen Rollen.
const APP_ROLE_ADMIN    = 'admin_anwesenheit';
const APP_ROLE_ABTADMIN = 'abteilungsadmin_anwesenheit';
const APP_ROLE_ERFASSER = 'erfasser_anwesenheit';
const APP_ROLE_ATEMSCHUTZ = 'admin_atemschutz';
const APP_ROLE_KLEIDUNG   = 'admin_kleidung';
const APP_ROLES_SET     = new Set([APP_ROLE_ADMIN, APP_ROLE_ABTADMIN, APP_ROLE_ERFASSER,
                                   APP_ROLE_ATEMSCHUTZ, APP_ROLE_KLEIDUNG]);

const STATE = {
  personen: [],
  dienstarten: [],
  abteilungen: [],          // die, für die der Benutzer berechtigt ist
  alleAbteilungen: [],      // nur für die Verwaltung des übergreifenden Admins
  personenRollen: [],       // Jugendlicher, Betreuer, Mitglied …
  abteilungId: null,        // aktuell gewählte Abteilung der Erfassung
  uebergreifend: false,     // darf alle Abteilungen sehen (admin_anwesenheit)
  vwAbt: undefined,         // Abteilung in den Verwaltungsansichten, null = alle
  vwOffen: new Set(),       // aufgeklappte Themengruppen
  alleThemen: [],
  themen: [],
  themenByDienstart: new Map(),
  tags: [],               // [{ id, name, sort_order }]
  tagsById: new Map(),
  entries: [],
  view: 'edit',           // edit | history | detail | users | tags
  detailId: null,
  currentId: null,        // id der aktuell im Formular geladenen Anwesenheit
  user: null,             // { username, roles[] }
  editUserId: null,       // beim Bearbeiten eines Benutzers
  editTagId: null,        // beim Bearbeiten eines Tags
  activePersonIdx: null,  // aktuell im Detail-Sheet geöffnete Person
};

function userIsAdmin()    { return !!STATE.user?.roles?.includes(APP_ROLE_ADMIN); }
function userIsErfasser() { return !!STATE.user?.roles?.includes(APP_ROLE_ERFASSER); }
function userIsAbteilungsAdmin() { return !!STATE.user?.roles?.includes(APP_ROLE_ABTADMIN); }
// Darf Stammdaten pflegen — übergreifend oder in der eigenen Abteilung.
function userDarfVerwalten() { return userIsAdmin() || userIsAbteilungsAdmin(); }
// Die Auswertung enthält Einsatzdaten und setzt Admin-Rechte in BEIDEN Apps
// voraus — der Endpunkt prüft das ebenfalls, hier geht es nur um die Anzeige.
// Auswertung sieht, wer übergreifend oder für eine Abteilung Admin ist. Der
// Endpunkt prüft das ebenfalls und grenzt auf die eigenen Abteilungen ein.
// Modul Atemschutz: Wehrführung (übergreifender Admin) oder Atemschutz-Admin.
// Module lassen sich je Installation ausschalten (public/module.js); in der
// öffentlichen Demo sind Atemschutz, Kleidung und der EP-Link aus.
const MODUL = { atemschutz: true, kleidung: true, einsatzprotokoll: true, ...(window.FFW_MODULE || {}) };
function userDarfAtemschutz() { return MODUL.atemschutz && (userIsAdmin() || !!STATE.user?.roles?.includes(APP_ROLE_ATEMSCHUTZ)); }
// Modul Kleidung: Wehrführung oder Kleidung-Admin.
function userDarfKleidung() { return MODUL.kleidung && (userIsAdmin() || !!STATE.user?.roles?.includes(APP_ROLE_KLEIDUNG)); }
// Erfassen und Verlauf: wer eine Rolle der Anwesenheit selbst hat. Ein
// reiner Modul-Admin (z. B. Atemschutz) landet direkt in seinem Bereich.
function userDarfErfassen() { return userIsAdmin() || userIsAbteilungsAdmin() || userIsErfasser(); }
function userDarfAuswerten() {
  const r = STATE.user?.roles || [];
  return r.includes(APP_ROLE_ADMIN) || r.includes(APP_ROLE_ABTADMIN);
}
// Startseite: für alle, die mehr tun als erfassen. Reine Erfasser landen
// weiter direkt in der Erfassung, am Übungsabend ohne Umweg.
function userHatStart() { return userDarfAuswerten() || userDarfAtemschutz() || userDarfKleidung(); }
function startAnsicht() {
  return userHatStart() ? 'start' : 'edit';
}

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

document.addEventListener('DOMContentLoaded', init);

async function init() {
  bindEvents();
  setDefaultDate();
  await refreshAuth();
}

function bindEvents() {
  // Login
  $('#login-form').addEventListener('submit', onLoginSubmit);

  // Header
  $('#btn-menu').addEventListener('click', openMenu);
  $('#btn-new').addEventListener('click', () => {
    closeMenu();
    resetForm();
    showView('edit');
  });
  $('#btn-close').addEventListener('click', () => {
    resetForm();
    showView('edit');
  });

  // Menu actions
  $('#menu-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'menu-overlay') closeMenu();
  });
  $$('#menu-overlay .sheet-item').forEach((b) =>
    b.addEventListener('click', () => onMenuAction(b.dataset.action))
  );

  // Edit view actions
  $('#btn-save').addEventListener('click', save);
  $('#btn-email').addEventListener('click', () => sendEmail(collect()));
  $('#btn-back').addEventListener('click', () => showView('history'));
  $('#abteilung').addEventListener('change', onAbteilungWechsel);
  $('#aus-tabelle').addEventListener('click', (e) => {
    const b = e.target.closest('.aus-name');
    if (b) oeffnePersonAuswertung(Number(b.dataset.pid));
  });
  $('#btn-auspers-zurueck').addEventListener('click', () => showView('auswertung'));
  $('#erfolg-neu').addEventListener('click', () => { $('#erfolg-dialog').close(); $('#btn-new').click(); });
  $('#erfolg-verlauf').addEventListener('click', () => { $('#erfolg-dialog').close(); showView('history'); });
  $('#erfolg-weiter').addEventListener('click', () => $('#erfolg-dialog').close());
  $('#hist-abteilung').addEventListener('change', (e) => {
    STATE.histAbt = e.target.value;
    loadHistory();
  });
  $('#hist-florix').addEventListener('change', (e) => {
    STATE.histFlorixOffen = e.target.checked;
    loadHistory();
  });
  $('#btn-person-add').addEventListener('click', openAddDialog);
  $('#add-close').addEventListener('click', () => $('#add-dialog').close());
  $('#add-suche').addEventListener('input', renderAddListe);
  $('#dienstart').addEventListener('change', populateThemaSelect);
  ['az', 'offen'].forEach((w) => $('#sort-' + w).addEventListener('change', (e) => {
    if (e.target.checked) setSortierung(w);
  }));
  $$('.bulk-actions .chip[data-bulk]').forEach((b) =>
    b.addEventListener('click', () => bulkSet(b.dataset.bulk))
  );

  // Users
  $('#btn-user-new').addEventListener('click', openUserDialog);
  $('#user-cancel').addEventListener('click', () => $('#user-dialog').close('cancel'));
  $('#user-save').addEventListener('click', saveUserDialog);

  // Tags
  $('#btn-tag-new').addEventListener('click', () => openTagDialog());
  $('#btn-aus-export').addEventListener('click', exportAuswertung);
  // Verwaltungsansichten: Reiter, Abteilungsauswahl, Suche.
  initReiter('#view-stammpersonen');
  initReiter('#view-themen');
  $('#pv-abt').addEventListener('change', () => { setzeVwAbt($('#pv-abt').value); renderStammPersonen(); });
  $('#pv-suche').addEventListener('input', renderStammPersonen);
  $('#pv-inaktiv').addEventListener('change', renderStammPersonen);
  $('#tv-abt').addEventListener('change', () => { setzeVwAbt($('#tv-abt').value); loadThemenView(); });
  $('#tv-suche').addEventListener('input', () => { renderThemenGruppen(); renderDienstarten(); });
  $('#tv-inaktiv').addEventListener('change', renderThemenGruppen);
  $('#th-abteilung').addEventListener('change', onThemaAbteilungWechsel);
  $('#erg-cancel').addEventListener('click', () => $('#erg-dialog').close());
  $('#erg-save').addEventListener('click', ergaenzeAbteilung);
  $('#merge-cancel').addEventListener('click', () => $('#merge-dialog').close());
  $('#merge-save').addEventListener('click', mergePersonen);
  // Beim Tippen nach bestehenden Personen suchen, entprellt.
  for (const id of ['#sp-nachname', '#sp-vorname']) {
    $(id).addEventListener('input', () => {
      clearTimeout(sucheTimer);
      sucheTimer = setTimeout(sucheDubletten, 300);
    });
  }
  $('#btn-prolle-new').addEventListener('click', () => openPersonenRolleDialog());
  $('#prolle-cancel').addEventListener('click', () => $('#prolle-dialog').close());
  $('#prolle-save').addEventListener('click', savePersonenRolle);
  $('#btn-abteilung-new').addEventListener('click', () => openAbteilungDialog());
  $('#abt-cancel').addEventListener('click', () => $('#abt-dialog').close());
  $('#abt-save').addEventListener('click', saveAbteilung);
  $('#btn-stammperson-new').addEventListener('click', () => openStammPersonDialog());
  $('#sp-cancel').addEventListener('click', () => $('#sp-dialog').close());
  $('#sp-save').addEventListener('click', saveStammPerson);
  $('#btn-dienstart-new').addEventListener('click', () => openDienstartDialog());
  $('#da-cancel').addEventListener('click', () => $('#da-dialog').close());
  $('#da-save').addEventListener('click', saveDienstart);
  $('#btn-thema-new').addEventListener('click', () => openThemaDialog());
  $('#th-cancel').addEventListener('click', () => $('#th-dialog').close());
  $('#th-save').addEventListener('click', saveThema);
  $('#tag-cancel').addEventListener('click', () => $('#tag-dialog').close('cancel'));
  $('#tag-save').addEventListener('click', saveTagDialog);

  // Übungsleiter-Combobox
  setupAusbilderCombo();

  // Person Detail-Sheet
  $('#person-sheet-done').addEventListener('click', closePersonSheet);
  $('#person-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'person-overlay') closePersonSheet();
  });
  $('#person-sheet-anwesend').addEventListener('change', () => {
    const idx = STATE.activePersonIdx;
    if (idx == null) return;
    STATE.entries[idx].status = $('#person-sheet-anwesend').checked ? 'anwesend' : '';
  });
}

// --- Auth Flow ---

async function refreshAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const me = await res.json();
      await onLoggedIn(me);
      return;
    }
  } catch {}
  showLogin();
}

function showLogin() {
  STATE.user = null;
  $('#login-screen').classList.remove('hidden');
  $('#app').classList.add('hidden');
  $('#login-pass').value = '';
}

async function onLoggedIn(me) {
  STATE.user = me;
  const isAdmin = userIsAdmin();
  const isErf = userIsErfasser();
  document.body.classList.toggle('is-admin', isAdmin);
  document.body.classList.toggle('is-erfasser', isErf && !isAdmin);
  document.body.classList.toggle('can-auswerten', userDarfAuswerten());
  // Themen und Personen darf auch der Abteilungsadmin pflegen — Benutzer und
  // Tags bleiben dem übergreifenden Admin vorbehalten.
  document.body.classList.toggle('can-verwalten', userDarfVerwalten());
  document.body.classList.toggle('can-atemschutz', userDarfAtemschutz());
  document.body.classList.toggle('can-kleidung', userDarfKleidung());
  document.body.classList.toggle('can-erfassen', userDarfErfassen());
  document.body.classList.toggle('has-start', userHatStart());
  $('#menu-username').textContent = me.username;
  $('#menu-role').textContent = isAdmin ? 'Admin'
    : userIsAbteilungsAdmin() ? 'Abteilungsadmin'
    : userIsErfasser() ? 'Erfasser'
    : STATE.user.roles.includes(APP_ROLE_ATEMSCHUTZ) ? 'Atemschutz' : 'Kleidung';
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  await loadStaticData();
  // Die Zeiten der Abteilung gelten auch für das erste, noch unberührte
  // Formular. Bisher setzte sie nur resetForm() — also erst nach "Neu" oder
  // einem Abteilungswechsel. Beim Anmelden blieben die Werte stehen, die fest
  // im HTML standen; für die Einsatzabteilung stimmten die zufällig.
  setDefaultZeiten();
  showView(startAnsicht());
}

async function onLoginSubmit(e) {
  e.preventDefault();
  const username = $('#login-user').value.trim();
  const password = $('#login-pass').value;
  const errEl = $('#login-error');
  errEl.classList.add('hidden');
  const btn = $('#login-submit');
  btn.disabled = true;
  btn.textContent = 'Anmelden …';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (res.status === 401) {
      errEl.textContent = 'Benutzername oder Passwort falsch.';
      errEl.classList.remove('hidden');
      return;
    }
    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || `HTTP ${res.status}`);
    }
    const me = await res.json();
    await onLoggedIn(me);
  } catch (err) {
    errEl.textContent = 'Fehler: ' + err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Anmelden';
  }
}

async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {}
  closeMenu();
  showLogin();
}

// --- Menu ---

function openMenu() {
  // Darstellungs-Umschalter auf den gespeicherten Stand dieses Geräts setzen.
  const theme = $('#theme-' + (typeof getTheme === 'function' ? getTheme() : 'auto'));
  if (theme) theme.checked = true;
  menuPanel('haupt', false);
  $('#menu-overlay').classList.remove('hidden');
}
// Hauptmenü oder Untermenü "Einstellungen"
function menuPanel(name, fokus = true) {
  $('#menu-haupt').classList.toggle('hidden', name !== 'haupt');
  $('#menu-einstellungen').classList.toggle('hidden', name !== 'einstellungen');
  if (!fokus) return;
  const ziel = name === 'haupt' ? '[data-action="einstellungen"]' : '[data-action="menue-zurueck"]';
  $(`#menu-overlay ${ziel}`)?.focus();
}
function closeMenu() {
  $('#menu-overlay').classList.add('hidden');
}
function onMenuAction(action) {
  if (action === 'einstellungen') { menuPanel('einstellungen'); return; }
  if (action === 'menue-zurueck') { menuPanel('haupt'); return; }
  closeMenu();
  if (action === 'tauglichkeiten') {
    modulLaden('atemschutz').then(() => window.agtArtenDialog())
      .catch((err) => toast('Fehler: ' + err.message, 'error'));
    return;
  }
  if (action === 'start') showView('start');
  else if (action === 'edit') showView('edit');
  else if (action === 'history') showView('history');
  else if (action === 'users') showView('users');
  else if (action === 'auswertung') showView('auswertung');
  else if (action === 'abteilungen') showView('abteilungen');
  else if (action === 'stammpersonen') showView('stammpersonen');
  else if (action === 'themen') showView('themen');
  else if (action === 'atemschutz') showView('atemschutz');
  else if (action === 'kleidung') showView('kleidung');
  else if (action === 'tags') showView('tags');
  else if (action === 'export') exportExcel();
  else if (action === 'logout') logout();
}

// Mehrfachauswahl von Abteilungen für die Verwaltungsdialoge. Nur die, für
// die der Benutzer zuständig ist — ein Jugendwart soll keine
// Einsatzabteilungs-Zuordnung setzen können.
function renderAbteilungsAuswahl(selector, praefix, gesetzte) {
  const box = $(selector);
  box.innerHTML = '';
  if (!STATE.abteilungen.length) {
    box.innerHTML = '<span class="leer">Keine Abteilung verfügbar.</span>';
    return;
  }
  const an = new Set((gesetzte || []).map(Number));
  for (const a of STATE.abteilungen) {
    const id = `${praefix}-abt-${a.id}`;
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" id="${id}" value="${a.id}"${an.has(a.id) ? ' checked' : ''}> `
      + `<span>${escapeHtml(a.name)}</span>`;
    box.appendChild(label);
  }
}

// Wie renderAbteilungsAuswahl, aber je Abteilung zusätzlich eine Rolle.
// Die Rolle hängt an der Zugehörigkeit: derselbe Mensch kann in der Jugend
// Betreuer und in der Einsatzabteilung Mitglied sein.
function renderAbteilungsRollen(selector, zuordnungen) {
  const box = $(selector);
  box.innerHTML = '';
  if (!STATE.abteilungen.length) {
    box.innerHTML = '<span class="leer">Keine Abteilung verfügbar.</span>';
    return;
  }
  const vorhanden = new Map((zuordnungen || []).map((z) => [Number(z.abteilung_id), z.rolle_id]));
  for (const a of STATE.abteilungen) {
    const an = vorhanden.has(a.id);
    const zeile = document.createElement('div');
    zeile.className = 'abt-rolle-zeile';
    const optionen = ['<option value="">— ohne Rolle —</option>']
      .concat(STATE.personenRollen.map((r) =>
        `<option value="${r.id}"${vorhanden.get(a.id) === r.id ? ' selected' : ''}>`
        + `${escapeHtml(r.name)}</option>`))
      .join('');
    zeile.innerHTML =
        `<label><input type="checkbox" data-abt="${a.id}"${an ? ' checked' : ''}> `
      + `<span>${escapeHtml(a.name)}</span></label>`
      + `<select data-rolle-fuer="${a.id}"${an ? '' : ' disabled'}>${optionen}</select>`;
    // Die Rollenauswahl ist nur sinnvoll, wenn die Abteilung angekreuzt ist.
    const box2 = zeile.querySelector('input');
    const sel = zeile.querySelector('select');
    box2.addEventListener('change', () => { sel.disabled = !box2.checked; });
    box.appendChild(zeile);
  }
}

function gewaehlteAbteilungsRollen(selector) {
  return [...$(selector).querySelectorAll('input[type="checkbox"]:checked')].map((el) => {
    const id = Number(el.dataset.abt);
    const sel = $(selector).querySelector(`select[data-rolle-fuer="${id}"]`);
    const rolle = sel && sel.value ? Number(sel.value) : null;
    return { abteilung_id: id, rolle_id: rolle };
  }).filter((z) => Number.isFinite(z.abteilung_id));
}

function gewaehlteAbteilungen(selector) {
  return [...$(selector).querySelectorAll('input[type="checkbox"]:checked')]
    .map((el) => Number(el.value)).filter(Number.isFinite);
}

// --- Abteilungen ---
// Welche Abteilung gewählt ist, bestimmt Teilnehmerliste, Themen und die
// Vorbelegung der Zeiten. Alle drei kommen aus den Daten, nicht aus dem Code —
// eine dritte Abteilung braucht hier keine Änderung.

async function ladePersonenRollen() {
  try {
    const res = await fetch('/api/personen-rollen');
    STATE.personenRollen = res.ok ? await res.json() : [];
  } catch { STATE.personenRollen = []; }
}

async function ladeAbteilungen() {
  try {
    const res = await fetch('/api/abteilungen');
    if (!res.ok) { STATE.abteilungen = []; return; }
    const d = await res.json();
    STATE.abteilungen = d.abteilungen || [];
    STATE.uebergreifend = !!d.uebergreifend;
    // Vorauswahl kommt vom Server: niedrigste sort_order unter den erlaubten.
    // Bei mehreren Berechtigungen ist das die Einsatzabteilung (sort_order 10).
    if (STATE.abteilungId === null
        || !STATE.abteilungen.some((a) => a.id === STATE.abteilungId)) {
      STATE.abteilungId = d.vorauswahl_id ?? null;
    }
  } catch { STATE.abteilungen = []; }

  const feld = $('#abteilung-feld');
  const sel = $('#abteilung');
  sel.innerHTML = '';
  for (const a of STATE.abteilungen) {
    const o = document.createElement('option');
    o.value = String(a.id);
    o.textContent = a.name;
    sel.appendChild(o);
  }
  if (STATE.abteilungId !== null) sel.value = String(STATE.abteilungId);
  // Bei genau einer Abteilung wäre der Umschalter nur Ballast.
  feld.classList.toggle('hidden', STATE.abteilungen.length < 2);
}

function aktuelleAbteilung() {
  return STATE.abteilungen.find((a) => a.id === STATE.abteilungId) || null;
}

// Zeiten aus der gewählten Abteilung. Fallback auf die alten Festwerte, falls
// an der Abteilung nichts hinterlegt ist.
function setDefaultZeiten() {
  const a = aktuelleAbteilung();
  $('#zeit-von').value = a?.standard_zeit_von || '20:00';
  $('#zeit-bis').value = a?.standard_zeit_bis || '21:30';
}

async function onAbteilungWechsel() {
  const neu = Number($('#abteilung').value);
  if (!Number.isFinite(neu) || neu === STATE.abteilungId) return;
  STATE.abteilungId = neu;
  // Teilnehmer und Themen gehören zur Abteilung und müssen neu geladen
  // werden; ein bereits begonnenes Formular wird dabei zurückgesetzt.
  await loadStaticData();
  resetForm();
}

// --- Static Daten ---

function setDefaultDate() {
  const today = new Date();
  const iso = today.toISOString().slice(0, 10);
  $('#datum').value = iso;
}

async function loadStaticData() {
  // Abteilungen zuerst: sie bestimmen, welche Personen und Themen geladen
  // werden und wie die Zeiten vorbelegt sind.
  await ladeAbteilungen();
  await ladePersonenRollen();
  const abt = STATE.abteilungId ? `?abteilung_id=${STATE.abteilungId}` : '';

  const [pRes, tRes, tagRes] = await Promise.all([
    fetch('/api/personen' + abt),
    // Themen kommen seit der Stammdaten-Umstellung aus D1 statt aus dem
    // Static-Asset /data/themen.json — damit im Admin pflegbar und nicht
    // mehr öffentlich abrufbar.
    fetch('/api/themen' + abt),
    fetch('/api/tags'),
  ]);
  if (pRes.status === 401) { showLogin(); return; }
  // 503 = Stammdaten-Tabellen fehlen, die Migration ist noch nicht gelaufen.
  // Ohne diesen Hinweis stünde man vor leeren Listen und wüsste nicht, warum.
  if (pRes.status === 503 || tRes.status === 503) {
    const d = await (pRes.status === 503 ? pRes : tRes).json().catch(() => ({}));
    hinweis(d.error || 'Stammdaten-Tabellen fehlen — Migration noch nicht ausgeführt.');
    STATE.personen = []; STATE.themen = []; STATE.tags = [];
    STATE.tagsById = new Map(); STATE.themenByDienstart = new Map(); STATE.entries = [];
    return;
  }
  STATE.personen = await pRes.json();
  STATE.themen = await tRes.json();
  STATE.tags = tagRes.ok ? await tagRes.json() : [];
  STATE.tagsById = new Map(STATE.tags.map((t) => [t.id, t]));
  STATE.themenByDienstart = new Map();
  STATE.themen.sort((a, b) => {
    if (a.dienstart !== b.dienstart) return a.dienstart.localeCompare(b.dienstart, 'de');
    if (a.prioritaet !== b.prioritaet) return a.prioritaet - b.prioritaet;
    return a.thema.localeCompare(b.thema, 'de');
  });
  STATE.themen.forEach((t) => {
    if (!STATE.themenByDienstart.has(t.dienstart)) STATE.themenByDienstart.set(t.dienstart, []);
    STATE.themenByDienstart.get(t.dienstart).push(t);
  });
  STATE.personen.sort((a, b) => {
    const cmp = a.vorname.localeCompare(b.vorname, 'de');
    return cmp !== 0 ? cmp : a.nachname.localeCompare(b.nachname, 'de');
  });
  STATE.entries = STATE.personen.map((p) => ({
    nachname: p.nachname,
    vorname: p.vorname,
    status: '',
    bemerkung: '',
    tag_ids: new Set(),
  }));
  populateDienstartSelect();
  renderPersonen();
  updateSummary();
}

function renderAusbilderOptions(filter) {
  const list = $('#ausbilder-list');
  list.innerHTML = '';
  const f = (filter || '').trim().toLowerCase();
  let count = 0;
  for (const p of STATE.personen) {
    const name = `${p.vorname} ${p.nachname}`;
    if (f && !name.toLowerCase().includes(f)) continue;
    const li = document.createElement('li');
    li.className = 'combo-item';
    li.textContent = name;
    li.setAttribute('role', 'option');
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      $('#ausbilder').value = name;
      closeAusbilderList();
    });
    list.appendChild(li);
    if (++count >= 50) break;
  }
  return count;
}

function openAusbilderList() {
  const input = $('#ausbilder');
  const count = renderAusbilderOptions(input.value);
  if (count === 0) {
    closeAusbilderList();
    return;
  }
  $('#ausbilder-list').classList.remove('hidden');
}

function closeAusbilderList() {
  $('#ausbilder-list').classList.add('hidden');
}

function setupAusbilderCombo() {
  const input = $('#ausbilder');
  const toggle = $('#ausbilder-toggle');
  toggle.addEventListener('click', (e) => {
    e.preventDefault();
    if ($('#ausbilder-list').classList.contains('hidden')) {
      // Beim Toggle-Klick die volle Liste zeigen, nicht filtern
      const tmpFilter = input.value;
      input.value = '';
      const count = renderAusbilderOptions('');
      input.value = tmpFilter;
      if (count > 0) {
        $('#ausbilder-list').classList.remove('hidden');
        input.focus();
      }
    } else {
      closeAusbilderList();
    }
  });
  input.addEventListener('focus', openAusbilderList);
  input.addEventListener('input', openAusbilderList);
  input.addEventListener('blur', () => {
    setTimeout(closeAusbilderList, 150);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAusbilderList();
  });
}

async function refreshTags() {
  try {
    const res = await fetch('/api/tags');
    if (!res.ok) return;
    STATE.tags = await res.json();
    STATE.tagsById = new Map(STATE.tags.map((t) => [t.id, t]));
  } catch {}
}

function populateDienstartSelect() {
  const sel = $('#dienstart');
  sel.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '— wählen —';
  placeholder.disabled = true;
  placeholder.selected = true;
  sel.appendChild(placeholder);
  for (const dienstart of STATE.themenByDienstart.keys()) {
    const opt = document.createElement('option');
    opt.value = dienstart;
    opt.textContent = dienstart;
    sel.appendChild(opt);
  }
  if (STATE.themenByDienstart.has('Aus- und Fortbildung')) {
    sel.value = 'Aus- und Fortbildung';
    populateThemaSelect();
  }
}

function populateThemaSelect() {
  const dienstart = $('#dienstart').value;
  const sel = $('#thema');
  sel.innerHTML = '';
  if (!dienstart) return;
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '— wählen —';
  placeholder.disabled = true;
  placeholder.selected = true;
  sel.appendChild(placeholder);
  for (const t of STATE.themenByDienstart.get(dienstart) || []) {
    const opt = document.createElement('option');
    opt.value = t.thema;
    opt.textContent = t.thema;
    sel.appendChild(opt);
  }
}

// --- Teilnehmer-Liste ---

// Reihenfolge der Teilnehmerliste: alphabetisch oder "Offene zuerst" (pro
// Gerät gemerkt). Sortiert wird nur beim Zeichnen der Liste, nicht beim
// Abhaken: eine Zeile, die unter dem Daumen wegspringt, führt zu Fehlgriffen.
const SORT_KEY = 'ffwe_anw_sort';
function getSortierung() {
  try { return localStorage.getItem(SORT_KEY) === 'offen' ? 'offen' : 'az'; } catch { return 'az'; }
}
function setSortierung(wert) {
  try { localStorage.setItem(SORT_KEY, wert); } catch {}
  renderPersonen();
}

function renderPersonen() {
  const list = $('#personen-list');
  list.innerHTML = '';
  const offenZuerst = getSortierung() === 'offen';
  $('#sort-' + (offenZuerst ? 'offen' : 'az')).checked = true;
  const reihenfolge = STATE.entries.map((_, i) => i);
  if (offenZuerst) {
    // stabil: innerhalb der Gruppen bleibt die alphabetische Reihenfolge
    reihenfolge.sort((a, b) =>
      (STATE.entries[a].status === 'anwesend') - (STATE.entries[b].status === 'anwesend'));
  }
  let trennerGesetzt = false;
  reihenfolge.forEach((idx) => {
    const entry = STATE.entries[idx];
    if (offenZuerst && !trennerGesetzt && entry.status === 'anwesend' && idx !== reihenfolge[0]) {
      const t = document.createElement('li');
      t.className = 'personen-trenner';
      t.textContent = 'Anwesend';
      list.appendChild(t);
      trennerGesetzt = true;
    }
    const li = document.createElement('li');
    li.className = 'person-item';

    const row = document.createElement('div');
    row.className = 'person-row';

    const checkLabel = document.createElement('label');
    checkLabel.className = 'check-area';
    checkLabel.htmlFor = `chk-${idx}`;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `chk-${idx}`;
    checkbox.className = 'person-checkbox';
    checkbox.checked = entry.status === 'anwesend';
    checkbox.addEventListener('change', () => {
      STATE.entries[idx].status = checkbox.checked ? 'anwesend' : '';
      updateSummary();
    });
    checkLabel.appendChild(checkbox);

    const nameBtn = document.createElement('button');
    nameBtn.type = 'button';
    nameBtn.className = 'person-name';
    nameBtn.textContent = `${entry.vorname} ${entry.nachname}`;
    nameBtn.addEventListener('click', () => openPersonSheet(idx));

    const dot = document.createElement('span');
    dot.className = 'person-info-dot';
    if (hasExtraInfo(entry)) dot.classList.add('active');

    row.appendChild(checkLabel);
    row.appendChild(nameBtn);
    row.appendChild(dot);
    li.appendChild(row);
    list.appendChild(li);
  });
}

function hasExtraInfo(entry) {
  const tagCount = entry.tag_ids ? entry.tag_ids.size : 0;
  return tagCount > 0 || (entry.bemerkung && entry.bemerkung.trim().length > 0);
}

function openPersonSheet(idx) {
  const entry = STATE.entries[idx];
  if (!entry) return;
  STATE.activePersonIdx = idx;

  $('#person-sheet-name').textContent = `${entry.vorname} ${entry.nachname}`;
  $('#person-sheet-anwesend').checked = entry.status === 'anwesend';
  $('#person-sheet-bemerkung').value = entry.bemerkung || '';

  const tagsList = $('#person-sheet-tags');
  tagsList.innerHTML = '';
  const empty = $('#person-sheet-tags-empty');
  if (!STATE.tags.length) {
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
    for (const t of STATE.tags) {
      const li = document.createElement('li');
      const lbl = document.createElement('label');
      lbl.className = 'tag-check-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = entry.tag_ids?.has(t.id) || false;
      cb.addEventListener('change', () => {
        if (!entry.tag_ids) entry.tag_ids = new Set();
        if (cb.checked) entry.tag_ids.add(t.id);
        else entry.tag_ids.delete(t.id);
      });
      const span = document.createElement('span');
      span.textContent = t.name;
      lbl.appendChild(cb);
      lbl.appendChild(span);
      li.appendChild(lbl);
      tagsList.appendChild(li);
    }
  }

  $('#person-overlay').classList.remove('hidden');
}

function closePersonSheet() {
  const idx = STATE.activePersonIdx;
  if (idx != null) {
    const entry = STATE.entries[idx];
    entry.status = $('#person-sheet-anwesend').checked ? 'anwesend' : '';
    entry.bemerkung = $('#person-sheet-bemerkung').value.trim();
  }
  $('#person-overlay').classList.add('hidden');
  STATE.activePersonIdx = null;
  renderPersonen();
  updateSummary();
}

// --- Person hinzufügen ---
// Aus allen hinterlegten (aktiven) Personen, auch aus anderen Abteilungen:
// Gäste und Aushilfen stehen nicht in der Teilnehmerliste ihrer Abteilung.
// Die Person kommt als anwesend dazu und wird beim Speichern wie jede andere
// per Name mit den Stammdaten verknüpft.
async function openAddDialog() {
  $('#add-suche').value = '';
  $('#add-liste').innerHTML = '<li class="add-leer">Lade …</li>';
  $('#add-dialog').showModal();
  try {
    const res = await fetch('/api/personen');
    if (res.status === 401) { $('#add-dialog').close(); showLogin(); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    STATE.allePersonen = await res.json();
  } catch {
    $('#add-liste').innerHTML = '<li class="add-leer">Personen konnten nicht geladen werden.</li>';
    return;
  }
  renderAddListe();
  $('#add-suche').focus();
}

function renderAddListe() {
  const liste = $('#add-liste');
  const f = $('#add-suche').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const schluessel = (n, v) => `${v}|${n}`.toLowerCase();
  const da = new Set(STATE.entries.map((e) => schluessel(e.nachname, e.vorname)));
  const abtName = new Map((STATE.abteilungen || []).map((x) => [x.id, x.kurz || x.name]));
  const treffer = (STATE.allePersonen || [])
    .filter((p) => !da.has(schluessel(p.nachname, p.vorname)))
    .filter((p) => { const voll = `${p.vorname} ${p.nachname}`.toLowerCase(); return f.every((t) => voll.includes(t)); })
    .sort((x, y) => x.vorname.localeCompare(y.vorname, 'de') || x.nachname.localeCompare(y.nachname, 'de'));
  liste.innerHTML = '';
  if (!treffer.length) {
    const li = document.createElement('li');
    li.className = 'add-leer';
    li.textContent = f.length ? 'Keine passende Person.' : 'Alle Personen stehen schon in der Liste.';
    liste.appendChild(li);
    return;
  }
  for (const p of treffer.slice(0, 100)) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'add-item';
    const name = document.createElement('span');
    name.textContent = `${p.vorname} ${p.nachname}`;
    const abt = document.createElement('span');
    abt.className = 'add-abt';
    abt.textContent = (p.abteilung_ids || []).map((id) => abtName.get(id)).filter(Boolean).join(', ');
    b.append(name, abt);
    b.addEventListener('click', () => personHinzufuegen(p));
    li.appendChild(b);
    liste.appendChild(li);
  }
}

function personHinzufuegen(p) {
  STATE.entries.push({
    nachname: p.nachname, vorname: p.vorname, status: 'anwesend',
    bemerkung: '', tag_ids: new Set(), extra: true,
  });
  sortiereEntries();
  renderPersonen();
  updateSummary();
  renderAddListe();
  toast(`${p.vorname} ${p.nachname} hinzugefügt`);
}

function sortiereEntries() {
  STATE.entries.sort((a, b) =>
    a.vorname.localeCompare(b.vorname, 'de') || a.nachname.localeCompare(b.nachname, 'de'));
}

function bulkSet(mode) {
  const value = mode === 'anwesend' ? 'anwesend' : '';
  const vorher = STATE.entries.map((e) => e.status);
  const angehakt = vorher.filter((st) => st === 'anwesend').length;
  STATE.entries.forEach((e) => (e.status = value));
  renderPersonen();
  updateSummary();
  // "Keine" löscht mit einem Tipp die ganze Erfassung: zurückholbar machen
  if (!value && angehakt) {
    toastRueckgaengig(`${angehakt} Haken entfernt`, () => {
      STATE.entries.forEach((e, i) => { if (vorher[i] !== undefined) e.status = vorher[i]; });
      renderPersonen();
      updateSummary();
    });
  }
}

function updateSummary() {
  const total = STATE.entries.length;
  const a = STATE.entries.filter((e) => e.status === 'anwesend').length;
  const sum = $('#summary-text');
  // Kurzes Anheben der Zahl, wenn sie sich ändert (CSS, nur ohne "Bewegung reduzieren")
  if (sum.dataset.a !== undefined && sum.dataset.a !== String(a)) {
    sum.classList.remove('tick'); void sum.offsetWidth; sum.classList.add('tick');
  }
  sum.dataset.a = String(a);
  sum.textContent = `${a} von ${total} anwesend`;
  // Fortschritt: ein Feld je Person, ab 60 Personen ein durchgehender Balken
  const bar = $('#fortschritt');
  if (total > 0 && total <= 60) {
    bar.className = 'fortschritt segmentiert';
    bar.style.gridTemplateColumns = `repeat(${total}, minmax(0, 1fr))`;
    bar.innerHTML = Array.from({ length: total }, (_, i) => `<i${i < a ? ' class="an"' : ''}></i>`).join('');
  } else {
    bar.className = 'fortschritt';
    bar.style.gridTemplateColumns = '';
    bar.innerHTML = `<i class="an" style="width:${total ? Math.round(a / total * 100) : 0}%"></i>`;
  }
}

// --- Speichern ---

function collect() {
  return {
    datum: $('#datum').value,
    abteilung_id: STATE.abteilungId,
    zeit_von: $('#zeit-von').value,
    zeit_bis: $('#zeit-bis').value,
    dienstart: $('#dienstart').value,
    thema: $('#thema').value,
    ausbilder: $('#ausbilder').value.trim(),
    bemerkung: $('#bemerkung-session').value.trim(),
    entries: STATE.entries.map((e) => ({
      nachname: e.nachname,
      vorname: e.vorname,
      status: e.status,
      bemerkung: e.bemerkung || '',
      tag_ids: e.tag_ids ? [...e.tag_ids] : [],
    })),
  };
}

function resetForm() {
  $('#form-session').reset();
  setDefaultDate();
  // form.reset() setzt auch den Abteilungs-Select zurück — Auswahl halten.
  if (STATE.abteilungId !== null) $('#abteilung').value = String(STATE.abteilungId);
  setDefaultZeiten();
  populateDienstartSelect();
  STATE.entries = STATE.entries.filter((e) => !e.extra);   // hinzugefügte Gäste
  STATE.entries.forEach((e) => {
    e.status = '';
    e.bemerkung = '';
    e.tag_ids = new Set();
  });
  STATE.currentId = null;
  renderPersonen();
  updateSummary();
}

async function save() {
  const data = collect();
  if (!data.datum || !data.dienstart || !data.thema) {
    toast('Bitte Datum, Dienstart und Thema wählen.', 'error');
    return;
  }

  const isUpdate = STATE.currentId != null;
  const url = isUpdate ? '/api/attendance/' + STATE.currentId : '/api/attendance';
  const method = isUpdate ? 'PUT' : 'POST';

  const btn = $('#btn-save');
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (res.status === 401) {
      toast('Sitzung abgelaufen.', 'error');
      showLogin();
      return;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }
    const result = await res.json().catch(() => ({}));
    if (!isUpdate && result.id) {
      STATE.currentId = result.id;
      updateHeaderTitle();
      erfolgZeigen(data);
    } else {
      toast('Gespeichert', 'success');
    }
  } catch (err) {
    toast('Fehler: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
}

// --- Views ---

// Welche Ansicht darf der Benutzer öffnen? Eine Stelle statt mehrerer Listen:
// die Auswertung fehlte für den Abteilungsadmin in der alten Aufzählung, der
// Menüpunkt war sichtbar, der Klick fiel aber stillschweigend auf die
// Erfassung zurück.
function ansichtErlaubt(view) {
  if (view === 'start') return userHatStart();
  if (view === 'atemschutz') return userDarfAtemschutz();
  if (view === 'kleidung') return userDarfKleidung();
  if (['edit', 'history', 'detail'].includes(view)) return userDarfErfassen();
  if (userIsAdmin()) return true;                                  // übergreifend
  if (['stammpersonen', 'themen'].includes(view)) return userDarfVerwalten();
  if (view === 'auswertung' || view === 'auspers') return userDarfAuswerten();
  return false;   // users, tags, abteilungen: nur übergreifender Admin
}

function showView(view) {
  if (STATE.user && !ansichtErlaubt(view)) view = startAnsicht();
  STATE.view = view;
  $('#view-start').classList.toggle('hidden', view !== 'start');
  $('#view-edit').classList.toggle('hidden', view !== 'edit');
  $('#view-history').classList.toggle('hidden', view !== 'history');
  $('#view-detail').classList.toggle('hidden', view !== 'detail');
  $('#view-users').classList.toggle('hidden', view !== 'users');
  $('#view-tags').classList.toggle('hidden', view !== 'tags');
  $('#view-auswertung').classList.toggle('hidden', view !== 'auswertung');
  $('#view-auspers').classList.toggle('hidden', view !== 'auspers');
  $('#view-abteilungen').classList.toggle('hidden', view !== 'abteilungen');
  $('#view-stammpersonen').classList.toggle('hidden', view !== 'stammpersonen');
  $('#view-themen').classList.toggle('hidden', view !== 'themen');
  $('#view-atemschutz').classList.toggle('hidden', view !== 'atemschutz');
  $('#view-kleidung').classList.toggle('hidden', view !== 'kleidung');
  $('#action-edit').classList.toggle('hidden', view !== 'edit');
  $('#action-detail').classList.toggle('hidden', view !== 'detail');
  updateHeaderTitle();
  if (view === 'start') ladeStart();
  if (view === 'history') loadHistory();
  if (view === 'users') loadUsers();
  if (view === 'tags') loadTagsView();
  if (view === 'auswertung') initAuswertung();
  if (view === 'abteilungen') loadAbteilungenView();
  if (view === 'stammpersonen') { loadStammPersonen(); loadPersonenRollenView(); }
  if (view === 'themen') loadThemenView();
  if (view === 'atemschutz') modulLaden('atemschutz').then(() => window.ladeAtemschutz());
  if (view === 'kleidung') modulLaden('kleidung').then(() => window.ladeKleidung());
  if (view !== 'kleidung' && window.kleidungScannerStopp) window.kleidungScannerStopp();
  kopfTitelPruefen();
}

function updateHeaderTitle() {
  const view = STATE.view;
  $('#header-title').textContent =
    view === 'start' ? 'Start'
    : view === 'history' ? 'Verlauf'
    : view === 'detail' ? 'Anwesenheit'
    : view === 'users' ? 'Benutzer'
    : view === 'tags' ? 'Tags'
    : view === 'auswertung' || view === 'auspers' ? 'Auswertung'
    : view === 'abteilungen' ? 'Abteilungen'
    : view === 'stammpersonen' ? 'Personen'
    : view === 'themen' ? 'Themen'
    : view === 'atemschutz' ? 'Atemschutz'
    : view === 'kleidung' ? 'Kleidung'
    : STATE.currentId ? 'Anwesenheit bearbeiten'
    : 'Anwesenheit';
}

// Module (Atemschutz, später Kleidung) liegen in eigenen Dateien und werden
// erst beim ersten Öffnen geladen: die Erfassung am Übungsabend bleibt schlank.
const _module = {};
function modulLaden(name) {
  if (!_module[name]) {
    _module[name] = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = `/${name}.js`;
      el.onload = resolve;
      el.onerror = () => { delete _module[name]; reject(new Error(`Modul ${name} nicht ladbar`)); };
      document.head.appendChild(el);
    });
  }
  return _module[name];
}

// Abteilungsauswahl im Verlauf: "alle" plus jede berechtigte Abteilung.
// Vorauswahl wie in der Erfassung, danach bleibt die Wahl in STATE.histAbt.
function renderHistoryAbteilung() {
  const sel = $('#hist-abteilung');
  const mehrere = STATE.abteilungen.length > 1;
  $('#hist-abteilung-feld').classList.toggle('hidden', !mehrere);
  if (!mehrere) return;   // Wahl offen lassen, falls die Liste noch lädt
  if (STATE.histAbt === undefined) {
    STATE.histAbt = STATE.abteilungId !== null ? String(STATE.abteilungId) : '';
  }
  sel.innerHTML = '<option value="">alle Abteilungen</option>';
  for (const a of STATE.abteilungen) {
    const o = document.createElement('option');
    o.value = String(a.id); o.textContent = a.name;
    sel.appendChild(o);
  }
  sel.value = STATE.histAbt;
  if (sel.value !== STATE.histAbt) { sel.value = ''; STATE.histAbt = ''; }
}

// Liniensymbole im Raster des Design-Systems (24 x 24, Strich 2). Knöpfe mit
// Symbol tragen immer aria-label und title, das SVG ist aria-hidden.
const ICON_PFAD = {
  edit: 'M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3zM13.5 7.5l3 3',
  florix: 'M4 4h16v16H4zM8 12l3 3 5-6',
  kaestchen: 'M4 4h16v16H4z',
  del: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  merge: 'M7 4v4c0 3 5 4 5 7v5M17 4v4c0 3-5 4-5 7M9 17l3 3 3-3',
};
const ICON = Object.fromEntries(Object.entries(ICON_PFAD).map(([k, d]) =>
  [k, `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`]));

function iconBtn(act, label, klasse = '') {
  return `<button type="button" class="icon-btn ${klasse}" data-act="${act}" aria-label="${label}" title="${label}">${ICON[act]}</button>`;
}

const WOCHENTAGE = ['SO', 'MO', 'DI', 'MI', 'DO', 'FR', 'SA'];
function monatsName(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m ? `${MONATE[m - 1]} ${y}` : ym;
}
// Kalenderblatt: Tag groß, Wochentag klein. Datum als UTC lesen, sonst
// verschiebt die Zeitzone den Wochentag.
function datumsKachel(iso) {
  const d = iso ? new Date(iso + 'T00:00:00Z') : null;
  if (!d || isNaN(d)) return '<div class="h-kachel" aria-hidden="true"></div>';
  return `<div class="h-kachel" title="${formatDate(iso)}"><span class="k-tag">${String(d.getUTCDate()).padStart(2, '0')}</span><span class="k-wt">${WOCHENTAGE[d.getUTCDay()]}</span></div>`;
}

// Kennzeichen "in Florix erfasst" (nur Admin und Abteilungsadmin).
function florixKnopf(s) {
  const an = !!s.florix_erfasst_at;
  const label = an ? 'In Florix erfasst, zurücknehmen' : 'Als in Florix erfasst markieren';
  return `<button type="button" class="h-florix${an ? ' an' : ''}" aria-pressed="${an}" aria-label="${label}" title="${label}">${an ? ICON.florix : ICON.kaestchen}</button>`;
}
async function florixSetzen(s, erfasst) {
  try {
    const res = await fetch(`/api/attendance/${s.id}/florix`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ erfasst }),
    });
    if (res.status === 401) { showLogin(); return false; }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'HTTP ' + res.status);
    Object.assign(s, await res.json());
    return true;
  } catch (err) {
    toast('Florix-Status nicht gespeichert: ' + err.message, 'error');
    return false;
  }
}

async function loadHistory() {
  const list = $('#history-list');
  list.innerHTML = '';
  $('#history-empty').classList.add('hidden');
  renderHistoryAbteilung();
  const mitAbteilung = STATE.abteilungen.length > 1;
  if (!mitAbteilung) STATE.histAbt = undefined;
  try {
    const res = await fetch('/api/attendance'
      + (STATE.histAbt ? `?abteilung_id=${STATE.histAbt}` : ''));
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const alle = await res.json();
    const florixSicht = userDarfVerwalten();
    $('#hist-florix').checked = !!STATE.histFlorixOffen;
    const items = florixSicht && STATE.histFlorixOffen ? alle.filter((s) => !s.florix_erfasst_at) : alle;
    seitenkopf('view-history', 'Verlauf', `${items.length} ${items.length === 1 ? 'Termin' : 'Termine'}`
      + (florixSicht && STATE.histFlorixOffen ? ' · Florix offen' : ''));
    if (!items.length && alle.length) {
      leerZustand('#history-empty', {
        icon: 'liste',
        titel: 'Alles in Florix erfasst',
        text: 'Kein Termin wartet mehr auf die Übertragung nach Florix.',
        knopf: 'Alle Termine zeigen',
        aktion: () => { STATE.histFlorixOffen = false; loadHistory(); },
      });
      return;
    }
    if (!items.length) {
      leerZustand('#history-empty', {
        icon: 'liste',
        titel: 'Noch keine Termine',
        text: STATE.histAbt
          ? 'In dieser Abteilung ist noch keine Anwesenheit gespeichert.'
          : 'Gespeicherte Anwesenheiten erscheinen hier, nach Monaten sortiert.',
        knopf: 'Neue Anwesenheit',
        aktion: () => { resetForm(); showView('edit'); },
      });
      return;
    }
    let monat = null;
    for (const s of items) {
      // Zwischenüberschrift je Monat; die Liste kommt nach Datum absteigend
      const m = (s.datum || '').slice(0, 7);
      if (m !== monat) {
        monat = m;
        const anzahl = items.filter((x) => (x.datum || '').startsWith(m)).length;
        const kopf = document.createElement('li');
        kopf.className = 'h-monat';
        kopf.innerHTML = `${escapeHtml(monatsName(m))} <span>${anzahl} ${anzahl === 1 ? 'Termin' : 'Termine'}</span>`;
        list.appendChild(kopf);
      }
      const li = document.createElement('li');
      li.className = 'history-item';
      const max = s.mitglieder_count || 0;
      const quote = max ? Math.min(100, Math.round(s.anwesend_count / max * 100)) : null;
      li.innerHTML = `
        ${datumsKachel(s.datum)}
        <div class="h-main">
          <div class="h-title">${escapeHtml(s.thema)}</div>
          <div class="h-meta">
            ${mitAbteilung && s.abteilung ? `<span class="h-badge h-badge-abt" title="${escapeHtml(s.abteilung)}">${escapeHtml(s.abteilung_kurz || s.abteilung)}</span>` : ''}
            <span>${s.zeit_von ? escapeHtml(s.zeit_von) + ' · ' : ''}${escapeHtml(s.dienstart)}</span>
            ${s.ausbilder ? `<span>${escapeHtml(s.ausbilder)}</span>` : ''}
            ${s.migriert_quelle ? `<span class="h-badge h-badge-migriert" title="Nachgetragen aus: ${escapeHtml(s.migriert_quelle)}">nachgetragen</span>` : ''}
            ${florixSicht && !s.florix_erfasst_at ? '<span class="h-badge h-badge-florix">Florix offen</span>' : ''}
          </div>
          <div class="h-quote" title="${s.anwesend_count} anwesend${max ? ` von ${max} Mitgliedern` : ''}">
            ${quote !== null ? `<span class="h-track"><span style="width:${quote}%"></span></span>` : ''}
            <span>${s.anwesend_count}${max ? ' / ' + max : ' anwesend'}</span>
          </div>
        </div>
        ${florixSicht ? florixKnopf(s) : ''}
        <button class="h-edit" aria-label="Bearbeiten" title="Bearbeiten">${ICON.edit}</button>
      `;
      const onFlorix = async (e) => {
        e.stopPropagation();
        const vorher = !!s.florix_erfasst_at;
        if (!await florixSetzen(s, !vorher)) return;
        if (STATE.histFlorixOffen && !vorher) {
          // Aus der Liste "Florix offen" fällt der Termin heraus
          toastRueckgaengig('In Florix erfasst', async () => { await florixSetzen(s, false); loadHistory(); });
          loadHistory();
          return;
        }
        li.querySelector('.h-florix').outerHTML = florixKnopf(s);
        li.querySelector('.h-florix').addEventListener('click', onFlorix);
        li.querySelector('.h-badge-florix')?.remove();
        if (!s.florix_erfasst_at) li.querySelector('.h-meta').insertAdjacentHTML('beforeend', '<span class="h-badge h-badge-florix">Florix offen</span>');
        toast(s.florix_erfasst_at ? 'In Florix erfasst' : 'Florix wieder offen', 'success');
      };
      li.querySelector('.h-florix')?.addEventListener('click', onFlorix);
      li.querySelector('.h-main').addEventListener('click', () => showDetail(s.id));
      li.querySelector('.h-edit').addEventListener('click', (e) => {
        e.stopPropagation();
        editSession(s.id);
      });
      list.appendChild(li);
    }
  } catch (err) {
    leerZustand('#history-empty', { icon: 'fehler', titel: 'Verlauf nicht abrufbar', text: err.message, knopf: 'Erneut laden', aktion: loadHistory });
  }
}

async function editSession(id) {
  try {
    const res = await fetch('/api/attendance/' + id);
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const s = await res.json();
    loadIntoEditForm(s);
    showView('edit');
  } catch (err) {
    toast('Fehler: ' + err.message, 'error');
  }
}

function loadIntoEditForm(s) {
  $('#datum').value = s.datum || '';
  if (s.abteilung_id && STATE.abteilungen.some((a) => a.id === s.abteilung_id)) {
    STATE.abteilungId = s.abteilung_id;
    $('#abteilung').value = String(s.abteilung_id);
  }
  $('#zeit-von').value = s.zeit_von || '';
  $('#zeit-bis').value = s.zeit_bis || '';
  $('#dienstart').value = s.dienstart || '';
  populateThemaSelect();
  $('#thema').value = s.thema || '';
  $('#ausbilder').value = s.ausbilder || '';
  $('#bemerkung-session').value = s.bemerkung || '';

  STATE.entries = STATE.entries.filter((e) => !e.extra);   // Gäste einer früher geladenen Erfassung
  const savedByKey = new Map();
  for (const e of (s.entries || [])) {
    const key = `${e.vorname.toLowerCase()}|${e.nachname.toLowerCase()}`;
    savedByKey.set(key, e);
  }
  STATE.entries.forEach((e) => {
    const key = `${e.vorname.toLowerCase()}|${e.nachname.toLowerCase()}`;
    const saved = savedByKey.get(key);
    if (saved) {
      e.status = saved.status === 'anwesend' ? 'anwesend' : '';
      e.bemerkung = saved.bemerkung || '';
      e.tag_ids = new Set(saved.tag_ids || []);
    } else {
      e.status = '';
      e.bemerkung = '';
      e.tag_ids = new Set();
    }
  });
  // Gespeicherte Teilnehmer, die nicht in der Liste der Abteilung stehen
  // (hinzugefügte Gäste, inzwischen Ausgetretene), sonst gingen sie beim
  // erneuten Speichern verloren: PUT ersetzt alle Einträge.
  const imListe = new Set(STATE.entries.map((e) => `${e.vorname.toLowerCase()}|${e.nachname.toLowerCase()}`));
  for (const [key, saved] of savedByKey) {
    if (imListe.has(key)) continue;
    STATE.entries.push({
      nachname: saved.nachname, vorname: saved.vorname,
      status: saved.status === 'anwesend' ? 'anwesend' : '',
      bemerkung: saved.bemerkung || '', tag_ids: new Set(saved.tag_ids || []), extra: true,
    });
  }
  sortiereEntries();
  STATE.currentId = s.id;
  renderPersonen();
  updateSummary();
}

async function showDetail(id) {
  STATE.detailId = id;
  showView('detail');
  const content = $('#detail-content');
  content.innerHTML = '<p class="empty">Lade …</p>';
  try {
    const res = await fetch('/api/attendance/' + id);
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const s = await res.json();
    renderDetail(s);
    const fx = $('#btn-detail-florix');
    const fxText = () => {
      fx.textContent = s.florix_erfasst_at ? 'Florix zurücknehmen' : 'In Florix erfasst';
      fx.setAttribute('aria-pressed', String(!!s.florix_erfasst_at));
    };
    fxText();
    fx.onclick = async () => {
      if (!await florixSetzen(s, !s.florix_erfasst_at)) return;
      fxText(); renderDetail(s);
      toast(s.florix_erfasst_at ? 'In Florix erfasst' : 'Florix wieder offen', 'success');
    };
    $('#btn-detail-email').onclick = () => sendEmail(s);
    $('#btn-detail-delete').onclick = () => deleteSession(id);
  } catch (err) {
    content.innerHTML = `<p class="empty">Fehler: ${escapeHtml(err.message)}</p>`;
  }
}

function renderDetail(s) {
  const total = s.entries.length;
  const a = s.entries.filter((e) => e.status === 'anwesend').length;

  const html = `
    <div class="detail-card">
      <h2>${escapeHtml(s.thema)}</h2>
      <div class="d-date">${formatDate(s.datum)}${s.zeit_von ? ` · ${s.zeit_von}${s.zeit_bis ? ' – ' + s.zeit_bis : ''}` : ''}</div>
      <div class="d-meta">
        <div><strong>Dienstart:</strong> ${escapeHtml(s.dienstart)}</div>
        ${s.ausbilder ? `<div><strong>Ausbilder:</strong> ${escapeHtml(s.ausbilder)}</div>` : ''}
        ${s.created_by ? `<div><strong>Erfasst von:</strong> ${escapeHtml(s.created_by)}</div>` : ''}
        ${s.migriert_quelle ? `<div><strong>Nachgetragen aus:</strong> ${escapeHtml(s.migriert_quelle)}</div>` : ''}
        ${userDarfVerwalten() ? `<div><strong>Florix:</strong> ${s.florix_erfasst_at
          ? `erfasst${s.florix_erfasst_by ? ' von ' + escapeHtml(s.florix_erfasst_by) : ''} am ${formatDate(String(s.florix_erfasst_at).slice(0, 10))}`
          : '<span class="d-florix-offen">offen</span>'}</div>` : ''}
        ${s.bemerkung ? `<div><strong>Bemerkung:</strong> ${escapeHtml(s.bemerkung)}</div>` : ''}
        <div class="muted" style="margin-top:6px">
          ${a} von ${total} anwesend
        </div>
      </div>
    </div>
    <ul class="detail-list">
      ${s.entries
        .filter((en) => en.status === 'anwesend')
        .sort((p, q) => p.vorname.localeCompare(q.vorname, 'de'))
        .map((en) => {
          const tagNames = (en.tag_ids || [])
            .map((id) => STATE.tagsById.get(id)?.name)
            .filter(Boolean);
          const extras = [];
          if (tagNames.length) {
            extras.push(
              `<div class="d-extra-tags">${tagNames
                .map((n) => `<span class="d-tag">${escapeHtml(n)}</span>`)
                .join('')}</div>`
            );
          }
          if (en.bemerkung) {
            extras.push(`<div class="d-extra-note">${escapeHtml(en.bemerkung)}</div>`);
          }
          return `
        <li class="detail-entry">
          <div class="d-entry-name">${escapeHtml(en.vorname)} ${escapeHtml(en.nachname)}</div>
          ${extras.join('')}
        </li>`;
        })
        .join('')}
    </ul>
  `;
  $('#detail-content').innerHTML = html;
}

async function deleteSession(id) {
  if (!await bestaetigen('Diese Anwesenheit wirklich löschen?')) return;
  try {
    const res = await fetch('/api/attendance/' + id, { method: 'DELETE' });
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    toast('Gelöscht', 'success');
    showView('history');
  } catch (err) {
    toast('Fehler: ' + err.message, 'error');
  }
}

// --- Benutzerverwaltung ---

async function loadUsers() {
  const list = $('#users-list');
  list.innerHTML = '';
  try {
    const res = await fetch('/api/users');
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const users = await res.json();
    seitenkopf('view-users', 'Benutzer', `${users.length} ${users.length === 1 ? 'Konto' : 'Konten'}`);
    for (const u of users) {
      const li = document.createElement('li');
      li.className = 'user-item';
      const roleLabels = (u.roles || []).map((r) => formatRoleLabel(r)).join(', ') || '—';
      li.innerHTML = `
        <div class="u-info">
          <div class="u-name">${escapeHtml(u.username)}</div>
          <div class="u-role">${escapeHtml(roleLabels)}</div>
        </div>
        <div class="u-actions">
          ${iconBtn('edit', 'Bearbeiten')}
          ${iconBtn('del', 'Löschen', 'icon-danger')}
        </div>
      `;
      li.querySelector('[data-act="edit"]').addEventListener('click', () => openUserDialog(u));
      li.querySelector('[data-act="del"]').addEventListener('click', () => deleteUser(u));
      list.appendChild(li);
    }
  } catch (err) {
    list.innerHTML = `<p class="empty">Fehler: ${escapeHtml(err.message)}</p>`;
  }
}

function openUserDialog(user) {
  const isEdit = user && user.id;
  STATE.editUserId = isEdit ? user.id : null;
  $('#user-dialog-title').textContent = isEdit ? `Benutzer „${user.username}"` : 'Neuer Benutzer';
  $('#user-username').value = isEdit ? user.username : '';
  $('#user-username').disabled = !!isEdit;
  $('#user-password').value = '';
  $('#user-password').placeholder = isEdit ? 'Leer lassen für unverändert' : '';

  const currentRoles = new Set(isEdit ? (user.roles || []) : [APP_ROLE_ERFASSER]);
  $('#user-role-admin').checked          = currentRoles.has(APP_ROLE_ADMIN);
  $('#user-role-abteilungsadmin').checked = currentRoles.has(APP_ROLE_ABTADMIN);
  $('#user-role-erfasser').checked        = currentRoles.has(APP_ROLE_ERFASSER);
  $('#user-role-atemschutz').checked      = currentRoles.has(APP_ROLE_ATEMSCHUTZ);
  $('#user-role-kleidung').checked        = currentRoles.has(APP_ROLE_KLEIDUNG);
  renderAbteilungsAuswahl('#user-abteilungen', 'ua', user?.abteilung_ids || []);

  // Hinweis auf fremde App-Rollen
  const otherRoles = isEdit ? (user.roles || []).filter((r) => !APP_ROLES_SET.has(r)) : [];
  const hint = $('#user-other-roles');
  if (otherRoles.length) {
    hint.textContent = 'Zusätzliche Rollen (nicht hier änderbar): ' + otherRoles.map(formatRoleLabel).join(', ');
    hint.classList.remove('hidden');
  } else {
    hint.classList.add('hidden');
  }

  $('#user-error').classList.add('hidden');
  $('#user-dialog').showModal();
}

async function saveUserDialog() {
  const errEl = $('#user-error');
  errEl.classList.add('hidden');
  const username = $('#user-username').value.trim();
  const password = $('#user-password').value;
  const selectedRoles = [];
  if ($('#user-role-admin').checked)          selectedRoles.push(APP_ROLE_ADMIN);
  if ($('#user-role-abteilungsadmin').checked) selectedRoles.push(APP_ROLE_ABTADMIN);
  if ($('#user-role-erfasser').checked) selectedRoles.push(APP_ROLE_ERFASSER);
  if ($('#user-role-atemschutz').checked) selectedRoles.push(APP_ROLE_ATEMSCHUTZ);
  if ($('#user-role-kleidung').checked) selectedRoles.push(APP_ROLE_KLEIDUNG);

  try {
    if (STATE.editUserId) {
      const body = {};
      if (password) body.password = password;
      body.roles = selectedRoles;
      body.abteilung_ids = gewaehlteAbteilungen('#user-abteilungen');
      const res = await fetch('/api/users/' + STATE.editUserId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      const result = await res.json().catch(() => ({}));
      toast(result.deleted ? 'Benutzer entfernt (keine Rollen mehr)' : 'Benutzer aktualisiert', 'success');
    } else {
      if (!username || !password) {
        errEl.textContent = 'Benutzername und Passwort erforderlich.';
        errEl.classList.remove('hidden');
        return;
      }
      if (!selectedRoles.length) {
        errEl.textContent = 'Mindestens eine Rolle auswählen.';
        errEl.classList.remove('hidden');
        return;
      }
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            username, password, roles: selectedRoles,
            abteilung_ids: gewaehlteAbteilungen('#user-abteilungen'),
          }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      toast('Benutzer angelegt', 'success');
    }
    $('#user-dialog').close('ok');
    loadUsers();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

async function deleteUser(user) {
  if (!await bestaetigen(`Benutzer „${user.username}“ wirklich löschen?`)) return;
  try {
    const res = await fetch('/api/users/' + user.id, { method: 'DELETE' });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `HTTP ${res.status}`);
    }
    toast('Gelöscht', 'success');
    loadUsers();
  } catch (err) {
    toast('Fehler: ' + err.message, 'error');
  }
}

// --- Tags-Verwaltung (Admin) ---

// --- Auswertung ---
// Teilnahmen und Stunden über beide Apps. Gerechnet wird serverseitig in
// functions/_lib/auswertung.js; hier geht es nur um Filter und Darstellung.

const MONATE = ['Januar','Februar','März','April','Mai','Juni',
                'Juli','August','September','Oktober','November','Dezember'];

let auswertungBereit = false;

async function initAuswertung() {
  if (!auswertungBereit) {
    const jahrSel = $('#aus-jahr');
    const jetzt = new Date().getFullYear();
    jahrSel.innerHTML = '';
    for (let j = jetzt; j >= jetzt - 10; j--) {
      const o = document.createElement('option');
      o.value = String(j); o.textContent = String(j);
      jahrSel.appendChild(o);
    }
    // Abteilungen: eine gemischte Auswertung gibt es absichtlich nicht —
    // das Stundensoll unterscheidet sich je Abteilung.
    const abtSel = $('#aus-abteilung');
    abtSel.innerHTML = '';
    for (const a of STATE.abteilungen) {
      const o = document.createElement('option');
      o.value = String(a.id); o.textContent = a.name;
      abtSel.appendChild(o);
    }
    if (STATE.abteilungId !== null) abtSel.value = String(STATE.abteilungId);
    $('#aus-abteilung-feld').classList.toggle('hidden', STATE.abteilungen.length < 2);

    const monatSel = $('#aus-monat');
    monatSel.innerHTML = '<option value="">ganzes Jahr</option>';
    MONATE.forEach((m, i) => {
      const o = document.createElement('option');
      o.value = String(i + 1).padStart(2, '0'); o.textContent = m;
      monatSel.appendChild(o);
    });

    // Personenfilter aus den Stammdaten, inaktive mit Kennzeichnung —
    // man will auch Ausgetretene auswerten können.
    const personSel = $('#aus-person');
    personSel.innerHTML = '<option value="">alle Personen</option>';
    try {
      const abtParam = $('#aus-abteilung').value;
      const res = await fetch('/api/personen?alle=1'
        + (abtParam ? `&abteilung_id=${abtParam}` : ''));
      if (res.ok) {
        for (const p of await res.json()) {
          const o = document.createElement('option');
          o.value = String(p.id);
          o.textContent = `${p.nachname}, ${p.vorname}` + (p.aktiv ? '' : ' (ausgetreten)');
          personSel.appendChild(o);
        }
      }
    } catch {}

    for (const id of ['#aus-abteilung', '#aus-jahr', '#aus-monat', '#aus-person']) {
      $(id).addEventListener('change', ladeAuswertung);
    }
    auswertungBereit = true;
  }
  await ladeAuswertung();
}

function auswertungZeitraum() {
  const jahr = $('#aus-jahr').value;
  const monat = $('#aus-monat').value;
  if (!monat) return { von: `${jahr}-01-01`, bis: `${jahr}-12-31` };
  // Letzter Tag des Monats: Tag 0 des Folgemonats.
  const letzter = new Date(Date.UTC(Number(jahr), Number(monat), 0)).getUTCDate();
  return { von: `${jahr}-${monat}-01`, bis: `${jahr}-${monat}-${String(letzter).padStart(2, '0')}` };
}

// Minuten als h:mm — Dezimalstunden stehen zusätzlich im Export.
function alsStunden(minuten) {
  const h = Math.floor(minuten / 60);
  const m = minuten % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

// Jahres-Soll an Übungsstunden. Grün ab erreicht, Gelb wenn die Hochrechnung
// auf zwölf Monate es erreichen würde, sonst Rot.
// Das Jahres-Soll steht nicht mehr im Code, sondern an der Abteilung
// (abteilungen.uebung_soll_stunden). Die Jugendfeuerwehr hat keines — dann
// entfällt die Ampel, denn Stunden sind dort nicht das Maß.
// Der Wert dient nur als Rückfallebene, falls die Abteilung keines liefert.
const UEBUNG_SOLL_FALLBACK = 30;

// Hochrechnung: erreichte Stunden / verstrichene Monate * 12. Die Monate
// leitet der Server aus dem aktuellen Datum ab (basis.monate_verstrichen),
// nicht aus den erfassten Übungen — sonst verzerren Monate ohne Übungsbetrieb
// das Ergebnis nach oben.
function uebungAmpel(block, monate, soll) {
  if (!soll) return '';                  // kein Soll -> keine Ampel
  const stunden = block.minuten / 60;
  if (stunden >= soll) return 'ampel-gruen';
  if (monate > 0) {
    const hochgerechnet = (stunden / monate) * 12;
    if (hochgerechnet > soll) return 'ampel-kurs';
  }
  return 'ampel-rot';
}

// Die Spalte "Dienst" ist entfernt, die Kategorie existiert in den Stammdaten
// aber weiter (Sitzungen/Tagungen, Versammlungen) und zählt in Gesamt mit.
// Ohne dieses Zusammenfassen wäre Gesamt größer als die Summe der sichtbaren
// Spalten — eine Differenz, die niemand erklären kann.
function dienstUndSonstiges(p) {
  return {
    teilnahmen: p.dienst.teilnahmen + p.sonstiges.teilnahmen,
    minuten:    p.dienst.minuten    + p.sonstiges.minuten,
    ohne_zeit:  p.dienst.ohne_zeit  + p.sonstiges.ohne_zeit,
  };
}

function zelle(block) {
  if (!block.teilnahmen) return '<td>–</td>';
  const luecke = block.ohne_zeit
    ? ` <span class="aus-luecke" title="${block.ohne_zeit} Termin(e) ohne Zeitangabe">+${block.ohne_zeit}</span>`
    : '';
  return `<td>${block.teilnahmen}× · ${alsStunden(block.minuten)}${luecke}</td>`;
}

// Rollen, die keine echte Funktion sind, sondern eine Datenlücke. Sie zählen
// nicht mit, wenn entschieden wird, ob der Durchschnitt aufgeteilt wird.
// "Teilnehmer" = teilgenommen ohne Mitgliedschaft; fließt serverseitig in keinen
// Durchschnitt ein und darf ihn hier auch nicht aufteilen
const KEINE_ECHTE_ROLLE = new Set(['nicht zuordenbar', 'ohne Rolle', 'Teilnehmer']);

// Karten für den Teilnehmerdurchschnitt. Gibt es in der Abteilung mehrere
// echte Rollen (Jugendfeuerwehr: Jugendlicher, Betreuer), steht je Rolle eine
// Karte statt der Gesamtzahl — "wie viele Jugendliche kommen im Schnitt" ist die
// Frage, die dort gestellt wird, nicht "wie viele Personen insgesamt". Mit nur
// einer Rolle (Einsatzabteilung: alle Mitglied) bleibt es bei der einen Zahl.
//
// Karten für Lücken ("ohne Rolle") erscheinen nur, wenn sie etwas zählen, damit
// die Summe der Karten zum Gesamtwert passt und nichts stillschweigend fehlt.
// Die Reihenfolge folgt der Reihenfolge der Rollenliste, nicht der Größe.
function durchschnittsKarten(k, art, gesamt, nachRolle, rollenListe) {
  const eintraege = Object.entries(nachRolle || {});
  const echte = eintraege.filter(([r]) => !KEINE_ECHTE_ROLLE.has(r));
  if (echte.length < 2) return k(gesamt ?? '–', `Teilnehmer je ${art} (Ø)`);

  const reihenfolge = new Map((rollenListe || []).map((r, i) => [r.name, i]));
  const rang = (name) => reihenfolge.has(name) ? reihenfolge.get(name) : 1e6;
  echte.sort((a, b) => rang(a[0]) - rang(b[0]));
  const luecken = eintraege.filter(([r, v]) => KEINE_ECHTE_ROLLE.has(r) && v > 0);
  return [...echte, ...luecken]
    .map(([rolle, wert]) => k(wert, `${escapeHtml(rolle)} je ${art} (Ø)`))
    .join('');
}

async function ladeAuswertung() {
  const tab = $('#aus-tabelle');
  const kz = $('#aus-kennzahlen');
  const hinweis = $('#aus-hinweis');
  tab.innerHTML = '<tbody><tr><td>lädt …</td></tr></tbody>';
  hinweis.classList.add('hidden');

  const { von, bis } = auswertungZeitraum();
  const personId = $('#aus-person').value;
  const abteilungId = $('#aus-abteilung').value;
  const url = `/api/auswertung?von=${von}&bis=${bis}`
    + (abteilungId ? `&abteilung_id=${abteilungId}` : '')
    + (personId ? `&person_id=${personId}` : '');

  let d;
  try {
    const res = await fetch(url);
    if (res.status === 401) { showLogin(); return; }
    d = await res.json();
    if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
  } catch (err) {
    tab.innerHTML = '';
    kz.innerHTML = '';
    hinweis.textContent = 'Fehler: ' + err.message;
    hinweis.classList.remove('hidden');
    return;
  }
  STATE.auswertung = d;
  seitenkopf('view-auswertung', 'Auswertung',
    `${$('#aus-jahr').value}${$('#aus-monat').value ? ' · ' + MONATE[Number($('#aus-monat').value) - 1] : ''} · ${d.basis.uebungen} ${d.basis.uebungen === 1 ? 'Übung' : 'Übungen'}`);

  // Abgeleitete Größen gleich hier, vor allem, was sie benutzt: die Kennzahlen
  // und die Rollen-Box brauchen mitEinsatz, die Tabelle die übrigen. Standen sie
  // früher erst vor der Tabelle, brach die Ansicht mit "Cannot access before
  // initialization" ab — Kennzahlen sichtbar, Tabelle nie.
  const monate = d.basis.monate_verstrichen ?? 0;
  // Soll der ausgewerteten Abteilung. null = keines (Jugendfeuerwehr).
  const soll = d.basis.uebung_soll_stunden ?? null;
  // Einsatzspalte nur für Abteilungen, die am Einsatzdienst teilnehmen.
  const mitEinsatz = d.basis.einsatzdienst !== false;
  // Rollenspalte nur, wenn in dieser Abteilung überhaupt mehr als eine Rolle
  // vorkommt — in der Einsatzabteilung sind alle "Mitglied". Die Zeile
  // "nicht zuordenbar" hat keine Person und damit keine Rolle; sie darf die
  // Spalte nicht erzwingen.
  const mitRollen = new Set(
    d.personen.filter((p) => p.person_id !== null).map((p) => p.rolle || '')
  ).size > 1;
  // Bei Monatsauswahl keine Ampel: aus einem Monat auf zwölf hochzurechnen
  // macht aus einem einzigen Dienstabend 36 Jahresstunden. Die Farben sind
  // für die Jahresbetrachtung gedacht.
  const monatsfilter = !!$('#aus-monat').value;

  const k = (wert, label) =>
    `<div class="aus-kennzahl"><div class="k-wert">${wert}</div><div class="k-label">${label}</div></div>`;
  // Einsatz-Kennzahlen nur für Abteilungen mit Einsatzdienst: bei der
  // Jugendfeuerwehr wären "Teilnehmer je Einsatz" und "Einsätze" immer leer.
  kz.innerHTML =
      durchschnittsKarten(k, 'Übung', d.durchschnitt.personen_pro_uebung,
                          d.durchschnitt.uebung_nach_rolle, STATE.personenRollen)
    + (mitEinsatz
        ? durchschnittsKarten(k, 'Einsatz', d.durchschnitt.personen_pro_einsatz,
                              d.durchschnitt.einsatz_nach_rolle, STATE.personenRollen)
        : '')
    + k(d.basis.uebungen, 'Übungen im Zeitraum')
    + k(d.basis.monate_verstrichen ?? '–', 'Monate verstrichen')
    + (mitEinsatz ? k(d.basis.einsaetze, 'Einsätze im Zeitraum') : '')
    + k(d.basis.aktive_personen, 'aktive Personen')
    + k(d.basis.uebung_soll_stunden ?? '–', 'Stundensoll');

  if (d.nicht_zuordenbar) {
    const namen = d.nicht_zuordenbar_namen
      .map((n) => `${escapeHtml(n.name)} (${n.anzahl}×)`).join(', ');
    hinweis.innerHTML =
      `<strong>${d.nicht_zuordenbar} Eintrag/Einträge ohne Personenzuordnung:</strong> ${namen}. `
      + 'Diese stehen in der Tabelle unter „nicht zuordenbar". Meist sind es alte '
      + 'Schreibweisen — über <em>Personen verwalten</em> ergänzen oder korrigieren.';
    hinweis.classList.remove('hidden');
  }

  if (!d.personen.length) {
    tab.innerHTML = '<tbody><tr><td>Keine Teilnahmen im gewählten Zeitraum.</td></tr></tbody>';
    return;
  }

  const kopf = `<thead><tr>
      <th>Person</th>
      ${mitRollen ? '<th>Rolle</th>' : ''}
      <th${soll ? ` title="Soll: ${soll} h im Jahr"` : ''}>Übung</th>
      <th title="Sitzungen, Versammlungen und sonstige Dienste">Sonstiges</th>
      ${mitEinsatz ? '<th>Einsatz</th>' : ''}<th>Gesamt</th>
    </tr></thead>`;
  const zeilen = d.personen.map((p) => {
    const klassen = [];
    if (p.aktiv === false) klassen.push('ist-inaktiv');
    if (p.person_id === null) klassen.push('ist-offen');
    const stunden = p.uebung.minuten / 60;
    const ampel = monatsfilter ? '' : uebungAmpel(p.uebung, monate, soll);
    const hoch = (!monatsfilter && monate > 0 && soll) ? (stunden / monate) * 12 : null;
    const titel = monatsfilter
      ? `${stunden.toFixed(1)} h in diesem Monat`
      : !soll
        ? `${stunden.toFixed(1)} h — für diese Abteilung ist kein Soll hinterlegt`
        : `${stunden.toFixed(1)} h erreicht`
          + (hoch !== null ? `, hochgerechnet ${hoch.toFixed(1)} h` : '')
          + ` — Soll ${soll} h`;
    return `<tr class="${klassen.join(' ')}">`
      + `<td>${p.person_id !== null
          ? `<button type="button" class="aus-name" data-pid="${p.person_id}" title="Einzelauswertung öffnen">${escapeHtml(p.name)}</button>`
          : escapeHtml(p.name)}${p.gast && !mitRollen ? ' <span class="aus-gast" title="Kein Mitglied dieser Abteilung, zählt in keiner Kennzahl mit">Teilnehmer</span>' : ''}${p.aktiv === false ? ' (ausgetreten)' : ''}</td>`
      + (mitRollen ? `<td>${escapeHtml(p.rolle || '–')}</td>` : '')
      + zelle(p.uebung).replace('<td>', `<td class="${ampel}" title="${escapeHtml(titel)}">`)
      + zelle(dienstUndSonstiges(p))
      + (mitEinsatz ? zelle(p.einsatz) : '')
      + zelle(p.gesamt)
      + '</tr>';
  }).join('');
  tab.innerHTML = kopf + `<tbody>${zeilen}</tbody>`;

  // Legende: ohne sie ist nicht erkennbar, woran die Farben hängen —
  // besonders Gelb, das von der Zahl der bisherigen Übungsmonate abhängt.
  const legende = $('#aus-legende');
  if (monatsfilter) {
    legende.textContent =
      'Keine Soll-Ampel bei Monatsauswahl — eine Hochrechnung aus einem Monat '
      + 'auf das Jahr wäre nicht belastbar. Für Jahr wählen: „ganzes Jahr".';
  } else if (!soll) {
    legende.textContent =
      `Für ${d.basis.abteilung || 'diese Abteilung'} ist kein Stundensoll `
      + 'hinterlegt — daher keine Ampel. Das Soll wird je Abteilung gepflegt.';
  } else legende.innerHTML =
      `<span class="ampel-gruen">■</span> ${soll} h erreicht &nbsp;`
    + `<span class="ampel-kurs">■</span> auf Kurs (hochgerechnet über ${soll} h) &nbsp;`
    + `<span class="ampel-rot">■</span> darunter`
    + (monate > 0
        ? ` &nbsp;·&nbsp; Hochrechnung: Stunden ÷ ${monate} verstrichene${monate === 1 ? 'r' : ''} `
          + `Monat${monate === 1 ? '' : 'e'} × 12`
        : ' &nbsp;·&nbsp; Zeitraum noch nicht begonnen, daher keine Hochrechnung');
}

// --- Einzelauswertung einer Person ---
// Liste aller Termine und Einsätze im gewählten Jahr plus Monatsverlauf.
// Immer das ganze Jahr: ein Monatsfilter würde aus dem Verlauf einen Balken
// machen.
const KAT_INFO = {
  sonstiges: { label: 'Sonstiges', klasse: 'k-sonst' },
  uebung:    { label: 'Übung',     klasse: 'k-uebung' },
  einsatz:   { label: 'Einsatz',   klasse: 'k-einsatz' },
};
const MONATE_KURZ = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

async function oeffnePersonAuswertung(personId) {
  const box = $('#auspers-inhalt');
  box.innerHTML = '<p class="empty">lädt …</p>';
  showView('auspers');
  window.scrollTo(0, 0);
  const jahr = $('#aus-jahr').value;
  const abt = STATE.auswertung?.basis?.abteilung_id ?? $('#aus-abteilung').value;
  let d;
  try {
    const res = await fetch(`/api/auswertung/person?person_id=${personId}&abteilung_id=${abt}`
      + `&von=${jahr}-01-01&bis=${jahr}-12-31`);
    if (res.status === 401) { showLogin(); return; }
    d = await res.json();
    if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
  } catch (err) {
    box.innerHTML = `<p class="empty">Nicht abrufbar: ${escapeHtml(err.message)}</p>`;
    return;
  }
  renderPersonAuswertung(d, Number(jahr));
}

function renderPersonAuswertung(d, jahr) {
  // Alles in eine Liste: Abende nach ihrer Kategorie, Einsätze als eigene.
  // "dienst" (Sitzungen, Versammlungen) zählt wie in der Tabelle zu Sonstiges.
  const eintraege = [
    ...d.termine.map((t) => ({
      datum: t.datum, zeit: [t.zeit_von, t.zeit_bis].filter(Boolean).join('–'),
      titel: t.titel, info: t.dienstart, minuten: t.minuten,
      kat: t.kategorie === 'uebung' ? 'uebung' : 'sonstiges',
    })),
    ...d.einsaetze.map((e) => ({
      datum: e.datum, zeit: e.uhrzeit, titel: e.titel,
      info: [e.fahrzeuge.join(', '), e.pa_minuten !== null ? `PA ${e.pa_minuten} min` : ''].filter(Boolean).join(' · '),
      minuten: e.minuten, kat: 'einsatz',
    })),
  ].sort((a, b) => (b.datum + b.zeit).localeCompare(a.datum + a.zeit));

  // Monatswerte
  const monate = Array.from({ length: 12 }, () => ({ sonstiges: 0, uebung: 0, einsatz: 0 }));
  for (const e of eintraege) {
    const m = Number(e.datum.slice(5, 7)) - 1;
    if (m >= 0 && m < 12) monate[m][e.kat]++;
  }
  const max = Math.max(1, ...monate.map((m) => m.sonstiges + m.uebung + m.einsatz));
  const heute = new Date();
  const zukunftAb = jahr === heute.getFullYear() ? heute.getMonth() + 1 : (jahr > heute.getFullYear() ? 0 : 12);
  const angeboten = d.uebungen_angeboten || {};
  const anzahl = (k) => eintraege.filter((e) => e.kat === k).length;
  const minuten = eintraege.reduce((s, e) => s + (e.minuten || 0), 0);
  const uebAngebot = Object.values(angeboten).reduce((s, n) => s + n, 0);
  const kats = d.abteilung.einsatzdienst ? ['sonstiges', 'uebung', 'einsatz'] : ['sonstiges', 'uebung'];
  STATE.ausPers = { d, jahr, eintraege, monate, kats, angeboten, uebAngebot, minuten };

  const k = (wert, label) =>
    `<div class="aus-kennzahl"><div class="k-wert">${wert}</div><div class="k-label">${label}</div></div>`;

  const balken = monate.map((m, i) => {
    const summe = kats.reduce((s, kat) => s + m[kat], 0);
    const ym = `${jahr}-${String(i + 1).padStart(2, '0')}`;
    const ang = angeboten[ym] || 0;
    const tip = `${MONATE[i]}: ${summe} ${summe === 1 ? 'Termin' : 'Termine'}`
      + kats.filter((kat) => m[kat]).map((kat) => ` · ${KAT_INFO[kat].label} ${m[kat]}`).join('')
      + (ang ? ` · ${m.uebung} von ${ang} Übungen` : '');
    const segmente = kats.filter((kat) => m[kat]).map((kat) =>
      `<span class="seg-${kat} ${KAT_INFO[kat].klasse}" style="flex-grow:${m[kat]}"></span>`).join('');
    return `<div class="mv-spalte${i >= zukunftAb ? ' mv-zukunft' : ''}" title="${escapeHtml(tip)}">
        <span class="mv-wert">${summe || ''}</span>
        <div class="mv-balken" style="height:${(summe / max) * 100}%">${segmente}</div>
        <span class="mv-monat">${MONATE_KURZ[i]}</span>
        <span class="mv-quote">${ang ? `${m.uebung}/${ang}` : ''}</span>
      </div>`;
  }).join('');

  let monat = null;
  const liste = eintraege.map((e) => {
    let kopf = '';
    const m = e.datum.slice(0, 7);
    if (m !== monat) {
      monat = m;
      const n = eintraege.filter((x) => x.datum.startsWith(m)).length;
      kopf = `<li class="h-monat">${escapeHtml(monatsName(m))} <span>${n} ${n === 1 ? 'Termin' : 'Termine'}</span></li>`;
    }
    return kopf + `<li class="history-item ap-eintrag">
        ${datumsKachel(e.datum)}
        <div class="h-main">
          <div class="h-title">${escapeHtml(e.titel || '–')}</div>
          <div class="h-meta">
            <span class="h-badge ap-kat ${KAT_INFO[e.kat].klasse}">${KAT_INFO[e.kat].label}</span>
            <span>${escapeHtml(e.zeit || '')}${e.info ? ' · ' + escapeHtml(e.info) : ''}</span>
            <span>${e.minuten !== null && e.minuten !== undefined ? alsStunden(e.minuten) : 'ohne Zeit'}</span>
          </div>
        </div>
      </li>`;
  }).join('');

  $('#auspers-inhalt').innerHTML = `
    <div class="detail-card">
      <h2>${escapeHtml(d.person.name)}</h2>
      <div class="d-date">${escapeHtml([d.person.rolle, d.abteilung.name, String(jahr)].filter(Boolean).join(' · '))}${d.person.aktiv ? '' : ' · ausgetreten'}</div>
      <button type="button" class="btn-secondary ap-pdf" id="btn-ap-pdf">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 20h14"/></svg> PDF-Export
      </button>
      <div class="aus-kennzahlen">
        ${k(eintraege.length, 'Teilnahmen')}
        ${k(alsStunden(minuten), 'Stunden')}
        ${k(uebAngebot ? `${anzahl('uebung')}/${uebAngebot}` : anzahl('uebung'), uebAngebot ? `Übungen (${Math.round(anzahl('uebung') / uebAngebot * 100)} %)` : 'Übungen')}
        ${d.abteilung.einsatzdienst ? k(anzahl('einsatz'), 'Einsätze') : ''}
      </div>
    </div>
    <div class="detail-card">
      <h3 class="ap-titel">Teilnahmen je Monat</h3>
      <div class="mv-legende">
        ${kats.slice().reverse().map((kat) => `<span><i class="${KAT_INFO[kat].klasse}"></i>${KAT_INFO[kat].label}</span>`).join('')}
        <span class="muted">Zahl unten: besuchte von angebotenen Übungen</span>
      </div>
      <div class="monatsverlauf" role="img" aria-label="Teilnahmen je Monat ${jahr}: ${monate.map((m, i) => `${MONATE[i]} ${kats.reduce((s, kat) => s + m[kat], 0)}`).join(', ')}">${balken}</div>
    </div>
    ${eintraege.length
      ? `<ul class="history-list ap-liste">${liste}</ul>`
      : '<p class="empty">Keine Teilnahmen in diesem Jahr.</p>'}
  `;
  $('#btn-ap-pdf').addEventListener('click', berichtsmappe);
}

// --- Berichtsmappe als PDF ---
// Persönliche Mappe für eine Person: Deckblatt mit Kennzahlen und
// Monatsverlauf, Monatsübersicht, danach jeder Termin. jsPDF wird erst beim
// Klick geladen (wie SheetJS für den Excel-Export).
const JSPDF_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js',
];
let _jspdfPromise = null;
// Datei an den Nutzer geben. In der installierten App (Startbildschirm) gehen
// Downloads und window.print() unter iOS ins Leere — dort das Teilen-Menü
// öffnen (Drucken, In Dateien sichern), sonst normal herunterladen.
async function dateiAusgeben(blob, datei) {
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const file = new File([blob], datei, { type: blob.type });
  if (standalone && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: datei }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: datei });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function pdfAusgeben(doc, datei) { return dateiAusgeben(doc.output('blob'), datei); }
function xlsxAusgeben(wb, datei) {
  const daten = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return dateiAusgeben(new Blob([daten], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), datei);
}

function loadJsPdf() {
  if (window.jspdf?.jsPDF?.API?.autoTable) return Promise.resolve(window.jspdf.jsPDF);
  if (_jspdfPromise) return _jspdfPromise;
  const lade = (src) => new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error('PDF-Bibliothek konnte nicht geladen werden'));
    document.head.appendChild(el);
  });
  _jspdfPromise = lade(JSPDF_URLS[0]).then(() => lade(JSPDF_URLS[1]))
    .then(() => window.jspdf.jsPDF)
    .catch((e) => { _jspdfPromise = null; throw e; });
  return _jspdfPromise;
}

// Druckfarben (heller Satz, fest: ein PDF hat kein Dunkel)
const PDF_FARBE = {
  text: [27, 22, 19], muted: [98, 90, 83], linie: [214, 210, 205], flaeche: [243, 241, 239],
  rot: [196, 32, 26], weiss: [255, 255, 255], lime: [198, 255, 0],
  sonstiges: [176, 116, 0], uebung: [29, 78, 216], einsatz: [196, 32, 26],
};

async function berichtsmappe() {
  const a = STATE.ausPers;
  if (!a) return;
  const btn = $('#btn-ap-pdf');
  btn.disabled = true;
  let jsPDF;
  try { jsPDF = await loadJsPdf(); }
  catch (err) { btn.disabled = false; hinweis('PDF-Export nicht möglich\n\n' + err.message); return; }
  try {
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const F = PDF_FARBE;
    const B = 210, RAND = 16;
    const { d, jahr, eintraege, monate, kats, angeboten, uebAngebot, minuten } = a;
    const anz = (k) => eintraege.filter((e) => e.kat === k).length;

    // Warnstreifen Lime/Rot oben, wie in der App
    doc.setFillColor(...F.rot); doc.rect(0, 0, B, 7, 'F');
    doc.setFillColor(...F.lime);
    for (let x = -10; x < B + 10; x += 9) doc.lines([[4.5, 0], [7, -7], [-4.5, 0]], x, 7, [1, 1], 'F', true);

    doc.setTextColor(...F.rot); doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
    doc.text('BERICHTSMAPPE ' + jahr, RAND, 22, { charSpace: 0.8 });
    doc.setTextColor(...F.text); doc.setFontSize(26);
    doc.text(d.person.name, RAND, 34);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(...F.muted);
    doc.text([d.person.rolle, d.abteilung.name, 'Freiwillige Feuerwehr Musterwehr'].filter(Boolean).join(' · ')
      + (d.person.aktiv ? '' : ' · ausgetreten'), RAND, 42);

    // Kennzahlen
    const karten = [
      [String(eintraege.length), 'Teilnahmen'],
      [alsStunden(minuten), 'Stunden'],
      [uebAngebot ? `${anz('uebung')}/${uebAngebot}` : String(anz('uebung')),
        uebAngebot ? `Übungen (${Math.round(anz('uebung') / uebAngebot * 100)} %)` : 'Übungen'],
    ];
    if (d.abteilung.einsatzdienst) karten.push([String(anz('einsatz')), 'Einsätze']);
    const kb = (B - 2 * RAND - (karten.length - 1) * 4) / karten.length;
    karten.forEach(([wert, label], i) => {
      const x = RAND + i * (kb + 4);
      doc.setFillColor(...F.flaeche); doc.setDrawColor(...F.linie); doc.rect(x, 52, kb, 24, 'FD');
      doc.setTextColor(...F.text); doc.setFont('helvetica', 'bold'); doc.setFontSize(20);
      doc.text(wert, x + 4, 64);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...F.muted);
      doc.text(label, x + 4, 71);
    });

    // Monatsverlauf
    let y = 90;
    doc.setTextColor(...F.text); doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
    doc.text('TEILNAHMEN JE MONAT', RAND, y, { charSpace: 0.5 });
    let lx = RAND;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    for (const k of kats.slice().reverse()) {
      doc.setFillColor(...F[k]); doc.rect(lx, y + 4, 3.5, 3.5, 'F');
      doc.setTextColor(...F.text); doc.text(KAT_INFO[k].label, lx + 5, y + 7);
      lx += 6 + doc.getTextWidth(KAT_INFO[k].label) + 6;
    }
    const top = y + 14, hoehe = 52, basis = top + hoehe;
    const breite = (B - 2 * RAND) / 12;
    const max = Math.max(1, ...monate.map((m) => kats.reduce((s, k) => s + m[k], 0)));
    doc.setDrawColor(...F.linie);
    for (let t = 1; t <= 3; t++) {   // leise Hilfslinien
      const gy = basis - (hoehe * t) / 3;
      doc.setLineWidth(0.1); doc.line(RAND, gy, B - RAND, gy);
    }
    monate.forEach((m, i) => {
      const x = RAND + i * breite + breite * 0.18, w = breite * 0.64;
      let yy = basis;
      const summe = kats.reduce((s, k) => s + m[k], 0);
      for (const k of kats) {
        if (!m[k]) continue;
        const h = (m[k] / max) * hoehe;
        doc.setFillColor(...F[k]); doc.rect(x, yy - h, w, h - 0.5, 'F');
        yy -= h;
      }
      doc.setFontSize(8.5); doc.setTextColor(...F.text); doc.setFont('helvetica', 'bold');
      if (summe) doc.text(String(summe), x + w / 2, yy - 1.5, { align: 'center' });
      doc.setFont('helvetica', 'normal'); doc.setTextColor(...F.muted);
      doc.text(MONATE_KURZ[i], x + w / 2, basis + 5, { align: 'center' });
      const ang = angeboten[`${jahr}-${String(i + 1).padStart(2, '0')}`];
      if (ang) doc.text(`${m.uebung}/${ang}`, x + w / 2, basis + 9.5, { align: 'center' });
    });
    doc.setDrawColor(...F.muted); doc.setLineWidth(0.3); doc.line(RAND, basis, B - RAND, basis);
    doc.setFontSize(8); doc.setTextColor(...F.muted);
    doc.text('Zahl unter dem Monat: besuchte von angebotenen Übungen', RAND, basis + 15);

    // Monatsübersicht
    const minMonat = Array(12).fill(0);
    for (const e of eintraege) minMonat[Number(e.datum.slice(5, 7)) - 1] += e.minuten || 0;
    const kopf = ['Monat', ...kats.map((k) => KAT_INFO[k].label), 'Gesamt', 'Stunden', 'Übungen besucht'];
    const zeilen = monate.map((m, i) => {
      const ang = angeboten[`${jahr}-${String(i + 1).padStart(2, '0')}`];
      return [MONATE[i], ...kats.map((k) => m[k] || '–'), kats.reduce((s, k) => s + m[k], 0) || '–',
        minMonat[i] ? alsStunden(minMonat[i]) : '–', ang ? `${m.uebung} von ${ang}` : '–'];
    });
    const tabStil = {
      theme: 'grid', margin: { left: RAND, right: RAND, bottom: 18 },
      styles: { font: 'helvetica', fontSize: 9, cellPadding: 1.8, textColor: F.text, lineColor: F.linie, lineWidth: 0.1 },
      headStyles: { fillColor: F.flaeche, textColor: F.text, fontStyle: 'bold' },
    };
    doc.autoTable({ ...tabStil, startY: basis + 22, head: [kopf], body: zeilen,
      columnStyles: Object.fromEntries(kopf.map((_, i) => [i, { halign: i ? 'right' : 'left' }])) });

    // Alle Termine, chronologisch
    doc.addPage();
    doc.setTextColor(...F.text); doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
    doc.text('ALLE TERMINE UND EINSÄTZE ' + jahr, RAND, 20, { charSpace: 0.5 });
    const liste = eintraege.slice().reverse().map((e) => [
      formatDate(e.datum), e.zeit || '', KAT_INFO[e.kat].label, e.titel || '–', e.info || '',
      e.minuten !== null && e.minuten !== undefined ? alsStunden(e.minuten) : 'ohne Zeit',
    ]);
    doc.autoTable({ ...tabStil, startY: 25,
      head: [['Datum', 'Zeit', 'Art', 'Thema / Einsatz', 'Details', 'Stunden']],
      body: liste.length ? liste : [['–', '', '', 'Keine Teilnahmen in diesem Jahr', '', '']],
      columnStyles: { 0: { cellWidth: 21 }, 1: { cellWidth: 21 }, 2: { cellWidth: 20 }, 5: { halign: 'right', cellWidth: 17 } },
      didParseCell: (c) => {
        if (c.section === 'body' && c.column.index === 2) {
          const k = Object.keys(KAT_INFO).find((x) => KAT_INFO[x].label === c.cell.raw);
          if (k) { c.cell.styles.textColor = F[k]; c.cell.styles.fontStyle = 'bold'; }
        }
      },
    });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...F.muted);
    doc.text(`Summe: ${eintraege.length} Teilnahmen · ${alsStunden(minuten)} Stunden`, RAND, doc.lastAutoTable.finalY + 7);

    // Fußzeile auf jeder Seite
    const seiten = doc.internal.getNumberOfPages();
    const heute = formatDate(new Date().toISOString().slice(0, 10));
    for (let i = 1; i <= seiten; i++) {
      doc.setPage(i);
      doc.setDrawColor(...F.linie); doc.setLineWidth(0.2); doc.line(RAND, 284, B - RAND, 284);
      doc.setFontSize(8); doc.setTextColor(...F.muted);
      doc.text(`Berichtsmappe ${d.person.name} · ${jahr}`, RAND, 289);
      doc.text(`erstellt am ${heute}`, B / 2, 289, { align: 'center' });
      doc.text(`Seite ${i} von ${seiten}`, B - RAND, 289, { align: 'right' });
    }
    const datei = `Berichtsmappe_${d.person.name.replace(/,\s*/, '_').replace(/[^\wäöüÄÖÜß-]+/g, '_')}_${jahr}.pdf`;
    await pdfAusgeben(doc, datei);
  } catch (err) {
    hinweis('PDF-Export fehlgeschlagen\n\n' + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function exportAuswertung() {
  const d = STATE.auswertung;
  if (!d) return;
  try {
    const XLSX = await loadSheetJs();
    const rows = d.personen.map((p) => {
      const r = { Person: p.name, Status: p.aktiv === false ? 'ausgetreten' : (p.person_id === null ? 'nicht zuordenbar' : 'aktiv') };
      // Dieselben Spalten wie in der Anzeige, inklusive der Zusammenfassung.
      const bloecke = [['Übung', p.uebung], ['Sonstiges', dienstUndSonstiges(p)],
                       ['Einsatz', p.einsatz], ['Gesamt', p.gesamt]];
      for (const [label, block] of bloecke) {
        r[`${label} Teilnahmen`] = block.teilnahmen;
        // Dezimalstunden, damit in Excel gerechnet werden kann.
        r[`${label} Stunden`] = Math.round((block.minuten / 60) * 100) / 100;
        r[`${label} ohne Zeit`] = block.ohne_zeit;
      }
      return r;
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Auswertung');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{
      Von: d.zeitraum.von, Bis: d.zeitraum.bis,
      'Übungen': d.basis.uebungen, 'Einsätze': d.basis.einsaetze,
      'aktive Personen': d.basis.aktive_personen,
      'Teilnehmer je Übung': d.durchschnitt.personen_pro_uebung ?? '',
      'Teilnehmer je Einsatz': d.durchschnitt.personen_pro_einsatz ?? '',
      'Einträge ohne Zuordnung': d.nicht_zuordenbar,
    }]), 'Zeitraum');
    await xlsxAusgeben(wb, `Auswertung_${d.zeitraum.von}_${d.zeitraum.bis}.xlsx`);
  } catch (err) {
    hinweis('Export fehlgeschlagen: ' + err.message);
  }
}

// --- Abteilungsverwaltung ---
// Nur für den übergreifenden Admin: ein Abteilungsadmin könnte sich hier
// sonst sein eigenes Stundensoll setzen oder den Einsatzdienst zuschalten.
// Zeigt immer ALLE Abteilungen, auch die, in denen der Admin nicht
// eingetragen ist — dafür liefert /api/abteilungen das Feld `alle`.

async function ladeAlleAbteilungen() {
  const res = await fetch('/api/abteilungen');
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'HTTP ' + res.status);
  const d = await res.json();
  return d.alle || d.abteilungen || [];
}

async function loadAbteilungenView() {
  const list = $('#abteilungen-list');
  list.innerHTML = '';
  try {
    STATE.alleAbteilungen = await ladeAlleAbteilungen();
    if (!STATE.alleAbteilungen.length) {
      list.innerHTML = '<p class="empty">Keine Abteilungen angelegt.</p>';
      return;
    }
    for (const a of STATE.alleAbteilungen) {
      const li = document.createElement('li');
      li.className = 'user-item';
      const zeiten = (a.standard_zeit_von && a.standard_zeit_bis)
        ? `${a.standard_zeit_von}–${a.standard_zeit_bis}` : 'keine Vorbelegung';
      const soll = a.uebung_soll_stunden != null ? `${a.uebung_soll_stunden} h Soll` : 'kein Soll';
      li.innerHTML = `
        <div class="u-info">
          <div class="u-name">${escapeHtml(a.name)}${a.kurz ? ` (${escapeHtml(a.kurz)})` : ''}</div>
          <div class="u-role">${escapeHtml(zeiten)} · ${escapeHtml(soll)}
            · ${a.einsatzdienst ? 'Einsatzdienst' : 'kein Einsatzdienst'}
            · #${a.sort_order}</div>
        </div>
        <div class="u-actions">
          ${iconBtn('edit', 'Bearbeiten')}
          ${iconBtn('del', 'Löschen', 'icon-danger')}
        </div>
      `;
      li.querySelector('[data-act="edit"]').addEventListener('click', () => openAbteilungDialog(a));
      li.querySelector('[data-act="del"]').addEventListener('click', () => deleteAbteilung(a));
      list.appendChild(li);
    }
  } catch (err) {
    list.innerHTML = `<p class="empty">Fehler: ${escapeHtml(err.message)}</p>`;
  }
}

function openAbteilungDialog(a) {
  const isEdit = !!(a && a.id);
  STATE.editAbteilungId = isEdit ? a.id : null;
  $('#abt-dialog-title').textContent = isEdit ? `Abteilung „${a.name}"` : 'Neue Abteilung';
  $('#abt-name').value = isEdit ? a.name : '';
  $('#abt-kurz').value = isEdit ? (a.kurz || '') : '';
  $('#abt-von').value  = isEdit ? (a.standard_zeit_von || '') : '';
  $('#abt-bis').value  = isEdit ? (a.standard_zeit_bis || '') : '';
  $('#abt-soll').value = isEdit && a.uebung_soll_stunden != null ? a.uebung_soll_stunden : '';
  $('#abt-sort').value = isEdit ? a.sort_order : 100;
  $('#abt-einsatzdienst').value = isEdit ? String(a.einsatzdienst ? 1 : 0) : '0';
  $('#abt-error').classList.add('hidden');
  $('#abt-dialog').showModal();
}

async function saveAbteilung() {
  const errEl = $('#abt-error'); errEl.classList.add('hidden');
  const soll = $('#abt-soll').value.trim();
  const payload = {
    name: $('#abt-name').value.trim(),
    kurz: $('#abt-kurz').value.trim() || null,
    standard_zeit_von: $('#abt-von').value || null,
    standard_zeit_bis: $('#abt-bis').value || null,
    // Leer heißt ausdrücklich "kein Soll" — nicht null-gleich-null-Stunden.
    uebung_soll_stunden: soll === '' ? null : Number(soll),
    einsatzdienst: $('#abt-einsatzdienst').value === '1',
    sort_order: Number($('#abt-sort').value) || 100,
  };
  const id = STATE.editAbteilungId;
  try {
    const res = await fetch(id ? '/api/abteilungen/' + id : '/api/abteilungen', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
    $('#abt-dialog').close();
    await loadAbteilungenView();
    // Umschalter, Zeiten und Auswertungsfilter hängen daran.
    await loadStaticData();
    toast('Abteilung gespeichert', 'success');
  } catch (err) {
    errEl.textContent = err.message; errEl.classList.remove('hidden');
  }
}

async function deleteAbteilung(a) {
  if (!await bestaetigen(`Abteilung „${a.name}" löschen?`)) return;
  try {
    const res = await fetch('/api/abteilungen/' + a.id, { method: 'DELETE' });
    const d = await res.json().catch(() => ({}));
    if (res.status === 409) {
      // Benennen, was daran hängt — eine FK-Meldung sagt das nicht.
      const v = d.verwendung || {};
      const teile = [
        [v.personen, 'Personen'], [v.themen, 'Themen'],
        [v.dienstarten, 'Dienstarten'], [v.termine, 'Termine'],
        [v.benutzer, 'Benutzer'],
      ].filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`);
      hinweis(`${d.error}\n\nNoch zugeordnet: ${teile.join(', ') || 'unbekannt'}`);
      return;
    }
    if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
    await loadAbteilungenView();
    await loadStaticData();
    toast('Abteilung gelöscht', 'success');
  } catch (err) { hinweis('Fehler: ' + err.message); }
}

// --- Verwaltungsansichten: Reiter, Abteilungsauswahl, Suche ---
// Mit 50 Personen und 130 Themen in zwei Abteilungen war die flache Liste nicht
// mehr zu überblicken. Jetzt: Unterseiten per Reiter für das, was fachlich
// getrennt ist (Personen | Rollen, Themen | Dienstarten), darüber ein
// Abteilungsauswahl- und Suchfeld, und Themen nach Dienstart gruppiert.

// Suchtext falten: "schütz" findet "Schütz", "schuetz" ebenfalls.
function sucheFalten(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '');
}
// Alle Suchwörter müssen vorkommen, in beliebiger Reihenfolge: "jutta wart".
function trifftSuche(text, suche) {
  const t = sucheFalten(suche);
  if (!t) return true;
  const heu = sucheFalten(text);
  return t.split(/\s+/).every((w) => heu.includes(w));
}

function filterPersonen(personen, { abteilungId, suche, mitInaktiven }) {
  return personen.filter((p) => {
    if (!mitInaktiven && !p.aktiv) return false;
    if (abteilungId != null && !(p.abteilung_ids || []).includes(abteilungId)) return false;
    return trifftSuche(`${p.nachname} ${p.vorname}`, suche);
  });
}

// Themen nach Dienstart gruppieren, Reihenfolge wie vom Server geliefert.
// Die Suche schließt den Dienstart-Namen ein: "Zeltlager" zeigt die ganze Gruppe.
function gruppiereThemen(themen, { suche, mitInaktiven }) {
  const gruppen = new Map();
  for (const t of themen) {
    if (!mitInaktiven && !t.aktiv) continue;
    if (!trifftSuche(`${t.thema} ${t.dienstart}`, suche)) continue;
    if (!gruppen.has(t.dienstart)) {
      gruppen.set(t.dienstart, { name: t.dienstart, kategorie: t.kategorie, themen: [] });
    }
    gruppen.get(t.dienstart).themen.push(t);
  }
  return [...gruppen.values()];
}

// Dienstarten, die für die gewählte Abteilung gelten: globale (NULL) und eigene.
function dienstartenFuer(dienstarten, abteilungId) {
  return dienstarten.filter((d) =>
    abteilungId == null || d.abteilung_id == null || d.abteilung_id === abteilungId);
}

function setzeVwAbt(wert) {
  STATE.vwAbt = wert === '' || wert == null ? null : Number(wert);
}

// Abteilungsauswahl füllen. "Alle Abteilungen" nur für den übergreifenden
// Admin — ein Abteilungsadmin soll fremde Abteilungen gar nicht erst sehen.
function fuelleVerwaltungsAbteilung(selectId, feldId) {
  if (STATE.vwAbt === undefined) STATE.vwAbt = STATE.abteilungId;   // Vorauswahl wie in der Erfassung
  const sel = $(selectId);
  sel.innerHTML = '';
  if (STATE.uebergreifend) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = 'Alle Abteilungen';
    sel.appendChild(o);
  }
  for (const a of STATE.abteilungen) {
    const o = document.createElement('option');
    o.value = String(a.id); o.textContent = a.name;
    sel.appendChild(o);
  }
  const gewollt = STATE.vwAbt == null ? '' : String(STATE.vwAbt);
  if ([...sel.options].some((o) => o.value === gewollt)) sel.value = gewollt;
  else { sel.selectedIndex = 0; setzeVwAbt(sel.value); }
  // Bei nur einer Möglichkeit wäre die Auswahl bloß Ballast.
  $(feldId).classList.toggle('hidden', sel.options.length < 2);
}

function zeigeReiter(viewSelector, name) {
  const view = $(viewSelector);
  for (const t of view.querySelectorAll('.reiter-tab')) {
    t.classList.toggle('aktiv', t.dataset.reiter === name);
  }
  for (const pnl of view.querySelectorAll('[data-panel]')) {
    pnl.classList.toggle('hidden', pnl.dataset.panel !== name);
  }
}
function initReiter(viewSelector) {
  for (const t of $(viewSelector).querySelectorAll('.reiter-tab')) {
    t.addEventListener('click', () => zeigeReiter(viewSelector, t.dataset.reiter));
  }
}

// --- Personen-Rollen ---
// Anlegen und Ändern nur für den übergreifenden Admin: die Liste gilt für
// alle Abteilungen, ein Abteilungsadmin würde damit in fremde hineinwirken.

async function loadPersonenRollenView() {
  const list = $('#prollen-list');
  list.innerHTML = '';
  try {
    const res = await fetch('/api/personen-rollen');
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'HTTP ' + res.status);
    const rollen = await res.json();
    STATE.personenRollen = rollen;
    if (!rollen.length) {
      list.innerHTML = '<p class="empty">Keine Rollen angelegt.</p>';
      return;
    }
    for (const r of rollen) {
      const li = document.createElement('li');
      li.className = 'user-item';
      li.innerHTML = `
        <div class="u-info">
          <div class="u-name">${escapeHtml(r.name)}</div>
          <div class="u-role">${r.zuordnungen} Zuordnung${r.zuordnungen === 1 ? '' : 'en'} · #${r.sort_order}</div>
        </div>
        <div class="u-actions admin-only">
          ${iconBtn('edit', 'Bearbeiten')}
          ${iconBtn('del', 'Löschen', 'icon-danger')}
        </div>
      `;
      li.querySelector('[data-act="edit"]').addEventListener('click', () => openPersonenRolleDialog(r));
      li.querySelector('[data-act="del"]').addEventListener('click', () => deletePersonenRolle(r));
      list.appendChild(li);
    }
  } catch (err) {
    list.innerHTML = `<p class="empty">Fehler: ${escapeHtml(err.message)}</p>`;
  }
}

function openPersonenRolleDialog(r) {
  const isEdit = !!(r && r.id);
  STATE.editPRolleId = isEdit ? r.id : null;
  $('#prolle-dialog-title').textContent = isEdit ? `Rolle „${r.name}"` : 'Neue Rolle';
  $('#prolle-name').value = isEdit ? r.name : '';
  $('#prolle-sort').value = isEdit ? r.sort_order : 100;
  $('#prolle-error').classList.add('hidden');
  $('#prolle-dialog').showModal();
}

async function savePersonenRolle() {
  const errEl = $('#prolle-error'); errEl.classList.add('hidden');
  const payload = {
    name: $('#prolle-name').value.trim(),
    sort_order: Number($('#prolle-sort').value) || 100,
  };
  const id = STATE.editPRolleId;
  try {
    const res = await fetch(id ? '/api/personen-rollen/' + id : '/api/personen-rollen', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
    $('#prolle-dialog').close();
    await loadPersonenRollenView();
    await loadStammPersonen();
    toast('Rolle gespeichert', 'success');
  } catch (err) {
    errEl.textContent = err.message; errEl.classList.remove('hidden');
  }
}

async function deletePersonenRolle(r) {
  // Die Zuordnungen bleiben erhalten (ON DELETE SET NULL), verlieren aber die
  // Rolle — und tauchen in der Auswertung dann unter "ohne Rolle" auf.
  const warnung = r.zuordnungen
    ? `\n\n${r.zuordnungen} Zuordnung${r.zuordnungen === 1 ? '' : 'en'} verlieren dabei ihre Rolle `
      + 'und erscheinen in der Auswertung unter „ohne Rolle".'
    : '';
  if (!await bestaetigen(`Rolle „${r.name}" löschen?${warnung}`)) return;
  try {
    const res = await fetch('/api/personen-rollen/' + r.id, { method: 'DELETE' });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
    await loadPersonenRollenView();
    await loadStammPersonen();
    toast('Rolle gelöscht', 'success');
  } catch (err) { hinweis('Fehler: ' + err.message); }
}

// --- Stammdaten: Personen ---
// Gilt für beide Apps: die Tabelle `personen` wird vom Einsatzprotokoll
// mitgelesen. Austritte werden deaktiviert, nicht gelöscht.

// "Jugendfeuerwehr (Betreuer), Einsatzabteilung FF (Mitglied)"
// Rolle in der Abteilung im Fokus, danach die übrigen Zugehörigkeiten:
// "Betreuer · auch: Einsatzabteilung FF (Mitglied)". Ohne Fokus alle.
function abteilungsText(pers, fokusId) {
  const z = pers.abteilungen || [];
  if (!z.length) return '';
  const namen = new Map(STATE.abteilungen.map((a) => [a.id, a.name]));
  const rollen = new Map(STATE.personenRollen.map((r) => [r.id, r.name]));
  const text = (x) => {
    const n = namen.get(x.abteilung_id) || `Abteilung ${x.abteilung_id}`;
    const r = x.rolle_id ? rollen.get(x.rolle_id) : null;
    return r ? `${n} (${r})` : n;
  };
  if (fokusId == null) return ' · ' + z.map(text).join(', ');
  const fokus = z.find((x) => x.abteilung_id === fokusId);
  const rest = z.filter((x) => x.abteilung_id !== fokusId);
  const teile = [];
  if (fokus) teile.push(fokus.rolle_id ? (rollen.get(fokus.rolle_id) || '') : 'ohne Rolle');
  if (rest.length) teile.push('auch: ' + rest.map(text).join(', '));
  return teile.length ? ' · ' + teile.filter(Boolean).join(' · ') : '';
}

async function loadStammPersonen() {
  fuelleVerwaltungsAbteilung('#pv-abt', '#pv-abt-feld');
  const list = $('#stammpersonen-list');
  try {
    const res = await fetch('/api/personen?alle=1');
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'HTTP ' + res.status);
    STATE.alleStammPersonen = await res.json();
    renderStammPersonen();
  } catch (err) {
    list.innerHTML = `<p class="empty">Fehler: ${escapeHtml(err.message)}</p>`;
  }
}

// Filtert und zeichnet neu, ohne den Server erneut zu fragen — Tippen in der
// Suche soll sich sofort anfühlen.
function renderStammPersonen() {
  const list = $('#stammpersonen-list');
  list.innerHTML = '';
  const alle = STATE.alleStammPersonen || [];
  const sichtbar = filterPersonen(alle, {
    abteilungId: STATE.vwAbt,
    suche: $('#pv-suche').value,
    mitInaktiven: $('#pv-inaktiv').checked,
  });
  const imFokus = STATE.vwAbt == null
    ? alle : alle.filter((p) => (p.abteilung_ids || []).includes(STATE.vwAbt));
  $('#pv-zaehler').textContent = `${sichtbar.length} von ${imFokus.length} Personen`;
  seitenkopf('view-stammpersonen', 'Personen', `${imFokus.filter((p) => p.aktiv).length} aktiv`);

  if (!sichtbar.length) {
    if (alle.length) {
      leerZustand(list, {
        icon: 'suche', titel: 'Keine Treffer', text: 'Keine Person passt zu Auswahl und Suche.',
        knopf: 'Suche leeren', aktion: () => { $('#pv-suche').value = ''; renderStammPersonen(); },
      });
    } else {
      leerZustand(list, {
        icon: 'personen', titel: 'Noch keine Personen', text: 'Personen werden einmal angelegt und dann jeder Abteilung zugeordnet.',
        knopf: '+ Neue Person', aktion: () => $('#btn-stammperson-new').click(),
      });
    }
    return;
  }
  for (const pers of sichtbar) {
    const li = document.createElement('li');
    li.className = 'user-item';
    const zeitraum = [pers.eintritt, pers.austritt].filter(Boolean).map(formatDate).join(' – ');
    li.innerHTML = `
      <div class="u-info">
        <div class="u-name">${escapeHtml(pers.nachname)}, ${escapeHtml(pers.vorname)}${pers.agt ? ' <span class="agt-plakette" title="Atemschutzgeräteträger">AGT</span>' : ''}</div>
        <div class="u-role">${pers.aktiv ? 'aktiv' : 'nicht aktiv'}${zeitraum ? ' · ' + escapeHtml(zeitraum) : ''}${escapeHtml(abteilungsText(pers, STATE.vwAbt))}</div>
      </div>
      <div class="u-actions">
        ${iconBtn('edit', 'Bearbeiten')}
        ${iconBtn('merge', 'Zusammenführen', 'admin-only')}
        ${iconBtn('del', 'Löschen', 'icon-danger')}
      </div>
    `;
    li.querySelector('[data-act="edit"]').addEventListener('click', () => openStammPersonDialog(pers));
    li.querySelector('[data-act="merge"]').addEventListener('click', () => openMergeDialog(pers));
    li.querySelector('[data-act="del"]').addEventListener('click', () => deleteStammPerson(pers));
    list.appendChild(li);
  }
}

// --- Zusammenführen ---
// Vorbeugen allein genügt nicht: eine entstandene Dublette bliebe sonst
// dauerhaft zwei Zeilen in der Auswertung, mit geteilten Stunden auf beiden.
// Nur für den übergreifenden Admin — der Vorgang greift über
// Abteilungsgrenzen und löscht einen Datensatz.

function openMergeDialog(ziel) {
  STATE.mergeZielId = ziel.id;
  $('#merge-ziel-text').innerHTML =
    `Alles wird auf <strong>${escapeHtml(ziel.nachname)}, ${escapeHtml(ziel.vorname)}</strong> `
    + 'übertragen. Dieser Datensatz bleibt bestehen.';
  const sel = $('#merge-quelle');
  sel.innerHTML = '';
  for (const p of (STATE.alleStammPersonen || [])) {
    if (p.id === ziel.id) continue;
    const o = document.createElement('option');
    o.value = String(p.id);
    o.textContent = `${p.nachname}, ${p.vorname}`;
    sel.appendChild(o);
  }
  $('#merge-error').classList.add('hidden');
  $('#merge-dialog').showModal();
}

async function mergePersonen() {
  const errEl = $('#merge-error'); errEl.classList.add('hidden');
  const quelleId = Number($('#merge-quelle').value);
  const quelleText = $('#merge-quelle').selectedOptions[0]?.textContent || '';
  if (!Number.isFinite(quelleId)) { errEl.textContent = 'Keine Person gewählt.'; errEl.classList.remove('hidden'); return; }
  if (!await bestaetigen(`„${quelleText}" eingliedern?\n\nDie Person wird eingegliedert und gelöscht. Das lässt sich nicht zurücknehmen.`, { ok: 'Zusammenführen' })) return;
  try {
    const res = await fetch(`/api/personen/${STATE.mergeZielId}/zusammenfuehren`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quelle_id: quelleId }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
    $('#merge-dialog').close();
    await loadStammPersonen();
    await loadStaticData();
    const u = d.umgehaengt || {};
    let text = `Zusammengeführt: ${u.abende || 0} Abende, ${u.besatzung || 0} Besatzungs-, `
             + `${u.atemschutz || 0} Atemschutzeinträge`;
    if (d.doppelte_abende_eingesammelt) {
      // Das ist eine Information, die der Admin kennen sollte: beide
      // Datensätze standen am selben Abend in der Liste.
      text += `. ${d.doppelte_abende_eingesammelt} Doppeleintrag/Doppeleinträge `
            + 'am selben Abend wurden zusammengelegt.';
    }
    hinweis(text);
  } catch (err) {
    errEl.textContent = err.message; errEl.classList.remove('hidden');
  }
}

// --- Dublettenvermeidung ---
// Beim Tippen bestehende Personen über ALLE Abteilungen zeigen. Das ist die
// eigentliche Prävention: man stolpert über die Person, bevor man sie anlegt.
// Ohne das sieht ein Jugendwart ein FF-Mitglied nicht und legt es neu an.

let sucheTimer = null;

// Abteilungen, in denen die Person noch fehlt UND die der Benutzer verwalten
// darf. Nur dort kann er sie ergänzen — alles andere würde der Server ohnehin
// mit 403 ablehnen.
function fehlendeAbteilungen(person, meineAbteilungen) {
  const hat = new Set(person.abteilung_ids || []);
  return meineAbteilungen.filter((a) => !hat.has(a.id));
}

function zeigeTreffer(treffer, ausser) {
  const box = $('#sp-treffer');
  const liste = (treffer || []).filter((t) => t.id !== ausser);
  if (!liste.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }

  STATE.trefferById = new Map(liste.map((t) => [t.id, t]));
  box.innerHTML = '<div class="t-kopf">Es gibt bereits:</div>'
    + liste.slice(0, 5).map((t) => {
      const fehlt = fehlendeAbteilungen(t, STATE.abteilungen);
      // Mit genau einer fehlenden Abteilung steht deren Name im Knopf; bei
      // mehreren öffnet der Dialog die Auswahl.
      const knopf = fehlt.length
        ? `<button type="button" class="chip" data-erg="${t.id}">`
          + (fehlt.length === 1 ? `+ ${escapeHtml(fehlt[0].name)}` : '+ Abteilung zuordnen')
          + '</button>'
        : '<span class="t-abt">bereits in allen Ihren Abteilungen</span>';
      return `<div class="t-zeile"><span>${escapeHtml(t.nachname)}, ${escapeHtml(t.vorname)}`
        + `<br><span class="t-abt">${escapeHtml(t.abteilungen_namen || 'keine Abteilung')}</span>`
        + `</span>${knopf}</div>`;
    }).join('');
  box.classList.remove('hidden');

  for (const btn of box.querySelectorAll('[data-erg]')) {
    btn.addEventListener('click', () =>
      openErgDialog(STATE.trefferById.get(Number(btn.dataset.erg))));
  }
}

async function sucheDubletten() {
  const n = $('#sp-nachname').value.trim();
  const v = $('#sp-vorname').value.trim();
  const q = [n, v].filter(Boolean).join(' ');
  if (q.length < 3) { zeigeTreffer([], null); return; }
  try {
    const res = await fetch('/api/personen?suche=' + encodeURIComponent(q));
    if (!res.ok) { zeigeTreffer([], null); return; }
    zeigeTreffer(await res.json(), STATE.editPersonId);
  } catch { zeigeTreffer([], null); }
}

// Eigene Abteilung zu einer bestehenden Person hinzufügen — der Ausweg aus
// der Sackgasse "existiert bereits, darf ich aber nicht bearbeiten".
function openErgDialog(person) {
  if (!person) return;
  const fehlt = fehlendeAbteilungen(person, STATE.abteilungen);
  if (!fehlt.length) return;
  STATE.ergPersonId = person.id;

  $('#erg-person').innerHTML =
    `<strong>${escapeHtml(person.nachname)}, ${escapeHtml(person.vorname)}</strong>`
    + `<br>bisher in: ${escapeHtml(person.abteilungen_namen || 'keiner Abteilung')}`;

  const asel = $('#erg-abteilung');
  asel.innerHTML = '';
  for (const a of fehlt) {
    const o = document.createElement('option');
    o.value = String(a.id); o.textContent = a.name;
    asel.appendChild(o);
  }
  // Die gerade gewählte Verwaltungsabteilung vorauswählen, wenn sie fehlt.
  const wunsch = STATE.vwAbt ?? STATE.abteilungId;
  if (wunsch != null && fehlt.some((a) => a.id === wunsch)) asel.value = String(wunsch);
  // Bei genau einer Möglichkeit wäre die Auswahl nur Ballast, bleibt aber
  // sichtbar, damit klar ist, wohin zugeordnet wird.
  asel.disabled = fehlt.length === 1;

  const rsel = $('#erg-rolle');
  rsel.innerHTML = '<option value="">— ohne Rolle —</option>';
  for (const r of STATE.personenRollen) {
    const o = document.createElement('option');
    o.value = String(r.id); o.textContent = r.name;
    rsel.appendChild(o);
  }

  $('#erg-error').classList.add('hidden');
  $('#erg-dialog').showModal();
}

async function ergaenzeAbteilung() {
  const errEl = $('#erg-error'); errEl.classList.add('hidden');
  const abteilungId = Number($('#erg-abteilung').value);
  const rolleId = $('#erg-rolle').value ? Number($('#erg-rolle').value) : null;
  if (!Number.isFinite(abteilungId)) {
    errEl.textContent = 'Keine Abteilung gewählt.'; errEl.classList.remove('hidden'); return;
  }
  try {
    const res = await fetch(`/api/personen/${STATE.ergPersonId}/abteilung`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ abteilung_id: abteilungId, rolle_id: rolleId }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
    $('#erg-dialog').close();
    $('#sp-dialog').close();
    await loadStammPersonen();
    await loadStaticData();
    toast('Abteilung zugeordnet', 'success');
  } catch (err) {
    errEl.textContent = err.message; errEl.classList.remove('hidden');
  }
}

function openStammPersonDialog(pers) {
  const isEdit = !!(pers && pers.id);
  STATE.editPersonId = isEdit ? pers.id : null;
  $('#sp-dialog-title').textContent = isEdit
    ? `${pers.nachname}, ${pers.vorname}` : 'Neue Person';
  $('#sp-nachname').value = isEdit ? pers.nachname : '';
  $('#sp-vorname').value  = isEdit ? pers.vorname : '';
  $('#sp-eintritt').value = isEdit ? (pers.eintritt || '') : '';
  $('#sp-austritt').value = isEdit ? (pers.austritt || '') : '';
  $('#sp-aktiv').value    = isEdit ? String(pers.aktiv ? 1 : 0) : '1';
  $('#sp-agt').checked    = isEdit ? !!pers.agt : false;
  STATE.editPersonAgt = isEdit ? !!pers.agt : false;
  // Bei einer neuen Person die aktuell gewählte Abteilung vorbelegen.
  renderAbteilungsRollen('#sp-abteilungen',
    isEdit
      ? (pers.abteilungen || (pers.abteilung_ids || []).map((id) => ({ abteilung_id: id, rolle_id: null })))
      : ((STATE.vwAbt ?? STATE.abteilungId)
          ? [{ abteilung_id: STATE.vwAbt ?? STATE.abteilungId, rolle_id: null }] : []));
  $('#sp-error').classList.add('hidden');
  zeigeTreffer([], null);
  $('#sp-dialog').showModal();
}

async function saveStammPerson(trotzdem = false) {
  const errEl = $('#sp-error'); errEl.classList.add('hidden');
  const payload = {
    nachname: $('#sp-nachname').value.trim(),
    vorname:  $('#sp-vorname').value.trim(),
    eintritt: $('#sp-eintritt').value || null,
    austritt: $('#sp-austritt').value || null,
    aktiv:    $('#sp-aktiv').value === '1',
    abteilungen: gewaehlteAbteilungsRollen('#sp-abteilungen'),
    trotzdem_anlegen: !!trotzdem,
  };
  const id = STATE.editPersonId;
  try {
    const res = await fetch(id ? '/api/personen/' + id : '/api/personen', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await res.json().catch(() => ({}));
    if (res.status === 409 && (d.vorhanden || d.aehnlich)) {
      // Statt nur abzulehnen den Ausweg anbieten: bestehende Person zeigen
      // und das Ergänzen der eigenen Abteilung ermöglichen.
      zeigeTreffer(d.vorhanden ? [d.vorhanden] : d.aehnlich, STATE.editPersonId);
      if (d.aehnlich) {
        errEl.innerHTML = escapeHtml(d.error)
          + ' — oben ergänzen, oder <button type="button" class="chip" id="sp-trotzdem">'
          + 'trotzdem neu anlegen</button>';
        errEl.classList.remove('hidden');
        $('#sp-trotzdem').addEventListener('click', () => saveStammPerson(true));
      } else {
        errEl.textContent = d.error;
        errEl.classList.remove('hidden');
      }
      return;
    }
    if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
    // AGT-Kennzeichen läuft über das Modul Atemschutz (eigene Rechte, Audit-Log)
    const pid = id || d.id;
    if (userDarfAtemschutz() && pid && $('#sp-agt').checked !== STATE.editPersonAgt) {
      const r2 = await fetch(`/api/agt/personen/${pid}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agt: $('#sp-agt').checked }),
      });
      if (!r2.ok) throw new Error((await r2.json().catch(() => ({}))).error || 'AGT-Kennzeichen nicht gespeichert');
    }
    $('#sp-dialog').close();
    await loadStammPersonen();
    await loadStaticData();   // Teilnehmerliste der Erfassung mitziehen
  } catch (err) {
    errEl.textContent = err.message; errEl.classList.remove('hidden');
  }
}

async function deleteStammPerson(pers) {
  if (!await bestaetigen(`${pers.nachname}, ${pers.vorname} löschen?`)) return;
  try {
    const res = await fetch('/api/personen/' + pers.id, { method: 'DELETE' });
    const d = await res.json().catch(() => ({}));
    if (res.status === 409) {
      // Person hat Historie — Löschen würde sie aus alten Auswertungen tilgen.
      const h = d.historie || {};
      const treffer = `${h.abende || 0} Abende, ${h.besatzung || 0} Besatzungs-, ${h.pa || 0} PA-Einträge`;
      if (await bestaetigen(`Stattdessen auf „nicht aktiv“ setzen?\n\n${d.error}\n\nGefunden: ${treffer}`, { ok: 'Nicht aktiv setzen', gefahr: false })) {
        await fetch('/api/personen/' + pers.id, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...pers, aktiv: false }),
        });
        await loadStammPersonen();
        await loadStaticData();
      }
      return;
    }
    if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
    await loadStammPersonen();
    await loadStaticData();
  } catch (err) { hinweis('Fehler: ' + err.message); }
}

// --- Stammdaten: Dienstarten und Themen ---

async function loadThemenView() {
  fuelleVerwaltungsAbteilung('#tv-abt', '#tv-abt-feld');
  // Dienstarten zuerst: der Themen-Dialog und die Gruppenüberschriften brauchen sie.
  await loadDienstartenList();
  await loadThemenList();
}

async function loadDienstartenList() {
  try {
    const res = await fetch('/api/dienstarten');
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'HTTP ' + res.status);
    STATE.dienstarten = await res.json();
    renderDienstarten();
  } catch (err) {
    $('#dienstarten-list').innerHTML = `<p class="empty">Fehler: ${escapeHtml(err.message)}</p>`;
  }
}

function renderDienstarten() {
  const list = $('#dienstarten-list');
  list.innerHTML = '';
  const alle = STATE.dienstarten || [];
  const sichtbar = dienstartenFuer(alle, STATE.vwAbt)
    .filter((d) => trifftSuche(d.name, $('#tv-suche').value));
  $('#tv-dienstart-zaehler').textContent = `${sichtbar.length} von ${alle.length} Dienstarten`;
  if (!sichtbar.length) {
    list.innerHTML = '<p class="empty">Keine Dienstart passt zu Auswahl und Suche.</p>';
    return;
  }
  const abtNamen = new Map(STATE.abteilungen.map((a) => [a.id, a.name]));
  for (const d of sichtbar) {
    const li = document.createElement('li');
    li.className = 'user-item';
    const gilt = d.abteilung_id == null ? 'alle Abteilungen'
      : (abtNamen.get(d.abteilung_id) || `Abteilung ${d.abteilung_id}`);
    li.innerHTML = `
      <div class="u-info">
        <div class="u-name">${escapeHtml(d.name)}</div>
        <div class="u-role">${escapeHtml(kategorieLabel(d.kategorie))} · gilt für ${escapeHtml(gilt)}
          · ${d.themen_anzahl} Themen insgesamt · Sortierung ${d.sort_order}</div>
      </div>
      <div class="u-actions">
        ${iconBtn('edit', 'Bearbeiten')}
        ${iconBtn('del', 'Löschen', 'icon-danger')}
      </div>
    `;
    li.querySelector('[data-act="edit"]').addEventListener('click', () => openDienstartDialog(d));
    li.querySelector('[data-act="del"]').addEventListener('click', () => deleteDienstart(d));
    list.appendChild(li);
  }
}

function kategorieLabel(k) {
  return k === 'uebung' ? 'zählt als Übung'
    : k === 'dienst' ? 'Dienst/Sitzung'
    : 'sonstiges';
}

function openDienstartDialog(d) {
  const isEdit = !!(d && d.id);
  STATE.editDienstartId = isEdit ? d.id : null;
  $('#da-dialog-title').textContent = isEdit ? `Dienstart „${d.name}"` : 'Neue Dienstart';
  $('#da-name').value = isEdit ? d.name : '';
  $('#da-kategorie').value = isEdit ? d.kategorie : 'sonstiges';
  $('#da-sort').value = isEdit ? d.sort_order : 100;

  // "Gilt für": leer = alle Abteilungen. Eine neue Dienstart ist in der
  // gewählten Abteilung vorbelegt, damit eine Jugend-eigene nicht versehentlich
  // in der Einsatzabteilung auftaucht.
  const sel = $('#da-abteilung');
  sel.innerHTML = '<option value="">Alle Abteilungen</option>';
  for (const a of STATE.abteilungen) {
    const o = document.createElement('option');
    o.value = String(a.id); o.textContent = a.name;
    sel.appendChild(o);
  }
  const gilt = isEdit ? d.abteilung_id : STATE.vwAbt;
  sel.value = gilt == null ? '' : String(gilt);

  $('#da-error').classList.add('hidden');
  $('#da-dialog').showModal();
}

async function saveDienstart() {
  const errEl = $('#da-error'); errEl.classList.add('hidden');
  const payload = {
    name: $('#da-name').value.trim(),
    kategorie: $('#da-kategorie').value,
    sort_order: Number($('#da-sort').value) || 100,
    abteilung_id: $('#da-abteilung').value ? Number($('#da-abteilung').value) : null,
  };
  const id = STATE.editDienstartId;
  try {
    const res = await fetch(id ? '/api/dienstarten/' + id : '/api/dienstarten', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
    $('#da-dialog').close();
    await loadThemenView();
    await loadStaticData();
  } catch (err) {
    errEl.textContent = err.message; errEl.classList.remove('hidden');
  }
}

async function deleteDienstart(d) {
  if (!await bestaetigen(`Dienstart „${d.name}" löschen?`)) return;
  try {
    const res = await fetch('/api/dienstarten/' + d.id, { method: 'DELETE' });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(r.error || 'HTTP ' + res.status);
    await loadThemenView();
    await loadStaticData();
  } catch (err) { hinweis('Fehler: ' + err.message); }
}

async function loadThemenList() {
  try {
    // Mit gewählter Abteilung fragt der Server nur diese; so sieht ein
    // Abteilungsadmin nicht einmal die Themen fremder Abteilungen im Netz.
    const abt = STATE.vwAbt != null ? `&abteilung_id=${STATE.vwAbt}` : '';
    const res = await fetch('/api/themen?alle=1' + abt);
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'HTTP ' + res.status);
    STATE.alleThemen = await res.json();
    renderThemenGruppen();
  } catch (err) {
    $('#themen-list').innerHTML = `<p class="empty">Fehler: ${escapeHtml(err.message)}</p>`;
  }
}

function renderThemenGruppen() {
  const box = $('#themen-list');
  box.innerHTML = '';
  const suche = $('#tv-suche').value;
  const gruppen = gruppiereThemen(STATE.alleThemen || [], {
    suche, mitInaktiven: $('#tv-inaktiv').checked,
  });
  const anzahl = gruppen.reduce((n, g) => n + g.themen.length, 0);
  $('#tv-zaehler').textContent = `${anzahl} Themen in ${gruppen.length} Dienstarten`;
  if (!gruppen.length) {
    box.innerHTML = '<p class="empty">Kein Thema passt zu Auswahl und Suche.</p>';
    return;
  }
  for (const g of gruppen) {
    const det = document.createElement('details');
    det.className = 'themen-gruppe';
    det.dataset.gruppe = g.name;
    // Offen bei aktiver Suche (sonst sähe man die Treffer nicht), bei nur
    // einer Gruppe, und für Gruppen, die der Benutzer selbst geöffnet hat.
    det.open = !!suche.trim() || gruppen.length === 1 || STATE.vwOffen.has(g.name);
    det.innerHTML = `<summary><span class="g-name">${escapeHtml(g.name)}</span>
      <span class="g-meta">${escapeHtml(kategorieLabel(g.kategorie))} · ${g.themen.length}</span></summary>`;
    const ul = document.createElement('ul');
    ul.className = 'users-list';
    for (const t of g.themen) {
      const li = document.createElement('li');
      li.className = 'user-item';
      li.innerHTML = `
        <div class="u-info">
          <div class="u-name">${t.aktiv ? '' : '⏸ '}${escapeHtml(t.thema)}</div>
          <div class="u-role">Priorität ${t.prioritaet}${t.aktiv ? '' : ' · inaktiv'}</div>
        </div>
        <div class="u-actions">
          ${iconBtn('edit', 'Bearbeiten')}
          ${iconBtn('del', 'Löschen', 'icon-danger')}
        </div>
      `;
      li.querySelector('[data-act="edit"]').addEventListener('click', () => openThemaDialog(t));
      li.querySelector('[data-act="del"]').addEventListener('click', () => deleteThema(t));
      ul.appendChild(li);
    }
    det.appendChild(ul);
    // Nur Handarbeit merken: das automatische Öffnen durch die Suche soll
    // nicht nach dem Leeren des Suchfelds offen bleiben.
    det.addEventListener('toggle', () => {
      if ($('#tv-suche').value.trim() || gruppen.length === 1) return;
      if (det.open) STATE.vwOffen.add(g.name); else STATE.vwOffen.delete(g.name);
    });
    box.appendChild(det);
  }
}

// Dienstart-Auswahl auf die der Abteilung begrenzen: eine Jugend-eigene
// Dienstart soll beim Anlegen eines FF-Themas nicht zur Auswahl stehen.
function fuelleThemaDienstarten(abteilungId, vorgewaehlt) {
  const sel = $('#th-dienstart');
  sel.innerHTML = '';
  for (const d of dienstartenFuer(STATE.dienstarten || [], abteilungId)) {
    const o = document.createElement('option');
    o.value = String(d.id); o.textContent = d.name;
    sel.appendChild(o);
  }
  if (vorgewaehlt != null && [...sel.options].some((o) => o.value === String(vorgewaehlt))) {
    sel.value = String(vorgewaehlt);
  }
}

function openThemaDialog(t) {
  const isEdit = !!(t && t.id);
  STATE.editThemaId = isEdit ? t.id : null;

  // Abteilung ist Pflicht und wird als ID gesendet. Vorher stand hier ein
  // Freitextfeld, das nur die Textspalte füllte: für den übergreifenden Admin
  // scheiterte "Neues Thema" deshalb mit "abteilung_id fehlt".
  const asel = $('#th-abteilung');
  asel.innerHTML = '';
  for (const a of STATE.abteilungen) {
    const o = document.createElement('option');
    o.value = String(a.id); o.textContent = a.name;
    asel.appendChild(o);
  }
  const abtWahl = isEdit && t.abteilung_id != null
    ? t.abteilung_id : (STATE.vwAbt ?? STATE.abteilungId);
  if (abtWahl != null && [...asel.options].some((o) => o.value === String(abtWahl))) {
    asel.value = String(abtWahl);
  }
  fuelleThemaDienstarten(Number(asel.value), isEdit ? t.dienstart_id : null);

  $('#th-dialog-title').textContent = isEdit ? 'Thema bearbeiten' : 'Neues Thema';
  $('#th-thema').value = isEdit ? t.thema : '';
  $('#th-prio').value = isEdit ? t.prioritaet : 1;
  $('#th-aktiv').value = isEdit ? String(t.aktiv ? 1 : 0) : '1';
  $('#th-error').classList.add('hidden');
  $('#th-dialog').showModal();
}

function onThemaAbteilungWechsel() {
  const bisher = $('#th-dienstart').value;
  fuelleThemaDienstarten(Number($('#th-abteilung').value), bisher);
}

async function saveThema() {
  const errEl = $('#th-error'); errEl.classList.add('hidden');
  const asel = $('#th-abteilung');
  const payload = {
    dienstart_id: Number($('#th-dienstart').value),
    thema: $('#th-thema').value.trim(),
    abteilung_id: Number(asel.value),
    // Die alte Textspalte weiter mitführen, damit sie nicht von der ID abweicht.
    abteilung: asel.selectedOptions[0]?.textContent || null,
    prioritaet: Number($('#th-prio').value) || 1,
    aktiv: $('#th-aktiv').value === '1',
  };
  if (!Number.isFinite(payload.dienstart_id)) {
    errEl.textContent = 'Keine Dienstart gewählt.'; errEl.classList.remove('hidden'); return;
  }
  const id = STATE.editThemaId;
  try {
    const res = await fetch(id ? '/api/themen/' + id : '/api/themen', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
    $('#th-dialog').close();
    // Die Gruppe des gespeicherten Themas offen halten.
    const dn = (STATE.dienstarten || []).find((x) => x.id === payload.dienstart_id);
    if (dn) STATE.vwOffen.add(dn.name);
    await loadThemenList();
    await loadStaticData();
  } catch (err) {
    errEl.textContent = err.message; errEl.classList.remove('hidden');
  }
}

async function deleteThema(t) {
  if (!await bestaetigen(`Thema „${t.thema}" löschen?\n\nBereits erfasste Abende behalten das Thema als Text.`)) return;
  try {
    const res = await fetch('/api/themen/' + t.id, { method: 'DELETE' });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
    await loadThemenList();
    await loadStaticData();
  } catch (err) { hinweis('Fehler: ' + err.message); }
}

async function loadTagsView() {
  const list = $('#tags-list');
  list.innerHTML = '';
  try {
    const res = await fetch('/api/tags');
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const tags = await res.json();
    if (!tags.length) {
      list.innerHTML = '<p class="empty">Noch keine Tags angelegt.</p>';
      return;
    }
    for (const t of tags) {
      const li = document.createElement('li');
      li.className = 'user-item';
      li.innerHTML = `
        <div class="u-info">
          <div class="u-name">${escapeHtml(t.name)}</div>
          <div class="u-role">Sortierung ${t.sort_order}</div>
        </div>
        <div class="u-actions">
          ${iconBtn('edit', 'Bearbeiten')}
          ${iconBtn('del', 'Löschen', 'icon-danger')}
        </div>
      `;
      li.querySelector('[data-act="edit"]').addEventListener('click', () => openTagDialog(t));
      li.querySelector('[data-act="del"]').addEventListener('click', () => deleteTag(t));
      list.appendChild(li);
    }
  } catch (err) {
    list.innerHTML = `<p class="empty">Fehler: ${escapeHtml(err.message)}</p>`;
  }
}

function openTagDialog(tag) {
  const isEdit = tag && tag.id;
  STATE.editTagId = isEdit ? tag.id : null;
  $('#tag-dialog-title').textContent = isEdit ? `Tag „${tag.name}" bearbeiten` : 'Neuer Tag';
  $('#tag-name').value = isEdit ? tag.name : '';
  $('#tag-sort').value = isEdit ? tag.sort_order : 100;
  $('#tag-error').classList.add('hidden');
  $('#tag-dialog').showModal();
}

async function saveTagDialog() {
  const errEl = $('#tag-error');
  errEl.classList.add('hidden');
  const name = $('#tag-name').value.trim();
  const sortOrder = Number($('#tag-sort').value) || 100;
  if (!name) {
    errEl.textContent = 'Name fehlt.';
    errEl.classList.remove('hidden');
    return;
  }
  try {
    if (STATE.editTagId) {
      const res = await fetch('/api/tags/' + STATE.editTagId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, sort_order: sortOrder }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      toast('Tag aktualisiert', 'success');
    } else {
      const res = await fetch('/api/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, sort_order: sortOrder }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      toast('Tag angelegt', 'success');
    }
    $('#tag-dialog').close('ok');
    await refreshTags();
    loadTagsView();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

async function deleteTag(tag) {
  if (!await bestaetigen(`Tag „${tag.name}" wirklich löschen? Bestehende Zuordnungen werden mit gelöscht.`)) return;
  try {
    const res = await fetch('/api/tags/' + tag.id, { method: 'DELETE' });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `HTTP ${res.status}`);
    }
    toast('Gelöscht', 'success');
    await refreshTags();
    loadTagsView();
  } catch (err) {
    toast('Fehler: ' + err.message, 'error');
  }
}

// --- Excel-Export ---

const SHEETJS_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
let _sheetjsPromise = null;

function loadSheetJs() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (_sheetjsPromise) return _sheetjsPromise;
  _sheetjsPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SHEETJS_URL;
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => {
      _sheetjsPromise = null;
      reject(new Error('SheetJS konnte nicht geladen werden'));
    };
    document.head.appendChild(s);
  });
  return _sheetjsPromise;
}

async function exportExcel() {
  toast('Lade Daten …');
  try {
    const [XLSX, dataRes] = await Promise.all([loadSheetJs(), fetch('/api/export')]);
    if (dataRes.status === 401) { showLogin(); return; }
    if (!dataRes.ok) throw new Error('HTTP ' + dataRes.status);
    const { sessions, entries, tags = [], entryTags = [] } = await dataRes.json();

    // Sheet 1 — Übersicht (pro Anwesenheit)
    const byId = new Map();
    for (const e of entries) {
      if (!byId.has(e.session_id)) byId.set(e.session_id, []);
      byId.get(e.session_id).push(e);
    }
    const overviewRows = sessions.map((s) => {
      const es = byId.get(s.id) || [];
      const anwesend = es.filter((e) => e.status === 'anwesend').length;
      return {
        Datum: s.datum,
        Beginn: s.zeit_von || '',
        Ende: s.zeit_bis || '',
        Dienstart: s.dienstart,
        Thema: s.thema,
        Ausbilder: s.ausbilder || '',
        Bemerkung: s.bemerkung || '',
        'Erfasst von': s.created_by || '',
        Anwesend: anwesend,
      };
    });
    const wsOverview = XLSX.utils.json_to_sheet(overviewRows);
    wsOverview['!cols'] = [
      { wch: 12 }, { wch: 8 }, { wch: 8 }, { wch: 24 }, { wch: 42 },
      { wch: 20 }, { wch: 30 }, { wch: 14 }, { wch: 10 },
    ];

    // Sheet 2 — Anwesende mit Zusatzinfos
    const tagMap = new Map(); // entry_id -> Set<tag_id>
    for (const et of entryTags) {
      if (!tagMap.has(et.entry_id)) tagMap.set(et.entry_id, new Set());
      tagMap.get(et.entry_id).add(et.tag_id);
    }
    const sortedTags = tags
      .slice()
      .sort((a, b) => (a.sort_order ?? 100) - (b.sort_order ?? 100) || a.name.localeCompare(b.name, 'de'));

    const sessById = new Map(sessions.map((s) => [s.id, s]));
    const entryRows = entries
      .filter((e) => e.status === 'anwesend')
      .map((e) => {
        const s = sessById.get(e.session_id) || {};
        const row = {
          Datum: s.datum || '',
          Thema: s.thema || '',
          Dienstart: s.dienstart || '',
          Vorname: e.vorname,
          Nachname: e.nachname,
          Bemerkung: e.bemerkung || '',
        };
        const entryTagSet = tagMap.get(e.id) || new Set();
        for (const t of sortedTags) {
          row[t.name] = entryTagSet.has(t.id) ? 'ja' : '';
        }
        return row;
      });
    const baseCols = [
      { wch: 12 }, { wch: 42 }, { wch: 24 }, { wch: 16 }, { wch: 16 }, { wch: 30 },
    ];
    const tagCols = sortedTags.map(() => ({ wch: 18 }));
    const wsEntries = XLSX.utils.json_to_sheet(entryRows);
    wsEntries['!cols'] = [...baseCols, ...tagCols];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsOverview, 'Übersicht');
    XLSX.utils.book_append_sheet(wb, wsEntries, 'Anwesende');

    const today = new Date().toISOString().slice(0, 10);
    await xlsxAusgeben(wb, `Anwesenheit_${today}.xlsx`);
    toast('Export erstellt', 'success');
  } catch (err) {
    toast('Export fehlgeschlagen: ' + err.message, 'error');
  }
}

// --- E-Mail ---

function sendEmail(data) {
  const subject = `Anwesenheit ${formatDate(data.datum)} – ${data.thema}`;
  const lines = [];
  lines.push(`Datum: ${formatDate(data.datum)}`);
  if (data.zeit_von) lines.push(`Zeit: ${data.zeit_von}${data.zeit_bis ? ' – ' + data.zeit_bis : ''}`);
  lines.push(`Dienstart: ${data.dienstart}`);
  lines.push(`Thema: ${data.thema}`);
  if (data.ausbilder) lines.push(`Ausbilder: ${data.ausbilder}`);
  if (data.bemerkung) lines.push(`Bemerkung: ${data.bemerkung}`);
  lines.push('');
  const a = data.entries.filter((e) => e.status === 'anwesend');
  lines.push(`Anwesend (${a.length}):`);
  a.forEach((p) => lines.push(`  • ${p.vorname} ${p.nachname}`));
  const body = lines.join('\n');
  const url = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.location.href = url;
}

// --- Utils ---

// --- Startseite ---
// Oben, was fällig ist (Atemschutz, Kleidung; je nach Rolle), darunter
// Kacheln für die Bereiche. Die Zahlen rechnet /api/start mit denselben
// Funktionen wie die Module, damit Start und Modul nie auseinanderlaufen.
const EP_URL = 'https://ffw-einsatzprotokoll.pages.dev/';
const START_ZEILEN = 5;
let START = null;

const START_KACHELN = [
  { view: 'edit', titel: 'Anwesenheit erfassen', text: 'Übungsabend, Dienst oder Termin', darf: () => userDarfErfassen() },
  { view: 'history', titel: 'Verlauf', text: 'Erfasste Anwesenheiten', darf: () => userDarfErfassen() },
  { view: 'auswertung', titel: 'Auswertung', text: 'Beteiligung je Abteilung und Person', darf: () => userDarfAuswerten() },
  { view: 'atemschutz', titel: 'Atemschutz', text: 'Tauglichkeit der Geräteträger', darf: () => userDarfAtemschutz(),
    zahl: () => START?.atemschutz?.agt ? `${START.atemschutz.tauglich} von ${START.atemschutz.agt} tauglich` : '' },
  { view: 'kleidung', titel: 'Kleidung', text: 'Reinigung und Prüfung', darf: () => userDarfKleidung(),
    zahl: () => START?.kleidung?.teile ? (START.kleidung.ueberfaellig ? `${START.kleidung.ueberfaellig} überfällig` : `${START.kleidung.teile} Teile`) : '' },
  { view: 'stammpersonen', titel: 'Personen', text: 'Stammdaten und Zuordnung', darf: () => userDarfVerwalten() },
];

// Kurze Namen der Nachweise für die Plaketten (die Wahlpflicht heißt in der
// Übersicht "Einsatz oder Einsatzübung", das passt nicht in eine Zeile).
const START_NACHWEIS = { lehrgang: 'Lehrgang', strecke: 'Strecke', g263: 'G 26.3',
  unterweisung: 'Unterweisung', wahlpflicht: 'Einsatzübung', kleidung: 'Kleidung' };

async function ladeStart() {
  const jetzt = new Date();
  const iso = `${jetzt.getFullYear()}-${String(jetzt.getMonth() + 1).padStart(2, '0')}-${String(jetzt.getDate()).padStart(2, '0')}`;
  const wt = WOCHENTAGE[jetzt.getDay()];
  seitenkopf('view-start', 'Start', `${wt.charAt(0)}${wt.charAt(1).toLowerCase()} ${formatDate(iso)}`);
  startKacheln();   // sofort, ohne auf das Netz zu warten

  const box = $('#start-faellig');
  const mitFaellig = userDarfAtemschutz() || userDarfKleidung();
  box.classList.toggle('hidden', !mitFaellig);
  $('.start-raster').classList.toggle('mit-faellig', mitFaellig);
  if (!mitFaellig) { box.innerHTML = ''; return; }
  if (!START) box.innerHTML = '<p class="start-meta">Fälligkeiten werden geladen …</p>';
  try {
    const res = await fetch('/api/start');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    START = await res.json();
  } catch (err) {
    box.innerHTML = `<div class="notice warn">Fälligkeiten nicht abrufbar (${escapeHtml(err.message)}).</div>`;
    return;
  }
  if (STATE.view !== 'start') return;
  box.innerHTML = [START.atemschutz && startAtemschutz(START.atemschutz),
                   START.kleidung && startKleidung(START.kleidung)].filter(Boolean).join('');
  box.querySelectorAll('[data-oeffnen]').forEach((b) =>
    b.addEventListener('click', () => showView(b.dataset.oeffnen)));
  // Aufgeklappt bleibt pro Gerät gemerkt
  box.querySelectorAll('details.start-block').forEach((d) => d.addEventListener('toggle', () => {
    const offen = startOffen();
    offen[d.dataset.key] = d.open;
    try { localStorage.setItem('ffwe_anw_start_offen', JSON.stringify(offen)); } catch {}
  }));
  startKacheln();
}

function startOffen() {
  try { return JSON.parse(localStorage.getItem('ffwe_anw_start_offen') || '{}') || {}; } catch { return {}; }
}

// Kompakter Block: Kopf mit Aufklapp-Pfeil, Titel, Kennzahl und Balken;
// die Einzelheiten erst nach dem Aufklappen.
function startBlock(key, titel, zahl, balken, inhalt) {
  return `<details class="card start-block" data-key="${key}" ${startOffen()[key] ? 'open' : ''}>
    <summary>
      <span class="start-block-kopf">
        <span class="card-title">${escapeHtml(titel)}</span>
        ${zahl ? `<span class="start-zahl">${escapeHtml(zahl)}</span>` : ''}
      </span>
      ${balken}
    </summary>
    <div class="start-block-inhalt">${inhalt}</div>
  </details>`;
}

// Balken aus Anteilen [{ n, stufe, text }]; stufe a0 rot … a3 grün, leer =
// grau. Darunter dieselben Zahlen als Text, nie nur Farbe.
function startBalken(teile) {
  const summe = teile.reduce((s, t) => s + t.n, 0);
  if (!summe) return '';
  const da = teile.filter((t) => t.n);
  return `<span class="start-balken" role="img" aria-label="${escapeHtml(da.map((t) => `${t.n} ${t.text}`).join(', '))}">
      ${da.map((t) => `<span class="sb-${t.stufe || 'leer'}" style="flex-grow:${t.n}"></span>`).join('')}
    </span>
    <span class="start-legende">${da.map((t) => `<span><i class="sb-${t.stufe || 'leer'}" aria-hidden="true"></i>${t.n} ${escapeHtml(t.text)}</span>`).join('')}</span>`;
}

function startZeilen(liste, view, zeile) {
  const mehr = liste.length - START_ZEILEN;
  return `<ul class="start-liste">${liste.slice(0, START_ZEILEN).map((x) => `
      <li><button type="button" class="start-zeile" data-oeffnen="${view}">${zeile(x)}</button></li>`).join('')}</ul>
    ${mehr > 0 ? `<button type="button" class="btn-link start-mehr" data-oeffnen="${view}">und ${mehr} weitere</button>` : ''}`;
}

function startAtemschutz(a) {
  if (a.fehlt) return startBlock('atemschutz', 'Atemschutz', '', '', '<p class="start-meta">Modul noch nicht eingerichtet.</p>');
  if (!a.agt) {
    return startBlock('atemschutz', 'Atemschutz', '', '', `<p class="start-meta">Noch keine Geräteträger gekennzeichnet.</p>
      <button type="button" class="btn-sm" data-oeffnen="atemschutz">Atemschutz öffnen</button>`);
  }
  const text = (x) => {
    const n = START_NACHWEIS[x.key] || x.key;
    if (x.key === 'kleidung') return x.status === 'rot' ? 'Kleidung überfällig' : 'Kleidung bald fällig';
    if (x.fehlt) return `${n} fehlt`;
    return x.status === 'rot' ? `${n} abgelaufen ${formatDate(x.gueltig_bis)}` : `${n} bis ${formatDate(x.gueltig_bis)}`;
  };
  const liste = a.personen.length
    ? startZeilen(a.personen, 'atemschutz', (p) => `
        <span class="start-name">${escapeHtml(p.name)}</span>
        <span class="start-punkte">${p.punkte.map((x) => `<span class="agt-st st-${x.status}">${escapeHtml(text(x))}</span>`).join('')}</span>`)
    : '<div class="notice ok">Alle Geräteträger tauglich. In den nächsten 30 Tagen läuft nichts ab.</div>';
  const meta = [a.florix_stand ? `Florix-Stand ${formatDate(a.florix_stand)}` : 'Noch kein Florix-Import',
    a.eintrag_fehlt ? `${a.eintrag_fehlt} ${a.eintrag_fehlt === 1 ? 'Nachweis' : 'Nachweise'} noch nicht in Pass oder Florix eingetragen` : '']
    .filter(Boolean).join(' · ');
  const balken = startBalken([{ n: a.tauglich, stufe: 'a3', text: 'tauglich' },
                              { n: a.agt - a.tauglich, stufe: 'a0', text: 'nicht tauglich' }]);
  return startBlock('atemschutz', 'Atemschutz', `${a.tauglich} von ${a.agt} tauglich`, balken,
    `${liste}<p class="start-meta">${escapeHtml(meta)}</p>
     <button type="button" class="btn-sm" data-oeffnen="atemschutz">Atemschutz öffnen</button>`);
}

function startKleidung(k) {
  if (k.fehlt) return startBlock('kleidung', 'Kleidung', '', '', '<p class="start-meta">Modul noch nicht eingerichtet.</p>');
  const hinweis = k.vorschlaege
    ? `<button type="button" class="notice warn start-hinweis" data-oeffnen="kleidung">${k.vorschlaege === 1 ? 'Ein Einsatz' : `${k.vorschlaege} Einsätze`} mit PA-Trägern: Kleidung zur Reinigung vorgeschlagen</button>`
    : '';
  const liste = k.personen.length
    ? startZeilen(k.personen, 'kleidung', (p) => `
        <span class="start-name">${escapeHtml(p.name)}${p.agt ? '<span class="agt-plakette">AGT</span>' : ''}</span>
        <span class="start-punkte">
          ${p.rot ? `<span class="agt-st st-rot">${p.rot} überfällig</span>` : ''}
          ${p.gelb ? `<span class="agt-st st-gelb">${p.gelb} fällig${p.rot ? '' : ` bis ${formatDate(p.naechst)}`}</span>` : ''}
        </span>`)
    : (k.teile ? '<div class="notice ok">Kein Teil überfällig oder in den nächsten 30 Tagen fällig.</div>' : '');
  const meta = [
    k.in_reinigung ? `${k.in_reinigung} in Reinigung${k.in_reinigung_seit ? ` seit ${formatDate(k.in_reinigung_seit)}` : ''}` : '',
    k.ohne_datum ? `${k.ohne_datum} ohne erfasste Reinigung` : '',
    k.zms_stand ? `ZMS-Stand ${formatDate(k.zms_stand)}` : 'Noch kein ZMS-Import',
  ].filter(Boolean).join(' · ');
  const zahl = k.teile ? `${k.gueltig} von ${k.teile} gültig` : '';
  const balken = startBalken([
    { n: k.gueltig, stufe: 'a3', text: 'gültig' },
    { n: k.bald + k.in_reinigung, stufe: 'a1', text: 'bald fällig oder in Reinigung' },
    { n: k.ueberfaellig, stufe: 'a0', text: 'überfällig' },
    { n: k.teile - k.gueltig - k.bald - k.in_reinigung - k.ueberfaellig, stufe: '', text: 'ohne Datum' },
  ]);
  // Offene Vorschläge nach Einsätzen bleiben auch zugeklappt sichtbar
  return startBlock('kleidung', 'Kleidung', zahl, balken + hinweis,
    `${liste}<p class="start-meta">${escapeHtml(meta)}</p>
     <button type="button" class="btn-sm" data-oeffnen="kleidung">Kleidung öffnen</button>`);
}

function startKacheln() {
  const icon = (view) => ($(`.sheet-item[data-action="${view}"] svg`)?.outerHTML || '')
    .replace('class="sheet-icon"', 'class="kachel-icon"');
  const roles = STATE.user?.roles || [];
  const ep = MODUL.einsatzprotokoll && (roles.includes('admin_einsatzprotokoll') || roles.includes('erfasser_einsatzprotokoll'));
  const nav = $('#start-kacheln');
  nav.innerHTML = START_KACHELN.filter((k) => k.darf()).map((k) => {
    const zahl = k.zahl ? k.zahl() : '';
    return `<button type="button" class="start-kachel" data-view="${k.view}">
        ${icon(k.view)}
        <span class="kachel-titel">${escapeHtml(k.titel)}</span>
        <span class="kachel-text">${escapeHtml(zahl || k.text)}</span>
      </button>`;
  }).join('') + (ep ? `<a class="start-kachel" href="${EP_URL}" target="_blank" rel="noopener">
        <svg class="kachel-icon" viewBox="0 0 24 24" aria-hidden="true">${LEER_ICON.fahrzeug}</svg>
        <span class="kachel-titel">Einsatz<wbr>protokoll</span>
        <span class="kachel-text">Eigene App, eigene Anmeldung</span>
      </a>` : '');
  nav.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
}

// --- Seitenkopf und Leerzustand ---
// Großer Kopf mit Kennzahl über Übersichten. Solange er zu sehen ist,
// blendet die Kopfzeile ihren (gleichen) Titel aus; beim Scrollen kommt er
// dort wieder.
function seitenkopf(sectionId, titel, kennzahl) {
  const sec = document.getElementById(sectionId);
  if (!sec) return;
  let k = sec.querySelector(':scope > .seitenkopf');
  if (!k) {
    k = document.createElement('div');
    k.className = 'seitenkopf';
    k.innerHTML = '<h2 class="sk-titel"></h2><span class="sk-zahl"></span>';
    sec.prepend(k);
  }
  k.querySelector('.sk-titel').textContent = titel;
  k.querySelector('.sk-zahl').textContent = kennzahl || '';
  kopfTitelPruefen();
}
function kopfTitelPruefen() {
  const k = document.querySelector('.view:not(.hidden) > .seitenkopf');
  const kopf = document.querySelector('.app-header');
  const sichtbar = !!k && !!kopf && k.getBoundingClientRect().bottom > kopf.getBoundingClientRect().bottom;
  document.body.classList.toggle('seitenkopf-sichtbar', sichtbar);
}
window.addEventListener('scroll', kopfTitelPruefen, { passive: true });

const LEER_ICON = {
  liste: '<path d="M9 4h6v3H9zM7 5.5H5v15h14v-15h-2"/><path d="M8.5 12h7M8.5 16h5"/>',
  suche: '<circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/>',
  personen: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.5M17.5 14.5A5.5 5.5 0 0 1 20.5 19"/>',
  diagramm: '<path d="M5 20V11M12 20V4M19 20v-6"/>',
  fahrzeug: '<path d="M3 16V8h11v8M14 11h4l3 3v2h-7M3 16h18"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
  geraet: '<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M10 18h4"/>',
  fehler: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.5"/>',
};
// Leerer Zustand: Symbol, ein Satz, optional ein Knopf mit Aktion.
function leerZustand(ziel, { icon = 'liste', titel, text = '', knopf = null, aktion = null }) {
  const el = typeof ziel === 'string' ? $(ziel) : ziel;
  if (!el) return;
  el.classList.remove('hidden');
  el.innerHTML = `<div class="leer">
      <svg class="leer-icon" viewBox="0 0 24 24" aria-hidden="true">${LEER_ICON[icon] || LEER_ICON.liste}</svg>
      <div class="leer-titel">${escapeHtml(titel)}</div>
      ${text ? `<p class="leer-text">${escapeHtml(text)}</p>` : ''}
      ${knopf ? `<button type="button" class="btn-secondary leer-aktion">${escapeHtml(knopf)}</button>` : ''}
    </div>`;
  if (knopf && aktion) el.querySelector('.leer-aktion').addEventListener('click', aktion);
}

// Abschlusskarte nach dem ersten Speichern: bestätigt, was gespeichert ist,
// und bietet den nächsten Schritt an. Änderungen danach melden nur kurz.
function erfolgZeigen(data) {
  const n = (data.entries || []).filter((e) => e.status === 'anwesend').length;
  const d = data.datum ? new Date(data.datum + 'T00:00:00Z') : null;
  const tag = d && !isNaN(d) ? `${WOCHENTAGE[d.getUTCDay()].charAt(0)}${WOCHENTAGE[d.getUTCDay()].charAt(1).toLowerCase()} ${formatDate(data.datum)}` : '';
  $('#erfolg-text').innerHTML =
    `<strong>${n} anwesend</strong>`
    + `<span>${escapeHtml(data.thema || '')}</span>`
    + `<span>${escapeHtml([tag, data.zeit_von && data.zeit_bis ? `${data.zeit_von}–${data.zeit_bis}` : data.zeit_von].filter(Boolean).join(' · '))}</span>`;
  $('#erfolg-dialog').showModal();
}

// --- Rückfrage und Hinweis ---
// Ersetzt confirm()/alert() des Browsers: die zeigen auf dem iPad die Adresse
// der Seite und passen nicht zur Oberfläche. Erste Zeile = Titel, der Rest
// (Absätze durch Leerzeile getrennt) = Text. Vorauswahl ist "Abbrechen".
function bestaetigen(text, { ok = 'Löschen', gefahr = true, abbrechen = 'Abbrechen' } = {}) {
  const dlg = $('#frage-dialog');
  const [titel, ...rest] = String(text).split('\n');
  $('#frage-titel').textContent = titel;
  const box = $('#frage-text');
  box.innerHTML = '';
  for (const absatz of rest.join('\n').split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean)) {
    const p = document.createElement('p');
    p.textContent = absatz;
    box.appendChild(p);
  }
  const ja = $('#frage-ja');
  ja.textContent = ok;
  ja.className = gefahr ? 'btn-danger' : 'btn-primary';
  const nein = $('#frage-nein');
  nein.textContent = abbrechen || '';
  nein.classList.toggle('hidden', !abbrechen);
  return new Promise((resolve) => {
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ja'), { once: true });
    dlg.showModal();
    (abbrechen ? nein : ja).focus();
  });
}
function hinweis(text) {
  return bestaetigen(text, { ok: 'OK', gefahr: false, abbrechen: null });
}

// Meldung mit "Rückgängig": für Entfernen ohne Rückfrage. Die Änderung ist
// schon gespeichert; Rückgängig legt den Eintrag wieder an.
function toastRueckgaengig(msg, onUndo, dauer = 6000) {
  const t = $('#toast');
  t.className = 'toast toast-undo';
  t.innerHTML = '';
  const text = document.createElement('span');
  text.textContent = msg;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'toast-aktion';
  btn.textContent = 'Rückgängig';
  const lauf = document.createElement('i');
  lauf.className = 'toast-lauf';
  lauf.style.animationDuration = dauer + 'ms';
  t.append(text, btn, lauf);
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.add('hidden'), dauer);
  btn.addEventListener('click', async () => {
    clearTimeout(t._tid);
    t.classList.add('hidden');
    await onUndo();
  }, { once: true });
}
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  t.classList.remove('hidden');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.add('hidden'), 2400);
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const ROLE_LABELS = {
  admin_anwesenheit:        'Admin (Anwesenheit)',
  abteilungsadmin_anwesenheit: 'Abteilungsadmin',
  admin_atemschutz:         'Atemschutz-Admin',
  admin_kleidung:           'Kleidung-Admin',
  erfasser_anwesenheit:     'Erfasser (Anwesenheit)',
  admin_einsatzprotokoll:   'Admin (Einsatzprotokoll)',
  erfasser_einsatzprotokoll:'Erfasser (Einsatzprotokoll)',
};
function formatRoleLabel(role) { return ROLE_LABELS[role] || role; }
