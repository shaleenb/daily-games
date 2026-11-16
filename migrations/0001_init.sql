-- Daily Games Hub — D1 / SQLite multi-user schema

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);

CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  url TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '🎮',
  color TEXT NOT NULL DEFAULT '#6366f1',
  category TEXT NOT NULL DEFAULT 'Daily',
  metric_label TEXT NOT NULL DEFAULT 'Score',
  metric_format TEXT NOT NULL DEFAULT 'number',
  metric_direction TEXT NOT NULL DEFAULT 'higher_is_better',
  parser_id TEXT NOT NULL DEFAULT 'auto',
  reset_timezone TEXT NOT NULL DEFAULT 'local',
  reset_time TEXT NOT NULL DEFAULT '00:00',
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_games_user_order ON games(user_id, sort_order, id);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  play_date TEXT NOT NULL,
  raw_text TEXT NOT NULL DEFAULT '',
  parser_id TEXT NOT NULL DEFAULT 'generic',
  parser_version INTEGER NOT NULL DEFAULT 1,
  completed INTEGER NOT NULL DEFAULT 1,
  solved INTEGER,
  primary_value REAL,
  display_value TEXT,
  puzzle_id TEXT,
  breakdown_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  notes TEXT NOT NULL DEFAULT '',
  manual_override INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(game_id, play_date)
);

CREATE INDEX IF NOT EXISTS idx_entries_play_date ON entries(play_date);
CREATE INDEX IF NOT EXISTS idx_entries_game_date ON entries(game_id, play_date);
CREATE INDEX IF NOT EXISTS idx_entries_user_date ON entries(user_id, play_date);
