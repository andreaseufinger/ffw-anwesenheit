-- D1 Schema für Anwesenheit Ausbildungsabend (Template / öffentliche Version)
-- Identisch zur produktiven Variante, aber mit generischem Standard-Admin.
PRAGMA foreign_keys = ON;

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
  -- Herkunft nachgetragener Termine, z. B. ein Export aus dem Dienstbuch der
  -- Wehrführung. NULL = in der App erfasst, der Normalfall. TEXT und kein
  -- Ja/Nein, damit ein Import vom nächsten unterscheidbar und über
  -- "WHERE migriert_quelle = ..." wieder zurücknehmbar ist.
  migriert_quelle TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_datum ON attendance_sessions(datum DESC);

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

CREATE TABLE IF NOT EXISTS tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort_order  INTEGER NOT NULL DEFAULT 100,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tags_sort ON tags(sort_order, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS attendance_entry_tags (
  entry_id  INTEGER NOT NULL REFERENCES attendance_entries(id) ON DELETE CASCADE,
  tag_id    INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_entry_tags_entry ON attendance_entry_tags(entry_id);
CREATE INDEX IF NOT EXISTS idx_entry_tags_tag ON attendance_entry_tags(tag_id);

INSERT OR IGNORE INTO tags (name, sort_order) VALUES
  ('Atemschutz - Einsatzübung', 10),
  ('Atemschutz - Theorie', 20),
  ('Führerscheinkontrolle', 30);

-- Benutzer (Login)
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT NOT NULL,                -- PBKDF2-SHA256, 100k Iter, 32 Bytes hex
  password_salt  TEXT NOT NULL,                -- 16 Bytes hex
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- App-Rollen pro Benutzer (n:m)
CREATE TABLE IF NOT EXISTS user_roles (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     TEXT NOT NULL CHECK (role IN (
    'admin_anwesenheit',
    'admin_einsatzprotokoll',
    'erfasser_anwesenheit',
    'erfasser_einsatzprotokoll'
  )),
  PRIMARY KEY (user_id, role)
);

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
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- =====================================================================
-- Stammdaten: Personen, Dienstarten, Themen
--
-- Werden im Admin-Bereich der App gepflegt (Menü -> Personen verwalten /
-- Themen verwalten), nicht mehr über Dateien im Repo. Die Personenliste
-- gilt auch für die Schwester-App Einsatzprotokoll.
--
-- Ausgetretene werden auf aktiv = 0 gesetzt, nicht gelöscht: sie
-- verschwinden aus den Auswahllisten, bleiben aber in Auswertungen
-- vergangener Jahre erhalten.
--
-- dienstarten.kategorie entscheidet, was in der Auswertung als Übung
-- zählt — Sitzungen und Veranstaltungen sollen dort nicht mitgerechnet
-- werden.
-- =====================================================================
CREATE TABLE IF NOT EXISTS personen (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  nachname   TEXT NOT NULL,
  vorname    TEXT NOT NULL,
  aktiv      INTEGER NOT NULL DEFAULT 1,
  eintritt   TEXT,
  austritt   TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (nachname, vorname)
);

CREATE INDEX IF NOT EXISTS idx_personen_sort ON personen(aktiv DESC, nachname COLLATE NOCASE, vorname COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS dienstarten (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kategorie  TEXT NOT NULL DEFAULT 'sonstiges'
               CHECK (kategorie IN ('uebung','dienst','sonstiges')),
  sort_order INTEGER NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS themen (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  dienstart_id INTEGER NOT NULL REFERENCES dienstarten(id) ON DELETE RESTRICT,
  thema        TEXT NOT NULL,
  abteilung    TEXT,
  prioritaet   INTEGER NOT NULL DEFAULT 1,
  aktiv        INTEGER NOT NULL DEFAULT 1,
  UNIQUE (dienstart_id, thema)
);

CREATE INDEX IF NOT EXISTS idx_themen_dienstart ON themen(dienstart_id, prioritaet, thema COLLATE NOCASE);

-- Beispiel-Dienstarten
INSERT OR IGNORE INTO dienstarten (name, kategorie, sort_order) VALUES ('Aus- und Fortbildung', 'uebung', 10);
INSERT OR IGNORE INTO dienstarten (name, kategorie, sort_order) VALUES ('Technischer Dienst', 'uebung', 20);
INSERT OR IGNORE INTO dienstarten (name, kategorie, sort_order) VALUES ('Sitzungen/Tagungen', 'dienst', 30);
INSERT OR IGNORE INTO dienstarten (name, kategorie, sort_order) VALUES ('Versammlungen', 'dienst', 40);
INSERT OR IGNORE INTO dienstarten (name, kategorie, sort_order) VALUES ('Veranstaltungen', 'sonstiges', 50);
INSERT OR IGNORE INTO dienstarten (name, kategorie, sort_order) VALUES ('Sonstiges', 'sonstiges', 60);

-- Beispiel-Personen (im Admin ersetzen)
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Burns', 'Montgomery');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Carlson', 'Carl');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Duck', 'Dagobert');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Duck', 'Daisy');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Duck', 'Donald');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Düsentrieb', 'Daniel');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Flanders', 'Maude');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Flanders', 'Ned');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Gallier', 'Asterix');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Gallier', 'Automatix');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Gallier', 'Majestix');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Gallier', 'Miraculix');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Gallier', 'Obelix');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Gallier', 'Troubadix');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Gans', 'Gustav');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Gumble', 'Barney');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Krabappel', 'Edna');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Leonard', 'Lenny');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Muntz', 'Nelson');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Simpson', 'Bart');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Simpson', 'Homer');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Simpson', 'Lisa');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Simpson', 'Maggie');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Simpson', 'Marge');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Skinner', 'Seymour');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Smithers', 'Waylon');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Szyslak', 'Moe');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Van Houten', 'Milhouse');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Wiggum', 'Clancy');
INSERT OR IGNORE INTO personen (nachname, vorname) VALUES ('Wiggum', 'Ralph');

