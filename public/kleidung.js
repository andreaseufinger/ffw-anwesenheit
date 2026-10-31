// Modul Kleidung (Konzept PSA und Atemschutz, Etappe 2).
//
// Wird von app.js erst beim ersten Öffnen nachgeladen und nutzt dessen
// Helfer ($, STATE, escapeHtml, formatDate, toast, toastRueckgaengig,
// bestaetigen, hinweis, seitenkopf, leerZustand, loadJsPdf). Status und
// Fälligkeit rechnet der Server (functions/_lib/kleidung.js).
//
// ZMS-Hessen bleibt führend für Bestand und Ausgabe. Hier gibt es nur:
// Reinigung (zugleich Prüfung), "Abgegeben zur Reinigung", Teile erfassen,
// die noch nicht in ZMS stehen, und den Import aus ZMS.

const KL_STATUS_TEXT = {
  dunkelgruen: 'gültig', gelb: 'bald fällig', rot: 'überfällig',
  unbekannt: 'ohne Datum', ohne: 'ohne Intervall',
};
// Die Etiketten der Gemeinde tragen einen Data-Matrix-Code (kein QR). Safari
// hat keinen BarcodeDetector, Chrome nur auf manchen Systemen; dann liest die
// Nachbildung auf Basis von ZXing (lädt ihr WebAssembly von jsDelivr).
const KL_DETEKTOR_URL = 'https://cdn.jsdelivr.net/npm/barcode-detector@3.2.2/dist/iife/ponyfill.js';
const KL_FORMATE = ['data_matrix', 'qr_code'];

let KL = null;   // letzte Antwort von /api/kleidung
const klFilter = { suche: '', nurAgt: false, ansicht: 'alle' };   // alle | faellig | reinigung | ohne

function klHeute() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
}

async function klSende(url, method = 'GET', body) {
  const res = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(d.error || 'HTTP ' + res.status); e.status = res.status; e.daten = d; throw e; }
  return d;
}

window.ladeKleidung = async function ladeKleidung() {
  const box = $('#kl-inhalt');
  if (!KL) box.innerHTML = '<p class="empty">lädt …</p>';
  try {
    KL = await klSende('/api/kleidung');
    // Vorschläge nach Einsätzen: Fehler hier darf die Liste nicht verhindern
    KL.vorschlaege = await klSende('/api/kleidung/vorschlaege').catch(() => []);
  }
  catch (err) {
    if (err.status === 401) { showLogin(); return; }
    leerZustand(box, { icon: 'fehler', titel: 'Kleidung nicht abrufbar', text: err.message,
      knopf: 'Erneut laden', aktion: window.ladeKleidung });
    return;
  }
  klRender();
};

function klStatusText(t) {
  if (t.in_reinigung_seit) return `in Reinigung seit ${formatDate(t.in_reinigung_seit)}`;
  if (t.status === 'unbekannt') return 'keine Reinigung erfasst';
  if (t.status === 'ohne') return t.letzte_reinigung ? `gereinigt ${formatDate(t.letzte_reinigung)}` : 'ohne Intervall';
  return `fällig ${formatDate(t.faellig_am)}`;
}
function klStatusKlasse(t) { return t.status === 'ohne' ? 'unbekannt' : t.status; }

function klGefiltert() {
  const f = klFilter.suche.trim().toLowerCase();
  return KL.teile.filter((t) => {
    if (klFilter.nurAgt && !t.agt) return false;
    if (klFilter.ansicht === 'faellig' && !['rot', 'gelb'].includes(t.status)) return false;
    if (klFilter.ansicht === 'reinigung' && !t.in_reinigung_seit) return false;
    if (klFilter.ansicht === 'ohne' && t.status !== 'unbekannt') return false;
    if (f && !`${t.person || ''} ${t.barcode} ${t.artikelart} ${t.groesse || ''}`.toLowerCase().includes(f)) return false;
    return true;
  });
}

function klRender() {
  const box = $('#kl-inhalt');
  const alle = KL.teile;
  const faellig = alle.filter((t) => t.status === 'rot').length;
  seitenkopf('view-kleidung', 'Kleidung', `${alle.length} Teile · ${faellig} überfällig`);
  const stand = KL.zms_stand
    ? `ZMS-Stand vom ${formatDate(KL.zms_stand.importiert_at.slice(0, 10))}`
    : 'Noch kein ZMS-Import';
  const zahl = (a) => alle.filter(a).length;
  const ansichten = [
    ['alle', `Alle (${alle.length})`],
    ['faellig', `Fällig (${zahl((t) => ['rot', 'gelb'].includes(t.status))})`],
    ['reinigung', `In Reinigung (${zahl((t) => t.in_reinigung_seit)})`],
    ['ohne', `Ohne Datum (${zahl((t) => t.status === 'unbekannt')})`],
  ];

  box.innerHTML = `
    <div class="agt-leiste">
      <span class="agt-stand">${escapeHtml(stand)}</span>
      <div class="agt-knoepfe">
        <button type="button" class="chip" id="kl-import-btn">ZMS-Import</button>
        <button type="button" class="chip" id="kl-neu-btn">+ Teil</button>
        <button type="button" class="chip" id="kl-arten-btn">Artikelliste</button>
      </div>
      <input type="file" id="kl-datei" accept=".csv,text/csv" hidden />
    </div>
    <button type="button" class="btn-primary kl-scan-btn" id="kl-scan-btn">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10"/></svg>
      Reinigung
    </button>
    <div id="kl-vorschlaege"></div>
    <div class="kl-filter">
      <div class="field"><label for="kl-suche">Suche</label>
        <input type="search" id="kl-suche" placeholder="Name, Inventarnummer, Art …" value="${escapeHtml(klFilter.suche)}" autocomplete="off" /></div>
      <label class="check-row"><input type="checkbox" id="kl-nur-agt" ${klFilter.nurAgt ? 'checked' : ''} /> <span>Nur AGT</span></label>
    </div>
    <div class="seg kl-ansicht" role="radiogroup" aria-label="Ansicht">
      ${ansichten.map(([k, t]) => `<label><input type="radio" name="kl-ansicht" value="${k}" ${klFilter.ansicht === k ? 'checked' : ''}><span>${t}</span></label>`).join('')}
    </div>
    <div id="kl-liste"></div>`;

  $('#kl-suche').addEventListener('input', (e) => { klFilter.suche = e.target.value; klListe(); });
  $('#kl-nur-agt').addEventListener('change', (e) => { klFilter.nurAgt = e.target.checked; klListe(); });
  box.querySelectorAll('input[name="kl-ansicht"]').forEach((r) => r.addEventListener('change', () => {
    klFilter.ansicht = r.value; klListe();
  }));
  $('#kl-scan-btn').addEventListener('click', () => klScanner('abgeben'));
  $('#kl-import-btn').addEventListener('click', () => $('#kl-datei').click());
  $('#kl-datei').addEventListener('change', klImportDatei);
  $('#kl-neu-btn').addEventListener('click', () => klNeuDialog());
  $('#kl-arten-btn').addEventListener('click', klArtenDialog);
  klVorschlaege();
  klListe();
}

