// Einsatzprotokoll FF Musterwehr — Frontend mit Live-Bearbeitung
//
// Bearbeitungsmodell:
// - Neuanlage: Klassisches "Speichern"-Pattern. Beim ersten Save wird der
//   Einsatz angelegt (POST), danach wechselt die App in den LIVE-Modus.
// - Live-Modus: Status `offen`. Jedes Feld speichert onBlur über einen
//   granularen Endpunkt. Polling alle 5 s synchronisiert Änderungen anderer
//   Clients (Felder mit Fokus werden nicht überschrieben).
// - Abschluss: Admin schließt den Einsatz; alle Felder werden read-only.

// App-spezifische Konstanten — diese App kennt nur ihre eigenen Rollen.
const APP_ROLE_ADMIN    = 'admin_einsatzprotokoll';
const APP_ROLE_ERFASSER = 'erfasser_einsatzprotokoll';
const APP_ROLE_LESER    = 'leser_einsatzprotokoll';
const APP_ROLES_SET     = new Set([APP_ROLE_ADMIN, APP_ROLE_ERFASSER, APP_ROLE_LESER]);

function userIsAdmin()    { return !!STATE?.user?.roles?.includes(APP_ROLE_ADMIN); }
function userIsErfasser() { return !!STATE?.user?.roles?.includes(APP_ROLE_ERFASSER); }
function userIsLeser()    { return !!STATE?.user?.roles?.includes(APP_ROLE_LESER); }
// Darf Einsätze bearbeiten (offene): Admin oder Erfasser.
function userCanWrite()   { return userIsAdmin() || userIsErfasser(); }
// Darf ALLE Einsätze sehen: Admin oder Leser.
function userCanSeeAll()  { return userIsAdmin() || userIsLeser(); }

const STATE = {
  user: null,
  view: 'edit',
  personen: [],
  fahrzeugeStamm: [],     // [{id, kennung, name, positionen[], sort_order, aktiv}]
  ffenStamm: [],
  currentId: null,
  currentEinsatz: null,   // gesamter Server-State des aktuellen Einsatzes
  knownUpdatedAt: null,   // für Polling
  pollTimer: null,
  // Form-State (nur für die Neuanlage; im Live-Modus ist currentEinsatz die Quelle)
  form: { ffIds: new Set(), fahrzeuge: [], pa: [], verunfallte: [] },
  editUserId: null,
  editFzId: null,
  editFfId: null,
};

const POLL_INTERVAL_MS = 5000;

// Feste Einsatzleiter (vor der Einsatzabteilung) und Vorschläge für den
// Einsatzort kommen aus wehr.js, weil sie je Wehr verschieden sind.
const EINSATZLEITER_ZUSATZ = window.FFW_EP?.einsatzleiter || [];

function personenNamen() {
  return STATE.personen.map((p) => `${p.vorname} ${p.nachname}`);
}

function einsatzleiterGruppen() {
  const zusatz = new Set(EINSATZLEITER_ZUSATZ);
  return [
    { label: 'Einsatzleiter', namen: EINSATZLEITER_ZUSATZ },
    { label: 'Einsatzabteilung', namen: personenNamen().filter((n) => !zusatz.has(n)) },
  ].filter((g) => g.namen.length);
}

const EINSATZORT_VORSCHLAEGE = window.FFW_EP?.einsatzorte || [];

const $ = (s) => document.querySelector(s);
// Liniensymbole im Raster des Design-Systems (24 x 24, Strich 2). Knöpfe mit
// Symbol tragen immer aria-label und title, das SVG ist aria-hidden.
const ICON_PFAD = {
  edit: 'M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3zM13.5 7.5l3 3',
  del: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
};
const ICON = Object.fromEntries(Object.entries(ICON_PFAD).map(([k, d]) =>
  [k, `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`]));

function iconBtn(act, label, klasse = '') {
  return `<button type="button" class="icon-btn ${klasse}" data-act="${act}" aria-label="${label}" title="${label}">${ICON[act]}</button>`;
}

const $$ = (s) => Array.from(document.querySelectorAll(s));

document.addEventListener('DOMContentLoaded', init);

async function init() {
  // Ausgeschaltetes Modul (public/module.js): Hinweis statt Anmeldung.
  if (window.FFW_MODULE?.einsatzprotokoll === false) {
    $('#login-screen').classList.add('hidden');
    $('#modul-aus').classList.remove('hidden');
    return;
  }
  bindEvents();
  setDefaultAlarm();
  await refreshAuth();
  beiRueckkehrNeuLaden();
}

// Bleibt die App im Hintergrund offen (iPad im Fahrzeug), friert iOS sie ein.
// Kommt sie zurück, stand bisher noch der alte Einsatz da. Nach mehr als einer
// Minute im Hintergrund deshalb so weitermachen wie bei einem frischen Start:
// laufenden Einsatz öffnen, sonst leeres Formular. Wer in der Übersicht oder
// Verwaltung war, bleibt dort; dort werden nur die Stammdaten aufgefrischt.
const RUECKKEHR_NEU_AB_MS = 60 * 1000;
function beiRueckkehrNeuLaden() {
  let verstecktSeit = null;
  const zurueck = async () => {
    const weg = verstecktSeit ? Date.now() - verstecktSeit : 0;
    verstecktSeit = null;
    if (weg < RUECKKEHR_NEU_AB_MS || !STATE.user) return;
    if (document.body.classList.contains('is-device') || STATE.view === 'edit') {
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      await refreshAuth();
    } else {
      await loadStaticData();
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') verstecktSeit = Date.now();
    else zurueck();
  });
  // Aus dem Seiten-Zwischenspeicher wiederhergestellt (Safari): wie Rückkehr
  window.addEventListener('pageshow', (e) => { if (e.persisted) { verstecktSeit = verstecktSeit || Date.now() - RUECKKEHR_NEU_AB_MS; zurueck(); } });
}

function bindEvents() {
  $('#login-form').addEventListener('submit', onLoginSubmit);

  $('#btn-menu').addEventListener('click', () => {
    const theme = $('#theme-' + (typeof getTheme === 'function' ? getTheme() : 'auto'));
    if (theme) theme.checked = true;
    $('#menu-overlay').classList.remove('hidden');
  });
  $('#btn-new').addEventListener('click', () => { stopPolling(); resetForm(); showView('edit'); closeMenu(); });
  $('#menu-overlay').addEventListener('click', (e) => { if (e.target.id === 'menu-overlay') closeMenu(); });
  $$('#menu-overlay .sheet-item').forEach((b) => b.addEventListener('click', () => onMenuAction(b.dataset.action)));

  $('#btn-save').addEventListener('click', saveInitial);
  $('#btn-back').addEventListener('click', () => { stopPolling(); showView('history'); });
  $('#btn-print').addEventListener('click', printEinsatz);

  $('#btn-add-pa').addEventListener('click', addPaRow);
  $('#btn-add-ver').addEventListener('click', addVerRow);
  $('#btn-abschliessen').addEventListener('click', toggleAbschluss);

  // Auto-Save Bindings für die Meta-Felder
  bindMetaAutoSave();

  // Aufgeschobene Übernahme fremder Änderungen nachholen, sobald niemand
  // mehr in einem Feld steht. Kurz warten: das Verlassen des Felds speichert
  // erst, und der nächste Fokus kann gleich im Nachbarfeld landen.
  $('#form-einsatz').addEventListener('focusout', () => {
    setTimeout(() => {
      if (STATE.reloadAusstehend && !benutzerArbeitet()) pollState();
    }, 800);
  });

  // Stammdaten / Benutzer
  $('#btn-fz-new').addEventListener('click', () => openFzDialog());
  $('#fz-cancel').addEventListener('click', () => $('#fz-dialog').close('cancel'));
  $('#fz-save').addEventListener('click', saveFzDialog);

  $('#btn-ff-new').addEventListener('click', () => openFfDialog());
  $('#ff-cancel').addEventListener('click', () => $('#ff-dialog').close('cancel'));
  $('#ff-save').addEventListener('click', saveFfDialog);

  $('#btn-user-new').addEventListener('click', () => openUserDialog());
  $('#btn-geraet-new').addEventListener('click', newGeraet);
  $('#btn-webhook-new').addEventListener('click', () => openWebhookDialog());
  $('#wh-cancel').addEventListener('click', () => $('#wh-dialog').close());
  $('#wh-save').addEventListener('click', saveWebhook);
  $('#enroll-close').addEventListener('click', () => $('#enroll-dialog').close());
  $('#enroll-copy').addEventListener('click', async () => {
    const field = $('#enroll-link');
    try {
      await navigator.clipboard.writeText(field.value);
      toast('Adresse kopiert', 'success');
    } catch {
      field.select();   // Fallback: Nutzer kopiert von Hand
    }
  });
  $('#user-cancel').addEventListener('click', () => $('#user-dialog').close('cancel'));
  $('#user-save').addEventListener('click', saveUserDialog);

  const elWahl = buildPersonenWahl({
    id: 'einsatzleiter', name: 'Einsatzleiter', leer: '– nicht eingetragen –',
    gruppen: einsatzleiterGruppen, onCommit: () => saveMetaField('einsatzleiter'),
  });
  $('#el-wahl').replaceWith(elWahl);
  STATE.elWahl = elWahl.personenwahl;
  setupCombo('einsatzort', 'eo-toggle', 'eo-list', () => saveMetaField('einsatzort'), () => EINSATZORT_VORSCHLAEGE);
}

function bindMetaAutoSave() {
  const fields = [
    ['alarm-datum', 'alarm_datum'],
    ['alarm-uhrzeit', 'alarm_uhrzeit'],
    ['alarmierte-einheit', 'alarmierte_einheit'],
    ['einsatzort', 'einsatzort'],
    ['einsatzgrund', 'einsatzgrund'],
    ['km-es', 'km_einsatzstelle'],
    ['km-gesamt', 'km_gesamt'],
    ['notizen', 'notizen'],
  ];
  for (const [domId, apiField] of fields) {
    const el = document.getElementById(domId);
    if (!el) continue;
    el.addEventListener('change', () => saveMetaField(apiField));
    el.addEventListener('blur', () => saveMetaField(apiField));
  }
  $('#erste-ff').addEventListener('change', () => saveMetaField('erste_ff_id'));
}

function closeMenu() { $('#menu-overlay').classList.add('hidden'); }

function onMenuAction(action) {
  closeMenu();
  if (action === 'hilfe') { location.href = '/hilfe/'; return; }
  if (action === 'logout') return logout();
  if (action === 'export') return exportExcel();
  if (action !== 'edit' && action !== 'history') stopPolling();
  if (['edit', 'history', 'fahrzeuge', 'ffen', 'users', 'geraete', 'webhooks'].includes(action)) showView(action);
}

function setDefaultAlarm() {
  const { datum, uhrzeit } = nowInBerlin();
  $('#alarm-datum').value = datum;
  $('#alarm-uhrzeit').value = uhrzeit;
}

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

// --- Auth ---

// Geräte-Benutzer (LF10, GW) melden sich ohne Benutzername/Passwort an. Der
// Device-Token aus der Ersteinrichtung liegt im localStorage und wird nur dann
// angefasst, wenn das Session-Cookie fehlt — im Normalbetrieb läuft alles über
// das HttpOnly-Cookie, an das kein JavaScript herankommt.
const DEVICE_TOKEN_KEY = 'ep_device_token';

function getDeviceToken() {
  try { return localStorage.getItem(DEVICE_TOKEN_KEY); } catch { return null; }
}
function clearDeviceToken() {
  try { localStorage.removeItem(DEVICE_TOKEN_KEY); } catch {}
}

