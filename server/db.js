import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { STARTER_GAMES, normalizeEmail } from '../shared/auth-crypto.js';
import {
  GENERIC_PARSER,
  PERCEPTLE_ROUNDS,
  normalizeDifficultyLabel,
  getParserById,
  getParserForGame,
  parseForGame,
  slugify,
  formatMetricValue,
  isValidResetTimezone,
  isValidResetTime,
  getGamePuzzleStatus,
} from '../shared/parsers/registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, 'data', 'daily-games.db');

export const VALID_METRIC_FORMATS = new Set(['number', 'duration_sec', 'percent', 'fraction']);
export const VALID_METRIC_DIRECTIONS = new Set(['higher_is_better', 'lower_is_better']);
const STARTER_SLUG_SET = new Set(STARTER_GAMES.map((g) => g.slug));

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

export class UnauthorizedError extends Error {
  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'UnauthorizedError';
    this.statusCode = 401;
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
    this.statusCode = 403;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.statusCode = 404;
  }
}

export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.statusCode = 409;
  }
}

export function serializeResolvedParser(parser) {
  const p = parser || GENERIC_PARSER;
  const id = typeof p.id === 'string' && p.id ? p.id : 'generic';
  const isCustomParser = typeof p.isCustomParser === 'boolean' ? p.isCustomParser : id !== 'generic';
  const name = typeof p.name === 'string' && p.name ? p.name : (id === 'generic' ? 'Generic Tracker' : id);
  const version = Number.isInteger(p.version) && p.version >= 1 ? p.version : 1;
  return { id, name, version, isCustomParser };
}

const PERCEPTLE_ROUND_BY_KEY = new Map(PERCEPTLE_ROUNDS.map((r) => [r.key, r]));
const PERCEPTLE_ROUND_BY_NAME = new Map(
  PERCEPTLE_ROUNDS.map((r) => [r.name.toLowerCase(), r]),
);
const PERCEPTLE_ROUND_BY_ICON = new Map(
  PERCEPTLE_ROUNDS.map((r) => [r.icon.replace(/\uFE0F/g, ''), r]),
);

function formatBreakdownDisplay(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

export function sanitizeBreakdownArray(raw) {
  if (!Array.isArray(raw)) {
    throw new ValidationError('breakdown must be an array');
  }

  return raw.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ValidationError('breakdown items must contain finite numeric values');
    }
    if (
      item.value === undefined ||
      item.value === null ||
      item.value === '' ||
      typeof item.value === 'boolean' ||
      !Number.isFinite(Number(item.value))
    ) {
      throw new ValidationError('breakdown items must contain finite numeric values');
    }
    const value = Number(item.value);

    const rawKey = typeof item.key === 'string' && item.key.trim() ? item.key.trim() : null;
    const rawIcon = typeof item.icon === 'string' && item.icon.trim() ? item.icon.trim() : null;
    const rawName = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : null;
    const matched =
      (rawKey && PERCEPTLE_ROUND_BY_KEY.get(rawKey)) ||
      (rawIcon && PERCEPTLE_ROUND_BY_ICON.get(rawIcon.replace(/\uFE0F/g, ''))) ||
      (rawName && PERCEPTLE_ROUND_BY_NAME.get(rawName.toLowerCase())) ||
      null;

    const key = rawKey || matched?.key || null;
    const icon = rawIcon || matched?.icon || null;
    const name = rawName || matched?.name || null;

    let label = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : '';
    if (!label) {
      if (icon && name) label = `${icon} ${name}`;
      else if (name) label = name;
      else if (key) label = key;
      else label = `Round ${idx + 1}`;
    }

    let max = null;
    if (item.max !== undefined && item.max !== null && item.max !== '') {
      if (typeof item.max === 'boolean' || !Number.isFinite(Number(item.max)) || Number(item.max) < 0) {
        throw new ValidationError('breakdown item max must be a non-negative finite number');
      }
      max = Number(item.max);
    } else if (matched) {
      max = matched.max;
    }

    const display =
      item.display !== undefined &&
      item.display !== null &&
      String(item.display).trim() !== ''
        ? String(item.display).trim()
        : formatBreakdownDisplay(value);

    return {
      ...(key ? { key } : {}),
      ...(icon ? { icon } : {}),
      ...(name ? { name } : {}),
      label,
      value,
      ...(max !== null ? { max } : {}),
      display,
    };
  });
}

export function isValidYmd(str) {
  if (typeof str !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(year, month - 1, day, 12, 0, 0, 0);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

export function normalizeUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    throw new ValidationError('URL is required');
  }
  let trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new ValidationError('URL is required');
  }
  if (trimmed.startsWith('//')) {
    trimmed = `https:${trimmed}`;
  } else if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ValidationError(`Invalid URL: ${rawUrl}`);
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
    throw new ValidationError(`URL must use http or https: ${rawUrl}`);
  }
  return parsed.toString().replace(/\/$/, trimmed.endsWith('/') ? '/' : '');
}

const IGNORED_CANONICAL_HOSTS = new Set(['example.com', 'localhost', '127.0.0.1']);

export function canonicalUrlKey(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  let trimmed = rawUrl.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('//')) {
    trimmed = `https:${trimmed}`;
  } else if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
    return null;
  }
  const hostNoWww = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!hostNoWww || IGNORED_CANONICAL_HOSTS.has(hostNoWww)) {
    return null;
  }
  const pathNoTrailing = parsed.pathname.replace(/\/+$/, '').toLowerCase();
  return `${hostNoWww}${pathNoTrailing}`;
}

function sqlBool(val) {
  return val ? 1 : 0;
}

function sqlNullableBool(val) {
  if (val === null || val === undefined) return null;
  return val ? 1 : 0;
}

