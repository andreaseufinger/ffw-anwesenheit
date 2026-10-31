// Modul Atemschutz (Konzept PSA und Atemschutz, Etappe 1).
//
// Wird von app.js erst beim ersten Öffnen nachgeladen und nutzt dessen
// Helfer ($, STATE, escapeHtml, formatDate, toast, bestaetigen, hinweis,
// seitenkopf, leerZustand). Status und Regeln rechnet der Server
// (functions/_lib/agt.js); hier wird nur angezeigt und erfasst.

const AGT_STATUS_TEXT = {
  dunkelgruen: 'eingetragen',
  hellgruen: 'Eintrag fehlt',
  gelb: 'läuft ab',
  rot: 'abgelaufen',
};
const AGT_QUELLE = {
  florix: 'Florix-Import',
  manuell: 'von Hand',
  anwesenheit: 'aus der Anwesenheit',
  einsatz: 'aus dem Einsatzprotokoll',
};
// Arten, die sich von Hand eintragen lassen, je Spalte. Atemschutzeinsätze
// kommen aus dem Einsatzprotokoll.
const AGT_EINTRAGBAR = {
  lehrgang: ['lehrgang'], strecke: ['strecke'], g263: ['g263'],
  unterweisung: ['unterweisung'], wahlpflicht: ['einsatzuebung'],
};

let AGT = null;            // letzte Antwort von /api/agt
let agtNurBedarf = false;  // Filter "Nur Handlungsbedarf"
let agtNurJahr = false;    // Filter "Fällig <laufendes Jahr>"
let agtSortierung = 'name'; // 'name' oder Schlüssel einer Spalte (ohne Lehrgang)

// Aufsteigend nach Ablaufdatum der gewählten Tauglichkeit: fehlender
// Nachweis zuerst (am dringendsten), unbefristet zuletzt, sonst nach Name.
function agtSortieren(liste, key) {
  if (key === 'name') return [...liste].sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const wert = (p) => {
    const n = p.spalten[key]?.nachweis;
    return !n ? '0000-00-00' : n.gueltig_bis || '9999-12-31';
  };
  return [...liste].sort((a, b) => wert(a).localeCompare(wert(b)) || a.name.localeCompare(b.name, 'de'));
}

// Fällig im Jahr: ein Nachweis fehlt, ist abgelaufen oder läuft bis zum
// 31.12. ab. Das Jahr kommt vom Serverdatum und wechselt so am 1. Januar.
function agtFaelligBis(p, jahr) {
  const ende = `${jahr}-12-31`;
  return Object.values(p.spalten).some((z) => !z.nachweis || (z.nachweis.gueltig_bis && z.nachweis.gueltig_bis <= ende));
}

window.ladeAtemschutz = async function ladeAtemschutz() {
  const box = $('#agt-inhalt');
  if (!AGT) box.innerHTML = '<p class="empty">lädt …</p>';
  try {
    const res = await fetch('/api/agt');
    if (res.status === 401) { showLogin(); return; }
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
    AGT = d;
  } catch (err) {
    leerZustand(box, { icon: 'fehler', titel: 'Atemschutz nicht abrufbar', text: err.message,
      knopf: 'Erneut laden', aktion: window.ladeAtemschutz });
    return;
  }
  agtRender();
};

function agtDatum(n, spalte) {
  if (!n) return 'fehlt';
  if (spalte === 'lehrgang') return n.datum ? `seit ${formatDate(n.datum)}` : 'vorhanden';
  return n.gueltig_bis ? `bis ${formatDate(n.gueltig_bis)}` : 'unbefristet';
}