// Stille Wiederanmeldung. Liefert das /me-Ergebnis oder null.
async function deviceReauth() {
  const token = getDeviceToken();
  if (!token) return null;
  try {
    const res = await fetch('/api/auth/device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (res.ok) return await res.json();
    // 401 = Token unbekannt (Gerät gelöscht/neu eingerichtet), 403 = gesperrt.
    // In beiden Fällen ist der gespeicherte Token wertlos.
    if (res.status === 401 || res.status === 403) clearDeviceToken();
  } catch {}
  return null;
}

// fetch mit automatischer Wiederanmeldung: läuft die Session unterwegs ab,
// meldet sich ein Gerät einmal still neu an und der Request wird wiederholt.
// Alle Bodies hier sind Strings, lassen sich also gefahrlos erneut senden.
async function apiFetch(input, init) {
  let res = await fetch(input, init);
  if (res.status === 401 && getDeviceToken()) {
    const me = await deviceReauth();
    if (me) res = await fetch(input, init);
  }
  return res;
}

async function refreshAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) { await onLoggedIn(await res.json()); return; }
  } catch {}
  const me = await deviceReauth();
  if (me) { await onLoggedIn(me); return; }
  showLogin();
}
function showLogin() {
  STATE.user = null;
  stopPolling();
  $('#login-screen').classList.remove('hidden');
  $('#app').classList.add('hidden');
  $('#login-pass').value = '';
}
async function onLoggedIn(me) {
  STATE.user = me;
  const isAdmin = userIsAdmin();
  const isErf = userIsErfasser();
  const canWrite = userCanWrite();
  document.body.classList.toggle('is-admin', isAdmin);
  document.body.classList.toggle('is-erfasser', isErf && !isAdmin);
  // Admin + Leser sehen alle Einsätze → dürfen exportieren.
  document.body.classList.toggle('can-see-all', userCanSeeAll());
  // Nicht-Schreiber (reine Leser) dürfen keinen neuen Einsatz anlegen.
  $('#btn-new').classList.toggle('hidden', !canWrite);
  const menuErfassen = $('#menu-overlay [data-action="edit"]');
  if (menuErfassen) menuErfassen.classList.toggle('hidden', !canWrite);
  $('#menu-username').textContent = me.username;
  // Am Gerät soll unmissverständlich sichtbar sein, dass Eingaben auf das
  // Fahrzeug laufen und nicht auf eine Person.
  document.body.classList.toggle('is-device', !!me.is_device);
  $('#device-badge').textContent = me.is_device ? me.username : '';
  $('#menu-role').textContent = me.is_device
    ? 'Gerät'
    : (isAdmin ? 'Admin' : (isErf ? 'Erfasser' : 'Leser'));
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  await loadStaticData();

  // Reine Leser haben kein Erfassungsformular — direkt in die Übersicht.
  if (!canWrite) {
    showView('history');
    return;
  }

  // Wenn ein offener Einsatz existiert, direkt hineinspringen statt ein
  // leeres Formular zu zeigen — so kann man aus dem Alarm-Webhook nahtlos
  // weiterarbeiten und niemand legt versehentlich einen Doppel-Einsatz an.
  const laufender = await findOffenenEinsatz();
  if (laufender) {
    await openEinsatz(laufender.id);
    toast('Laufender Einsatz geladen', 'success');
  } else {
    resetForm();
    showView('edit');
  }
}

async function findOffenenEinsatz() {
  try {
    const res = await apiFetch('/api/einsaetze');
    if (!res.ok) return null;
    const items = await res.json();
    // Liste kommt sortiert nach alarm_datum DESC — erster offener ist der neueste Alarm.
    return items.find((e) => e.status === 'offen') || null;
  } catch { return null; }
}
async function onLoginSubmit(e) {
  e.preventDefault();
  const username = $('#login-user').value.trim();
  const password = $('#login-pass').value;
  const errEl = $('#login-error'); errEl.classList.add('hidden');
  const btn = $('#login-submit'); btn.disabled = true; btn.textContent = 'Anmelden …';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      errEl.textContent = res.status === 401 ? 'Benutzername oder Passwort falsch.'
        : res.status === 403 ? 'Dieses Konto hat keinen Zugang zum Einsatzprotokoll.'
        : res.status === 429 ? (d.error || 'Zu viele Fehlversuche. Bitte später erneut versuchen.')
        : 'Anmeldung fehlgeschlagen: ' + (d.error || `HTTP ${res.status}`);
      errEl.classList.remove('hidden');
      return;
    }
    await onLoggedIn(await res.json());
  } catch (err) {
    errEl.textContent = 'Keine Verbindung: ' + err.message; errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = 'Anmelden';
  }
}
async function logout() {
  // Auf einem Geräte-Tablet würde die stille Wiederanmeldung sonst sofort
  // greifen. Abmelden heißt dort: Gerät abmelden, neue Einrichtung nötig.
  if (document.body.classList.contains('is-device')) {
    const ok = await bestaetigen(
      'Dieses Gerät abmelden?\n\n' +
      'Die automatische Anmeldung geht dabei verloren — das Gerät muss danach ' +
      'vom Administrator neu eingerichtet werden.',
      { ok: 'Abmelden' }
    );
    if (!ok) return;
    clearDeviceToken();
  }
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
  document.body.classList.remove('is-device');
  showLogin();
}

// --- Stammdaten ---

async function loadStaticData() {
  const [pRes, fzRes, ffRes] = await Promise.all([
    apiFetch('/api/einsaetze/personen'),
    apiFetch('/api/fahrzeuge'),
    apiFetch('/api/ffen'),
  ]);
  if (pRes.status === 401) { showLogin(); return; }
  STATE.personen = await pRes.json();
  // Atemschutztauglichkeit für Hinweise in der PA-Liste. Darf den Start nie
  // aufhalten: ohne Antwort gibt es einfach keine Hinweise.
  apiFetch('/api/agt-status').then((r) => (r.ok ? r.json() : null)).then((d) => {
    STATE.agt = d && d.aktiv ? new Map(d.personen.map((p) => [p.name.toLowerCase(), p])) : null;
    if (STATE.form?.pa?.length) renderPaList();
  }).catch(() => {});
  STATE.personen.sort((a, b) => a.vorname.localeCompare(b.vorname, 'de') || a.nachname.localeCompare(b.nachname, 'de'));
  STATE.elWahl.aktualisieren();
  STATE.fahrzeugeStamm = fzRes.ok ? await fzRes.json() : [];
  STATE.ffenStamm = ffRes.ok ? await ffRes.json() : [];
  renderFfenChecklist();
  renderErsteFfSelect();
  renderFahrzeugeForm();
}

// --- Views ---

function showView(view) {
  const erfasserViews = new Set(['edit', 'history']);
  if (STATE.user && !userIsAdmin() && !erfasserViews.has(view)) view = 'edit';
  STATE.view = view;
  ['edit', 'history', 'fahrzeuge', 'ffen', 'users', 'geraete', 'webhooks'].forEach((v) => {
    const el = document.getElementById('view-' + v);
    if (el) el.classList.toggle('hidden', v !== view);
  });
  $('#action-edit').classList.toggle('hidden', view !== 'edit');
  updateHeaderTitle();
  if (view === 'history') loadHistory();
  if (view === 'fahrzeuge') loadFzStamm();
  if (view === 'ffen') loadFfStamm();
  if (view === 'users') loadUsers();
  if (view === 'geraete') loadGeraete();
  if (view === 'webhooks') loadWebhooks();
  kopfTitelPruefen();
}

function updateHeaderTitle() {
  $('#header-title').textContent =
    STATE.view === 'history' ? 'Verlauf'
    : STATE.view === 'fahrzeuge' ? 'Fahrzeuge'
    : STATE.view === 'ffen' ? 'Nachbar-FFen'
    : STATE.view === 'webhooks' ? 'Webhooks'
    : STATE.view === 'geraete' ? 'Geräte'
    : STATE.view === 'users' ? 'Benutzer'
    : STATE.currentId ? (STATE.currentEinsatz?.einsatzgrund || 'Einsatz bearbeiten') : 'Neuer Einsatz';
}

// --- Initial-Save (Neuanlage) ---

function collectForCreate() {
  const fahrzeuge = STATE.form.fahrzeuge.map((f) => ({
    fahrzeug_id: f.fahrzeug_id,
    ende_datum: f.ende_datum || null,
    ende_uhrzeit: f.ende_uhrzeit || null,
    besatzung: Object.entries(f.besatzung || {})
      .filter(([, name]) => name && name.trim())
      .map(([position, name]) => {
        const parts = name.trim().split(/\s+/);
        return { position, person_vorname: parts[0] || '', person_nachname: parts.slice(1).join(' ') };
      }),
  }));
  return {
    alarm_datum: $('#alarm-datum').value,
    alarm_uhrzeit: $('#alarm-uhrzeit').value,
    alarmierte_einheit: $('#alarmierte-einheit').value.trim(),
    einsatzort: $('#einsatzort').value.trim(),
    einsatzgrund: $('#einsatzgrund').value.trim(),
    einsatzleiter: STATE.elWahl.wert(),
    km_einsatzstelle: $('#km-es').value || null,
    km_gesamt: $('#km-gesamt').value || null,
    erste_ff_id: Number($('#erste-ff').value) || null,
    notizen: $('#notizen').value.trim(),
    ff_ids: [...STATE.form.ffIds],
    fahrzeuge,
    pa: STATE.form.pa.filter((p) => p.person_vorname || p.person_nachname),
    verunfallte: (STATE.form.verunfallte || []).map((v) => typeof v === 'string' ? v : v.kennzeichen).filter(Boolean),
  };
}

