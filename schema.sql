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
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  person_id   INTEGER REFERENCES personen(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_attendance_entries_person ON attendance_entries(person_id);

CREATE INDEX IF NOT EXISTS idx_entries_session ON attendance_entries(session_id);

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
