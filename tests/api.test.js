import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';
import { createDatabase, canonicalUrlKey } from '../server/db.js';
import {
  addDays,
  DIFFICULTY_COLORS,
  computeStreaks,
  computeGameStats,
  computeCardSummaries,
  computeDailyOverview,
  extractShareGrid,
  computePlayersLeaderboard,
} from '../server/stats.js';
import { getGamePuzzleStatus, getLocalDateString } from '../shared/parsers/registry.js';
import { hashPassword } from '../shared/auth-crypto.js';

function createClient(baseUrl) {
  const cookies = new Map();

  function applySetCookies(headers) {
    const setCookies =
      typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : headers.get('set-cookie')
          ? [headers.get('set-cookie')]
          : [];

    for (const raw of setCookies) {
      const firstPart = raw.split(';')[0];
      const eqIdx = firstPart.indexOf('=');
      if (eqIdx <= 0) continue;
      const name = firstPart.slice(0, eqIdx).trim();
      const val = firstPart.slice(eqIdx + 1).trim();
      if (!val || /Max-Age=0/i.test(raw)) {
        cookies.delete(name);
      } else {
        cookies.set(name, val);
      }
    }
  }

  async function request(urlPath, { method = 'GET', body, headers: extraHeaders = {} } = {}) {
    const headers = { ...extraHeaders };
    if (cookies.size > 0 && !headers.Cookie && !headers.cookie) {
      headers.Cookie = Array.from(cookies.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
    }
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}${urlPath}`, { method, headers, body: payload });
    applySetCookies(res.headers);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, text, json };
  }

  return { request, cookies };
}

async function startTestApp(dbPath = ':memory:') {
  const app = createApp({ dbPath });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const defaultClient = createClient(baseUrl);

  return {
    app,
    baseUrl,
    request: defaultClient.request,
    createClient: () => createClient(baseUrl),
    close: () => app.close(),
  };
}

async function registerUser(client, { name = 'Alice', email = 'alice@example.com', password = 'password123' } = {}) {
  const res = await client.request('/api/auth/register', {
    method: 'POST',
    body: { name, email, password },
  });
  assert.equal(res.status, 201, `Expected 201 registering ${email}, got ${res.status}: ${res.text}`);
  return res;
}

test('seeds 9 starter games per user on registration without creating anonymous rows', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-games-seed-'));
  const dbPath = path.join(tmpDir, 'nested', 'test.db');

  try {
    const db1 = createDatabase({ dbPath });
    const rawCount = Number(db1.sqlite.prepare('SELECT COUNT(*) AS count FROM games').get().count);
    assert.equal(rawCount, 0);

    const { hashHex, saltHex } = await hashPassword('password123');
    const user1 = db1.registerUser({
      name: 'Alice',
      email: 'alice@example.com',
      passwordHash: hashHex,
      passwordSalt: saltHex,
    });
    const games1 = db1.listGames({ userId: user1.id });
    assert.equal(games1.length, 9);
    assert.deepEqual(
      games1.map((g) => g.slug),
      [
        'cluesbysam',
        'krillion',
        'farflung',
        'perceptle',
        'pricepoint',
        'fermi',
        'magnitudle',
        'plain',
        'timeguessr',
      ],
    );
    assert.equal(games1[0].parserId, 'cluesbysam');
    assert.equal(games1[0].resolvedParser.id, 'cluesbysam');
    assert.equal(games1[0].resolvedParser.isCustomParser, true);
    assert.equal(games1[0].metricFormat, 'duration_sec');
    assert.equal(games1[0].metricDirection, 'lower_is_better');
    assert.equal(games1[0].resetTimezone, 'America/New_York');
    assert.equal(games1[3].slug, 'perceptle');
    assert.equal(games1[3].parserId, 'perceptle');
    assert.equal(games1[3].resolvedParser.id, 'perceptle');
    assert.equal(games1[3].resolvedParser.isCustomParser, true);
    assert.equal(games1[4].resetTimezone, 'America/Los_Angeles');
    assert.equal(games1[7].parserId, 'plain');
    assert.equal(games1[7].resolvedParser.id, 'plain');
    assert.equal(games1[7].resetTimezone, 'America/New_York');
    assert.equal(games1[8].parserId, 'timeguessr');
    assert.equal(games1[8].resolvedParser.id, 'timeguessr');
    assert.equal(games1[8].resetTimezone, 'UTC');

    const user2 = db1.registerUser({
      name: 'Bob',
      email: 'bob@example.com',
      passwordHash: hashHex,
      passwordSalt: saltHex,
    });
    const games2 = db1.listGames({ userId: user2.id });
    assert.equal(games2.length, 9);
    assert.deepEqual(
      games2.map((g) => g.slug),
      [
        'cluesbysam',
        'krillion',
        'farflung',
        'perceptle',
        'pricepoint',
        'fermi',
        'magnitudle',
        'plain',
        'timeguessr',
      ],
    );

    db1.createGame({ name: 'Wordle', url: 'https://www.nytimes.com/games/wordle' }, user1.id);
    db1.close();

    const db2 = createDatabase({ dbPath });
    assert.equal(db2.listGames({ userId: user1.id }).length, 10);
    assert.equal(db2.listGames({ userId: user2.id }).length, 9);
    db2.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('non-destructively migrates legacy pre-auth DB, preserves entries, and claims for first registered user', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-games-migrate-'));
  const dbPath = path.join(tmpDir, 'legacy.db');

  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        url TEXT NOT NULL,
        icon TEXT NOT NULL DEFAULT '🎮',
        color TEXT NOT NULL DEFAULT '#6366f1',
        category TEXT NOT NULL DEFAULT 'Daily',
        metric_label TEXT NOT NULL DEFAULT 'Score',
        metric_format TEXT NOT NULL DEFAULT 'number',
        metric_direction TEXT NOT NULL DEFAULT 'higher_is_better',
        parser_id TEXT NOT NULL DEFAULT 'auto',
        sort_order INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      INSERT INTO games (id, name, slug, url, sort_order, archived, created_at)
      VALUES
        (1, 'Clues by Sam', 'cluesbysam', 'https://cluesbysam.com', 1, 0, '2026-11-15T00:00:00Z'),
        (2, 'Krillion', 'krillion', 'https://krillion.io', 2, 0, '2026-11-15T00:00:00Z'),
        (3, 'Farflung', 'farflung', 'https://farflunggame.fun', 3, 0, '2026-11-15T00:00:00Z'),
        (4, 'Perceptle', 'perceptle', 'https://perceptle.com', 4, 0, '2026-11-15T00:00:00Z');
      INSERT INTO entries (game_id, play_date, raw_text, primary_value, display_value, created_at, updated_at)
      VALUES (2, '2026-11-15', 'Krillion #123 465', 465, '465', '2026-11-15T01:00:00Z', '2026-11-15T01:00:00Z');
    `);
    legacy.close();

    const ctx = await startTestApp(dbPath);
    try {
      const meBeforeClaim = await ctx.request('/api/auth/me');
      assert.equal(meBeforeClaim.status, 200);
      assert.deepEqual(meBeforeClaim.json, {
        authenticated: false,
        user: null,
        hasUsers: false,
        unclaimed: { gamesCount: 9, entriesCount: 1 },
      });
    } finally {
      await ctx.close();
    }

    const db = createDatabase({ dbPath });
    assert.deepEqual(db.getAuthBootstrapStatus(), {
      hasUsers: false,
      unclaimedGamesCount: 9,
      unclaimedEntriesCount: 1,
    });

    const { hashHex, saltHex } = await hashPassword('password123');
    const firstUser = db.registerUser({
      name: 'First Player',
      email: 'first@example.com',
      passwordHash: hashHex,
      passwordSalt: saltHex,
    });
    const firstGames = db.listGames({ userId: firstUser.id });
    assert.equal(firstGames.length, 9);
    assert.equal(firstGames.find((g) => g.slug === 'cluesbysam').resetTimezone, 'America/New_York');
    assert.equal(firstGames.find((g) => g.slug === 'cluesbysam').parserId, 'cluesbysam');
    assert.equal(firstGames.find((g) => g.slug === 'pricepoint').resetTimezone, 'America/Los_Angeles');
    assert.ok(firstGames.some((g) => g.slug === 'plain'));
    assert.ok(firstGames.some((g) => g.slug === 'timeguessr'));

    const firstEntries = db.listEntries({ userId: firstUser.id });
    assert.equal(firstEntries.length, 1);
    assert.equal(firstEntries[0].primaryValue, 465);

    const secondUser = db.registerUser({
      name: 'Friend',
      email: 'friend@example.com',
      passwordHash: hashHex,
      passwordSalt: saltHex,
    });
    assert.deepEqual(db.getAuthBootstrapStatus(), {
      hasUsers: true,
      unclaimedGamesCount: 0,
      unclaimedEntriesCount: 0,
    });
    assert.equal(db.listGames({ userId: secondUser.id }).length, 9);
    assert.equal(db.listEntries({ userId: secondUser.id }).length, 0);
    db.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('auto-reparses generic/outdated entries on startup while respecting manual_override', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-games-reparse-'));
  const dbPath = path.join(tmpDir, 'reparse.db');

  try {
    const db1 = createDatabase({ dbPath });
    const { hashHex, saltHex } = await hashPassword('password123');
    const user = db1.registerUser({
      name: 'Alice',
      email: 'alice@example.com',
      passwordHash: hashHex,
      passwordSalt: saltHex,
    });
    const wordle = db1.createGame(
      {
        name: 'Wordle',
        url: 'nytimes.com/games/wordle',
        metricLabel: 'Guesses',
        metricFormat: 'fraction',
        metricDirection: 'lower_is_better',
      },
      user.id,
    );
    assert.equal(wordle.resolvedParser.id, 'wordle');
    assert.equal(wordle.resolvedParser.isCustomParser, true);

    const now = new Date().toISOString();
    db1.sqlite
      .prepare(`
        INSERT INTO entries (
          user_id, game_id, play_date, raw_text, parser_id, parser_version,
          completed, solved, primary_value, display_value, puzzle_id,
          breakdown_json, metadata_json, notes, manual_override, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'generic', 1, 1, NULL, NULL, 'Played', NULL, '[]', '{}', '', 0, ?, ?)
      `)
      .run(
        user.id,
        wordle.id,
        '2026-11-10',
        'Wordle 1,234 4/6\n\n⬛🟨⬛⬛🟩\n🟩🟩🟩🟩🟩',
        now,
        now,
      );

    db1.sqlite
      .prepare(`
        INSERT INTO entries (
          user_id, game_id, play_date, raw_text, parser_id, parser_version,
          completed, solved, primary_value, display_value, puzzle_id,
          breakdown_json, metadata_json, notes, manual_override, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'generic', 1, 1, 1, 2, '2/6', '#1233', '[]', '{}', 'manual fix', 1, ?, ?)
      `)
      .run(
        user.id,
        wordle.id,
        '2026-11-09',
        'Wordle 1,233 5/6\n\n🟩🟩🟩🟩🟩',
        now,
        now,
      );

    db1.close();

    const db2 = createDatabase({ dbPath });
    const upgraded = db2.getEntryByGameAndDate(wordle.id, '2026-11-10', user.id);
    assert.equal(upgraded.parserId, 'wordle');
    assert.equal(upgraded.solved, true);
    assert.equal(upgraded.primaryValue, 4);
    assert.equal(upgraded.displayValue, '4/6');
    assert.equal(upgraded.puzzleId, '#1234');

    const untouched = db2.getEntryByGameAndDate(wordle.id, '2026-11-09', user.id);
    assert.equal(untouched.manualOverride, true);
    assert.equal(untouched.primaryValue, 2);
    assert.equal(untouched.displayValue, '2/6');
    assert.equal(untouched.notes, 'manual fix');
    db2.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('auth lifecycle, CSRF Sec-Fetch-Site protection, cookie attributes, and strict user isolation', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.close());

  const alice = ctx.createClient();
  const bob = ctx.createClient();

  // Unauthenticated checks
  const health = await alice.request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');

  const meAnon = await alice.request('/api/auth/me');
  assert.equal(meAnon.status, 200);
  assert.equal(meAnon.json.authenticated, false);
  assert.equal(meAnon.json.user, null);
  assert.equal(meAnon.json.hasUsers, false);
  assert.deepEqual(meAnon.json.unclaimed, { gamesCount: 0, entriesCount: 0 });

  for (const protectedRoute of ['/api/bootstrap', '/api/games', '/api/entries', '/api/stats', '/api/export']) {
    const unauth = await alice.request(protectedRoute);
    assert.equal(unauth.status, 401, `Expected 401 on ${protectedRoute}`);
  }

  // Sec-Fetch-Site: cross-site -> 403 before auth
  const csrfBlocked = await alice.request('/api/auth/register', {
    method: 'POST',
    headers: { 'Sec-Fetch-Site': 'cross-site' },
    body: { name: 'Eve', email: 'eve@example.com', password: 'password123' },
  });
  assert.equal(csrfBlocked.status, 403);
  assert.match(csrfBlocked.headers.get('vary') || '', /Sec-Fetch-Site/i);

  // Validation errors on register
  const badEmail = await alice.request('/api/auth/register', {
    method: 'POST',
    body: { name: 'Alice', email: 'not-an-email', password: 'password123' },
  });
  assert.equal(badEmail.status, 400);

  const shortPass = await alice.request('/api/auth/register', {
    method: 'POST',
    body: { name: 'Alice', email: 'alice@example.com', password: 'short' },
  });
  assert.equal(shortPass.status, 400);

  // Register Alice with Unicode name + verify HTTP cookie
  const regAlice = await alice.request('/api/auth/register', {
    method: 'POST',
    body: { name: 'Renée 🎮', email: 'Alice@Example.com', password: 'password123' },
  });
  assert.equal(regAlice.status, 201);
  assert.equal(regAlice.json.authenticated, true);
  assert.equal(regAlice.json.user.email, 'alice@example.com');
  assert.equal(regAlice.json.user.displayName, 'Renée 🎮');
  const setCookie = regAlice.headers.get('set-cookie') || '';
  assert.match(setCookie, /^dg_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);

  // Duplicate email (case-insensitive) -> 409
  const dup = await bob.request('/api/auth/register', {
    method: 'POST',
    body: { name: 'Dup', email: 'ALICE@example.com', password: 'password123' },
  });
  assert.equal(dup.status, 409);

  // Register via X-Forwarded-Proto: https issues __Host-dg_session
  const httpsReg = await ctx.createClient().request('/api/auth/register', {
    method: 'POST',
    headers: { 'x-forwarded-proto': 'https' },
    body: { name: 'HTTPS User', email: 'https@example.com', password: 'password123' },
  });
  assert.equal(httpsReg.status, 201);
  assert.match(httpsReg.headers.get('set-cookie') || '', /^__Host-dg_session=.*Secure/i);

  // Alice creates a game & logs an entry
  const aliceGameRes = await alice.request('/api/games', {
    method: 'POST',
    body: { name: 'Alice Secret Game', url: 'https://alice.example.com' },
  });
  assert.equal(aliceGameRes.status, 201);
  const aliceGame = aliceGameRes.json.game;

  const aliceEntryRes = await alice.request('/api/entries', {
    method: 'POST',
    body: { gameId: aliceGame.id, playDate: '2026-11-15', primaryValue: 999 },
  });
  assert.equal(aliceEntryRes.status, 201);
  const aliceEntry = aliceEntryRes.json.entry;

  // Register Bob and verify strict isolation
  await registerUser(bob, { name: 'Bob', email: 'bob@example.com', password: 'password123' });

  const bobBoot = await bob.request('/api/bootstrap?date=2026-11-15');
  assert.equal(bobBoot.status, 200);
  assert.equal(bobBoot.json.user.email, 'bob@example.com');
  assert.equal(bobBoot.json.games.length, 9);
  assert.equal(bobBoot.json.entriesForDate.length, 0);

  // Bob probing Alice's IDs must fail with 404
  assert.equal(
    (await bob.request(`/api/games/${aliceGame.id}`, { method: 'PUT', body: { name: 'Hacked' } })).status,
    404,
  );
  assert.equal((await bob.request(`/api/games/${aliceGame.id}`, { method: 'DELETE' })).status, 404);
  assert.equal(
    (await bob.request(`/api/games/${aliceGame.id}/reparse`, { method: 'POST', body: {} })).status,
    404,
  );
  assert.equal((await bob.request(`/api/stats?gameId=${aliceGame.id}`)).status, 404);
  assert.equal(
    (await bob.request(`/api/entries/${aliceEntry.id}`, { method: 'PUT', body: { notes: 'x' } })).status,
    404,
  );
  assert.equal((await bob.request(`/api/entries/${aliceEntry.id}`, { method: 'DELETE' })).status, 404);
  assert.equal(
    (await bob.request('/api/entries', { method: 'POST', body: { gameId: aliceGame.id, playDate: '2026-11-15', primaryValue: 1 } })).status,
    404,
  );
  assert.equal(
    (await bob.request('/api/games/reorder', { method: 'PUT', body: { orderedIds: [aliceGame.id] } })).status,
    404,
  );
  assert.deepEqual((await bob.request(`/api/entries?gameId=${aliceGame.id}`)).json.entries, []);

  // Logout & Clear-Site-Data + Login errors
  const logoutRes = await alice.request('/api/auth/logout', { method: 'POST' });
  assert.equal(logoutRes.status, 200);
  assert.equal(logoutRes.headers.get('clear-site-data'), '"cookies"');
  const meAfterLogout = await alice.request('/api/auth/me');
  assert.equal(meAfterLogout.json.authenticated, false);
  assert.equal(meAfterLogout.json.user, null);
  assert.equal(meAfterLogout.json.hasUsers, true);
  assert.deepEqual(meAfterLogout.json.unclaimed, { gamesCount: 0, entriesCount: 0 });
  assert.equal((await alice.request('/api/bootstrap')).status, 401);

  const badLogin = await alice.request('/api/auth/login', {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'wrong-password' },
  });
  assert.equal(badLogin.status, 401);

  const missingLogin = await alice.request('/api/auth/login', {
    method: 'POST',
    body: { email: 'nobody@example.com', password: 'password123' },
  });
  assert.equal(missingLogin.status, 401);

  const goodLogin = await alice.request('/api/auth/login', {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'password123' },
  });
  assert.equal(goodLogin.status, 200);
  assert.equal(goodLogin.json.authenticated, true);
  assert.equal((await alice.request('/api/auth/me')).json.user.email, 'alice@example.com');
});

