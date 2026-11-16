import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { GENERIC_PARSER, getParserForGame } from '../shared/parsers/registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, 'data', 'daily-games.db');
const DEFAULT_OUT_PATH = path.join(PROJECT_ROOT, 'data', 'local-backup.json');

function safeJsonParse(str, fallback) {
  if (typeof str !== 'string' || !str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function serializeResolvedParser(parser) {
  const p = parser || GENERIC_PARSER;
  const id = typeof p.id === 'string' && p.id ? p.id : 'generic';
  const isCustomParser = typeof p.isCustomParser === 'boolean' ? p.isCustomParser : id !== 'generic';
  const name =
    typeof p.name === 'string' && p.name ? p.name : id === 'generic' ? 'Generic Tracker' : id;
  const version = Number.isInteger(p.version) && p.version >= 1 ? p.version : 1;
  return { id, name, version, isCustomParser };
}

function mapGameRow(rawRow) {
  const r = { ...rawRow };
  const base = {
    id: Number(r.id),
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

function mapEntryRow(rawRow) {
  const r = { ...rawRow };
  return {
    id: Number(r.id),
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
    metadata: safeJsonParse(r.metadata_json, {}),
    notes: String(r.notes ?? ''),
    manualOverride: Boolean(r.manual_override),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function parseArgs(argv) {
  const opts = { dbPath: DEFAULT_DB_PATH, outPath: DEFAULT_OUT_PATH, userId: null, email: null };
  for (const arg of argv) {
    if (arg.startsWith('--db=')) opts.dbPath = path.resolve(arg.slice(5));
    else if (arg.startsWith('--out=')) opts.outPath = path.resolve(arg.slice(6));
    else if (arg.startsWith('--user-id=')) opts.userId = Number(arg.slice(10));
    else if (arg.startsWith('--email=')) opts.email = arg.slice(8).trim().toLowerCase();
  }
  return opts;
}

export function exportLocalDbToJson({
  dbPath = DEFAULT_DB_PATH,
  outPath = DEFAULT_OUT_PATH,
  userId = null,
  email = null,
} = {}) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database file does not exist: ${dbPath}`);
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
    );
    const hasUsers = tables.has('users');
    const gameCols = new Set(db.prepare('PRAGMA table_info(games)').all().map((r) => r.name));
    const hasGameUserId = gameCols.has('user_id');

    let targetUserId = userId;
    if (hasUsers && hasGameUserId) {
      if (email) {
        const userRow = db
          .prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE')
          .get(email);
        if (!userRow) {
          throw new Error(`No user found with email: ${email}`);
        }
        targetUserId = Number(userRow.id);
      } else if (!targetUserId) {
        const users = db.prepare('SELECT id FROM users ORDER BY id ASC').all();
        if (users.length === 1) {
          targetUserId = Number(users[0].id);
        } else if (users.length > 1) {
          targetUserId = Number(users[0].id);
          console.warn(
            `Multiple local users found; exporting user_id=${targetUserId}. Pass --user-id or --email to select another.`,
          );
        }
      }
    }

    let gameRows;
    let entryRows;

    if (hasGameUserId && targetUserId) {
      gameRows = db
        .prepare('SELECT * FROM games WHERE user_id = ? OR user_id IS NULL ORDER BY sort_order ASC, id ASC')
        .all(targetUserId);
      const gameIds = new Set(gameRows.map((g) => Number(g.id)));
      entryRows = db
        .prepare('SELECT * FROM entries ORDER BY play_date DESC, id DESC')
        .all()
        .filter((e) => gameIds.has(Number(e.game_id)));
    } else if (hasGameUserId) {
      gameRows = db
        .prepare('SELECT * FROM games WHERE user_id IS NULL ORDER BY sort_order ASC, id ASC')
        .all();
      const gameIds = new Set(gameRows.map((g) => Number(g.id)));
      entryRows = db
        .prepare('SELECT * FROM entries ORDER BY play_date DESC, id DESC')
        .all()
        .filter((e) => gameIds.has(Number(e.game_id)));
    } else {
      gameRows = db.prepare('SELECT * FROM games ORDER BY sort_order ASC, id ASC').all();
      entryRows = db.prepare('SELECT * FROM entries ORDER BY play_date DESC, id DESC').all();
    }

    const games = gameRows.map(mapGameRow);
    const entries = entryRows.map(mapEntryRow);
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      games,
      entries,
    };

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    return { outPath, gamesCount: games.length, entriesCount: entries.length };
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const opts = parseArgs(process.argv.slice(2));
  const res = exportLocalDbToJson(opts);
  console.log(
    `Exported ${res.gamesCount} games and ${res.entriesCount} entries to ${res.outPath}`,
  );
}