function agtRender() {
  const d = AGT;
  const box = $('#agt-inhalt');
  const tauglich = d.personen.filter((p) => p.tauglich).length;
  seitenkopf('view-atemschutz', 'Atemschutz', `${tauglich} von ${d.personen.length} tauglich`);
  const stand = d.florix_stand
    ? `Florix-Stand ${d.florix_stand.stichtag ? formatDate(d.florix_stand.stichtag) : '–'}`
      + ` · importiert ${formatDate(d.florix_stand.importiert_at.slice(0, 10))}`
    : 'Noch kein Florix-Import';
  const jahr = (d.heute || new Date().toISOString()).slice(0, 4);
  const zeilen = agtSortieren(d.personen.filter((p) => (!agtNurBedarf || p.gesamt !== 'dunkelgruen')
    && (!agtNurJahr || agtFaelligBis(p, jahr))), agtSortierung);
  const sortWahl = [['name', 'Name'], ...d.spalten.filter((sp) => sp.key !== 'lehrgang').map((sp) => [sp.key, sp.name])];

  box.innerHTML = `
    <div class="agt-leiste">
      <span class="agt-stand">${escapeHtml(stand)}</span>
      <div class="agt-knoepfe">
        <button type="button" class="chip" id="agt-import-btn">Florix-Import</button>
        <button type="button" class="chip" id="agt-sammel-btn">Sammeleintrag</button>
        <button type="button" class="chip" id="agt-planung-btn">Planung Strecke</button>
        <button type="button" class="chip" id="agt-neu-btn">+ AGT</button>
      </div>
      <input type="file" id="agt-datei" accept=".csv,text/csv" hidden />
    </div>
    <div class="agt-legende">
      ${['dunkelgruen', 'hellgruen', 'gelb', 'rot'].map((s) =>
        `<span class="agt-st st-${s}">${AGT_STATUS_TEXT[s]}</span>`).join('')}
      <div class="agt-filter">
        <label class="check-row"><input type="checkbox" id="agt-bedarf" ${agtNurBedarf ? 'checked' : ''} /> <span>Nur Handlungsbedarf</span></label>
        <label class="check-row"><input type="checkbox" id="agt-jahr" ${agtNurJahr ? 'checked' : ''} /> <span>Fällig ${jahr}</span></label>
        <div class="field agt-sortierung">
          <label for="agt-sort">Sortierung</label>
          <select id="agt-sort">${sortWahl.map(([k, t]) => `<option value="${k}" ${k === agtSortierung ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}</select>
        </div>
      </div>
    </div>
    <div class="agt-tabelle" role="table" aria-label="Atemschutztauglichkeit">
      <div class="agt-kopf" role="row">
        <span role="columnheader">AGT</span>
        ${d.spalten.map((sp) => `<span role="columnheader">${escapeHtml(sp.name)}</span>`).join('')}
        <span role="columnheader">Kleidung</span>
        <span role="columnheader" title="Nächster Streckendurchgang geplant">Strecke geplant</span>
        <span role="columnheader">Gesamt</span>
      </div>
      ${zeilen.map((p) => `
        <div class="agt-zeile" role="row">
          <button type="button" class="agt-name" data-pid="${p.id}" role="rowheader">${escapeHtml(p.name)}${p.aktiv ? '' : ' <span class="muted">(ausgetreten)</span>'}</button>
          ${d.spalten.map((sp) => {
            const z = p.spalten[sp.key];
            return `<button type="button" class="agt-zelle st-${z.status}" role="cell"
                      data-pid="${p.id}" data-spalte="${sp.key}"
                      aria-label="${escapeHtml(sp.name)}: ${AGT_STATUS_TEXT[z.status]}, ${agtDatum(z.nachweis, sp.key)}">
                      <span class="z-titel">${escapeHtml(sp.name)}</span>
                      <span class="z-wert">${agtDatum(z.nachweis, sp.key)}</span>
                    </button>`;
          }).join('')}
          ${agtKleidungZelle(p)}
          ${agtPlanZelle(p)}
          <span class="agt-gesamt agt-st st-${p.gesamt}" role="cell">${p.tauglich ? 'tauglich' : 'nicht tauglich'}</span>
        </div>`).join('')}
    </div>
    <div id="agt-leer"></div>`;

  if (!d.personen.length) {
    leerZustand('#agt-leer', { icon: 'personen', titel: 'Noch keine Geräteträger',
      text: 'Den Florix-Export „Tauglichkeiten Atemschutz“ importieren oder Personen mit „+ AGT“ kennzeichnen.',
      knopf: 'Florix-Import', aktion: () => $('#agt-datei').click() });
  } else if (!zeilen.length) {
    leerZustand('#agt-leer', agtNurJahr && !agtNurBedarf
      ? { icon: 'liste', titel: `Nichts fällig ${jahr}`, text: `Alle Nachweise gelten über den 31.12.${jahr} hinaus.` }
      : { icon: 'liste', titel: 'Kein Handlungsbedarf',
          text: 'Alle Nachweise sind gültig und in Atemschutzpass und Florix eingetragen.' });
  }

  $('#agt-bedarf').addEventListener('change', (e) => { agtNurBedarf = e.target.checked; agtRender(); });
  $('#agt-jahr').addEventListener('change', (e) => { agtNurJahr = e.target.checked; agtRender(); });
  $('#agt-sort').addEventListener('change', (e) => { agtSortierung = e.target.value; agtRender(); });
  $('#agt-import-btn').addEventListener('click', () => $('#agt-datei').click());
  $('#agt-datei').addEventListener('change', agtImportDatei);
  $('#agt-sammel-btn').addEventListener('click', () => agtSammelDialog());
  $('#agt-planung-btn').addEventListener('click', agtPlanungDialog);
  $('#agt-neu-btn').addEventListener('click', agtNeuDialog);
  box.querySelectorAll('.agt-zelle[data-spalte]').forEach((b) =>
    b.addEventListener('click', () => agtNachweisDialog(Number(b.dataset.pid), b.dataset.spalte)));
  box.querySelectorAll('.agt-zelle-kleidung').forEach((b) =>
    b.addEventListener('click', () => agtKleidungDialog(Number(b.dataset.pid))));
  box.querySelectorAll('.agt-zelle-plan').forEach((b) =>
    b.addEventListener('click', () => agtPlanDialog(Number(b.dataset.pid))));
  box.querySelectorAll('.agt-name').forEach((b) =>
    b.addEventListener('click', () => agtPersonDialog(Number(b.dataset.pid))));
}

// Kleidungsspalte: schlechtestes der AGT-relevanten Teile (HuPF 1, HuPF 4,
// Handschuhe, Haube). Ohne erfasste Reinigung neutral, zählt dann nicht.
const AGT_KLEIDUNG_TEXT = { dunkelgruen: 'gültig', gelb: 'bald fällig', rot: 'überfällig', unbekannt: '' };
function agtKleidungText(k) {
  if (!k || !k.teile) return 'keine Teile';
  if (k.status === 'unbekannt') return `${k.ohne_datum} ohne Datum`;
  const teile = [];
  if (k.in_reinigung) teile.push(`${k.in_reinigung} in Reinigung`);
  if (k.ohne_datum) teile.push(`${k.ohne_datum} ohne Datum`);
  return teile.length ? `${AGT_KLEIDUNG_TEXT[k.status]} · ${teile.join(', ')}` : AGT_KLEIDUNG_TEXT[k.status];
}
function agtKleidungZelle(p) {
  const k = p.kleidung || { status: 'unbekannt', teile: 0 };
  return `<button type="button" class="agt-zelle agt-zelle-kleidung st-${k.status}" role="cell" data-pid="${p.id}"
            aria-label="Kleidung: ${escapeHtml(agtKleidungText(k))}">
            <span class="z-titel">Kleidung</span>
            <span class="z-wert">${escapeHtml(agtKleidungText(k))}</span>
          </button>`;
}
function agtKleidungDialog(pid) {
  const p = AGT.personen.find((x) => x.id === pid);
  const k = p?.kleidung;
  if (!p) return;
  agtDialog(`
    <form method="dialog" class="agt-form">
      <h3>Kleidung</h3>
      <p class="agt-unter">${escapeHtml(p.name)} · zählt: HuPF Teil 1 und 4, Handschuhe, Flammschutzhaube</p>
      ${k && k.liste && k.liste.length ? `<ul class="agt-verlauf-liste">${k.liste.map((t) => `
        <li><span><strong>${escapeHtml(t.artikelart)}</strong> · ${escapeHtml(t.barcode)}</span>
            <span class="muted">${t.in_reinigung_seit ? 'in Reinigung seit ' + formatDate(t.in_reinigung_seit)
              : t.letzte_reinigung ? 'gereinigt ' + formatDate(t.letzte_reinigung) : 'keine Reinigung erfasst'}</span></li>`).join('')}</ul>`
        : '<p>Für diese Person sind keine Teile erfasst, die für den Kleidungsstatus zählen.</p>'}
      <p class="hint">Gepflegt im Bereich Kleidung. Teile ohne erfasste Reinigung zählen noch nicht in die Ampel.</p>
      <div class="dialog-actions"><button type="button" class="btn-primary" data-schliessen>Fertig</button></div>
    </form>`);
}

// --- Dialog-Gerüst -------------------------------------------------------

function agtDialog(html) {
  const dlg = $('#agt-dialog');
  dlg.innerHTML = html;
  dlg.querySelectorAll('[data-schliessen]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  if (!dlg.open) dlg.showModal();
  return dlg;
}

async function agtSende(url, method, body) {
  const res = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
  return d;
}

// --- Untermenü je Nachweis ----------------------------------------------

async function agtNachweisDialog(pid, spalte) {
  const p = AGT.personen.find((x) => x.id === pid);
  const sp = AGT.spalten.find((x) => x.key === spalte);
  if (!p || !sp) return;
  let alle = [];
  try { alle = (await agtSende(`/api/agt/personen/${pid}`, 'GET')).nachweise; }
  catch (err) { hinweis('Nachweise nicht abrufbar\n\n' + err.message); return; }
  const eigene = alle.filter((n) => sp.arten.includes(n.art));
  const z = p.spalten[spalte];
  const m = z.nachweis;
  const artName = (a) => AGT.arten.find((x) => x.art === a)?.name || a;
  const eintragbar = AGT_EINTRAGBAR[spalte] || [];
  const istG26 = spalte === 'g263';
  const istLehrgang = spalte === 'lehrgang';
  // Welche Häkchen diese Art braucht (Einstellungen -> Tauglichkeiten)
  const regel = m ? AGT.arten.find((a) => a.art === m.art) : null;
  const passNoetig = regel?.pass_pflicht !== 0;
  const florixNoetig = regel?.florix_pflicht !== 0;
  const haken = [passNoetig && 'Atemschutzpass', florixNoetig && 'Florix'].filter(Boolean);

  const dlg = agtDialog(`
    <form method="dialog" class="agt-form">
      <h3>${escapeHtml(sp.name)}</h3>
      <p class="agt-unter">${escapeHtml(p.name)}</p>
      <div class="agt-status-zeile">
        <span class="agt-st st-${z.status}">${AGT_STATUS_TEXT[z.status]}</span>
        <span>${agtDatum(m, spalte)}${m ? ' · ' + escapeHtml(AGT_QUELLE[m.quelle] || m.quelle) : ''}</span>
      </div>
      ${m && haken.length ? `
        <fieldset class="agt-haken">
          <legend>Status setzen</legend>
          ${passNoetig ? `<label class="check-row"><input type="checkbox" id="agt-pass" ${m.pass ? 'checked' : ''} /> <span>Im Atemschutzpass eingetragen</span></label>` : ''}
          ${florixNoetig ? `<label class="check-row"><input type="checkbox" id="agt-florix" ${m.florix ? 'checked' : ''} /> <span>In Florix eingetragen</span></label>` : ''}
          <p class="hint">Dunkelgrün erst mit ${haken.length > 1 ? 'beiden Häkchen' : 'dem Häkchen'}. 30 Tage vor Ablauf gelb, danach rot.</p>
        </fieldset>` : ''}
      ${eintragbar.length ? `
        <fieldset class="agt-eintragen">
          <legend>Nachweis eintragen</legend>
          ${eintragbar.length > 1 ? '' : `<input type="hidden" id="agt-art" value="${eintragbar[0]}" />`}
          <div class="row-2">
            <div class="field">
              <label for="agt-datum">${istLehrgang ? 'Abschluss am' : istG26 ? 'Untersuchung am (optional)' : 'Durchgeführt am'}</label>
              <input type="date" id="agt-datum" />
            </div>
            ${istG26 ? `<div class="field"><label for="agt-bis">Nächste Untersuchung</label><input type="date" id="agt-bis" /></div>` : ''}
          </div>
          <button type="button" class="btn-secondary" id="agt-eintragen">Eintragen</button>
        </fieldset>` : ''}
      ${eigene.length ? `
        <div class="agt-verlauf">
          <div class="marke-klein">Alle Nachweise</div>
          <ul>${eigene.map((n) => `
            <li class="${n.verworfen ? 'agt-verworfen' : ''}">
              <span>${escapeHtml(artName(n.art))}: ${n.art === 'lehrgang' ? formatDate(n.datum || '') : 'bis ' + formatDate(n.gueltig_bis || '')}${n.datum && n.art !== 'lehrgang' ? ` <span class="muted">(am ${formatDate(n.datum)})</span>` : ''}</span>
              <span class="muted">${escapeHtml(AGT_QUELLE[n.quelle] || n.quelle)}${n.pass ? ' · Pass' : ''}${n.florix ? ' · Florix' : ''}${n.verworfen ? ' · zurückgenommen' : ''}</span>
              ${n.quelle === 'manuell' ? `<button type="button" class="icon-btn icon-danger" data-loeschen="${n.id}" aria-label="Nachweis löschen" title="Nachweis löschen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>`
                : ['anwesenheit', 'einsatz'].includes(n.quelle)
                  ? (n.verworfen
                      ? `<button type="button" class="chip" data-wieder="${n.id}">Wiederherstellen</button>`
                      : `<button type="button" class="chip" data-zuruecknehmen="${n.id}">Zurücknehmen</button>`)
                  : ''}
            </li>`).join('')}</ul>
        </div>` : ''}
      <div class="dialog-actions"><button type="button" class="btn-primary" data-schliessen>Fertig</button></div>
    </form>`);

  const neuLaden = async () => { await window.ladeAtemschutz(); agtNachweisDialog(pid, spalte); };
  for (const [feld, key] of [['#agt-pass', 'pass'], ['#agt-florix', 'florix']]) {
    const el = dlg.querySelector(feld);
    if (el) el.addEventListener('change', async () => {
      try { await agtSende(`/api/agt/nachweise/${m.id}`, 'PUT', { [key]: el.checked }); await neuLaden(); }
      catch (err) { el.checked = !el.checked; toast('Fehler: ' + err.message, 'error'); }
    });
  }
  const btn = dlg.querySelector('#agt-eintragen');
  if (btn) btn.addEventListener('click', async () => {
    const datum = dlg.querySelector('#agt-datum').value || null;
    const bis = dlg.querySelector('#agt-bis')?.value || null;
    try {
      await agtSende('/api/agt/nachweise', 'POST',
        { person_ids: [pid], art: dlg.querySelector('#agt-art').value, datum, gueltig_bis: bis });
      toast('Nachweis eingetragen', 'success');
      await neuLaden();
    } catch (err) { toast('Fehler: ' + err.message, 'error'); }
  });
  dlg.querySelectorAll('[data-zuruecknehmen]').forEach((b) => b.addEventListener('click', async () => {
    try { await agtSende(`/api/agt/nachweise/${b.dataset.zuruecknehmen}`, 'DELETE'); await neuLaden(); }
    catch (err) { toast('Fehler: ' + err.message, 'error'); }
  }));
  dlg.querySelectorAll('[data-wieder]').forEach((b) => b.addEventListener('click', async () => {
    try { await agtSende(`/api/agt/nachweise/${b.dataset.wieder}`, 'PUT', { verworfen: false }); await neuLaden(); }
    catch (err) { toast('Fehler: ' + err.message, 'error'); }
  }));
  dlg.querySelectorAll('[data-loeschen]').forEach((b) => b.addEventListener('click', async () => {
    if (!await bestaetigen('Nachweis löschen?\n\nDer von Hand eingetragene Nachweis wird entfernt.')) return;
    try { await agtSende(`/api/agt/nachweise/${b.dataset.loeschen}`, 'DELETE'); await neuLaden(); }
    catch (err) { toast('Fehler: ' + err.message, 'error'); }
  }));
}

// --- Planung Atemschutzstrecke ------------------------------------------
// Je AGT ein geplanter nächster Durchgang (Termin der Übungsanlage oder freies
// Datum). Die Planung leert der Server, sobald ein Streckennachweis am oder
// nach dem Datum vorliegt.

const AGT_WT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const AGT_WT_LANG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

function agtTerminText(datum, uhrzeit, lang = false) {
  const d = new Date(datum + 'T00:00:00Z');
  const wt = (lang ? AGT_WT_LANG : AGT_WT)[d.getUTCDay()];
  return `${wt}${lang ? ',' : ''} ${formatDate(datum)}${uhrzeit ? (lang ? `, ${uhrzeit} Uhr` : ` · ${uhrzeit}`) : ''}`;
}
function agtKommune() { return (typeof MODUL !== 'undefined' && MODUL.kommune) || ''; }
function agtArtText(art) {
  return art === 'eigen' ? (agtKommune() ? `Termine ${agtKommune()}` : 'Eigene Termine')
    : art === 'ausweich' ? 'Ausweichtermin' : 'Weitere Termine';
}

// Strecke läuft bis Jahresende ab (oder fehlt bzw. ist abgelaufen)
function agtStreckeFaelligBis(p, jahr) {
  const n = p.spalten.strecke?.nachweis;
  return !n || (!!n.gueltig_bis && n.gueltig_bis <= `${jahr}-12-31`);
}

// Hinweise zu einem geplanten Datum; blockieren nichts
function agtPlanHinweise(p, datum) {
  if (!datum) return [];
  const h = [];
  const st = p.spalten.strecke?.nachweis;
  const g = p.spalten.g263?.nachweis;
  if (st?.gueltig_bis && st.gueltig_bis < datum) h.push({ stufe: 'rot', text: `Strecke läuft vorher ab (bis ${formatDate(st.gueltig_bis)})` });
  if (!g) h.push({ stufe: 'rot', text: 'G 26.3 fehlt' });
  else if (g.gueltig_bis && g.gueltig_bis < datum) h.push({ stufe: 'rot', text: `G 26.3 bis dahin abgelaufen (bis ${formatDate(g.gueltig_bis)})` });
  if (datum < AGT.heute) h.push({ stufe: 'gelb', text: 'Termin vorbei, Nachweis fehlt' });
  return h;
}
function agtHinweisHtml(h) {
  return h.map((x) => `<span class="agt-st st-${x.stufe}">${escapeHtml(x.text)}</span>`).join('');
}

function agtPlanZelle(p) {
  const pl = p.planung;
  let klasse, wert;
  if (pl) {
    const h = agtPlanHinweise(p, pl.datum);
    klasse = h.some((x) => x.stufe === 'rot') ? 'st-rot' : h.length ? 'st-gelb' : 'st-plan';
    wert = agtTerminText(pl.datum);
  } else {
    klasse = agtStreckeFaelligBis(p, AGT.heute.slice(0, 4)) ? 'st-gelb' : 'st-unbekannt';
    wert = 'nicht geplant';
  }
  return `<button type="button" class="agt-zelle agt-zelle-plan ${klasse}" role="cell" data-pid="${p.id}"
            aria-label="Nächster Streckendurchgang: ${escapeHtml(wert)}">
            <span class="z-titel">Strecke geplant</span>
            <span class="z-wert">${escapeHtml(wert)}</span>
          </button>`;
}

// Auswahl je AGT. zurueck: Funktion, die nach Speichern oder "Zurück" die
// aufrufende Ansicht (Planung) wieder öffnet.
function agtPlanDialog(pid, zurueck = null) {
  const p = AGT.personen.find((x) => x.id === pid);
  if (!p) return;
  const pl = p.planung;
  const heute = AGT.heute;
  const termine = (AGT.termine || []).filter((t) => t.datum >= heute || t.id === pl?.termin_id);
  const opt = (t) => `<option value="t${t.id}" ${pl?.termin_id === t.id ? 'selected' : ''}>${escapeHtml(agtTerminText(t.datum, t.uhrzeit))}${t.art === 'weitere' && t.kunden ? ' – ' + escapeHtml(t.kunden) : ''}${t.datum < heute ? ' (vorbei)' : ''}</option>`;
  const gruppe = (art) => {
    const l = termine.filter((t) => t.art === art);
    return l.length ? `<optgroup label="${escapeHtml(agtArtText(art))}">${l.map(opt).join('')}</optgroup>` : '';
  };
  const frei = !!pl && !pl.termin_id;
  const st = p.spalten.strecke?.nachweis;
  const dlg = agtDialog(`
    <form method="dialog" class="agt-form">
      <h3>Nächster Streckendurchgang</h3>
      <p class="agt-unter">${escapeHtml(p.name)} · Strecke ${st ? (st.gueltig_bis ? 'bis ' + formatDate(st.gueltig_bis) : 'unbefristet') : 'fehlt'}</p>
      <div class="field"><label for="agt-p-termin">Geplant</label>
        <select id="agt-p-termin">
          <option value="">— nicht geplant —</option>
          ${gruppe('eigen')}${gruppe('ausweich')}${gruppe('weitere')}
          <optgroup label="Anderes Datum"><option value="frei" ${frei ? 'selected' : ''}>Datum frei eingeben …</option></optgroup>
        </select></div>
      <div class="field ${frei ? '' : 'hidden'}" id="agt-p-frei"><label for="agt-p-datum">Datum</label>
        <input type="date" id="agt-p-datum" value="${frei ? escapeHtml(pl.datum) : ''}" /></div>
      <div class="agt-status-zeile" id="agt-p-hinweise"></div>
      <div class="dialog-actions">
        <button type="button" class="btn-secondary" id="agt-p-abbrechen">${zurueck ? 'Zurück' : 'Abbrechen'}</button>
        <button type="button" class="btn-primary" id="agt-p-speichern">Speichern</button>
      </div>
    </form>`);
  const sel = dlg.querySelector('#agt-p-termin');
  const datumEl = dlg.querySelector('#agt-p-datum');
  const gewaehlt = () => {
    if (sel.value === 'frei') return { datum: datumEl.value || null, termin_id: null };
    if (sel.value.startsWith('t')) {
      const t = (AGT.termine || []).find((x) => `t${x.id}` === sel.value);
      return { datum: t?.datum || null, termin_id: t?.id || null };
    }
    return { datum: null, termin_id: null };
  };
  const zeigen = () => {
    dlg.querySelector('#agt-p-frei').classList.toggle('hidden', sel.value !== 'frei');
    dlg.querySelector('#agt-p-hinweise').innerHTML = agtHinweisHtml(agtPlanHinweise(p, gewaehlt().datum));
  };
  sel.addEventListener('change', zeigen);
  datumEl.addEventListener('change', zeigen);
  zeigen();
  dlg.querySelector('#agt-p-abbrechen').addEventListener('click', () => (zurueck ? zurueck() : dlg.close()));
  dlg.querySelector('#agt-p-speichern').addEventListener('click', async () => {
    const g = gewaehlt();
    if (sel.value === 'frei' && !g.datum) { toast('Datum fehlt', 'error'); return; }
    try {
      await agtSende('/api/agt/planung', 'PUT', { person_ids: [pid], ...g });
      toast(g.datum ? `Geplant: ${agtTerminText(g.datum)}` : 'Planung entfernt', 'success');
      await window.ladeAtemschutz();
      if (zurueck) zurueck(); else dlg.close();
    } catch (err) { toast('Fehler: ' + err.message, 'error'); }
  });
}

// Gruppen der Planungsansicht: Termine mit geplanten AGT, eigene künftige
// Termine auch ohne; frei eingegebene Daten je Datum.
function agtPlanGruppen() {
  const heute = AGT.heute;
  const termine = AGT.termine || [];
  const gruppen = new Map();
  for (const t of termine) {
    if (t.art === 'eigen' && t.datum >= heute) gruppen.set(`t${t.id}`, { schluessel: `t${t.id}`, termin: t, datum: t.datum, uhrzeit: t.uhrzeit, personen: [] });
  }
  for (const p of AGT.personen) {
    if (!p.planung) continue;
    const t = p.planung.termin_id ? termine.find((x) => x.id === p.planung.termin_id) : null;
    const k = t ? `t${t.id}` : `f${p.planung.datum}`;
    if (!gruppen.has(k)) gruppen.set(k, { schluessel: k, termin: t, datum: p.planung.datum, uhrzeit: t?.uhrzeit || null, personen: [] });
    gruppen.get(k).personen.push(p);
  }
  return [...gruppen.values()].sort((a, b) => `${a.datum} ${a.uhrzeit || ''}`.localeCompare(`${b.datum} ${b.uhrzeit || ''}`));
}

function agtPlanungDialog() {
  const heute = AGT.heute;
  const jahr = heute.slice(0, 4);
  const gruppen = agtPlanGruppen();
  const ohne = AGT.personen.filter((p) => p.aktiv && !p.planung && agtStreckeFaelligBis(p, jahr))
    .sort((a, b) => (a.spalten.strecke?.nachweis?.gueltig_bis || '').localeCompare(b.spalten.strecke?.nachweis?.gueltig_bis || ''));
  const kommend = gruppen.filter((g) => g.datum >= heute && g.personen.length);
  const geplant = AGT.personen.filter((p) => p.planung).length;
  const tag = (g) => g.termin ? (g.termin.art === 'weitere' ? g.termin.kunden || 'Weitere' : agtArtText(g.termin.art).replace(/^Termine /, '')) : 'freies Datum';
  const dlg = agtDialog(`
    <form method="dialog" class="agt-form">
      <h3>Planung Strecke</h3>
      <p class="agt-unter">${geplant} geplant · ${ohne.length} ohne Termin (Strecke läuft ${jahr} ab)</p>
      <button type="button" class="btn-primary" id="agt-pl-pdf" ${kommend.length ? '' : 'disabled'}>Teilnehmerliste (PDF)</button>
      <div class="agt-pl-liste">
        ${gruppen.map((g) => `
          <div class="agt-pl-termin ${g.datum < heute ? 'vorbei' : ''}">
            <div class="agt-pl-kopf">
              <strong>${escapeHtml(agtTerminText(g.datum, g.uhrzeit))}</strong>
              <span class="tag">${escapeHtml(tag(g))}</span>
              <span class="muted">${g.personen.length} AGT</span>
            </div>
            ${g.personen.length ? `<div class="agt-pl-namen">${g.personen.map((p) => {
              const rot = agtPlanHinweise(p, g.datum).some((x) => x.stufe === 'rot');
              return `<button type="button" class="chip agt-pl-name ${rot ? 'warn' : ''}" data-pid="${p.id}">${rot ? '! ' : ''}${escapeHtml(p.name)}</button>`;
            }).join('')}</div>` : ''}
            <div class="agt-pl-aktionen">
              ${g.termin && g.datum >= heute ? `<button type="button" class="chip" data-plus="${g.schluessel}">+ AGT</button>` : ''}
              ${g.personen.length && g.datum >= heute ? `<button type="button" class="chip" data-pdf="${g.schluessel}">PDF</button>` : ''}
              ${g.personen.length && g.datum <= heute ? `<button type="button" class="chip" data-eintragen="${g.schluessel}">Nachweise eintragen</button>` : ''}
            </div>
          </div>`).join('') || '<p class="muted">Noch keine Termine. Termine pflegen unter Einstellungen → Tauglichkeiten verwalten.</p>'}
        <div class="agt-pl-termin agt-pl-ohne">
          <div class="agt-pl-kopf"><strong>Ohne Termin</strong><span class="tag">Strecke läuft ${jahr} ab</span><span class="muted">${ohne.length} AGT</span></div>
          ${ohne.length ? `<div class="agt-pl-namen">${ohne.map((p) => {
            const n = p.spalten.strecke?.nachweis;
            return `<button type="button" class="chip agt-pl-name" data-pid="${p.id}">${escapeHtml(p.name)} · ${n?.gueltig_bis ? 'bis ' + formatDate(n.gueltig_bis) : 'fehlt'}</button>`;
          }).join('')}</div>` : '<p class="muted">Alle mit fälliger Strecke haben einen Termin.</p>'}
        </div>
      </div>
      <div class="dialog-actions"><button type="button" class="btn-secondary" data-schliessen>Schließen</button></div>
    </form>`);
  const finde = (k) => gruppen.find((g) => g.schluessel === k);
  dlg.querySelectorAll('.agt-pl-name').forEach((b) => b.addEventListener('click', () => agtPlanDialog(Number(b.dataset.pid), agtPlanungDialog)));
  dlg.querySelector('#agt-pl-pdf').addEventListener('click', () => agtTeilnehmerPdf(kommend));
  dlg.querySelectorAll('[data-pdf]').forEach((b) => b.addEventListener('click', () => agtTeilnehmerPdf([finde(b.dataset.pdf)])));
  dlg.querySelectorAll('[data-eintragen]').forEach((b) => b.addEventListener('click', () => {
    const g = finde(b.dataset.eintragen);
    agtSammelDialog({ art: 'strecke', datum: g.datum, ids: g.personen.map((p) => p.id) });
  }));
  dlg.querySelectorAll('[data-plus]').forEach((b) => b.addEventListener('click', () => agtPlanMehrere(finde(b.dataset.plus))));
}

// Mehrere AGT auf einmal für einen Termin planen
function agtPlanMehrere(g) {
  const dabei = new Set(g.personen.map((p) => p.id));
  const kandidaten = AGT.personen.filter((p) => p.aktiv && !dabei.has(p.id));
  const jahr = AGT.heute.slice(0, 4);
  const dlg = agtDialog(`
    <form method="dialog" class="agt-form">
      <h3>${escapeHtml(agtTerminText(g.datum, g.uhrzeit))}</h3>
      <p class="agt-unter">Geräteträger für diesen Termin einplanen. Eine andere Planung wird ersetzt.</p>
      <div class="checkbox-liste agt-s-liste">${kandidaten.map((p) => {
        const n = p.spalten.strecke?.nachweis;
        const info = [n?.gueltig_bis ? `Strecke bis ${formatDate(n.gueltig_bis)}` : 'Strecke fehlt', p.planung ? `geplant ${agtTerminText(p.planung.datum)}` : ''].filter(Boolean).join(' · ');
        return `<label><input type="checkbox" value="${p.id}" ${!p.planung && agtStreckeFaelligBis(p, jahr) ? 'checked' : ''} /> <span>${escapeHtml(p.name)} <span class="muted">${escapeHtml(info)}</span></span></label>`;
      }).join('')}</div>
      <div class="dialog-actions">
        <button type="button" class="btn-secondary" id="agt-pm-zurueck">Zurück</button>
        <button type="button" class="btn-primary" id="agt-pm-speichern">Einplanen</button>
      </div>
    </form>`);
  dlg.querySelector('#agt-pm-zurueck').addEventListener('click', agtPlanungDialog);
  dlg.querySelector('#agt-pm-speichern').addEventListener('click', async () => {
    const ids = [...dlg.querySelectorAll('.agt-s-liste input:checked')].map((c) => Number(c.value));
    if (!ids.length) { toast('Niemand ausgewählt', 'error'); return; }
    try {
      await agtSende('/api/agt/planung', 'PUT', { person_ids: ids, termin_id: g.termin.id });
      toast(`${ids.length} AGT eingeplant`, 'success');
      await window.ladeAtemschutz();
      agtPlanungDialog();
    } catch (err) { toast('Fehler: ' + err.message, 'error'); }
  });
}

// Interne Teilnehmerliste: eine Seite je Termin
async function agtTeilnehmerPdf(gruppen) {
  gruppen = gruppen.filter((g) => g && g.personen.length);
  if (!gruppen.length) return;
  let jsPDF;
  try { jsPDF = await loadJsPdf(); } catch (err) { hinweis('PDF nicht möglich\n\n' + err.message); return; }
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  gruppen.forEach((g, i) => {
    if (i) doc.addPage();
    doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
    doc.text('Belastungsübung Atemschutzstrecke', 16, 20);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
    doc.text(agtTerminText(g.datum, g.uhrzeit, true), 16, 27);
    const zusatz = g.termin ? (g.termin.art === 'ausweich' ? 'Ausweichtermin' : g.termin.kunden || '') : 'frei vereinbartes Datum';
    doc.text(`${zusatz ? zusatz + ' · ' : ''}${g.personen.length} Teilnehmer`, 16, 33);
    const zeilen = g.personen.map((p) => {
      const [nach, vor] = p.name.split(', ');
      const st = p.spalten.strecke?.nachweis, gg = p.spalten.g263?.nachweis;
      return [nach, vor || '', st ? (st.gueltig_bis ? formatDate(st.gueltig_bis) : 'unbefristet') : 'fehlt',
              gg ? (gg.gueltig_bis ? formatDate(gg.gueltig_bis) : 'unbefristet') : 'fehlt'];
    }).sort((a, b) => `${a[0]} ${a[1]}`.localeCompare(`${b[0]} ${b[1]}`, 'de'));
    doc.autoTable({
      startY: 39, margin: { left: 16, right: 16 }, theme: 'grid',
      styles: { font: 'helvetica', fontSize: 10, cellPadding: 2 },
      headStyles: { fillColor: [243, 241, 239], textColor: [27, 22, 19] },
      head: [['Name', 'Vorname', 'Strecke gültig bis', 'G 26.3 gültig bis']],
      body: zeilen,
    });
    doc.setFontSize(8); doc.setTextColor(95, 87, 80);
    doc.text(`Freiwillige Feuerwehr Musterwehr · interne Teilnehmerliste · Stand ${formatDate(AGT.heute)} · ${STATE.user?.username || ''}`, 16, 287);
    doc.setTextColor(0, 0, 0);
  });
  await pdfAusgeben(doc, gruppen.length === 1 ? `Teilnehmerliste_Strecke_${gruppen[0].datum}.pdf` : `Teilnehmerliste_Strecke_${AGT.heute}.pdf`);
}

// Terminliste des Kreises lesen: je Zeile "Donnerstag, 14. Januar 2027 18:30
// Kunden" (Text aus dem PDF) oder "14.01.2027 18:30 Kunden". Die Art ergibt
// sich aus den Kunden: Ausweichtermin, eigene Kommune (MODUL.kommune), sonst
// weitere.
const AGT_MONATE = ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'];
function agtTermineParsen(text) {
  const kommune = agtKommune().toLowerCase();
  const zwei = (x) => String(x).padStart(2, '0');
  const out = [];
  for (const roh of String(text || '').split(/\r?\n/)) {
    const z = roh.replace(/\s+/g, ' ').trim();
    let m = /(\d{1,2})\.\s*([A-Za-zÄÖÜäöü]+)\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(.*)$/.exec(z);
    let datum, uhrzeit, rest;
    if (m && AGT_MONATE.includes(m[2].toLowerCase())) {
      datum = `${m[3]}-${zwei(AGT_MONATE.indexOf(m[2].toLowerCase()) + 1)}-${zwei(m[1])}`;
      uhrzeit = `${zwei(m[4])}:${m[5]}`; rest = m[6];
    } else if ((m = /(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})\s*(.*)$/.exec(z))) {
      datum = `${m[3]}-${zwei(m[2])}-${zwei(m[1])}`;
      uhrzeit = `${zwei(m[4])}:${m[5]}`; rest = m[6];
    } else continue;
    const kunden = rest.trim();
    const art = /ausweich/i.test(kunden) ? 'ausweich' : kommune && kunden.toLowerCase().includes(kommune) ? 'eigen' : 'weitere';
    if (!out.some((t) => t.datum === datum && t.uhrzeit === uhrzeit)) out.push({ datum, uhrzeit, kunden, art });
  }
  return out;
}

// --- Einstellungen: Tauglichkeiten verwalten ------------------------------
// Je Tauglichkeit die Gültigkeit in Monaten und ob Atemschutzpass und Florix
// für "dunkelgrün" nötig sind. Speichert jede Änderung sofort.
window.agtArtenDialog = async function () {
  let arten, termine;
  try { [arten, termine] = await Promise.all([agtSende('/api/agt/arten', 'GET'), agtSende('/api/agt/termine', 'GET')]); }
  catch (err) { hinweis('Tauglichkeiten nicht abrufbar\n\n' + err.message); return; }
  const jetztJahr = new Date().getFullYear();
  const jahre = [...new Set(termine.map((t) => t.datum.slice(0, 4)))].sort();
  const artWahl = (wert, attr) => `<div class="field"><select ${attr} aria-label="Art des Termins">${['eigen', 'ausweich', 'weitere'].map((a) =>
    `<option value="${a}" ${a === wert ? 'selected' : ''}>${escapeHtml(agtArtText(a))}</option>`).join('')}</select></div>`;
  const dlg = agtDialog(`
    <form method="dialog" class="agt-form">
      <h3>Tauglichkeiten</h3>
      <p class="agt-unter">Gültigkeit und welche Einträge für „gültig, eingetragen“ (dunkelgrün) nötig sind.</p>
      <div class="agt-arten" role="table" aria-label="Tauglichkeiten">
        <div class="agt-arten-kopf" role="row">
          <span role="columnheader">Tauglichkeit</span><span role="columnheader">Monate</span>
          <span role="columnheader">Pass</span><span role="columnheader">Florix</span>
        </div>
        ${arten.map((a) => `
          <div class="agt-art-zeile" role="row" data-art="${escapeHtml(a.art)}">
            <span role="cell" class="agt-art-name">${escapeHtml(a.name)}</span>
            <span role="cell" class="agt-art-monate">${a.art === 'lehrgang' ? '<span class="muted">unbefristet</span>'
              : `<span class="agt-art-lbl" aria-hidden="true">Monate</span><input type="number" min="1" max="120" inputmode="numeric" data-feld="frist_monate" value="${a.frist_monate ?? ''}" placeholder="—" aria-label="${escapeHtml(a.name)}: Gültigkeit in Monaten" />`}</span>
            <label role="cell" class="agt-art-haken"><input type="checkbox" data-feld="pass_pflicht" ${a.pass_pflicht ? 'checked' : ''} aria-label="${escapeHtml(a.name)}: Atemschutzpass nötig" /><span class="agt-art-lbl" aria-hidden="true">Pass</span></label>
            <label role="cell" class="agt-art-haken"><input type="checkbox" data-feld="florix_pflicht" ${a.florix_pflicht ? 'checked' : ''} aria-label="${escapeHtml(a.name)}: Florix nötig" /><span class="agt-art-lbl" aria-hidden="true">Florix</span></label>
          </div>`).join('')}
      </div>
      <p class="hint">Gültig bis = Datum + Monate − 1 Tag. Beispiel 12 Monate: Unterweisung am 22.05.2026 gilt bis 21.05.2027. Leer: Datum laut Bescheinigung (G 26.3). Daten aus dem Florix-Import bleiben, wie sie importiert wurden.</p>

      <h4 class="agt-abschnitt">Termine Atemschutzstrecke</h4>
      <div class="agt-termine">
        ${jahre.map((j) => {
          const l = termine.filter((t) => t.datum.startsWith(j));
          return `<details class="agt-termin-jahr" ${Number(j) >= jetztJahr ? 'open' : ''}>
            <summary>${j} · ${l.length} Termine</summary>
            ${l.map((t) => `
              <div class="agt-termin-zeile" data-tid="${t.id}">
                <input type="date" data-tf="datum" value="${t.datum}" aria-label="Datum" />
                <input type="time" data-tf="uhrzeit" value="${t.uhrzeit || ''}" aria-label="Uhrzeit" />
                <input type="text" data-tf="kunden" value="${escapeHtml(t.kunden || '')}" placeholder="Kunden" aria-label="Kunden" />
                ${artWahl(t.art, 'data-tf="art"')}
                <button type="button" class="icon-btn icon-danger" data-tdel="${t.id}" aria-label="Termin löschen" title="Termin löschen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>
                ${t.geplant ? `<span class="muted agt-termin-info">${t.geplant} AGT geplant</span>` : ''}
              </div>`).join('')}
          </details>`;
        }).join('') || '<p class="muted">Noch keine Termine.</p>'}
      </div>
      <div class="agt-termin-zeile agt-termin-neu">
        <input type="date" id="agt-tn-datum" aria-label="Datum des neuen Termins" />
        <input type="time" id="agt-tn-uhrzeit" value="18:30" aria-label="Uhrzeit des neuen Termins" />
        <input type="text" id="agt-tn-kunden" placeholder="Kunden" aria-label="Kunden des neuen Termins" />
        ${artWahl('eigen', 'id="agt-tn-art"')}
        <button type="button" class="btn-secondary" id="agt-tn-ok">+ Termin</button>
      </div>
      <button type="button" class="chip" id="agt-t-einfuegen">Liste einfügen</button>
      <div class="agt-t-import hidden" id="agt-t-import">
        <div class="field"><label for="agt-t-text">Terminliste des Kreises (aus dem PDF kopiert)</label>
          <textarea id="agt-t-text" rows="6" placeholder="Donnerstag, 14. Januar 2027 18:30 Weinbach, ${escapeHtml(agtKommune() || 'Musterort')}"></textarea></div>
        <button type="button" class="btn-secondary" id="agt-t-vorschau">Vorschau</button>
        <div id="agt-t-ergebnis"></div>
      </div>
      <div class="dialog-actions"><button type="button" class="btn-primary" data-schliessen>Fertig</button></div>
    </form>`);
  // Termine Atemschutzstrecke
  dlg.querySelectorAll('[data-tf]').forEach((el) => el.addEventListener('change', async () => {
    const id = el.closest('[data-tid]').dataset.tid;
    try {
      await agtSende(`/api/agt/termine/${id}`, 'PUT', { [el.dataset.tf]: el.value || null });
      toast('Termin gespeichert', 'success');
    } catch (err) { toast('Fehler: ' + err.message, 'error'); window.agtArtenDialog(); }
  }));
  dlg.querySelectorAll('[data-tdel]').forEach((b) => b.addEventListener('click', async () => {
    const t = termine.find((x) => String(x.id) === b.dataset.tdel);
    if (!await bestaetigen(`Termin ${agtTerminText(t.datum, t.uhrzeit)} löschen?${t.geplant ? `\n\n${t.geplant} geplante AGT behalten das Datum als frei eingegebenes Datum.` : ''}`)) { window.agtArtenDialog(); return; }
    try { await agtSende(`/api/agt/termine/${t.id}`, 'DELETE'); toast('Termin gelöscht', 'success'); }
    catch (err) { toast('Fehler: ' + err.message, 'error'); }
    window.agtArtenDialog();
  }));
  dlg.querySelector('#agt-tn-ok').addEventListener('click', async () => {
    const t = { datum: dlg.querySelector('#agt-tn-datum').value, uhrzeit: dlg.querySelector('#agt-tn-uhrzeit').value || null,
                kunden: dlg.querySelector('#agt-tn-kunden').value, art: dlg.querySelector('#agt-tn-art').value };
    if (!t.datum) { toast('Datum fehlt', 'error'); return; }
    try {
      const r = await agtSende('/api/agt/termine', 'POST', { termine: [t] });
      toast(r.neu ? 'Termin angelegt' : 'Diesen Termin gibt es schon', r.neu ? 'success' : 'error');
      window.agtArtenDialog();
    } catch (err) { toast('Fehler: ' + err.message, 'error'); }
  });
  dlg.querySelector('#agt-t-einfuegen').addEventListener('click', () => {
    dlg.querySelector('#agt-t-import').classList.toggle('hidden');
    dlg.querySelector('#agt-t-text').focus();
  });
  dlg.querySelector('#agt-t-vorschau').addEventListener('click', () => {
    const liste = agtTermineParsen(dlg.querySelector('#agt-t-text').value);
    const ziel = dlg.querySelector('#agt-t-ergebnis');
    if (!liste.length) { ziel.innerHTML = '<p class="hint">Keine Termine erkannt. Erwartet je Zeile: Datum, Uhrzeit, Kunden.</p>'; return; }
    const zahl = (a) => liste.filter((t) => t.art === a).length;
    ziel.innerHTML = `<p><strong>${liste.length} Termine erkannt</strong> · ${zahl('eigen')} ${escapeHtml(agtArtText('eigen'))}, ${zahl('ausweich')} Ausweichtermin, ${zahl('weitere')} weitere</p>
      <ul class="agt-vorschau">${liste.map((t) => `<li>${escapeHtml(agtTerminText(t.datum, t.uhrzeit))} · ${escapeHtml(t.kunden || '')} <span class="muted">(${escapeHtml(agtArtText(t.art))})</span></li>`).join('')}</ul>
      <button type="button" class="btn-primary" id="agt-t-uebernehmen">${liste.length} Termine übernehmen</button>`;
    ziel.querySelector('#agt-t-uebernehmen').addEventListener('click', async () => {
      try {
        const r = await agtSende('/api/agt/termine', 'POST', { termine: liste });
        toast(`${r.neu} neu${r.vorhanden ? `, ${r.vorhanden} schon vorhanden` : ''}`, 'success');
        window.agtArtenDialog();
      } catch (err) { toast('Fehler: ' + err.message, 'error'); }
    });
  });

  dlg.querySelectorAll('[data-feld]').forEach((el) => el.addEventListener('change', async () => {
    const art = el.closest('[data-art]').dataset.art;
    const wert = el.type === 'checkbox' ? el.checked : (el.value === '' ? null : Number(el.value));
    try {
      await agtSende(`/api/agt/arten/${encodeURIComponent(art)}`, 'PUT', { [el.dataset.feld]: wert });
      toast('Gespeichert', 'success');
      if (STATE.view === 'atemschutz') await window.ladeAtemschutz();
    } catch (err) {
      if (el.type === 'checkbox') el.checked = !el.checked;
      toast('Fehler: ' + err.message, 'error');
    }
  }));
};

// --- Person: Kennzeichen entfernen --------------------------------------

function agtPersonDialog(pid) {
  const p = AGT.personen.find((x) => x.id === pid);
  if (!p) return;
  const dlg = agtDialog(`
    <form method="dialog" class="agt-form">
      <h3>${escapeHtml(p.name)}</h3>
      <p class="agt-unter">Atemschutzgeräteträger · ${p.tauglich ? 'tauglich' : 'nicht tauglich'}</p>
      <p>Wer nicht mehr unter Atemschutz eingesetzt wird, verliert hier das Kennzeichen AGT. Die Nachweise bleiben gespeichert.</p>
      <div class="dialog-actions">
        <button type="button" class="btn-secondary" data-schliessen>Abbrechen</button>
        <button type="button" class="btn-danger" id="agt-entfernen">Kennzeichen entfernen</button>
      </div>
    </form>`);
  dlg.querySelector('#agt-entfernen').addEventListener('click', async () => {
    try {
      await agtSende(`/api/agt/personen/${pid}`, 'PUT', { agt: false });
      dlg.close();
      toastRueckgaengig(`${p.name} ist kein AGT mehr`, async () => {
        await agtSende(`/api/agt/personen/${pid}`, 'PUT', { agt: true });
        await window.ladeAtemschutz();
      });
      await window.ladeAtemschutz();
    } catch (err) { toast('Fehler: ' + err.message, 'error'); }
  });
}

// --- + AGT ---------------------------------------------------------------

async function agtNeuDialog() {
  let kandidaten = [];
  try { kandidaten = await agtSende('/api/agt/kandidaten', 'GET'); }
  catch (err) { hinweis('Personen nicht abrufbar\n\n' + err.message); return; }
  const dlg = agtDialog(`
    <form method="dialog" class="agt-form">
      <h3>AGT kennzeichnen</h3>
      <p class="agt-unter">Aktive Mitglieder der Einsatzabteilung ohne Kennzeichen</p>
      <div class="field"><label for="agt-suche">Suche</label><input type="search" id="agt-suche" placeholder="Name …" autocomplete="off" /></div>
      <ul class="add-liste" id="agt-kand"></ul>
      <div class="dialog-actions"><button type="button" class="btn-secondary" data-schliessen>Schließen</button></div>
    </form>`);
  const zeige = () => {
    const f = dlg.querySelector('#agt-suche').value.trim().toLowerCase();
    const liste = kandidaten.filter((k) => !f || `${k.nachname} ${k.vorname}`.toLowerCase().includes(f));
    dlg.querySelector('#agt-kand').innerHTML = liste.length
      ? liste.map((k) => `<li><button type="button" class="add-item" data-id="${k.id}"><span>${escapeHtml(k.nachname)}, ${escapeHtml(k.vorname)}</span><span class="add-abt">+ AGT</span></button></li>`).join('')
      : '<li class="add-leer">Keine passende Person.</li>';
    dlg.querySelectorAll('.add-item').forEach((b) => b.addEventListener('click', async () => {
      try {
        await agtSende(`/api/agt/personen/${b.dataset.id}`, 'PUT', { agt: true });
        kandidaten = kandidaten.filter((k) => k.id !== Number(b.dataset.id));
        toast('Als AGT gekennzeichnet', 'success');
        zeige();
        await window.ladeAtemschutz();
      } catch (err) { toast('Fehler: ' + err.message, 'error'); }
    }));
  };
  dlg.querySelector('#agt-suche').addEventListener('input', zeige);
  zeige();
}

// --- Sammeleintrag -------------------------------------------------------

// vorgabe: { art, datum, ids } — z. B. aus der Planung nach einem Termin
function agtSammelDialog(vorgabe = {}) {
  const personen = AGT.personen;
  const vorIds = new Set(vorgabe.ids || []);
  if (!personen.length) { hinweis('Noch keine Geräteträger\n\nZuerst den Florix-Export importieren oder Personen mit „+ AGT“ kennzeichnen.'); return; }
  const dlg = agtDialog(`
    <form method="dialog" class="agt-form">
      <h3>Sammeleintrag</h3>
      <p class="agt-unter">Ein Nachweis für mehrere Geräteträger, z. B. nach einem Streckendurchgang</p>
      <div class="row-2">
        <div class="field"><label for="agt-s-art">Nachweis</label>
          <select id="agt-s-art">
            <option value="strecke">Belastungsübung Übungsstrecke</option>
            <option value="unterweisung" ${vorgabe.art === 'unterweisung' ? 'selected' : ''}>Unterweisung Atemschutz</option>
            <option value="einsatzuebung" ${vorgabe.art === 'einsatzuebung' ? 'selected' : ''}>Einsatzübung Atemschutz</option>
          </select></div>
        <div class="field"><label for="agt-s-datum">Durchgeführt am</label><input type="date" id="agt-s-datum" value="${escapeHtml(vorgabe.datum || '')}" /></div>
      </div>
      <div class="field">
        <label>Geräteträger</label>
        <div class="checkbox-liste agt-s-liste">${personen.map((p) =>
          `<label><input type="checkbox" value="${p.id}" ${vorIds.has(p.id) ? 'checked' : ''} /> <span>${escapeHtml(p.name)}</span></label>`).join('')}</div>
      </div>
      <div class="dialog-actions">
        <button type="button" class="btn-secondary" data-schliessen>Abbrechen</button>
        <button type="button" class="btn-primary" id="agt-s-speichern">Eintragen</button>
      </div>
    </form>`);
  dlg.querySelector('#agt-s-speichern').addEventListener('click', async () => {
    const ids = [...dlg.querySelectorAll('.agt-s-liste input:checked')].map((c) => Number(c.value));
    const datum = dlg.querySelector('#agt-s-datum').value;
    if (!datum) { toast('Datum fehlt', 'error'); return; }
    if (!ids.length) { toast('Niemand ausgewählt', 'error'); return; }
    try {
      await agtSende('/api/agt/nachweise', 'POST', { person_ids: ids, art: dlg.querySelector('#agt-s-art').value, datum });
      dlg.close();
      toast(`${ids.length} Nachweis${ids.length === 1 ? '' : 'e'} eingetragen`, 'success');
      await window.ladeAtemschutz();
    } catch (err) { toast('Fehler: ' + err.message, 'error'); }
  });
}

// --- Florix-Import -------------------------------------------------------

// CSV mit Anführungszeichen und Zeilenumbrüchen in Feldern (der Kopf des
// Florix-Exports steht in einer Zelle über mehrere Zeilen).
function agtCsv(text, sep = ';') {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
      continue;
    }
    if (c === '"') q = true;
    else if (c === sep) { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); rows.push(row); row = []; f = '';
    } else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
function agtIso(s) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(s || '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// Liest den Export und behält nur, was die App braucht. Geburtsdaten
// werden hier verworfen und verlassen den Browser nicht.
function agtExportLesen(text) {
  const rows = agtCsv(text.replace(/^﻿/, ''));
  const k = rows.findIndex((r) => (r[0] || '').trim() === 'Name, Vorname');
  if (k < 0) throw new Error('Spalte „Name, Vorname“ nicht gefunden. Ist das der Export „Tauglichkeiten Atemschutz“?');
  const h = rows[k];
  const col = (teil) => h.findIndex((x) => x.includes(teil));
  const C = {
    organisation: col('Organisation'), lehrgang: col('Lehrgang'), strecke: col('Belastungsübung'),
    g263: col('G26.3'), unterweisung: col('Unterweisung'), einsatz: col('Atemschutzeinsatz'),
    einsatzuebung: col('Einsatzübung'),
  };
  for (const key of ['lehrgang', 'strecke', 'g263', 'unterweisung', 'einsatzuebung']) {
    if (C[key] < 0) throw new Error(`Spalte für „${key}“ fehlt im Export`);
  }
  const kopf = rows.slice(0, k).flat().join('\n');
  const stichtag = agtIso((/Stichtag:\s*(\d{2}\.\d{2}\.\d{4})/.exec(kopf) || [])[1]);
  const zeilen = rows.slice(k + 1).filter((r) => (r[0] || '').trim()).map((r) => ({
    name: r[0].trim(),
    organisation: C.organisation >= 0 ? (r[C.organisation] || '').trim() : '',
    lehrgang: agtIso(r[C.lehrgang]), strecke: agtIso(r[C.strecke]), g263: agtIso(r[C.g263]),
    unterweisung: agtIso(r[C.unterweisung]),
    einsatz: C.einsatz >= 0 ? agtIso(r[C.einsatz]) : null,
    einsatzuebung: agtIso(r[C.einsatzuebung]),
  }));
  return { stichtag, zeilen };
}

async function agtImportDatei(e) {
  const datei = e.target.files?.[0];
  e.target.value = '';
  if (!datei) return;
  let daten;
  try {
    const buf = await datei.arrayBuffer();
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch { text = new TextDecoder('windows-1252').decode(buf); }
    daten = agtExportLesen(text);
  } catch (err) { hinweis('Datei nicht lesbar\n\n' + err.message); return; }
  await agtImportVorschau(daten, {});
}

async function agtImportVorschau(daten, zuordnung) {
  let v;
  try { v = await agtSende('/api/agt/import', 'POST', { ...daten, zuordnung, uebernehmen: false }); }
  catch (err) { hinweis('Import nicht möglich\n\n' + err.message); return; }
  const neuAgt = v.zugeordnet.filter((z) => z.neu_agt);
  const dlg = agtDialog(`
    <form method="dialog" class="agt-form">
      <h3>Florix-Import</h3>
      <p class="agt-unter">Stand ${v.stichtag ? formatDate(v.stichtag) : 'unbekannt'} · ${v.zeilen} Zeilen</p>
      <ul class="agt-vorschau">
        <li><strong>${v.zugeordnet.length}</strong> Geräteträger zugeordnet</li>
        <li><strong>${v.neue_daten}</strong> neue oder geänderte Florix-Daten</li>
        ${neuAgt.length ? `<li><strong>${neuAgt.length}</strong> bekommen das Kennzeichen AGT: ${neuAgt.map((z) => escapeHtml(z.person)).join(', ')}</li>` : ''}
        ${v.nicht_mehr.length ? `<li><strong>${v.nicht_mehr.length}</strong> nicht mehr im Export (bleiben AGT, bitte prüfen): ${v.nicht_mehr.map((p) => escapeHtml(p.person)).join(', ')}</li>` : ''}
      </ul>
      ${v.offen.length ? `
        <div class="sp-treffer">
          <div class="t-kopf">${v.offen.length} Name${v.offen.length === 1 ? '' : 'n'} ohne eindeutige Person</div>
          ${v.offen.map((o, i) => `
            <div class="field">
              <label for="agt-z-${i}">${escapeHtml(o.name)}${o.organisation ? ' · ' + escapeHtml(o.organisation) : ''}</label>
              <select id="agt-z-${i}" data-name="${escapeHtml(o.name)}">
                <option value="">— bitte wählen —</option>
                <option value="0">nicht übernehmen</option>
                ${v.personen.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}
              </select>
            </div>`).join('')}
          <p class="hint">Die Wahl wird gemerkt und beim nächsten Import wieder verwendet.</p>
        </div>` : ''}
      <div class="dialog-actions">
        <button type="button" class="btn-secondary" data-schliessen>Abbrechen</button>
        <button type="button" class="btn-primary" id="agt-i-ok">${v.offen.length ? 'Weiter' : 'Übernehmen'}</button>
      </div>
    </form>`);
  dlg.querySelector('#agt-i-ok').addEventListener('click', async () => {
    const z = { ...zuordnung };
    for (const sel of dlg.querySelectorAll('select[data-name]')) {
      if (sel.value === '') { toast('Bitte jeden Namen zuordnen oder „nicht übernehmen“ wählen', 'error'); return; }
      z[sel.dataset.name] = Number(sel.value);
    }
    if (v.offen.length) { await agtImportVorschau(daten, z); return; }
    try {
      await agtSende('/api/agt/import', 'POST', { ...daten, zuordnung: z, uebernehmen: true });
      dlg.close();
      toast('Florix-Stand übernommen', 'success');
      await window.ladeAtemschutz();
    } catch (err) { toast('Fehler: ' + err.message, 'error'); }
  });
}