// Nach Einsätzen mit PA-Trägern: deren Kleidung (Arten, die für AGT zählen)
// zur Reinigung vorschlagen. Der Kleiderwart bestätigt oder ignoriert.
function klVorschlaege() {
  const ziel = $('#kl-vorschlaege');
  const liste = KL.vorschlaege || [];
  if (!liste.length) { ziel.innerHTML = ''; return; }
  ziel.innerHTML = `<div class="kl-vorschlaege">
    <div class="marke-klein">Nach Einsätzen unter Atemschutz</div>
    ${liste.map((v) => `
      <div class="kl-vorschlag">
        <div><strong>${formatDate(v.datum)} · ${escapeHtml(v.titel)}</strong>
          <div class="muted">${v.personen.map(escapeHtml).join(', ')} · ${v.teile.length} Teil${v.teile.length === 1 ? '' : 'e'}: ${[...new Set(v.teile.map((t) => t.artikelart))].map(escapeHtml).join(', ')}</div></div>
        <div class="kl-knopfreihe">
          <button type="button" class="btn-primary" data-v-ok="${v.einsatz_id}">Zur Reinigung geben</button>
          <button type="button" class="btn-secondary" data-v-weg="${v.einsatz_id}">Ignorieren</button>
        </div>
      </div>`).join('')}
  </div>`;
  const tun = async (id, aktion) => {
    try {
      const d = await klSende('/api/kleidung/vorschlaege', 'POST', { einsatz_id: Number(id), aktion, datum: klHeute() });
      toast(aktion === 'uebernehmen' ? `${d.teile} Teile zur Reinigung gegeben` : 'Vorschlag ausgeblendet', 'success');
      await window.ladeKleidung();
    } catch (err) { toast('Fehler: ' + err.message, 'error'); }
  };
  ziel.querySelectorAll('[data-v-ok]').forEach((b) => b.addEventListener('click', () => tun(b.dataset.vOk, 'uebernehmen')));
  ziel.querySelectorAll('[data-v-weg]').forEach((b) => b.addEventListener('click', () => tun(b.dataset.vWeg, 'ignorieren')));
}

function klListe() {
  const ziel = $('#kl-liste');
  const teile = klGefiltert();
  if (!KL.teile.length) {
    leerZustand(ziel, { icon: 'liste', titel: 'Noch keine Kleidung',
      text: 'Den Export „persönliche Ausrüstung“ aus ZMS-Hessen importieren. Übernommen wird nur Schutzkleidung mit Inventarnummer BRE…',
      knopf: 'ZMS-Import', aktion: () => $('#kl-datei').click() });
    return;
  }
  if (!teile.length) {
    leerZustand(ziel, { icon: 'suche', titel: 'Keine Treffer', text: 'Kein Teil passt zu Filter und Suche.',
      knopf: 'Filter zurücksetzen', aktion: () => { Object.assign(klFilter, { suche: '', nurAgt: false, ansicht: 'alle' }); klRender(); } });
    return;
  }
  // nach Person gruppiert, nicht ausgegebene Teile am Ende
  const gruppen = new Map();
  for (const t of teile) {
    const k = t.person_id ? `p${t.person_id}` : 'lager';
    if (!gruppen.has(k)) gruppen.set(k, { person: t.person, agt: t.agt, teile: [] });
    gruppen.get(k).teile.push(t);
  }
  const reihe = [...gruppen.entries()].sort((a, b) =>
    a[0] === 'lager' ? 1 : b[0] === 'lager' ? -1 : a[1].person.localeCompare(b[1].person, 'de'));
  ziel.innerHTML = `
    ${klFilter.ansicht === 'reinigung' ? '<button type="button" class="chip kl-pdf" id="kl-pdf">Liste als PDF</button>' : ''}
    <div class="kl-gruppen">${reihe.map(([, g]) => `
      <section class="kl-gruppe">
        <h3 class="kl-person">${g.person ? escapeHtml(g.person) : 'Nicht ausgegeben'}${g.agt ? ' <span class="agt-plakette">AGT</span>' : ''}<span class="kl-anzahl">${g.teile.length}</span></h3>
        <ul class="kl-teile">${g.teile.map((t) => `
          <li><button type="button" class="kl-teil" data-id="${t.id}">
            <span class="kl-art">${escapeHtml(t.artikelart)}${t.groesse ? ` <span class="muted">· ${escapeHtml(t.groesse)}</span>` : ''}</span>
            <span class="kl-nr">${escapeHtml(t.barcode)}${t.quelle === 'app' ? ' · nur in der App' : ''}</span>
            <span class="agt-st st-${klStatusKlasse(t)} kl-st">${escapeHtml(klStatusText(t))}</span>
          </button></li>`).join('')}</ul>
      </section>`).join('')}</div>`;
  ziel.querySelectorAll('.kl-teil').forEach((b) => b.addEventListener('click', () => klTeilDialog(Number(b.dataset.id))));
  const pdf = $('#kl-pdf');
  if (pdf) pdf.addEventListener('click', () => klReinigungsPdf(teile));
}

// --- Dialog-Gerüst -------------------------------------------------------

