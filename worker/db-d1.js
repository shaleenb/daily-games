/**
 * Cloudflare D1 async database adapter for Daily Games Hub.
 * ZERO Node built-ins and ZERO module-level mutable request state.
 */
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

export const VALID_METRIC_FORMATS = new Set(['number', 'duration_sec', 'percent', 'fraction']);
export const VALID_METRIC_DIRECTIONS = new Set(['higher_is_better', 'lower_is_better']);
const STARTER_SLUG_SET = new Set(STARTER_GAMES.map((g) => g.slug));
const IGNORED_CANONICAL_HOSTS = new Set(['example.com', 'localhost', '127.0.0.1']);

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
  constructor(message = 'Not found') {
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

const TABLE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS games (
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
  )`,
  `CREATE TABLE IF NOT EXISTS entries (
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
  )`,
  `CREATE TABLE IF NOT EXISTS game_catalog (
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
  )`,
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`,
];

const INDEX_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_games_user_order ON games(user_id, sort_order, id)`,
  `CREATE INDEX IF NOT EXISTS idx_entries_play_date ON entries(play_date)`,
  `CREATE INDEX IF NOT EXISTS idx_entries_game_date ON entries(game_id, play_date)`,
  `CREATE INDEX IF NOT EXISTS idx_entries_user_date ON entries(user_id, play_date)`,
];

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
  'fermi',
  'magnitudle',
  'plain',
  'timeguessr',
]);
const BACKFILL_TIMEZONE_SLUGS = new Set(['cluesbysam', 'krillion', 'farflung', 'perceptle']);
const GRID_METRIC_KEYS = [
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

async function runBatched(db, stmts, chunkSize = 50) {
  for (let i = 0; i < stmts.length; i += chunkSize) {
    await db.batch(stmts.slice(i, i + chunkSize));
  }
}

async function syncStarterGamesOnDb(
  db,
  userId,
  { appendSlugs = WAVE_APPEND_STARTER_SLUGS } = {},
) {
  const isUnclaimed = userId === null || userId === undefined;
  const uid = isUnclaimed ? null : Number(userId);
  const existingRes = isUnclaimed
    ? await db
        .prepare(
          'SELECT id, slug, parser_id, reset_timezone, reset_time, sort_order FROM games WHERE user_id IS NULL',
        )
        .all()
    : await db
        .prepare(
          'SELECT id, slug, parser_id, reset_timezone, reset_time, sort_order FROM games WHERE user_id = ?',
        )
        .bind(uid)
        .all();

  const rows = existingRes?.results || [];
  const bySlug = new Map(rows.map((r) => [String(r.slug), r]));
  let maxOrder = rows.reduce((acc, r) => Math.max(acc, Number(r.sort_order || 0)), 0);
  const now = new Date().toISOString();
  const stmts = [];

  for (const g of STARTER_GAMES) {
    const existing = bySlug.get(g.slug);
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
        stmts.push(
          isUnclaimed
            ? db
                .prepare(
                  'UPDATE games SET reset_timezone = ?, reset_time = ? WHERE id = ? AND user_id IS NULL',
                )
                .bind(g.resetTimezone, nextTime, Number(existing.id))
            : db
                .prepare(
                  'UPDATE games SET reset_timezone = ?, reset_time = ? WHERE id = ? AND user_id = ?',
                )
                .bind(g.resetTimezone, nextTime, Number(existing.id), uid),
        );
      }
      if (
        UPGRADE_PARSER_STARTER_SLUGS.has(g.slug) &&
        existing.parser_id === 'auto' &&
        g.parserId !== 'auto'
      ) {
        stmts.push(
          db
            .prepare("UPDATE games SET parser_id = ? WHERE id = ? AND parser_id = 'auto'")
            .bind(g.parserId, Number(existing.id)),
        );
      }
    } else if (appendSlugs.has(g.slug)) {
      const sortOrder = Math.max(maxOrder + 1, g.sortOrder);
      maxOrder = sortOrder;
      stmts.push(
        db
          .prepare(`
            INSERT INTO games (
              user_id, name, slug, url, icon, color, category,
              metric_label, metric_format, metric_direction,
              parser_id, reset_timezone, reset_time, sort_order, archived, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
            uid,
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
          ),
      );
    }
  }

  if (stmts.length > 0) {
    await runBatched(db, stmts);
  }
}

async function seedCatalogOnDb(db, now = new Date().toISOString()) {
  const stmts = STARTER_GAMES.map((g) =>
    db
      .prepare(`
        INSERT OR IGNORE INTO game_catalog (
          slug, name, url, icon, color, category,
          metric_label, metric_format, metric_direction,
          parser_id, reset_timezone, reset_time,
          created_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `)
      .bind(
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
        now,
        now,
      ),
  );
  stmts.push(
    db.prepare(
      "UPDATE game_catalog SET parser_id = 'cluesbysam' WHERE slug = 'cluesbysam' AND parser_id = 'auto'",
    ),
  );
  stmts.push(
    db.prepare(
      "UPDATE game_catalog SET parser_id = 'perceptle' WHERE slug = 'perceptle' AND parser_id = 'auto'",
    ),
  );
  stmts.push(
    db.prepare(
      "UPDATE game_catalog SET parser_id = 'fermi' WHERE slug = 'fermi' AND parser_id = 'auto'",
    ),
  );
  stmts.push(
    db.prepare(
      "UPDATE game_catalog SET parser_id = 'magnitudle' WHERE slug = 'magnitudle' AND parser_id = 'auto'",
    ),
  );
  stmts.push(
    db.prepare(`
      INSERT OR IGNORE INTO game_catalog (
        slug, name, url, icon, color, category,
        metric_label, metric_format, metric_direction,
        parser_id, reset_timezone, reset_time,
        created_by_user_id, created_at, updated_at
      )
      SELECT
        slug, name, url, icon, color, category,
        metric_label, metric_format, metric_direction,
        parser_id, reset_timezone, reset_time,
        user_id, created_at, created_at
      FROM games
      ORDER BY CASE WHEN user_id IS NOT NULL THEN 0 ELSE 1 END, id ASC
    `),
  );
  await runBatched(db, stmts);
}

