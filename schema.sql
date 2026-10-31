-- D1 Schema für Anwesenheit Ausbildungsabend (Template / öffentliche Version)
-- Identisch zur produktiven Variante, aber mit generischem Standard-Admin.
-- Am Ende stehen die Tabellen des Einsatzprotokolls (leer, ohne Stammdaten):
-- Auswertung, Atemschutz und Kleidung fragen sie mit ab.
PRAGMA foreign_keys = ON;

-- =====================================================================
-- Abteilungen
--
-- Die Wehr hat mehr als eine Abteilung (Einsatzabteilung, Jugendfeuerwehr).
-- Abteilung ist eine Dimension an den Stammdaten, nicht eine Vermehrung der
-- Rollennamen — sonst bräuchte jede weitere Abteilung neue Rollen.
--
-- uebung_soll_stunden NULL bedeutet "kein Stundensoll": die Auswertung lässt
-- die Ampel dann weg. Für die Jugendfeuerwehr ist das so gewollt.
-- =====================================================================
CREATE TABLE IF NOT EXISTS abteilungen (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kurz                TEXT,
  uebung_soll_stunden REAL,                 -- NULL = kein Soll, keine Ampel
  -- Vorbelegung der Erfassung. Als Daten und nicht im Code, damit eine
  -- weitere Abteilung keine Codeänderung braucht.
  standard_zeit_von   TEXT,                 -- HH:MM
  standard_zeit_bis   TEXT,                 -- HH:MM
  -- 1 = Mitglieder nehmen am Einsatzdienst teil. Das Einsatzprotokoll liest
  -- seine Teilnehmerliste danach, statt einen Abteilungsnamen zu kennen.
  -- Eine Alters- und Ehrenabteilung bekäme 0.
  einsatzdienst       INTEGER NOT NULL DEFAULT 0,
  -- Bestimmt auch die Vorauswahl in der Erfassung: die niedrigste Abteilung,
  -- für die der Benutzer berechtigt ist.
  sort_order          INTEGER NOT NULL DEFAULT 100
);

INSERT OR IGNORE INTO abteilungen (name, kurz, uebung_soll_stunden, standard_zeit_von, standard_zeit_bis, einsatzdienst, sort_order) VALUES ('Einsatzabteilung FF', 'FF', 30, '20:00', '21:30', 1, 10);
INSERT OR IGNORE INTO abteilungen (name, kurz, uebung_soll_stunden, standard_zeit_von, standard_zeit_bis, einsatzdienst, sort_order) VALUES ('Jugendfeuerwehr', 'JF', NULL, '18:15', '19:30', 0, 20);

-- =====================================================================
-- Stammdaten: Personen, Dienstarten, Themen
--
-- Werden im Admin-Bereich gepflegt (Menü -> Personen/Themen verwalten), nicht
-- über Dateien im Repo. Die Personenliste gilt auch für die Schwester-App
-- Einsatzprotokoll, die dieselbe Tabelle liest.
--
-- Ausgetretene werden auf aktiv = 0 gesetzt, nicht gelöscht: sie verschwinden
-- aus den Auswahllisten, bleiben aber für Auswertungen vergangener Jahre
-- erhalten.
--
-- Dienstart ist eine eigene Tabelle, weil die frühere Freitext-Variante schon
-- auseinandergelaufen war ("Veranstaltungen" neben "Veranstaltung"). kategorie
-- entscheidet, was in der Auswertung als Übung zählt.
--
-- Steht vor attendance_entries, weil dessen person_id hierauf verweist.
-- =====================================================================
CREATE TABLE IF NOT EXISTS personen (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  nachname   TEXT NOT NULL,
  vorname    TEXT NOT NULL,
  aktiv      INTEGER NOT NULL DEFAULT 1,
  eintritt   TEXT,                             -- ISO yyyy-mm-dd, optional
  austritt   TEXT,                             -- ISO yyyy-mm-dd, optional
  agt        INTEGER NOT NULL DEFAULT 0,       -- Atemschutzgeräteträger (Modul Atemschutz)
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (nachname, vorname)
);