async function saveInitial() {
  const payload = collectForCreate();
  if (!payload.alarm_datum || !payload.alarm_uhrzeit) {
    toast('Alarm-Datum und Uhrzeit erforderlich', 'error'); return;
  }
  const btn = $('#btn-save'); btn.disabled = true; btn.setAttribute('aria-busy', 'true');
  try {
    const res = await apiFetch('/api/einsaetze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error(await res.text());
    const { id } = await res.json();
    STATE.currentId = id;
    STATE.speicher = { zuletzt: Date.now(), fehler: false };
    // direkt in den Live-Modus wechseln (server ist nun Quelle der Wahrheit)
    await loadFullEinsatz(id);
    startPolling();
    toast('Einsatz erfasst — Live-Bearbeitung aktiv', 'success');
  } catch (err) {
    toast('Fehler: ' + err.message, 'error');
  } finally {
    btn.disabled = false; btn.removeAttribute('aria-busy');
  }
}

// --- Live-Modus: Einsatz laden + rendern ---

async function loadFullEinsatz(id) {
  const res = await apiFetch('/api/einsaetze/' + id);
  if (res.status === 401) { showLogin(); return; }
  if (!res.ok) throw new Error(await res.text());
  const e = await res.json();
  STATE.currentEinsatz = e;
  STATE.knownUpdatedAt = e.updated_at;
  fillFormFromEinsatz(e, { preserveFocus: false });
  updateLiveBanner();
}

function fillFormFromEinsatz(e, { preserveFocus }) {
  const focused = preserveFocus ? document.activeElement : null;
  function setVal(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    if (preserveFocus && el === focused) return;
    el.value = value ?? '';
  }
  setVal('alarm-datum', e.alarm_datum);
  setVal('alarm-uhrzeit', e.alarm_uhrzeit);
  setVal('alarmierte-einheit', e.alarmierte_einheit);
  setVal('einsatzort', e.einsatzort);
  setVal('einsatzgrund', e.einsatzgrund);
  if (!(preserveFocus && STATE.elWahl.enthaeltFokus())) STATE.elWahl.setzen(e.einsatzleiter);
  setVal('km-es', e.km_einsatzstelle);
  setVal('km-gesamt', e.km_gesamt);
  setVal('notizen', e.notizen);
  setVal('erste-ff', e.erste_ff_id || '');

  STATE.form.ffIds = new Set(e.ff_ids || []);

  // Fahrzeuge: ef_id-tracking, ende_datum/uhrzeit, besatzung
  STATE.form.fahrzeuge = (e.fahrzeuge || []).map((f) => {
    const besatzung = {};
    for (const b of (f.besatzung || [])) {
      besatzung[b.position] = [b.person_vorname, b.person_nachname].filter(Boolean).join(' ');
    }
    return {
      ef_id: f.id,
      fahrzeug_id: f.fahrzeug_id,
      ende_datum: f.ende_datum || '',
      ende_uhrzeit: f.ende_uhrzeit || '',
      besatzung,
    };
  });

  STATE.form.pa = (e.pa || []).map((p) => ({
    pa_id: p.id,
    person_vorname: p.person_vorname || '',
    person_nachname: p.person_nachname || '',
    dauer_minuten: p.dauer_minuten,
  }));
  STATE.form.verunfallte = (e.verunfallte || []).map((v) => ({
    v_id: v.id,
    kennzeichen: v.kennzeichen || '',
  }));

  renderFfenChecklist();
  renderErsteFfSelect();
  renderFahrzeugeForm();
  renderPaList();
  renderVerList();
  applyStatusToForm();
  updateHeaderTitle();
}

function applyStatusToForm() {
  const e = STATE.currentEinsatz;
  // Read-only, wenn abgeschlossen ODER der Nutzer kein Schreibrecht hat (Leser).
  const readonly = !userCanWrite() || (e && e.status === 'abgeschlossen');
  const form = $('#form-einsatz');
  if (!form) return;
  $$('#form-einsatz input, #form-einsatz select, #form-einsatz textarea, #form-einsatz button').forEach((el) => {
    el.disabled = !!readonly;
  });
  // "Neuer Einsatz"-Button im Header bleibt aktiv
  // PA + Verunfallte add buttons
  $('#btn-add-pa').disabled = !!readonly;
  $('#btn-add-ver').disabled = !!readonly;

  // Action-Footer: Save-Button nur für Schreiber in der Neuanlage anzeigen.
  if (STATE.currentId || !userCanWrite()) {
    $('#btn-save').classList.add('hidden');
  } else {
    $('#btn-save').classList.remove('hidden');
  }
}

function updateLiveBanner() {
  updateHeaderTitle();
  const banner = $('#live-banner');
  const e = STATE.currentEinsatz;
  // Drucken: nur für Admin/Leser (seeall-only, siehe CSS) und nur bei geöffnetem Protokoll.
  $('#btn-print').classList.toggle('hidden', !STATE.currentId);
  if (!STATE.currentId || !e) {
    banner.classList.add('hidden');
    // Ohne geöffneten Einsatz gibt es nichts abzuschließen. Sonst bliebe der
    // Knopf vom zuvor geöffneten Einsatz im leeren Formular stehen.
    $('#btn-abschliessen').classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
  if (e.status === 'abgeschlossen') {
    banner.className = 'live-banner closed';
    const by = e.abgeschlossen_by ? ` von ${escapeHtml(e.abgeschlossen_by)}` : '';
    const mig = e.migriert_quelle
      ? ` · nachgetragen aus: ${escapeHtml(e.migriert_quelle)}`
      : '';
    banner.innerHTML = `<strong>Abgeschlossen</strong>${by}${e.abgeschlossen_at ? ' · ' + formatSqlDateTime(e.abgeschlossen_at) : ''}${mig}`;
  } else if (!userCanWrite()) {
    // Leser: offener Einsatz, aber nur Ansicht.
    banner.className = 'live-banner closed';
    banner.innerHTML = `<strong>Nur-Lese-Ansicht</strong> · dieser Einsatz wird gerade bearbeitet`;
  } else {
    const sp = STATE.speicher || {};
    if (sp.fehler || STATE.offline) {
      banner.className = 'live-banner warn';
      banner.innerHTML = `<strong>Nicht gespeichert</strong> · ${STATE.offline ? 'keine Verbindung' : 'letzte Änderung fehlgeschlagen'}${sp.zuletzt ? ' · zuletzt gespeichert ' + vorWieLange(sp.zuletzt) : ''}`;
    } else {
      banner.className = 'live-banner open';
      banner.innerHTML = `<span class="live-punkt" aria-hidden="true"></span><strong>Live</strong> · ${sp.zuletzt ? 'gespeichert ' + vorWieLange(sp.zuletzt) : 'Änderungen werden automatisch gespeichert'}`;
    }
  }
  // Admin-Button beschriften
  const adminBtn = $('#btn-abschliessen');
  if (userIsAdmin()) {
    adminBtn.classList.remove('hidden');
    adminBtn.textContent = e.status === 'abgeschlossen' ? 'Wieder öffnen' : 'Abschließen';
    adminBtn.className = 'btn-' + (e.status === 'abgeschlossen' ? 'secondary' : 'danger');
  } else {
    adminBtn.classList.add('hidden');
  }
}

// --- Polling ---

function startPolling() {
  stopPolling();
  if (!STATE.currentId) return;
  STATE.pollTimer = setInterval(pollState, POLL_INTERVAL_MS);
  // Anzeige "gespeichert vor … s" jede Sekunde nachführen
  STATE.statusTimer = setInterval(updateLiveBanner, 1000);
}

// Speicherstatus für den Live-Hinweis. Die meisten Schreibaufrufe sind
// "silent" (kein Toast je Feld); ohne diese Anzeige bliebe ein Funkloch
// unbemerkt.
function speicherStatus(ok) {
  if (!STATE.currentId) return;
  STATE.speicher = ok ? { zuletzt: Date.now(), fehler: false } : { ...(STATE.speicher || {}), fehler: true };
  updateLiveBanner();
}
function vorWieLange(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `vor ${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `vor ${m} min` : 'vor über einer Stunde';
}
function stopPolling() {
  if (STATE.pollTimer) { clearInterval(STATE.pollTimer); STATE.pollTimer = null; }
  if (STATE.statusTimer) { clearInterval(STATE.statusTimer); STATE.statusTimer = null; }
}
// Fokus in einem Eingabefeld des Formulars = jemand arbeitet gerade daran.
function benutzerArbeitet() {
  const a = document.activeElement;
  const form = document.getElementById('form-einsatz');
  return !!a && !!form && form.contains(a) && a.matches('input, textarea, select');
}

async function pollState() {
  if (!STATE.currentId) { stopPolling(); return; }
  if (STATE.view !== 'edit') return;
  try {
    const res = await apiFetch('/api/einsaetze/' + STATE.currentId + '/state');
    if (!res.ok) return;
    if (STATE.offline) { STATE.offline = false; updateLiveBanner(); }
    const s = await res.json();
    if (s.updated_at !== STATE.knownUpdatedAt || STATE.reloadAusstehend) {
      // Wer gerade tippt oder eine Auswahlliste offen hat, wird nicht
      // unterbrochen: der Neuaufbau zerstörte das Feld und klappte die Liste
      // zu, sobald ein zweites Gerät speicherte. Nachgeholt wird beim
      // Verlassen des Felds (siehe bindEvents).
      if (benutzerArbeitet()) { STATE.reloadAusstehend = true; return; }
      STATE.reloadAusstehend = false;
      // jemand anderes hat geändert → vollen Reload, ohne fokussierte Felder zu überschreiben
      const fullRes = await apiFetch('/api/einsaetze/' + STATE.currentId);
      if (!fullRes.ok) return;
      const full = await fullRes.json();
      STATE.currentEinsatz = full;
      STATE.knownUpdatedAt = full.updated_at;
      fillFormFromEinsatz(full, { preserveFocus: true });
      updateLiveBanner();
    }
  } catch {
    if (!STATE.offline) { STATE.offline = true; updateLiveBanner(); }
  }
}

// --- Granulare Saves ---

// Live = offener Einsatz UND Schreibrecht. Reine Leser sind nie „live", damit
// keine granularen Save-Calls (die serverseitig 403 lieferten) abgesetzt werden.
function isLive() { return userCanWrite() && STATE.currentId && STATE.currentEinsatz && STATE.currentEinsatz.status === 'offen'; }

async function saveMetaField(field) {
  if (!isLive()) return;
  const map = {
    alarm_datum: () => $('#alarm-datum').value,
    alarm_uhrzeit: () => $('#alarm-uhrzeit').value,
    alarmierte_einheit: () => $('#alarmierte-einheit').value.trim(),
    einsatzort: () => $('#einsatzort').value.trim(),
    einsatzgrund: () => $('#einsatzgrund').value.trim(),
    einsatzleiter: () => STATE.elWahl.wert(),
    km_einsatzstelle: () => $('#km-es').value || null,
    km_gesamt: () => $('#km-gesamt').value || null,
    notizen: () => $('#notizen').value.trim(),
    erste_ff_id: () => Number($('#erste-ff').value) || null,
  };
  if (!map[field]) return;
  const payload = { [field]: map[field]() };
  await sendJson('/api/einsaetze/' + STATE.currentId + '/meta', 'PUT', payload, true);
}

async function saveFfenVorOrt() {
  if (!isLive()) return;
  await sendJson('/api/einsaetze/' + STATE.currentId + '/ffen-vor-ort', 'PUT',
    { ff_ids: [...STATE.form.ffIds] }, true);
}

async function addFahrzeug(fahrzeugId) {
  if (!isLive()) return null;
  const res = await sendJson('/api/einsaetze/' + STATE.currentId + '/fahrzeuge', 'POST', { fahrzeug_id: fahrzeugId });
  if (!res) return null;
  return res.id;
}
async function removeFahrzeug(efId) {
  if (!isLive()) return;
  await sendJson('/api/einsaetze/' + STATE.currentId + '/fahrzeuge/' + efId, 'DELETE', null, true);
}
async function saveFahrzeugEnde(efId, ende_datum, ende_uhrzeit) {
  if (!isLive()) return;
  await sendJson('/api/einsaetze/' + STATE.currentId + '/fahrzeuge/' + efId, 'PUT',
    { ende_datum, ende_uhrzeit }, true);
}
async function saveBesatzung(efId, besatzungObj) {
  if (!isLive()) return;
  const besatzung = Object.entries(besatzungObj || {})
    .filter(([, name]) => name && name.trim())
    .map(([position, name]) => {
      const parts = name.trim().split(/\s+/);
      return { position, person_vorname: parts[0] || '', person_nachname: parts.slice(1).join(' ') };
    });
  await sendJson('/api/einsaetze/' + STATE.currentId + '/fahrzeuge/' + efId, 'PUT', { besatzung }, true);
}

async function createPa() {
  if (!isLive()) return null;
  const res = await sendJson('/api/einsaetze/' + STATE.currentId + '/pa', 'POST', {});
  return res?.id || null;
}
async function savePa(paId, fields) {
  if (!isLive()) return;
  await sendJson('/api/einsaetze/' + STATE.currentId + '/pa/' + paId, 'PUT', fields, true);
}
async function deletePa(paId) {
  if (!isLive()) return;
  await sendJson('/api/einsaetze/' + STATE.currentId + '/pa/' + paId, 'DELETE', null, true);
}

async function createVer() {
  if (!isLive()) return null;
  const res = await sendJson('/api/einsaetze/' + STATE.currentId + '/verunfallte', 'POST', { kennzeichen: '' });
  return res?.id || null;
}
async function saveVer(vId, kennzeichen) {
  if (!isLive()) return;
  await sendJson('/api/einsaetze/' + STATE.currentId + '/verunfallte/' + vId, 'PUT', { kennzeichen }, true);
}
async function deleteVer(vId) {
  if (!isLive()) return;
  await sendJson('/api/einsaetze/' + STATE.currentId + '/verunfallte/' + vId, 'DELETE', null, true);
}

async function sendJson(url, method, body, silent = false) {
  try {
    const opts = { method, headers: {} };
    if (body !== null && body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await apiFetch(url, opts);
    if (res.status === 401) { showLogin(); return null; }
    if (res.status === 409) {
      // Einsatz wurde gerade abgeschlossen
      toast('Einsatz ist abgeschlossen — keine Änderung gespeichert.', 'error');
      await loadFullEinsatz(STATE.currentId); // Form aktualisieren
      return null;
    }
    if (!res.ok) {
      const text = await res.text();
      speicherStatus(false);
      if (!silent) toast('Fehler: ' + text, 'error');
      return null;
    }
    const data = await res.json().catch(() => ({}));
    // Den neuen Stand NICHT als bekannt übernehmen: hat zwischendurch ein
    // anderes Gerät gespeichert, steckt dessen Änderung im neuen updated_at
    // und würde sonst nie angezeigt. Der nächste Abgleich lädt neu — außer
    // jemand steht gerade in einem Feld, dann wartet er (benutzerArbeitet).
    speicherStatus(true);
    return data;
  } catch (err) {
    speicherStatus(false);
    if (!silent) toast('Netzwerkfehler: ' + err.message, 'error');
    return null;
  }
}

// --- Abschluss / Wieder öffnen ---

async function toggleAbschluss() {
  if (!STATE.currentId) return;
  const closing = STATE.currentEinsatz?.status === 'offen';
  const verb = closing ? 'abschließen' : 'wieder öffnen';
  if (!await bestaetigen(`Einsatz wirklich ${verb}?`, { ok: closing ? 'Abschließen' : 'Wieder öffnen', gefahr: closing })) return;
  try {
    const res = await apiFetch('/api/einsaetze/' + STATE.currentId + '/abschluss', {
      method: closing ? 'POST' : 'DELETE',
    });
    if (!res.ok) throw new Error(await res.text());
    await loadFullEinsatz(STATE.currentId);
    toast(closing ? 'Einsatz abgeschlossen' : 'Einsatz wieder geöffnet', 'success');
  } catch (err) {
    toast('Fehler: ' + err.message, 'error');
  }
}

// --- Render Form-Subsections ---

function renderFfenChecklist() {
  const list = $('#ffen-checklist'); list.innerHTML = '';
  const active = STATE.ffenStamm.filter((f) => f.aktiv);
  if (!active.length) { list.innerHTML = '<li class="empty-small">Noch keine FFen konfiguriert.</li>'; return; }
  for (const ff of active) {
    const li = document.createElement('li');
    const lbl = document.createElement('label'); lbl.className = 'tag-check-row';
    const cb = document.createElement('input'); cb.type = 'checkbox';
    cb.checked = STATE.form.ffIds.has(ff.id);
    cb.addEventListener('change', () => {
      if (cb.checked) STATE.form.ffIds.add(ff.id); else STATE.form.ffIds.delete(ff.id);
      saveFfenVorOrt();
    });
    const span = document.createElement('span'); span.textContent = `${ff.kuerzel} — ${ff.name}`;
    lbl.appendChild(cb); lbl.appendChild(span);
    li.appendChild(lbl); list.appendChild(li);
  }
}

function renderErsteFfSelect() {
  const sel = $('#erste-ff');
  const current = sel.value;
  sel.innerHTML = '<option value="">— keine —</option>';
  for (const ff of STATE.ffenStamm.filter((f) => f.aktiv)) {
    const opt = document.createElement('option');
    opt.value = ff.id; opt.textContent = `${ff.kuerzel} — ${ff.name}`;
    sel.appendChild(opt);
  }
  if (current) sel.value = current;
}

function renderFahrzeugeForm() {
  const list = $('#fahrzeuge-list'); list.innerHTML = '';
  const active = STATE.fahrzeugeStamm.filter((f) => f.aktiv);
  if (!active.length) { list.innerHTML = '<li class="empty-small">Noch keine Fahrzeuge konfiguriert.</li>'; return; }

  for (const fz of active) {
    const existing = STATE.form.fahrzeuge.find((f) => f.fahrzeug_id === fz.id);
    const used = !!existing;

    const li = document.createElement('li'); li.className = 'fahrzeug-card';

    const head = document.createElement('div'); head.className = 'fahrzeug-head';
    const lbl = document.createElement('label'); lbl.className = 'tag-check-row';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = used;
    cb.addEventListener('change', async () => {
      if (cb.checked) {
        if (isLive()) {
          const newId = await addFahrzeug(fz.id);
          if (newId == null) { cb.checked = false; return; }
          STATE.form.fahrzeuge.push({ ef_id: newId, fahrzeug_id: fz.id, ende_datum: '', ende_uhrzeit: '', besatzung: {} });
        } else {
          STATE.form.fahrzeuge.push({ fahrzeug_id: fz.id, ende_datum: '', ende_uhrzeit: '', besatzung: {} });
        }
      } else {
        const idx = STATE.form.fahrzeuge.findIndex((f) => f.fahrzeug_id === fz.id);
        if (idx >= 0) {
          const item = STATE.form.fahrzeuge[idx];
          if (isLive() && item.ef_id) await removeFahrzeug(item.ef_id);
          STATE.form.fahrzeuge.splice(idx, 1);
          toastRueckgaengig(`${fz.name} mit Besatzung entfernt`, async () => {
            const kopie = { ...item, besatzung: { ...item.besatzung } };
            if (isLive()) {
              const newId = await addFahrzeug(fz.id);
              if (newId == null) return;
              kopie.ef_id = newId;
              if (kopie.ende_datum || kopie.ende_uhrzeit) await saveFahrzeugEnde(newId, kopie.ende_datum || null, kopie.ende_uhrzeit || null);
              await saveBesatzung(newId, kopie.besatzung);
            }
            STATE.form.fahrzeuge.push(kopie);
            renderFahrzeugeForm();
          });
        }
      }
      renderFahrzeugeForm();
    });
    const sp = document.createElement('span'); sp.innerHTML = `<strong>${escapeHtml(fz.name)}</strong> <span class="muted">(${escapeHtml(fz.kennung)})</span>`;
    lbl.appendChild(cb); lbl.appendChild(sp); head.appendChild(lbl);
    li.id = 'fz-karte-' + fz.id;
    if (used) {
      const besetzt = document.createElement('span');
      besetzt.className = 'fz-besetzt';
      besetzt.dataset.fz = fz.id;
      head.appendChild(besetzt);
    }
    li.appendChild(head);

    if (used) {
      const body = document.createElement('div'); body.className = 'fahrzeug-body';

      const endeRow = document.createElement('div'); endeRow.className = 'row-2';
      endeRow.innerHTML = `
        <div class="field"><label>Einsatzende Datum</label><input type="date" value="${escapeAttr(existing.ende_datum || '')}" /></div>
        <div class="field"><label>Einsatzende Uhrzeit</label><input type="time" value="${escapeAttr(existing.ende_uhrzeit || '')}" /></div>
      `;
      const [endeDatumInp, endeZeitInp] = endeRow.querySelectorAll('input');
      const onEndeBlur = () => {
        existing.ende_datum = endeDatumInp.value;
        existing.ende_uhrzeit = endeZeitInp.value;
        if (isLive() && existing.ef_id) saveFahrzeugEnde(existing.ef_id, existing.ende_datum || null, existing.ende_uhrzeit || null);
      };
      endeDatumInp.addEventListener('change', onEndeBlur);
      endeZeitInp.addEventListener('change', onEndeBlur);
      body.appendChild(endeRow);

      const besTitle = document.createElement('div'); besTitle.className = 'subsection-title'; besTitle.textContent = 'Besatzung';
      body.appendChild(besTitle);

      const grid = document.createElement('div'); grid.className = 'besatzung-grid';
      for (const pos of fz.positionen) {
        const row = document.createElement('div'); row.className = 'besatzung-row';
        const label = document.createElement('div'); label.className = 'pos-label'; label.textContent = pos;
        const combo = buildPersonenWahl({
          wert: existing.besatzung[pos] || '', name: `${fz.name} ${pos}`, leer: '– frei –',
          gruppen: () => [{ namen: personenNamen() }],
          onCommit: (value) => {
            existing.besatzung[pos] = value;
            updateStaerke();
            if (isLive() && existing.ef_id) saveBesatzung(existing.ef_id, existing.besatzung);
          },
        });
        row.appendChild(label); row.appendChild(combo); grid.appendChild(row);
      }
      body.appendChild(grid);
      li.appendChild(body);
    }
    list.appendChild(li);
  }
  updateStaerke();
  applyStatusToForm();
}

// Stärkemeldung Verbandsführer/Unterführer/Mannschaft/Gesamt je Fahrzeug und
// in Summe, aus den besetzten Positionen. Zuordnung über das Positionskürzel.
const POS_VERBANDSFUEHRER = new Set(['ZF', 'VF', 'BF']);
const POS_UNTERFUEHRER = new Set(['GF', 'STF', 'ZTF']);
function staerkeVon(besatzung) {
  const st = [0, 0, 0];
  for (const [pos, name] of Object.entries(besatzung || {})) {
    if (!name || !name.trim()) continue;
    const p = pos.toUpperCase();
    st[POS_VERBANDSFUEHRER.has(p) ? 0 : POS_UNTERFUEHRER.has(p) ? 1 : 2]++;
  }
  return [...st, st[0] + st[1] + st[2]];
}
function updateStaerke() {
  const leiste = $('#staerke-leiste');
  const eingesetzt = STATE.form.fahrzeuge
    .map((f) => ({ f, fz: STATE.fahrzeugeStamm.find((x) => x.id === f.fahrzeug_id) }))
    .filter((x) => x.fz);
  leiste.classList.toggle('hidden', !eingesetzt.length);
  leiste.innerHTML = '';
  const summe = [0, 0, 0, 0];
  const neu = {};
  for (const { f, fz } of eingesetzt) {
    const st = staerkeVon(f.besatzung);
    st.forEach((v, i) => { summe[i] += v; });
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'staerke';
    b.title = `${fz.name}: zur Besatzung springen`;
    const wert = st.join('/');
    // Zahl kurz anheben, wenn sie sich geändert hat (nur mit Bewegung)
    const geaendert = STATE.staerkeAlt && STATE.staerkeAlt[fz.id] !== undefined && STATE.staerkeAlt[fz.id] !== wert;
    neu[fz.id] = wert;
    b.innerHTML = `<span class="s-k">${escapeHtml(fz.name)}</span><span class="s-v${geaendert ? ' tick' : ''}">${wert}</span>`;
    b.addEventListener('click', () => document.getElementById('fz-karte-' + fz.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    leiste.appendChild(b);
    const kopf = document.querySelector(`.fz-besetzt[data-fz="${fz.id}"]`);
    if (kopf) kopf.textContent = `${st[3]} von ${fz.positionen.length} besetzt`;
  }
  STATE.staerkeAlt = neu;
  if (eingesetzt.length > 1) {
    const g = document.createElement('div');
    g.className = 'staerke staerke-summe';
    g.innerHTML = `<span class="s-k">Gesamt</span><span class="s-v">${summe.join('/')}</span>`;
    leiste.appendChild(g);
  }
}

// Personenwahl (Einsatzleiter, Besatzung, PA-Träger): Auswahlliste statt
// Textfeld. Das iPad zeigt dafür seine eigene Liste ohne Tastatur; quer
// verdeckte die Tastatur die frühere Vorschlagsliste fast ganz. Wer nicht in
// der Liste steht (andere Wehr, Gast), kommt über „Andere …“ am Ende in ein
// Textfeld. Gespeichert wird wie bisher nur der Name.
//
// gruppen() liefert [{ label?, namen }] und wird bei jedem Neuaufbau gelesen.
// onCommit(name) nur bei echter Änderung (change und blur feuern beide und
// schickten sonst dieselbe Besatzung zweimal gleichzeitig).
const PW_ANDERE = '__andere__';

function buildPersonenWahl({ wert = '', gruppen, leer, name, id = null, onCommit }) {
  const wrap = document.createElement('div');
  wrap.className = 'personenwahl';
  const pfeil = document.createElement('div');
  pfeil.className = 'pw-select';
  const sel = document.createElement('select');
  if (id) sel.id = id; else sel.setAttribute('aria-label', name);
  pfeil.appendChild(sel);
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.autocomplete = 'off';
  inp.className = 'hidden';
  inp.placeholder = 'Name (nicht in der Liste)';
  inp.setAttribute('aria-label', `${name}: Name, wenn nicht in der Liste`);
  wrap.append(pfeil, inp);

  let zuletzt = (wert || '').trim();

  function optionen() {
    sel.innerHTML = '';
    sel.appendChild(new Option(leer, ''));
    for (const g of gruppen()) {
      if (!g.namen.length) continue;
      const ziel = g.label ? Object.assign(document.createElement('optgroup'), { label: g.label }) : sel;
      for (const n of g.namen) ziel.appendChild(new Option(n, n));
      if (ziel !== sel) sel.appendChild(ziel);
    }
    sel.appendChild(new Option('Andere …', PW_ANDERE));
  }
  function inListe(v) {
    return [...sel.options].some((o) => o.value === v && v !== PW_ANDERE);
  }
  function zeigen(v) {
    const andere = !!v && !inListe(v);
    sel.value = andere ? PW_ANDERE : v;
    inp.value = andere ? v : '';
    inp.classList.toggle('hidden', !andere);
    wrap.classList.toggle('belegt', !!v);
  }
  function commit(v) {
    wrap.classList.toggle('belegt', !!v);
    if (v === zuletzt) return;
    zuletzt = v;
    if (onCommit) onCommit(v);
  }

  sel.addEventListener('change', () => {
    if (sel.value === PW_ANDERE) {
      // Gespeichert wird erst mit dem Namen
      inp.value = '';
      inp.classList.remove('hidden');
      inp.focus();
      return;
    }
    inp.classList.add('hidden');
    inp.value = '';
    commit(sel.value);
  });
  // Leer verlassen = versehentlich „Andere …“ gewählt: alten Stand zeigen.
  // Leeren geht über den ersten Eintrag der Liste.
  const ausFeld = () => {
    const v = inp.value.trim();
    if (v) commit(v); else zeigen(zuletzt);
  };
  inp.addEventListener('change', ausFeld);
  inp.addEventListener('blur', ausFeld);

  optionen();
  zeigen(zuletzt);
  wrap.personenwahl = {
    wert: () => (sel.value === PW_ANDERE ? inp.value.trim() : sel.value),
    setzen: (v) => { zuletzt = (v || '').trim(); optionen(); zeigen(zuletzt); },
    aktualisieren: () => { optionen(); zeigen(zuletzt); },
    enthaeltFokus: () => wrap.contains(document.activeElement),
  };
  return wrap;
}

// Hinweis neben einem PA-Träger aus dem Modul Atemschutz. Nur Information:
// eintragen lässt sich jeder, die Entscheidung liegt beim Einsatzleiter.
function agtHinweis(name) {
  if (!STATE.agt || !name || !name.trim()) return null;
  const p = STATE.agt.get(name.trim().toLowerCase());
  if (!p) return { klasse: 'warn', text: 'kein AGT-Kennzeichen' };
  // Welcher Nachweis fehlt, steht nur im Modul Atemschutz (SEC4).
  if (!p.tauglich) return { klasse: 'warn', text: 'nicht tauglich' };
  if (p.bald) return { klasse: 'info', text: 'Nachweis läuft bald ab' };
  return null;
}
function paHinweisSetzen(li, name) {
  let el = li.querySelector('.pa-hinweis');
  const h = agtHinweis(name);
  if (!h) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); li.appendChild(el); }
  el.className = 'pa-hinweis ' + h.klasse;
  el.textContent = h.text;
}

function renderPaList() {
  const list = $('#pa-list'); list.innerHTML = '';
  STATE.form.pa.forEach((p, idx) => {
    const li = document.createElement('li'); li.className = 'pa-row';

    const nameCombo = buildPersonenWahl({
      wert: displayName(p), name: `PA-Träger ${idx + 1}`, leer: '– Person wählen –',
      gruppen: () => [{ namen: personenNamen() }],
      onCommit: (value) => {
        assignNameToPa(idx, value);
        paHinweisSetzen(li, value);
        if (isLive() && p.pa_id) savePa(p.pa_id, {
          person_vorname: p.person_vorname, person_nachname: p.person_nachname,
        });
      },
    });

    const dauerInp = document.createElement('input');
    dauerInp.type = 'number'; dauerInp.placeholder = 'Min'; dauerInp.min = '0';
    dauerInp.value = p.dauer_minuten ?? '';

    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.className = 'icon-btn icon-danger';
    delBtn.setAttribute('aria-label', 'PA-Träger entfernen'); delBtn.title = 'PA-Träger entfernen';
    delBtn.innerHTML = ICON.del;

    const onDauerChange = () => {
      const v = Number(dauerInp.value); p.dauer_minuten = Number.isFinite(v) ? v : null;
      if (isLive() && p.pa_id) savePa(p.pa_id, { dauer_minuten: p.dauer_minuten });
    };
    dauerInp.addEventListener('change', onDauerChange);
    dauerInp.addEventListener('blur', onDauerChange);
    delBtn.addEventListener('click', async () => {
      if (isLive() && p.pa_id) await deletePa(p.pa_id);
      STATE.form.pa.splice(idx, 1); renderPaList();
      const name = displayName(p);
      toastRueckgaengig(name ? `PA-Träger ${name} entfernt` : 'PA-Zeile entfernt', async () => {
        let pa_id = null;
        if (isLive()) {
          pa_id = await createPa();
          if (pa_id == null) return;
          await savePa(pa_id, { person_vorname: p.person_vorname, person_nachname: p.person_nachname, dauer_minuten: p.dauer_minuten });
        }
        STATE.form.pa.splice(Math.min(idx, STATE.form.pa.length), 0, { ...p, pa_id });
        renderPaList();
      });
    });

    li.appendChild(nameCombo);
    li.appendChild(dauerInp);
    li.appendChild(delBtn);
    paHinweisSetzen(li, displayName(p));
    list.appendChild(li);
  });
  applyStatusToForm();
}
async function addPaRow() {
  let pa_id = null;
  if (isLive()) {
    pa_id = await createPa();
    if (pa_id == null) return;
  }
  STATE.form.pa.push({ pa_id, person_vorname: '', person_nachname: '', dauer_minuten: null });
  renderPaList();
}
function assignNameToPa(idx, fullName) {
  const parts = fullName.trim().split(/\s+/);
  STATE.form.pa[idx].person_vorname = parts[0] || '';
  STATE.form.pa[idx].person_nachname = parts.slice(1).join(' ');
}
function displayName(p) {
  return [p.person_vorname, p.person_nachname].filter(Boolean).join(' ');
}

function renderVerList() {
  const list = $('#ver-list'); list.innerHTML = '';
  STATE.form.verunfallte.forEach((v, idx) => {
    const li = document.createElement('li'); li.className = 'pa-row';
    li.innerHTML = `
      <input type="text" placeholder="z. B. LM-AB 1234" value="${escapeAttr(v.kennzeichen || '')}" />
      <span></span>
      <button type="button" class="icon-btn icon-danger" aria-label="Kennzeichen entfernen" title="Kennzeichen entfernen">${ICON.del}</button>
    `;
    const inp = li.querySelector('input');
    const delBtn = li.querySelector('button');
    const onChange = () => {
      v.kennzeichen = inp.value.trim();
      if (isLive() && v.v_id) saveVer(v.v_id, v.kennzeichen);
    };
    inp.addEventListener('change', onChange);
    inp.addEventListener('blur', onChange);
    delBtn.addEventListener('click', async () => {
      if (isLive() && v.v_id) await deleteVer(v.v_id);
      STATE.form.verunfallte.splice(idx, 1); renderVerList();
      toastRueckgaengig(v.kennzeichen ? `Kennzeichen ${v.kennzeichen} entfernt` : 'Kennzeichen-Zeile entfernt', async () => {
        let v_id = null;
        if (isLive()) {
          v_id = await createVer();
          if (v_id == null) return;
          if (v.kennzeichen) await saveVer(v_id, v.kennzeichen);
        }
        STATE.form.verunfallte.splice(Math.min(idx, STATE.form.verunfallte.length), 0, { ...v, v_id });
        renderVerList();
      });
    });
    list.appendChild(li);
  });
  applyStatusToForm();
}
async function addVerRow() {
  let v_id = null;
  if (isLive()) {
    v_id = await createVer();
    if (v_id == null) return;
  }
  STATE.form.verunfallte.push({ v_id, kennzeichen: '' });
  renderVerList();
}

// --- Form Reset (für Neuanlage) ---

function resetForm() {
  STATE.speicher = null;
  STATE.staerkeAlt = null;
  STATE.offline = false;
  STATE.currentId = null;
  STATE.currentEinsatz = null;
  STATE.knownUpdatedAt = null;
  $('#form-einsatz').reset();
  STATE.elWahl.setzen('');
  setDefaultAlarm();
  STATE.form = { ffIds: new Set(), fahrzeuge: [], pa: [], verunfallte: [] };
  renderFfenChecklist();
  renderErsteFfSelect();
  renderFahrzeugeForm();
  renderPaList();
  renderVerList();
  updateLiveBanner();
  applyStatusToForm();
  updateHeaderTitle();
}

// --- Verlauf ---

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli',
  'August', 'September', 'Oktober', 'November', 'Dezember'];
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

async function loadHistory() {
  const list = $('#history-list'); list.innerHTML = '';
  $('#history-empty').classList.add('hidden');
  try {
    const res = await apiFetch('/api/einsaetze');
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const items = await res.json();
    seitenkopf('view-history', 'Verlauf', `${items.length} ${items.length === 1 ? 'Einsatz' : 'Einsätze'}`);
    if (!items.length) {
      leerZustand('#history-empty', {
        icon: 'liste', titel: 'Noch keine Einsätze',
        text: 'Einsätze erscheinen hier, sobald ein Alarm eingeht oder jemand einen anlegt.',
        knopf: userCanWrite() ? 'Einsatz anlegen' : null,
        aktion: () => { resetForm(); showView('edit'); },
      });
      return;
    }
    let monat = null;
    for (const e of items) {
      // Zwischenüberschrift je Monat; die Liste kommt nach Datum absteigend
      const m = (e.alarm_datum || '').slice(0, 7);
      if (m !== monat) {
        monat = m;
        const anzahl = items.filter((x) => (x.alarm_datum || '').startsWith(m)).length;
        const kopf = document.createElement('li');
        kopf.className = 'h-monat';
        kopf.innerHTML = `${escapeHtml(monatsName(m))} <span>${anzahl} ${anzahl === 1 ? 'Einsatz' : 'Einsätze'}</span>`;
        list.appendChild(kopf);
      }
      const li = document.createElement('li'); li.className = 'history-item';
      const statusBadge = e.status === 'offen'
        ? '<span class="status-badge open">offen</span>'
        : '<span class="status-badge closed">abgeschlossen</span>';
      // Nachgetragene Einsätze kennzeichnen: Fahrzeug- und Positionszuordnung
      // stammt dort aus einer Regel, nicht aus einer Aufzeichnung (siehe notizen).
      const migBadge = e.migriert_quelle
        ? ` <span class="status-badge migriert" title="Nachgetragen aus: ${escapeHtml(e.migriert_quelle)}">nachgetragen</span>`
        : '';
      li.innerHTML = `
        ${datumsKachel(e.alarm_datum)}
        <div class="h-main">
          <div class="h-date">${escapeHtml(e.alarm_uhrzeit || '')} ${statusBadge}${migBadge}</div>
          <div class="h-title">${escapeHtml(e.einsatzgrund || e.einsatzort || e.alarmierte_einheit || '(kein Grund)')}</div>
          <div class="h-meta">
            ${e.alarmierte_einheit ? `<span>${escapeHtml(e.alarmierte_einheit)}</span>` : ''}
            ${e.einsatzort ? `<span>${escapeHtml(e.einsatzort)}</span>` : ''}
            ${e.fahrzeuge_kennungen ? `<span>${escapeHtml(e.fahrzeuge_kennungen)}</span>` : ''}
            ${e.created_by ? `<span>von ${escapeHtml(e.created_by)}</span>` : ''}
          </div>
        </div>
        ${userIsAdmin() ? `<button type="button" class="h-edit h-del" aria-label="Einsatzbericht löschen" title="Einsatzbericht löschen">${ICON.del}</button>` : ''}
      `;
      li.querySelector('.h-main').addEventListener('click', () => openEinsatz(e.id));
      const delBtn = li.querySelector('.h-edit');
      if (delBtn) delBtn.addEventListener('click', () => deleteEinsatz(e));
      list.appendChild(li);
    }
  } catch (err) {
    leerZustand('#history-empty', { icon: 'fehler', titel: 'Verlauf nicht abrufbar', text: err.message, knopf: 'Erneut laden', aktion: loadHistory });
  }
}

async function deleteEinsatz(e) {
  const label = `${formatDate(e.alarm_datum)} · ${e.alarm_uhrzeit} – ${e.einsatzgrund || e.einsatzort || e.alarmierte_einheit || '(kein Grund)'}`;
  if (!await bestaetigen(`Einsatzbericht löschen?\n\n${label}\n\nDer Bericht wird mit Besatzung und Atemschutz endgültig entfernt.`)) return;
  try {
    const res = await apiFetch('/api/einsaetze/' + e.id, { method: 'DELETE' });
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || 'HTTP ' + res.status); }
    toast('Einsatzbericht gelöscht', 'success');
    loadHistory();
  } catch (err) { toast('Fehler: ' + err.message, 'error'); }
}

async function openEinsatz(id) {
  STATE.speicher = null;
  STATE.staerkeAlt = null;
  STATE.offline = false;
  STATE.currentId = id;
  await loadFullEinsatz(id);
  showView('edit');
  startPolling();
}

// --- Combobox (Einsatzleiter, Einsatzort) ---

function defaultComboItems() {
  return STATE.personen.map((p) => `${p.vorname} ${p.nachname}`);
}

// Filter beim Antippen eines Felds: Steht schon ein Name aus der Liste darin,
// die ganze Liste zeigen. Sonst sähe man nur diesen einen Namen und könnte
// nicht wechseln, ohne das Feld erst zu leeren.
function comboFilter(wert, items) {
  const w = (wert || '').trim().toLowerCase();
  return w && items().some((n) => n.toLowerCase() === w) ? '' : wert;
}

function setupCombo(inputId, toggleId, listId, onPick, getItems) {
  const input = $('#' + inputId);
  const list = $('#' + listId);
  const toggle = $('#' + toggleId);
  const items = getItems || defaultComboItems;

  function render(filter) {
    list.innerHTML = '';
    const f = (filter || '').trim().toLowerCase();
    let count = 0;
    for (const name of items()) {
      if (f && !name.toLowerCase().includes(f)) continue;
      const li = document.createElement('li'); li.className = 'combo-item';
      li.textContent = name;
      li.addEventListener('mousedown', (e) => {
        e.preventDefault(); input.value = name; list.classList.add('hidden');
        if (onPick) onPick();
      });
      list.appendChild(li); if (++count >= 50) break;
    }
    return count;
  }
  toggle.addEventListener('click', (e) => {
    e.preventDefault();
    if (list.classList.contains('hidden')) { render(''); list.classList.remove('hidden'); input.focus(); }
    else list.classList.add('hidden');
  });
  input.addEventListener('focus', () => { if (render(comboFilter(input.value, items)) > 0) list.classList.remove('hidden'); });
  input.addEventListener('input', () => { if (render(input.value) > 0) list.classList.remove('hidden'); else list.classList.add('hidden'); });
  input.addEventListener('blur', () => setTimeout(() => list.classList.add('hidden'), 150));
}

// --- Stammdaten-Verwaltung (unverändert) ---

async function loadFzStamm() {
  const list = $('#fz-stamm-list'); list.innerHTML = '';
  try {
    const res = await apiFetch('/api/fahrzeuge');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const rows = await res.json();
    seitenkopf('view-fahrzeuge', 'Fahrzeuge', `${rows.filter((f) => f.aktiv).length} aktiv`);
    if (!rows.length) {
      leerZustand(list, {
        icon: 'fahrzeug', titel: 'Noch keine Fahrzeuge',
        text: 'Fahrzeuge mit ihren Positionen anlegen, dann stehen sie in jedem Einsatz zur Auswahl.',
        knopf: 'Fahrzeug anlegen', aktion: () => openFzDialog(),
      });
      return;
    }
    for (const fz of rows) {
      const li = document.createElement('li'); li.className = 'user-item';
      li.innerHTML = `
        <div class="u-info">
          <div class="u-name">${escapeHtml(fz.name)} <span class="muted">(${escapeHtml(fz.kennung)})</span> ${fz.aktiv ? '' : '<span class="muted">– inaktiv</span>'}</div>
          <div class="u-role">${fz.positionen.join(', ')}</div>
        </div>
        <div class="u-actions">
          ${iconBtn('edit', 'Bearbeiten')}
          ${iconBtn('del', 'Löschen', 'icon-danger')}
        </div>
      `;
      li.querySelector('[data-act="edit"]').addEventListener('click', () => openFzDialog(fz));
      li.querySelector('[data-act="del"]').addEventListener('click', () => deleteFz(fz));
      list.appendChild(li);
    }
  } catch (err) { list.innerHTML = `<p class="empty">Fehler: ${escapeHtml(err.message)}</p>`; }
}
function openFzDialog(fz) {
  STATE.editFzId = fz?.id || null;
  $('#fz-dialog-title').textContent = fz ? `Fahrzeug „${fz.name}"` : 'Neues Fahrzeug';
  $('#fz-kennung').value = fz?.kennung || '';
  $('#fz-name').value = fz?.name || '';
  $('#fz-positionen').value = fz ? fz.positionen.join(',') : 'MA,GF,AF,AM,WF,WM,SF,SM,ME';
  $('#fz-sort').value = fz?.sort_order ?? 100;
  $('#fz-aktiv').value = fz ? String(fz.aktiv) : '1';
  $('#fz-error').classList.add('hidden');
  $('#fz-dialog').showModal();
}
async function saveFzDialog() {
  const errEl = $('#fz-error'); errEl.classList.add('hidden');
  const payload = {
    kennung: $('#fz-kennung').value.trim(),
    name: $('#fz-name').value.trim(),
    positionen: $('#fz-positionen').value.split(',').map((s) => s.trim()).filter(Boolean),
    sort_order: Number($('#fz-sort').value) || 100,
    aktiv: $('#fz-aktiv').value === '1',
  };
  try {
    const url = STATE.editFzId ? '/api/fahrzeuge/' + STATE.editFzId : '/api/fahrzeuge';
    const method = STATE.editFzId ? 'PUT' : 'POST';
    const res = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'HTTP ' + res.status); }
    $('#fz-dialog').close('ok'); await refreshFzStamm(); loadFzStamm();
    toast('Gespeichert', 'success');
  } catch (err) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
}
async function deleteFz(fz) {
  if (!await bestaetigen(`Fahrzeug „${fz.name}" wirklich löschen?`)) return;
  try {
    const res = await apiFetch('/api/fahrzeuge/' + fz.id, { method: 'DELETE' });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'HTTP ' + res.status); }
    toast('Gelöscht', 'success'); await refreshFzStamm(); loadFzStamm();
  } catch (err) { toast('Fehler: ' + err.message, 'error'); }
}
async function refreshFzStamm() {
  const res = await apiFetch('/api/fahrzeuge'); if (!res.ok) return;
  STATE.fahrzeugeStamm = await res.json();
}

