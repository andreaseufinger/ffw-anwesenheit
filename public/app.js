// Anwesenheit — Frontend mit Login/Rollen

// App-spezifische Konstanten — diese App kennt nur ihre eigenen Rollen.
const APP_ROLE_ADMIN    = 'admin_anwesenheit';
const APP_ROLE_ERFASSER = 'erfasser_anwesenheit';
const APP_ROLES_SET     = new Set([APP_ROLE_ADMIN, APP_ROLE_ERFASSER]);

const STATE = {
  personen: [],
  dienstarten: [],
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
// Die Auswertung enthält Einsatzdaten und setzt Admin-Rechte in BEIDEN Apps
// voraus — der Endpunkt prüft das ebenfalls, hier geht es nur um die Anzeige.
function userDarfAuswerten() {
  const r = STATE.user?.roles || [];
  return r.includes('admin_anwesenheit') && r.includes('admin_einsatzprotokoll');
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
  else if (action === 'stammpersonen') showView('stammpersonen');
  else if (action === 'themen') showView('themen');
  else if (action === 'tags') showView('tags');
  else if (action === 'export') exportExcel();
  else if (action === 'logout') logout();
}

// --- Static Daten ---

function setDefaultDate() {
  const today = new Date();
  const iso = today.toISOString().slice(0, 10);
  $('#datum').value = iso;
}

async function loadStaticData() {
  const [pRes, tRes, tagRes] = await Promise.all([
    fetch('/api/personen'),
    // Themen kommen seit der Stammdaten-Umstellung aus D1 statt aus dem
    // Static-Asset /data/themen.json — damit im Admin pflegbar und nicht
    // mehr öffentlich abrufbar.
    fetch('/api/themen'),
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
  $('#zeit-von').value = '20:00';
  $('#zeit-bis').value = '21:30';
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
  if (STATE.user && !userIsAdmin() && !erfasserViews.has(view)) view = 'edit';
  STATE.view = view;
  $('#view-edit').classList.toggle('hidden', view !== 'edit');
  $('#view-history').classList.toggle('hidden', view !== 'history');
  $('#view-detail').classList.toggle('hidden', view !== 'detail');
  $('#view-users').classList.toggle('hidden', view !== 'users');
  $('#view-tags').classList.toggle('hidden', view !== 'tags');
  $('#view-auswertung').classList.toggle('hidden', view !== 'auswertung');
  $('#view-stammpersonen').classList.toggle('hidden', view !== 'stammpersonen');
  $('#view-themen').classList.toggle('hidden', view !== 'themen');
  $('#action-edit').classList.toggle('hidden', view !== 'edit');
  $('#action-detail').classList.toggle('hidden', view !== 'detail');
  updateHeaderTitle();
  if (view === 'history') loadHistory();
  if (view === 'users') loadUsers();
  if (view === 'tags') loadTagsView();
  if (view === 'auswertung') initAuswertung();
  if (view === 'stammpersonen') loadStammPersonen();
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
  $('#user-role-admin').checked    = currentRoles.has(APP_ROLE_ADMIN);
  $('#user-role-erfasser').checked = currentRoles.has(APP_ROLE_ERFASSER);

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
  if ($('#user-role-admin').checked)    selectedRoles.push(APP_ROLE_ADMIN);
  if ($('#user-role-erfasser').checked) selectedRoles.push(APP_ROLE_ERFASSER);

  try {
    if (STATE.editUserId) {
      const body = {};
      if (password) body.password = password;
      body.roles = selectedRoles;
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
        body: JSON.stringify({ username, password, roles: selectedRoles }),
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
      const res = await fetch('/api/personen?alle=1');
      if (res.ok) {
        for (const p of await res.json()) {
          const o = document.createElement('option');
          o.value = String(p.id);
          o.textContent = `${p.nachname}, ${p.vorname}` + (p.aktiv ? '' : ' (ausgetreten)');
          personSel.appendChild(o);
        }
      }
    } catch {}

    for (const id of ['#aus-jahr', '#aus-monat', '#aus-person']) {
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
  const url = `/api/auswertung?von=${von}&bis=${bis}` + (personId ? `&person_id=${personId}` : '');

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

  const k = (wert, label) =>
    `<div class="aus-kennzahl"><div class="k-wert">${wert}</div><div class="k-label">${label}</div></div>`;
  kz.innerHTML =
      k(d.durchschnitt.personen_pro_uebung ?? '–', 'Teilnehmer je Übung (Ø)')
    + k(d.durchschnitt.personen_pro_einsatz ?? '–', 'Teilnehmer je Einsatz (Ø)')
    + k(d.basis.uebungen, 'Übungen im Zeitraum')
    + k(d.basis.einsaetze, 'Einsätze im Zeitraum')
    + k(d.basis.aktive_personen, 'aktive Personen');

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
      <th>Person</th><th>Übung</th><th>Dienst</th><th>Sonstiges</th>
      <th>Einsatz</th><th>Gesamt</th>
    </tr></thead>`;
  const zeilen = d.personen.map((p) => {
    const klassen = [];
    if (p.aktiv === false) klassen.push('ist-inaktiv');
    if (p.person_id === null) klassen.push('ist-offen');
    return `<tr class="${klassen.join(' ')}">`
      + `<td>${escapeHtml(p.name)}${p.aktiv === false ? ' (ausgetreten)' : ''}</td>`
      + zelle(p.uebung) + zelle(p.dienst) + zelle(p.sonstiges)
      + zelle(p.einsatz) + zelle(p.gesamt)
      + '</tr>';
  }).join('');
  tab.innerHTML = kopf + `<tbody>${zeilen}</tbody>`;
}

async function exportAuswertung() {
  const d = STATE.auswertung;
  if (!d) return;
  try {
    const XLSX = await loadSheetJs();
    const rows = d.personen.map((p) => {
      const r = { Person: p.name, Status: p.aktiv === false ? 'ausgetreten' : (p.person_id === null ? 'nicht zuordenbar' : 'aktiv') };
      for (const [feld, label] of [['uebung','Übung'],['dienst','Dienst'],['sonstiges','Sonstiges'],['einsatz','Einsatz'],['gesamt','Gesamt']]) {
        r[`${label} Teilnahmen`] = p[feld].teilnahmen;
        // Dezimalstunden, damit in Excel gerechnet werden kann.
        r[`${label} Stunden`] = Math.round((p[feld].minuten / 60) * 100) / 100;
        r[`${label} ohne Zeit`] = p[feld].ohne_zeit;
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

// --- Stammdaten: Personen ---
// Gilt für beide Apps: die Tabelle `personen` wird vom Einsatzprotokoll
// mitgelesen. Austritte werden deaktiviert, nicht gelöscht.

async function loadStammPersonen() {
  const list = $('#stammpersonen-list');
  list.innerHTML = '';
  try {
    const res = await fetch('/api/personen?alle=1');
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'HTTP ' + res.status);
    const personen = await res.json();
    if (!personen.length) {
      list.innerHTML = '<p class="empty">Noch keine Personen eingetragen.</p>';
      return;
    }
    const aktive = personen.filter((p) => p.aktiv).length;
    const kopf = document.createElement('p');
    kopf.className = 'hint';
    kopf.textContent = `${personen.length} Personen, davon ${aktive} aktiv.`;
    list.appendChild(kopf);

    for (const pers of personen) {
      const li = document.createElement('li');
      li.className = 'user-item';
      const zeitraum = [pers.eintritt, pers.austritt].filter(Boolean).map(formatDate).join(' – ');
      li.innerHTML = `
        <div class="u-info">
          <div class="u-name">${pers.aktiv ? '' : '⏸ '}${escapeHtml(pers.nachname)}, ${escapeHtml(pers.vorname)}</div>
          <div class="u-role">${pers.aktiv ? 'aktiv' : 'nicht aktiv'}${zeitraum ? ' · ' + escapeHtml(zeitraum) : ''}</div>
        </div>
        <div class="u-actions">
          <button class="chip" data-act="edit">Bearbeiten</button>
          <button class="chip chip-danger" data-act="del">Löschen</button>
        </div>
      `;
      li.querySelector('[data-act="edit"]').addEventListener('click', () => openStammPersonDialog(pers));
      li.querySelector('[data-act="del"]').addEventListener('click', () => deleteStammPerson(pers));
      list.appendChild(li);
    }
  } catch (err) {
    list.innerHTML = `<p class="empty">Fehler: ${escapeHtml(err.message)}</p>`;
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
  $('#sp-error').classList.add('hidden');
  $('#sp-dialog').showModal();
}

async function saveStammPerson() {
  const errEl = $('#sp-error'); errEl.classList.add('hidden');
  const payload = {
    nachname: $('#sp-nachname').value.trim(),
    vorname:  $('#sp-vorname').value.trim(),
    eintritt: $('#sp-eintritt').value || null,
    austritt: $('#sp-austritt').value || null,
    aktiv:    $('#sp-aktiv').value === '1',
  };
  const id = STATE.editPersonId;
  try {
    const res = await fetch(id ? '/api/personen/' + id : '/api/personen', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await res.json().catch(() => ({}));
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
  await loadDienstartenList();
  await loadThemenList();
}

async function loadDienstartenList() {
  const list = $('#dienstarten-list');
  list.innerHTML = '';
  try {
    const res = await fetch('/api/dienstarten');
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'HTTP ' + res.status);
    STATE.dienstarten = await res.json();
    if (!STATE.dienstarten.length) {
      list.innerHTML = '<p class="empty">Noch keine Dienstarten angelegt.</p>';
      return;
    }
    for (const d of STATE.dienstarten) {
      const li = document.createElement('li');
      li.className = 'user-item';
      li.innerHTML = `
        <div class="u-info">
          <div class="u-name">${escapeHtml(d.name)}</div>
          <div class="u-role">${escapeHtml(kategorieLabel(d.kategorie))} · ${d.themen_anzahl} Themen · Sortierung ${d.sort_order}</div>
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
  } catch (err) {
    list.innerHTML = `<p class="empty">Fehler: ${escapeHtml(err.message)}</p>`;
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
  $('#da-error').classList.add('hidden');
  $('#da-dialog').showModal();
}

async function saveDienstart() {
  const errEl = $('#da-error'); errEl.classList.add('hidden');
  const payload = {
    name: $('#da-name').value.trim(),
    kategorie: $('#da-kategorie').value,
    sort_order: Number($('#da-sort').value) || 100,
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
  const list = $('#themen-list');
  list.innerHTML = '';
  try {
    const res = await fetch('/api/themen?alle=1');
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'HTTP ' + res.status);
    const themen = await res.json();
    if (!themen.length) {
      list.innerHTML = '<p class="empty">Noch keine Themen angelegt.</p>';
      return;
    }
    for (const t of themen) {
      const li = document.createElement('li');
      li.className = 'user-item';
      li.innerHTML = `
        <div class="u-info">
          <div class="u-name">${t.aktiv ? '' : '⏸ '}${escapeHtml(t.thema)}</div>
          <div class="u-role">${escapeHtml(t.dienstart)}${t.abteilung ? ' · ' + escapeHtml(t.abteilung) : ''} · Priorität ${t.prioritaet}</div>
        </div>
        <div class="u-actions">
          <button class="chip" data-act="edit">Bearbeiten</button>
          <button class="chip chip-danger" data-act="del">Löschen</button>
        </div>
      `;
      li.querySelector('[data-act="edit"]').addEventListener('click', () => openThemaDialog(t));
      li.querySelector('[data-act="del"]').addEventListener('click', () => deleteThema(t));
      list.appendChild(li);
    }
  } catch (err) {
    list.innerHTML = `<p class="empty">Fehler: ${escapeHtml(err.message)}</p>`;
  }
}

function openThemaDialog(t) {
  const isEdit = !!(t && t.id);
  STATE.editThemaId = isEdit ? t.id : null;
  const sel = $('#th-dienstart');
  sel.innerHTML = '';
  for (const d of (STATE.dienstarten || [])) {
    const o = document.createElement('option');
    o.value = String(d.id); o.textContent = d.name;
    sel.appendChild(o);
  }
  $('#th-dialog-title').textContent = isEdit ? `Thema bearbeiten` : 'Neues Thema';
  sel.value = isEdit ? String(t.dienstart_id) : (sel.options[0]?.value || '');
  $('#th-thema').value = isEdit ? t.thema : '';
  $('#th-abteilung').value = isEdit ? (t.abteilung || '') : '';
  $('#th-prio').value = isEdit ? t.prioritaet : 1;
  $('#th-aktiv').value = isEdit ? String(t.aktiv ? 1 : 0) : '1';
  $('#th-error').classList.add('hidden');
  $('#th-dialog').showModal();
}

async function saveThema() {
  const errEl = $('#th-error'); errEl.classList.add('hidden');
  const payload = {
    dienstart_id: Number($('#th-dienstart').value),
    thema: $('#th-thema').value.trim(),
    abteilung: $('#th-abteilung').value.trim() || null,
    prioritaet: Number($('#th-prio').value) || 1,
    aktiv: $('#th-aktiv').value === '1',
  };
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