async function backfillCluesBySamEntriesOnDb(db) {
  const rowsRes = await db
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

  const rows = rowsRes?.results || [];
  if (rows.length === 0) return 0;

  const cluesParser = getParserById('cluesbysam');
  const stmts = [];

  for (const r of rows) {
    const existingMeta = safeJsonParse(r.metadata_json, {});
    if (existingMeta?.difficultyOverride) continue;

    const hasDifficulty = Boolean(normalizeDifficultyLabel(existingMeta?.difficulty));
    const hasGridMetrics =
      existingMeta?.grid !== undefined || existingMeta?.cleanCount !== undefined;
    if (hasDifficulty && hasGridMetrics) continue;

    const gameStub = {
      slug: String(r.game_slug || 'cluesbysam'),
      name: String(r.game_name || 'Clues by Sam'),
      url: String(r.game_url || 'https://cluesbysam.com'),
      parserId: 'cluesbysam',
    };
    const parsed = cluesParser
      ? cluesParser.parse(String(r.raw_text ?? ''), gameStub, String(r.play_date || ''))
      : parseForGame(String(r.raw_text ?? ''), gameStub);
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

    for (const key of GRID_METRIC_KEYS) {
      if (merged[key] === undefined && parsedMeta[key] !== undefined && parsedMeta[key] !== null) {
        merged[key] = parsedMeta[key];
        changed = true;
      }
    }

    if (changed) {
      stmts.push(
        db
          .prepare('UPDATE entries SET metadata_json = ? WHERE id = ?')
          .bind(JSON.stringify(merged), Number(r.id)),
      );
    }
  }

  if (stmts.length > 0) {
    await runBatched(db, stmts);
  }
  return stmts.length;
}

async function backfillPerceptleEntriesOnDb(db) {
  const rowsRes = await db
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

  const rows = rowsRes?.results || [];
  if (rows.length === 0) return 0;

  const perceptleParser = getParserById('perceptle');
  const stmts = [];

  for (const r of rows) {
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

    stmts.push(
      db
        .prepare(`
          UPDATE entries SET
            parser_id = ?, parser_version = ?,
            primary_value = ?, display_value = ?, puzzle_id = ?,
            breakdown_json = ?, metadata_json = ?
          WHERE id = ?
        `)
        .bind(
          String(parsed.parserId || 'perceptle'),
          Number(parsed.parserVersion || 1),
          nextPrimaryValue,
          nextDisplayValue,
          nextPuzzleId,
          JSON.stringify(parsedBreakdown),
          JSON.stringify(mergedMeta),
          Number(r.id),
        ),
    );
  }

  if (stmts.length > 0) {
    await runBatched(db, stmts);
  }
  return stmts.length;
}

async function backfillAllGameGridsAndFermiOnDb(db) {
  const rowsRes = await db
    .prepare(`
      SELECT
        e.id, e.raw_text, e.parser_id, e.parser_version,
        e.primary_value, e.display_value, e.puzzle_id,
        e.breakdown_json, e.metadata_json, e.manual_override,
        g.slug AS game_slug, g.name AS game_name, g.url AS game_url,
        g.metric_label, g.metric_format, g.metric_direction, g.parser_id AS game_parser_id
      FROM entries e
      JOIN games g ON g.id = e.game_id
      WHERE TRIM(e.raw_text) != ''
    `)
    .all();

  const rows = rowsRes?.results || [];
  if (rows.length === 0) return 0;

  const stmts = [];

  for (const r of rows) {
    const gameCtx = {
      slug: String(r.game_slug || ''),
      name: String(r.game_name || ''),
      url: String(r.game_url || ''),
      metricLabel: String(r.metric_label || 'Score'),
      metricFormat: String(r.metric_format || 'number'),
      metricDirection: String(r.metric_direction || 'higher_is_better'),
      parserId: String(r.game_parser_id || 'auto'),
    };
    const resolved = serializeResolvedParser(getParserForGame(gameCtx));
    const parsed = parseForGame(String(r.raw_text ?? ''), gameCtx);
    if (!parsed || typeof parsed !== 'object') continue;

    const isManual = Boolean(r.manual_override);
    const isFermi = gameCtx.slug === 'fermi' || resolved.id === 'fermi';
    const isMagnitudle = gameCtx.slug === 'magnitudle' || resolved.id === 'magnitudle';

    const existingBreakdown = safeJsonParse(r.breakdown_json, []);
    const existingMeta = safeJsonParse(r.metadata_json, {});
    const mergedMeta =
      existingMeta && typeof existingMeta === 'object' && !Array.isArray(existingMeta)
        ? { ...existingMeta }
        : {};
    const parsedMeta = parsed.metadata && typeof parsed.metadata === 'object' ? parsed.metadata : {};
    const parsedBreakdown = Array.isArray(parsed.breakdown) ? parsed.breakdown : [];

    let nextParserId = String(r.parser_id || 'generic');
    let nextParserVersion = Number(r.parser_version || 1);
    let nextPrimaryValue =
      r.primary_value === null || r.primary_value === undefined ? null : Number(r.primary_value);
    let nextDisplayValue = r.display_value ?? null;
    let nextPuzzleId = r.puzzle_id ?? null;
    let nextBreakdown = Array.isArray(existingBreakdown) ? existingBreakdown : [];

    if (isFermi) {
      if (!isManual) {
        nextParserId = String(parsed.parserId || 'fermi');
        nextParserVersion = Number(parsed.parserVersion || 1);
        if (parsed.primaryValue !== null && parsed.primaryValue !== undefined) {
          nextPrimaryValue = Number(parsed.primaryValue);
          if (parsed.displayValue) {
            nextDisplayValue = String(parsed.displayValue);
          }
        }
        if (parsed.puzzleId) {
          nextPuzzleId = String(parsed.puzzleId);
        }
        if (parsedBreakdown.length > 0) {
          nextBreakdown = parsedBreakdown;
        }
        if (typeof parsedMeta.emojiGrid === 'string' && parsedMeta.emojiGrid.trim()) {
          mergedMeta.emojiGrid = parsedMeta.emojiGrid.trim();
        }
        if (parsedMeta.topPercent !== undefined && parsedMeta.topPercent !== null) {
          mergedMeta.topPercent = parsedMeta.topPercent;
        }
        if (parsedMeta.percentileLabel) {
          mergedMeta.percentileLabel = parsedMeta.percentileLabel;
        }
      } else {
        const trimmedPid = typeof nextPuzzleId === 'string' ? nextPuzzleId.trim() : '';
        if (trimmedPid && !trimmedPid.startsWith('#') && parsed.puzzleId === `#${trimmedPid}`) {
          nextPuzzleId = parsed.puzzleId;
        }
        if (nextBreakdown.length === 0 && parsedBreakdown.length > 0) {
          nextBreakdown = parsedBreakdown;
        }
        for (const key of ['emojiGrid', 'topPercent', 'percentileLabel']) {
          const cur = mergedMeta[key];
          const isEmpty = cur === undefined || cur === null || (typeof cur === 'string' && !cur.trim());
          if (
            isEmpty &&
            parsedMeta[key] !== undefined &&
            parsedMeta[key] !== null &&
            parsedMeta[key] !== ''
          ) {
            mergedMeta[key] = parsedMeta[key];
          }
        }
      }
    } else {
      if (isMagnitudle && !isManual) {
        nextParserId = String(parsed.parserId || 'magnitudle');
        nextParserVersion = Number(parsed.parserVersion || 1);
        if (
          nextPrimaryValue === null &&
          parsed.primaryValue !== null &&
          parsed.primaryValue !== undefined
        ) {
          nextPrimaryValue = Number(parsed.primaryValue);
          if (parsed.displayValue) {
            nextDisplayValue = String(parsed.displayValue);
          }
        }
        if (!nextPuzzleId && parsed.puzzleId) {
          nextPuzzleId = String(parsed.puzzleId);
        }
      }

      if (nextBreakdown.length === 0 && parsedBreakdown.length > 0) {
        nextBreakdown = parsedBreakdown;
      }

      const existingGrid =
        typeof mergedMeta.emojiGrid === 'string' ? mergedMeta.emojiGrid.trim() : '';
      const parsedGrid =
        typeof parsedMeta.emojiGrid === 'string' ? parsedMeta.emojiGrid.trim() : '';

      if (!existingGrid && parsedGrid) {
        mergedMeta.emojiGrid = parsedGrid;
      } else if (isMagnitudle && parsedGrid && existingGrid !== parsedGrid) {
        const existingLines = existingGrid.split(/\r?\n/);
        const parsedLines = parsedGrid.split(/\r?\n/);
        if (
          existingLines.length >= parsedLines.length * 2 &&
          existingLines.slice(0, parsedLines.length).join('\n') === parsedGrid
        ) {
          mergedMeta.emojiGrid = parsedGrid;
        }
      } else if (
        gameCtx.slug === 'timeguessr' &&
        !isManual &&
        parsedGrid &&
        existingGrid &&
        !existingGrid.includes('🏆') &&
        parsedGrid.includes('🏆')
      ) {
        mergedMeta.emojiGrid = parsedGrid;
      }

      if (
        isMagnitudle &&
        parsedMeta.maxScore !== undefined &&
        parsedMeta.maxScore !== null &&
        (mergedMeta.maxScore === undefined ||
          (!isManual && mergedMeta.maxScore !== parsedMeta.maxScore))
      ) {
        mergedMeta.maxScore = parsedMeta.maxScore;
      }
    }

    const nextBreakdownJson = JSON.stringify(nextBreakdown);
    const nextMetaJson = JSON.stringify(mergedMeta);
    const origPrimary =
      r.primary_value === null || r.primary_value === undefined ? null : Number(r.primary_value);
    const changed =
      nextParserId !== String(r.parser_id || 'generic') ||
      nextParserVersion !== Number(r.parser_version || 1) ||
      nextPrimaryValue !== origPrimary ||
      nextDisplayValue !== (r.display_value ?? null) ||
      nextPuzzleId !== (r.puzzle_id ?? null) ||
      nextBreakdownJson !== String(r.breakdown_json ?? '[]') ||
      nextMetaJson !== String(r.metadata_json ?? '{}');

    if (changed) {
      stmts.push(
        db
          .prepare(`
            UPDATE entries SET
              parser_id = ?, parser_version = ?,
              primary_value = ?, display_value = ?, puzzle_id = ?,
              breakdown_json = ?, metadata_json = ?
            WHERE id = ?
          `)
          .bind(
            nextParserId,
            nextParserVersion,
            nextPrimaryValue,
            nextDisplayValue,
            nextPuzzleId,
            nextBreakdownJson,
            nextMetaJson,
            Number(r.id),
          ),
      );
    }
  }

  if (stmts.length > 0) {
    await runBatched(db, stmts);
  }
  return stmts.length;
}