test('REST API bootstrap, games CRUD, URL normalization, reorder, and static security', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.close());
  await registerUser(ctx);

  const badBoot = await ctx.request('/api/bootstrap?date=bad-date');
  assert.equal(badBoot.status, 400);
  assert.ok(badBoot.json.error);

  const boot = await ctx.request('/api/bootstrap?date=2026-11-15');
  assert.equal(boot.status, 200);
  assert.equal(boot.json.date, '2026-11-15');
  assert.equal(boot.json.user.email, 'alice@example.com');
  assert.equal(boot.json.games.length, 9);
  assert.equal(boot.json.dailyOverview.activeGamesCount, 9);
  assert.equal(boot.json.dailyOverview.playedTodayCount, 0);
  assert.ok(Array.isArray(boot.json.parsers));
  assert.ok(boot.json.parsers.some((p) => p.id === 'generic'));
  assert.ok(boot.json.parsers.some((p) => p.id === 'cluesbysam'));
  assert.ok(boot.json.parsers.some((p) => p.id === 'plain'));
  assert.ok(boot.json.parsers.some((p) => p.id === 'timeguessr'));
  assert.ok(boot.json.parsers.some((p) => p.id === 'wordle'));

  const created1 = await ctx.request('/api/games', {
    method: 'POST',
    body: {
      name: 'Wordle',
      url: 'nytimes.com/games/wordle',
      icon: '🟩',
      category: 'Word',
      metricLabel: 'Guesses',
      metricFormat: 'fraction',
      metricDirection: 'lower_is_better',
    },
  });
  assert.equal(created1.status, 201);
  assert.equal(created1.json.game.url, 'https://nytimes.com/games/wordle');
  assert.equal(created1.json.game.slug, 'wordle');
  assert.equal(created1.json.game.resolvedParser.id, 'wordle');
  assert.equal(created1.json.game.resolvedParser.isCustomParser, true);

  const created2 = await ctx.request('/api/games', {
    method: 'POST',
    body: { name: 'Wordle', url: 'https://example.com/wordle-2' },
  });
  assert.equal(created2.status, 201);
  assert.equal(created2.json.game.slug, 'wordle-2');

  const badGame = await ctx.request('/api/games', {
    method: 'POST',
    body: { name: 'Bad', url: 'https://example.com', metricFormat: 'bogus' },
  });
  assert.equal(badGame.status, 400);

  const badTz = await ctx.request('/api/games', {
    method: 'POST',
    body: { name: 'BadTZ', url: 'https://example.com', resetTimezone: 'Mars/Olympus' },
  });
  assert.equal(badTz.status, 400);

  const badTime = await ctx.request('/api/games', {
    method: 'POST',
    body: { name: 'BadTime', url: 'https://example.com', resetTime: '25:99' },
  });
  assert.equal(badTime.status, 400);

  const customTzGame = await ctx.request('/api/games', {
    method: 'POST',
    body: {
      name: 'Custom Reset',
      url: 'https://custom.example.com',
      resetTimezone: 'Asia/Tokyo',
      resetTime: '04:30',
    },
  });
  assert.equal(customTzGame.status, 201);
  assert.equal(customTzGame.json.game.resetTimezone, 'Asia/Tokyo');
  assert.equal(customTzGame.json.game.resetTime, '04:30');

  const updatedCustomTz = await ctx.request(`/api/games/${customTzGame.json.game.id}`, {
    method: 'PUT',
    body: { resetTimezone: 'Europe/London', resetTime: '06:00' },
  });
  assert.equal(updatedCustomTz.status, 200);
  assert.equal(updatedCustomTz.json.game.resetTimezone, 'Europe/London');
  assert.equal(updatedCustomTz.json.game.resetTime, '06:00');
  await ctx.request(`/api/games/${customTzGame.json.game.id}`, { method: 'DELETE' });

  const listRes = await ctx.request('/api/games');
  const ids = listRes.json.games.map((g) => g.id);
  const reversed = [...ids].reverse();
  const reorderRes = await ctx.request('/api/games/reorder', {
    method: 'PUT',
    body: { orderedIds: reversed },
  });
  assert.equal(reorderRes.status, 200);
  assert.deepEqual(
    reorderRes.json.games.map((g) => g.id),
    reversed,
  );

  const updatedRes = await ctx.request(`/api/games/${created2.json.game.id}`, {
    method: 'PUT',
    body: { archived: true, url: 'example.com/updated' },
  });
  assert.equal(updatedRes.status, 200);
  assert.equal(updatedRes.json.game.archived, true);
  assert.equal(updatedRes.json.game.url, 'https://example.com/updated');

  const delRes = await ctx.request(`/api/games/${created2.json.game.id}`, {
    method: 'DELETE',
  });
  assert.equal(delRes.status, 200);
  assert.equal(delRes.json.ok, true);

  const delMissing = await ctx.request(`/api/games/${created2.json.game.id}`, {
    method: 'DELETE',
  });
  assert.equal(delMissing.status, 404);

  const sharedJs = await ctx.request('/shared/parsers/registry.js');
  assert.equal(sharedJs.status, 200);
  assert.match(sharedJs.headers.get('content-type') || '', /application\/javascript/);

  const authCryptoJs = await ctx.request('/shared/auth-crypto.js');
  assert.equal(authCryptoJs.status, 200);
  assert.match(authCryptoJs.headers.get('content-type') || '', /application\/javascript/);

  const traversal1 = await ctx.request('/shared/%2e%2e/package.json');
  assert.ok(traversal1.status === 403 || traversal1.status === 404);
  assert.ok(!traversal1.text.includes('"daily-games-hub"'));

  const traversal2 = await ctx.request('/../../package.json');
  assert.ok(traversal2.status === 403 || traversal2.status === 404);
  assert.ok(!traversal2.text.includes('"daily-games-hub"'));
});

