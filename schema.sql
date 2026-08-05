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
  bemerkung   TEXT
);

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