function safeJsonParse(str, fallback) {
  if (typeof str !== 'string' || !str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function parsePositiveInt(value, label = 'id') {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new ValidationError(`Invalid ${label}`);
  }
  return num;
}

function mapUserRow(rawRow) {
  if (!rawRow) return null;
  const r = { ...rawRow };
  return {
    id: Number(r.id),
    email: String(r.email),
    displayName: String(r.display_name),
    createdAt: String(r.created_at),
  };
}

function mapGameRow(rawRow) {
  if (!rawRow) return null;
  const r = { ...rawRow };
  const base = {
    id: Number(r.id),
    userId: r.user_id === null || r.user_id === undefined ? null : Number(r.user_id),
    name: String(r.name),
    slug: String(r.slug),
    url: String(r.url),
    icon: String(r.icon),
    color: String(r.color),
    category: String(r.category),
    metricLabel: String(r.metric_label),
    metricFormat: String(r.metric_format),
    metricDirection: String(r.metric_direction),
    parserId: String(r.parser_id),
    resetTimezone: String(r.reset_timezone ?? 'local'),
    resetTime: String(r.reset_time ?? '00:00'),
    sortOrder: Number(r.sort_order),
    archived: Boolean(r.archived),
    createdAt: String(r.created_at),
  };
  const resolved = serializeResolvedParser(getParserForGame(base));
  return {
    ...base,
    resolvedParser: resolved,
  };
}

function mapEntryRow(rawRow) {
  if (!rawRow) return null;
  const r = { ...rawRow };
  const metadata = safeJsonParse(r.metadata_json, {});
  const difficulty = normalizeDifficultyLabel(metadata?.difficulty) || null;
  return {
    id: Number(r.id),
    userId: r.user_id === null || r.user_id === undefined ? null : Number(r.user_id),
    gameId: Number(r.game_id),
    playDate: String(r.play_date),
    rawText: String(r.raw_text ?? ''),
    parserId: String(r.parser_id ?? 'generic'),
    parserVersion: Number(r.parser_version ?? 1),
    completed: Boolean(r.completed),
    solved: r.solved === null || r.solved === undefined ? null : Boolean(r.solved),
    primaryValue:
      r.primary_value === null || r.primary_value === undefined ? null : Number(r.primary_value),
    displayValue: r.display_value === undefined ? null : r.display_value,
    puzzleId: r.puzzle_id === undefined ? null : r.puzzle_id,
    breakdown: safeJsonParse(r.breakdown_json, []),
    metadata,
    difficulty,
    notes: String(r.notes ?? ''),
    manualOverride: Boolean(r.manual_override),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function createDatabase({ dbPath = DEFAULT_DB_PATH } = {}) {
  const isMemory = dbPath === ':memory:' || String(dbPath).startsWith('file::memory:');
  if (!isMemory) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec('PRAGMA foreign_keys = ON;');
  if (!isMemory) {
    try {
      sqlite.exec('PRAGMA journal_mode = WAL;');
    } catch {
      // Ignore if environment does not support WAL
    }
  }

  sqlite.exec(`
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
  `);

  const WAVE_APPEND_STARTER_SLUGS = new Set([
    'pricepoint',
    'fermi',
    'magnitudle',
    'plain',
    'timeguessr',
  ]);
  const UPGRADE_PARSER_STARTER_SLUGS = new Set([
    'cluesbysam',
    'perceptle',
    'plain',
    'timeguessr',
  ]);
  const BACKFILL_TIMEZONE_SLUGS = new Set(['cluesbysam', 'krillion', 'farflung', 'perceptle']);

  function syncStarterGamesForUser(userId, { appendSlugs = WAVE_APPEND_STARTER_SLUGS } = {}) {
    const isUnclaimed = userId === null || userId === undefined;
    const selectSql = isUnclaimed
      ? 'SELECT id, parser_id, reset_timezone, reset_time FROM games WHERE user_id IS NULL AND slug = ?'
      : 'SELECT id, parser_id, reset_timezone, reset_time FROM games WHERE user_id = ? AND slug = ?';
    const maxSql = isUnclaimed
      ? 'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM games WHERE user_id IS NULL'
      : 'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM games WHERE user_id = ?';

    const existingBySlugStmt = sqlite.prepare(selectSql);
    const updateTzStmt = sqlite.prepare(
      'UPDATE games SET reset_timezone = ?, reset_time = ? WHERE id = ?',
    );
    const upgradeParserStmt = sqlite.prepare(
      "UPDATE games SET parser_id = ? WHERE id = ? AND parser_id = 'auto'",
    );
    const insertStmt = sqlite.prepare(`
      INSERT INTO games (
        user_id, name, slug, url, icon, color, category,
        metric_label, metric_format, metric_direction,
        parser_id, reset_timezone, reset_time, sort_order, archived, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();

    for (const g of STARTER_GAMES) {
      const existing = isUnclaimed
        ? existingBySlugStmt.get(g.slug)
        : existingBySlugStmt.get(userId, g.slug);

      if (existing) {
        if (
          BACKFILL_TIMEZONE_SLUGS.has(g.slug) &&
          existing.reset_timezone === 'local' &&
          g.resetTimezone !== 'local'
        ) {
          const nextTime =
            !existing.reset_time || existing.reset_time === '00:00'
              ? g.resetTime
              : existing.reset_time;
          updateTzStmt.run(g.resetTimezone, nextTime, existing.id);
        }
        if (
          UPGRADE_PARSER_STARTER_SLUGS.has(g.slug) &&
          existing.parser_id === 'auto' &&
          g.parserId !== 'auto'
        ) {
          upgradeParserStmt.run(g.parserId, existing.id);
        }
      } else if (appendSlugs.has(g.slug)) {
        const maxRow = isUnclaimed
          ? sqlite.prepare(maxSql).get()
          : sqlite.prepare(maxSql).get(userId);
        const sortOrder = Math.max(Number(maxRow.max_order) + 1, g.sortOrder);
        insertStmt.run(
          isUnclaimed ? null : userId,
          g.name,
          g.slug,
          g.url,
          g.icon,
          g.color,
          g.category,
          g.metricLabel,
          g.metricFormat,
          g.metricDirection,
          g.parserId,
          g.resetTimezone,
          g.resetTime,
          sortOrder,
          0,
          now,
        );
      }
    }
  }

  function backfillCluesBySamEntries() {
    const rows = sqlite
      .prepare(`
        SELECT
          e.id, e.raw_text, e.metadata_json, e.play_date,
          g.slug AS game_slug, g.name AS game_name, g.url AS game_url
        FROM entries e
        JOIN games g ON g.id = e.game_id
        WHERE (g.slug = 'cluesbysam' OR g.parser_id = 'cluesbysam')
          AND TRIM(e.raw_text) != ''
      `)
      .all();

    if (rows.length === 0) return 0;

    const gridMetricKeys = [
      'seconds',
      'emojiGrid',
      'grid',
      'gridRows',
      'gridCols',
      'cleanCount',
      'greenCount',
      'yellowCount',
      'hintCount',
    ];
    const updateMetaStmt = sqlite.prepare('UPDATE entries SET metadata_json = ? WHERE id = ?');
    let updated = 0;

    sqlite.exec('BEGIN IMMEDIATE;');
    try {
      for (const rawRow of rows) {
        const r = { ...rawRow };
        const existingMeta = safeJsonParse(r.metadata_json, {});
        if (existingMeta?.difficultyOverride) continue;

        const hasDifficulty = Boolean(normalizeDifficultyLabel(existingMeta?.difficulty));
        const hasGridMetrics =
          existingMeta?.grid !== undefined || existingMeta?.cleanCount !== undefined;
        if (hasDifficulty && hasGridMetrics) continue;

        const cluesParser = getParserById('cluesbysam');
        const parsed = cluesParser
          ? cluesParser.parse(
              String(r.raw_text ?? ''),
              {
                slug: String(r.game_slug || 'cluesbysam'),
                name: String(r.game_name || 'Clues by Sam'),
                url: String(r.game_url || 'https://cluesbysam.com'),
              },
              String(r.play_date || ''),
            )
          : parseForGame(String(r.raw_text ?? ''), {
              slug: String(r.game_slug || 'cluesbysam'),
              name: String(r.game_name || 'Clues by Sam'),
              url: String(r.game_url || 'https://cluesbysam.com'),
              parserId: 'cluesbysam',
            });
        const parsedMeta = parsed?.metadata;
        if (!parsedMeta || typeof parsedMeta !== 'object') continue;

        const merged = { ...existingMeta };
        let changed = false;

        if (!hasDifficulty) {
          const parsedDiff = normalizeDifficultyLabel(parsedMeta.difficulty);
          if (parsedDiff) {
            merged.difficulty = parsedDiff;
            changed = true;
          }
        }

        for (const key of gridMetricKeys) {
          if (merged[key] === undefined && parsedMeta[key] !== undefined && parsedMeta[key] !== null) {
            merged[key] = parsedMeta[key];
            changed = true;
          }
        }

        if (changed) {
          updateMetaStmt.run(JSON.stringify(merged), Number(r.id));
          updated += 1;
        }
      }
      sqlite.exec('COMMIT;');
    } catch (err) {
      try {
        sqlite.exec('ROLLBACK;');
      } catch {
        // ignore rollback failure
      }
      throw err;
    }

    return updated;
  }

  function backfillPerceptleEntries() {
    const rows = sqlite
      .prepare(`
        SELECT
          e.id, e.raw_text, e.parser_id, e.parser_version,
          e.primary_value, e.display_value, e.puzzle_id,
          e.breakdown_json, e.metadata_json, e.manual_override,
          g.slug AS game_slug, g.name AS game_name, g.url AS game_url
        FROM entries e
        JOIN games g ON g.id = e.game_id
        WHERE (g.slug = 'perceptle' OR g.parser_id = 'perceptle')
          AND TRIM(e.raw_text) != ''
      `)
      .all();

    if (rows.length === 0) return 0;

    const perceptleParser = getParserById('perceptle');
    const updateEntryStmt = sqlite.prepare(`
      UPDATE entries SET
        parser_id = ?, parser_version = ?,
        primary_value = ?, display_value = ?, puzzle_id = ?,
        breakdown_json = ?, metadata_json = ?
      WHERE id = ?
    `);
    let updated = 0;

    sqlite.exec('BEGIN IMMEDIATE;');
    try {
      for (const rawRow of rows) {
        const r = { ...rawRow };
        const existingBreakdown = safeJsonParse(r.breakdown_json, []);
        if (Array.isArray(existingBreakdown) && existingBreakdown.length > 0) continue;

        const gameCtx = {
          slug: String(r.game_slug || 'perceptle'),
          name: String(r.game_name || 'Perceptle'),
          url: String(r.game_url || 'https://perceptle.com'),
          parserId: 'perceptle',
        };
        const parsed = perceptleParser
          ? perceptleParser.parse(String(r.raw_text ?? ''), gameCtx)
          : parseForGame(String(r.raw_text ?? ''), gameCtx);

        const parsedBreakdown = Array.isArray(parsed?.breakdown) ? parsed.breakdown : [];
        const parsedMeta = parsed?.metadata && typeof parsed.metadata === 'object' ? parsed.metadata : {};
        const hasRoundScores =
          parsedMeta.roundScores &&
          typeof parsedMeta.roundScores === 'object' &&
          Object.keys(parsedMeta.roundScores).length > 0;
        const hasPerceptleData =
          parsedBreakdown.length > 0 || Boolean(parsedMeta.grade) || hasRoundScores;
        if (!hasPerceptleData) continue;

        const existingMeta = safeJsonParse(r.metadata_json, {});
        const mergedMeta =
          existingMeta && typeof existingMeta === 'object' && !Array.isArray(existingMeta)
            ? { ...existingMeta }
            : {};
        for (const key of ['grade', 'maxScore', 'roundScores', 'emojiGrid']) {
          if (mergedMeta[key] === undefined && parsedMeta[key] !== undefined && parsedMeta[key] !== null) {
            mergedMeta[key] = parsedMeta[key];
          }
        }

        const isManual = Boolean(r.manual_override);
        let nextPrimaryValue =
          r.primary_value === null || r.primary_value === undefined ? null : Number(r.primary_value);
        let nextDisplayValue = r.display_value ?? null;
        let nextPuzzleId = r.puzzle_id ?? null;

        if (!isManual) {
          if (nextPrimaryValue === null && parsed.primaryValue !== null && parsed.primaryValue !== undefined) {
            nextPrimaryValue = Number(parsed.primaryValue);
          }
          if (parsed.displayValue) {
            nextDisplayValue = String(parsed.displayValue);
          }
          if (!nextPuzzleId && parsed.puzzleId) {
            nextPuzzleId = String(parsed.puzzleId);
          }
        }

        updateEntryStmt.run(
          String(parsed.parserId || 'perceptle'),
          Number(parsed.parserVersion || 1),
          nextPrimaryValue,
          nextDisplayValue,
          nextPuzzleId,
          JSON.stringify(parsedBreakdown),
          JSON.stringify(mergedMeta),
          Number(r.id),
        );
        updated += 1;
      }
      sqlite.exec('COMMIT;');
    } catch (err) {
      try {
        sqlite.exec('ROLLBACK;');
      } catch {
        // ignore rollback failure
      }
      throw err;
    }

    return updated;
  }

  function migrateLegacySchema() {
    const gameCols = new Set(
      sqlite.prepare('PRAGMA table_info(games)').all().map((c) => c.name),
    );
    if (!gameCols.has('reset_timezone')) {
      sqlite.exec("ALTER TABLE games ADD COLUMN reset_timezone TEXT NOT NULL DEFAULT 'local';");
    }
    if (!gameCols.has('reset_time')) {
      sqlite.exec("ALTER TABLE games ADD COLUMN reset_time TEXT NOT NULL DEFAULT '00:00';");
    }

    const refreshedGameCols = new Set(
      sqlite.prepare('PRAGMA table_info(games)').all().map((c) => c.name),
    );
    const entryCols = new Set(
      sqlite.prepare('PRAGMA table_info(entries)').all().map((c) => c.name),
    );

    const needsUserColumnRebuild =
      !refreshedGameCols.has('user_id') || !entryCols.has('user_id');

    if (needsUserColumnRebuild) {
      const hasGameUserId = refreshedGameCols.has('user_id');
      const hasEntryUserId = entryCols.has('user_id');

      sqlite.exec('PRAGMA foreign_keys = OFF;');
      sqlite.exec('BEGIN IMMEDIATE;');
      try {
        sqlite.exec(`
          CREATE TABLE games_new (
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

          INSERT INTO games_new (
            id, user_id, name, slug, url, icon, color, category,
            metric_label, metric_format, metric_direction,
            parser_id, reset_timezone, reset_time, sort_order, archived, created_at
          )
          SELECT
            id, ${hasGameUserId ? 'user_id' : 'NULL'}, name, slug, url, icon, color, category,
            metric_label, metric_format, metric_direction,
            parser_id, reset_timezone, reset_time, sort_order, archived, created_at
          FROM games;

          CREATE TABLE entries_new (
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

          INSERT INTO entries_new (
            id, user_id, game_id, play_date, raw_text, parser_id, parser_version,
            completed, solved, primary_value, display_value, puzzle_id,
            breakdown_json, metadata_json, notes, manual_override, created_at, updated_at
          )
          SELECT
            id, ${hasEntryUserId ? 'user_id' : 'NULL'}, game_id, play_date, raw_text, parser_id, parser_version,
            completed, solved, primary_value, display_value, puzzle_id,
            breakdown_json, metadata_json, notes, manual_override, created_at, updated_at
          FROM entries;

          DROP TABLE entries;
          DROP TABLE games;
          ALTER TABLE games_new RENAME TO games;
          ALTER TABLE entries_new RENAME TO entries;
        `);
        sqlite.exec('COMMIT;');
      } catch (err) {
        sqlite.exec('ROLLBACK;');
        sqlite.exec('PRAGMA foreign_keys = ON;');
        throw err;
      }
      sqlite.exec('PRAGMA foreign_keys = ON;');
    }

    sqlite.exec(`
      CREATE INDEX IF NOT EXISTS idx_games_user_order ON games(user_id, sort_order, id);
      CREATE INDEX IF NOT EXISTS idx_entries_play_date ON entries(play_date);
      CREATE INDEX IF NOT EXISTS idx_entries_game_date ON entries(game_id, play_date);
      CREATE INDEX IF NOT EXISTS idx_entries_user_date ON entries(user_id, play_date);
    `);

    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

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
    `);

    const now = new Date().toISOString();
    const hasMigrationStmt = sqlite.prepare('SELECT 1 AS applied FROM schema_migrations WHERE id = ?');
    const markMigrationStmt = sqlite.prepare(
      'INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)',
    );

    const unclaimedRow = sqlite
      .prepare('SELECT COUNT(*) AS count FROM games WHERE user_id IS NULL')
      .get();

    const wave2MigrationId = 'wave2_starters_and_cluesbysam_v1';
    if (!hasMigrationStmt.get(wave2MigrationId)) {
      if (Number(unclaimedRow.count) > 0) {
        syncStarterGamesForUser(null);
      }
      const existingUsers = sqlite.prepare('SELECT id FROM users ORDER BY id ASC').all();
      const userHasGamesStmt = sqlite.prepare('SELECT COUNT(*) AS count FROM games WHERE user_id = ?');
      for (const u of existingUsers) {
        const uid = Number(u.id);
        if (Number(userHasGamesStmt.get(uid).count) > 0) {
          syncStarterGamesForUser(uid);
        }
      }
      sqlite.exec(
        "UPDATE games SET parser_id = 'cluesbysam' WHERE slug = 'cluesbysam' AND parser_id = 'auto';",
      );
      markMigrationStmt.run(wave2MigrationId, now);
    }

    const seedCatalogStmt = sqlite.prepare(`
      INSERT OR IGNORE INTO game_catalog (
        slug, name, url, icon, color, category,
        metric_label, metric_format, metric_direction,
        parser_id, reset_timezone, reset_time,
        created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const g of STARTER_GAMES) {
      seedCatalogStmt.run(
        g.slug,
        g.name,
        g.url,
        g.icon,
        g.color,
        g.category,
        g.metricLabel,
        g.metricFormat,
        g.metricDirection,
        g.parserId,
        g.resetTimezone,
        g.resetTime,
        null,
        now,
        now,
      );
    }
    sqlite.exec(
      "UPDATE game_catalog SET parser_id = 'cluesbysam' WHERE slug = 'cluesbysam' AND parser_id = 'auto';",
    );
    sqlite.exec(
      "UPDATE game_catalog SET parser_id = 'perceptle' WHERE slug = 'perceptle' AND parser_id = 'auto';",
    );

    const existingGameRows = sqlite
      .prepare('SELECT * FROM games ORDER BY CASE WHEN user_id IS NOT NULL THEN 0 ELSE 1 END, id ASC')
      .all();
    for (const row of existingGameRows) {
      const r = { ...row };
      seedCatalogStmt.run(
        String(r.slug),
        String(r.name),
        String(r.url),
        String(r.icon),
        String(r.color),
        String(r.category),
        String(r.metric_label),
        String(r.metric_format),
        String(r.metric_direction),
        String(r.parser_id),
        String(r.reset_timezone ?? 'local'),
        String(r.reset_time ?? '00:00'),
        r.user_id === null || r.user_id === undefined ? null : Number(r.user_id),
        String(r.created_at || now),
        String(r.created_at || now),
      );
    }

    const backfillMigrationId = 'cluesbysam_difficulty_backfill_v1';
    if (!hasMigrationStmt.get(backfillMigrationId)) {
      backfillCluesBySamEntries();
      markMigrationStmt.run(backfillMigrationId, now);
    }

    const perceptleMigrationId = 'perceptle_parser_and_backfill_v1';
    if (!hasMigrationStmt.get(perceptleMigrationId)) {
      sqlite.exec(
        "UPDATE games SET parser_id = 'perceptle' WHERE slug = 'perceptle' AND parser_id = 'auto';",
      );
      sqlite.exec(
        "UPDATE game_catalog SET parser_id = 'perceptle' WHERE slug = 'perceptle' AND parser_id = 'auto';",
      );
      backfillPerceptleEntries();
      markMigrationStmt.run(perceptleMigrationId, now);
    }
  }

  migrateLegacySchema();

  function insertStarterGamesForUser(userId) {
    const now = new Date().toISOString();
    const insertStmt = sqlite.prepare(`
      INSERT INTO games (
        user_id, name, slug, url, icon, color, category,
        metric_label, metric_format, metric_direction,
        parser_id, reset_timezone, reset_time, sort_order, archived, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const g of STARTER_GAMES) {
      insertStmt.run(
        userId,
        g.name,
        g.slug,
        g.url,
        g.icon,
        g.color,
        g.category,
        g.metricLabel,
        g.metricFormat,
        g.metricDirection,
        g.parserId,
        g.resetTimezone,
        g.resetTime,
        g.sortOrder,
        0,
        now,
      );
    }
  }

  function seedStarterGamesForUser(userId) {
    const uid = parsePositiveInt(userId, 'userId');
    const unclaimedCount = Number(
      sqlite.prepare('SELECT COUNT(*) AS count FROM games WHERE user_id IS NULL').get().count,
    );

    if (unclaimedCount > 0) {
      sqlite.prepare('UPDATE games SET user_id = ? WHERE user_id IS NULL').run(uid);
      sqlite.prepare('UPDATE entries SET user_id = ? WHERE user_id IS NULL').run(uid);
      syncStarterGamesForUser(uid, { appendSlugs: new Set() });
      return;
    }

    const userGamesCount = Number(
      sqlite.prepare('SELECT COUNT(*) AS count FROM games WHERE user_id = ?').get(uid).count,
    );
    if (userGamesCount === 0) {
      insertStarterGamesForUser(uid);
    }
  }

  function registerUser({ name, email, passwordHash, passwordSalt }) {
    const normalized = normalizeEmail(email);
    if (!normalized) {
      throw new ValidationError('Valid email is required');
    }
    const displayName = typeof name === 'string' ? name.trim() : '';
    if (!displayName) {
      throw new ValidationError('Display name is required');
    }
    if (!passwordHash || !passwordSalt) {
      throw new ValidationError('Password hash and salt are required');
    }

    const now = new Date().toISOString();
    sqlite.exec('BEGIN IMMEDIATE;');
    try {
      const res = sqlite
        .prepare(`
          INSERT INTO users (email, display_name, password_hash, password_salt, created_at)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(normalized, displayName, String(passwordHash), String(passwordSalt), now);

      const userId = Number(res.lastInsertRowid);
      seedStarterGamesForUser(userId);
      sqlite.exec('COMMIT;');

      return getUserById(userId);
    } catch (err) {
      try {
        sqlite.exec('ROLLBACK;');
      } catch {
        // ignore
      }
      if (String(err?.message || '').toLowerCase().includes('unique')) {
        throw new ConflictError('An account with this email already exists');
      }
      throw err;
    }
  }

  function getUserByEmail(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const row = sqlite
      .prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE')
      .get(normalized);
    if (!row) return null;
    const r = { ...row };
    return {
      id: Number(r.id),
      email: String(r.email),
      displayName: String(r.display_name),
      passwordHash: String(r.password_hash),
      passwordSalt: String(r.password_salt),
      createdAt: String(r.created_at),
    };
  }

  function getUserById(id) {
    const userId = parsePositiveInt(id, 'userId');
    const row = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    return mapUserRow(row);
  }

  function getAuthBootstrapStatus() {
    const usersCount = Number(sqlite.prepare('SELECT COUNT(*) AS count FROM users').get().count);
    const unclaimedGamesCount = Number(
      sqlite.prepare('SELECT COUNT(*) AS count FROM games WHERE user_id IS NULL').get().count,
    );
    const unclaimedEntriesCount = Number(
      sqlite.prepare('SELECT COUNT(*) AS count FROM entries WHERE user_id IS NULL').get().count,
    );
    return {
      hasUsers: usersCount > 0,
      unclaimedGamesCount,
      unclaimedEntriesCount,
    };
  }

  function listUsersPublic() {
    return sqlite
      .prepare('SELECT id, display_name, created_at FROM users ORDER BY id ASC')
      .all()
      .map((rawRow) => {
        const r = { ...rawRow };
        return {
          id: Number(r.id),
          displayName: String(r.display_name),
          createdAt: String(r.created_at),
        };
      });
  }

  function listAllGamesForLeaderboard() {
    return sqlite
      .prepare('SELECT * FROM games WHERE user_id IS NOT NULL ORDER BY sort_order ASC, id ASC')
      .all()
      .map(mapGameRow);
  }

  function listAllEntriesForLeaderboard() {
    return sqlite
      .prepare('SELECT * FROM entries WHERE user_id IS NOT NULL ORDER BY play_date ASC, id ASC')
      .all()
      .map(mapEntryRow);
  }

  function createSession({ id, userId, tokenHash, expiresAt }) {
    const uid = parsePositiveInt(userId, 'userId');
    const now = new Date().toISOString();
    sqlite
      .prepare(`
        INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(String(id), uid, String(tokenHash), String(expiresAt), now);
    return { id: String(id), userId: uid, expiresAt: String(expiresAt), createdAt: now };
  }

  function getSessionByTokenHash(tokenHash) {
    if (typeof tokenHash !== 'string' || !tokenHash) return null;
    const row = sqlite
      .prepare(`
        SELECT
          s.id AS session_id,
          s.user_id,
          s.expires_at,
          s.created_at AS session_created_at,
          u.email,
          u.display_name,
          u.created_at AS user_created_at
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?
      `)
      .get(tokenHash);
    if (!row) return null;
    const r = { ...row };
    const now = new Date().toISOString();
    if (String(r.expires_at) <= now) {
      sqlite.prepare('DELETE FROM sessions WHERE id = ?').run(String(r.session_id));
      return null;
    }
    return {
      sessionId: String(r.session_id),
      expiresAt: String(r.expires_at),
      user: {
        id: Number(r.user_id),
        email: String(r.email),
        displayName: String(r.display_name),
        createdAt: String(r.user_created_at),
      },
    };
  }

  function deleteSessionByTokenHash(tokenHash) {
    if (typeof tokenHash !== 'string' || !tokenHash) return;
    sqlite.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  function resolveUniqueSlug(desired, excludeGameId = null, userId) {
    const uid = parsePositiveInt(userId, 'userId');
    const base = slugify(desired || '') || 'game';
    let candidate = base;
    let suffix = 2;
    const checkStmt = sqlite.prepare('SELECT id FROM games WHERE user_id = ? AND slug = ?');
    while (true) {
      const existing = checkStmt.get(uid, candidate);
      if (!existing || (excludeGameId !== null && Number(existing.id) === excludeGameId)) {
        return candidate;
      }
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
  }

  function listGames({ userId, includeArchived = true } = {}) {
    const uid = parsePositiveInt(userId, 'userId');
    const sql = includeArchived
      ? 'SELECT * FROM games WHERE user_id = ? ORDER BY sort_order ASC, id ASC'
      : 'SELECT * FROM games WHERE user_id = ? AND archived = 0 ORDER BY sort_order ASC, id ASC';
    return sqlite.prepare(sql).all(uid).map(mapGameRow);
  }

  function getGameById(id, userId) {
    const gameId = parsePositiveInt(id, 'gameId');
    const uid = parsePositiveInt(userId, 'userId');
    const row = sqlite
      .prepare('SELECT * FROM games WHERE id = ? AND user_id = ?')
      .get(gameId, uid);
    return mapGameRow(row);
  }

  function validateGameFields(input, isCreate = true) {
    const out = {};

    if (isCreate || input.name !== undefined) {
      if (typeof input.name !== 'string' || !input.name.trim()) {
        throw new ValidationError('Game name is required');
      }
      out.name = input.name.trim();
    }

    if (isCreate || input.url !== undefined) {
      out.url = normalizeUrl(input.url);
    }

    if (input.slug !== undefined) {
      const s = slugify(String(input.slug));
      if (!s) throw new ValidationError('Slug cannot be empty');
      out.slug = s;
    }

    if (isCreate || input.icon !== undefined) {
      out.icon = typeof input.icon === 'string' && input.icon.trim() ? input.icon.trim() : '🎮';
    }

    if (isCreate || input.color !== undefined) {
      out.color =
        typeof input.color === 'string' && input.color.trim() ? input.color.trim() : '#6366f1';
    }

    if (isCreate || input.category !== undefined) {
      out.category =
        typeof input.category === 'string' && input.category.trim()
          ? input.category.trim()
          : 'Daily';
    }

    if (isCreate || input.metricLabel !== undefined) {
      out.metricLabel =
        typeof input.metricLabel === 'string' && input.metricLabel.trim()
          ? input.metricLabel.trim()
          : 'Score';
    }

    if (isCreate || input.metricFormat !== undefined) {
      const fmt = input.metricFormat === undefined ? 'number' : String(input.metricFormat).trim();
      if (!VALID_METRIC_FORMATS.has(fmt)) {
        throw new ValidationError(`Invalid metricFormat: ${fmt}`);
      }
      out.metricFormat = fmt;
    }

    if (isCreate || input.metricDirection !== undefined) {
      const dir =
        input.metricDirection === undefined
          ? 'higher_is_better'
          : String(input.metricDirection).trim();
      if (!VALID_METRIC_DIRECTIONS.has(dir)) {
        throw new ValidationError(`Invalid metricDirection: ${dir}`);
      }
      out.metricDirection = dir;
    }

    if (isCreate || input.parserId !== undefined) {
      out.parserId =
        typeof input.parserId === 'string' && input.parserId.trim()
          ? input.parserId.trim()
          : 'auto';
    }

    if (isCreate || input.resetTimezone !== undefined) {
      const tz =
        input.resetTimezone === undefined ||
        input.resetTimezone === null ||
        String(input.resetTimezone).trim() === ''
          ? 'local'
          : String(input.resetTimezone).trim();
      if (!isValidResetTimezone(tz)) {
        throw new ValidationError(`Invalid resetTimezone: ${tz}`);
      }
      out.resetTimezone = tz;
    }

    if (isCreate || input.resetTime !== undefined) {
      const rt =
        input.resetTime === undefined ||
        input.resetTime === null ||
        String(input.resetTime).trim() === ''
          ? '00:00'
          : String(input.resetTime).trim();
      if (!isValidResetTime(rt)) {
        throw new ValidationError(`Invalid resetTime: ${rt} (expected HH:MM)`);
      }
      out.resetTime = rt;
    }

    if (input.sortOrder !== undefined) {
      const order = Number(input.sortOrder);
      if (!Number.isFinite(order)) {
        throw new ValidationError('sortOrder must be a number');
      }
      out.sortOrder = Math.trunc(order);
    }

    if (isCreate || input.archived !== undefined) {
      out.archived = Boolean(input.archived);
    }

    return out;
  }

  function upsertCatalogIgnore(gameFields, slug, createdByUserId, createdAt = new Date().toISOString()) {
    sqlite
      .prepare(`
        INSERT OR IGNORE INTO game_catalog (
          slug, name, url, icon, color, category,
          metric_label, metric_format, metric_direction,
          parser_id, reset_timezone, reset_time,
          created_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        slug,
        gameFields.name,
        gameFields.url,
        gameFields.icon,
        gameFields.color,
        gameFields.category,
        gameFields.metricLabel,
        gameFields.metricFormat,
        gameFields.metricDirection,
        gameFields.parserId,
        gameFields.resetTimezone,
        gameFields.resetTime,
        createdByUserId ?? null,
        createdAt,
        createdAt,
      );
  }

  function createGame(input, userId) {
    const uid = parsePositiveInt(userId, 'userId');
    if (!input || typeof input !== 'object') {
      throw new ValidationError('Invalid game payload');
    }
    const fields = validateGameFields(input, true);
    const desiredSlug = fields.slug || slugify(fields.name) || 'game';
    const viewerOwnsDesired = sqlite
      .prepare('SELECT id FROM games WHERE user_id = ? AND slug = ?')
      .get(uid, desiredSlug);

    let slug;
    if (!viewerOwnsDesired) {
      const catBySlug = sqlite
        .prepare('SELECT slug FROM game_catalog WHERE slug = ?')
        .get(desiredSlug);
      if (catBySlug) {
        slug = desiredSlug;
      } else if (input.slug === undefined) {
        const targetUrlKey = canonicalUrlKey(fields.url);
        let matchedCatSlug = null;
        if (targetUrlKey) {
          const catRows = sqlite
            .prepare('SELECT slug, url FROM game_catalog ORDER BY created_at ASC, slug ASC')
            .all();
          const checkUserSlugStmt = sqlite.prepare(
            'SELECT id FROM games WHERE user_id = ? AND slug = ?',
          );
          for (const catRow of catRows) {
            if (
              canonicalUrlKey(catRow.url) === targetUrlKey &&
              !checkUserSlugStmt.get(uid, catRow.slug)
            ) {
              matchedCatSlug = String(catRow.slug);
              break;
            }
          }
        }
        slug = matchedCatSlug || resolveUniqueSlug(desiredSlug, null, uid);
      } else {
        slug = resolveUniqueSlug(desiredSlug, null, uid);
      }
    } else {
      slug = resolveUniqueSlug(desiredSlug, null, uid);
    }

    let sortOrder = fields.sortOrder;
    if (sortOrder === undefined) {
      const maxRow = sqlite
        .prepare('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM games WHERE user_id = ?')
        .get(uid);
      sortOrder = Number(maxRow.max_order) + 1;
    }

    const now = new Date().toISOString();
    const res = sqlite
      .prepare(`
        INSERT INTO games (
          user_id, name, slug, url, icon, color, category,
          metric_label, metric_format, metric_direction,
          parser_id, reset_timezone, reset_time, sort_order, archived, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        uid,
        fields.name,
        slug,
        fields.url,
        fields.icon,
        fields.color,
        fields.category,
        fields.metricLabel,
        fields.metricFormat,
        fields.metricDirection,
        fields.parserId,
        fields.resetTimezone,
        fields.resetTime,
        sortOrder,
        sqlBool(fields.archived),
        now,
      );

    upsertCatalogIgnore(fields, slug, uid, now);

    return getGameById(res.lastInsertRowid, uid);
  }

  function updateGame(id, input, userId) {
    const uid = parsePositiveInt(userId, 'userId');
    const existing = getGameById(id, uid);
    if (!existing) {
      throw new NotFoundError('Game not found');
    }
    if (!input || typeof input !== 'object') {
      throw new ValidationError('Invalid game payload');
    }

    const fields = validateGameFields(input, false);
    const slug =
      fields.slug !== undefined ? resolveUniqueSlug(fields.slug, existing.id, uid) : existing.slug;

    const updated = {
      name: fields.name ?? existing.name,
      slug,
      url: fields.url ?? existing.url,
      icon: fields.icon ?? existing.icon,
      color: fields.color ?? existing.color,
      category: fields.category ?? existing.category,
      metricLabel: fields.metricLabel ?? existing.metricLabel,
      metricFormat: fields.metricFormat ?? existing.metricFormat,
      metricDirection: fields.metricDirection ?? existing.metricDirection,
      parserId: fields.parserId ?? existing.parserId,
      resetTimezone: fields.resetTimezone ?? existing.resetTimezone,
      resetTime: fields.resetTime ?? existing.resetTime,
      sortOrder: fields.sortOrder ?? existing.sortOrder,
      archived: fields.archived !== undefined ? fields.archived : existing.archived,
    };

    sqlite
      .prepare(`
        UPDATE games SET
          name = ?, slug = ?, url = ?, icon = ?, color = ?, category = ?,
          metric_label = ?, metric_format = ?, metric_direction = ?,
          parser_id = ?, reset_timezone = ?, reset_time = ?, sort_order = ?, archived = ?
        WHERE id = ? AND user_id = ?
      `)
      .run(
        updated.name,
        updated.slug,
        updated.url,
        updated.icon,
        updated.color,
        updated.category,
        updated.metricLabel,
        updated.metricFormat,
        updated.metricDirection,
        updated.parserId,
        updated.resetTimezone,
        updated.resetTime,
        updated.sortOrder,
        sqlBool(updated.archived),
        existing.id,
        uid,
      );

    const now = new Date().toISOString();
    upsertCatalogIgnore(updated, updated.slug, uid, now);
    const catRow = sqlite
      .prepare('SELECT created_by_user_id FROM game_catalog WHERE slug = ?')
      .get(updated.slug);
    if (
      catRow &&
      catRow.created_by_user_id !== null &&
      catRow.created_by_user_id !== undefined &&
      Number(catRow.created_by_user_id) === uid
    ) {
      sqlite
        .prepare(`
          UPDATE game_catalog SET
            name = ?, url = ?, icon = ?, color = ?, category = ?,
            metric_label = ?, metric_format = ?, metric_direction = ?,
            parser_id = ?, reset_timezone = ?, reset_time = ?, updated_at = ?
          WHERE slug = ?
        `)
        .run(
          updated.name,
          updated.url,
          updated.icon,
          updated.color,
          updated.category,
          updated.metricLabel,
          updated.metricFormat,
          updated.metricDirection,
          updated.parserId,
          updated.resetTimezone,
          updated.resetTime,
          now,
          updated.slug,
        );
    }

    if (updated.slug !== existing.slug && !STARTER_SLUG_SET.has(existing.slug)) {
      const remaining = Number(
        sqlite.prepare('SELECT COUNT(*) AS count FROM games WHERE slug = ?').get(existing.slug).count,
      );
      if (remaining === 0) {
        sqlite.prepare('DELETE FROM game_catalog WHERE slug = ?').run(existing.slug);
      }
    }

    return getGameById(existing.id, uid);
  }

  function reorderGames(orderedIds, userId) {
    const uid = parsePositiveInt(userId, 'userId');
    if (!Array.isArray(orderedIds)) {
      throw new ValidationError('orderedIds must be an array');
    }
    const cleanIds = orderedIds.map((id) => parsePositiveInt(id, 'orderedId'));
    const allGames = listGames({ userId: uid, includeArchived: true });
    const existingIdSet = new Set(allGames.map((g) => g.id));
    for (const id of cleanIds) {
      if (!existingIdSet.has(id)) {
        throw new NotFoundError(`Game ${id} not found`);
      }
    }

    const seen = new Set();
    const finalOrder = [];
    for (const id of cleanIds) {
      if (!seen.has(id)) {
        seen.add(id);
        finalOrder.push(id);
      }
    }
    for (const g of allGames) {
      if (!seen.has(g.id)) {
        seen.add(g.id);
        finalOrder.push(g.id);
      }
    }

    const updateStmt = sqlite.prepare('UPDATE games SET sort_order = ? WHERE id = ? AND user_id = ?');
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      finalOrder.forEach((id, idx) => {
        updateStmt.run(idx + 1, id, uid);
      });
      sqlite.exec('COMMIT');
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw err;
    }

    return listGames({ userId: uid, includeArchived: true });
  }

  function deleteGame(id, userId) {
    const gameId = parsePositiveInt(id, 'gameId');
    const uid = parsePositiveInt(userId, 'userId');
    const existingRow = sqlite
      .prepare('SELECT slug FROM games WHERE id = ? AND user_id = ?')
      .get(gameId, uid);
    if (!existingRow) {
      throw new NotFoundError('Game not found');
    }
    sqlite.prepare('DELETE FROM games WHERE id = ? AND user_id = ?').run(gameId, uid);
    const slug = String(existingRow.slug);
    if (!STARTER_SLUG_SET.has(slug)) {
      const remaining = Number(
        sqlite.prepare('SELECT COUNT(*) AS count FROM games WHERE slug = ?').get(slug).count,
      );
      if (remaining === 0) {
        sqlite.prepare('DELETE FROM game_catalog WHERE slug = ?').run(slug);
      }
    }
    return true;
  }

  function listCatalogGames({ userId } = {}) {
    const uid = parsePositiveInt(userId, 'userId');
    const catalogRows = sqlite
      .prepare(`
        SELECT c.*, u.display_name AS created_by_name
        FROM game_catalog c
        LEFT JOIN users u ON u.id = c.created_by_user_id
      `)
      .all();

    const playerCounts = new Map();
    const countRows = sqlite
      .prepare(`
        SELECT slug, COUNT(DISTINCT user_id) AS player_count
        FROM games
        WHERE user_id IS NOT NULL AND archived = 0
        GROUP BY slug
      `)
      .all();
    for (const cr of countRows) {
      playerCounts.set(String(cr.slug), Number(cr.player_count));
    }

    const viewerGames = new Map();
    const viewerRows = sqlite
      .prepare('SELECT id, slug, archived, sort_order FROM games WHERE user_id = ?')
      .all(uid);
    for (const vr of viewerRows) {
      viewerGames.set(String(vr.slug), {
        id: Number(vr.id),
        archived: Boolean(vr.archived),
        sortOrder: Number(vr.sort_order),
      });
    }

    const mapped = catalogRows.map((raw) => {
      const r = { ...raw };
      const slug = String(r.slug);
      const base = {
        slug,
        name: String(r.name),
        url: String(r.url),
        icon: String(r.icon),
        color: String(r.color),
        category: String(r.category),
        metricLabel: String(r.metric_label),
        metricFormat: String(r.metric_format),
        metricDirection: String(r.metric_direction),
        parserId: String(r.parser_id),
        resetTimezone: String(r.reset_timezone ?? 'local'),
        resetTime: String(r.reset_time ?? '00:00'),
      };
      const resolvedParser = serializeResolvedParser(getParserForGame(base));
      const viewerGame = viewerGames.get(slug);
      const viewerStatus = !viewerGame
        ? 'not_added'
        : viewerGame.archived
          ? 'archived'
          : 'active';

      return {
        ...base,
        resolvedParser,
        isStarter: STARTER_SLUG_SET.has(slug),
        createdByUserId:
          r.created_by_user_id === null || r.created_by_user_id === undefined
            ? null
            : Number(r.created_by_user_id),
        createdByName: r.created_by_name ? String(r.created_by_name) : null,
        playerCount: playerCounts.get(slug) || 0,
        viewerStatus,
        viewerGameId: viewerGame ? viewerGame.id : null,
        _viewerSortOrder: viewerGame ? viewerGame.sortOrder : 0,
      };
    });

    const statusRank = { not_added: 0, archived: 1, active: 2 };
    mapped.sort((a, b) => {
      const ra = statusRank[a.viewerStatus];
      const rb = statusRank[b.viewerStatus];
      if (ra !== rb) return ra - rb;
      if (a.viewerStatus === 'not_added') {
        return b.playerCount - a.playerCount || a.name.localeCompare(b.name);
      }
      if (a.viewerStatus === 'archived') {
        return a.name.localeCompare(b.name);
      }
      return a._viewerSortOrder - b._viewerSortOrder || a.name.localeCompare(b.name);
    });

    return mapped.map(({ _viewerSortOrder, ...item }) => item);
  }

  function subscribeCatalogGame(rawSlug, userId) {
    const uid = parsePositiveInt(userId, 'userId');
    const slug = slugify(String(rawSlug || ''));
    if (!slug) {
      throw new ValidationError('Game slug is required');
    }

    let catRow = sqlite.prepare('SELECT * FROM game_catalog WHERE slug = ?').get(slug);
    if (!catRow) {
      const fallback = sqlite
        .prepare('SELECT * FROM games WHERE slug = ? AND user_id IS NOT NULL ORDER BY id ASC LIMIT 1')
        .get(slug);
      if (fallback) {
        const f = { ...fallback };
        upsertCatalogIgnore(
          {
            name: String(f.name),
            url: String(f.url),
            icon: String(f.icon),
            color: String(f.color),
            category: String(f.category),
            metricLabel: String(f.metric_label),
            metricFormat: String(f.metric_format),
            metricDirection: String(f.metric_direction),
            parserId: String(f.parser_id),
            resetTimezone: String(f.reset_timezone ?? 'local'),
            resetTime: String(f.reset_time ?? '00:00'),
          },
          slug,
          f.user_id === null || f.user_id === undefined ? null : Number(f.user_id),
          String(f.created_at || new Date().toISOString()),
        );
        catRow = sqlite.prepare('SELECT * FROM game_catalog WHERE slug = ?').get(slug);
      }
    }
    if (!catRow) {
      throw new NotFoundError('Catalog game not found');
    }

    const existing = sqlite
      .prepare('SELECT * FROM games WHERE user_id = ? AND slug = ?')
      .get(uid, slug);
    if (existing && !existing.archived) {
      return { game: mapGameRow(existing), status: 'already_active' };
    }

    const maxRow = sqlite
      .prepare('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM games WHERE user_id = ?')
      .get(uid);
    const nextOrder = Number(maxRow.max_order) + 1;

    if (existing && existing.archived) {
      sqlite
        .prepare('UPDATE games SET archived = 0, sort_order = ? WHERE id = ? AND user_id = ?')
        .run(nextOrder, existing.id, uid);
      return { game: getGameById(existing.id, uid), status: 'restored' };
    }

    const c = { ...catRow };
    const now = new Date().toISOString();
    const res = sqlite
      .prepare(`
        INSERT INTO games (
          user_id, name, slug, url, icon, color, category,
          metric_label, metric_format, metric_direction,
          parser_id, reset_timezone, reset_time, sort_order, archived, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `)
      .run(
        uid,
        String(c.name),
        slug,
        String(c.url),
        String(c.icon),
        String(c.color),
        String(c.category),
        String(c.metric_label),
        String(c.metric_format),
        String(c.metric_direction),
        String(c.parser_id),
        String(c.reset_timezone ?? 'local'),
        String(c.reset_time ?? '00:00'),
        nextOrder,
        now,
      );

    return { game: getGameById(res.lastInsertRowid, uid), status: 'subscribed' };
  }

  function getEntryById(id, userId) {
    const entryId = parsePositiveInt(id, 'entryId');
    const uid = parsePositiveInt(userId, 'userId');
    const row = sqlite
      .prepare('SELECT * FROM entries WHERE id = ? AND user_id = ?')
      .get(entryId, uid);
    return mapEntryRow(row);
  }

  function getEntryByGameAndDate(gameId, playDate, userId) {
    const uid = parsePositiveInt(userId, 'userId');
    const row = sqlite
      .prepare('SELECT * FROM entries WHERE game_id = ? AND play_date = ? AND user_id = ?')
      .get(gameId, playDate, uid);
    return mapEntryRow(row);
  }

  function listEntries({ userId, gameId, from, to, date, limit } = {}) {
    const uid = parsePositiveInt(userId, 'userId');
    const clauses = ['user_id = ?'];
    const params = [uid];

    if (gameId !== undefined && gameId !== null && gameId !== '') {
      clauses.push('game_id = ?');
      params.push(parsePositiveInt(gameId, 'gameId'));
    }
    if (date !== undefined && date !== null && date !== '') {
      if (!isValidYmd(date)) throw new ValidationError('Invalid date (expected YYYY-MM-DD)');
      clauses.push('play_date = ?');
      params.push(date);
    }
    if (from !== undefined && from !== null && from !== '') {
      if (!isValidYmd(from)) throw new ValidationError('Invalid from date (expected YYYY-MM-DD)');
      clauses.push('play_date >= ?');
      params.push(from);
    }
    if (to !== undefined && to !== null && to !== '') {
      if (!isValidYmd(to)) throw new ValidationError('Invalid to date (expected YYYY-MM-DD)');
      clauses.push('play_date <= ?');
      params.push(to);
    }

    let sql = `SELECT * FROM entries WHERE ${clauses.join(' AND ')} ORDER BY play_date DESC, id DESC`;

    if (limit !== undefined && limit !== null && limit !== '') {
      const parsedLimit = parsePositiveInt(limit, 'limit');
      sql += ' LIMIT ?';
      params.push(parsedLimit);
    }

    return sqlite.prepare(sql).all(...params).map(mapEntryRow);
  }

  function normalizePrimaryValue(val) {
    if (val === undefined || val === null || val === '') return null;
    const num = Number(val);
    if (!Number.isFinite(num)) {
      throw new ValidationError('primaryValue must be a finite number');
    }
    return num;
  }

  function resolveEntryValues(input, game, existingEntry = null) {
    const rawText =
      input.rawText !== undefined
        ? String(input.rawText ?? '')
        : existingEntry
          ? existingEntry.rawText
          : '';

    const hasRawText = rawText.trim().length > 0;
    const shouldParseRaw =
      hasRawText &&
      (existingEntry === null || input.rawText !== undefined);

    const parsed = shouldParseRaw ? parseForGame(rawText, game) : null;

    const manualOverride =
      input.manualOverride !== undefined
        ? Boolean(input.manualOverride)
        : existingEntry
          ? existingEntry.manualOverride
          : false;

    let completed;
    if (input.completed !== undefined) {
      completed = Boolean(input.completed);
    } else if (parsed) {
      completed = Boolean(parsed.completed);
    } else if (existingEntry) {
      completed = existingEntry.completed;
    } else {
      completed = true;
    }

    let solved;
    if (input.solved !== undefined) {
      solved = input.solved === null ? null : Boolean(input.solved);
    } else if (parsed) {
      solved = parsed.solved ?? null;
    } else if (existingEntry) {
      solved = existingEntry.solved;
    } else {
      solved = null;
    }

    if (input.breakdown !== undefined && input.breakdown !== null && !Array.isArray(input.breakdown)) {
      throw new ValidationError('breakdown must be an array');
    }

    let breakdown;
    if (Array.isArray(input.breakdown)) {
      breakdown = sanitizeBreakdownArray(input.breakdown);
    } else if (input.breakdown === null) {
      breakdown = [];
    } else if (parsed && Array.isArray(parsed.breakdown)) {
      breakdown = sanitizeBreakdownArray(parsed.breakdown);
    } else if (existingEntry && Array.isArray(existingEntry.breakdown)) {
      breakdown = existingEntry.breakdown;
    } else {
      breakdown = [];
    }

    const isPerceptleGame =
      game.slug === 'perceptle' ||
      game.parserId === 'perceptle' ||
      game.resolvedParser?.id === 'perceptle';
    const computedPerceptleAverage =
      isPerceptleGame &&
      Array.isArray(input.breakdown) &&
      breakdown.length > 0 &&
      input.primaryValue === undefined &&
      (parsed?.primaryValue === undefined || parsed?.primaryValue === null);

    let primaryValue;
    if (input.primaryValue !== undefined) {
      primaryValue = normalizePrimaryValue(input.primaryValue);
    } else if (computedPerceptleAverage) {
      const sum = breakdown.reduce((acc, item) => acc + item.value, 0);
      primaryValue = Math.round(sum / breakdown.length);
    } else if (parsed) {
      primaryValue = parsed.primaryValue ?? null;
    } else if (existingEntry) {
      primaryValue = existingEntry.primaryValue;
    } else {
      primaryValue = null;
    }

    const fallbackLabel = solved === false ? 'DNF' : 'Played';
    let displayValue;
    if (
      input.displayValue !== undefined &&
      input.displayValue !== null &&
      String(input.displayValue).trim() !== ''
    ) {
      displayValue = String(input.displayValue).trim();
    } else if (input.primaryValue !== undefined) {
      displayValue =
        primaryValue !== null
          ? formatMetricValue(primaryValue, game.metricFormat, fallbackLabel)
          : fallbackLabel;
    } else if (computedPerceptleAverage) {
      displayValue = String(primaryValue);
    } else if (parsed) {
      displayValue =
        parsed.displayValue ??
        formatMetricValue(parsed.primaryValue, game.metricFormat, fallbackLabel);
    } else if (
      existingEntry &&
      (input.solved === undefined ||
        (existingEntry.displayValue &&
          existingEntry.displayValue !== 'Played' &&
          existingEntry.displayValue !== 'DNF'))
    ) {
      displayValue = existingEntry.displayValue ?? fallbackLabel;
    } else if (primaryValue !== null) {
      displayValue = formatMetricValue(primaryValue, game.metricFormat, fallbackLabel);
    } else {
      displayValue = fallbackLabel;
    }

    let puzzleId;
    if (input.puzzleId !== undefined) {
      puzzleId =
        input.puzzleId === null || String(input.puzzleId).trim() === ''
          ? null
          : String(input.puzzleId).trim();
    } else if (parsed) {
      puzzleId = parsed.puzzleId ?? null;
    } else if (existingEntry) {
      puzzleId = existingEntry.puzzleId;
    } else {
      puzzleId = null;
    }

    let metadata;
    if (input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)) {
      metadata = { ...input.metadata };
    } else if (parsed && parsed.metadata && typeof parsed.metadata === 'object') {
      metadata = { ...parsed.metadata };
    } else if (existingEntry && existingEntry.metadata && typeof existingEntry.metadata === 'object') {
      metadata = { ...existingEntry.metadata };
    } else {
      metadata = {};
    }

    const hasDifficultyField = Object.prototype.hasOwnProperty.call(input, 'difficulty');
    if (hasDifficultyField) {
      if (input.difficulty === '' || input.difficulty === null) {
        delete metadata.difficulty;
        delete metadata.difficultyOverride;
      } else if (input.difficulty !== undefined) {
        if (typeof input.difficulty !== 'string') {
          throw new ValidationError('difficulty must be a string or null');
        }
        const diff = normalizeDifficultyLabel(input.difficulty);
        if (diff) {
          metadata.difficulty = diff;
          metadata.difficultyOverride = true;
        } else {
          delete metadata.difficulty;
          delete metadata.difficultyOverride;
        }
      }
    } else if (parsed) {
      const parsedDiff = normalizeDifficultyLabel(parsed.metadata?.difficulty);
      if (parsedDiff) {
        metadata.difficulty = parsedDiff;
      } else {
        delete metadata.difficulty;
        if (existingEntry?.metadata?.difficultyOverride && existingEntry?.metadata?.difficulty) {
          const existingDiff = normalizeDifficultyLabel(existingEntry.metadata.difficulty);
          if (existingDiff) {
            metadata.difficulty = existingDiff;
            metadata.difficultyOverride = true;
          }
        }
      }
    } else if (existingEntry?.metadata?.difficulty !== undefined) {
      const existingDiff = normalizeDifficultyLabel(existingEntry.metadata.difficulty);
      if (existingDiff) {
        metadata.difficulty = existingDiff;
      } else {
        delete metadata.difficulty;
      }
    }

    if (isPerceptleGame) {
      const nextRoundScores = {};
      for (const item of breakdown) {
        if (item && typeof item.key === 'string' && item.key.trim()) {
          nextRoundScores[item.key.trim()] = item.value;
        }
      }
      if (Object.keys(nextRoundScores).length > 0) {
        metadata.roundScores = nextRoundScores;
        if (metadata.maxScore === undefined) {
          metadata.maxScore = 100;
        }
      } else if (input.breakdown !== undefined) {
        delete metadata.roundScores;
      }
    }

    const parserId = parsed
      ? String(parsed.parserId || game.resolvedParser.id || 'generic')
      : existingEntry
        ? existingEntry.parserId
        : String(game.resolvedParser.id || 'generic');

    const parserVersion = parsed
      ? Number(parsed.parserVersion || game.resolvedParser.version || 1)
      : existingEntry
        ? existingEntry.parserVersion
        : Number(game.resolvedParser.version || 1);

    const notes =
      input.notes !== undefined
        ? String(input.notes ?? '')
        : existingEntry
          ? existingEntry.notes
          : '';

    return {
      rawText,
      parserId,
      parserVersion,
      completed,
      solved,
      primaryValue,
      displayValue,
      puzzleId,
      breakdown,
      metadata,
      notes,
      manualOverride,
      parsed,
    };
  }

  function upsertEntry(input, userId) {
    const uid = parsePositiveInt(userId, 'userId');
    if (!input || typeof input !== 'object') {
      throw new ValidationError('Invalid entry payload');
    }
    const gameId = parsePositiveInt(input.gameId, 'gameId');
    const game = getGameById(gameId, uid);
    if (!game) {
      throw new NotFoundError('Game not found');
    }

    let playDate = input.playDate;
    if (playDate === undefined || playDate === null || playDate === '') {
      const prelimParsed =
        typeof input.rawText === 'string' && input.rawText.trim()
          ? parseForGame(input.rawText, game)
          : null;
      playDate =
        prelimParsed?.puzzleDate && isValidYmd(prelimParsed.puzzleDate)
          ? prelimParsed.puzzleDate
          : getGamePuzzleStatus(game).activePuzzleDate;
    }
    if (!isValidYmd(playDate)) {
      throw new ValidationError('Invalid playDate (expected YYYY-MM-DD)');
    }

    const existing = getEntryByGameAndDate(game.id, playDate, uid);
    const resolved = resolveEntryValues(input, game, existing);
    const now = new Date().toISOString();

    sqlite
      .prepare(`
        INSERT INTO entries (
          user_id, game_id, play_date, raw_text, parser_id, parser_version,
          completed, solved, primary_value, display_value, puzzle_id,
          breakdown_json, metadata_json, notes, manual_override,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(game_id, play_date) DO UPDATE SET
          raw_text = excluded.raw_text,
          parser_id = excluded.parser_id,
          parser_version = excluded.parser_version,
          completed = excluded.completed,
          solved = excluded.solved,
          primary_value = excluded.primary_value,
          display_value = excluded.display_value,
          puzzle_id = excluded.puzzle_id,
          breakdown_json = excluded.breakdown_json,
          metadata_json = excluded.metadata_json,
          notes = excluded.notes,
          manual_override = excluded.manual_override,
          updated_at = excluded.updated_at
      `)
      .run(
        uid,
        game.id,
        playDate,
        resolved.rawText,
        resolved.parserId,
        resolved.parserVersion,
        sqlBool(resolved.completed),
        sqlNullableBool(resolved.solved),
        resolved.primaryValue,
        resolved.displayValue,
        resolved.puzzleId,
        JSON.stringify(resolved.breakdown),
        JSON.stringify(resolved.metadata),
        resolved.notes,
        sqlBool(resolved.manualOverride),
        existing ? existing.createdAt : now,
        now,
      );

    return getEntryByGameAndDate(game.id, playDate, uid);
  }

  function updateEntry(id, input, userId) {
    const uid = parsePositiveInt(userId, 'userId');
    const existing = getEntryById(id, uid);
    if (!existing) {
      throw new NotFoundError('Entry not found');
    }
    if (!input || typeof input !== 'object') {
      throw new ValidationError('Invalid entry payload');
    }

    const targetGameId =
      input.gameId !== undefined ? parsePositiveInt(input.gameId, 'gameId') : existing.gameId;
    const game = getGameById(targetGameId, uid);
    if (!game) {
      throw new NotFoundError('Game not found');
    }

    const targetPlayDate = input.playDate !== undefined ? input.playDate : existing.playDate;
    if (!isValidYmd(targetPlayDate)) {
      throw new ValidationError('Invalid playDate (expected YYYY-MM-DD)');
    }

    if (targetGameId !== existing.gameId || targetPlayDate !== existing.playDate) {
      const collision = getEntryByGameAndDate(targetGameId, targetPlayDate, uid);
      if (collision && collision.id !== existing.id) {
        throw new ConflictError(
          `An entry already exists for game ${targetGameId} on ${targetPlayDate}`,
        );
      }
    }

    const resolved = resolveEntryValues(input, game, existing);
    const now = new Date().toISOString();

    sqlite
      .prepare(`
        UPDATE entries SET
          game_id = ?, play_date = ?, raw_text = ?, parser_id = ?, parser_version = ?,
          completed = ?, solved = ?, primary_value = ?, display_value = ?, puzzle_id = ?,
          breakdown_json = ?, metadata_json = ?, notes = ?, manual_override = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `)
      .run(
        targetGameId,
        targetPlayDate,
        resolved.rawText,
        resolved.parserId,
        resolved.parserVersion,
        sqlBool(resolved.completed),
        sqlNullableBool(resolved.solved),
        resolved.primaryValue,
        resolved.displayValue,
        resolved.puzzleId,
        JSON.stringify(resolved.breakdown),
        JSON.stringify(resolved.metadata),
        resolved.notes,
        sqlBool(resolved.manualOverride),
        now,
        existing.id,
        uid,
      );

    return getEntryById(existing.id, uid);
  }

  function deleteEntry(id, userId) {
    const entryId = parsePositiveInt(id, 'entryId');
    const uid = parsePositiveInt(userId, 'userId');
    const res = sqlite.prepare('DELETE FROM entries WHERE id = ? AND user_id = ?').run(entryId, uid);
    if (res.changes === 0) {
      throw new NotFoundError('Entry not found');
    }
    return true;
  }

  function reparseGameEntries(
    gameId,
    { force = false, startupOnly = false } = {},
    userId = null,
  ) {
    const game = startupOnly
      ? mapGameRow(sqlite.prepare('SELECT * FROM games WHERE id = ?').get(parsePositiveInt(gameId, 'gameId')))
      : getGameById(gameId, userId);

    if (!game) {
      throw new NotFoundError('Game not found');
    }
    const resolvedParser = game.resolvedParser;

    if (startupOnly && !resolvedParser.isCustomParser && resolvedParser.id === 'generic') {
      return { updatedCount: 0, parser: resolvedParser };
    }

    const rows = sqlite
      .prepare('SELECT * FROM entries WHERE game_id = ? AND TRIM(raw_text) != ? AND manual_override = 0')
      .all(game.id, '');

    const candidates = rows
      .map(mapEntryRow)
      .filter((entry) => {
        if (force) return true;
        return (
          entry.parserId === 'generic' ||
          entry.parserId !== resolvedParser.id ||
          entry.parserVersion < resolvedParser.version
        );
      });

    if (candidates.length === 0) {
      return { updatedCount: 0, parser: resolvedParser };
    }

    const updateStmt = sqlite.prepare(`
      UPDATE entries SET
        parser_id = ?, parser_version = ?, completed = ?, solved = ?,
        primary_value = ?, display_value = ?, puzzle_id = ?,
        breakdown_json = ?, metadata_json = ?, updated_at = ?
      WHERE id = ?
    `);

    const now = new Date().toISOString();
    let updatedCount = 0;

    sqlite.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of candidates) {
        const parsed = parseForGame(entry.rawText, game);
        const fallbackLabel = parsed.solved === false ? 'DNF' : 'Played';
        const displayValue =
          parsed.displayValue ??
          formatMetricValue(parsed.primaryValue, game.metricFormat, fallbackLabel);
        const nextMetadata =
          parsed.metadata && typeof parsed.metadata === 'object' ? { ...parsed.metadata } : {};
        const parsedDiff = normalizeDifficultyLabel(nextMetadata.difficulty);
        if (parsedDiff) {
          nextMetadata.difficulty = parsedDiff;
        } else {
          delete nextMetadata.difficulty;
        }
        if (entry.metadata?.difficultyOverride) {
          const overrideDiff = normalizeDifficultyLabel(entry.metadata.difficulty);
          if (overrideDiff) {
            nextMetadata.difficulty = overrideDiff;
            nextMetadata.difficultyOverride = true;
          }
        }

        updateStmt.run(
          String(parsed.parserId || resolvedParser.id || 'generic'),
          Number(parsed.parserVersion || resolvedParser.version || 1),
          sqlBool(parsed.completed),
          sqlNullableBool(parsed.solved),
          parsed.primaryValue ?? null,
          displayValue,
          parsed.puzzleId ?? null,
          JSON.stringify(Array.isArray(parsed.breakdown) ? parsed.breakdown : []),
          JSON.stringify(nextMetadata),
          now,
          entry.id,
        );
        updatedCount += 1;
      }
      sqlite.exec('COMMIT');
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw err;
    }

    return { updatedCount, parser: resolvedParser };
  }

  function runAutoReparseOnStartup() {
    const games = sqlite.prepare('SELECT * FROM games ORDER BY sort_order ASC, id ASC').all().map(mapGameRow);
    let totalUpdated = 0;
    for (const game of games) {
      if (game.resolvedParser.isCustomParser || game.resolvedParser.id !== 'generic') {
        const { updatedCount } = reparseGameEntries(game.id, { startupOnly: true });
        totalUpdated += updatedCount;
      }
    }
    return totalUpdated;
  }

  function exportData(userId) {
    const uid = parsePositiveInt(userId, 'userId');
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      games: listGames({ userId: uid, includeArchived: true }),
      entries: listEntries({ userId: uid }),
    };
  }

  function importData({ games, entries, mode = 'merge' } = {}, userId) {
    const uid = parsePositiveInt(userId, 'userId');
    if (!Array.isArray(games) || !Array.isArray(entries)) {
      throw new ValidationError('Import payload must contain games and entries arrays');
    }
    if (mode !== 'merge' && mode !== 'replace') {
      throw new ValidationError(`Invalid import mode: ${mode}`);
    }

    const idMap = new Map();
    const slugMap = new Map();
    let gamesCount = 0;
    let entriesCount = 0;

    sqlite.exec('BEGIN IMMEDIATE');
    try {
      if (mode === 'replace') {
        sqlite.prepare('DELETE FROM entries WHERE user_id = ?').run(uid);
        sqlite.prepare('DELETE FROM games WHERE user_id = ?').run(uid);
      }

      const existingBySlugStmt = sqlite.prepare('SELECT * FROM games WHERE user_id = ? AND slug = ?');
      const insertGameWithIdStmt = sqlite.prepare(`
        INSERT INTO games (
          id, user_id, name, slug, url, icon, color, category,
          metric_label, metric_format, metric_direction,
          parser_id, reset_timezone, reset_time, sort_order, archived, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertGameStmt = sqlite.prepare(`
        INSERT INTO games (
          user_id, name, slug, url, icon, color, category,
          metric_label, metric_format, metric_direction,
          parser_id, reset_timezone, reset_time, sort_order, archived, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updateGameByIdStmt = sqlite.prepare(`
        UPDATE games SET
          name = ?, url = ?, icon = ?, color = ?, category = ?,
          metric_label = ?, metric_format = ?, metric_direction = ?,
          parser_id = ?, reset_timezone = ?, reset_time = ?, sort_order = ?, archived = ?
        WHERE id = ? AND user_id = ?
      `);

      for (const rawGame of games) {
        if (!rawGame || typeof rawGame !== 'object') {
          throw new ValidationError('Invalid game record in import payload');
        }
        const fields = validateGameFields(rawGame, true);
        const desiredSlug = fields.slug || slugify(fields.name) || 'game';
        const sortOrder = fields.sortOrder ?? gamesCount + 1;
        const createdAt =
          typeof rawGame.createdAt === 'string' && rawGame.createdAt
            ? rawGame.createdAt
            : new Date().toISOString();

        const existing = existingBySlugStmt.get(uid, desiredSlug);
        let mappedId;
        let savedSlug = desiredSlug;

        if (existing && mode === 'merge') {
          mappedId = Number(existing.id);
          updateGameByIdStmt.run(
            fields.name,
            fields.url,
            fields.icon,
            fields.color,
            fields.category,
            fields.metricLabel,
            fields.metricFormat,
            fields.metricDirection,
            fields.parserId,
            fields.resetTimezone,
            fields.resetTime,
            sortOrder,
            sqlBool(fields.archived),
            mappedId,
            uid,
          );
        } else {
          const finalSlug = resolveUniqueSlug(desiredSlug, null, uid);
          savedSlug = finalSlug;
          if (
            mode === 'replace' &&
            Number.isInteger(rawGame.id) &&
            rawGame.id > 0 &&
            !sqlite.prepare('SELECT id FROM games WHERE id = ?').get(rawGame.id)
          ) {
            insertGameWithIdStmt.run(
              rawGame.id,
              uid,
              fields.name,
              finalSlug,
              fields.url,
              fields.icon,
              fields.color,
              fields.category,
              fields.metricLabel,
              fields.metricFormat,
              fields.metricDirection,
              fields.parserId,
              fields.resetTimezone,
              fields.resetTime,
              sortOrder,
              sqlBool(fields.archived),
              createdAt,
            );
            mappedId = Number(rawGame.id);
          } else {
            const res = insertGameStmt.run(
              uid,
              fields.name,
              finalSlug,
              fields.url,
              fields.icon,
              fields.color,
              fields.category,
              fields.metricLabel,
              fields.metricFormat,
              fields.metricDirection,
              fields.parserId,
              fields.resetTimezone,
              fields.resetTime,
              sortOrder,
              sqlBool(fields.archived),
              createdAt,
            );
            mappedId = Number(res.lastInsertRowid);
          }
        }

        upsertCatalogIgnore(fields, savedSlug, uid, createdAt);

        if (rawGame.id !== undefined && rawGame.id !== null) {
          idMap.set(Number(rawGame.id), mappedId);
        }
        slugMap.set(desiredSlug, mappedId);
        gamesCount += 1;
      }

      const upsertEntryStmt = sqlite.prepare(`
        INSERT INTO entries (
          user_id, game_id, play_date, raw_text, parser_id, parser_version,
          completed, solved, primary_value, display_value, puzzle_id,
          breakdown_json, metadata_json, notes, manual_override,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(game_id, play_date) DO UPDATE SET
          raw_text = excluded.raw_text,
          parser_id = excluded.parser_id,
          parser_version = excluded.parser_version,
          completed = excluded.completed,
          solved = excluded.solved,
          primary_value = excluded.primary_value,
          display_value = excluded.display_value,
          puzzle_id = excluded.puzzle_id,
          breakdown_json = excluded.breakdown_json,
          metadata_json = excluded.metadata_json,
          notes = excluded.notes,
          manual_override = excluded.manual_override,
          updated_at = excluded.updated_at
      `);

      for (const rawEntry of entries) {
        if (!rawEntry || typeof rawEntry !== 'object') {
          throw new ValidationError('Invalid entry record in import payload');
        }
        let targetGameId = null;
        if (rawEntry.gameId !== undefined && idMap.has(Number(rawEntry.gameId))) {
          targetGameId = idMap.get(Number(rawEntry.gameId));
        } else if (rawEntry.gameSlug && slugMap.has(String(rawEntry.gameSlug))) {
          targetGameId = slugMap.get(String(rawEntry.gameSlug));
        } else if (mode === 'merge' && Number.isInteger(Number(rawEntry.gameId))) {
          const direct = sqlite
            .prepare('SELECT id FROM games WHERE id = ? AND user_id = ?')
            .get(Number(rawEntry.gameId), uid);
          if (direct) targetGameId = Number(direct.id);
        }

        if (!targetGameId) {
          throw new ValidationError(`Entry references unknown gameId: ${rawEntry.gameId}`);
        }
        if (!isValidYmd(rawEntry.playDate)) {
          throw new ValidationError(`Invalid entry playDate: ${rawEntry.playDate}`);
        }

        const primaryValue = normalizePrimaryValue(rawEntry.primaryValue);
        const solved =
          rawEntry.solved === undefined || rawEntry.solved === null
            ? null
            : Boolean(rawEntry.solved);
        const completed = rawEntry.completed === undefined ? true : Boolean(rawEntry.completed);
        const manualOverride = Boolean(rawEntry.manualOverride);
        const now = new Date().toISOString();
        const createdAt =
          typeof rawEntry.createdAt === 'string' && rawEntry.createdAt ? rawEntry.createdAt : now;
        const updatedAt =
          typeof rawEntry.updatedAt === 'string' && rawEntry.updatedAt ? rawEntry.updatedAt : now;

        upsertEntryStmt.run(
          uid,
          targetGameId,
          rawEntry.playDate,
          String(rawEntry.rawText ?? ''),
          String(rawEntry.parserId ?? 'generic'),
          Number.isInteger(rawEntry.parserVersion) ? rawEntry.parserVersion : 1,
          sqlBool(completed),
          sqlNullableBool(solved),
          primaryValue,
          rawEntry.displayValue !== undefined && rawEntry.displayValue !== null
            ? String(rawEntry.displayValue)
            : null,
          rawEntry.puzzleId !== undefined && rawEntry.puzzleId !== null
            ? String(rawEntry.puzzleId)
            : null,
          JSON.stringify(Array.isArray(rawEntry.breakdown) ? rawEntry.breakdown : []),
          JSON.stringify(
            rawEntry.metadata && typeof rawEntry.metadata === 'object' ? rawEntry.metadata : {},
          ),
          String(rawEntry.notes ?? ''),
          sqlBool(manualOverride),
          createdAt,
          updatedAt,
        );
        entriesCount += 1;
      }

      sqlite.exec('COMMIT');
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw err;
    }

    return { ok: true, gamesCount, entriesCount };
  }

  runAutoReparseOnStartup();

  return {
    sqlite,
    registerUser,
    getUserByEmail,
    getUserById,
    getAuthBootstrapStatus,
    listUsersPublic,
    listAllGamesForLeaderboard,
    listAllEntriesForLeaderboard,
    createSession,
    getSessionByTokenHash,
    deleteSessionByTokenHash,
    seedStarterGamesForUser,
    listGames,
    getGameById,
    createGame,
    updateGame,
    reorderGames,
    deleteGame,
    listCatalogGames,
    subscribeCatalogGame,
    listEntries,
    getEntryById,
    getEntryByGameAndDate,
    upsertEntry,
    updateEntry,
    deleteEntry,
    reparseGameEntries,
    exportData,
    importData,
    close() {
      sqlite.close();
    },
  };
}
