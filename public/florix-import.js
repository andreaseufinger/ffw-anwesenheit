// Änderungsliste des Florix-Imports (Atemschutz und Kleidung).
//
// Wird von atemschutz.js und kleidung.js über modulLaden('florix-import')
// geholt und nutzt die Helfer aus app.js (escapeHtml). Die Gruppen kommen
// fertig vom Server (`aenderungen`); hier wird nur gezeigt, nichts gerechnet.
// Gruppen bis 10 Einträge sind offen, größere zugeklappt (Konzept E6).

const FLX_OFFEN_BIS = 10;

// gruppen: [{ titel, eintraege: [HTML je Zeile], hinweis? }], leere werden
// ausgelassen. zahlen: Zeilen für Unverändertes, nur als Zahl.
window.florixListe = function florixListe(gruppen, zahlen = []) {
  const voll = gruppen.filter((g) => g.eintraege.length);
  const gruppenHtml = voll.map((g) => `
    <details class="themen-gruppe florix-gruppe"${g.eintraege.length <= FLX_OFFEN_BIS ? ' open' : ''}>
      <summary><span class="g-name">${escapeHtml(g.titel)}</span><span class="g-meta">${g.eintraege.length}</span></summary>
      ${g.hinweis ? `<p class="muted florix-hinweis">${escapeHtml(g.hinweis)}</p>` : ''}
      <ul class="agt-vorschau florix-liste">${g.eintraege.map((e) => `<li>${e}</li>`).join('')}</ul>
    </details>`).join('');
  const zeilen = zahlen.filter((z) => z.anzahl).map((z) => `<li><strong>${z.anzahl}</strong> ${escapeHtml(z.text)}</li>`).join('');
  return `<div class="themen-gruppen florix-gruppen">${gruppenHtml}</div>${zeilen ? `<ul class="agt-vorschau florix-zahlen">${zeilen}</ul>` : ''}`;
};

// Satz über der Liste und Beschriftung des Knopfs: ohne Änderungen wird nur
// vermerkt, dass der Export eingelesen wurde (Konzept E4).
window.florixKopf = function florixKopf(anzahlAenderungen) {
  return anzahlAenderungen
    ? { satz: `${anzahlAenderungen} ${anzahlAenderungen === 1 ? 'Änderung' : 'Änderungen'}. Erst mit dem Knopf unten wird gebucht.`, knopf: 'Änderungen übernehmen' }
    : { satz: 'Der Export bringt keine Änderungen.', knopf: 'Stand übernehmen' };
};

// Ein alter → neuer Wert, mit „leer“ für fehlende Angaben.
window.florixWechsel = function florixWechsel(alt, neu) {
  const t = (v) => (v == null || v === '' ? '<span class="muted">leer</span>' : escapeHtml(String(v)));
  return `${t(alt)} → ${t(neu)}`;
};
