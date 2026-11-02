// Audit-Log: wer hat wann was geändert.
//
// Allgemein gehalten (bereich, objekt), damit Atemschutz, Kleidung und später
// das Einsatzprotokoll dieselbe Tabelle nutzen. details ist JSON und enthält
// nur, was sich geändert hat — keine Befunde, keine Geburtsdaten.

// Ein Eintrag als vorbereitete Anweisung, damit Aufrufer ihn in denselben
// Batch wie die eigentliche Änderung legen können (beides oder nichts).
export function auditEintrag(env, user, { bereich, aktion, objekt = null, objektId = null, details = null }) {
  return env.DB.prepare(
    `INSERT INTO audit_log (benutzer, bereich, aktion, objekt, objekt_id, details)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    user?.username ?? null, bereich, aktion, objekt,
    objektId === null ? null : String(objektId),
    details === null ? null : JSON.stringify(details),
  );
}

export async function protokolliere(env, user, eintrag) {
  await auditEintrag(env, user, eintrag).run();
}