export async function ensureSchema(db) {
  if (!db) {
    throw new Error('D1 database binding (env.DB) is not configured');
  }
  const existing = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'sessions', 'games', 'entries', 'game_catalog', 'schema_migrations')",
    )
    .first();
  if (Number(existing?.count || 0) < 6) {
    await db.batch(TABLE_STATEMENTS.map((sql) => db.prepare(sql)));
    await db.batch(INDEX_STATEMENTS.map((sql) => db.prepare(sql)));
  }

  const now = new Date().toISOString();
  const wave2MigrationId = 'wave2_starters_and_cluesbysam_v1';
  const wave2Applied = await db
    .prepare('SELECT 1 AS applied FROM schema_migrations WHERE id = ?')
    .bind(wave2MigrationId)
    .first();

  if (!wave2Applied) {
    const unclaimedRow = await db
      .prepare('SELECT COUNT(*) AS count FROM games WHERE user_id IS NULL')
      .first();
    if (Number(unclaimedRow?.count || 0) > 0) {
      await syncStarterGamesOnDb(db, null, { appendSlugs: WAVE_APPEND_STARTER_SLUGS });
    }

    const existingUsersRes = await db.prepare('SELECT id FROM users ORDER BY id ASC').all();
    for (const u of existingUsersRes?.results || []) {
      const uid = Number(u.id);
      const hasGamesRow = await db
        .prepare('SELECT COUNT(*) AS count FROM games WHERE user_id = ?')
        .bind(uid)
        .first();
      if (Number(hasGamesRow?.count || 0) > 0) {
        await syncStarterGamesOnDb(db, uid, { appendSlugs: WAVE_APPEND_STARTER_SLUGS });
      }
    }

    await db
      .prepare("UPDATE games SET parser_id = 'cluesbysam' WHERE slug = 'cluesbysam' AND parser_id = 'auto'")
      .run();
    await seedCatalogOnDb(db, now);
    await db
      .prepare('INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)')
      .bind(wave2MigrationId, now)
      .run();
  } else {
    const catalogCountRow = await db.prepare('SELECT COUNT(*) AS count FROM game_catalog').first();
    if (Number(catalogCountRow?.count || 0) === 0) {
      await seedCatalogOnDb(db, now);
    }
  }

  const backfillMigrationId = 'cluesbysam_difficulty_backfill_v1';
  const backfillApplied = await db
    .prepare('SELECT 1 AS applied FROM schema_migrations WHERE id = ?')
    .bind(backfillMigrationId)
    .first();
  if (!backfillApplied) {
    await backfillCluesBySamEntriesOnDb(db);
    await db
      .prepare('INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)')
      .bind(backfillMigrationId, now)
      .run();
  }

  const perceptleMigrationId = 'perceptle_parser_and_backfill_v1';
  const perceptleApplied = await db
    .prepare('SELECT 1 AS applied FROM schema_migrations WHERE id = ?')
    .bind(perceptleMigrationId)
    .first();
  if (!perceptleApplied) {
    await db.batch([
      db.prepare(
        "UPDATE games SET parser_id = 'perceptle' WHERE slug = 'perceptle' AND parser_id = 'auto'",
      ),
      db.prepare(
        "UPDATE game_catalog SET parser_id = 'perceptle' WHERE slug = 'perceptle' AND parser_id = 'auto'",
      ),
    ]);
    await backfillPerceptleEntriesOnDb(db);
    await db
      .prepare('INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)')
      .bind(perceptleMigrationId, now)
      .run();
  }

  const fermiMagnitudleMigrationId = 'fermi_magnitudle_grids_backfill_v1';
  const fermiMagnitudleApplied = await db
    .prepare('SELECT 1 AS applied FROM schema_migrations WHERE id = ?')
    .bind(fermiMagnitudleMigrationId)
    .first();
  if (!fermiMagnitudleApplied) {
    await db.batch([
      db.prepare(
        "UPDATE games SET parser_id = 'fermi' WHERE slug = 'fermi' AND parser_id = 'auto'",
      ),
      db.prepare(
        "UPDATE games SET parser_id = 'magnitudle' WHERE slug = 'magnitudle' AND parser_id = 'auto'",
      ),
      db.prepare(
        "UPDATE game_catalog SET parser_id = 'fermi' WHERE slug = 'fermi' AND parser_id = 'auto'",
      ),
      db.prepare(
        "UPDATE game_catalog SET parser_id = 'magnitudle' WHERE slug = 'magnitudle' AND parser_id = 'auto'",
      ),
    ]);
    await backfillAllGameGridsAndFermiOnDb(db);
    await db
      .prepare('INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)')
      .bind(fermiMagnitudleMigrationId, now)
      .run();
  }
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