CREATE INDEX IF NOT EXISTS idx_personen_sort ON personen(aktiv DESC, nachname COLLATE NOCASE, vorname COLLATE NOCASE);

-- Personen <-> Abteilung ist n:m, nicht 1:n: ein Jugendwart gehört zu beiden
-- Abteilungen. Mit einer einzelnen abteilung_id an der Person müsste man ihn
-- doppelt anlegen und hätte ihn in der Auswertung zweimal.
--
-- von/bis sind für den Wechsel gedacht, der bei einer Jugendwehr jährlich
-- vorkommt (18 werden und in die Einsatzabteilung übertreten). Leer = immer.
-- Rolle einer Person innerhalb einer Abteilung (Jugendlicher, Betreuer,
-- Mitglied). Eigene Tabelle und kein Freitext: an einem Freitextfeld ist die
-- Gruppierung hier schon einmal auseinandergelaufen. Die Liste ist global,
-- der Kontext kommt aus der Abteilung, in der sie zugewiesen wird.
CREATE TABLE IF NOT EXISTS personen_rollen (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort_order INTEGER NOT NULL DEFAULT 100
);

INSERT OR IGNORE INTO personen_rollen (name, sort_order) VALUES ('Mitglied', 10);
INSERT OR IGNORE INTO personen_rollen (name, sort_order) VALUES ('Jugendlicher', 20);
INSERT OR IGNORE INTO personen_rollen (name, sort_order) VALUES ('Betreuer', 30);

CREATE TABLE IF NOT EXISTS personen_abteilungen (
  person_id    INTEGER NOT NULL REFERENCES personen(id) ON DELETE CASCADE,
  abteilung_id INTEGER NOT NULL REFERENCES abteilungen(id) ON DELETE RESTRICT,
  von          TEXT,
  bis          TEXT,
  -- Die Rolle hängt an der ZUGEHÖRIGKEIT, nicht an der Person: ein Jugendwart
  -- ist in der Jugendfeuerwehr Betreuer, in der Einsatzabteilung einfaches
  -- Mitglied. An der Person wäre eine der beiden Angaben zwangsläufig falsch.
  rolle_id     INTEGER REFERENCES personen_rollen(id) ON DELETE SET NULL,
  PRIMARY KEY (person_id, abteilung_id)
);

CREATE INDEX IF NOT EXISTS idx_personen_abt ON personen_abteilungen(abteilung_id, person_id);
CREATE INDEX IF NOT EXISTS idx_personen_abt_rolle ON personen_abteilungen(abteilung_id, rolle_id);