test('detect, entries upsert/edit/delete, reparse, and stats for higher_is_better & lower_is_better', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.close());
  await registerUser(ctx);

  const gamesRes = await ctx.request('/api/games');
  const cluesGame = gamesRes.json.games.find((g) => g.slug === 'cluesbysam');
  const farflungGame = gamesRes.json.games.find((g) => g.slug === 'farflung');
  const krillionGame = gamesRes.json.games.find((g) => g.slug === 'krillion');

  const wordleRes = await ctx.request('/api/games', {
    method: 'POST',
    body: {
      name: 'Wordle',
      url: 'https://www.nytimes.com/games/wordle',
      metricLabel: 'Guesses',
      metricFormat: 'fraction',
      metricDirection: 'lower_is_better',
    },
  });
  const wordleGame = wordleRes.json.game;

  const detectWordle = await ctx.request('/api/detect', {
    method: 'POST',
    body: {
      rawText: 'Wordle 1,240 3/6\n\n⬛🟨⬛⬛🟩\n🟩🟩🟩🟩🟩',
    },
  });
  assert.equal(detectWordle.status, 200);
  assert.equal(detectWordle.json.matchedGame?.id, wordleGame.id);
  assert.equal(detectWordle.json.parserId, 'wordle');
  assert.equal(detectWordle.json.parsed.primaryValue, 3);

  const cluesDays = [
    { date: '2026-11-11', rawText: 'Clues by Sam #101\nSolved in 2:30' },
    { date: '2026-11-12', rawText: 'Clues by Sam #102\nSolved in 1:35' },
    { date: '2026-11-13', rawText: 'Clues by Sam #103\nSolved in 2:00' },
    { date: '2026-11-14', rawText: 'Clues by Sam #104\nSolved in 1:50' },
  ];
  for (const item of cluesDays) {
    const res = await ctx.request('/api/entries', {
      method: 'POST',
      body: {
        gameId: cluesGame.id,
        playDate: item.date,
        rawText: item.rawText,
      },
    });
    assert.equal(res.status, 201);
  }

  const upsertUpdate = await ctx.request('/api/entries', {
    method: 'POST',
    body: {
      gameId: cluesGame.id,
      playDate: '2026-11-14',
      rawText: 'Clues by Sam #104\nSolved in 1:45',
      notes: 'updated run',
    },
  });
  assert.equal(upsertUpdate.status, 201);
  assert.equal(upsertUpdate.json.entry.primaryValue, 105);
  assert.equal(upsertUpdate.json.entry.notes, 'updated run');

  const cluesEntries = await ctx.request(`/api/entries?gameId=${cluesGame.id}`);
  assert.equal(cluesEntries.json.entries.length, 4);

  for (const [date, val] of [
    ['2026-11-12', 520],
    ['2026-11-13', 910],
    ['2026-11-14', 780],
    ['2026-11-15', 840],
  ]) {
    const res = await ctx.request('/api/entries', {
      method: 'POST',
      body: {
        gameId: farflungGame.id,
        playDate: date,
        primaryValue: val,
        manualOverride: true,
      },
    });
    assert.equal(res.status, 201);
  }

  const noScore = await ctx.request('/api/entries', {
    method: 'POST',
    body: {
      gameId: krillionGame.id,
      playDate: '2026-11-15',
      completed: true,
    },
  });
  assert.equal(noScore.status, 201);
  assert.equal(noScore.json.entry.primaryValue, null);
  assert.equal(noScore.json.entry.displayValue, 'Played');

  const boot = await ctx.request('/api/bootstrap?date=2026-11-15');
  assert.equal(boot.status, 200);
  const cluesSummary = boot.json.cardSummaries[cluesGame.id];
  assert.equal(cluesSummary.currentStreak, 4);
  assert.equal(cluesSummary.longestStreak, 4);
  assert.equal(cluesSummary.personalBest.value, 95);
  assert.equal(cluesSummary.personalBest.playDate, '2026-11-12');
  assert.equal(cluesSummary.recentSparkline.length, 14);
  assert.equal(cluesSummary.recentSparkline[13].playDate, '2026-11-15');
  assert.equal(cluesSummary.recentSparkline[13].completed, false);

  const farflungSummary = boot.json.cardSummaries[farflungGame.id];
  assert.equal(farflungSummary.personalBest.value, 910);
  assert.equal(farflungSummary.personalBest.playDate, '2026-11-13');

  assert.equal(boot.json.dailyOverview.activeGamesCount, 10);
  assert.equal(boot.json.dailyOverview.playedTodayCount, 2);
  assert.equal(boot.json.dailyOverview.routineStreak, 5);
  assert.equal(boot.json.dailyOverview.playedTodayInStreak, true);
  assert.equal(boot.json.dailyOverview.fullSweepDays, 0);

  const cluesStatsRes = await ctx.request(
    `/api/stats?gameId=${cluesGame.id}&date=2026-11-15&days=30`,
  );
  assert.equal(cluesStatsRes.status, 200);
  assert.equal(cluesStatsRes.json.heatmap.length, 91);
  assert.equal(cluesStatsRes.json.heatmap[90].date, '2026-11-15');
  assert.equal(cluesStatsRes.json.heatmap[90].count, 2);
  assert.equal(cluesStatsRes.json.gameStats.kpis.personalBest.value, 95);
  assert.equal(cluesStatsRes.json.gameStats.kpis.totalPlayed, 4);
  assert.equal(cluesStatsRes.json.gameStats.kpis.currentStreak, 4);
  const pbTrend = cluesStatsRes.json.gameStats.trendSeries.find((p) => p.playDate === '2026-11-12');
  assert.equal(pbTrend.isPersonalBest, true);
  assert.equal(
    cluesStatsRes.json.gameStats.trendSeries.filter((p) => p.isPersonalBest).length,
    1,
  );
  assert.ok(cluesStatsRes.json.gameStats.distribution.length >= 1);

  const targetEntry = cluesEntries.json.entries.find((e) => e.playDate === '2026-11-11');
  const putRes = await ctx.request(`/api/entries/${targetEntry.id}`, {
    method: 'PUT',
    body: { notes: 'edited note' },
  });
  assert.equal(putRes.status, 200);
  assert.equal(putRes.json.entry.notes, 'edited note');
  assert.equal(putRes.json.entry.primaryValue, 150);

  const conflictRes = await ctx.request(`/api/entries/${targetEntry.id}`, {
    method: 'PUT',
    body: { playDate: '2026-11-12' },
  });
  assert.equal(conflictRes.status, 409);

  await ctx.request('/api/entries', {
    method: 'POST',
    body: {
      gameId: wordleGame.id,
      playDate: '2026-11-14',
      rawText: 'Wordle 1,239 4/6\n\n🟩🟩🟩🟩🟩',
    },
  });
  await ctx.request('/api/entries', {
    method: 'POST',
    body: {
      gameId: wordleGame.id,
      playDate: '2026-11-15',
      rawText: 'Wordle 1,240 X/6\n\n⬛⬛⬛⬛⬛',
    },
  });
  const wordleStats = await ctx.request(
    `/api/stats?gameId=${wordleGame.id}&date=2026-11-15`,
  );
  assert.equal(wordleStats.json.gameStats.kpis.totalPlayed, 2);
  assert.equal(wordleStats.json.gameStats.kpis.solvedCount, 1);
  assert.equal(wordleStats.json.gameStats.kpis.winRate, 50);

  const reparseForce = await ctx.request(`/api/games/${wordleGame.id}/reparse`, {
    method: 'POST',
    body: { force: true },
  });
  assert.equal(reparseForce.status, 200);
  assert.equal(reparseForce.json.updatedCount, 2);
  assert.equal(reparseForce.json.parser.id, 'wordle');

  const delEntry = await ctx.request(`/api/entries/${targetEntry.id}`, { method: 'DELETE' });
  assert.equal(delEntry.status, 200);
  assert.equal(delEntry.json.ok, true);
});

test('export and import (replace & merge modes) are user-scoped and preserve games, entries, and breakdown', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.close());

  const alice = ctx.createClient();
  const bob = ctx.createClient();
  await registerUser(alice, { name: 'Alice', email: 'alice@example.com' });
  await registerUser(bob, { name: 'Bob', email: 'bob@example.com' });

  const bobGames = (await bob.request('/api/games')).json.games;
  await bob.request('/api/entries', {
    method: 'POST',
    body: { gameId: bobGames[0].id, playDate: '2026-11-15', primaryValue: 120 },
  });

  const gamesRes = await alice.request('/api/games');
  const perceptle = gamesRes.json.games.find((g) => g.slug === 'perceptle');

  await alice.request('/api/entries', {
    method: 'POST',
    body: {
      gameId: perceptle.id,
      playDate: '2026-11-15',
      primaryValue: 860,
      displayValue: '860',
      breakdown: [
        { label: 'Round 1', value: 180, max: 200 },
        { label: 'Round 2', value: 165, max: 200 },
      ],
      metadata: { source: 'test' },
      manualOverride: true,
    },
  });

  const exported = await alice.request('/api/export');
  assert.equal(exported.status, 200);
  assert.equal(exported.json.version, 1);
  assert.equal(exported.json.games.length, 9);
  assert.equal(exported.json.entries.length, 1);

  await alice.request('/api/games', {
    method: 'POST',
    body: { name: 'Temp Game', url: 'https://temp.example.com' },
  });
  assert.equal((await alice.request('/api/games')).json.games.length, 10);

  const replaceRes = await alice.request('/api/import', {
    method: 'POST',
    body: {
      games: exported.json.games,
      entries: exported.json.entries,
      mode: 'replace',
    },
  });
  assert.equal(replaceRes.status, 200);
  assert.equal(replaceRes.json.ok, true);
  assert.equal(replaceRes.json.gamesCount, 9);
  assert.equal(replaceRes.json.entriesCount, 1);

  // Bob's data must remain completely untouched by Alice's replace import!
  assert.equal((await bob.request('/api/entries')).json.entries.length, 1);

  const gamesAfter = (await alice.request('/api/games')).json.games;
  assert.equal(gamesAfter.length, 9);

  const statsAfter = await alice.request(`/api/stats?gameId=${perceptle.id}&date=2026-11-15`);
  assert.equal(statsAfter.json.gameStats.breakdownSummary.length, 2);
  assert.equal(statsAfter.json.gameStats.breakdownSummary[0].label, 'Round 1');
  assert.equal(statsAfter.json.gameStats.breakdownSummary[0].avgValue, 180);

  const mergeRes = await alice.request('/api/import', {
    method: 'POST',
    body: {
      games: [{ id: 999, name: 'Wordle', slug: 'wordle', url: 'https://www.nytimes.com/games/wordle' }],
      entries: [
        {
          gameId: 999,
          playDate: '2026-11-15',
          primaryValue: 3,
          displayValue: '3/6',
          solved: true,
          completed: true,
        },
      ],
      mode: 'merge',
    },
  });
  assert.equal(mergeRes.status, 200);
  const gamesAfterMerge = (await alice.request('/api/games')).json.games;
  assert.equal(gamesAfterMerge.length, 10);
  const importedWordle = gamesAfterMerge.find((g) => g.slug === 'wordle');
  assert.equal(importedWordle.resetTimezone, 'local');
  assert.equal(importedWordle.resetTime, '00:00');
  assert.equal((await alice.request('/api/entries')).json.entries.length, 2);
});

test('live bootstrap (?live=1&tz=...) handles off-local activePuzzleDate and omitted playDate defaults to activePuzzleDate', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.close());
  await registerUser(ctx);

  const badTzBoot = await ctx.request('/api/bootstrap?live=1&tz=Invalid/Zone');
  assert.equal(badTzBoot.status, 400);

  const honoluluGameRes = await ctx.request('/api/games', {
    method: 'POST',
    body: {
      name: 'Honolulu Puzzle',
      url: 'https://honolulu.example.com',
      resetTimezone: 'Pacific/Honolulu',
      resetTime: '00:00',
    },
  });
  assert.equal(honoluluGameRes.status, 201);
  const honoluluGame = honoluluGameRes.json.game;

  const bootLive = await ctx.request('/api/bootstrap?live=1&tz=Pacific/Kiritimati');
  assert.equal(bootLive.status, 200);

  const honoluluSummary = bootLive.json.cardSummaries[honoluluGame.id];
  assert.ok(honoluluSummary.puzzleStatus);
  assert.equal(honoluluSummary.puzzleStatus.isOffLocalDate, true);
  assert.notEqual(honoluluSummary.puzzleStatus.activePuzzleDate, bootLive.json.date);

  const saveRes = await ctx.request('/api/entries', {
    method: 'POST',
    body: {
      gameId: honoluluGame.id,
      playDate: honoluluSummary.puzzleStatus.activePuzzleDate,
      primaryValue: 777,
    },
  });
  assert.equal(saveRes.status, 201);

  const bootLiveAfter = await ctx.request('/api/bootstrap?live=1&tz=Pacific/Kiritimati');
  assert.equal(bootLiveAfter.status, 200);
  assert.equal(
    bootLiveAfter.json.entriesForDate.some((e) => e.gameId === honoluluGame.id && e.primaryValue === 777),
    true,
  );
  assert.equal(bootLiveAfter.json.dailyOverview.playedTodayCount, 1);
  assert.equal(bootLiveAfter.json.cardSummaries[honoluluGame.id].currentStreak, 1);

  const bootStatic = await ctx.request(`/api/bootstrap?date=${bootLive.json.date}`);
  assert.equal(bootStatic.status, 200);
  assert.equal(
    bootStatic.json.entriesForDate.some((e) => e.gameId === honoluluGame.id),
    false,
  );

  const omittedDateEntry = await ctx.request('/api/entries', {
    method: 'POST',
    body: {
      gameId: honoluluGame.id,
      primaryValue: 888,
    },
  });
  assert.equal(omittedDateEntry.status, 201);
  assert.equal(
    omittedDateEntry.json.entry.playDate,
    getGamePuzzleStatus(honoluluGame).activePuzzleDate,
  );
});