function klDialog(html) {
  const dlg = $('#kl-dialog');
  dlg.innerHTML = html;
  dlg.querySelectorAll('[data-schliessen]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  if (!dlg.open) dlg.showModal();
  return dlg;
}

let _klPersonen = null;
async function klPersonen() {
  if (!_klPersonen) _klPersonen = await klSende('/api/kleidung/personen');
  return _klPersonen;
}

// --- Reinigung -----------------------------------------------------------

async function klReinigung(aktion, ids, datum) {
  const d = await klSende('/api/kleidung/reinigung', 'POST', { aktion, ids, datum });
  return d;
}
function klRueckgaengig(d, text) {
  if (!d.eintraege?.length) return;
  toastRueckgaengig(text, async () => {
    await klSende('/api/kleidung/reinigung', 'POST', { aktion: 'rueckgaengig', eintraege: d.eintraege });
    await window.ladeKleidung();
  });
}

// --- Teil ----------------------------------------------------------------

async function klTeilDialog(id) {
  let t;
  try { t = await klSende(`/api/kleidung/teile/${id}`); }
  catch (err) { hinweis('Teil nicht abrufbar\n\n' + err.message); return; }
  const app = t.quelle === 'app';
  const personen = app ? await klPersonen().catch(() => []) : [];
  // Letzte Buchung zurücknehmen: eine offene Abgabe zuerst, sonst die jüngste
  // Reinigung (mit Abgabe: wieder "in Reinigung", nachgetragen: austragen).
  const letzte = t.reinigungen.find((r) => !r.gereinigt_am) || t.reinigungen[0] || null;
  const rueck = !letzte ? null
    : !letzte.gereinigt_am ? { text: `Abgabe vom ${formatDate(letzte.abgegeben_am)} zurücknehmen`, art: 'loeschen' }
    : letzte.abgegeben_am ? { text: `„Gereinigt ${formatDate(letzte.gereinigt_am)}“ zurücknehmen`, art: 'oeffnen' }
    : { text: `Reinigung vom ${formatDate(letzte.gereinigt_am)} austragen`, art: 'loeschen' };
  const dlg = klDialog(`
    <form method="dialog" class="agt-form">
      <h3>${escapeHtml(t.artikelart || t.typ || 'Teil')}</h3>
      <p class="agt-unter">${escapeHtml(t.barcode)}${t.groesse ? ' · Größe ' + escapeHtml(t.groesse) : ''} · ${app ? 'nur in der App erfasst' : 'aus ZMS-Hessen'}${t.im_bestand ? '' : ' · nicht mehr im ZMS-Export'}</p>
      <div class="agt-status-zeile">
        <span class="agt-st st-${klStatusKlasse(t)}">${escapeHtml(KL_STATUS_TEXT[t.status] || t.status)}</span>
        <span>${escapeHtml(klStatusText(t))}</span>
      </div>
      ${app ? `
        <div class="field"><label for="kl-t-person">Ausgegeben an</label>
          <select id="kl-t-person"><option value="">— nicht ausgegeben —</option>
          ${personen.map((p) => `<option value="${p.id}" ${p.id === t.person_id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select></div>`
        : `<p>Ausgegeben an: <strong>${t.person ? escapeHtml(t.person) : 'niemand'}</strong>${t.standort ? ' · ' + escapeHtml(t.standort) : ''}<br><span class="muted">Änderungen der Ausgabe in ZMS-Hessen buchen; sie kommen mit dem nächsten Import.</span></p>`}
      <fieldset class="agt-eintragen">
        <legend>Reinigung</legend>
        ${t.in_reinigung_seit
          ? `<div class="field"><label for="kl-t-datum">Zurück aus der Reinigung am</label><input type="date" id="kl-t-datum" value="${klHeute()}" /></div>
             <button type="button" class="btn-primary" id="kl-t-zurueck">Gereinigt zurück</button>`
          : `<div class="row-2">
               <div class="field"><label for="kl-t-datum">Datum</label><input type="date" id="kl-t-datum" value="${klHeute()}" /></div>
             </div>
             <div class="kl-knopfreihe">
               <button type="button" class="btn-primary" id="kl-t-abgeben">Zur Reinigung geben</button>
               <button type="button" class="btn-secondary" id="kl-t-nachtragen">Reinigung nachtragen</button>
             </div>`}
        ${rueck ? `<button type="button" class="btn-secondary kl-t-rueck" id="kl-t-rueck" aria-describedby="kl-t-rueck-text">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>
            <span>Rückgängig</span></button>
          <span class="muted kl-t-rueck-text" id="kl-t-rueck-text">${escapeHtml(rueck.text)}</span>` : ''}
      </fieldset>
      ${t.reinigungen.length ? `
        <div class="agt-verlauf">
          <div class="marke-klein">Bisherige Reinigungen</div>
          <ul>${t.reinigungen.map((r) => `<li class="kl-r-zeile">
            <span>${r.gereinigt_am ? 'gereinigt ' + formatDate(r.gereinigt_am) : 'in Reinigung'}</span>
            <span class="muted">${r.abgegeben_am ? 'abgegeben ' + formatDate(r.abgegeben_am) : 'nachgetragen'}${r.gereinigt_by || r.abgegeben_by ? ' · ' + escapeHtml(r.gereinigt_by || r.abgegeben_by) : ''}</span>
            <button type="button" class="icon-btn kl-r-weg" data-rid="${r.id}" aria-label="Eintrag austragen" title="Eintrag austragen">${ICON.del}</button>
          </li>`).join('')}</ul>
        </div>` : ''}
      <div class="dialog-actions">
        ${app ? '<button type="button" class="btn-danger" id="kl-t-loeschen">Löschen</button>' : ''}
        <button type="button" class="btn-primary" data-schliessen>Fertig</button>
      </div>
    </form>`);

  const datum = () => dlg.querySelector('#kl-t-datum').value;
  const nach = async (aktion, text) => {
    if (!datum()) { toast('Datum fehlt', 'error'); return; }
    try {
      const d = await klReinigung(aktion, [t.id], datum());
      await window.ladeKleidung();
      klRueckgaengig(d, text);
      klTeilDialog(t.id);
    } catch (err) { toast('Fehler: ' + err.message, 'error'); }
  };
  dlg.querySelector('#kl-t-abgeben')?.addEventListener('click', () => nach('abgeben', `${t.barcode} zur Reinigung gegeben`));
  dlg.querySelector('#kl-t-nachtragen')?.addEventListener('click', () => nach('zurueck', `Reinigung für ${t.barcode} nachgetragen`));
  dlg.querySelector('#kl-t-zurueck')?.addEventListener('click', () => nach('zurueck', `${t.barcode} gereinigt zurück`));
  // Korrekturen: Eintrag austragen oder "gereinigt" zurücknehmen
  const korrigiere = async (rid, art, frage) => {
    if (!await bestaetigen(frage, { ok: art === 'oeffnen' ? 'Zurücknehmen' : 'Austragen' })) return;
    try {
      if (art === 'oeffnen') await klSende(`/api/kleidung/reinigung/${rid}`, 'PUT', { gereinigt: false });
      else await klSende(`/api/kleidung/reinigung/${rid}`, 'DELETE');
      await window.ladeKleidung();
      toast(art === 'oeffnen' ? 'Zurückgenommen: Teil ist wieder in der Reinigung' : 'Eintrag ausgetragen', 'success');
      klTeilDialog(t.id);
    } catch (err) { toast('Fehler: ' + err.message, 'error'); }
  };
  dlg.querySelector('#kl-t-rueck')?.addEventListener('click', () => korrigiere(letzte.id, rueck.art,
    rueck.art === 'oeffnen' ? `${rueck.text}?\nDas Teil gilt dann wieder als in der Reinigung.`
      : `${rueck.text}?\nDer Eintrag wird gelöscht.`));
  dlg.querySelectorAll('.kl-r-weg').forEach((b) => b.addEventListener('click', () => {
    const r = t.reinigungen.find((x) => x.id === Number(b.dataset.rid));
    const was = r.gereinigt_am ? `Reinigung vom ${formatDate(r.gereinigt_am)}` : `Abgabe vom ${formatDate(r.abgegeben_am)}`;
    korrigiere(r.id, 'loeschen', `${was} austragen?\nAbgabe und Reinigung dieses Eintrags werden gelöscht.`);
  }));
  dlg.querySelector('#kl-t-person')?.addEventListener('change', async (e) => {
    try { await klSende(`/api/kleidung/teile/${t.id}`, 'PUT', { person_id: e.target.value || null }); await window.ladeKleidung(); toast('Zuordnung gespeichert', 'success'); }
    catch (err) { toast('Fehler: ' + err.message, 'error'); }
  });
  dlg.querySelector('#kl-t-loeschen')?.addEventListener('click', async () => {
    if (!await bestaetigen(`Teil ${t.barcode} löschen?\n\nDas Teil und seine Reinigungen werden entfernt.`)) return;
    try { await klSende(`/api/kleidung/teile/${t.id}`, 'DELETE'); dlg.close(); await window.ladeKleidung(); }
    catch (err) { toast('Fehler: ' + err.message, 'error'); }
  });
}

async function klNeuDialog(barcode = '') {
  let personen = [];
  try { personen = await klPersonen(); } catch {}
  const dlg = klDialog(`
    <form method="dialog" class="agt-form">
      <h3>Teil erfassen</h3>
      <p class="agt-unter">Für Teile, die noch nicht in ZMS-Hessen stehen. Taucht das Teil später im ZMS-Export auf, übernimmt ZMS.</p>
      <div class="field"><label for="kl-n-barcode">Inventarnummer der Gemeinde</label>
        <input type="text" id="kl-n-barcode" placeholder="BRE001234" value="${escapeHtml(barcode)}" autocapitalize="characters" autocomplete="off" /></div>
      <div class="row-2">
        <div class="field"><label for="kl-n-art">Artikelart</label>
          <select id="kl-n-art">${KL.artikelarten.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="kl-n-groesse">Größe</label><input type="text" id="kl-n-groesse" autocomplete="off" /></div>
      </div>
      <div class="field"><label for="kl-n-person">Ausgegeben an</label>
        <select id="kl-n-person"><option value="">— nicht ausgegeben —</option>
        ${personen.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}${p.agt ? ' (AGT)' : ''}</option>`).join('')}</select></div>
      <div class="dialog-actions">
        <button type="button" class="btn-secondary" data-schliessen>Abbrechen</button>
        <button type="button" class="btn-primary" id="kl-n-ok">Erfassen</button>
      </div>
    </form>`);
  dlg.querySelector('#kl-n-ok').addEventListener('click', async () => {
    try {
      const d = await klSende('/api/kleidung/teile', 'POST', {
        barcode: dlg.querySelector('#kl-n-barcode').value,
        artikelart_id: Number(dlg.querySelector('#kl-n-art').value),
        groesse: dlg.querySelector('#kl-n-groesse').value,
        person_id: dlg.querySelector('#kl-n-person').value || null,
      });
      dlg.close();
      toast('Teil erfasst', 'success');
      await window.ladeKleidung();
      klTeilDialog(d.id);
    } catch (err) { toast('Fehler: ' + err.message, 'error'); }
  });
}

// --- Artikelliste --------------------------------------------------------

async function klArtenDialog() {
  let d;
  try { d = await klSende('/api/kleidung/artikelarten'); }
  catch (err) { hinweis('Artikelliste nicht abrufbar\n\n' + err.message); return; }
  const dlg = klDialog(`
    <form method="dialog" class="agt-form">
      <h3>Artikelliste</h3>
      <p class="agt-unter">Prüfintervall je Artikelart (leer = nur führen) und ob die Art für den Kleidungsstatus der AGT zählt.</p>
      <div class="kl-arten">
        <div class="kl-arten-kopf"><span>Artikelart</span><span>Monate</span><span>AGT</span></div>
        ${d.artikelarten.map((a) => `
          <div class="kl-art-zeile" data-id="${a.id}">
            <span>${escapeHtml(a.name)} <span class="muted">· ${a.teile} Teile</span></span>
            <input type="number" min="1" max="120" inputmode="numeric" value="${a.intervall_monate ?? ''}" aria-label="Prüfintervall ${escapeHtml(a.name)} in Monaten" />
            <input type="checkbox" ${a.agt_relevant ? 'checked' : ''} aria-label="${escapeHtml(a.name)} zählt für AGT-Kleidung" />
          </div>`).join('')}
      </div>
      <div class="kl-knopfreihe">
        <input type="text" id="kl-a-neu" placeholder="Neue Artikelart" autocomplete="off" aria-label="Neue Artikelart" />
        <button type="button" class="btn-secondary" id="kl-a-neu-ok">Hinzufügen</button>
      </div>
      <details class="hinweis">
        <summary>Bezeichnungen aus ZMS (${d.typen.length})</summary>
        <div class="kl-typen">${d.typen.map((t) => `
          <div class="field"><label>${escapeHtml(t.typ)}</label>
            <select data-typ="${escapeHtml(t.typ)}"><option value="">nicht führen</option>
            ${d.artikelarten.map((a) => `<option value="${a.id}" ${a.id === t.artikelart_id ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}</select></div>`).join('')}</div>
      </details>
      <div class="dialog-actions"><button type="button" class="btn-primary" data-schliessen>Fertig</button></div>
    </form>`);
  dlg.querySelectorAll('.kl-art-zeile').forEach((z) => {
    const id = z.dataset.id;
    const [zahl, haken] = z.querySelectorAll('input');
    zahl.addEventListener('change', async () => {
      try { await klSende(`/api/kleidung/artikelarten/${id}`, 'PUT', { intervall_monate: zahl.value === '' ? null : Number(zahl.value) }); toast('Intervall gespeichert', 'success'); await window.ladeKleidung(); }
      catch (err) { toast('Fehler: ' + err.message, 'error'); }
    });
    haken.addEventListener('change', async () => {
      try { await klSende(`/api/kleidung/artikelarten/${id}`, 'PUT', { agt_relevant: haken.checked }); toast('Gespeichert', 'success'); }
      catch (err) { haken.checked = !haken.checked; toast('Fehler: ' + err.message, 'error'); }
    });
  });
  dlg.querySelector('#kl-a-neu-ok').addEventListener('click', async () => {
    const name = dlg.querySelector('#kl-a-neu').value.trim();
    if (!name) return;
    try { await klSende('/api/kleidung/artikelarten', 'POST', { name, intervall_monate: 12 }); await window.ladeKleidung(); klArtenDialog(); }
    catch (err) { toast('Fehler: ' + err.message, 'error'); }
  });
  dlg.querySelectorAll('select[data-typ]').forEach((sel) => sel.addEventListener('change', async () => {
    try { await klSende('/api/kleidung/typen', 'PUT', { typ: sel.dataset.typ, artikelart_id: sel.value ? Number(sel.value) : null }); toast('Zuordnung gespeichert', 'success'); await window.ladeKleidung(); }
    catch (err) { toast('Fehler: ' + err.message, 'error'); }
  }));
}

// --- Scanner -------------------------------------------------------------
// Kamera mit BarcodeDetector, wo er Data Matrix kann, sonst die ZXing-Nachbildung
// (Safari/iPhone). Jeder erkannte Code wird sofort gebucht; derselbe Code
// innerhalb von 3 s wird ignoriert. Getippte Nummern gehen denselben Weg.

let _klStream = null, _klLauf = null;
window.kleidungScannerStopp = function () {
  if (_klLauf) { cancelAnimationFrame(_klLauf); _klLauf = null; }
  if (_klStream) { _klStream.getTracks().forEach((t) => t.stop()); _klStream = null; }
  const dlg = $('#kl-scan');
  if (dlg?.open) dlg.close();
};

// Eingebauter Detektor, wenn er Data Matrix kann, sonst die Nachbildung.
async function klDetektor() {
  if ('BarcodeDetector' in window) {
    try {
      const formate = await window.BarcodeDetector.getSupportedFormats();
      if (formate.includes('data_matrix')) return new window.BarcodeDetector({ formats: KL_FORMATE });
    } catch { /* weiter mit der Nachbildung */ }
  }
  if (!window.BarcodeDetectionAPI) {
    await new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = KL_DETEKTOR_URL;
      el.onload = resolve;
      el.onerror = () => reject(new Error('Code-Erkennung nicht ladbar'));
      document.head.appendChild(el);
    });
  }
  return new window.BarcodeDetectionAPI.BarcodeDetector({ formats: KL_FORMATE });
}

// Reinigung: Scan, Treffer oder eingetippte Nummer kommen erst auf eine
// Liste; gebucht wird gesammelt mit "Buchen". Nur "Suchen" öffnet das Teil
// sofort.
let klSammel = [];

async function klScanner(modus) {
  klSammel = [];
  const dlg = $('#kl-scan');
  dlg.innerHTML = `
    <div class="kl-scan-kopf">
      <h3>Reinigung</h3>
      <button type="button" class="icon-btn" id="kl-s-zu" aria-label="Schließen" title="Schließen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <div class="seg kl-s-modus" role="radiogroup" aria-label="Was soll gebucht werden?">
      <label><input type="radio" name="kl-modus" value="abgeben" ${modus === 'abgeben' ? 'checked' : ''}><span>Zur Reinigung</span></label>
      <label><input type="radio" name="kl-modus" value="zurueck" ${modus === 'zurueck' ? 'checked' : ''}><span>Gereinigt</span></label>
      <label><input type="radio" name="kl-modus" value="suchen" ${modus === 'suchen' ? 'checked' : ''}><span>Suchen</span></label>
    </div>
    <div class="field kl-s-datum-feld"><label for="kl-s-datum">Datum</label><input type="date" id="kl-s-datum" value="${klHeute()}" /></div>
    <h4 class="kl-s-titel">Scannen</h4>
    <div class="kl-video"><video id="kl-video" playsinline muted></video><div class="kl-rahmen" aria-hidden="true"></div>
      <p class="kl-video-hinweis" id="kl-video-hinweis">Kamera wird gestartet …</p></div>
    <div class="kl-knopfreihe">
      <input type="search" id="kl-s-code" placeholder="Nummer oder Name" autocapitalize="characters" autocomplete="off" aria-label="Inventarnummer oder Name suchen" aria-controls="kl-s-treffer" />
      <button type="button" class="btn-secondary" id="kl-s-ok">Hinzufügen</button>
    </div>
    <ul class="kl-s-treffer" id="kl-s-treffer" aria-label="Treffer"></ul>
    <div class="kl-s-sammel" id="kl-s-sammel">
      <h4 class="kl-s-titel" id="kl-s-liste-titel">Liste</h4>
      <ul class="kl-s-protokoll" id="kl-s-liste" aria-live="polite"></ul>
      <button type="button" class="btn-primary" id="kl-s-buchen" disabled>Buchen</button>
    </div>
    <ul class="kl-s-protokoll" id="kl-s-protokoll" aria-live="polite"></ul>`;
  dlg.showModal();
  const modusVon = () => dlg.querySelector('input[name="kl-modus"]:checked').value;
  const datumFeld = dlg.querySelector('.kl-s-datum-feld');
  const umschalten = () => {
    const suchen = modusVon() === 'suchen';
    datumFeld.classList.toggle('hidden', suchen);
    dlg.querySelector('#kl-s-sammel').classList.toggle('hidden', suchen);
    dlg.querySelector('#kl-s-ok').textContent = suchen ? 'Öffnen' : 'Hinzufügen';
    klListeZeigen(modusVon());
  };
  dlg.querySelectorAll('input[name="kl-modus"]').forEach((r) => r.addEventListener('change', umschalten));
  umschalten();

  const zu = async () => {
    if (klSammel.length && !await bestaetigen(
      `Liste verwerfen?\n${klSammel.length === 1 ? 'Ein Teil ist' : `${klSammel.length} Teile sind`} noch nicht gebucht.`,
      { ok: 'Verwerfen' })) return;
    klSammel = [];
    window.kleidungScannerStopp();
    await window.ladeKleidung();
  };
  dlg.querySelector('#kl-s-zu').addEventListener('click', zu);
  dlg.oncancel = (e) => { e.preventDefault(); zu(); };
  dlg.querySelector('#kl-s-buchen').addEventListener('click', () =>
    klListeBuchen(modusVon(), dlg.querySelector('#kl-s-datum').value));

  const eingabe = dlg.querySelector('#kl-s-code');
  const trefferEl = dlg.querySelector('#kl-s-treffer');
  let treffer = [];
  const nehmen = (code) => {
    eingabe.value = ''; treffer = []; trefferEl.innerHTML = '';
    klCodeNehmen(code, modusVon());
    eingabe.focus();
  };
  // Eindeutiger Treffer geht vor, sonst die Eingabe wie getippt (der Server
  // erkennt auch "BRE 2180" oder die Identifikation).
  const tippen = () => {
    const c = eingabe.value.trim();
    if (c) nehmen(treffer.length === 1 ? treffer[0].barcode : c);
  };
  dlg.querySelector('#kl-s-ok').addEventListener('click', tippen);
  eingabe.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); tippen(); } });
  eingabe.addEventListener('input', () => {
    treffer = klTreffer(eingabe.value);
    trefferEl.innerHTML = treffer.map((t, i) => `<li><button type="button" class="kl-s-treffer-zeile" data-i="${i}">
        <strong>${escapeHtml(t.barcode)}</strong>
        <span class="muted">${escapeHtml([t.artikelart, t.groesse && `Gr. ${t.groesse}`, t.person].filter(Boolean).join(' · '))}</span>
      </button></li>`).join('');
    trefferEl.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => nehmen(treffer[Number(b.dataset.i)].barcode)));
  });

  const hinweisEl = dlg.querySelector('#kl-video-hinweis');
  try {
    // Höhere Auflösung: die Etiketten sind klein
    _klStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
  } catch (err) {
    hinweisEl.textContent = 'Keine Kamera verfügbar. Die Nummer lässt sich unten eintippen.';
    return;
  }
  const video = dlg.querySelector('#kl-video');
  video.srcObject = _klStream;
  await video.play().catch(() => {});
  hinweisEl.textContent = 'Code-Erkennung wird geladen …';

  let det;
  try { det = await klDetektor(); } catch (err) { hinweisEl.textContent = err.message + '. Bitte Nummer eintippen.'; return; }
  if (!_klStream) return;   // inzwischen geschlossen
  hinweisEl.textContent = 'Etikett mit Inventarnummer in den Rahmen halten';
  // Bild verkleinert auf eine Leinwand: schneller, und die Nachbildung liest
  // dort genauso zuverlässig (Etikett-Foto: 1280 px 250 ms, 640 px 90 ms).
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const erkenne = async () => {
    if (!video.videoWidth) return [];
    const w = Math.min(960, video.videoWidth), h = Math.round(video.videoHeight * (w / video.videoWidth));
    canvas.width = w; canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    return det.detect(canvas);
  };
  let letzter = '', letzterZeit = 0, beschaeftigt = false, zuletzt = 0, fremd = 0;
  const schleife = async (zeit) => {
    _klLauf = requestAnimationFrame(schleife);
    if (beschaeftigt || zeit - zuletzt < 250) return;
    zuletzt = zeit;
    beschaeftigt = true;
    try {
      const codes = (await erkenne()).map((c) => c.rawValue || '');
      // Nur Codes mit Gemeinde-Inventarnummer; der Code des Herstellers auf
      // demselben Etikett wird übergangen.
      const code = codes.map((c) => /BRE\d+/i.exec(c)?.[0]?.toUpperCase()).find(Boolean);
      // Was schon auf der Liste steht, still übergehen (Etikett bleibt im Bild)
      const schonDa = code && modusVon() !== 'suchen' && klSammel.some((t) => (t.barcode || '').toUpperCase() === code);
      if (code && !schonDa && (code !== letzter || Date.now() - letzterZeit > 3000)) {
        letzter = code; letzterZeit = Date.now();
        if (navigator.vibrate) navigator.vibrate(60);
        hinweisEl.textContent = `${code} erkannt`;
        await klCodeNehmen(code, modusVon());
      } else if (!code && codes.length && Date.now() - fremd > 3000) {
        fremd = Date.now();
        hinweisEl.textContent = 'Code ohne Inventarnummer – das Etikett „Feuerwehr Musterstadt“ anvisieren';
      }
    } catch { /* einzelne Bilder dürfen scheitern */ }
    beschaeftigt = false;
  };
  _klLauf = requestAnimationFrame(schleife);
}

// Trefferliste beim Eintippen: Teilnummer ("2180" findet BRE002180), sonst
// alle Wörter in Nummer, Art oder Name. Höchstens acht, Nummern, die auf die
// Eingabe enden, zuerst.
function klTreffer(eingabe) {
  const q = eingabe.trim().toLowerCase();
  if (q.length < 2 || !KL?.teile) return [];
  const woerter = q.split(/\s+/);
  const liste = KL.teile.filter((t) => {
    if (!t.barcode) return false;
    const text = `${t.barcode} ${t.identifikation || ''} ${t.artikelart || ''} ${t.person || ''}`.toLowerCase();
    return woerter.every((w) => text.includes(w));
  });
  const rang = (t) => (t.barcode.toLowerCase().endsWith(q) ? 0 : t.barcode.toLowerCase().includes(q) ? 1 : 2);
  return liste.sort((a, b) => rang(a) - rang(b) || a.barcode.localeCompare(b.barcode)).slice(0, 8);
}

function klProtokoll(klasse, html) {
  const li = document.createElement('li');
  li.className = klasse;
  li.innerHTML = html;
  $('#kl-s-protokoll').prepend(li);
  return li;
}

function klTeilName(t) {
  return `${escapeHtml(t.artikelart || t.typ || 'Teil')} · ${escapeHtml(t.barcode)}${t.person ? ' · ' + escapeHtml(t.person) : ''}`;
}

// Teil nachschlagen und auf die Liste setzen (im Modus Suchen: öffnen).
async function klCodeNehmen(code, modus) {
  let t;
  try { t = await klSende(`/api/kleidung/teil?code=${encodeURIComponent(code)}`); }
  catch (err) {
    if (err.status === 404) {
      const li = klProtokoll('kl-s-fehler', `<span><strong>${escapeHtml(err.daten?.code || code)}</strong> ist nicht bekannt</span>
        <button type="button" class="chip">Erfassen</button>`);
      li.querySelector('button').addEventListener('click', () => { klSammel = []; window.kleidungScannerStopp(); klNeuDialog(err.daten?.code || code); });
    } else klProtokoll('kl-s-fehler', `<span>${escapeHtml(err.message)}</span>`);
    return;
  }
  if (modus === 'suchen') { klSammel = []; window.kleidungScannerStopp(); klTeilDialog(t.id); return; }
  if (klSammel.some((x) => x.id === t.id)) {
    klProtokoll('kl-s-info', `<span>${klTeilName(t)}</span><span class="muted">steht schon auf der Liste</span>`);
    return;
  }
  klSammel.push(t);
  klListeZeigen(modus);
}

function klListeZeigen(modus) {
  const ul = $('#kl-s-liste');
  if (!ul) return;
  const n = klSammel.length;
  $('#kl-s-liste-titel').textContent = n ? `Liste · ${n} ${n === 1 ? 'Teil' : 'Teile'}` : 'Liste';
  ul.innerHTML = n ? klSammel.map((t, i) => {
    // Hinweis je nach Modus: schon abgegeben wird übersprungen, ohne offene
    // Abgabe wird die Reinigung nachgetragen.
    const notiz = modus === 'abgeben' && t.in_reinigung_seit ? `schon in Reinigung seit ${formatDate(t.in_reinigung_seit)}, wird übersprungen`
      : modus === 'zurueck' && !t.in_reinigung_seit ? 'nicht abgegeben, Reinigung wird nachgetragen' : '';
    return `<li class="${notiz ? 'kl-s-info' : ''}"><span>${klTeilName(t)}${notiz ? `<br><span class="muted">${escapeHtml(notiz)}</span>` : ''}</span>
      <button type="button" class="icon-btn kl-s-weg" data-i="${i}" aria-label="Von der Liste nehmen" title="Von der Liste nehmen">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></li>`;
  }).join('') : '<li class="kl-s-leer">Noch nichts gescannt. Etikett scannen oder Nummer eintippen.</li>';
  ul.querySelectorAll('.kl-s-weg').forEach((b) => b.addEventListener('click', () => {
    klSammel.splice(Number(b.dataset.i), 1);
    klListeZeigen(modus);
  }));
  const knopf = $('#kl-s-buchen');
  knopf.disabled = !n;
  knopf.textContent = !n ? 'Buchen'
    : `${n} ${n === 1 ? 'Teil' : 'Teile'} ${modus === 'zurueck' ? 'als gereinigt buchen' : 'zur Reinigung buchen'}`;
}

async function klListeBuchen(modus, datum) {
  if (!klSammel.length) return;
  if (!datum) { toast('Datum fehlt', 'error'); return; }
  const knopf = $('#kl-s-buchen');
  knopf.disabled = true;
  let d;
  try { d = await klReinigung(modus, klSammel.map((t) => t.id), datum); }
  catch (err) { toast('Fehler: ' + err.message, 'error'); klListeZeigen(modus); return; }
  const gebucht = d.eintraege?.length || 0;
  const ueber = d.uebersprungen?.length || 0;
  const text = `${gebucht} ${gebucht === 1 ? 'Teil' : 'Teile'} ${modus === 'zurueck' ? 'als gereinigt gebucht' : 'zur Reinigung gebucht'}`
    + (ueber ? ` · ${ueber} übersprungen` : '');
  const li = klProtokoll('kl-s-ok', `<span>${escapeHtml(text)}</span>${gebucht ? '<button type="button" class="chip">Rückgängig</button>' : ''}`);
  li.querySelector('button')?.addEventListener('click', async () => {
    try { await klSende('/api/kleidung/reinigung', 'POST', { aktion: 'rueckgaengig', eintraege: d.eintraege }); li.remove(); toast('Buchung zurückgenommen', 'success'); }
    catch (err) { toast('Fehler: ' + err.message, 'error'); }
  });
  if (navigator.vibrate) navigator.vibrate([40, 40, 40]);
  klSammel = [];
  klListeZeigen(modus);
}

// --- Liste der abgegebenen Teile (optional) ------------------------------

async function klReinigungsPdf(teile) {
  let jsPDF;
  try { jsPDF = await loadJsPdf(); } catch (err) { hinweis('PDF nicht möglich\n\n' + err.message); return; }
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
  doc.text('Zur Reinigung abgegeben', 16, 20);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
  doc.text(`Freiwillige Feuerwehr Musterwehr · Stand ${formatDate(klHeute())} · ${teile.length} Teile`, 16, 27);
  doc.autoTable({
    startY: 33, margin: { left: 16, right: 16 }, theme: 'grid',
    styles: { font: 'helvetica', fontSize: 9, cellPadding: 1.8 },
    headStyles: { fillColor: [243, 241, 239], textColor: [27, 22, 19] },
    head: [['Inventarnr.', 'Artikelart', 'Größe', 'Ausgegeben an', 'Abgegeben am']],
    body: teile.map((t) => [t.barcode, t.artikelart, t.groesse || '', t.person || '', formatDate(t.in_reinigung_seit || '')]),
  });
  await pdfAusgeben(doc, `Reinigung_${klHeute()}.pdf`);
}

// --- ZMS-Import ----------------------------------------------------------

function klCsv(text, sep = ';') {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true;
    else if (c === sep) { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

async function klImportDatei(e) {
  const datei = e.target.files?.[0];
  e.target.value = '';
  if (!datei) return;
  let zeilen;
  try {
    const buf = await datei.arrayBuffer();
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch { text = new TextDecoder('windows-1252').decode(buf); }   // ZMS liefert Latin-1
    const rows = klCsv(text.replace(/^﻿/, ''));
    const h = rows[0] || [];
    const col = (n) => h.findIndex((x) => x.trim() === n);
    const C = { art: col('Art'), typ: col('Typ'), ident: col('Identifikation'), barcode: col('Barcode'),
                groesse: col('Größe'), person: col('Ausgegeben an'), standort: col('Standort') };
    if (C.typ < 0 || C.barcode < 0 || C.ident < 0) throw new Error('Spalten „Typ“, „Identifikation“ oder „Barcode“ fehlen. Ist das der Export „persönliche Ausrüstung“?');
    zeilen = rows.slice(1).filter((r) => /^BRE\d+$/i.test((r[C.barcode] || '').trim())).map((r) => ({
      identifikation: r[C.ident], barcode: r[C.barcode], art: C.art >= 0 ? r[C.art] : '', typ: r[C.typ],
      groesse: C.groesse >= 0 ? r[C.groesse] : '', person: C.person >= 0 ? r[C.person] : '',
      standort: C.standort >= 0 ? r[C.standort] : '',
    }));
    if (!zeilen.length) throw new Error('Keine Zeile mit Inventarnummer BRE… gefunden.');
  } catch (err) { hinweis('Datei nicht lesbar\n\n' + err.message); return; }
  await klImportVorschau(zeilen, {}, {});
}

async function klImportVorschau(zeilen, typen, namen) {
  let v;
  try { v = await klSende('/api/kleidung/import', 'POST', { zeilen, typen, namen, uebernehmen: false }); }
  catch (err) { hinweis('Import nicht möglich\n\n' + err.message); return; }
  const offen = v.offene_typen.length + v.offene_namen.length;
  const dlg = klDialog(`
    <form method="dialog" class="agt-form">
      <h3>ZMS-Import</h3>
      <p class="agt-unter">${v.zeilen} Teile mit Inventarnummer BRE…</p>
      <ul class="agt-vorschau">
        <li><strong>${v.neu}</strong> neu</li>
        <li><strong>${v.geaendert}</strong> geändert (Zuordnung, Größe, Standort)</li>
        <li><strong>${v.gleich}</strong> unverändert</li>
        ${v.aus_app ? `<li><strong>${v.aus_app}</strong> bisher nur in der App, jetzt aus ZMS</li>` : ''}
        ${v.nicht_gefuehrt ? `<li><strong>${v.nicht_gefuehrt}</strong> keine Schutzkleidung, nicht geführt</li>` : ''}
        ${v.fehlt ? `<li><strong>${v.fehlt}</strong> nicht mehr im Export, verschwinden aus den Listen (Reinigungen bleiben gespeichert)</li>` : ''}
      </ul>
      ${v.offene_typen.length ? `
        <div class="sp-treffer">
          <div class="t-kopf">Neue Bezeichnungen aus ZMS</div>
          ${v.offene_typen.map((o, i) => `
            <div class="field"><label for="kl-ty-${i}">${escapeHtml(o.typ)} <span class="muted">· ${escapeHtml(o.zms_art)} · ${o.anzahl}×</span></label>
              <select id="kl-ty-${i}" data-typ="${escapeHtml(o.typ)}">
                <option value="">— bitte wählen —</option>
                <option value="0" ${/^dienstkleidung$/i.test(o.zms_art) ? 'selected' : ''}>nicht führen</option>
                ${v.artikelarten.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')}
              </select></div>`).join('')}
        </div>` : ''}
      ${v.offene_namen.length ? `
        <div class="sp-treffer">
          <div class="t-kopf">Namen ohne eindeutige Person</div>
          ${v.offene_namen.map((o, i) => `
            <div class="field"><label for="kl-na-${i}">${escapeHtml(o.name)} <span class="muted">· ${o.anzahl} Teile</span></label>
              <select id="kl-na-${i}" data-name="${escapeHtml(o.name)}">
                <option value="">— bitte wählen —</option>
                <option value="0">keiner Person zuordnen</option>
                ${v.personen.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}
              </select></div>`).join('')}
        </div>` : ''}
      ${offen ? '<p class="hint">Die Wahl wird gemerkt und beim nächsten Import wieder verwendet.</p>' : ''}
      <div class="dialog-actions">
        <button type="button" class="btn-secondary" data-schliessen>Abbrechen</button>
        <button type="button" class="btn-primary" id="kl-i-ok">${offen ? 'Weiter' : 'Übernehmen'}</button>
      </div>
    </form>`);
  dlg.querySelector('#kl-i-ok').addEventListener('click', async () => {
    const ty = { ...typen }, na = { ...namen };
    for (const sel of dlg.querySelectorAll('select[data-typ]')) {
      if (sel.value === '') { toast('Bitte jede Bezeichnung zuordnen', 'error'); return; }
      ty[sel.dataset.typ] = Number(sel.value);
    }
    for (const sel of dlg.querySelectorAll('select[data-name]')) {
      if (sel.value === '') { toast('Bitte jeden Namen zuordnen', 'error'); return; }
      na[sel.dataset.name] = Number(sel.value);
    }
    if (offen) { await klImportVorschau(zeilen, ty, na); return; }
    try {
      const d = await klSende('/api/kleidung/import', 'POST', { zeilen, typen: ty, namen: na, uebernehmen: true });
      dlg.close();
      toast(`ZMS-Stand übernommen: ${d.uebernommen} Teile`, 'success');
      await window.ladeKleidung();
    } catch (err) { toast('Fehler: ' + err.message, 'error'); }
  });
}