async function loadFfStamm() {
  const list = $('#ff-stamm-list'); list.innerHTML = '';
  try {
    const res = await apiFetch('/api/ffen');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const rows = await res.json();
    if (!rows.length) { list.innerHTML = '<p class="empty">Noch keine FFen.</p>'; return; }
    for (const ff of rows) {
      const li = document.createElement('li'); li.className = 'user-item';
      li.innerHTML = `
        <div class="u-info">
          <div class="u-name">${escapeHtml(ff.kuerzel)} — ${escapeHtml(ff.name)} ${ff.aktiv ? '' : '<span class="muted">– inaktiv</span>'}</div>
          <div class="u-role">Sortierung ${ff.sort_order}</div>
        </div>
        <div class="u-actions">
          ${iconBtn('edit', 'Bearbeiten')}
          ${iconBtn('del', 'Löschen', 'icon-danger')}
        </div>
      `;
      li.querySelector('[data-act="edit"]').addEventListener('click', () => openFfDialog(ff));
      li.querySelector('[data-act="del"]').addEventListener('click', () => deleteFf(ff));
      list.appendChild(li);
    }
  } catch (err) { list.innerHTML = `<p class="empty">Fehler: ${escapeHtml(err.message)}</p>`; }
}
function openFfDialog(ff) {
  STATE.editFfId = ff?.id || null;
  $('#ff-dialog-title').textContent = ff ? `FF „${ff.name}"` : 'Neue Nachbar-FF';
  $('#ff-kuerzel').value = ff?.kuerzel || '';
  $('#ff-name').value = ff?.name || '';
  $('#ff-sort').value = ff?.sort_order ?? 100;
  $('#ff-aktiv').value = ff ? String(ff.aktiv) : '1';
  $('#ff-error').classList.add('hidden');
  $('#ff-dialog').showModal();
}
async function saveFfDialog() {
  const errEl = $('#ff-error'); errEl.classList.add('hidden');
  const payload = {
    kuerzel: $('#ff-kuerzel').value.trim(),
    name: $('#ff-name').value.trim(),
    sort_order: Number($('#ff-sort').value) || 100,
    aktiv: $('#ff-aktiv').value === '1',
  };
  try {
    const url = STATE.editFfId ? '/api/ffen/' + STATE.editFfId : '/api/ffen';
    const method = STATE.editFfId ? 'PUT' : 'POST';
    const res = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'HTTP ' + res.status); }
    $('#ff-dialog').close('ok'); await refreshFfStamm(); loadFfStamm();
    toast('Gespeichert', 'success');
  } catch (err) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
}
async function deleteFf(ff) {
  if (!await bestaetigen(`FF „${ff.name}" wirklich löschen?`)) return;
  try {
    const res = await apiFetch('/api/ffen/' + ff.id, { method: 'DELETE' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    toast('Gelöscht', 'success'); await refreshFfStamm(); loadFfStamm();
  } catch (err) { toast('Fehler: ' + err.message, 'error'); }
}
async function refreshFfStamm() {
  const res = await apiFetch('/api/ffen'); if (!res.ok) return;
  STATE.ffenStamm = await res.json();
}

async function loadUsers() {
  const list = $('#users-list'); list.innerHTML = '';
  try {
    const res = await apiFetch('/api/einsaetze/benutzer');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const users = (await res.json()).filter((u) => !u.is_device);
    seitenkopf('view-users', 'Benutzer', `${users.length} ${users.length === 1 ? 'Konto' : 'Konten'}`);
    for (const u of users) {
      const li = document.createElement('li'); li.className = 'user-item';
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
  } catch (err) { list.innerHTML = `<p class="empty">Fehler: ${escapeHtml(err.message)}</p>`; }
}
// --- Ausgehende Webhooks ---
// Werden nach dem Anlegen eines Einsatzes der Reihe nach aufgerufen. Die
// Verwaltung hier ist reine Konfiguration; ausgelöst wird serverseitig.

// Das als Secret hinterlegte Ziel steht bewusst nicht in der Datenbank und
// ist hier deshalb nicht bearbeitbar — nur prüfbar. Die URL bleibt serverseitig.
async function renderSecretWebhook(list) {
  let info;
  try {
    const res = await apiFetch('/api/webhooks/secret');
    if (!res.ok) return;
    info = await res.json();
  } catch { return; }

  const li = document.createElement('li');
  li.className = 'user-item';
  const ziel = info.konfiguriert
    ? `Ziel: ${escapeHtml(info.host || 'unbekannt')} · URL serverseitig`
    : 'nicht konfiguriert — HOMEY_WEBHOOK_BASE in Cloudflare setzen';
  li.innerHTML = `
    <div class="u-info">
      <div class="u-name">Homey (Secret)</div>
      <div class="u-role">wird als Erstes aufgerufen · ${ziel}</div>
      <div class="u-role" data-rolle="ergebnis"></div>
    </div>
    <div class="u-actions">
      <button class="chip" data-act="test"${info.konfiguriert ? '' : ' disabled'}>Testen</button>
    </div>
  `;
  li.querySelector('[data-act="test"]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const out = li.querySelector('[data-rolle="ergebnis"]');
    btn.disabled = true; out.textContent = 'teste …';
    try {
      const res = await apiFetch('/api/webhooks/secret', { method: 'POST' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
      out.textContent = d.ok ? `zuletzt OK (${d.status})` : `zuletzt ${d.status}`;
      toast(d.ok ? `Homey: OK (${d.status})` : `Homey: ${d.status}`, d.ok ? 'success' : 'error');
    } catch (err) {
      out.textContent = '';
      toast('Fehler: ' + err.message, 'error');
    } finally { btn.disabled = false; }
  });
  list.appendChild(li);
}

async function loadWebhooks() {
  const list = $('#webhooks-list'); list.innerHTML = '';
  await renderSecretWebhook(list);
  try {
    const res = await apiFetch('/api/webhooks');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const hooks = await res.json();
    if (!hooks.length) {
      const leer = document.createElement('p');
      leer.className = 'empty';
      leer.textContent = 'Keine weiteren Ziele eingetragen.';
      list.appendChild(leer);
      return;
    }
    for (const h of hooks) {
      const li = document.createElement('li'); li.className = 'user-item';
      const zuletzt = h.last_at
        ? `zuletzt ${escapeHtml(h.last_status || '?')} am ${formatSqlDateTime(h.last_at)}`
        : 'noch nie aufgerufen';
      li.innerHTML = `
        <div class="u-info">
          <div class="u-name">${escapeHtml(h.name)}${h.aktiv ? '' : ' <span class="muted">– inaktiv</span>'}</div>
          <div class="u-role">#${h.sort_order} · ${escapeHtml(h.url)}</div>
          <div class="u-role">${zuletzt}</div>
        </div>
        <div class="u-actions">
          <button class="chip" data-act="test">Testen</button>
          ${iconBtn('edit', 'Bearbeiten')}
          ${iconBtn('del', 'Löschen', 'icon-danger')}
        </div>
      `;
      li.querySelector('[data-act="test"]').addEventListener('click', () => testWebhook(h));
      li.querySelector('[data-act="edit"]').addEventListener('click', () => openWebhookDialog(h));
      li.querySelector('[data-act="del"]').addEventListener('click', () => deleteWebhook(h));
      list.appendChild(li);
    }
  } catch (err) {
    const fehler = document.createElement('p');
    fehler.className = 'empty';
    fehler.textContent = 'Fehler: ' + err.message;
    list.appendChild(fehler);
  }
}

function openWebhookDialog(hook) {
  const isEdit = !!(hook && hook.id);
  STATE.editWebhookId = isEdit ? hook.id : null;
  $('#wh-dialog-title').textContent = isEdit ? `Webhook „${hook.name}"` : 'Neuer Webhook';
  $('#wh-name').value  = isEdit ? hook.name : '';
  $('#wh-url').value   = isEdit ? hook.url : '';
  $('#wh-sort').value  = isEdit ? hook.sort_order : 100;
  $('#wh-aktiv').value = isEdit ? String(hook.aktiv ? 1 : 0) : '1';
  $('#wh-error').classList.add('hidden');
  $('#wh-dialog').showModal();
}

async function saveWebhook() {
  const errEl = $('#wh-error'); errEl.classList.add('hidden');
  const payload = {
    name: $('#wh-name').value.trim(),
    url: $('#wh-url').value.trim(),
    sort_order: Number($('#wh-sort').value) || 100,
    aktiv: $('#wh-aktiv').value === '1',
  };
  const id = STATE.editWebhookId;
  try {
    const res = await apiFetch(id ? '/api/webhooks/' + id : '/api/webhooks', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    $('#wh-dialog').close();
    toast('Webhook gespeichert', 'success');
    await loadWebhooks();
  } catch (err) {
    errEl.textContent = err.message; errEl.classList.remove('hidden');
  }
}

async function testWebhook(h) {
  toast(`Teste „${h.name}" …`);
  try {
    const res = await apiFetch('/api/webhooks/' + h.id, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    toast(data.ok ? `${h.name}: OK (${data.status})` : `${h.name}: ${data.status}`,
          data.ok ? 'success' : 'error');
    await loadWebhooks();
  } catch (err) { toast('Fehler: ' + err.message, 'error'); }
}

async function deleteWebhook(h) {
  if (!await bestaetigen(`Webhook „${h.name}" löschen?`)) return;
  try {
    const res = await apiFetch('/api/webhooks/' + h.id, { method: 'DELETE' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    toast('Webhook gelöscht', 'success');
    await loadWebhooks();
  } catch (err) { toast('Fehler: ' + err.message, 'error'); }
}

// --- Geräte (LF10, GW) ---
// Ein Geräte-Benutzer entspricht genau einem Tablet. Eingerichtet wird per
// QR-Code; der dahinterliegende Einmal-Code gilt 15 Minuten.

const QRCODE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
let _qrPromise = null;

// Prüfsummen (Subresource Integrity) der nachgeladenen Bibliotheken. Der
// Browser führt ein Skript nur aus, wenn sein Inhalt exakt dazu passt — ein
// manipuliertes CDN kann so keinen Code einschleusen und etwa den
// Geräte-Token aus dem localStorage lesen. Bei einem Versionswechsel neu
// berechnen:
//   curl -sL <URL> | openssl dgst -sha384 -binary | openssl base64 -A
// Dieselbe Tabelle steht in public/app.js (Anwesenheit).
const SKRIPT_PRUEFSUMMEN = {
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js':
    'sha384-3zSEDfvllQohrq0PHL1fOXJuC/jSOO34H46t6UQfobFOmxE5BpjjaIJY5F2/bMnU',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js':
    'sha384-JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js':
    'sha384-fCAW/rDWORTbQXSiB7mOg0QtQ5c+r0f544y6XoKjuVva0nMBlCpNUjiFeG5iMdS3',
  'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js':
    'sha384-EnyY0/GSHQGSxSgMwaIPzSESbqoOLSexfnSMN2AP+39Ckmn92stwABZynq1JyzdT',
};
// <script>-Element für eine fremde Bibliothek, immer mit Prüfsumme. Fehlt sie
// in der Tabelle, wird gar nicht erst geladen.
function fremdesSkript(src) {
  const integrity = SKRIPT_PRUEFSUMMEN[src];
  if (!integrity) throw new Error('Keine Prüfsumme für ' + src);
  return Object.assign(document.createElement('script'), { src, integrity, crossOrigin: 'anonymous' });
}
function loadQrLib() {
  if (window.QRCode) return Promise.resolve(window.QRCode);
  if (_qrPromise) return _qrPromise;
  _qrPromise = new Promise((resolve, reject) => {
    const el = fremdesSkript(QRCODE_URL);
    el.onload = () => resolve(window.QRCode);
    el.onerror = () => { _qrPromise = null; reject(new Error('QR-Bibliothek konnte nicht geladen werden')); };
    document.head.appendChild(el);
  });
  return _qrPromise;
}

async function loadGeraete() {
  const list = $('#geraete-list'); list.innerHTML = '';
  try {
    const res = await apiFetch('/api/devices');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const geraete = await res.json();
    seitenkopf('view-geraete', 'Geräte', `${geraete.length} ${geraete.length === 1 ? 'Tablet' : 'Tablets'}`);
    if (!geraete.length) {
      leerZustand(list, {
        icon: 'geraet', titel: 'Noch keine Geräte',
        text: 'Ein Gerät ist ein Fahrzeug-Tablet, das sich ohne Passwort anmeldet.',
        knopf: 'Gerät anlegen', aktion: newGeraet,
      });
      return;
    }
    for (const g of geraete) {
      const li = document.createElement('li'); li.className = 'user-item';
      const gesperrt = !!g.device_revoked_at;
      const zuletzt = g.last_seen_at ? `zuletzt gesehen ${formatSqlDateTime(g.last_seen_at)}` : 'noch nie verbunden';
      li.innerHTML = `
        <div class="u-info">
          <div class="u-name">${escapeHtml(g.username)}</div>
          <div class="u-role">${escapeHtml(g.status)} · ${escapeHtml(zuletzt)}</div>
        </div>
        <div class="u-actions">
          <button class="chip" data-act="enroll">Einrichten</button>
          <button class="chip" data-act="revoke">${gesperrt ? 'Entsperren' : 'Sperren'}</button>
          ${iconBtn('del', 'Löschen', 'icon-danger')}
        </div>
      `;
      li.querySelector('[data-act="enroll"]').addEventListener('click', () => enrollGeraet(g));
      li.querySelector('[data-act="revoke"]').addEventListener('click', () => revokeGeraet(g, !gesperrt));
      li.querySelector('[data-act="del"]').addEventListener('click', () => deleteGeraet(g));
      list.appendChild(li);
    }
  } catch (err) { list.innerHTML = `<p class="empty">Fehler: ${escapeHtml(err.message)}</p>`; }
}

async function newGeraet() {
  const name = prompt('Kennung des Geräts (z. B. LF10 oder GW):');
  if (!name) return;
  try {
    const res = await apiFetch('/api/devices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: name.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    await loadGeraete();
    showEnrollDialog(data);
  } catch (err) { toast('Fehler: ' + err.message, 'error'); }
}

async function enrollGeraet(g) {
  try {
    const res = await apiFetch('/api/devices/' + g.id, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    await loadGeraete();
    showEnrollDialog(data);
  } catch (err) { toast('Fehler: ' + err.message, 'error'); }
}

async function showEnrollDialog(data) {
  const url = location.origin + data.enroll_url;
  $('#enroll-dialog-title').textContent = `Gerät „${data.username}" einrichten`;
  $('#enroll-ttl').textContent = String(data.expires_in_minutes ?? 15);
  $('#enroll-link').value = url;
  const box = $('#enroll-qr'); box.innerHTML = '';
  $('#enroll-dialog').showModal();
  try {
    const QRCode = await loadQrLib();
    new QRCode(box, { text: url, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });
  } catch {
    box.innerHTML = '<p class="hint">QR-Code nicht verfügbar — bitte die Adresse unten verwenden.</p>';
  }
}

async function revokeGeraet(g, revoked) {
  if (revoked && !await bestaetigen(`Gerät „${g.username}" sperren?\n\nDas Tablet verliert sofort den Zugriff.`, { ok: 'Sperren' })) return;
  try {
    const res = await apiFetch('/api/devices/' + g.id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revoked }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    toast(revoked ? 'Gerät gesperrt' : 'Gerät entsperrt', 'success');
    await loadGeraete();
  } catch (err) { toast('Fehler: ' + err.message, 'error'); }
}

async function deleteGeraet(g) {
  if (!await bestaetigen(`Gerät „${g.username}" endgültig löschen?`)) return;
  try {
    const res = await apiFetch('/api/devices/' + g.id, { method: 'DELETE' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    toast('Gerät gelöscht', 'success');
    await loadGeraete();
  } catch (err) { toast('Fehler: ' + err.message, 'error'); }
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
  $('#user-role-leser').checked    = currentRoles.has(APP_ROLE_LESER);

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
  const errEl = $('#user-error'); errEl.classList.add('hidden');
  const username = $('#user-username').value.trim();
  const password = $('#user-password').value;
  const selectedRoles = [];
  if ($('#user-role-admin').checked)    selectedRoles.push(APP_ROLE_ADMIN);
  if ($('#user-role-erfasser').checked) selectedRoles.push(APP_ROLE_ERFASSER);
  if ($('#user-role-leser').checked)    selectedRoles.push(APP_ROLE_LESER);
  try {
    if (STATE.editUserId) {
      const body = {};
      if (password) body.password = password;
      body.roles = selectedRoles;
      const res = await apiFetch('/api/einsaetze/benutzer/' + STATE.editUserId, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'HTTP ' + res.status); }
      const result = await res.json().catch(() => ({}));
      toast(result.deleted ? 'Benutzer entfernt (keine Rollen mehr)' : 'Benutzer aktualisiert', 'success');
    } else {
      if (!username || !password) { errEl.textContent = 'Benutzername und Passwort erforderlich.'; errEl.classList.remove('hidden'); return; }
      if (!selectedRoles.length) { errEl.textContent = 'Mindestens eine Rolle auswählen.'; errEl.classList.remove('hidden'); return; }
      const res = await apiFetch('/api/einsaetze/benutzer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, roles: selectedRoles }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'HTTP ' + res.status); }
      toast('Benutzer angelegt', 'success');
    }
    $('#user-dialog').close('ok'); loadUsers();
  } catch (err) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
}

const ROLE_LABELS = {
  admin_anwesenheit:        'Admin (Anwesenheit)',
  erfasser_anwesenheit:     'Erfasser (Anwesenheit)',
  admin_einsatzprotokoll:   'Admin (Einsatzprotokoll)',
  erfasser_einsatzprotokoll:'Erfasser (Einsatzprotokoll)',
  leser_einsatzprotokoll:   'Leser (Einsatzprotokoll)',
};
function formatRoleLabel(role) { return ROLE_LABELS[role] || role; }
async function deleteUser(user) {
  if (!await bestaetigen(`Benutzer „${user.username}" wirklich löschen?`)) return;
  try {
    const res = await apiFetch('/api/einsaetze/benutzer/' + user.id, { method: 'DELETE' });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'HTTP ' + res.status); }
    toast('Gelöscht', 'success'); loadUsers();
  } catch (err) { toast('Fehler: ' + err.message, 'error'); }
}

// --- Excel-Export (Admin + Leser) ---

const SHEETJS_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
let _sheetjsPromise = null;

function loadSheetJs() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (_sheetjsPromise) return _sheetjsPromise;
  _sheetjsPromise = new Promise((resolve, reject) => {
    const s = fremdesSkript(SHEETJS_URL);
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
    const [XLSX, res] = await Promise.all([loadSheetJs(), apiFetch('/api/einsaetze/export')]);
    if (res.status === 401) { showLogin(); return; }
    if (res.status === 403) { toast('Keine Berechtigung für den Export', 'error'); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { einsaetze = [] } = await res.json();
    if (!einsaetze.length) { toast('Keine Einsätze zum Exportieren', 'error'); return; }

    // Sheet 1 — Übersicht (eine Zeile je Einsatz)
    const overviewRows = einsaetze.map((e) => {
      const kraefte = (e.fahrzeuge || []).reduce((n, f) => n + (f.besatzung || []).length, 0);
      return {
        Datum: e.alarm_datum || '',
        Uhrzeit: e.alarm_uhrzeit || '',
        'Alarmierte Einheit': e.alarmierte_einheit || '',
        Einsatzort: e.einsatzort || '',
        Einsatzgrund: e.einsatzgrund || '',
        Einsatzleiter: e.einsatzleiter || '',
        'Erste FF': e.erste_ff_name || '',
        'FFen vor Ort': (e.ffen || []).join(', '),
        Fahrzeuge: (e.fahrzeuge || []).map((f) => f.kennung).join(', '),
        'Km Einsatzstelle': e.km_einsatzstelle ?? '',
        'Km gesamt': e.km_gesamt ?? '',
        Einsatzkräfte: kraefte,
        'PA-Träger': (e.pa || []).length,
        'Verunfallte (Kennz.)': (e.verunfallte || []).join(', '),
        Status: e.status === 'abgeschlossen' ? 'Abgeschlossen' : 'Offen',
        'Abgeschlossen am': formatSqlDateTime(e.abgeschlossen_at),
        'Abgeschlossen von': e.abgeschlossen_by || '',
        'Erfasst von': e.created_by || '',
        Notizen: e.notizen || '',
      };
    });
    const wsOverview = XLSX.utils.json_to_sheet(overviewRows);
    wsOverview['!cols'] = [
      { wch: 12 }, { wch: 8 }, { wch: 20 }, { wch: 24 }, { wch: 24 }, { wch: 18 },
      { wch: 10 }, { wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 10 }, { wch: 12 },
      { wch: 10 }, { wch: 18 }, { wch: 14 }, { wch: 18 }, { wch: 16 }, { wch: 14 }, { wch: 40 },
    ];

    // Sheet 2 — Besatzung (eine Zeile je Einsatzkraft)
    const besRows = [];
    for (const e of einsaetze) {
      for (const f of (e.fahrzeuge || [])) {
        for (const b of (f.besatzung || [])) {
          besRows.push({
            Datum: e.alarm_datum || '',
            Einsatzgrund: e.einsatzgrund || '',
            Fahrzeug: [f.kennung, f.name].filter(Boolean).join(' '),
            Position: b.position || '',
            Vorname: b.person_vorname || '',
            Nachname: b.person_nachname || '',
          });
        }
      }
    }
    const wsBes = XLSX.utils.json_to_sheet(besRows);
    wsBes['!cols'] = [{ wch: 12 }, { wch: 24 }, { wch: 18 }, { wch: 10 }, { wch: 16 }, { wch: 16 }];

    // Sheet 3 — Atemschutz (eine Zeile je PA-Träger)
    const paRows = [];
    for (const e of einsaetze) {
      for (const p of (e.pa || [])) {
        paRows.push({
          Datum: e.alarm_datum || '',
          Einsatzgrund: e.einsatzgrund || '',
          Vorname: p.person_vorname || '',
          Nachname: p.person_nachname || '',
          'Dauer (min)': p.dauer_minuten ?? '',
        });
      }
    }
    const wsPa = XLSX.utils.json_to_sheet(paRows);
    wsPa['!cols'] = [{ wch: 12 }, { wch: 24 }, { wch: 16 }, { wch: 16 }, { wch: 12 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsOverview, 'Einsätze');
    XLSX.utils.book_append_sheet(wb, wsBes, 'Besatzung');
    XLSX.utils.book_append_sheet(wb, wsPa, 'Atemschutz');

    const today = new Date().toISOString().slice(0, 10);
    const daten = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    await dateiAusgeben(new Blob([daten], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `Einsaetze_${today}.xlsx`);
    toast('Export erstellt', 'success');
  } catch (err) {
    toast('Export fehlgeschlagen: ' + err.message, 'error');
  }
}

// --- Utils ---

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
  t.textContent = msg; t.className = 'toast ' + kind; t.classList.remove('hidden');
  clearTimeout(t._tid); t._tid = setTimeout(() => t.classList.add('hidden'), 2400);
}
function formatDate(iso) { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; }
function formatSqlDateTime(ts) {
  if (!ts) return '';
  return formatDateTime(String(ts).replace(' ', 'T') + 'Z');
}
function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()} ${hh}:${mi}`;
}
function escapeHtml(s) {
  return String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

// --- Drucken (PDF, DIN A4 Hochformat) ---
// Erzeugt das Protokoll als PDF (jsPDF + autoTable, bei Bedarf nachgeladen).
// window.print() geht in der installierten App auf dem iPad ins Leere, das PDF
// dagegen öffnet dort das Teilen-Menü mit „Drucken“ und „In Dateien sichern“.
const JSPDF_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js',
];
let _jspdfPromise = null;
function loadJsPdf() {
  if (window.jspdf?.jsPDF?.API?.autoTable) return Promise.resolve(window.jspdf.jsPDF);
  if (_jspdfPromise) return _jspdfPromise;
  const lade = (src) => new Promise((resolve, reject) => {
    const el = fremdesSkript(src);
    el.onload = resolve;
    el.onerror = () => reject(new Error('PDF-Bibliothek konnte nicht geladen werden'));
    document.head.appendChild(el);
  });
  _jspdfPromise = lade(JSPDF_URLS[0]).then(() => lade(JSPDF_URLS[1]))
    .then(() => window.jspdf.jsPDF)
    .catch((e) => { _jspdfPromise = null; throw e; });
  return _jspdfPromise;
}

// Datei an den Nutzer geben: in der installierten App über das Teilen-Menü
// (Downloads gehen dort unter iOS ins Leere), sonst normal herunterladen.
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

// Druckfarben (heller Satz, fest: ein PDF hat kein Dunkel)
const PDF_FARBE = { text: [27, 22, 19], muted: [98, 90, 83], linie: [214, 210, 205], flaeche: [243, 241, 239], rot: [196, 32, 26] };

async function printEinsatz() {
  const e = STATE.currentEinsatz;
  if (!e) return;
  const btn = $('#btn-print');
  btn.disabled = true;
  try {
    const JsPdf = await loadJsPdf();
    const doc = new JsPdf({ unit: 'mm', format: 'a4' });
    const F = PDF_FARBE, B = 210, RAND = 14;
    let y = 20;
    // Standardschrift kennt nur WinAnsi: Bindestrich-Varianten auf "-" abbilden
    const t = (v) => String(v ?? '').replace(/[\u2010-\u2012]/g, '-');
    const tabelle = (opts) => {
      doc.autoTable({
        startY: y, margin: { left: RAND, right: RAND }, theme: 'plain',
        styles: { font: 'helvetica', fontSize: 10, textColor: F.text, cellPadding: { top: 1.6, bottom: 1.6, left: 2, right: 2 }, lineColor: F.linie, lineWidth: { bottom: 0.2 } },
        headStyles: { fontStyle: 'bold', fillColor: F.flaeche },
        ...opts,
      });
      y = doc.lastAutoTable.finalY + 6;
    };
    const ueberschrift = (txt) => {
      y += 3;
      if (y > 265) { doc.addPage(); y = 20; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...F.text);
      doc.text(txt, RAND, y);
      doc.setDrawColor(...F.linie); doc.setLineWidth(0.2); doc.line(RAND, y + 1.8, B - RAND, y + 1.8);
      y += 7;
    };
    const leer = (txt) => {
      doc.setFont('helvetica', 'italic'); doc.setFontSize(10); doc.setTextColor(...F.muted);
      doc.text(txt, RAND, y); y += 8;
    };

    // Kopf
    const status = e.status === 'abgeschlossen'
      ? `Abgeschlossen${e.abgeschlossen_by ? ' von ' + e.abgeschlossen_by : ''}${e.abgeschlossen_at ? ' · ' + formatSqlDateTime(e.abgeschlossen_at) : ''}`
      : 'Offen';
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(...F.rot);
    doc.text('Einsatzprotokoll FF Musterwehr', RAND, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5); doc.setTextColor(...F.muted);
    doc.text(t(`${formatDate(e.alarm_datum)} · ${e.alarm_uhrzeit || ''} Uhr — ${status}`), RAND, y + 6);
    doc.setDrawColor(...F.rot); doc.setLineWidth(0.6); doc.line(RAND, y + 9, B - RAND, y + 9);
    y += 15;

    tabelle({
      body: [
        ['Alarmierte Einheit', e.alarmierte_einheit || '—'],
        ['Einsatzort', e.einsatzort || '—'],
        ['Einsatzgrund', e.einsatzgrund || '—'],
        ['Einsatzleiter', e.einsatzleiter || '—'],
        ['Km bis Einsatzstelle', e.km_einsatzstelle ?? '—'],
        ['Gesamt Km', e.km_gesamt ?? '—'],
      ].map(([k, v]) => [k, t(v)]),
      columnStyles: { 0: { fontStyle: 'bold', textColor: F.muted, cellWidth: 55 } },
    });

    ueberschrift('FFen vor Ort');
    const ffNamen = (e.ff_ids || [])
      .map((id) => STATE.ffenStamm.find((f) => f.id === id))
      .filter(Boolean)
      .map((f) => [t(`${f.kuerzel} — ${f.name}`)]);
    if (ffNamen.length) tabelle({ body: ffNamen }); else leer('Keine weiteren FFen vor Ort.');
    const ersteFf = e.erste_ff_id ? STATE.ffenStamm.find((f) => f.id === e.erste_ff_id) : null;
    if (ersteFf) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...F.muted);
      doc.text(t(`Zuerst vor Ort: ${ersteFf.kuerzel} — ${ersteFf.name}`), RAND, y - 2); y += 5;
    }

    ueberschrift('Eingesetzte Fahrzeuge');
    if (!(e.fahrzeuge || []).length) leer('Keine Fahrzeuge erfasst.');
    for (const f of (e.fahrzeuge || [])) {
      const ende = f.ende_datum ? `${formatDate(f.ende_datum)} ${f.ende_uhrzeit || ''}`.trim() : '—';
      const besatzung = (f.besatzung || []).map((b) => [t(b.position), t(displayName(b) || '—')]);
      tabelle({
        head: [[t(`${f.kennung} — ${f.name}`), t(`Einsatzende: ${ende}`)]],
        body: besatzung.length ? besatzung : [[{ content: 'Keine Besatzung erfasst.', colSpan: 2, styles: { fontStyle: 'italic', textColor: F.muted } }]],
        columnStyles: { 0: { cellWidth: 40 } },
        didParseCell: (c) => { if (c.section === 'head' && c.column.index === 1) { c.cell.styles.halign = 'right'; c.cell.styles.fontStyle = 'normal'; c.cell.styles.textColor = F.muted; } },
      });
    }

    ueberschrift('Atemschutz (PA)');
    if ((e.pa || []).length) {
      tabelle({
        head: [['Name', 'Dauer (Min)']],
        body: e.pa.map((p) => [t(displayName(p) || '—'), p.dauer_minuten ?? '—']),
        columnStyles: { 1: { cellWidth: 30, halign: 'right' } },
      });
    } else leer('Keine PA-Einsätze erfasst.');

    ueberschrift('Verunfallte (KFZ-Kennzeichen)');
    if ((e.verunfallte || []).length) tabelle({ body: e.verunfallte.map((v) => [t(v.kennzeichen)]) });
    else leer('Keine Kennzeichen erfasst.');

    ueberschrift('Notizen');
    tabelle({ body: [[t(e.notizen || '—')]], styles: { font: 'helvetica', fontSize: 10, textColor: F.text, cellPadding: 0 } });

    // Fußzeile auf jeder Seite
    const seiten = doc.internal.getNumberOfPages();
    const gedruckt = formatDateTime(new Date().toISOString());
    for (let i = 1; i <= seiten; i++) {
      doc.setPage(i);
      doc.setDrawColor(...F.linie); doc.setLineWidth(0.2); doc.line(RAND, 284, B - RAND, 284);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...F.muted);
      doc.text(t(`Erfasst von ${e.created_by || '—'} · Gedruckt am ${gedruckt}`), RAND, 289);
      doc.text(`Seite ${i} von ${seiten}`, B - RAND, 289, { align: 'right' });
    }
    await dateiAusgeben(doc.output('blob'), `Einsatzprotokoll_${e.alarm_datum || 'ohne-Datum'}_${e.id}.pdf`);
  } catch (err) {
    toast('PDF fehlgeschlagen: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}