export function serializeResolvedParser(parser) {
  const p = parser || GENERIC_PARSER;
  const id = typeof p.id === 'string' && p.id ? p.id : 'generic';
  const isCustomParser = typeof p.isCustomParser === 'boolean' ? p.isCustomParser : id !== 'generic';
  const name =
    typeof p.name === 'string' && p.name ? p.name : id === 'generic' ? 'Generic Tracker' : id;
  const version = Number.isInteger(p.version) && p.version >= 1 ? p.version : 1;
  return { id, name, version, isCustomParser };
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

function normalizePrimaryValue(val) {
  if (val === undefined || val === null || val === '') return null;
  const num = Number(val);
  if (!Number.isFinite(num)) {
    throw new ValidationError('primaryValue must be a finite number');
  }
  return num;
}

function mapUserRow(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    email: String(r.email),
    displayName: String(r.display_name),
    createdAt: String(r.created_at),
  };
}

function mapGameRow(r) {
  if (!r) return null;
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
  return {
    ...base,
    resolvedParser: serializeResolvedParser(getParserForGame(base)),
  };
}

function mapEntryRow(r) {
  if (!r) return null;
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
      typeof input.category === 'string' && input.category.trim() ? input.category.trim() : 'Daily';
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
      typeof input.parserId === 'string' && input.parserId.trim() ? input.parserId.trim() : 'auto';
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

function resolveEntryValues(input, game, existingEntry = null) {
  const rawText =
    input.rawText !== undefined
      ? String(input.rawText ?? '')
      : existingEntry
        ? existingEntry.rawText
        : '';

  const hasRawText = rawText.trim().length > 0;
  const shouldParseRaw = hasRawText && (existingEntry === null || input.rawText !== undefined);
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
  };
}

function getLastInsertRowId(res) {
  return Number(res?.meta?.last_row_id ?? res?.lastInsertRowid ?? 0);
}

function getChanges(res) {
  return Number(res?.meta?.changes ?? res?.changes ?? 0);
}