test('stats live-cycle unit test anchors streaks and daily overview per game activePuzzleDate', () => {
  const now = new Date('2026-11-16T06:00:00Z');
  const games = [
    {
      id: 1,
      name: 'Farflung',
      slug: 'farflung',
      metricFormat: 'number',
      metricDirection: 'higher_is_better',
      resetTimezone: 'UTC',
      resetTime: '00:00',
      archived: false,
      sortOrder: 1,
    },
    {
      id: 2,
      name: 'PricePoint',
      slug: 'pricepoint',
      metricFormat: 'number',
      metricDirection: 'higher_is_better',
      resetTimezone: 'America/Los_Angeles',
      resetTime: '00:00',
      archived: false,
      sortOrder: 2,
    },
  ];

  const entries = [
    { id: 1, gameId: 1, playDate: '2026-11-15', completed: true, solved: null, primaryValue: 400, displayValue: '400' },
    { id: 2, gameId: 1, playDate: '2026-11-16', completed: true, solved: null, primaryValue: 500, displayValue: '500' },
    { id: 3, gameId: 2, playDate: '2026-11-14', completed: true, solved: null, primaryValue: 300, displayValue: '300' },
    { id: 4, gameId: 2, playDate: '2026-11-15', completed: true, solved: null, primaryValue: 600, displayValue: '600' },
  ];

  const summaries = computeCardSummaries(games, entries, '2026-11-16', {
    live: true,
    now,
    viewerTimeZone: 'Asia/Kolkata',
  });
  assert.equal(summaries[1].puzzleStatus.activePuzzleDate, '2026-11-16');
  assert.equal(summaries[2].puzzleStatus.activePuzzleDate, '2026-11-15');
  assert.equal(summaries[2].puzzleStatus.isOffLocalDate, true);
  assert.equal(summaries[1].currentStreak, 2);
  assert.equal(summaries[2].currentStreak, 2);
  assert.equal(summaries[2].recentSparkline[13].playDate, '2026-11-15');
  assert.equal(summaries[2].recentSparkline[13].completed, true);

  const overview = computeDailyOverview(games, entries, '2026-11-16', {
    live: true,
    now,
    viewerTimeZone: 'Asia/Kolkata',
  });
  assert.equal(overview.activeGamesCount, 2);
  assert.equal(overview.playedTodayCount, 2);
  assert.equal(overview.playedTodayInStreak, true);
  assert.equal(overview.routineStreak, 2);
  assert.equal(overview.fullSweepDays, 2);
});

test('stats unit tests: streaks edge cases, rolling avg, median, distribution, fullSweepDays', () => {
  const streak1 = computeStreaks(
    [
      { playDate: '2026-11-10', completed: true },
      { playDate: '2026-11-11', completed: true },
      { playDate: '2026-11-12', completed: true },
      { playDate: '2026-11-14', completed: true },
      { playDate: '2026-11-15', completed: true },
    ],
    '2026-11-15',
  );
  assert.equal(streak1.currentStreak, 2);
  assert.equal(streak1.longestStreak, 3);

  const streak2 = computeStreaks(
    [
      { playDate: '2026-11-12', completed: true },
      { playDate: '2026-11-13', completed: true },
    ],
    '2026-11-15',
  );
  assert.equal(streak2.currentStreak, 0);
  assert.equal(streak2.longestStreak, 2);

  const fakeGame = {
    id: 1,
    name: 'Test',
    slug: 'test',
    metricFormat: 'number',
    metricDirection: 'higher_is_better',
  };
  const gs = computeGameStats(
    fakeGame,
    [
      { id: 1, gameId: 1, playDate: '2026-11-01', completed: true, solved: null, primaryValue: 100, displayValue: '100', rawText: '100', breakdown: [] },
      { id: 2, gameId: 1, playDate: '2026-11-12', completed: true, solved: null, primaryValue: 200, displayValue: '200', rawText: '200', breakdown: [] },
      { id: 3, gameId: 1, playDate: '2026-11-13', completed: true, solved: null, primaryValue: 300, displayValue: '300', rawText: '300', breakdown: [] },
      { id: 4, gameId: 1, playDate: '2026-11-14', completed: true, solved: null, primaryValue: 400, displayValue: '400', rawText: '400', breakdown: [] },
      { id: 5, gameId: 1, playDate: '2026-11-15', completed: true, solved: null, primaryValue: 500, displayValue: '500', rawText: '500', breakdown: [] },
    ],
    { days: 7, referenceDate: '2026-11-15' },
  );
  assert.equal(gs.kpis.totalPlayed, 4);
  assert.equal(gs.kpis.averageValue, 350);
  assert.equal(gs.kpis.medianValue, 350);
  assert.equal(gs.kpis.personalBest.value, 500);
  assert.equal(gs.kpis.winRate, null);
});

test('multi-player GET /api/leaderboard: all users, 1224 ties, direction scoring, privacy & spoiler shield', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.close());

  const anon = ctx.createClient();
  const unauthRes = await anon.request('/api/leaderboard');
  assert.equal(unauthRes.status, 401);

  const alice = ctx.createClient();
  const bob = ctx.createClient();
  const charlie = ctx.createClient();
  const dana = ctx.createClient();

  await registerUser(alice, { name: 'Alice', email: 'alice-lb@example.com' });
  await registerUser(bob, { name: 'Bob', email: 'bob-lb@example.com' });
  await registerUser(charlie, { name: 'Charlie', email: 'charlie-lb@example.com' });
  await registerUser(dana, { name: 'Dana', email: 'dana-lb@example.com' }); // 0 plays

  const tz = 'UTC';
  const aliceBoot = await alice.request(`/api/bootstrap?live=1&tz=${tz}`);
  const bobBoot = await bob.request(`/api/bootstrap?live=1&tz=${tz}`);
  const charlieBoot = await charlie.request(`/api/bootstrap?live=1&tz=${tz}`);

  const findGame = (boot, slug) => boot.json.games.find((g) => g.slug === slug);
  const aliceClues = findGame(aliceBoot, 'cluesbysam');
  const bobClues = findGame(bobBoot, 'cluesbysam');
  const charlieClues = findGame(charlieBoot, 'cluesbysam');

  const aliceKrillion = findGame(aliceBoot, 'krillion');
  const bobKrillion = findGame(bobBoot, 'krillion');
  const charlieKrillion = findGame(charlieBoot, 'krillion');

  const cluesActiveDate = aliceBoot.json.cardSummaries[aliceClues.id].puzzleStatus.activePuzzleDate;
  const krillionActiveDate = aliceBoot.json.cardSummaries[aliceKrillion.id].puzzleStatus.activePuzzleDate;
  const oldHistoricalDate = addDays(krillionActiveDate, -2);

  // Clues by Sam (lower_is_better): Alice 1:30 (90s) & Bob 1:30 (90s) tie #1 (gold, 3 pts); Charlie 2:10 (130s) gets rank 3 (bronze, 1 pt)!
  await alice.request('/api/entries', {
    method: 'POST',
    body: { gameId: aliceClues.id, playDate: cluesActiveDate, rawText: 'Clues by Sam #201\nSolved in 1:30' },
  });
  await bob.request('/api/entries', {
    method: 'POST',
    body: { gameId: bobClues.id, playDate: cluesActiveDate, rawText: 'Clues by Sam #201\nSolved in 1:30' },
  });
  await charlie.request('/api/entries', {
    method: 'POST',
    body: { gameId: charlieClues.id, playDate: cluesActiveDate, rawText: 'Clues by Sam #201\nSolved in 2:10' },
  });

  // Krillion (higher_is_better): Alice logs emojiGrid + secret notes on active puzzle date + historical date
  await alice.request('/api/entries', {
    method: 'POST',
    body: {
      gameId: aliceKrillion.id,
      playDate: krillionActiveDate,
      rawText: 'Krillion #300 🦐\n700\n\n🏮🦑🏮🐟🦑🦑🏮',
      notes: 'secret active spoiler',
    },
  });
  await alice.request('/api/entries', {
    method: 'POST',
    body: {
      gameId: aliceKrillion.id,
      playDate: oldHistoricalDate,
      rawText: 'Krillion #298 🦐\n650\n\n🏮🦑🏮🐟🦑🦑🏮',
      notes: 'old public note',
    },
  });

  // Bob adds custom Wordle game with DNF (X/6) -> gets 1 pt, no medal
  const bobWordle = (
    await bob.request('/api/games', {
      method: 'POST',
      body: {
        name: 'Wordle',
        url: 'https://www.nytimes.com/games/wordle',
        metricLabel: 'Guesses',
        metricFormat: 'fraction',
        metricDirection: 'lower_is_better',
      },
    })
  ).json.game;
  const wordleActiveDate = getGamePuzzleStatus(bobWordle, new Date(), tz).activePuzzleDate;
  await bob.request('/api/entries', {
    method: 'POST',
    body: {
      gameId: bobWordle.id,
      playDate: wordleActiveDate,
      rawText: 'Wordle 1,250 X/6\n\n⬛🟨⬛⬛⬛\n⬛⬛⬛⬛⬛',
    },
  });

  // 1. Check Bob's view BEFORE Bob plays Krillion active puzzle -> Alice's Krillion cell MUST be spoiler-protected
  const bobLbBefore = await bob.request(`/api/leaderboard?live=1&tz=${tz}&days=30&gameSlug=krillion`);
  assert.equal(bobLbBefore.status, 200);
  assert.equal(bobLbBefore.json.totalPlayers, 4);
  assert.equal(bobLbBefore.json.overallStandings.length, 4);
  assert.equal(bobLbBefore.json.todayMatrix.rows.length, 4);
  assert.equal(bobLbBefore.json.gameBoard.standings.length, 4);

  // Privacy: zero emails, password hashes, or rawText leaked anywhere
  assert.equal(bobLbBefore.text.includes('alice-lb@example.com'), false);
  assert.equal(bobLbBefore.text.includes('bob-lb@example.com'), false);
  assert.equal(bobLbBefore.text.includes('secret active spoiler'), false);
  assert.equal(bobLbBefore.text.includes('Krillion #300'), false);

  // Dana (0 plays) appears with 0s
  const danaOverall = bobLbBefore.json.overallStandings.find((p) => p.displayName === 'Dana');
  assert.ok(danaOverall);
  assert.equal(danaOverall.arcadePoints, 0);
  assert.equal(danaOverall.totalPlayed, 0);
  assert.equal(danaOverall.clearedTodayCount, 0);
  assert.equal(danaOverall.routineStreak, 0);

  // Spoiler shield active for Bob on Krillion
  const krillionCatalogBefore = bobLbBefore.json.catalogGames.find((g) => g.slug === 'krillion');
  assert.equal(krillionCatalogBefore.viewerCleared, false);
  const aliceKrillionMatrixBefore = bobLbBefore.json.todayMatrix.rows.find(
    (r) => r.displayName === 'Alice',
  ).cells.krillion;
  assert.equal(aliceKrillionMatrixBefore.displayValue, '700');
  assert.equal(aliceKrillionMatrixBefore.rank, 1);
  assert.equal(aliceKrillionMatrixBefore.medal, 'gold');
  assert.equal(aliceKrillionMatrixBefore.spoilerProtected, true);
  assert.equal(aliceKrillionMatrixBefore.emojiGrid, null);
  assert.equal(aliceKrillionMatrixBefore.notes, '');

  // Check historical date (oldHistoricalDate) is NOT spoiler-protected even though Bob never played it
  const bobHistLb = await bob.request(`/api/leaderboard?date=${oldHistoricalDate}&tz=${tz}&gameSlug=krillion`);
  assert.equal(bobHistLb.status, 200);
  const aliceHistCell = bobHistLb.json.todayMatrix.rows.find((r) => r.displayName === 'Alice').cells.krillion;
  assert.equal(aliceHistCell.spoilerProtected, false);
  assert.equal(aliceHistCell.emojiGrid, '🏮🦑🏮🐟🦑🦑🏮');
  assert.equal(aliceHistCell.notes, 'old public note');

  // Check Clues by Sam Olympic "1224" tie + lower_is_better
  const bobCluesLb = await bob.request(`/api/leaderboard?live=1&tz=${tz}&days=30&gameSlug=cluesbysam`);
  assert.equal(bobCluesLb.status, 200);
  const cluesStandings = bobCluesLb.json.gameBoard.standings;
  const aliceCluesRow = cluesStandings.find((s) => s.displayName === 'Alice');
  const bobCluesRow = cluesStandings.find((s) => s.displayName === 'Bob');
  const charlieCluesRow = cluesStandings.find((s) => s.displayName === 'Charlie');
  assert.equal(aliceCluesRow.today.rank, 1);
  assert.equal(aliceCluesRow.today.medal, 'gold');
  assert.equal(aliceCluesRow.gamePoints, 3);
  assert.equal(bobCluesRow.today.rank, 1);
  assert.equal(bobCluesRow.today.medal, 'gold');
  assert.equal(bobCluesRow.gamePoints, 3);
  assert.equal(charlieCluesRow.today.rank, 3);
  assert.equal(charlieCluesRow.today.medal, 'bronze');
  assert.equal(charlieCluesRow.gamePoints, 1);

  // Check Wordle DNF cell (rank: null, medal: null, points: 1, solved: false)
  const bobWordleCell = bobLbBefore.json.todayMatrix.rows.find((r) => r.displayName === 'Bob').cells.wordle;
  assert.equal(bobWordleCell.solved, false);
  assert.equal(bobWordleCell.displayValue, 'X/6');
  assert.equal(bobWordleCell.rank, null);
  assert.equal(bobWordleCell.medal, null);
  assert.equal(bobWordleCell.points, 1);

  // 2. Bob clears Krillion with 900 (> 700) -> unlocks Alice's spoiler shield & Bob takes Gold (3 pts) while Alice drops to Silver (2 pts)!
  await bob.request('/api/entries', {
    method: 'POST',
    body: {
      gameId: bobKrillion.id,
      playDate: krillionActiveDate,
      rawText: 'Krillion #300 🦐\n900\n\n🏮🏮🏮🏮🏮',
    },
  });

  const bobLbAfter = await bob.request(`/api/leaderboard?live=1&tz=${tz}&days=30&gameSlug=krillion`);
  assert.equal(bobLbAfter.status, 200);
  const krillionCatalogAfter = bobLbAfter.json.catalogGames.find((g) => g.slug === 'krillion');
  assert.equal(krillionCatalogAfter.viewerCleared, true);

  const aliceKrillionMatrixAfter = bobLbAfter.json.todayMatrix.rows.find(
    (r) => r.displayName === 'Alice',
  ).cells.krillion;
  assert.equal(aliceKrillionMatrixAfter.spoilerProtected, false);
  assert.equal(aliceKrillionMatrixAfter.emojiGrid, '🏮🦑🏮🐟🦑🦑🏮');
  assert.equal(aliceKrillionMatrixAfter.notes, 'secret active spoiler');
  assert.equal(aliceKrillionMatrixAfter.rank, 2);
  assert.equal(aliceKrillionMatrixAfter.medal, 'silver');
  assert.equal(aliceKrillionMatrixAfter.points, 2);

  const bobKrillionMatrixAfter = bobLbAfter.json.todayMatrix.rows.find(
    (r) => r.displayName === 'Bob',
  ).cells.krillion;
  assert.equal(bobKrillionMatrixAfter.rank, 1);
  assert.equal(bobKrillionMatrixAfter.medal, 'gold');
  assert.equal(bobKrillionMatrixAfter.points, 3);

  // Check listUsersPublic never returns email/password fields
  const publicUsers = ctx.app.db.listUsersPublic();
  assert.equal(publicUsers.length, 4);
  assert.equal(Object.hasOwn(publicUsers[0], 'email'), false);
  assert.equal(Object.hasOwn(publicUsers[0], 'passwordHash'), false);

  // Validate bad days/tz query params return 400
  assert.equal((await bob.request('/api/leaderboard?days=invalid')).status, 400);
  assert.equal((await bob.request('/api/leaderboard?tz=Bad/Zone')).status, 400);
});