CREATE TABLE IF NOT EXISTS dienstarten (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kategorie  TEXT NOT NULL DEFAULT 'sonstiges'
               CHECK (kategorie IN ('uebung','dienst','sonstiges')),
  sort_order INTEGER NOT NULL DEFAULT 100,
  -- NULL = gilt für alle Abteilungen. Gesetzt = nur dort, damit die Jugend
  -- eigene Dienstarten anlegen kann (Gruppenstunde, Zeltlager), ohne dass
  -- sie in der Einsatzabteilung auftauchen.
  abteilung_id INTEGER REFERENCES abteilungen(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS themen (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  dienstart_id INTEGER NOT NULL REFERENCES dienstarten(id) ON DELETE RESTRICT,
  thema        TEXT NOT NULL,
  abteilung    TEXT,
  prioritaet   INTEGER NOT NULL DEFAULT 1,
  aktiv        INTEGER NOT NULL DEFAULT 1,
  abteilung_id INTEGER REFERENCES abteilungen(id) ON DELETE RESTRICT,
  UNIQUE (dienstart_id, thema)
);

CREATE INDEX IF NOT EXISTS idx_themen_dienstart ON themen(dienstart_id, prioritaet, thema COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_themen_abteilung ON themen(abteilung_id, prioritaet, thema COLLATE NOCASE);

-- Sessions (Ausbildungsabende)
CREATE TABLE IF NOT EXISTS attendance_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  datum       TEXT NOT NULL,                  -- ISO yyyy-mm-dd
  zeit_von    TEXT,                           -- HH:MM
  zeit_bis    TEXT,                           -- HH:MM
  dienstart   TEXT NOT NULL,
  thema       TEXT NOT NULL,
  ausbilder   TEXT,
  bemerkung   TEXT,
  created_by  TEXT,                           -- username des Erfassers
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  abteilung_id INTEGER REFERENCES abteilungen(id) ON DELETE RESTRICT,
  -- Herkunft nachgetragener Termine, z. B. ein Export aus dem Dienstbuch der
  -- Wehrführung. NULL = in der App erfasst, der Normalfall. TEXT und kein
  -- Ja/Nein, damit ein Import vom nächsten unterscheidbar und über
  -- "WHERE migriert_quelle = ..." wieder zurücknehmbar ist.
  migriert_quelle TEXT,
  -- In Florix übertragen (NULL = Florix offen). Setzen nur Admins.
  florix_erfasst_at TEXT,
  florix_erfasst_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_datum ON attendance_sessions(datum DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_abteilung ON attendance_sessions(abteilung_id, datum DESC);

CREATE TABLE IF NOT EXISTS attendance_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  nachname    TEXT NOT NULL,
  vorname     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT '',       -- anwesend | ''
  bemerkung   TEXT,
  -- Verknüpfung zur Stammdaten-Person. Der Name bleibt daneben erhalten:
  -- wer später heiratet, soll im alten Protokoll den damaligen Namen behalten.
  -- NULL = nicht zuordenbar; die Auswertung weist das aus statt es zu verschweigen.
  person_id   INTEGER REFERENCES personen(id) ON DELETE SET NULL,
  -- Eigenes Kennzeichen auch hier: eine einzelne Teilnahme kann nachgetragen
  -- sein, obwohl der Termin selbst in der App erfasst wurde.
  migriert_quelle TEXT
);

CREATE INDEX IF NOT EXISTS idx_attendance_entries_person ON attendance_entries(person_id);

CREATE INDEX IF NOT EXISTS idx_entries_session ON attendance_entries(session_id);

CREATE INDEX IF NOT EXISTS idx_sessions_migriert ON attendance_sessions(migriert_quelle);
CREATE INDEX IF NOT EXISTS idx_entries_migriert ON attendance_entries(migriert_quelle);

-- Konfigurierbare Zusatz-Tags (z.B. "Atemschutz - Einsatzübung", "Führerscheinkontrolle")
CREATE TABLE IF NOT EXISTS tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort_order  INTEGER NOT NULL DEFAULT 100,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Atemschutz-Nachweis, den der Tag am Teilnehmer erzeugt ('unterweisung', 'einsatzuebung')
  agt_art     TEXT REFERENCES agt_arten(art)
);

CREATE INDEX IF NOT EXISTS idx_tags_sort ON tags(sort_order, name COLLATE NOCASE);

-- Zuordnung Tag <-> Teilnehmer-Eintrag
CREATE TABLE IF NOT EXISTS attendance_entry_tags (
  entry_id  INTEGER NOT NULL REFERENCES attendance_entries(id) ON DELETE CASCADE,
  tag_id    INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_entry_tags_entry ON attendance_entry_tags(entry_id);
CREATE INDEX IF NOT EXISTS idx_entry_tags_tag ON attendance_entry_tags(tag_id);

-- Standard-Tags stehen weiter unten, nach agt_arten: tags.agt_art verweist
-- darauf, und mit foreign_keys = ON scheitert sonst schon das Anlegen.

-- Benutzer (Login)
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT NOT NULL,                -- PBKDF2-SHA256, 100k Iterationen, 32 Bytes hex
  password_salt  TEXT NOT NULL,                -- 16 Bytes hex
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Geräte-Benutzer (z. B. LF10, GW): genau ein physisches Gerät je Benutzer,
  -- Anmeldung per Device-Token statt Passwort. Persönliche Benutzer haben
  -- is_device = 0 und melden sich weiterhin mit Benutzername + Passwort an.
  is_device           INTEGER NOT NULL DEFAULT 0,
  device_token_hash   TEXT,                    -- SHA-256 hex des Device-Tokens
  device_token_prefix TEXT,                    -- erste 8 Zeichen, nur zur Wiedererkennung
  device_revoked_at   TEXT,                    -- gesetzt = Gerät gesperrt
  last_seen_at        TEXT,
  last_seen_ip        TEXT
);

-- App-Rollen pro Benutzer (n:m). Ein Benutzer kann beliebig viele Rollen
-- halten — z. B. nur Anwesenheit-Admin, nur Einsatzprotokoll-Erfasser, beides usw.
-- Bewusst ohne CHECK auf die Rollennamen: SQLite kennt kein
-- ALTER TABLE ... DROP CONSTRAINT, jede neue Rolle hätte sonst einen
-- Tabellen-Neubau erfordert. Geprüft wird im Code (validateRoles gegen
-- ALL_ROLES in functions/_lib/auth.js), wo es wartbar ist.
CREATE TABLE IF NOT EXISTS user_roles (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     TEXT NOT NULL,
  PRIMARY KEY (user_id, role)
);

-- Für welche Abteilungen ein Benutzer erfassen bzw. als Abteilungsadmin
-- wirken darf. Leer = keine. admin_anwesenheit ist übergreifend und braucht
-- hier keinen Eintrag.
CREATE TABLE IF NOT EXISTS user_abteilungen (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  abteilung_id INTEGER NOT NULL REFERENCES abteilungen(id) ON DELETE RESTRICT,
  PRIMARY KEY (user_id, abteilung_id)
);

CREATE INDEX IF NOT EXISTS idx_user_abt ON user_abteilungen(abteilung_id, user_id);

CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role);

-- Standard-Admin
--   Benutzer:   Admin
--   Passwort:   changeme
-- WICHTIG: Direkt nach dem ersten Login das Passwort ändern!
INSERT OR IGNORE INTO users (username, password_hash, password_salt)
VALUES (
  'Admin',
  '1d975f1e741a1d31a5bb4fb655cdb1158f226e83f0bdb636727f2a90a5b8ccc9',
  '0123456789abcdef0123456789abcdef'
);

INSERT OR IGNORE INTO user_roles (user_id, role)
SELECT id, 'admin_anwesenheit' FROM users WHERE username = 'Admin';
INSERT OR IGNORE INTO user_roles (user_id, role)
SELECT id, 'erfasser_anwesenheit' FROM users WHERE username = 'Admin';

-- Session-Tokens
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,                -- 32 Bytes hex
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Einmal-Codes für die Ersteinrichtung eines Geräts (15 Minuten, einmal
-- einlösbar). Der langlebige Device-Token wandert dadurch nie über Mail
-- oder Chat, sondern entsteht erst auf dem Gerät selbst.
CREATE TABLE IF NOT EXISTS device_enrollments (
  code_hash  TEXT PRIMARY KEY,                 -- SHA-256 hex des Enrollment-Codes
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_device_enroll_user ON device_enrollments(user_id);
CREATE INDEX IF NOT EXISTS idx_users_device_token ON users(device_token_hash);

-- Audit-Log: wer hat wann was geändert. Allgemein gehalten, damit alle
-- Module dieselbe Tabelle nutzen (siehe migrations/2026-10-26_atemschutz.sql).
CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  zeit      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  benutzer  TEXT,
  bereich   TEXT NOT NULL,                     -- z. B. 'atemschutz'
  aktion    TEXT NOT NULL,                     -- anlegen | aendern | loeschen | import
  objekt    TEXT,
  objekt_id TEXT,
  details   TEXT                               -- JSON
);
CREATE INDEX IF NOT EXISTS idx_audit_objekt ON audit_log(bereich, objekt, objekt_id);
CREATE INDEX IF NOT EXISTS idx_audit_zeit ON audit_log(zeit);

-- Modul Atemschutz: Nachweisarten wie in Florix gegliedert, Nachweise je
-- Person, gemerkte Namenszuordnung und Importstände.
CREATE TABLE IF NOT EXISTS agt_arten (
  art          TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  gruppe       TEXT NOT NULL CHECK (gruppe IN ('grundlage', 'pflicht', 'wahlpflicht')),
  frist_monate INTEGER,                        -- NULL: unbefristet bzw. Datum der Bescheinigung (G 26.3)
  sort_order   INTEGER NOT NULL DEFAULT 100,
  -- Häkchen, die für "dunkelgrün" nötig sind (Einstellungen -> Tauglichkeiten)
  pass_pflicht   INTEGER NOT NULL DEFAULT 1,
  florix_pflicht INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO agt_arten (art, name, gruppe, frist_monate, sort_order) VALUES ('lehrgang', 'Lehrgang Atemschutzgeräteträger', 'grundlage', NULL, 10);
INSERT OR IGNORE INTO agt_arten (art, name, gruppe, frist_monate, sort_order) VALUES ('strecke', 'Belastungsübung Übungsstrecke', 'pflicht', 12, 20);
INSERT OR IGNORE INTO agt_arten (art, name, gruppe, frist_monate, sort_order) VALUES ('g263', 'G 26.3', 'pflicht', NULL, 30);
INSERT OR IGNORE INTO agt_arten (art, name, gruppe, frist_monate, sort_order) VALUES ('unterweisung', 'Unterweisung Atemschutz', 'pflicht', 12, 40);
INSERT OR IGNORE INTO agt_arten (art, name, gruppe, frist_monate, sort_order) VALUES ('einsatzuebung', 'Einsatzübung Atemschutz', 'wahlpflicht', 12, 50);
INSERT OR IGNORE INTO agt_arten (art, name, gruppe, frist_monate, sort_order) VALUES ('einsatz', 'Atemschutzeinsatz', 'wahlpflicht', 12, 60);

-- Standard-Tags (per OR IGNORE nur beim ersten Mal angelegt)
INSERT OR IGNORE INTO tags (name, sort_order) VALUES
  ('Atemschutz - Einsatzübung', 10),
  ('Atemschutz - Theorie', 20),
  ('Führerscheinkontrolle', 30);
UPDATE tags SET agt_art = 'einsatzuebung' WHERE name = 'Atemschutz - Einsatzübung' AND agt_art IS NULL;
UPDATE tags SET agt_art = 'unterweisung' WHERE name = 'Atemschutz - Theorie' AND agt_art IS NULL;

CREATE TABLE IF NOT EXISTS agt_nachweise (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id   INTEGER NOT NULL REFERENCES personen(id) ON DELETE CASCADE,
  art         TEXT NOT NULL REFERENCES agt_arten(art),
  datum       TEXT,                            -- Durchführung, wenn bekannt
  gueltig_bis TEXT,                            -- maßgeblich; Florix liefert nur dieses
  quelle      TEXT NOT NULL CHECK (quelle IN ('florix', 'manuell', 'anwesenheit', 'einsatz')),
  quelle_ref  TEXT,                            -- Florix: Ablaufdatum, Einsatz: Einsatz-ID
  pass        INTEGER NOT NULL DEFAULT 0,      -- im Atemschutzpass eingetragen
  florix      INTEGER NOT NULL DEFAULT 0,      -- in Florix eingetragen
  bemerkung   TEXT,
  verworfen   INTEGER NOT NULL DEFAULT 0,      -- automatischer Nachweis zurückgenommen
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (person_id, art, quelle, quelle_ref)
);
CREATE INDEX IF NOT EXISTS idx_agt_nachweise_person ON agt_nachweise(person_id, art, gueltig_bis);

-- Planung Atemschutzstrecke: Termine der Übungsanlage und je AGT der nächste
-- geplante Durchgang (Migration 2026-10-30_strecke_planung.sql legt auch die
-- Termine des Jahres an).
CREATE TABLE IF NOT EXISTS agt_strecke_termine (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  datum    TEXT NOT NULL,
  uhrzeit  TEXT,
  kunden   TEXT,
  art      TEXT NOT NULL DEFAULT 'weitere' CHECK (art IN ('eigen', 'ausweich', 'weitere')),
  UNIQUE (datum, uhrzeit)
);
CREATE INDEX IF NOT EXISTS idx_agt_termine_datum ON agt_strecke_termine(datum);

CREATE TABLE IF NOT EXISTS agt_planung (
  person_id  INTEGER PRIMARY KEY REFERENCES personen(id) ON DELETE CASCADE,
  datum      TEXT NOT NULL,
  termin_id  INTEGER REFERENCES agt_strecke_termine(id) ON DELETE SET NULL,
  geplant_by TEXT,
  geplant_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agt_planung_termin ON agt_planung(termin_id);

CREATE TABLE IF NOT EXISTS agt_namen (
  name      TEXT PRIMARY KEY COLLATE NOCASE,   -- "Nachname, Vorname" wie im Florix-Export
  person_id INTEGER REFERENCES personen(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agt_importe (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  stichtag      TEXT,
  zeilen        INTEGER,
  importiert_by TEXT,
  importiert_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Modul Kleidung: ZMS-Hessen führt Bestand und Ausgabe, die App ergänzt
-- Reinigung (= Prüfung) und "Abgegeben zur Reinigung". Seeds der Artikelarten
-- und der ZMS-Typen stehen in migrations/2026-10-27_kleidung.sql.
CREATE TABLE IF NOT EXISTS kleidung_artikelarten (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  intervall_monate INTEGER DEFAULT 12,          -- NULL: nur führen, nicht überwachen
  agt_relevant     INTEGER NOT NULL DEFAULT 0,  -- zählt für den Kleidungsstatus der AGT
  sort_order       INTEGER NOT NULL DEFAULT 100
);
CREATE TABLE IF NOT EXISTS kleidung_typen (
  typ           TEXT PRIMARY KEY COLLATE NOCASE, -- Bezeichnung aus ZMS
  artikelart_id INTEGER REFERENCES kleidung_artikelarten(id) ON DELETE SET NULL  -- NULL: nicht führen
);
CREATE TABLE IF NOT EXISTS kleidung_teile (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  identifikation TEXT UNIQUE,                   -- ZMS-Schlüssel; NULL bei Teilen nur in der App
  barcode        TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- Inventarnummer der Gemeinde (QR)
  artikelart_id  INTEGER REFERENCES kleidung_artikelarten(id) ON DELETE SET NULL,
  typ            TEXT,
  groesse        TEXT,
  person_id      INTEGER REFERENCES personen(id) ON DELETE SET NULL,
  standort       TEXT,
  quelle         TEXT NOT NULL DEFAULT 'zms' CHECK (quelle IN ('zms', 'app')),
  im_bestand     INTEGER NOT NULL DEFAULT 1,    -- 0: fehlte im letzten ZMS-Export
  created_by     TEXT,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_kleidung_teile_person ON kleidung_teile(person_id);
CREATE TABLE IF NOT EXISTS kleidung_reinigungen (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  teil_id      INTEGER NOT NULL REFERENCES kleidung_teile(id) ON DELETE CASCADE,
  abgegeben_am TEXT,
  gereinigt_am TEXT,                            -- NULL: noch in der Reinigung
  abgegeben_by TEXT,
  gereinigt_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_kleidung_reinigungen_teil ON kleidung_reinigungen(teil_id, gereinigt_am);
CREATE TABLE IF NOT EXISTS kleidung_namen (
  name      TEXT PRIMARY KEY COLLATE NOCASE,    -- "Vorname Nachname" wie in ZMS
  person_id INTEGER REFERENCES personen(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS kleidung_einsatz_vorschlaege (
  einsatz_id  INTEGER PRIMARY KEY,              -- Vorschlag "zur Reinigung" erledigt
  aktion      TEXT NOT NULL CHECK (aktion IN ('uebernommen', 'ignoriert')),
  erledigt_by TEXT,
  erledigt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS kleidung_importe (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  zeilen        INTEGER,
  uebernommen   INTEGER,
  importiert_by TEXT,
  importiert_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Grund-Dienstarten (Themen und Personen kommen über den Admin bzw. die Migration)
INSERT OR IGNORE INTO dienstarten (name, kategorie, sort_order) VALUES ('Aus- und Fortbildung', 'uebung', 10);
INSERT OR IGNORE INTO dienstarten (name, kategorie, sort_order) VALUES ('Technischer Dienst', 'uebung', 20);
INSERT OR IGNORE INTO dienstarten (name, kategorie, sort_order) VALUES ('Sitzungen/Tagungen', 'dienst', 30);
INSERT OR IGNORE INTO dienstarten (name, kategorie, sort_order) VALUES ('Versammlungen', 'dienst', 40);
INSERT OR IGNORE INTO dienstarten (name, kategorie, sort_order) VALUES ('Veranstaltungen', 'sonstiges', 50);
INSERT OR IGNORE INTO dienstarten (name, kategorie, sort_order) VALUES ('Sonstiges', 'sonstiges', 60);

-- =====================================================================
-- Einsatzprotokoll (eigene App, im Template nicht enthalten). Die Tabellen
-- werden leer angelegt, weil die Anwesenheit sie in Abfragen mitliest.
-- =====================================================================

-- =====================================================================
-- Stammdaten: Fahrzeuge (mit konfigurierbaren Positionen je Fahrzeug)
-- =====================================================================
CREATE TABLE IF NOT EXISTS einsatz_fahrzeuge_stamm (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kennung     TEXT NOT NULL UNIQUE,            -- z.B. "3/43"
  name        TEXT NOT NULL,                    -- z.B. "LF 10"
  positionen  TEXT NOT NULL,                    -- JSON-Array, z.B. ["MA","GF","AF","AM","WF","WM","SF","SM","ME"]
  sort_order  INTEGER NOT NULL DEFAULT 100,
  aktiv       INTEGER NOT NULL DEFAULT 1,       -- 0 = ausgemustert/ausgeblendet
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fahrzeuge_sort ON einsatz_fahrzeuge_stamm(sort_order, name);

-- =====================================================================
-- Stammdaten: Nachbar-Feuerwehren
-- =====================================================================
CREATE TABLE IF NOT EXISTS einsatz_ffen_stamm (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kuerzel     TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- "WE", "NB", "TEC"
  name        TEXT NOT NULL,                          -- Name der Wehr
  sort_order  INTEGER NOT NULL DEFAULT 100,
  aktiv       INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ffen_sort ON einsatz_ffen_stamm(sort_order, name);

-- =====================================================================
-- Einsätze
-- =====================================================================
CREATE TABLE IF NOT EXISTS einsaetze (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  alarm_datum         TEXT NOT NULL,                    -- ISO yyyy-mm-dd
  alarm_uhrzeit       TEXT NOT NULL,                    -- HH:MM
  einsatzort          TEXT,
  einsatzgrund        TEXT,                              -- freitext, später ggf. dropdown
  einsatzleiter       TEXT,
  km_einsatzstelle    REAL,
  km_gesamt           REAL,
  erste_ff_id         INTEGER REFERENCES einsatz_ffen_stamm(id) ON DELETE SET NULL,
  notizen             TEXT,
  alarmierte_einheit  TEXT,                              -- vom Webhook gesetzt (unit)
  status              TEXT NOT NULL DEFAULT 'offen',   -- 'offen' | 'abgeschlossen'
  abgeschlossen_at    TEXT,
  abgeschlossen_by    TEXT,
  created_by          TEXT,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- siehe Kommentar bei attendance_sessions.migriert_quelle im Root-Schema
  migriert_quelle     TEXT
);

CREATE INDEX IF NOT EXISTS idx_einsaetze_datum ON einsaetze(alarm_datum DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_einsaetze_status ON einsaetze(status);

-- =====================================================================
-- FFen vor Ort (m:n Einsatz <-> Stamm-FFen)
-- =====================================================================
CREATE TABLE IF NOT EXISTS einsatz_ffen_vor_ort (
  einsatz_id  INTEGER NOT NULL REFERENCES einsaetze(id) ON DELETE CASCADE,
  ff_id       INTEGER NOT NULL REFERENCES einsatz_ffen_stamm(id) ON DELETE CASCADE,
  PRIMARY KEY (einsatz_id, ff_id)
);

CREATE INDEX IF NOT EXISTS idx_efvo_einsatz ON einsatz_ffen_vor_ort(einsatz_id);

-- =====================================================================
-- Eingesetzte Fahrzeuge pro Einsatz + Einsatzende-Zeitstempel
-- =====================================================================
CREATE TABLE IF NOT EXISTS einsatz_fahrzeuge (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  einsatz_id     INTEGER NOT NULL REFERENCES einsaetze(id) ON DELETE CASCADE,
  fahrzeug_id    INTEGER NOT NULL REFERENCES einsatz_fahrzeuge_stamm(id) ON DELETE RESTRICT,
  ende_datum     TEXT,                                 -- ISO yyyy-mm-dd
  ende_uhrzeit   TEXT,                                 -- HH:MM
  UNIQUE (einsatz_id, fahrzeug_id)
);

CREATE INDEX IF NOT EXISTS idx_ef_einsatz ON einsatz_fahrzeuge(einsatz_id);

-- =====================================================================
-- Besatzung je Fahrzeug-Einsatz (Position -> Person)
-- =====================================================================
CREATE TABLE IF NOT EXISTS einsatz_besatzung (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  einsatz_fahrzeug_id      INTEGER NOT NULL REFERENCES einsatz_fahrzeuge(id) ON DELETE CASCADE,
  position                 TEXT NOT NULL,              -- "MA", "GF", "AF", ... oder "3","4",...
  person_nachname          TEXT,
  person_vorname           TEXT,
  -- siehe Kommentar bei attendance_entries.person_id im Root-Schema
  person_id                INTEGER REFERENCES personen(id) ON DELETE SET NULL,
  UNIQUE (einsatz_fahrzeug_id, position)
);

CREATE INDEX IF NOT EXISTS idx_eb_person ON einsatz_besatzung(person_id);

CREATE INDEX IF NOT EXISTS idx_eb_ef ON einsatz_besatzung(einsatz_fahrzeug_id);

-- =====================================================================
-- PA-Einsatz (Atemschutz pro Einsatz)
-- =====================================================================
CREATE TABLE IF NOT EXISTS einsatz_pa (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  einsatz_id      INTEGER NOT NULL REFERENCES einsaetze(id) ON DELETE CASCADE,
  person_nachname TEXT NOT NULL,
  person_vorname  TEXT NOT NULL,
  dauer_minuten   INTEGER,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  person_id       INTEGER REFERENCES personen(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_pa_person ON einsatz_pa(person_id);

CREATE INDEX IF NOT EXISTS idx_pa_einsatz ON einsatz_pa(einsatz_id);

-- =====================================================================
-- Amtliche Kennzeichen der Verunfallten
-- =====================================================================
CREATE TABLE IF NOT EXISTS einsatz_verunfallte (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  einsatz_id   INTEGER NOT NULL REFERENCES einsaetze(id) ON DELETE CASCADE,
  kennzeichen  TEXT NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_verunfallte_einsatz ON einsatz_verunfallte(einsatz_id);

-- =====================================================================
-- Ausgehende Webhooks: werden nach dem Anlegen eines Einsatzes der Reihe
-- nach aufgerufen (Fan-out, da aPager PRO nur ein Ziel ansteuern kann).
-- =====================================================================
CREATE TABLE IF NOT EXISTS einsatz_webhooks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,                   -- darf {keyword} {unit} {id} {datum} {uhrzeit} enthalten
  aktiv       INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 100,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by  TEXT,
  last_status TEXT,
  last_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_einsatz_webhooks_reihenfolge
  ON einsatz_webhooks(aktiv, sort_order, id);
