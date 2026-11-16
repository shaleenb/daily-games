-- Daily Games Hub — Shared Hub Game Catalog

CREATE TABLE IF NOT EXISTS game_catalog (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
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
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