export function createD1Database(d1) {
  if (!d1) {
    throw new Error('D1 database binding (env.DB) is required');
  }

  let schemaPromise = null;
  async function ready() {
    if (!schemaPromise) {
      schemaPromise = ensureSchema(d1).catch((err) => {
        schemaPromise = null;
        throw err;
      });
    }
    return schemaPromise;
  }

  async function insertStarterGamesForUser(userId) {
    const now = new Date().toISOString();
    const stmts = STARTER_GAMES.map((g) =>
      d1
        .prepare(`
          INSERT INTO games (
            user_id, name, slug, url, icon, color, category,
            metric_label, metric_format, metric_direction,
            parser_id, reset_timezone, reset_time, sort_order, archived, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
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
        ),
    );
    await d1.batch(stmts);
  }

  async function seedStarterGamesForUser(userId) {
    await ready();
    const uid = parsePositiveInt(userId, 'userId');
    const unclaimedRow = await d1
      .prepare('SELECT COUNT(*) AS count FROM games WHERE user_id IS NULL')
      .first();

    if (Number(unclaimedRow?.count || 0) > 0) {
      const claimRes = await d1.batch([
        d1.prepare('UPDATE games SET user_id = ? WHERE user_id IS NULL').bind(uid),
        d1.prepare('UPDATE entries SET user_id = ? WHERE user_id IS NULL').bind(uid),
      ]);
      if (getChanges(claimRes[0]) > 0) {
        await syncStarterGamesOnDb(d1, uid, { appendSlugs: new Set() });
        return;
      }
    }

    const existingRow = await d1
      .prepare('SELECT COUNT(*) AS count FROM games WHERE user_id = ?')
      .bind(uid)
      .first();
    if (Number(existingRow?.count || 0) === 0) {
      await insertStarterGamesForUser(uid);
    }
  }

  async function getUserById(id) {
    await ready();
    const userId = parsePositiveInt(id, 'userId');
    const row = await d1.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
    return mapUserRow(row);
  }

  async function getUserByEmail(email) {
    await ready();
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const row = await d1
      .prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE')
      .bind(normalized)
      .first();
    if (!row) return null;
    return {
      id: Number(row.id),
      email: String(row.email),
      displayName: String(row.display_name),
      passwordHash: String(row.password_hash),
      passwordSalt: String(row.password_salt),
      createdAt: String(row.created_at),
    };
  }

  async function registerUser({ name, email, passwordHash, passwordSalt }) {
    await ready();
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
    let userId;
    try {
      const res = await d1
        .prepare(`
          INSERT INTO users (email, display_name, password_hash, password_salt, created_at)
          VALUES (?, ?, ?, ?, ?)
        `)
        .bind(normalized, displayName, String(passwordHash), String(passwordSalt), now)
        .run();
      userId = getLastInsertRowId(res);
    } catch (err) {
      if (String(err?.message || '').toLowerCase().includes('unique')) {
        throw new ConflictError('An account with this email already exists');
      }
      throw err;
    }

    try {
      await seedStarterGamesForUser(userId);
    } catch (err) {
      try {
        await d1.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
      } catch {
        // ignore cleanup error
      }
      throw err;
    }

    return getUserById(userId);
  }

  async function getAuthBootstrapStatus() {
    await ready();
    const [usersRow, gamesRow, entriesRow] = await Promise.all([
      d1.prepare('SELECT COUNT(*) AS count FROM users').first(),
      d1.prepare('SELECT COUNT(*) AS count FROM games WHERE user_id IS NULL').first(),
      d1.prepare('SELECT COUNT(*) AS count FROM entries WHERE user_id IS NULL').first(),
    ]);
    return {
      hasUsers: Number(usersRow?.count || 0) > 0,
      unclaimedGamesCount: Number(gamesRow?.count || 0),
      unclaimedEntriesCount: Number(entriesRow?.count || 0),
    };
  }

  async function listUsersPublic() {
    await ready();
    const res = await d1
      .prepare('SELECT id, display_name, created_at FROM users ORDER BY id ASC')
      .all();
    return (res?.results || []).map((r) => ({
      id: Number(r.id),
      displayName: String(r.display_name),
      createdAt: String(r.created_at),
    }));
  }

  async function listAllGamesForLeaderboard() {
    await ready();
    const res = await d1
      .prepare('SELECT * FROM games WHERE user_id IS NOT NULL ORDER BY sort_order ASC, id ASC')
      .all();
    return (res?.results || []).map(mapGameRow);
  }

  async function listAllEntriesForLeaderboard() {
    await ready();
    const res = await d1
      .prepare('SELECT * FROM entries WHERE user_id IS NOT NULL ORDER BY play_date ASC, id ASC')
      .all();
    return (res?.results || []).map(mapEntryRow);
  }

  async function createSession({ id, userId, tokenHash, expiresAt }) {
    await ready();
    const uid = parsePositiveInt(userId, 'userId');
    const now = new Date().toISOString();
    await d1
      .prepare(`
        INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .bind(String(id), uid, String(tokenHash), String(expiresAt), now)
      .run();
    return { id: String(id), userId: uid, expiresAt: String(expiresAt), createdAt: now };
  }

  async function getSessionByTokenHash(tokenHash) {
    await ready();
    if (typeof tokenHash !== 'string' || !tokenHash) return null;
    const row = await d1
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
      .bind(tokenHash)
      .first();
    if (!row) return null;

    const now = new Date().toISOString();
    if (String(row.expires_at) <= now) {
      await d1.prepare('DELETE FROM sessions WHERE id = ?').bind(String(row.session_id)).run();
      return null;
    }
    return {
      sessionId: String(row.session_id),
      expiresAt: String(row.expires_at),
      user: {
        id: Number(row.user_id),
        email: String(row.email),
        displayName: String(row.display_name),
        createdAt: String(row.user_created_at),
      },
    };
  }

  async function deleteSessionByTokenHash(tokenHash) {
    await ready();
    if (typeof tokenHash !== 'string' || !tokenHash) return;
    await d1.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
  }

  async function resolveUniqueSlug(desired, excludeGameId = null, userId) {
    const uid = parsePositiveInt(userId, 'userId');
    const base = slugify(desired || '') || 'game';
    const res = await d1
      .prepare('SELECT id, slug FROM games WHERE user_id = ?')
      .bind(uid)
      .all();
    const taken = new Set(
      (res?.results || [])
        .filter((r) => excludeGameId === null || Number(r.id) !== excludeGameId)
        .map((r) => String(r.slug)),
    );
    let candidate = base;
    let suffix = 2;
    while (taken.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  async function listGames({ userId, includeArchived = true } = {}) {
    await ready();
    const uid = parsePositiveInt(userId, 'userId');
    const sql = includeArchived
      ? 'SELECT * FROM games WHERE user_id = ? ORDER BY sort_order ASC, id ASC'
      : 'SELECT * FROM games WHERE user_id = ? AND archived = 0 ORDER BY sort_order ASC, id ASC';
    const res = await d1.prepare(sql).bind(uid).all();
    return (res?.results || []).map(mapGameRow);
  }

  async function getGameById(id, userId) {
    await ready();
    const gameId = parsePositiveInt(id, 'gameId');
    const uid = parsePositiveInt(userId, 'userId');
    const row = await d1
      .prepare('SELECT * FROM games WHERE id = ? AND user_id = ?')
      .bind(gameId, uid)
      .first();
    return mapGameRow(row);
  }

  function buildUpsertCatalogIgnoreStmt(
    gameFields,
    slug,
    createdByUserId,
    createdAt = new Date().toISOString(),
  ) {
    return d1
      .prepare(`
        INSERT OR IGNORE INTO game_catalog (
          slug, name, url, icon, color, category,
          metric_label, metric_format, metric_direction,
          parser_id, reset_timezone, reset_time,
          created_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
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

  async function createGame(input, userId) {
    await ready();
    const uid = parsePositiveInt(userId, 'userId');
    if (!input || typeof input !== 'object') {
      throw new ValidationError('Invalid game payload');
    }
    const fields = validateGameFields(input, true);
    const desiredSlug = fields.slug || slugify(fields.name) || 'game';
    const viewerOwnsDesired = await d1
      .prepare('SELECT id FROM games WHERE user_id = ? AND slug = ?')
      .bind(uid, desiredSlug)
      .first();

    let slug;
    if (!viewerOwnsDesired) {
      const catBySlug = await d1
        .prepare('SELECT slug FROM game_catalog WHERE slug = ?')
        .bind(desiredSlug)
        .first();
      if (catBySlug) {
        slug = desiredSlug;
      } else if (input.slug === undefined) {
        const targetUrlKey = canonicalUrlKey(fields.url);
        let matchedCatSlug = null;
        if (targetUrlKey) {
          const [catRes, userGamesRes] = await Promise.all([
            d1.prepare('SELECT slug, url FROM game_catalog ORDER BY created_at ASC, slug ASC').all(),
            d1.prepare('SELECT slug FROM games WHERE user_id = ?').bind(uid).all(),
          ]);
          const userSlugs = new Set((userGamesRes?.results || []).map((r) => String(r.slug)));
          for (const catRow of catRes?.results || []) {
            if (
              canonicalUrlKey(catRow.url) === targetUrlKey &&
              !userSlugs.has(String(catRow.slug))
            ) {
              matchedCatSlug = String(catRow.slug);
              break;
            }
          }
        }
        slug = matchedCatSlug || (await resolveUniqueSlug(desiredSlug, null, uid));
      } else {
        slug = await resolveUniqueSlug(desiredSlug, null, uid);
      }
    } else {
      slug = await resolveUniqueSlug(desiredSlug, null, uid);
    }

    let sortOrder = fields.sortOrder;
    if (sortOrder === undefined) {
      const maxRow = await d1
        .prepare('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM games WHERE user_id = ?')
        .bind(uid)
        .first();
      sortOrder = Number(maxRow?.max_order || 0) + 1;
    }

    const now = new Date().toISOString();
    const batchRes = await d1.batch([
      d1
        .prepare(`
          INSERT INTO games (
            user_id, name, slug, url, icon, color, category,
            metric_label, metric_format, metric_direction,
            parser_id, reset_timezone, reset_time, sort_order, archived, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
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
        ),
      buildUpsertCatalogIgnoreStmt(fields, slug, uid, now),
    ]);

    return getGameById(getLastInsertRowId(batchRes[0]), uid);
  }

  async function updateGame(id, input, userId) {
    await ready();
    const uid = parsePositiveInt(userId, 'userId');
    const existing = await getGameById(id, uid);
    if (!existing) {
      throw new NotFoundError('Game not found');
    }
    if (!input || typeof input !== 'object') {
      throw new ValidationError('Invalid game payload');
    }

    const fields = validateGameFields(input, false);
    const slug =
      fields.slug !== undefined
        ? await resolveUniqueSlug(fields.slug, existing.id, uid)
        : existing.slug;

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

    const now = new Date().toISOString();
    await d1.batch([
      d1
        .prepare(`
          UPDATE games SET
            name = ?, slug = ?, url = ?, icon = ?, color = ?, category = ?,
            metric_label = ?, metric_format = ?, metric_direction = ?,
            parser_id = ?, reset_timezone = ?, reset_time = ?, sort_order = ?, archived = ?
          WHERE id = ? AND user_id = ?
        `)
        .bind(
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
        ),
      buildUpsertCatalogIgnoreStmt(updated, updated.slug, uid, now),
    ]);

    const catRow = await d1
      .prepare('SELECT created_by_user_id FROM game_catalog WHERE slug = ?')
      .bind(updated.slug)
      .first();
    if (
      catRow &&
      catRow.created_by_user_id !== null &&
      catRow.created_by_user_id !== undefined &&
      Number(catRow.created_by_user_id) === uid
    ) {
      await d1
        .prepare(`
          UPDATE game_catalog SET
            name = ?, url = ?, icon = ?, color = ?, category = ?,
            metric_label = ?, metric_format = ?, metric_direction = ?,
            parser_id = ?, reset_timezone = ?, reset_time = ?, updated_at = ?
          WHERE slug = ?
        `)
        .bind(
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
        )
        .run();
    }

    if (updated.slug !== existing.slug && !STARTER_SLUG_SET.has(existing.slug)) {
      const remRow = await d1
        .prepare('SELECT COUNT(*) AS count FROM games WHERE slug = ?')
        .bind(existing.slug)
        .first();
      if (Number(remRow?.count || 0) === 0) {
        await d1.prepare('DELETE FROM game_catalog WHERE slug = ?').bind(existing.slug).run();
      }
    }

    return getGameById(existing.id, uid);
  }

  async function reorderGames(orderedIds, userId) {
    await ready();
    const uid = parsePositiveInt(userId, 'userId');
    if (!Array.isArray(orderedIds)) {
      throw new ValidationError('orderedIds must be an array');
    }
    const cleanIds = orderedIds.map((id) => parsePositiveInt(id, 'orderedId'));
    const allGames = await listGames({ userId: uid, includeArchived: true });
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

    if (finalOrder.length > 0) {
      await d1.batch(
        finalOrder.map((gameId, idx) =>
          d1
            .prepare('UPDATE games SET sort_order = ? WHERE id = ? AND user_id = ?')
            .bind(idx + 1, gameId, uid),
        ),
      );
    }

    return listGames({ userId: uid, includeArchived: true });
  }

  async function deleteGame(id, userId) {
    await ready();
    const gameId = parsePositiveInt(id, 'gameId');
    const uid = parsePositiveInt(userId, 'userId');
    const existingRow = await d1
      .prepare('SELECT slug FROM games WHERE id = ? AND user_id = ?')
      .bind(gameId, uid)
      .first();
    if (!existingRow) {
      throw new NotFoundError('Game not found');
    }
    await d1.prepare('DELETE FROM games WHERE id = ? AND user_id = ?').bind(gameId, uid).run();

    const slug = String(existingRow.slug);
    if (!STARTER_SLUG_SET.has(slug)) {
      const remRow = await d1
        .prepare('SELECT COUNT(*) AS count FROM games WHERE slug = ?')
        .bind(slug)
        .first();
      if (Number(remRow?.count || 0) === 0) {
        await d1.prepare('DELETE FROM game_catalog WHERE slug = ?').bind(slug).run();
      }
    }
    return true;
  }

  async function listCatalogGames({ userId } = {}) {
    await ready();
    const uid = parsePositiveInt(userId, 'userId');
    const [catalogRes, countRes, viewerRes] = await Promise.all([
      d1
        .prepare(`
          SELECT c.*, u.display_name AS created_by_name
          FROM game_catalog c
          LEFT JOIN users u ON u.id = c.created_by_user_id
        `)
        .all(),
      d1
        .prepare(`
          SELECT slug, COUNT(DISTINCT user_id) AS player_count
          FROM games
          WHERE user_id IS NOT NULL AND archived = 0
          GROUP BY slug
        `)
        .all(),
      d1
        .prepare('SELECT id, slug, archived, sort_order FROM games WHERE user_id = ?')
        .bind(uid)
        .all(),
    ]);

    const playerCounts = new Map();
    for (const cr of countRes?.results || []) {
      playerCounts.set(String(cr.slug), Number(cr.player_count));
    }

    const viewerGames = new Map();
    for (const vr of viewerRes?.results || []) {
      viewerGames.set(String(vr.slug), {
        id: Number(vr.id),
        archived: Boolean(vr.archived),
        sortOrder: Number(vr.sort_order),
      });
    }

    const mapped = (catalogRes?.results || []).map((r) => {
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

  async function subscribeCatalogGame(rawSlug, userId) {
    await ready();
    const uid = parsePositiveInt(userId, 'userId');
    const slug = slugify(String(rawSlug || ''));
    if (!slug) {
      throw new ValidationError('Game slug is required');
    }

    let catRow = await d1.prepare('SELECT * FROM game_catalog WHERE slug = ?').bind(slug).first();
    if (!catRow) {
      const fallback = await d1
        .prepare('SELECT * FROM games WHERE slug = ? AND user_id IS NOT NULL ORDER BY id ASC LIMIT 1')
        .bind(slug)
        .first();
      if (fallback) {
        await buildUpsertCatalogIgnoreStmt(
          {
            name: String(fallback.name),
            url: String(fallback.url),
            icon: String(fallback.icon),
            color: String(fallback.color),
            category: String(fallback.category),
            metricLabel: String(fallback.metric_label),
            metricFormat: String(fallback.metric_format),
            metricDirection: String(fallback.metric_direction),
            parserId: String(fallback.parser_id),
            resetTimezone: String(fallback.reset_timezone ?? 'local'),
            resetTime: String(fallback.reset_time ?? '00:00'),
          },
          slug,
          fallback.user_id === null || fallback.user_id === undefined
            ? null
            : Number(fallback.user_id),
          String(fallback.created_at || new Date().toISOString()),
        ).run();
        catRow = await d1.prepare('SELECT * FROM game_catalog WHERE slug = ?').bind(slug).first();
      }
    }
    if (!catRow) {
      throw new NotFoundError('Catalog game not found');
    }

    const existing = await d1
      .prepare('SELECT * FROM games WHERE user_id = ? AND slug = ?')
      .bind(uid, slug)
      .first();
    if (existing && !existing.archived) {
      return { game: mapGameRow(existing), status: 'already_active' };
    }

    const maxRow = await d1
      .prepare('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM games WHERE user_id = ?')
      .bind(uid)
      .first();
    const nextOrder = Number(maxRow?.max_order || 0) + 1;

    if (existing && existing.archived) {
      await d1
        .prepare('UPDATE games SET archived = 0, sort_order = ? WHERE id = ? AND user_id = ?')
        .bind(nextOrder, Number(existing.id), uid)
        .run();
      return { game: await getGameById(Number(existing.id), uid), status: 'restored' };
    }

    const now = new Date().toISOString();
    const res = await d1
      .prepare(`
        INSERT INTO games (
          user_id, name, slug, url, icon, color, category,
          metric_label, metric_format, metric_direction,
          parser_id, reset_timezone, reset_time, sort_order, archived, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `)
      .bind(
        uid,
        String(catRow.name),
        slug,
        String(catRow.url),
        String(catRow.icon),
        String(catRow.color),
        String(catRow.category),
        String(catRow.metric_label),
        String(catRow.metric_format),
        String(catRow.metric_direction),
        String(catRow.parser_id),
        String(catRow.reset_timezone ?? 'local'),
        String(catRow.reset_time ?? '00:00'),
        nextOrder,
        now,
      )
      .run();

    return { game: await getGameById(getLastInsertRowId(res), uid), status: 'subscribed' };
  }

  async function getEntryById(id, userId) {
    await ready();
    const entryId = parsePositiveInt(id, 'entryId');
    const uid = parsePositiveInt(userId, 'userId');
    const row = await d1
      .prepare('SELECT * FROM entries WHERE id = ? AND user_id = ?')
      .bind(entryId, uid)
      .first();
    return mapEntryRow(row);
  }

  async function getEntryByGameAndDate(gameId, playDate, userId) {
    await ready();
    const uid = parsePositiveInt(userId, 'userId');
    const row = await d1
      .prepare('SELECT * FROM entries WHERE game_id = ? AND play_date = ? AND user_id = ?')
      .bind(gameId, playDate, uid)
      .first();
    return mapEntryRow(row);
  }

  async function listEntries({ userId, gameId, from, to, date, limit } = {}) {
    await ready();
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

    const res = await d1.prepare(sql).bind(...params).all();
    return (res?.results || []).map(mapEntryRow);
  }

  async function upsertEntry(input, userId) {
    await ready();
    const uid = parsePositiveInt(userId, 'userId');
    if (!input || typeof input !== 'object') {
      throw new ValidationError('Invalid entry payload');
    }
    const gameId = parsePositiveInt(input.gameId, 'gameId');
    const game = await getGameById(gameId, uid);
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

    const existing = await getEntryByGameAndDate(game.id, playDate, uid);
    const resolved = resolveEntryValues(input, game, existing);
    const now = new Date().toISOString();

    await d1
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
      .bind(
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
      )
      .run();

    return getEntryByGameAndDate(game.id, playDate, uid);
  }

  async function updateEntry(id, input, userId) {
    await ready();
    const uid = parsePositiveInt(userId, 'userId');
    const existing = await getEntryById(id, uid);
    if (!existing) {
      throw new NotFoundError('Entry not found');
    }
    if (!input || typeof input !== 'object') {
      throw new ValidationError('Invalid entry payload');
    }

    const targetGameId =
      input.gameId !== undefined ? parsePositiveInt(input.gameId, 'gameId') : existing.gameId;
    const game = await getGameById(targetGameId, uid);
    if (!game) {
      throw new NotFoundError('Game not found');
    }

    const targetPlayDate = input.playDate !== undefined ? input.playDate : existing.playDate;
    if (!isValidYmd(targetPlayDate)) {
      throw new ValidationError('Invalid playDate (expected YYYY-MM-DD)');
    }

    if (targetGameId !== existing.gameId || targetPlayDate !== existing.playDate) {
      const collision = await getEntryByGameAndDate(targetGameId, targetPlayDate, uid);
      if (collision && collision.id !== existing.id) {
        throw new ConflictError(
          `An entry already exists for game ${targetGameId} on ${targetPlayDate}`,
        );
      }
    }

    const resolved = resolveEntryValues(input, game, existing);
    const now = new Date().toISOString();

    await d1
      .prepare(`
        UPDATE entries SET
          game_id = ?, play_date = ?, raw_text = ?, parser_id = ?, parser_version = ?,
          completed = ?, solved = ?, primary_value = ?, display_value = ?, puzzle_id = ?,
          breakdown_json = ?, metadata_json = ?, notes = ?, manual_override = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `)
      .bind(
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
      )
      .run();

    return getEntryById(existing.id, uid);
  }

  async function deleteEntry(id, userId) {
    await ready();
    const entryId = parsePositiveInt(id, 'entryId');
    const uid = parsePositiveInt(userId, 'userId');
    const res = await d1
      .prepare('DELETE FROM entries WHERE id = ? AND user_id = ?')
      .bind(entryId, uid)
      .run();
    if (getChanges(res) === 0) {
      throw new NotFoundError('Entry not found');
    }
    return true;
  }

  async function reparseGameEntries(gameId, { force = false } = {}, userId) {
    await ready();
    const uid = parsePositiveInt(userId, 'userId');
    const game = await getGameById(gameId, uid);
    if (!game) {
      throw new NotFoundError('Game not found');
    }
    const resolvedParser = game.resolvedParser;

    const rowsRes = await d1
      .prepare(
        'SELECT * FROM entries WHERE game_id = ? AND user_id = ? AND TRIM(raw_text) != ? AND manual_override = 0',
      )
      .bind(game.id, uid, '')
      .all();

    const candidates = (rowsRes?.results || [])
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

    const now = new Date().toISOString();
    const stmts = candidates.map((entry) => {
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

      return d1
        .prepare(`
          UPDATE entries SET
            parser_id = ?, parser_version = ?, completed = ?, solved = ?,
            primary_value = ?, display_value = ?, puzzle_id = ?,
            breakdown_json = ?, metadata_json = ?, updated_at = ?
          WHERE id = ? AND user_id = ?
        `)
        .bind(
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
          uid,
        );
    });

    await d1.batch(stmts);
    return { updatedCount: stmts.length, parser: resolvedParser };
  }

  async function exportData(userId) {
    await ready();
    const uid = parsePositiveInt(userId, 'userId');
    const [games, entries] = await Promise.all([
      listGames({ userId: uid, includeArchived: true }),
      listEntries({ userId: uid }),
    ]);
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      games,
      entries,
    };
  }

  async function importData({ games, entries, mode = 'merge' } = {}, userId) {
    await ready();
    const uid = parsePositiveInt(userId, 'userId');
    if (!Array.isArray(games) || !Array.isArray(entries)) {
      throw new ValidationError('Import payload must contain games and entries arrays');
    }
    if (mode !== 'merge' && mode !== 'replace') {
      throw new ValidationError(`Invalid import mode: ${mode}`);
    }

    const validatedGames = games.map((rawGame, idx) => {
      if (!rawGame || typeof rawGame !== 'object') {
        throw new ValidationError('Invalid game record in import payload');
      }
      const fields = validateGameFields(rawGame, true);
      const desiredSlug = fields.slug || slugify(fields.name) || 'game';
      const sortOrder = fields.sortOrder ?? idx + 1;
      const createdAt =
        typeof rawGame.createdAt === 'string' && rawGame.createdAt
          ? rawGame.createdAt
          : new Date().toISOString();
      return { rawGame, fields, desiredSlug, sortOrder, createdAt };
    });

    const validatedEntries = entries.map((rawEntry) => {
      if (!rawEntry || typeof rawEntry !== 'object') {
        throw new ValidationError('Invalid entry record in import payload');
      }
      if (!isValidYmd(rawEntry.playDate)) {
        throw new ValidationError(`Invalid entry playDate: ${rawEntry.playDate}`);
      }
      const primaryValue = normalizePrimaryValue(rawEntry.primaryValue);
      return { rawEntry, primaryValue };
    });

    if (mode === 'replace') {
      await d1.batch([
        d1.prepare('DELETE FROM entries WHERE user_id = ?').bind(uid),
        d1.prepare('DELETE FROM games WHERE user_id = ?').bind(uid),
      ]);
    }

    const currentGames = await listGames({ userId: uid, includeArchived: true });
    const existingBySlug = new Map(currentGames.map((g) => [g.slug, g]));
    const takenSlugs = new Set(currentGames.map((g) => g.slug));

    function allocateSlug(desired) {
      const base = slugify(desired || '') || 'game';
      let candidate = base;
      let suffix = 2;
      while (takenSlugs.has(candidate)) {
        candidate = `${base}-${suffix}`;
        suffix += 1;
      }
      takenSlugs.add(candidate);
      return candidate;
    }

    const idMap = new Map();
    const slugMap = new Map();
    const catalogStmts = [];
    let gamesCount = 0;

    for (const item of validatedGames) {
      const { rawGame, fields, desiredSlug, sortOrder, createdAt } = item;
      const existing = existingBySlug.get(desiredSlug);
      let mappedId;
      let savedSlug = desiredSlug;

      if (existing && mode === 'merge') {
        mappedId = existing.id;
        await d1
          .prepare(`
            UPDATE games SET
              name = ?, url = ?, icon = ?, color = ?, category = ?,
              metric_label = ?, metric_format = ?, metric_direction = ?,
              parser_id = ?, reset_timezone = ?, reset_time = ?, sort_order = ?, archived = ?
            WHERE id = ? AND user_id = ?
          `)
          .bind(
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
          )
          .run();
      } else {
        const finalSlug = allocateSlug(desiredSlug);
        savedSlug = finalSlug;
        let canPreserveId = false;
        if (mode === 'replace' && Number.isInteger(rawGame.id) && rawGame.id > 0) {
          const idTaken = await d1
            .prepare('SELECT id FROM games WHERE id = ?')
            .bind(rawGame.id)
            .first();
          canPreserveId = !idTaken;
        }

        if (canPreserveId) {
          await d1
            .prepare(`
              INSERT INTO games (
                id, user_id, name, slug, url, icon, color, category,
                metric_label, metric_format, metric_direction,
                parser_id, reset_timezone, reset_time, sort_order, archived, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .bind(
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
            )
            .run();
          mappedId = Number(rawGame.id);
        } else {
          const res = await d1
            .prepare(`
              INSERT INTO games (
                user_id, name, slug, url, icon, color, category,
                metric_label, metric_format, metric_direction,
                parser_id, reset_timezone, reset_time, sort_order, archived, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .bind(
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
            )
            .run();
          mappedId = getLastInsertRowId(res);
        }
        existingBySlug.set(finalSlug, { id: mappedId, slug: finalSlug });
      }

      catalogStmts.push(buildUpsertCatalogIgnoreStmt(fields, savedSlug, uid, createdAt));

      if (rawGame.id !== undefined && rawGame.id !== null) {
        idMap.set(Number(rawGame.id), mappedId);
      }
      slugMap.set(desiredSlug, mappedId);
      gamesCount += 1;
    }

    if (catalogStmts.length > 0) {
      const BATCH_CHUNK = 50;
      for (let i = 0; i < catalogStmts.length; i += BATCH_CHUNK) {
        await d1.batch(catalogStmts.slice(i, i + BATCH_CHUNK));
      }
    }

    const userGameIdSet = new Set(
      (await listGames({ userId: uid, includeArchived: true })).map((g) => g.id),
    );
    const entryStmts = [];

    for (const { rawEntry, primaryValue } of validatedEntries) {
      let targetGameId = null;
      if (rawEntry.gameId !== undefined && idMap.has(Number(rawEntry.gameId))) {
        targetGameId = idMap.get(Number(rawEntry.gameId));
      } else if (rawEntry.gameSlug && slugMap.has(String(rawEntry.gameSlug))) {
        targetGameId = slugMap.get(String(rawEntry.gameSlug));
      } else if (mode === 'merge' && Number.isInteger(Number(rawEntry.gameId))) {
        const directId = Number(rawEntry.gameId);
        if (userGameIdSet.has(directId)) {
          targetGameId = directId;
        }
      }

      if (!targetGameId) {
        throw new ValidationError(`Entry references unknown gameId: ${rawEntry.gameId}`);
      }

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

      entryStmts.push(
        d1
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
          .bind(
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
          ),
      );
    }

    const BATCH_CHUNK = 50;
    for (let i = 0; i < entryStmts.length; i += BATCH_CHUNK) {
      await d1.batch(entryStmts.slice(i, i + BATCH_CHUNK));
    }

    return { ok: true, gamesCount, entriesCount: entryStmts.length };
  }

  return {
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
  };
}