test('extractShareGrid & computePlayersLeaderboard unit tests: multi-line grids, single-row grids, and days=all', () => {
  assert.equal(
    extractShareGrid({ metadata: { emojiGrid: '🟩🟩🟩🟩🟩' }, rawText: '' }),
    '🟩🟩🟩🟩🟩',
  );
  assert.equal(
    extractShareGrid({
      metadata: {},
      rawText: 'Krillion #123 🦐\n465\n\n🏮🦑🏮🐟🦑🦑🏮',
    }),
    '🏮🦑🏮🐟🦑🦑🏮',
  );
  assert.equal(
    extractShareGrid({
      metadata: {},
      rawText: 'Size It Up\n#99\nScore: 116/500\n\n🟥🟥⬜⬜⬜ 39\n🟥🟥🟥⬜⬜ 53',
    }),
    '🟥🟥⬜⬜⬜ 39\n🟥🟥🟥⬜⬜ 53',
  );
  assert.equal(
    extractShareGrid({ metadata: {}, rawText: 'Clues by Sam #101\nSolved in 2:14' }),
    null,
  );

  // Window filter days=7 vs days=null ('all')
  const now = new Date('2026-11-16T06:00:00Z');
  const users = [
    { id: 1, displayName: 'Alice', createdAt: '2026-11-01T00:00:00Z' },
    { id: 2, displayName: 'Bob', createdAt: '2026-11-01T00:00:00Z' },
  ];
  const allGames = [
    {
      id: 1,
      userId: 1,
      name: 'Krillion',
      slug: 'krillion',
      url: 'https://krillion.io',
      icon: '🦑',
      color: '#06b6d4',
      category: 'Trivia',
      metricLabel: 'Score',
      metricFormat: 'number',
      metricDirection: 'higher_is_better',
      resetTimezone: 'UTC',
      resetTime: '00:00',
      sortOrder: 1,
      archived: false,
    },
    {
      id: 2,
      userId: 2,
      name: 'Krillion',
      slug: 'krillion',
      url: 'https://krillion.io',
      icon: '🦑',
      color: '#06b6d4',
      category: 'Trivia',
      metricLabel: 'Score',
      metricFormat: 'number',
      metricDirection: 'higher_is_better',
      resetTimezone: 'UTC',
      resetTime: '00:00',
      sortOrder: 1,
      archived: false,
    },
  ];
  const allEntries = [
    { id: 1, userId: 1, gameId: 1, playDate: '2026-10-01', completed: true, solved: null, primaryValue: 900, displayValue: '900', rawText: '900' },
    { id: 2, userId: 1, gameId: 1, playDate: '2026-11-16', completed: true, solved: null, primaryValue: 500, displayValue: '500', rawText: '500' },
    { id: 3, userId: 2, gameId: 2, playDate: '2026-11-16', completed: true, solved: null, primaryValue: 800, displayValue: '800', rawText: '800' },
  ];

  const lb7 = computePlayersLeaderboard({
    users,
    allGames,
    allEntries,
    viewerUserId: 1,
    referenceDate: '2026-11-16',
    days: 7,
    live: true,
    now,
    viewerTimeZone: 'UTC',
  });
  assert.equal(lb7.overallStandings[0].displayName, 'Bob');
  assert.equal(lb7.overallStandings[0].arcadePoints, 3);
  assert.equal(lb7.overallStandings[1].displayName, 'Alice');
  assert.equal(lb7.overallStandings[1].arcadePoints, 2);
  assert.equal(lb7.overallStandings[1].totalPlayed, 1);

  const lbAll = computePlayersLeaderboard({
    users,
    allGames,
    allEntries,
    viewerUserId: 1,
    referenceDate: '2026-11-16',
    days: null,
    live: true,
    now,
    viewerTimeZone: 'UTC',
  });
  const aliceAll = lbAll.overallStandings.find((p) => p.displayName === 'Alice');
  assert.equal(aliceAll.arcadePoints, 5); // 3 pts on 2026-10-01 + 2 pts on 2026-11-16
  assert.equal(aliceAll.totalPlayed, 2);
});

test('shared hub game_catalog, 1-click subscribe/restore, URL dedup, orphan cleanup, and auth gates', async (t) => {
  assert.equal(canonicalUrlKey('https://www.costcodle.com/'), 'costcodle.com');
  assert.equal(canonicalUrlKey('costcodle.com/daily/'), 'costcodle.com/daily');
  assert.equal(canonicalUrlKey('https://example.com/test'), null);
  assert.equal(canonicalUrlKey('http://localhost:4321/a'), null);
  assert.equal(canonicalUrlKey('http://127.0.0.1:8787/b'), null);
  assert.equal(canonicalUrlKey('not a url'), null);

  const ctx = await startTestApp();
  t.after(() => ctx.close());

  const anon = ctx.createClient();
  assert.equal((await anon.request('/api/catalog')).status, 401);
  assert.equal(
    (await anon.request('/api/catalog/subscribe', { method: 'POST', body: { slug: 'cluesbysam' } })).status,
    401,
  );

  const alice = ctx.createClient();
  const bob = ctx.createClient();
  const dana = ctx.createClient();

  await registerUser(alice, { name: 'Alice', email: 'alice-cat@example.com' });
  await registerUser(bob, { name: 'Bob', email: 'bob-cat@example.com' });
  await registerUser(dana, { name: 'Dana', email: 'dana-cat@example.com' });

  // Alice adds "NYT Connections"
  const createConn = await alice.request('/api/games', {
    method: 'POST',
    body: {
      name: 'NYT Connections',
      url: 'https://www.nytimes.com/games/connections',
      icon: '🟪',
      category: 'Word',
      metricLabel: 'Mistakes',
      metricFormat: 'number',
      metricDirection: 'lower_is_better',
    },
  });
  assert.equal(createConn.status, 201);
  assert.equal(createConn.json.game.slug, 'nyt-connections');

  // Bob sees it in GET /api/catalog & /api/bootstrap.catalog & GET /api/leaderboard
  const bobCatalog = await bob.request('/api/catalog');
  assert.equal(bobCatalog.status, 200);
  assert.equal(bobCatalog.text.includes('alice-cat@example.com'), false);
  const connCatForBob = bobCatalog.json.catalog.find((c) => c.slug === 'nyt-connections');
  assert.ok(connCatForBob);
  assert.equal(connCatForBob.viewerStatus, 'not_added');
  assert.equal(connCatForBob.createdByName, 'Alice');
  assert.equal(connCatForBob.playerCount, 1);
  assert.equal(connCatForBob.isStarter, false);

  const bobBoot = await bob.request('/api/bootstrap');
  assert.equal(bobBoot.status, 200);
  assert.ok(Array.isArray(bobBoot.json.catalog));
  assert.equal(
    bobBoot.json.catalog.find((c) => c.slug === 'nyt-connections')?.viewerStatus,
    'not_added',
  );

  const bobLb = await bob.request('/api/leaderboard?gameSlug=nyt-connections');
  assert.equal(bobLb.status, 200);
  assert.equal(bobLb.json.gameBoard.game.slug, 'nyt-connections');
  assert.equal(bobLb.json.gameBoard.game.viewerHasGame, false);
  assert.equal(bobLb.json.gameBoard.game.viewerArchivedGame, false);
  assert.equal(bobLb.json.gameBoard.game.playerCount, 1);

  // Bob subscribes (201) -> repeat (200 already_active) -> archive + restore (200 restored)
  const sub1 = await bob.request('/api/catalog/subscribe', {
    method: 'POST',
    body: { slug: 'nyt-connections' },
  });
  assert.equal(sub1.status, 201);
  assert.equal(sub1.json.status, 'subscribed');
  assert.equal(sub1.json.game.slug, 'nyt-connections');
  assert.equal(sub1.json.game.archived, false);

  const sub2 = await bob.request('/api/catalog/subscribe', {
    method: 'POST',
    body: { slug: 'nyt-connections' },
  });
  assert.equal(sub2.status, 200);
  assert.equal(sub2.json.status, 'already_active');

  await bob.request(`/api/games/${sub1.json.game.id}`, {
    method: 'PUT',
    body: { archived: true },
  });

  const bobLbArchived = await bob.request('/api/leaderboard?gameSlug=nyt-connections');
  assert.equal(bobLbArchived.json.gameBoard.game.viewerHasGame, false);
  assert.equal(bobLbArchived.json.gameBoard.game.viewerArchivedGame, true);

  const sub3 = await bob.request('/api/catalog/subscribe', {
    method: 'POST',
    body: { slug: 'nyt-connections' },
  });
  assert.equal(sub3.status, 200);
  assert.equal(sub3.json.status, 'restored');
  assert.equal(sub3.json.game.archived, false);

  // URL deduplication: Alice adds Costcodle, Dana creates Costco Daily with https://www.costcodle.com/ -> adopts 'costcodle'
  const aliceCostco = await alice.request('/api/games', {
    method: 'POST',
    body: { name: 'Costcodle', url: 'https://costcodle.com' },
  });
  assert.equal(aliceCostco.status, 201);
  assert.equal(aliceCostco.json.game.slug, 'costcodle');

  const danaCostco = await dana.request('/api/games', {
    method: 'POST',
    body: { name: 'Costco Daily', url: 'https://www.costcodle.com/' },
  });
  assert.equal(danaCostco.status, 201);
  assert.equal(danaCostco.json.game.slug, 'costcodle');

  await alice.request('/api/entries', {
    method: 'POST',
    body: { gameId: aliceCostco.json.game.id, playDate: '2026-11-15', primaryValue: 400 },
  });
  await dana.request('/api/entries', {
    method: 'POST',
    body: { gameId: danaCostco.json.game.id, playDate: '2026-11-15', primaryValue: 600 },
  });

  const danaLbCostco = await dana.request('/api/leaderboard?date=2026-11-15&gameSlug=costcodle');
  assert.equal(danaLbCostco.status, 200);
  assert.equal(danaLbCostco.json.catalogGames.filter((g) => g.slug === 'costcodle').length, 1);
  assert.equal(danaLbCostco.json.gameBoard.game.playerCount, 2);
  assert.equal(danaLbCostco.json.gameBoard.standings.find((s) => s.displayName === 'Dana').gamePoints, 3);
  assert.equal(danaLbCostco.json.gameBoard.standings.find((s) => s.displayName === 'Alice').gamePoints, 2);

  // Orphan cleanup: Dana creates & deletes Typo Game (0 other subscribers) -> gone from catalog
  const typoRes = await dana.request('/api/games', {
    method: 'POST',
    body: { name: 'Typo Game', url: 'https://typogame.io' },
  });
  assert.equal(typoRes.status, 201);
  assert.ok((await alice.request('/api/catalog')).json.catalog.some((c) => c.slug === 'typo-game'));

  await dana.request(`/api/games/${typoRes.json.game.id}`, { method: 'DELETE' });
  assert.equal(
    (await alice.request('/api/catalog')).json.catalog.some((c) => c.slug === 'typo-game'),
    false,
  );

  // Alice deletes NYT Connections while Bob keeps it -> stays in catalog with playerCount: 1
  await alice.request(`/api/games/${createConn.json.game.id}`, { method: 'DELETE' });
  const aliceCatalogAfter = (await alice.request('/api/catalog')).json.catalog;
  const connAfter = aliceCatalogAfter.find((c) => c.slug === 'nyt-connections');
  assert.ok(connAfter);
  assert.equal(connAfter.playerCount, 1);
  assert.equal(connAfter.viewerStatus, 'not_added');

  // Unknown catalog slug -> 404
  assert.equal(
    (await alice.request('/api/catalog/subscribe', { method: 'POST', body: { slug: 'does-not-exist' } })).status,
    404,
  );
});

