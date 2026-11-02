// Prüfsumme für die Änderungsliste der Florix-Importe (Atemschutz, Kleidung).
//
// Die Vorschau liefert Liste und Prüfsumme. Beim Übernehmen rechnet der
// Server den Plan neu und bucht nur, wenn die Prüfsumme dieselbe ist wie in
// der Vorschau: Was gezeigt wurde, ist genau das, was gebucht wird.

// JSON mit sortierten Schlüsseln, damit gleiche Daten gleich aussehen.
// Die Reihenfolge von Listen bleibt, sie ist Teil des Plans.
export function kanonisch(wert) {
  if (Array.isArray(wert)) return `[${wert.map(kanonisch).join(',')}]`;
  if (wert && typeof wert === 'object') {
    return `{${Object.keys(wert).sort()
      .filter((k) => wert[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${kanonisch(wert[k])}`).join(',')}}`;
  }
  return JSON.stringify(wert ?? null);
}

// SHA-256 der kanonischen Form als Hex-Text.
export async function planPruefsumme(wert) {
  const bytes = new TextEncoder().encode(kanonisch(wert));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
