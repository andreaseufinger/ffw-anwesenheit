// Anwesenheit — Frontend mit Login/Rollen

// App-spezifische Konstanten — diese App kennt nur ihre eigenen Rollen.
const APP_ROLE_ADMIN    = 'admin_anwesenheit';
const APP_ROLE_ERFASSER = 'erfasser_anwesenheit';
const APP_ROLES_SET     = new Set([APP_ROLE_ADMIN, APP_ROLE_ERFASSER]);

const STATE = {
  personen: [],
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
    fetch('/data/themen.json'),
    fetch('/api/tags'),
  ]);
  if (pRes.status === 401) { showLogin(); return; }
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
  $('#action-edit').classList.toggle('hidden', view !== 'edit');
  $('#action-detail').classList.toggle('hidden', view !== 'detail');
  updateHeaderTitle();
  if (view === 'history') loadHistory();
  if (view === 'users') loadUsers();
  if (view === 'tags') loadTagsView();
}

function updateHeaderTitle() {
  const view = STATE.view;
  $('#header-title').textContent =
    view === 'history' ? 'Vorherige Anwesenheiten'
    : view === 'detail' ? 'Anwesenheit'
    : view === 'users' ? 'Benutzer'
    : view === 'tags' ? 'Tags'
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
