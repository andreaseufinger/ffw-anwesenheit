// Anwesenheit — Frontend mit Login/Rollen

// App-spezifische Konstanten — diese App kennt nur ihre eigenen Rollen.
const APP_ROLE_ADMIN    = 'admin_anwesenheit';
const APP_ROLE_ABTADMIN = 'abteilungsadmin_anwesenheit';
const APP_ROLE_ERFASSER = 'erfasser_anwesenheit';
const APP_ROLES_SET     = new Set([APP_ROLE_ADMIN, APP_ROLE_ABTADMIN, APP_ROLE_ERFASSER]);

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
function userDarfAuswerten() {
  const r = STATE.user?.roles || [];
  return r.includes(APP_ROLE_ADMIN) || r.includes(APP_ROLE_ABTADMIN);
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
  $('#dienstart').addEventListener('change', populateThemaSelect);
  $$('.bulk-actions .chip').forEach((b) =>
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
  $('#menu-username').textContent = me.username;
  $('#menu-role').textContent = isAdmin ? 'Admin' : 'Erfasser';
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  await loadStaticData();
  showView('edit');
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
  $('#menu-overlay').classList.remove('hidden');
}
function closeMenu() {
  $('#menu-overlay').classList.add('hidden');
}
function onMenuAction(action) {
  closeMenu();
  if (action === 'edit') showView('edit');
  else if (action === 'history') showView('history');
  else if (action === 'users') showView('users');
  else if (action === 'auswertung') showView('auswertung');
  else if (action === 'abteilungen') showView('abteilungen');
  else if (action === 'stammpersonen') showView('stammpersonen');
  else if (action === 'themen') showView('themen');
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
    alert(d.error || 'Stammdaten-Tabellen fehlen — Migration noch nicht ausgeführt.');
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

function renderPersonen() {
  const list = $('#personen-list');
  list.innerHTML = '';
  STATE.entries.forEach((entry, idx) => {
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

function bulkSet(mode) {
  const value = mode === 'anwesend' ? 'anwesend' : '';
  STATE.entries.forEach((e) => (e.status = value));
  renderPersonen();
  updateSummary();
}

function updateSummary() {
  const total = STATE.entries.length;
  const a = STATE.entries.filter((e) => e.status === 'anwesend').length;
  $('#summary-text').textContent = `${a} von ${total} anwesend`;
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
  btn.textContent = 'Speichere …';
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
    }
    toast('Gespeichert', 'success');
  } catch (err) {
    toast('Fehler: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Speichern';
  }
}

// --- Views ---

function showView(view) {
  // Erfasser darf nur edit, history und detail
  const erfasserViews = new Set(['edit', 'history', 'detail']);
  const verwalterViews = new Set(['stammpersonen', 'themen']);
  if (STATE.user && !userIsAdmin()
      && !erfasserViews.has(view)
      && !(userDarfVerwalten() && verwalterViews.has(view))) {
    view = 'edit';
  }
  STATE.view = view;
  $('#view-edit').classList.toggle('hidden', view !== 'edit');
  $('#view-history').classList.toggle('hidden', view !== 'history');
  $('#view-detail').classList.toggle('hidden', view !== 'detail');
  $('#view-users').classList.toggle('hidden', view !== 'users');
  $('#view-tags').classList.toggle('hidden', view !== 'tags');
  $('#view-auswertung').classList.toggle('hidden', view !== 'auswertung');
  $('#view-abteilungen').classList.toggle('hidden', view !== 'abteilungen');
  $('#view-stammpersonen').classList.toggle('hidden', view !== 'stammpersonen');
  $('#view-themen').classList.toggle('hidden', view !== 'themen');
  $('#action-edit').classList.toggle('hidden', view !== 'edit');
  $('#action-detail').classList.toggle('hidden', view !== 'detail');
  updateHeaderTitle();
  if (view === 'history') loadHistory();
  if (view === 'users') loadUsers();
  if (view === 'tags') loadTagsView();
  if (view === 'auswertung') initAuswertung();
  if (view === 'abteilungen') loadAbteilungenView();
  if (view === 'stammpersonen') { loadStammPersonen(); loadPersonenRollenView(); }
  if (view === 'themen') loadThemenView();
}

function updateHeaderTitle() {
  const view = STATE.view;
  $('#header-title').textContent =
    view === 'history' ? 'Vorherige Anwesenheiten'
    : view === 'detail' ? 'Anwesenheit'
    : view === 'users' ? 'Benutzer'
    : view === 'tags' ? 'Tags'
    : view === 'auswertung' ? 'Auswertung'
    : view === 'abteilungen' ? 'Abteilungen'
    : view === 'stammpersonen' ? 'Personen'
    : view === 'themen' ? 'Themen'
    : STATE.currentId ? 'Anwesenheit bearbeiten'
    : 'Anwesenheit';
}

async function loadHistory() {
  const list = $('#history-list');
  list.innerHTML = '';
  $('#history-empty').classList.add('hidden');
  try {
    const res = await fetch('/api/attendance');
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const items = await res.json();
    if (!items.length) {
      $('#history-empty').textContent = 'Noch keine Anwesenheiten gespeichert.';
      $('#history-empty').classList.remove('hidden');
      return;
    }
    for (const s of items) {
      const li = document.createElement('li');
      li.className = 'history-item';
      li.innerHTML = `
        <div class="h-main">
          <div class="h-date">${formatDate(s.datum)}${s.zeit_von ? ' · ' + s.zeit_von : ''}</div>
          <div class="h-title">${escapeHtml(s.thema)}</div>
          <div class="h-meta">
            <span>${escapeHtml(s.dienstart)}</span>
            ${s.ausbilder ? `<span>${escapeHtml(s.ausbilder)}</span>` : ''}
            ${s.created_by ? `<span>von ${escapeHtml(s.created_by)}</span>` : ''}
            ${s.migriert_quelle ? `<span class="h-badge h-badge-migriert" title="Nachgetragen aus: ${escapeHtml(s.migriert_quelle)}">nachgetragen</span>` : ''}
            <span class="h-badge">${s.anwesend_count} anwesend</span>
          </div>
        </div>
        <button class="h-edit" aria-label="Bearbeiten">Bearbeiten</button>
      `;
      li.querySelector('.h-main').addEventListener('click', () => showDetail(s.id));
      li.querySelector('.h-edit').addEventListener('click', (e) => {
        e.stopPropagation();
        editSession(s.id);
      });
      list.appendChild(li);
    }
  } catch (err) {
    $('#history-empty').textContent = 'Verlauf nicht abrufbar: ' + err.message;
    $('#history-empty').classList.remove('hidden');
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
        ${s.bemerkung ? `<div><strong>Bemerkung:</strong> ${escapeHtml(s.bemerkung)}</div>` : ''}
        <div style="margin-top:6px;color:var(--gray-500)">
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
  if (!confirm('Diese Anwesenheit wirklich löschen?')) return;
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
          <button class="chip" data-act="edit">Bearbeiten</button>
          <button class="chip chip-danger" data-act="del">Löschen</button>
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
  if (!confirm(`Benutzer „${user.username}“ wirklich löschen?`)) return;
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

  // Vorherige Rollen-Box entfernen — insertAdjacentHTML würde sonst stapeln.
  const alteBox = document.getElementById('aus-rollen-box');
  if (alteBox) alteBox.remove();

  const k = (wert, label) =>
    `<div class="aus-kennzahl"><div class="k-wert">${wert}</div><div class="k-label">${label}</div></div>`;
  kz.innerHTML =
      k(d.durchschnitt.personen_pro_uebung ?? '–', 'Teilnehmer je Übung (Ø)')
    + k(d.durchschnitt.personen_pro_einsatz ?? '–', 'Teilnehmer je Einsatz (Ø)')
    + k(d.basis.uebungen, 'Übungen im Zeitraum')
    + k(d.basis.monate_verstrichen ?? '–', 'Monate verstrichen')
    + k(d.basis.einsaetze, 'Einsätze im Zeitraum')
    + k(d.basis.aktive_personen, 'aktive Personen')
    + k(d.basis.uebung_soll_stunden ?? '–', 'Stundensoll');

  // Aufteilung nach Rolle — in der Jugendfeuerwehr ist der Unterschied
  // zwischen "zehn Jugendliche" und "sechs Jugendliche plus vier Betreuer"
  // das eigentlich Interessante. Nur zeigen, wenn es mehr als eine Rolle gibt.
  const nachRolle = (titel, obj) => {
    const eintraege = Object.entries(obj || {});
    if (eintraege.length < 2) return '';
    return `<div class="aus-rollen"><strong>${titel}:</strong> `
      + eintraege.map(([r, v]) => `${escapeHtml(r)} ${v}`).join(' · ')
      + '</div>';
  };
  kz.insertAdjacentHTML('afterend',
    '<div id="aus-rollen-box">'
    + nachRolle('Teilnehmer je Übung nach Rolle', d.durchschnitt.uebung_nach_rolle)
    + (mitEinsatz ? nachRolle('Teilnehmer je Einsatz nach Rolle', d.durchschnitt.einsatz_nach_rolle) : '')
    + '</div>');

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
      + `<td>${escapeHtml(p.name)}${p.aktiv === false ? ' (ausgetreten)' : ''}</td>`
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
    XLSX.writeFile(wb, `Auswertung_${d.zeitraum.von}_${d.zeitraum.bis}.xlsx`);
  } catch (err) {
    alert('Export fehlgeschlagen: ' + err.message);
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
          <button class="chip" data-act="edit">Bearbeiten</button>
          <button class="chip chip-danger" data-act="del">Löschen</button>
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
  if (!confirm(`Abteilung „${a.name}" löschen?`)) return;
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
      alert(`${d.error}\n\nNoch zugeordnet: ${teile.join(', ') || 'unbekannt'}`);
      return;
    }
    if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
    await loadAbteilungenView();
    await loadStaticData();
    toast('Abteilung gelöscht', 'success');
  } catch (err) { alert('Fehler: ' + err.message); }
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
          <button class="chip" data-act="edit">Bearbeiten</button>
          <button class="chip chip-danger" data-act="del">Löschen</button>
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
  if (!confirm(`Rolle „${r.name}" löschen?${warnung}`)) return;
  try {
    const res = await fetch('/api/personen-rollen/' + r.id, { method: 'DELETE' });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
    await loadPersonenRollenView();
    await loadStammPersonen();
    toast('Rolle gelöscht', 'success');
  } catch (err) { alert('Fehler: ' + err.message); }
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

  if (!sichtbar.length) {
    list.innerHTML = alle.length
      ? '<p class="empty">Keine Person passt zu Auswahl und Suche.</p>'
      : '<p class="empty">Noch keine Personen eingetragen.</p>';
    return;
  }
  for (const pers of sichtbar) {
    const li = document.createElement('li');
    li.className = 'user-item';
    const zeitraum = [pers.eintritt, pers.austritt].filter(Boolean).map(formatDate).join(' – ');
    li.innerHTML = `
      <div class="u-info">
        <div class="u-name">${pers.aktiv ? '' : '⏸ '}${escapeHtml(pers.nachname)}, ${escapeHtml(pers.vorname)}</div>
        <div class="u-role">${pers.aktiv ? 'aktiv' : 'nicht aktiv'}${zeitraum ? ' · ' + escapeHtml(zeitraum) : ''}${escapeHtml(abteilungsText(pers, STATE.vwAbt))}</div>
      </div>
      <div class="u-actions">
        <button class="chip" data-act="edit">Bearbeiten</button>
        <button class="chip admin-only" data-act="merge">Zusammenführen</button>
        <button class="chip chip-danger" data-act="del">Löschen</button>
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
  if (!confirm(`„${quelleText}" wird eingegliedert und gelöscht.\n\nDas lässt sich nicht zurücknehmen.`)) return;
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
    alert(text);
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
    $('#sp-dialog').close();
    await loadStammPersonen();
    await loadStaticData();   // Teilnehmerliste der Erfassung mitziehen
  } catch (err) {
    errEl.textContent = err.message; errEl.classList.remove('hidden');
  }
}

async function deleteStammPerson(pers) {
  if (!confirm(`${pers.nachname}, ${pers.vorname} löschen?`)) return;
  try {
    const res = await fetch('/api/personen/' + pers.id, { method: 'DELETE' });
    const d = await res.json().catch(() => ({}));
    if (res.status === 409) {
      // Person hat Historie — Löschen würde sie aus alten Auswertungen tilgen.
      const h = d.historie || {};
      const treffer = `${h.abende || 0} Abende, ${h.besatzung || 0} Besatzungs-, ${h.pa || 0} PA-Einträge`;
      if (confirm(`${d.error}\n\nGefunden: ${treffer}\n\nJetzt stattdessen auf „nicht aktiv" setzen?`)) {
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
  } catch (err) { alert('Fehler: ' + err.message); }
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
        <button class="chip" data-act="edit">Bearbeiten</button>
        <button class="chip chip-danger" data-act="del">Löschen</button>
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
  if (!confirm(`Dienstart „${d.name}" löschen?`)) return;
  try {
    const res = await fetch('/api/dienstarten/' + d.id, { method: 'DELETE' });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(r.error || 'HTTP ' + res.status);
    await loadThemenView();
    await loadStaticData();
  } catch (err) { alert('Fehler: ' + err.message); }
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
          <button class="chip" data-act="edit">Bearbeiten</button>
          <button class="chip chip-danger" data-act="del">Löschen</button>
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
  if (!confirm(`Thema „${t.thema}" löschen?\n\nBereits erfasste Abende behalten das Thema als Text.`)) return;
  try {
    const res = await fetch('/api/themen/' + t.id, { method: 'DELETE' });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
    await loadThemenList();
    await loadStaticData();
  } catch (err) { alert('Fehler: ' + err.message); }
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
          <button class="chip" data-act="edit">Bearbeiten</button>
          <button class="chip chip-danger" data-act="del">Löschen</button>
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
  if (!confirm(`Tag „${tag.name}" wirklich löschen? Bestehende Zuordnungen werden mit gelöscht.`)) return;
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
    XLSX.writeFile(wb, `Anwesenheit_${today}.xlsx`);
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
  erfasser_anwesenheit:     'Erfasser (Anwesenheit)',
  admin_einsatzprotokoll:   'Admin (Einsatzprotokoll)',
  erfasser_einsatzprotokoll:'Erfasser (Einsatzprotokoll)',
};
function formatRoleLabel(role) { return ROLE_LABELS[role] || role; }