-- Beispiel-Themen (im Admin ergänzen)
INSERT OR IGNORE INTO themen (dienstart_id, thema, abteilung, prioritaet) SELECT id, 'FwDV 1-Grundtätigkeiten', 'Einsatzabteilung FF', 1 FROM dienstarten WHERE name = 'Aus- und Fortbildung';
INSERT OR IGNORE INTO themen (dienstart_id, thema, abteilung, prioritaet) SELECT id, 'FwDV 3-Löscheinsatz', 'Einsatzabteilung FF', 1 FROM dienstarten WHERE name = 'Aus- und Fortbildung';
INSERT OR IGNORE INTO themen (dienstart_id, thema, abteilung, prioritaet) SELECT id, 'FwDV 10-Die tragbaren Leitern', 'Einsatzabteilung FF', 1 FROM dienstarten WHERE name = 'Aus- und Fortbildung';
INSERT OR IGNORE INTO themen (dienstart_id, thema, abteilung, prioritaet) SELECT id, 'Erste Hilfe', 'Einsatzabteilung FF', 2 FROM dienstarten WHERE name = 'Aus- und Fortbildung';
INSERT OR IGNORE INTO themen (dienstart_id, thema, abteilung, prioritaet) SELECT id, 'Gerätepflege', 'Einsatzabteilung FF', 1 FROM dienstarten WHERE name = 'Technischer Dienst';
INSERT OR IGNORE INTO themen (dienstart_id, thema, abteilung, prioritaet) SELECT id, 'Vorstandssitzung', NULL, 1 FROM dienstarten WHERE name = 'Sitzungen/Tagungen';
INSERT OR IGNORE INTO themen (dienstart_id, thema, abteilung, prioritaet) SELECT id, 'Jahreshauptversammlung', NULL, 1 FROM dienstarten WHERE name = 'Versammlungen';
INSERT OR IGNORE INTO themen (dienstart_id, thema, abteilung, prioritaet) SELECT id, 'Tag der offenen Tür', NULL, 1 FROM dienstarten WHERE name = 'Veranstaltungen';
INSERT OR IGNORE INTO themen (dienstart_id, thema, abteilung, prioritaet) SELECT id, 'Sonstiges', NULL, 9 FROM dienstarten WHERE name = 'Sonstiges';

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
  -- Mitglied.
  rolle_id     INTEGER REFERENCES personen_rollen(id) ON DELETE SET NULL,
  PRIMARY KEY (person_id, abteilung_id)
);

CREATE INDEX IF NOT EXISTS idx_personen_abt ON personen_abteilungen(abteilung_id, person_id);

-- Für welche Abteilungen ein Benutzer erfassen bzw. als Abteilungsadmin
-- wirken darf. Leer = keine. admin_anwesenheit ist übergreifend und braucht
-- hier keinen Eintrag.
CREATE TABLE IF NOT EXISTS user_abteilungen (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  abteilung_id INTEGER NOT NULL REFERENCES abteilungen(id) ON DELETE RESTRICT,
  PRIMARY KEY (user_id, abteilung_id)
);

CREATE INDEX IF NOT EXISTS idx_user_abt ON user_abteilungen(abteilung_id, user_id);

-- Zusätzlich zum UNIQUE (nachname, vorname): fängt auch Namen, die sich nur
-- in der Groß-/Kleinschreibung unterscheiden. Schreibvarianten wie "Schuetz"
-- statt "Schütz" kann kein Index fangen — das prüft die API.
CREATE UNIQUE INDEX IF NOT EXISTS idx_personen_name_nocase ON personen(nachname COLLATE NOCASE, vorname COLLATE NOCASE);