test('Wave 2 migration: appends Plain & TimeGuessr onto existing 7-game shelves without reviving deleted games, upgrades cluesbysam parser, and backfills entry metadata', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-games-wave2-mig-'));
  const dbPath = path.join(tmpDir, 'wave2-legacy.db');

  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE games (
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
      CREATE TABLE entries (
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
      INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at)
      VALUES (1, 'legacy@example.com', 'Legacy Player', 'h', 's', '2026-11-01T00:00:00Z');
      INSERT INTO games (id, user_id, name, slug, url, metric_label, metric_format, metric_direction, parser_id, reset_timezone, reset_time, sort_order, archived, created_at)
      VALUES
        (1, 1, 'Clues by Sam', 'cluesbysam', 'https://cluesbysam.com', 'Solve Time', 'duration_sec', 'lower_is_better', 'auto', 'America/New_York', '00:00', 1, 0, '2026-11-01T00:00:00Z'),
        (2, 1, 'Krillion', 'krillion', 'https://krillion.io', 'Score', 'number', 'higher_is_better', 'auto', 'local', '00:00', 2, 0, '2026-11-01T00:00:00Z'),
        (3, 1, 'Farflung', 'farflung', 'https://farflunggame.fun', 'Score', 'number', 'higher_is_better', 'auto', 'local', '00:00', 3, 0, '2026-11-01T00:00:00Z'),
        (4, 1, 'Perceptle', 'perceptle', 'https://perceptle.com', 'Score', 'number', 'higher_is_better', 'auto', 'local', '00:00', 4, 0, '2026-11-01T00:00:00Z'),
        (5, 1, 'PricePoint', 'pricepoint', 'https://pricepoint.live', 'Score', 'number', 'higher_is_better', 'auto', 'America/Los_Angeles', '00:00', 5, 0, '2026-11-01T00:00:00Z'),
        (6, 1, 'Fermi', 'fermi', 'https://fermi.wtf', 'Score', 'number', 'higher_is_better', 'auto', 'local', '00:00', 6, 0, '2026-11-01T00:00:00Z'),
        (7, 1, 'Magnitudle', 'magnitudle', 'https://magnitudle.com', 'Score', 'number', 'higher_is_better', 'auto', 'local', '00:00', 7, 0, '2026-11-01T00:00:00Z');
      INSERT INTO entries (id, user_id, game_id, play_date, raw_text, parser_id, parser_version, completed, solved, primary_value, display_value, puzzle_id, metadata_json, manual_override, created_at, updated_at)
      VALUES
        (1, 1, 1, '2026-11-10', 'I solved the daily Clues by Sam, Nov 10th 2026 (Hard), in 02:15\n🟩🟩🟩🟩\n🟩🟨🟩🟩', 'generic', 1, 1, 1, 135, '2:15', NULL, '{}', 0, '2026-11-10T01:00:00Z', '2026-11-10T01:00:00Z'),
        (2, 1, 1, '2026-11-11', 'I solved the daily Clues by Sam, Nov 11th 2026 (Easy), in 01:40\n🟩🟩🟩🟩', 'generic', 1, 1, 1, 99, '1:39', NULL, '{"difficulty":"Brutal","difficultyOverride":true}', 1, '2026-11-11T01:00:00Z', '2026-11-11T01:00:00Z');
    `);
    legacy.close();

    const db1 = createDatabase({ dbPath });
    const games = db1.listGames({ userId: 1 });
    assert.equal(games.length, 9);
    const cluesGame = games.find((g) => g.slug === 'cluesbysam');
    assert.equal(cluesGame.parserId, 'cluesbysam');
    assert.equal(cluesGame.resolvedParser.id, 'cluesbysam');
    const plainGame = games.find((g) => g.slug === 'plain');
    const tgGame = games.find((g) => g.slug === 'timeguessr');
    assert.ok(plainGame);
    assert.ok(tgGame);
    assert.equal(plainGame.parserId, 'plain');
    assert.equal(tgGame.parserId, 'timeguessr');

    const catRow = db1.sqlite.prepare("SELECT parser_id FROM game_catalog WHERE slug = 'cluesbysam'").get();
    assert.equal(catRow.parser_id, 'cluesbysam');
    assert.ok(db1.sqlite.prepare("SELECT 1 FROM game_catalog WHERE slug = 'plain'").get());
    assert.ok(db1.sqlite.prepare("SELECT 1 FROM game_catalog WHERE slug = 'timeguessr'").get());

    const autoBackfilled = db1.getEntryById(1, 1);
    assert.equal(autoBackfilled.difficulty, 'Hard');
    assert.equal(autoBackfilled.metadata.difficulty, 'Hard');
    assert.equal(autoBackfilled.metadata.cleanCount, 7);
    assert.equal(autoBackfilled.metadata.yellowCount, 1);
    assert.ok(autoBackfilled.metadata.grid);

    const manualProtected = db1.getEntryById(2, 1);
    assert.equal(manualProtected.primaryValue, 99);
    assert.equal(manualProtected.difficulty, 'Brutal');
    assert.equal(manualProtected.metadata.difficulty, 'Brutal');
    assert.equal(manualProtected.metadata.difficultyOverride, true);

    // User deletes Plain explicitly -> must NOT be revived on reopen
    db1.deleteGame(plainGame.id, 1);
    db1.close();

    const db2 = createDatabase({ dbPath });
    const gamesAfterDelete = db2.listGames({ userId: 1 });
    assert.equal(gamesAfterDelete.length, 8);
    assert.equal(gamesAfterDelete.some((g) => g.slug === 'plain'), false);
    db2.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Clues by Sam difficulty auto-parse, parse-preview, manual override, explicit clear, and stats filtering with unified streaks', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-games-diff-stats-'));
  const dbPath = path.join(tmpDir, 'diff-stats.db');

  try {
    const ctx1 = await startTestApp(dbPath);
    await registerUser(ctx1, { name: 'Alice', email: 'alice@example.com', password: 'password123' });

    const boot = await ctx1.request('/api/bootstrap?date=2026-11-15');
    const cluesGame = boot.json.games.find((g) => g.slug === 'cluesbysam');
    assert.equal(cluesGame.parserId, 'cluesbysam');

    const preview1 = await ctx1.request('/api/entries/parse-preview', {
      method: 'POST',
      body: {
        gameId: cluesGame.id,
        rawText: 'I solved the daily Clues by Sam, Nov 12th 2026 (Medium), in 01:30\n🟩🟩🟩🟩\n🟩🟨🟩🟩',
      },
    });
    assert.equal(preview1.status, 200);
    assert.equal(preview1.json.difficulty, 'Medium');
    assert.equal(preview1.json.supportsDifficulty, true);
    assert.equal(preview1.json.parsed.metadata.difficulty, 'Medium');
    assert.equal(preview1.json.parsed.primaryValue, 90);

    const previewAuto = await ctx1.request('/api/entries/parse-preview', {
      method: 'POST',
      body: {
        rawText: 'I solved the daily Clues by Sam (Brutal) in 04:10\nhttps://cluesbysam.com',
      },
    });
    assert.equal(previewAuto.status, 200);
    assert.equal(previewAuto.json.matchedGame?.id, cluesGame.id);
    assert.equal(previewAuto.json.difficulty, 'Brutal');
    assert.equal(previewAuto.json.supportsDifficulty, true);

    // Log 4 consecutive days with mixed difficulties
    const e1 = await ctx1.request('/api/entries', {
      method: 'POST',
      body: {
        gameId: cluesGame.id,
        playDate: '2026-11-12',
        rawText: 'I solved the daily Clues by Sam, Nov 12th 2026 (Easy), in 01:00\n🟩🟩🟩🟩',
      },
    });
    assert.equal(e1.status, 201);
    assert.equal(e1.json.entry.difficulty, 'Easy');
    assert.equal(e1.json.entry.metadata.difficulty, 'Easy');
    assert.equal(e1.json.entry.metadata.difficultyOverride, undefined);

    const e2 = await ctx1.request('/api/entries', {
      method: 'POST',
      body: {
        gameId: cluesGame.id,
        playDate: '2026-11-13',
        rawText: 'I solved the daily Clues by Sam, Nov 13th 2026 (Hard), in 04:00\n🟩🟩🟩🟨',
      },
    });
    assert.equal(e2.status, 201);
    assert.equal(e2.json.entry.difficulty, 'Hard');

    const e3 = await ctx1.request('/api/entries', {
      method: 'POST',
      body: {
        gameId: cluesGame.id,
        playDate: '2026-11-14',
        rawText: 'I solved the daily Clues by Sam, Nov 14th 2026 (Easy), in 01:30\n🟩🟩🟩🟩',
      },
    });
    assert.equal(e3.status, 201);

    // Override difficulty explicitly on Nov 15
    const e4 = await ctx1.request('/api/entries', {
      method: 'POST',
      body: {
        gameId: cluesGame.id,
        playDate: '2026-11-15',
        rawText: 'I solved the daily Clues by Sam, Nov 15th 2026 (Medium), in 03:00\n🟩🟩🟩🟩',
        difficulty: 'hard',
      },
    });
    assert.equal(e4.status, 201);
    assert.equal(e4.json.entry.difficulty, 'Hard');
    assert.equal(e4.json.entry.metadata.difficulty, 'Hard');
    assert.equal(e4.json.entry.metadata.difficultyOverride, true);

    // Stats unfiltered
    const statsAll = await ctx1.request(`/api/stats?gameId=${cluesGame.id}&date=2026-11-15&days=30`);
    assert.equal(statsAll.status, 200);
    const gsAll = statsAll.json.gameStats;
    assert.equal(gsAll.supportsDifficulty, true);
    assert.equal(gsAll.filters.difficulty, null);
    assert.equal(gsAll.kpis.currentStreak, 4);
    assert.equal(gsAll.kpis.longestStreak, 4);
    assert.equal(gsAll.kpis.totalPlayed, 4);
    assert.equal(gsAll.difficultyOptions.length, 5);
    assert.deepEqual(
      gsAll.difficultyOptions.map((d) => ({ value: d.value, count: d.count, color: d.color })),
      [
        { value: 'Easy', count: 2, color: DIFFICULTY_COLORS.Easy },
        { value: 'Medium', count: 0, color: DIFFICULTY_COLORS.Medium },
        { value: 'Tricky', count: 0, color: DIFFICULTY_COLORS.Tricky },
        { value: 'Hard', count: 2, color: DIFFICULTY_COLORS.Hard },
        { value: 'Brutal', count: 0, color: DIFFICULTY_COLORS.Brutal },
      ],
    );
    assert.deepEqual(gsAll.difficultySummary, [
      { key: 'Easy', label: 'Easy', average: 75, latest: 90, best: 60, count: 2, color: DIFFICULTY_COLORS.Easy },
      { key: 'Hard', label: 'Hard', average: 210, latest: 180, best: 180, count: 2, color: DIFFICULTY_COLORS.Hard },
    ]);
    assert.ok(gsAll.trendSeries.every((pt) => typeof pt.difficulty === 'string'));
    assert.ok(gsAll.entries.every((ent) => typeof ent.difficulty === 'string'));

    // Stats filtered by Hard: KPIs & trend filter to Hard, but streaks stay UNIFIED across all difficulties!
    const statsHard = await ctx1.request(
      `/api/stats?gameId=${cluesGame.id}&date=2026-11-15&days=30&difficulty=Hard`,
    );
    assert.equal(statsHard.status, 200);
    const gsHard = statsHard.json.gameStats;
    assert.equal(gsHard.filters.difficulty, 'Hard');
    assert.equal(gsHard.kpis.currentStreak, 4);
    assert.equal(gsHard.kpis.longestStreak, 4);
    assert.equal(gsHard.kpis.totalPlayed, 2);
    assert.equal(gsHard.kpis.averageValue, 210);
    assert.equal(gsHard.kpis.personalBest.value, 180);
    assert.equal(gsHard.kpis.personalBest.playDate, '2026-11-15');
    assert.equal(gsHard.trendSeries.length, 2);
    assert.equal(gsHard.entries.length, 2);
    assert.equal(gsHard.difficultySummary.length, 2);

    // Explicit clear via PUT with difficulty: '' -> removes metadata.difficulty and metadata.difficultyOverride
    const cleared = await ctx1.request(`/api/entries/${e4.json.entry.id}`, {
      method: 'PUT',
      body: { difficulty: '' },
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.entry.difficulty, null);
    assert.equal(cleared.json.entry.metadata.difficulty, undefined);
    assert.equal(cleared.json.entry.metadata.difficultyOverride, undefined);

    await ctx1.close();

    // Reopen DB: explicit clear must stay cleared on restart
    const ctx2 = await startTestApp(dbPath);
    try {
      await ctx2.request('/api/auth/login', {
        method: 'POST',
        body: { email: 'alice@example.com', password: 'password123' },
      });
      const afterReopen = await ctx2.request(`/api/entries?gameId=${cluesGame.id}&date=2026-11-15`);
      assert.equal(afterReopen.status, 200);
      assert.equal(afterReopen.json.entries[0].difficulty, null);
      assert.equal(afterReopen.json.entries[0].metadata.difficulty, undefined);
    } finally {
      await ctx2.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('GET /api/leaderboard difficulty filtering keeps todayMatrix Arcade Points unchanged and exposes cell.difficulty', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.close());

  const alice = createClient(ctx.baseUrl);
  const bob = createClient(ctx.baseUrl);
  await registerUser(alice, { name: 'Alice', email: 'alice@example.com', password: 'password123' });
  await registerUser(bob, { name: 'Bob', email: 'bob@example.com', password: 'password123' });

  const aliceClues = (await alice.request('/api/games')).json.games.find((g) => g.slug === 'cluesbysam');
  const bobClues = (await bob.request('/api/games')).json.games.find((g) => g.slug === 'cluesbysam');

  // Nov 13: Easy — Bob (0:50) beats Alice (1:20) -> Bob 3 pts, Alice 2 pts
  // Nov 14: Hard — Alice (2:00) beats Bob (2:30) -> Alice 3 pts, Bob 2 pts
  // Nov 15 (today): Hard — Alice (2:10) beats Bob (2:45) -> Alice 3 pts, Bob 2 pts
  // Overall Clues points: Alice = 2+3+3 = 8, Bob = 3+2+2 = 7
  for (const [date, text] of [
    ['2026-11-13', 'I solved Clues by Sam (Easy) in 01:20'],
    ['2026-11-14', 'I solved Clues by Sam (Hard) in 02:00'],
    ['2026-11-15', 'I solved Clues by Sam (Hard) in 02:10'],
  ]) {
    await alice.request('/api/entries', {
      method: 'POST',
      body: { gameId: aliceClues.id, playDate: date, rawText: text },
    });
  }
  for (const [date, text] of [
    ['2026-11-13', 'I solved Clues by Sam (Easy) in 00:50'],
    ['2026-11-14', 'I solved Clues by Sam (Hard) in 02:30'],
    ['2026-11-15', 'I solved Clues by Sam (Hard) in 02:45'],
  ]) {
    await bob.request('/api/entries', {
      method: 'POST',
      body: { gameId: bobClues.id, playDate: date, rawText: text },
    });
  }

  const lbAll = await alice.request('/api/leaderboard?date=2026-11-15&days=30&gameSlug=cluesbysam');
  assert.equal(lbAll.status, 200);
  const aliceMatrix = lbAll.json.todayMatrix.rows.find((r) => r.displayName === 'Alice');
  const bobMatrix = lbAll.json.todayMatrix.rows.find((r) => r.displayName === 'Bob');
  assert.equal(aliceMatrix.cells.cluesbysam.difficulty, 'Hard');
  assert.equal(bobMatrix.cells.cluesbysam.difficulty, 'Hard');
  assert.equal(aliceMatrix.todayPoints, 3);
  assert.equal(bobMatrix.todayPoints, 2);

  // Filter Head-to-Head by Easy (and resolve by gameId too)
  const lbEasy = await alice.request(
    `/api/leaderboard?date=2026-11-15&days=30&gameId=${aliceClues.id}&difficulty=Easy`,
  );
  assert.equal(lbEasy.status, 200);
  assert.equal(lbEasy.json.filters.difficulty, 'Easy');
  assert.equal(lbEasy.json.gameBoard.game.supportsDifficulty, true);
  assert.equal(lbEasy.json.gameBoard.game.filters.difficulty, 'Easy');
  assert.equal(lbEasy.json.gameBoard.game.difficultyOptions.find((d) => d.value === 'Easy').count, 2);
  assert.equal(lbEasy.json.gameBoard.game.difficultyOptions.find((d) => d.value === 'Hard').count, 4);

  // Today's Matrix & Overall Arcade Points stay unchanged when filtering by difficulty!
  const aliceOverall = lbEasy.json.overallStandings.find((s) => s.displayName === 'Alice');
  const bobOverall = lbEasy.json.overallStandings.find((s) => s.displayName === 'Bob');
  assert.equal(aliceOverall.arcadePoints, 8);
  assert.equal(bobOverall.arcadePoints, 7);
  assert.equal(
    lbEasy.json.todayMatrix.rows.find((r) => r.displayName === 'Alice').todayPoints,
    3,
  );

  // Head-to-Head filtered to Easy puts Bob #1 (50s / 3 pts) over Alice (80s / 2 pts), while keeping unified currentStreak=3!
  const standings = lbEasy.json.gameBoard.standings;
  assert.equal(standings[0].displayName, 'Bob');
  assert.equal(standings[0].gamePoints, 3);
  assert.equal(standings[0].totalPlayed, 1);
  assert.equal(standings[0].personalBestValue, 50);
  assert.equal(standings[0].currentStreak, 3);
  assert.equal(standings[1].displayName, 'Alice');
  assert.equal(standings[1].gamePoints, 2);
  assert.equal(standings[1].totalPlayed, 1);
  assert.equal(standings[1].personalBestValue, 80);
  assert.equal(standings[1].currentStreak, 3);
});

test('Perceptle per-round breakdown: auto-parse, manual round logging, PUT edit, validation, and 5-row breakdownSummary with bestValue', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.close());
  await registerUser(ctx);

  const boot = await ctx.request('/api/bootstrap?date=2026-11-15');
  const perceptleGame = boot.json.games.find((g) => g.slug === 'perceptle');
  assert.equal(perceptleGame.parserId, 'perceptle');
  assert.equal(perceptleGame.resolvedParser.id, 'perceptle');

  // 1. Auto-parse share text with grade + 5 round chips
  const pasteRes = await ctx.request('/api/entries', {
    method: 'POST',
    body: {
      gameId: perceptleGame.id,
      playDate: '2026-11-15',
      rawText: 'Perceptle #122 - C (69)\n🔢 57  🎯 93  📐 100  🥁 3  ✂️ 93\nhttps://perceptle.com',
    },
  });
  assert.equal(pasteRes.status, 201);
  const pasted = pasteRes.json.entry;
  assert.equal(pasted.parserId, 'perceptle');
  assert.equal(pasted.primaryValue, 69);
  assert.equal(pasted.displayValue, '69 (C)');
  assert.equal(pasted.puzzleId, '#122');
  assert.equal(pasted.metadata.grade, 'C');
  assert.equal(pasted.metadata.maxScore, 100);
  assert.deepEqual(pasted.metadata.roundScores, {
    count: 57,
    track: 93,
    angle: 100,
    tempo: 3,
    split: 93,
  });
  assert.deepEqual(
    pasted.breakdown.map((b) => ({ key: b.key, label: b.label, value: b.value, max: b.max })),
    [
      { key: 'count', label: '🔢 Count', value: 57, max: 100 },
      { key: 'track', label: '🎯 Track', value: 93, max: 100 },
      { key: 'angle', label: '📐 Angle', value: 100, max: 100 },
      { key: 'tempo', label: '🥁 Tempo', value: 3, max: 100 },
      { key: 'split', label: '✂️ Split', value: 93, max: 100 },
    ],
  );

  // 2. Manual per-round save (without primaryValue -> computes rounded avg) + PUT edit
  const manualRes = await ctx.request('/api/entries', {
    method: 'POST',
    body: {
      gameId: perceptleGame.id,
      playDate: '2026-11-14',
      manualOverride: true,
      breakdown: [
        { key: 'count', value: 80 },
        { key: 'track', value: 70 },
        { key: 'angle', value: 90 },
        { key: 'tempo', value: 60 },
        { key: 'split', value: 100 },
      ],
    },
  });
  assert.equal(manualRes.status, 201);
  assert.equal(manualRes.json.entry.primaryValue, 80);
  assert.equal(manualRes.json.entry.displayValue, '80');
  assert.deepEqual(manualRes.json.entry.metadata.roundScores, {
    count: 80,
    track: 70,
    angle: 90,
    tempo: 60,
    split: 100,
  });

  const editRes = await ctx.request(`/api/entries/${manualRes.json.entry.id}`, {
    method: 'PUT',
    body: {
      breakdown: [
        { key: 'count', value: 85 },
        { key: 'track', value: 75 },
        { key: 'angle', value: 95 },
        { key: 'tempo', value: 65 },
        { key: 'split', value: 95 },
      ],
    },
  });
  assert.equal(editRes.status, 200);
  assert.equal(editRes.json.entry.primaryValue, 83);
  assert.equal(editRes.json.entry.displayValue, '83');
  assert.equal(editRes.json.entry.metadata.roundScores.tempo, 65);
  assert.equal(editRes.json.entry.metadata.roundScores.split, 95);

  // 3. ValidationError (400) on invalid breakdown types / non-numeric item values
  const badArrayRes = await ctx.request('/api/entries', {
    method: 'POST',
    body: {
      gameId: perceptleGame.id,
      playDate: '2026-11-13',
      breakdown: 'not-an-array',
    },
  });
  assert.equal(badArrayRes.status, 400);

  const badValueRes = await ctx.request('/api/entries', {
    method: 'POST',
    body: {
      gameId: perceptleGame.id,
      playDate: '2026-11-13',
      breakdown: [{ key: 'count', label: '🔢 Count', value: 'not-a-number' }],
    },
  });
  assert.equal(badValueRes.status, 400);

  const nullValueRes = await ctx.request('/api/entries', {
    method: 'POST',
    body: {
      gameId: perceptleGame.id,
      playDate: '2026-11-13',
      breakdown: [{ key: 'count', label: '🔢 Count', value: null }],
    },
  });
  assert.equal(nullValueRes.status, 400);

  // 4. Stats 5-row breakdownSummary with avgValue, latestValue, bestValue, max: 100, count: 2
  const statsRes = await ctx.request(`/api/stats?gameId=${perceptleGame.id}&date=2026-11-15&days=30`);
  assert.equal(statsRes.status, 200);
  const summary = statsRes.json.gameStats.breakdownSummary;
  assert.deepEqual(summary, [
    { label: '🔢 Count', icon: '🔢', avgValue: 71, max: 100, latestValue: 57, bestValue: 85, count: 2 },
    { label: '🎯 Track', icon: '🎯', avgValue: 84, max: 100, latestValue: 93, bestValue: 93, count: 2 },
    { label: '📐 Angle', icon: '📐', avgValue: 97.5, max: 100, latestValue: 100, bestValue: 100, count: 2 },
    { label: '🥁 Tempo', icon: '🥁', avgValue: 34, max: 100, latestValue: 3, bestValue: 65, count: 2 },
    { label: '✂️ Split', icon: '✂️', avgValue: 94, max: 100, latestValue: 93, bestValue: 95, count: 2 },
  ]);
});

test('perceptle_parser_and_backfill_v1 migration: upgrades perceptle parser_id and backfills empty breakdown rows while respecting manual_override', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-games-perceptle-mig-'));
  const dbPath = path.join(tmpDir, 'perceptle-legacy.db');

  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE games (
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
      CREATE TABLE entries (
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
      INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at)
      VALUES (1, 'p@example.com', 'Player', 'h', 's', '2026-11-01T00:00:00Z');
      INSERT INTO games (id, user_id, name, slug, url, metric_label, metric_format, metric_direction, parser_id, sort_order, archived, created_at)
      VALUES (1, 1, 'Perceptle', 'perceptle', 'https://perceptle.com', 'Score', 'number', 'higher_is_better', 'auto', 4, 0, '2026-11-01T00:00:00Z');
      INSERT INTO entries (id, user_id, game_id, play_date, raw_text, parser_id, parser_version, completed, solved, primary_value, display_value, puzzle_id, breakdown_json, metadata_json, manual_override, created_at, updated_at)
      VALUES
        (1, 1, 1, '2026-11-15', 'Perceptle #122 - C (69)\n🔢 57  🎯 93  📐 100  🥁 3  ✂️ 93\nhttps://perceptle.com', 'generic', 1, 1, NULL, 69, '69', NULL, '[]', '{}', 0, '2026-11-15T01:00:00Z', '2026-11-15T01:00:00Z'),
        (2, 1, 1, '2026-11-14', 'Perceptle #121 - B (75)\n🔢 60  🎯 70  📐 80  🥁 75  ✂️ 90', 'generic', 1, 1, NULL, 99, '99 custom', '#999', '[]', '{}', 1, '2026-11-14T01:00:00Z', '2026-11-14T01:00:00Z');
    `);
    legacy.close();

    const db = createDatabase({ dbPath });
    const perceptle = db.getGameById(1, 1);
    assert.equal(perceptle.parserId, 'perceptle');
    assert.equal(perceptle.resolvedParser.id, 'perceptle');

    const catRow = db.sqlite.prepare("SELECT parser_id FROM game_catalog WHERE slug = 'perceptle'").get();
    assert.equal(catRow.parser_id, 'perceptle');
    assert.ok(
      db.sqlite
        .prepare("SELECT 1 FROM schema_migrations WHERE id = 'perceptle_parser_and_backfill_v1'")
        .get(),
    );

    const autoBackfilled = db.getEntryById(1, 1);
    assert.equal(autoBackfilled.parserId, 'perceptle');
    assert.equal(autoBackfilled.primaryValue, 69);
    assert.equal(autoBackfilled.displayValue, '69 (C)');
    assert.equal(autoBackfilled.puzzleId, '#122');
    assert.equal(autoBackfilled.breakdown.length, 5);
    assert.equal(autoBackfilled.metadata.grade, 'C');
    assert.equal(autoBackfilled.metadata.roundScores.tempo, 3);

    const manualRow = db.getEntryById(2, 1);
    assert.equal(manualRow.parserId, 'perceptle');
    assert.equal(manualRow.primaryValue, 99);
    assert.equal(manualRow.displayValue, '99 custom');
    assert.equal(manualRow.puzzleId, '#999');
    assert.equal(manualRow.breakdown.length, 5);
    assert.equal(manualRow.metadata.grade, 'B');
    assert.equal(manualRow.metadata.roundScores.split, 90);
    db.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('GET /api/leaderboard days=1 off-local targetDate parity + todayPoints, todayMedals, and Olympic todayRank on overallStandings & todayMatrix', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.close());

  const alice = createClient(ctx.baseUrl);
  const bob = createClient(ctx.baseUrl);
  const charlie = createClient(ctx.baseUrl);
  const dana = createClient(ctx.baseUrl);

  await registerUser(alice, { name: 'Alice', email: 'alice-lb1@example.com', password: 'password123' });
  await registerUser(bob, { name: 'Bob', email: 'bob-lb1@example.com', password: 'password123' });
  await registerUser(charlie, { name: 'Charlie', email: 'charlie-lb1@example.com', password: 'password123' });
  await registerUser(dana, { name: 'Dana', email: 'dana-lb1@example.com', password: 'password123' });

  const tz = 'Pacific/Kiritimati';
  const createHonolulu = await alice.request('/api/games', {
    method: 'POST',
    body: {
      name: 'Honolulu Puzzle',
      url: 'https://honolulu-lb.example.com',
      resetTimezone: 'Pacific/Honolulu',
      resetTime: '00:00',
    },
  });
  assert.equal(createHonolulu.status, 201);
  const honoluluSlug = createHonolulu.json.game.slug;

  await bob.request('/api/catalog/subscribe', { method: 'POST', body: { slug: honoluluSlug } });
  await charlie.request('/api/catalog/subscribe', { method: 'POST', body: { slug: honoluluSlug } });

  const [aliceBoot, bobBoot, charlieBoot] = await Promise.all([
    alice.request(`/api/bootstrap?live=1&tz=${encodeURIComponent(tz)}`),
    bob.request(`/api/bootstrap?live=1&tz=${encodeURIComponent(tz)}`),
    charlie.request(`/api/bootstrap?live=1&tz=${encodeURIComponent(tz)}`),
  ]);

  const aliceHon = aliceBoot.json.games.find((g) => g.slug === honoluluSlug);
  const bobHon = bobBoot.json.games.find((g) => g.slug === honoluluSlug);
  const charlieHon = charlieBoot.json.games.find((g) => g.slug === honoluluSlug);
  const honTargetDate = aliceBoot.json.cardSummaries[aliceHon.id].puzzleStatus.activePuzzleDate;
  assert.notEqual(honTargetDate, aliceBoot.json.date);

  const aliceKril = aliceBoot.json.games.find((g) => g.slug === 'krillion');
  const bobKril = bobBoot.json.games.find((g) => g.slug === 'krillion');
  const krilTargetDate = aliceBoot.json.cardSummaries[aliceKril.id].puzzleStatus.activePuzzleDate;

  // Historical entry outside days=1 window (should count for days=30 arcadePoints, NOT days=1)
  const honPriorDate = addDays(honTargetDate, -1);
  await charlie.request('/api/entries', {
    method: 'POST',
    body: { gameId: charlieHon.id, playDate: honPriorDate, primaryValue: 1500 },
  });

  // Active off-local cycle on Honolulu: Alice (900, gold) ties Bob (900, gold); Charlie (500, bronze)
  await alice.request('/api/entries', {
    method: 'POST',
    body: { gameId: aliceHon.id, playDate: honTargetDate, primaryValue: 900 },
  });
  await bob.request('/api/entries', {
    method: 'POST',
    body: { gameId: bobHon.id, playDate: honTargetDate, primaryValue: 900 },
  });
  await charlie.request('/api/entries', {
    method: 'POST',
    body: { gameId: charlieHon.id, playDate: honTargetDate, primaryValue: 500 },
  });

  // Active local cycle on Krillion: Alice (400) ties Bob (400) -> both get gold (3)
  await alice.request('/api/entries', {
    method: 'POST',
    body: { gameId: aliceKril.id, playDate: krilTargetDate, primaryValue: 400 },
  });
  await bob.request('/api/entries', {
    method: 'POST',
    body: { gameId: bobKril.id, playDate: krilTargetDate, primaryValue: 400 },
  });

  // 1. days=1&live=1&tz=... matches todayMatrix 100% point-for-point even across off-local targetDates
  const lb1 = await alice.request(`/api/leaderboard?days=1&live=1&tz=${encodeURIComponent(tz)}`);
  assert.equal(lb1.status, 200);
  assert.equal(lb1.json.days, 1);

  const honCat = lb1.json.catalogGames.find((g) => g.slug === honoluluSlug);
  assert.equal(honCat.targetDate, honTargetDate);
  assert.notEqual(honCat.targetDate, lb1.json.date);

  for (const player of lb1.json.overallStandings) {
    const matrixRow = lb1.json.todayMatrix.rows.find((r) => r.userId === player.userId);
    assert.ok(matrixRow);
    assert.equal(player.arcadePoints, player.todayPoints);
    assert.equal(player.todayPoints, matrixRow.todayPoints);
    assert.deepEqual(player.medals, player.todayMedals);
    assert.deepEqual(player.todayMedals, matrixRow.todayMedals);
    assert.equal(player.todayRank, matrixRow.todayRank);
  }

  const findRow = (list, name) => list.find((r) => r.displayName === name);
  const a1 = findRow(lb1.json.overallStandings, 'Alice');
  const b1 = findRow(lb1.json.overallStandings, 'Bob');
  const c1 = findRow(lb1.json.overallStandings, 'Charlie');
  const d1 = findRow(lb1.json.overallStandings, 'Dana');

  assert.equal(a1.todayPoints, 6);
  assert.deepEqual(a1.todayMedals, { gold: 2, silver: 0, bronze: 0 });
  assert.equal(a1.todayRank, 1);
  assert.equal(b1.todayPoints, 6);
  assert.deepEqual(b1.todayMedals, { gold: 2, silver: 0, bronze: 0 });
  assert.equal(b1.todayRank, 1);
  assert.equal(c1.todayPoints, 1);
  assert.deepEqual(c1.todayMedals, { gold: 0, silver: 0, bronze: 1 });
  assert.equal(c1.todayRank, 3);
  assert.equal(d1.todayPoints, 0);
  assert.deepEqual(d1.todayMedals, { gold: 0, silver: 0, bronze: 0 });
  assert.equal(d1.todayRank, null);

  // 2. days=30&live=1&tz=... includes Charlie's prior Honolulu win in arcadePoints while preserving todayPoints/todayMedals/todayRank
  const lb30 = await alice.request(`/api/leaderboard?days=30&live=1&tz=${encodeURIComponent(tz)}`);
  assert.equal(lb30.status, 200);
  assert.equal(lb30.json.days, 30);

  const c30 = findRow(lb30.json.overallStandings, 'Charlie');
  const cMatrix30 = findRow(lb30.json.todayMatrix.rows, 'Charlie');
  const d30 = findRow(lb30.json.overallStandings, 'Dana');
  assert.equal(c30.arcadePoints, 4); // 3 pts from yesterday + 1 pt today
  assert.equal(c30.todayPoints, 1);
  assert.deepEqual(c30.todayMedals, { gold: 0, silver: 0, bronze: 1 });
  assert.equal(c30.todayRank, 3);
  assert.equal(cMatrix30.todayPoints, 1);
  assert.deepEqual(cMatrix30.todayMedals, { gold: 0, silver: 0, bronze: 1 });
  assert.equal(cMatrix30.todayRank, 3);
  assert.equal(d30.todayRank, null);
});
