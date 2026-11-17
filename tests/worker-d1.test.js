import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index.js';
import { ensureSchema, canonicalUrlKey, createD1Database } from '../worker/db-d1.js';
import { BUILTIN_CATALOG_GAMES, OPTIONAL_CATALOG_GAMES } from '../shared/auth-crypto.js';
import { getGamePuzzleStatus } from '../shared/parsers/registry.js';
import { DIFFICULTY_COLORS } from '../server/stats.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const MIGRATION_SQL = fs.readFileSync(
  path.join(PROJECT_ROOT, 'migrations', '0001_init.sql'),
  'utf8',
);

function createD1Adapter(sqliteDb) {
  sqliteDb.exec('PRAGMA foreign_keys = ON;');

  function makeStatement(sql, boundParams = []) {
    return {
      _sql: sql,
      _params: boundParams,
      bind(...params) {
        return makeStatement(sql, params);
      },
      async first(colName) {
        const stmt = sqliteDb.prepare(sql);
        const row = stmt.get(...boundParams);
        if (row === undefined) return null;
        const plain = { ...row };
        if (colName !== undefined) {
          return Object.prototype.hasOwnProperty.call(plain, colName) ? plain[colName] : null;
        }
        return plain;
      },
      async all() {
        const stmt = sqliteDb.prepare(sql);
        const rows = stmt.all(...boundParams).map((r) => ({ ...r }));
        return {
          results: rows,
          success: true,
          meta: { changes: 0, last_row_id: 0 },
        };
      },
      async run() {
        const stmt = sqliteDb.prepare(sql);
        const res = stmt.run(...boundParams);
        return {
          results: [],
          success: true,
          meta: {
            changes: Number(res.changes ?? 0),
            last_row_id: Number(res.lastInsertRowid ?? 0),
          },
        };
      },
    };
  }

  return {
    prepare(sql) {
      return makeStatement(sql);
    },
    async batch(statements) {
      sqliteDb.exec('BEGIN IMMEDIATE;');
      try {
        const out = [];
        for (const s of statements) {
          if (/^\s*(?:SELECT|PRAGMA|WITH)\b/i.test(s._sql)) {
            out.push(await s.all());
          } else {
            out.push(await s.run());
          }
        }
        sqliteDb.exec('COMMIT;');
        return out;
      } catch (err) {
        try {
          sqliteDb.exec('ROLLBACK;');
        } catch {
          // ignore
        }
        throw err;
      }
    },
    async exec(sql) {
      sqliteDb.exec(sql);
      return { count: 1, duration: 0 };
    },
  };
}

function createWorkerHarness({ applyMigration = false, origin = 'https://daily-games.example.com' } = {}) {
  const sqliteDb = new DatabaseSync(':memory:');
  const d1 = createD1Adapter(sqliteDb);
  if (applyMigration) {
    sqliteDb.exec(MIGRATION_SQL);
  }

  const assetCalls = [];
  const env = {
    DB: d1,
    ASSETS: {
      async fetch(request) {
        const url = new URL(request.url);
        assetCalls.push(url.pathname);
        if (url.pathname === '/' || url.pathname === '/index.html') {
          return new Response('<!doctype html><title>Daily Games Hub</title>', {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
        if (url.pathname === '/shared/parsers/registry.js') {
          return new Response('export const PARSERS = [];', {
            status: 200,
            headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
          });
        }
        return new Response('Not Found', { status: 404 });
      },
    },
  };

  const ctx = {
    waitUntil() {},
    passThroughOnException() {
      throw new Error('passThroughOnException must never be called');
    },
  };

  function createSessionClient(baseOrigin = origin) {
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
      return setCookies;
    }

    async function call(urlPath, { method = 'GET', body, headers: extraHeaders = {} } = {}) {
      const headers = new Headers(extraHeaders);
      if (cookies.size > 0 && !headers.has('Cookie')) {
        headers.set(
          'Cookie',
          Array.from(cookies.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join('; '),
        );
      }
      let rawBody;
      if (body !== undefined) {
        rawBody = typeof body === 'string' ? body : JSON.stringify(body);
        if (!headers.has('Content-Type')) {
          headers.set('Content-Type', 'application/json');
        }
      }

      const req = new Request(`${baseOrigin}${urlPath}`, {
        method,
        headers,
        body: rawBody,
      });
      const res = await worker.fetch(req, env, ctx);
      const setCookies = applySetCookies(res.headers);
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // non-JSON
      }
      return { res, status: res.status, headers: res.headers, setCookies, text, json };
    }

    return { cookies, call };
  }

  return { sqliteDb, d1, env, ctx, assetCalls, createSessionClient };
}

test('Worker health, static asset passthrough, security headers, and structured 500', async () => {
  const harness = createWorkerHarness();
  const client = harness.createSessionClient();

  const health = await client.call('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.ok(health.json.timestamp);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(health.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(health.headers.get('cache-control'), 'no-store');

  const home = await client.call('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Daily Games Hub/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(harness.assetCalls, ['/']);

  const sharedAsset = await client.call('/shared/parsers/registry.js');
  assert.equal(sharedAsset.status, 200);
  assert.equal(harness.assetCalls.includes('/shared/parsers/registry.js'), true);

  // Explicit structured JSON 500 when DB binding fails (never passThroughOnException)
  const brokenRes = await worker.fetch(
    new Request('https://daily-games.example.com/api/auth/me'),
    { DB: null, ASSETS: harness.env.ASSETS },
    harness.ctx,
  );
  assert.equal(brokenRes.status, 500);
  const brokenBody = await brokenRes.json();
  assert.equal(brokenBody.error, 'Internal server error');

  harness.sqliteDb.close();
});

test('Worker auth lifecycle: register, __Host-dg_session vs dg_session, login, logout + Clear-Site-Data, and Sec-Fetch-Site CSRF', async () => {
  const httpsHarness = createWorkerHarness({ origin: 'https://daily-games.example.com' });
  const httpsClient = httpsHarness.createSessionClient('https://daily-games.example.com');

  // Unauthenticated endpoints
  const meAnon = await httpsClient.call('/api/auth/me');
  assert.equal(meAnon.status, 200);
  assert.equal(meAnon.json.authenticated, false);
  assert.equal(meAnon.json.user, null);
  assert.equal(meAnon.json.hasUsers, false);
  assert.deepEqual(meAnon.json.unclaimed, { gamesCount: 0, entriesCount: 0 });
  assert.equal(Array.isArray(meAnon.json.signupCatalog), true);
  assert.equal(meAnon.json.signupCatalog.length, BUILTIN_CATALOG_GAMES.length);
  const signupSizeItUp = meAnon.json.signupCatalog.find((g) => g.slug === 'magnitudle');
  assert.equal(signupSizeItUp?.name, 'Size It Up');
  assert.equal(signupSizeItUp?.collection, 'Magnitudle');

  const unauthBootstrap = await httpsClient.call('/api/bootstrap');
  assert.equal(unauthBootstrap.status, 401);

  // Sec-Fetch-Site: cross-site rejected with 403 + Vary before auth
  const csrfBlocked = await httpsClient.call('/api/auth/register', {
    method: 'POST',
    headers: { 'Sec-Fetch-Site': 'cross-site' },
    body: { name: 'Eve', email: 'eve@example.com', password: 'password123' },
  });
  assert.equal(csrfBlocked.status, 403);
  assert.equal(csrfBlocked.headers.get('vary'), 'Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site');

  // Register over HTTPS -> __Host-dg_session with Secure, HttpOnly, SameSite=Lax
  const reg = await httpsClient.call('/api/auth/register', {
    method: 'POST',
    headers: { 'Sec-Fetch-Site': 'same-origin' },
    body: { name: 'Alice', email: 'Alice@Example.com', password: 'password123' },
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.json.authenticated, true);
  assert.equal(reg.json.user.email, 'alice@example.com');
  assert.equal(reg.json.user.displayName, 'Alice');
  assert.equal(reg.setCookies.length, 1);
  assert.match(reg.setCookies[0], /^__Host-dg_session=/);
  assert.match(reg.setCookies[0], /;\s*Secure\b/);
  assert.match(reg.setCookies[0], /;\s*HttpOnly\b/);
  assert.match(reg.setCookies[0], /;\s*SameSite=Lax\b/);
  assert.ok(httpsClient.cookies.has('__Host-dg_session'));

  // Duplicate email -> 409
  const dup = await httpsClient.call('/api/auth/register', {
    method: 'POST',
    body: { name: 'Alice Two', email: 'alice@example.com', password: 'password123' },
  });
  assert.equal(dup.status, 409);

  // Authenticated /api/auth/me
  const meAuth = await httpsClient.call('/api/auth/me');
  assert.equal(meAuth.status, 200);
  assert.equal(meAuth.json.authenticated, true);
  assert.equal(meAuth.json.user.displayName, 'Alice');

  // Logout sets Clear-Site-Data: "cookies" and expires session cookies
  const logout = await httpsClient.call('/api/auth/logout', { method: 'POST' });
  assert.equal(logout.status, 200);
  assert.equal(logout.json.ok, true);
  assert.equal(logout.headers.get('clear-site-data'), '"cookies"');
  assert.ok(logout.setCookies.some((c) => c.startsWith('__Host-dg_session=') && /Max-Age=0/.test(c)));
  assert.ok(logout.setCookies.some((c) => c.startsWith('dg_session=') && /Max-Age=0/.test(c)));
  assert.equal(httpsClient.cookies.size, 0);

  // Post-logout session is invalidated
  const meAfterLogout = await httpsClient.call('/api/auth/me');
  assert.equal(meAfterLogout.status, 200);
  assert.equal(meAfterLogout.json.authenticated, false);
  assert.equal(meAfterLogout.json.user, null);
  assert.equal(meAfterLogout.json.hasUsers, true);
  assert.deepEqual(meAfterLogout.json.unclaimed, { gamesCount: 0, entriesCount: 0 });
  assert.equal(Array.isArray(meAfterLogout.json.signupCatalog), true);
  assert.equal(meAfterLogout.json.signupCatalog.length, BUILTIN_CATALOG_GAMES.length);

  // Wrong password -> 401; nonexistent user -> 401
  const badPw = await httpsClient.call('/api/auth/login', {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'wrong-password' },
  });
  assert.equal(badPw.status, 401);

  const badEmail = await httpsClient.call('/api/auth/login', {
    method: 'POST',
    body: { email: 'nobody@example.com', password: 'password123' },
  });
  assert.equal(badEmail.status, 401);

  // Valid login over HTTP (local dev / test) -> dg_session without Secure flag
  const httpClient = httpsHarness.createSessionClient('http://127.0.0.1:8787');
  const httpLogin = await httpClient.call('/api/auth/login', {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'password123' },
  });
  assert.equal(httpLogin.status, 200);
  assert.equal(httpLogin.setCookies.length, 1);
  assert.match(httpLogin.setCookies[0], /^dg_session=/);
  assert.doesNotMatch(httpLogin.setCookies[0], /;\s*Secure\b/);
  assert.ok(httpClient.cookies.has('dg_session'));

  // Cross-site DELETE also blocked
  const csrfDelete = await httpClient.call('/api/games/1', {
    method: 'DELETE',
    headers: { 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(csrfDelete.status, 403);

  httpsHarness.sqliteDb.close();
});

test('Worker strict Alice vs Bob isolation, games CRUD/reorder, entries upsert, stats, and export/import', async () => {
  const harness = createWorkerHarness({ applyMigration: true });
  const alice = harness.createSessionClient();
  const bob = harness.createSessionClient();

  const regAlice = await alice.call('/api/auth/register', {
    method: 'POST',
    body: { name: 'Alice', email: 'alice@example.com', password: 'alice-password-1' },
  });
  assert.equal(regAlice.status, 201);

  const regBob = await bob.call('/api/auth/register', {
    method: 'POST',
    body: { name: 'Bob', email: 'bob@example.com', password: 'bob-password-1' },
  });
  assert.equal(regBob.status, 201);

  // Both receive 10 starter games (including Plain, TimeGuessr & Eraly)
  const aliceBoot = await alice.call('/api/bootstrap?live=1&tz=America/New_York');
  assert.equal(aliceBoot.status, 200);
  assert.equal(aliceBoot.json.games.length, 10);
  const aliceCluesStarter = aliceBoot.json.games.find((g) => g.slug === 'cluesbysam');
  assert.equal(aliceCluesStarter.parserId, 'cluesbysam');
  assert.ok(aliceBoot.json.games.some((g) => g.slug === 'perceptle' && g.parserId === 'perceptle'));
  assert.ok(aliceBoot.json.games.some((g) => g.slug === 'fermi' && g.parserId === 'fermi'));
  assert.ok(
    aliceBoot.json.games.some(
      (g) => g.slug === 'magnitudle' && g.name === 'Size It Up' && g.parserId === 'magnitudle',
    ),
  );
  assert.ok(aliceBoot.json.games.some((g) => g.slug === 'eraly' && g.parserId === 'eraly'));
  assert.ok(aliceBoot.json.games.some((g) => g.slug === 'plain' && g.parserId === 'plain'));
  assert.ok(aliceBoot.json.games.some((g) => g.slug === 'timeguessr' && g.parserId === 'timeguessr'));
  assert.equal(aliceBoot.json.user.email, 'alice@example.com');
  assert.equal(aliceBoot.json.entriesForDate.length, 0);
  assert.deepEqual(aliceBoot.json.entries, []);

  const bobBoot = await bob.call('/api/bootstrap?date=2026-11-16');
  assert.equal(bobBoot.status, 200);
  assert.equal(bobBoot.json.games.length, 10);
  assert.equal(bobBoot.json.user.email, 'bob@example.com');

  // Alice creates a custom lower_is_better duration game & a higher_is_better game
  const createSprint = await alice.call('/api/games', {
    method: 'POST',
    body: {
      name: 'Mini Crossword',
      url: 'https://example.com/mini',
      metricLabel: 'Solve Time',
      metricFormat: 'duration_sec',
      metricDirection: 'lower_is_better',
      resetTimezone: 'America/New_York',
    },
  });
  assert.equal(createSprint.status, 201);
  const aliceMini = createSprint.json.game;

  // Alice logs 3 entries on Mini Crossword (lower_is_better) and 2 on Krillion (higher_is_better)
  const aliceKrillion = aliceBoot.json.games.find((g) => g.slug === 'krillion');
  assert.ok(aliceKrillion);

  const mini1 = await alice.call('/api/entries', {
    method: 'POST',
    body: { gameId: aliceMini.id, playDate: '2026-11-14', primaryValue: 95, solved: true },
  });
  assert.equal(mini1.status, 201);
  assert.equal(mini1.json.entry.displayValue, '1:35');

  await alice.call('/api/entries', {
    method: 'POST',
    body: { gameId: aliceMini.id, playDate: '2026-11-15', primaryValue: 62, solved: true },
  });
  await alice.call('/api/entries', {
    method: 'POST',
    body: { gameId: aliceMini.id, playDate: '2026-11-16', primaryValue: 74, solved: true },
  });
  // Upsert overwrite on same date
  const miniUpsert = await alice.call('/api/entries', {
    method: 'POST',
    body: { gameId: aliceMini.id, playDate: '2026-11-16', primaryValue: 58, solved: true },
  });
  assert.equal(miniUpsert.status, 201);
  assert.equal(miniUpsert.json.entry.displayValue, '0:58');

  const krill1 = await alice.call('/api/entries', {
    method: 'POST',
    body: {
      gameId: aliceKrillion.id,
      playDate: '2026-11-15',
      rawText: 'Krillion #123 🦐\n465\n\n🏮🦑🏮🐟🦑🦑🏮',
    },
  });
  assert.equal(krill1.status, 201);
  assert.equal(krill1.json.entry.primaryValue, 465);

  const krill2 = await alice.call('/api/entries', {
    method: 'POST',
    body: {
      gameId: aliceKrillion.id,
      playDate: '2026-11-16',
      rawText: 'Krillion #124 🦐\n510\n\n🏮🦑🏮🐟🦑🦑🏮',
    },
  });
  assert.equal(krill2.status, 201);

  // Detect endpoint uses Alice's games only
  const detectKrill = await alice.call('/api/detect', {
    method: 'POST',
    body: { rawText: 'Krillion #125\n490' },
  });
  assert.equal(detectKrill.status, 200);
  assert.equal(detectKrill.json.matchedGame.id, aliceKrillion.id);

  // Stats: lower_is_better personalBest should be 58 (0:58)
  const miniStats = await alice.call(
    `/api/stats?gameId=${aliceMini.id}&date=2026-11-16&days=30`,
  );
  assert.equal(miniStats.status, 200);
  assert.equal(miniStats.json.gameStats.kpis.personalBest.value, 58);
  assert.equal(miniStats.json.gameStats.kpis.personalBest.displayValue, '0:58');
  assert.equal(miniStats.json.gameStats.kpis.currentStreak, 3);
  assert.equal(miniStats.json.heatmap.length, 91);

  // Stats: higher_is_better personalBest should be 510
  const krillStats = await alice.call(
    `/api/stats?gameId=${aliceKrillion.id}&date=2026-11-16`,
  );
  assert.equal(krillStats.status, 200);
  assert.equal(krillStats.json.gameStats.kpis.personalBest.value, 510);
  assert.equal(krillStats.json.gameStats.kpis.currentStreak, 2);

  // Reorder games
  const aliceGamesRes = await alice.call('/api/games');
  const reversedIds = aliceGamesRes.json.games.map((g) => g.id).reverse();
  const reordered = await alice.call('/api/games/reorder', {
    method: 'PUT',
    body: { orderedIds: reversedIds },
  });
  assert.equal(reordered.status, 200);
  assert.deepEqual(
    reordered.json.games.map((g) => g.id),
    reversedIds,
  );

  // Cross-user isolation: Bob gets 404 on ALL of Alice's game/entry endpoints
  const bobProbeGamePut = await bob.call(`/api/games/${aliceMini.id}`, {
    method: 'PUT',
    body: { name: 'Hijacked' },
  });
  assert.equal(bobProbeGamePut.status, 404);

  const bobProbeGameDel = await bob.call(`/api/games/${aliceMini.id}`, {
    method: 'DELETE',
  });
  assert.equal(bobProbeGameDel.status, 404);

  const bobProbeReparse = await bob.call(`/api/games/${aliceKrillion.id}/reparse`, {
    method: 'POST',
    body: { force: true },
  });
  assert.equal(bobProbeReparse.status, 404);

  const bobProbeStats = await bob.call(`/api/stats?gameId=${aliceMini.id}`);
  assert.equal(bobProbeStats.status, 404);

  const bobProbeReorder = await bob.call('/api/games/reorder', {
    method: 'PUT',
    body: { orderedIds: [aliceMini.id] },
  });
  assert.equal(bobProbeReorder.status, 404);

  const bobProbeEntryPut = await bob.call(`/api/entries/${mini1.json.entry.id}`, {
    method: 'PUT',
    body: { primaryValue: 999 },
  });
  assert.equal(bobProbeEntryPut.status, 404);

  const bobProbeEntryDel = await bob.call(`/api/entries/${mini1.json.entry.id}`, {
    method: 'DELETE',
  });
  assert.equal(bobProbeEntryDel.status, 404);

  const bobEntries = await bob.call('/api/entries');
  assert.equal(bobEntries.status, 200);
  assert.equal(bobEntries.json.entries.length, 0);

  // Bob cannot detect Alice's custom Mini Crossword game
  const bobDetectMini = await bob.call('/api/detect', {
    method: 'POST',
    body: { rawText: 'Mini Crossword 0:45' },
  });
  assert.equal(bobDetectMini.status, 200);
  assert.equal(bobDetectMini.json.matchedGame, null);

  // Export Alice's data, then import into Bob (merge then replace) -> Alice remains unaffected!
  const aliceExport = await alice.call('/api/export');
  assert.equal(aliceExport.status, 200);
  assert.equal(aliceExport.json.games.length, 11);
  assert.equal(aliceExport.json.entries.length, 5);

  const bobMerge = await bob.call('/api/import', {
    method: 'POST',
    body: { ...aliceExport.json, mode: 'merge' },
  });
  assert.equal(bobMerge.status, 200);
  assert.equal(bobMerge.json.gamesCount, 11);
  assert.equal(bobMerge.json.entriesCount, 5);

  const bobAfterMerge = await bob.call('/api/entries');
  assert.equal(bobAfterMerge.json.entries.length, 5);

  // Bob's replace import with 1 game wipes ONLY Bob's data, leaving Alice's 11 games & 5 entries intact
  const bobReplace = await bob.call('/api/import', {
    method: 'POST',
    body: {
      mode: 'replace',
      games: [
        {
          id: 999,
          name: 'Bob Solo Game',
          slug: 'bob-solo',
          url: 'https://bob.example.com',
        },
      ],
      entries: [
        {
          gameId: 999,
          playDate: '2026-11-16',
          primaryValue: 123,
          displayValue: '123',
        },
      ],
    },
  });
  assert.equal(bobReplace.status, 200);
  assert.equal(bobReplace.json.gamesCount, 1);
  assert.equal(bobReplace.json.entriesCount, 1);

  const bobGamesAfterReplace = await bob.call('/api/games');
  assert.equal(bobGamesAfterReplace.json.games.length, 1);
  assert.equal(bobGamesAfterReplace.json.games[0].name, 'Bob Solo Game');

  const aliceGamesAfterBobReplace = await alice.call('/api/games');
  const aliceEntriesAfterBobReplace = await alice.call('/api/entries');
  assert.equal(aliceGamesAfterBobReplace.json.games.length, 11);
  assert.equal(aliceEntriesAfterBobReplace.json.entries.length, 5);

  // Alice updates and deletes her own entry & game cleanly
  const updEntry = await alice.call(`/api/entries/${krill2.json.entry.id}`, {
    method: 'PUT',
    body: { primaryValue: 555, notes: 'PB updated' },
  });
  assert.equal(updEntry.status, 200);
  assert.equal(updEntry.json.entry.primaryValue, 555);
  assert.equal(updEntry.json.entry.notes, 'PB updated');

  const delEntry = await alice.call(`/api/entries/${krill2.json.entry.id}`, { method: 'DELETE' });
  assert.equal(delEntry.status, 200);

  const delGame = await alice.call(`/api/games/${aliceMini.id}`, { method: 'DELETE' });
  assert.equal(delGame.status, 200);

  harness.sqliteDb.close();
});

test('Worker ensureSchema is idempotent and first user claims pre-existing user_id IS NULL legacy rows', async () => {
  const harness = createWorkerHarness({ applyMigration: false });
  await ensureSchema(harness.d1);
  await ensureSchema(harness.d1);

  // Seed a legacy unclaimed game + entry (simulating migrated local DB)
  const now = new Date().toISOString();
  harness.sqliteDb
    .prepare(
      `INSERT INTO games (user_id, name, slug, url, icon, color, category, metric_label, metric_format, metric_direction, parser_id, reset_timezone, reset_time, sort_order, archived, created_at)
       VALUES (NULL, 'Krillion', 'krillion', 'https://krillion.io', '🦑', '#06b6d4', 'Trivia', 'Score', 'number', 'higher_is_better', 'auto', 'America/New_York', '00:00', 1, 0, ?)`,
    )
    .run(now);
  harness.sqliteDb
    .prepare(
      `INSERT INTO entries (user_id, game_id, play_date, raw_text, parser_id, parser_version, completed, solved, primary_value, display_value, puzzle_id, breakdown_json, metadata_json, notes, manual_override, created_at, updated_at)
       VALUES (NULL, 1, '2026-11-15', 'Krillion #123 465', 'generic', 1, 1, NULL, 465, '465', '#123', '[]', '{}', '', 0, ?, ?)`,
    )
    .run(now, now);

  const first = harness.createSessionClient();
  const meBeforeClaim = await first.call('/api/auth/me');
  assert.equal(meBeforeClaim.status, 200);
  assert.equal(meBeforeClaim.json.authenticated, false);
  assert.equal(meBeforeClaim.json.user, null);
  assert.equal(meBeforeClaim.json.hasUsers, false);
  assert.deepEqual(meBeforeClaim.json.unclaimed, { gamesCount: 1, entriesCount: 1 });
  assert.equal(Array.isArray(meBeforeClaim.json.signupCatalog), true);
  assert.ok(meBeforeClaim.json.signupCatalog.length >= BUILTIN_CATALOG_GAMES.length);

  const regFirst = await first.call('/api/auth/register', {
    method: 'POST',
    body: { name: 'Shaleen', email: 'shaleen@example.com', password: 'password123' },
  });
  assert.equal(regFirst.status, 201);

  const entries = await first.call('/api/entries');
  assert.equal(entries.status, 200);
  assert.equal(entries.json.entries.length, 1);
  assert.equal(entries.json.entries[0].primaryValue, 465);
  assert.equal(entries.json.entries[0].puzzleId, '#123');

  harness.sqliteDb.close();
});

test('Worker Wordle custom parser, reparse, expired session rejection, and zero Node built-ins', async () => {
  const harness = createWorkerHarness({ applyMigration: true });
  const client = harness.createSessionClient();

  await client.call('/api/auth/register', {
    method: 'POST',
    body: { name: 'Wordler', email: 'wordler@example.com', password: 'password123' },
  });

  const createWordle = await client.call('/api/games', {
    method: 'POST',
    body: {
      name: 'Wordle',
      url: 'https://www.nytimes.com/games/wordle/index.html',
      metricLabel: 'Guesses',
      metricFormat: 'fraction',
      metricDirection: 'lower_is_better',
      parserId: 'generic',
    },
  });
  assert.equal(createWordle.status, 201);
  const wordleGame = createWordle.json.game;

  // Logged initially with generic parser
  const logged = await client.call('/api/entries', {
    method: 'POST',
    body: {
      gameId: wordleGame.id,
      playDate: '2026-11-16',
      rawText: 'Wordle 1,234 4/6\n\n⬛🟨⬛⬛⬛\n🟩🟩⬛⬛⬛\n🟩🟩🟩⬛⬛\n🟩🟩🟩🟩🟩',
    },
  });
  assert.equal(logged.status, 201);
  assert.equal(logged.json.entry.parserId, 'generic');

  // Switch parserId to auto and reparse
  const updatedGame = await client.call(`/api/games/${wordleGame.id}`, {
    method: 'PUT',
    body: { parserId: 'auto' },
  });
  assert.equal(updatedGame.status, 200);
  assert.equal(updatedGame.json.game.resolvedParser.id, 'wordle');

  const reparse = await client.call(`/api/games/${wordleGame.id}/reparse`, {
    method: 'POST',
    body: {},
  });
  assert.equal(reparse.status, 200);
  assert.equal(reparse.json.updatedCount, 1);

  const entriesAfter = await client.call(`/api/entries?gameId=${wordleGame.id}`);
  assert.equal(entriesAfter.json.entries[0].parserId, 'wordle');
  assert.equal(entriesAfter.json.entries[0].primaryValue, 4);
  assert.equal(entriesAfter.json.entries[0].displayValue, '4/6');

  // Force session expiry in DB -> subsequent call returns 401 and deletes stale session
  harness.sqliteDb
    .prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'")
    .run();
  const expiredBoot = await client.call('/api/bootstrap');
  assert.equal(expiredBoot.status, 401);
  const remainingSessions = harness.sqliteDb
    .prepare('SELECT COUNT(*) AS c FROM sessions')
    .get();
  assert.equal(Number(remainingSessions.c), 0);

  // Confirm worker/db-d1.js and worker/index.js contain zero Node built-ins
  for (const rel of ['worker/db-d1.js', 'worker/index.js']) {
    const src = fs.readFileSync(path.join(PROJECT_ROOT, rel), 'utf8');
    assert.doesNotMatch(src, /from\s+['"]node:/);
    assert.doesNotMatch(src, /require\s*\(/);
  }

  harness.sqliteDb.close();
});

test('Worker GET /api/leaderboard: multi-player Olympic 1224 ties, privacy, and spoiler shield', async () => {
  const harness = createWorkerHarness({ applyMigration: true });
  const anon = harness.createSessionClient();
  assert.equal((await anon.call('/api/leaderboard')).status, 401);

  const alice = harness.createSessionClient();
  const bob = harness.createSessionClient();
  const charlie = harness.createSessionClient();
  const dana = harness.createSessionClient();

  await alice.call('/api/auth/register', {
    method: 'POST',
    body: { name: 'Alice', email: 'alice-d1lb@example.com', password: 'password123' },
  });
  await bob.call('/api/auth/register', {
    method: 'POST',
    body: { name: 'Bob', email: 'bob-d1lb@example.com', password: 'password123' },
  });
  await charlie.call('/api/auth/register', {
    method: 'POST',
    body: { name: 'Charlie', email: 'charlie-d1lb@example.com', password: 'password123' },
  });
  await dana.call('/api/auth/register', {
    method: 'POST',
    body: { name: 'Dana', email: 'dana-d1lb@example.com', password: 'password123' },
  });

  const tz = 'UTC';
  const aliceBoot = await alice.call(`/api/bootstrap?live=1&tz=${tz}`);
  const bobBoot = await bob.call(`/api/bootstrap?live=1&tz=${tz}`);
  const charlieBoot = await charlie.call(`/api/bootstrap?live=1&tz=${tz}`);

  const findGame = (boot, slug) => boot.json.games.find((g) => g.slug === slug);
  const aliceClues = findGame(aliceBoot, 'cluesbysam');
  const bobClues = findGame(bobBoot, 'cluesbysam');
  const charlieClues = findGame(charlieBoot, 'cluesbysam');
  const aliceKrillion = findGame(aliceBoot, 'krillion');
  const bobKrillion = findGame(bobBoot, 'krillion');

  const cluesDate = aliceBoot.json.cardSummaries[aliceClues.id].puzzleStatus.activePuzzleDate;
  const krillionDate = aliceBoot.json.cardSummaries[aliceKrillion.id].puzzleStatus.activePuzzleDate;

  // Clues by Sam (lower_is_better): Alice & Bob tie at 1:30 (90s -> rank 1, gold, 3 pts); Charlie 2:10 (130s -> rank 3, bronze, 1 pt)
  await alice.call('/api/entries', {
    method: 'POST',
    body: { gameId: aliceClues.id, playDate: cluesDate, rawText: 'Clues by Sam #201\nSolved in 1:30' },
  });
  await bob.call('/api/entries', {
    method: 'POST',
    body: { gameId: bobClues.id, playDate: cluesDate, rawText: 'Clues by Sam #201\nSolved in 1:30' },
  });
  await charlie.call('/api/entries', {
    method: 'POST',
    body: { gameId: charlieClues.id, playDate: cluesDate, rawText: 'Clues by Sam #201\nSolved in 2:10' },
  });

  // Krillion (higher_is_better): Alice logs emoji grid + secret note
  await alice.call('/api/entries', {
    method: 'POST',
    body: {
      gameId: aliceKrillion.id,
      playDate: krillionDate,
      rawText: 'Krillion #300 🦐\n700\n\n🏮🦑🏮🐟🦑🦑🏮',
      notes: 'secret active note',
    },
  });

  // Bob adds Wordle with DNF X/6 -> 1 pt, no medal
  const bobWordle = (
    await bob.call('/api/games', {
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
  await bob.call('/api/entries', {
    method: 'POST',
    body: {
      gameId: bobWordle.id,
      playDate: wordleActiveDate,
      rawText: 'Wordle 1,250 X/6\n\n⬛🟨⬛⬛⬛\n⬛⬛⬛⬛⬛',
    },
  });

  // Bob checks leaderboard BEFORE clearing Krillion -> Alice's grid/notes shielded, no emails/rawText leaked
  const bobBefore = await bob.call(`/api/leaderboard?live=1&tz=${tz}&days=30&gameSlug=krillion`);
  assert.equal(bobBefore.status, 200);
  assert.equal(bobBefore.json.totalPlayers, 4);
  assert.equal(bobBefore.json.overallStandings.length, 4);
  assert.equal(bobBefore.text.includes('alice-d1lb@example.com'), false);
  assert.equal(bobBefore.text.includes('secret active note'), false);
  assert.equal(bobBefore.text.includes('Krillion #300'), false);

  const danaRow = bobBefore.json.overallStandings.find((p) => p.displayName === 'Dana');
  assert.equal(danaRow.arcadePoints, 0);
  assert.equal(danaRow.totalPlayed, 0);

  const aliceKrillBefore = bobBefore.json.todayMatrix.rows.find(
    (r) => r.displayName === 'Alice',
  ).cells.krillion;
  assert.equal(aliceKrillBefore.displayValue, '700');
  assert.equal(aliceKrillBefore.spoilerProtected, true);
  assert.equal(aliceKrillBefore.emojiGrid, null);
  assert.equal(aliceKrillBefore.notes, '');

  const bobWordleCell = bobBefore.json.todayMatrix.rows.find(
    (r) => r.displayName === 'Bob',
  ).cells.wordle;
  assert.equal(bobWordleCell.solved, false);
  assert.equal(bobWordleCell.points, 1);
  assert.equal(bobWordleCell.rank, null);

  // Clues by Sam Olympic 1224 tie
  const cluesLb = await bob.call(`/api/leaderboard?live=1&tz=${tz}&days=all&gameSlug=cluesbysam`);
  assert.equal(cluesLb.status, 200);
  const cStandings = cluesLb.json.gameBoard.standings;
  assert.equal(cStandings.find((s) => s.displayName === 'Alice').today.rank, 1);
  assert.equal(cStandings.find((s) => s.displayName === 'Bob').today.rank, 1);
  assert.equal(cStandings.find((s) => s.displayName === 'Charlie').today.rank, 3);
  assert.equal(cStandings.find((s) => s.displayName === 'Charlie').today.medal, 'bronze');

  // Bob clears Krillion with 900 -> unlocks Alice's spoiler shield & Bob gets gold
  await bob.call('/api/entries', {
    method: 'POST',
    body: {
      gameId: bobKrillion.id,
      playDate: krillionDate,
      rawText: 'Krillion #300 🦐\n900\n\n🏮🏮🏮🏮🏮',
    },
  });

  const bobAfter = await bob.call(`/api/leaderboard?live=1&tz=${tz}&days=30&gameSlug=krillion`);
  assert.equal(bobAfter.status, 200);
  const aliceKrillAfter = bobAfter.json.todayMatrix.rows.find(
    (r) => r.displayName === 'Alice',
  ).cells.krillion;
  assert.equal(aliceKrillAfter.spoilerProtected, false);
  assert.equal(aliceKrillAfter.emojiGrid, '🏮🦑🏮🐟🦑🦑🏮');
  assert.equal(aliceKrillAfter.notes, 'secret active note');
  assert.equal(aliceKrillAfter.rank, 2);
  assert.equal(aliceKrillAfter.medal, 'silver');

  // Invalid params -> 400
  assert.equal((await bob.call('/api/leaderboard?days=0')).status, 400);
  assert.equal((await bob.call('/api/leaderboard?tz=Not/ATimezone')).status, 400);
  assert.equal((await bob.call('/api/leaderboard?date=bad-date')).status, 400);

  harness.sqliteDb.close();
});

test('Worker Shared Hub Game Catalog: upgrade from 0001_init, subscribe/restore, URL dedup, and orphan cleanup', async () => {
  // Unit assertions on canonicalUrlKey
  assert.equal(canonicalUrlKey('https://www.costcodle.com/'), 'costcodle.com');
  assert.equal(canonicalUrlKey('http://example.com/test'), null);
  assert.equal(canonicalUrlKey('http://localhost:4321/game'), null);
  assert.equal(canonicalUrlKey('http://127.0.0.1:4321/game'), null);
  assert.equal(canonicalUrlKey('not a url'), null);

  // Start with 0001_init.sql ONLY (no 0002_game_catalog.sql pre-applied) to test auto-upgrade + backfill
  const harness = createWorkerHarness({ applyMigration: true });
  const anon = harness.createSessionClient();
  assert.equal((await anon.call('/api/catalog')).status, 401);
  assert.equal(
    (await anon.call('/api/catalog/subscribe', { method: 'POST', body: { slug: 'krillion' } })).status,
    401,
  );

  const alice = harness.createSessionClient();
  const bob = harness.createSessionClient();
  const dana = harness.createSessionClient();

  await alice.call('/api/auth/register', {
    method: 'POST',
    body: { name: 'Alice', email: 'alice-cat@example.com', password: 'password123' },
  });
  await bob.call('/api/auth/register', {
    method: 'POST',
    body: { name: 'Bob', email: 'bob-cat@example.com', password: 'password123' },
  });
  await dana.call('/api/auth/register', {
    method: 'POST',
    body: { name: 'Dana', email: 'dana-cat@example.com', password: 'password123' },
  });

  // Alice adds "NYT Connections"
  const createConn = await alice.call('/api/games', {
    method: 'POST',
    body: {
      name: 'NYT Connections',
      url: 'https://www.nytimes.com/games/connections',
      category: 'Word',
      metricLabel: 'Mistakes',
      metricFormat: 'number',
      metricDirection: 'lower_is_better',
    },
  });
  assert.equal(createConn.status, 201);
  assert.equal(createConn.json.game.slug, 'nyt-connections');

  // Bob sees it in /api/catalog, /api/bootstrap.catalog, and /api/leaderboard (zero emails leaked)
  const bobBoot = await bob.call('/api/bootstrap?live=1&tz=UTC');
  assert.equal(bobBoot.status, 200);
  const bootConn = bobBoot.json.catalog.find((c) => c.slug === 'nyt-connections');
  assert.ok(bootConn);
  assert.equal(bootConn.viewerStatus, 'not_added');
  assert.equal(bootConn.createdByName, 'Alice');
  assert.equal(bootConn.playerCount, 1);

  const bobCat = await bob.call('/api/catalog');
  assert.equal(bobCat.status, 200);
  assert.equal(bobCat.text.includes('alice-cat@example.com'), false);
  assert.equal(bobCat.json.catalog[0].slug, 'nyt-connections');

  const bobLbBefore = await bob.call('/api/leaderboard?live=1&tz=UTC&gameSlug=nyt-connections');
  assert.equal(bobLbBefore.status, 200);
  assert.equal(
    bobLbBefore.json.catalogGames.some((g) => g.slug === 'nyt-connections'),
    false,
  );
  assert.notEqual(bobLbBefore.json.gameBoard.game.slug, 'nyt-connections');

  // Unknown catalog slug -> 404
  assert.equal(
    (await bob.call('/api/catalog/subscribe', { method: 'POST', body: { slug: 'does-not-exist' } }))
      .status,
    404,
  );

  // Bob subscribes -> 201 subscribed; repeat -> 200 already_active
  const sub1 = await bob.call('/api/catalog/subscribe', {
    method: 'POST',
    body: { slug: 'nyt-connections' },
  });
  assert.equal(sub1.status, 201);
  assert.equal(sub1.json.status, 'subscribed');
  assert.equal(sub1.json.game.slug, 'nyt-connections');
  assert.equal(sub1.json.game.compete, true);

  const bobLbAfterSub = await bob.call('/api/leaderboard?live=1&tz=UTC&gameSlug=nyt-connections');
  assert.equal(bobLbAfterSub.status, 200);
  assert.equal(bobLbAfterSub.json.gameBoard.game.slug, 'nyt-connections');
  assert.equal(bobLbAfterSub.json.gameBoard.game.viewerHasGame, true);
  assert.equal(bobLbAfterSub.json.gameBoard.game.viewerArchivedGame, false);
  assert.equal(bobLbAfterSub.json.gameBoard.game.playerCount, 2);

  const sub2 = await bob.call('/api/catalog/subscribe', {
    method: 'POST',
    body: { slug: 'nyt-connections' },
  });
  assert.equal(sub2.status, 200);
  assert.equal(sub2.json.status, 'already_active');

  // Bob archives & re-subscribes -> 200 restored
  await bob.call(`/api/games/${sub1.json.game.id}`, {
    method: 'PUT',
    body: { archived: true },
  });
  const lbArchived = await bob.call('/api/leaderboard?live=1&tz=UTC&gameSlug=nyt-connections');
  assert.equal(
    lbArchived.json.catalogGames.some((g) => g.slug === 'nyt-connections'),
    false,
  );
  const bobBootArchived = await bob.call('/api/bootstrap?live=1&tz=UTC');
  assert.equal(
    bobBootArchived.json.catalog.find((c) => c.slug === 'nyt-connections')?.viewerStatus,
    'archived',
  );

  const subRestore = await bob.call('/api/catalog/subscribe', {
    method: 'POST',
    body: { slug: 'nyt-connections' },
  });
  assert.equal(subRestore.status, 200);
  assert.equal(subRestore.json.status, 'restored');
  assert.equal(subRestore.json.game.archived, false);

  // URL deduplication: Alice creates Costcodle; Dana creates Costco Daily with www + trailing slash
  const aliceCostco = await alice.call('/api/games', {
    method: 'POST',
    body: { name: 'Costcodle', url: 'https://costcodle.com' },
  });
  assert.equal(aliceCostco.status, 201);
  assert.equal(aliceCostco.json.game.slug, 'costcodle');

  const danaCostco = await dana.call('/api/games', {
    method: 'POST',
    body: { name: 'Costco Daily', url: 'https://www.costcodle.com/' },
  });
  assert.equal(danaCostco.status, 201);
  assert.equal(danaCostco.json.game.slug, 'costcodle');

  // Same-user duplicate still creates costcodle-2
  const danaCostcoDup = await dana.call('/api/games', {
    method: 'POST',
    body: { name: 'Costcodle', url: 'https://costcodle.com' },
  });
  assert.equal(danaCostcoDup.status, 201);
  assert.equal(danaCostcoDup.json.game.slug, 'costcodle-2');
  await dana.call(`/api/games/${danaCostcoDup.json.game.id}`, { method: 'DELETE' });

  // Orphan cleanup: Typo Game deleted with 0 remaining subscribers -> removed from catalog
  const typo = await dana.call('/api/games', {
    method: 'POST',
    body: { name: 'Typo Game', url: 'https://typogame.io' },
  });
  assert.equal(typo.status, 201);
  assert.equal(
    (await alice.call('/api/catalog')).json.catalog.some((c) => c.slug === 'typo-game'),
    true,
  );
  await dana.call(`/api/games/${typo.json.game.id}`, { method: 'DELETE' });
  assert.equal(
    (await alice.call('/api/catalog')).json.catalog.some((c) => c.slug === 'typo-game'),
    false,
  );

  // Alice deletes NYT Connections while Bob still owns it -> stays in catalog with playerCount: 1
  await alice.call(`/api/games/${createConn.json.game.id}`, { method: 'DELETE' });
  const aliceCatAfterDel = await alice.call('/api/catalog');
  const connRemaining = aliceCatAfterDel.json.catalog.find((c) => c.slug === 'nyt-connections');
  assert.ok(connRemaining);
  assert.equal(connRemaining.viewerStatus, 'not_added');
  assert.equal(connRemaining.playerCount, 1);

  harness.sqliteDb.close();
});

test('Worker Wave 2 D1 upgrade: legacy 7-game DB gets Plain + TimeGuessr, Clues by Sam backfill without reviving deleted games', async () => {
  const harness = createWorkerHarness({ applyMigration: true });
  const now = '2026-11-16T00:00:00.000Z';

  // Seed legacy Wave-1 production-like D1 state: 0001_init + 0002 game_catalog (no schema_migrations),
  // 1 user, 6 active games (Perceptle already deleted by user; Clues by Sam still on parser_id='auto'),
  // and existing Clues by Sam entries (one unparsed metadata, one manual difficultyOverride).
  const catalogSql = fs.readFileSync(
    path.join(PROJECT_ROOT, 'migrations', '0002_game_catalog.sql'),
    'utf8',
  );
  harness.sqliteDb.exec(catalogSql);

  harness.sqliteDb.exec(`
    INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at)
    VALUES (1, 'legacy@example.com', 'Legacy Player', 'h', 's', '2026-11-01T00:00:00Z');
  `);

  // Authenticate via a real session login after registration-style password hash, or insert a valid session token
  // Easier: register a dummy second user? Better: use shared/auth-crypto sha256Hex directly or create session row.
  const { sha256Hex } = await import('../shared/auth-crypto.js');
  const rawToken = 'legacy-test-session-token-12345';
  const tokenHash = await sha256Hex(rawToken);
  harness.sqliteDb
    .prepare(
      'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run('sess-1', 1, tokenHash, '2099-01-01T00:00:00.000Z', now);

  harness.sqliteDb.exec(`
    INSERT INTO games (id, user_id, name, slug, url, metric_label, metric_format, metric_direction, parser_id, reset_timezone, reset_time, sort_order, archived, created_at)
    VALUES
      (1, 1, 'Clues by Sam', 'cluesbysam', 'https://cluesbysam.com', 'Solve Time', 'duration_sec', 'lower_is_better', 'auto', 'America/New_York', '00:00', 1, 0, '2026-11-01T00:00:00Z'),
      (2, 1, 'Krillion', 'krillion', 'https://krillion.io', 'Score', 'number', 'higher_is_better', 'auto', 'America/New_York', '00:00', 2, 0, '2026-11-01T00:00:00Z'),
      (3, 1, 'Farflung', 'farflung', 'https://farflunggame.fun', 'Score', 'number', 'higher_is_better', 'auto', 'UTC', '00:00', 3, 0, '2026-11-01T00:00:00Z'),
      (4, 1, 'PricePoint', 'pricepoint', 'https://pricepoint.gg', 'Score', 'number', 'higher_is_better', 'auto', 'America/Los_Angeles', '00:00', 5, 0, '2026-11-01T00:00:00Z'),
      (5, 1, 'Fermi', 'fermi', 'https://fermi.gg', 'Avg Multiplier', 'number', 'lower_is_better', 'auto', 'America/New_York', '00:00', 6, 0, '2026-11-01T00:00:00Z'),
      (6, 1, 'Magnitudle', 'magnitudle', 'https://magnitudle.com', 'Score', 'number', 'higher_is_better', 'auto', 'local', '00:00', 7, 0, '2026-11-01T00:00:00Z');

    INSERT INTO game_catalog (slug, name, url, metric_label, metric_format, metric_direction, parser_id, created_at, updated_at)
    VALUES
      ('cluesbysam', 'Clues by Sam', 'https://cluesbysam.com', 'Solve Time', 'duration_sec', 'lower_is_better', 'auto', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z'),
      ('krillion', 'Krillion', 'https://krillion.io', 'Score', 'number', 'higher_is_better', 'auto', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z');

    INSERT INTO entries (id, user_id, game_id, play_date, raw_text, parser_id, parser_version, completed, solved, primary_value, display_value, puzzle_id, metadata_json, manual_override, created_at, updated_at)
    VALUES
      (1, 1, 1, '2026-11-16', 'I solved the daily #CluesBySam, Nov 16th 2026 (Easy), in 02:26\n🟩🟩🟩🟩\n🟩🟩🟩🟩\n🟩🟩🟩🟩\n🟩🟩🟩🟩\n🟩🟩🟩🟩\nhttps://cluesbysam.com', 'generic', 1, 1, 1, 146, '2:26', NULL, '{}', 0, '2026-11-16T01:00:00Z', '2026-11-16T01:00:00Z'),
      (2, 1, 1, '2026-11-15', 'I solved the daily Clues by Sam, Nov 15th 2026 (Easy), in 01:40\n🟩🟩🟩🟩', 'generic', 1, 1, 1, 99, '1:39', NULL, '{"difficulty":"Brutal","difficultyOverride":true}', 1, '2026-11-15T01:00:00Z', '2026-11-15T01:00:00Z');
  `);

  await ensureSchema(harness.d1);
  // Idempotent second pass
  await ensureSchema(harness.d1);

  const client = harness.createSessionClient();
  const authHeader = { Cookie: `__Host-dg_session=${rawToken}` };

  const gamesRes = await client.call('/api/games', { headers: authHeader });
  assert.equal(gamesRes.status, 200);
  // 6 legacy remaining (Perceptle NOT revived) + Plain + TimeGuessr + Eraly = 9
  assert.equal(gamesRes.json.games.length, 9);
  assert.equal(gamesRes.json.games.some((g) => g.slug === 'perceptle'), false);

  const cluesGame = gamesRes.json.games.find((g) => g.slug === 'cluesbysam');
  const plainGame = gamesRes.json.games.find((g) => g.slug === 'plain');
  const tgGame = gamesRes.json.games.find((g) => g.slug === 'timeguessr');
  assert.equal(cluesGame.parserId, 'cluesbysam');
  assert.equal(cluesGame.resolvedParser.id, 'cluesbysam');
  assert.ok(plainGame);
  assert.equal(plainGame.parserId, 'plain');
  assert.ok(tgGame);
  assert.equal(tgGame.parserId, 'timeguessr');

  const catClues = harness.sqliteDb
    .prepare("SELECT parser_id FROM game_catalog WHERE slug = 'cluesbysam'")
    .get();
  assert.equal(catClues.parser_id, 'cluesbysam');
  assert.ok(harness.sqliteDb.prepare("SELECT 1 FROM game_catalog WHERE slug = 'plain'").get());
  assert.ok(harness.sqliteDb.prepare("SELECT 1 FROM game_catalog WHERE slug = 'timeguessr'").get());

  const entriesRes = await client.call(`/api/entries?gameId=${cluesGame.id}`, {
    headers: authHeader,
  });
  const backfilled = entriesRes.json.entries.find((e) => e.id === 1);
  const manualProtected = entriesRes.json.entries.find((e) => e.id === 2);
  assert.equal(backfilled.difficulty, 'Easy');
  assert.equal(backfilled.metadata.difficulty, 'Easy');
  assert.equal(backfilled.metadata.cleanCount, 20);
  assert.ok(backfilled.metadata.grid);

  assert.equal(manualProtected.primaryValue, 99);
  assert.equal(manualProtected.manualOverride, true);
  assert.equal(manualProtected.difficulty, 'Brutal');
  assert.equal(manualProtected.metadata.difficulty, 'Brutal');
  assert.equal(manualProtected.metadata.difficultyOverride, true);

  // User deletes Plain explicitly -> fresh request / ensureSchema must NOT revive Plain
  const delPlain = await client.call(`/api/games/${plainGame.id}`, {
    method: 'DELETE',
    headers: authHeader,
  });
  assert.equal(delPlain.status, 200);
  await ensureSchema(harness.d1);

  const gamesAfterDelete = await client.call('/api/games', { headers: authHeader });
  assert.equal(gamesAfterDelete.json.games.length, 8);
  assert.equal(gamesAfterDelete.json.games.some((g) => g.slug === 'plain'), false);

  harness.sqliteDb.close();
});

test('Worker difficulty parse-preview, manual override/clear, /api/stats?difficulty, /api/leaderboard?difficulty, Plain & TimeGuessr', async () => {
  const harness = createWorkerHarness({ applyMigration: true });
  const alice = harness.createSessionClient();
  const bob = harness.createSessionClient();

  await alice.call('/api/auth/register', {
    method: 'POST',
    body: { name: 'Alice', email: 'alice-diff@example.com', password: 'password123' },
  });
  await bob.call('/api/auth/register', {
    method: 'POST',
    body: { name: 'Bob', email: 'bob-diff@example.com', password: 'password123' },
  });

  const aliceBoot = await alice.call('/api/bootstrap?date=2026-11-15');
  const bobBoot = await bob.call('/api/bootstrap?date=2026-11-15');
  const aliceClues = aliceBoot.json.games.find((g) => g.slug === 'cluesbysam');
  const bobClues = bobBoot.json.games.find((g) => g.slug === 'cluesbysam');
  const alicePlain = aliceBoot.json.games.find((g) => g.slug === 'plain');
  const aliceTg = aliceBoot.json.games.find((g) => g.slug === 'timeguessr');

  // 1. parse-preview with gameId and auto-detect
  const previewExplicit = await alice.call('/api/entries/parse-preview', {
    method: 'POST',
    body: {
      gameId: aliceClues.id,
      rawText: 'I solved the daily #CluesBySam, Nov 12th 2026 (Medium), in 01:30\n🟩🟩🟩🟩\n🟩🟨🟩🟩',
    },
  });
  assert.equal(previewExplicit.status, 200);
  assert.equal(previewExplicit.json.difficulty, 'Medium');
  assert.equal(previewExplicit.json.supportsDifficulty, true);
  assert.equal(previewExplicit.json.parsed.metadata.difficulty, 'Medium');
  assert.equal(previewExplicit.json.parsed.primaryValue, 90);

  const previewAuto = await alice.call('/api/entries/parse-preview', {
    method: 'POST',
    body: {
      rawText: 'I solved the daily Clues by Sam (Brutal) in 04:10\nhttps://cluesbysam.com',
    },
  });
  assert.equal(previewAuto.status, 200);
  assert.equal(previewAuto.json.matchedGame.id, aliceClues.id);
  assert.equal(previewAuto.json.difficulty, 'Brutal');
  assert.equal(previewAuto.json.supportsDifficulty, true);

  // 2. Log 4 consecutive days for Alice with Easy/Hard + explicit difficulty override on Nov 15
  const e1 = await alice.call('/api/entries', {
    method: 'POST',
    body: {
      gameId: aliceClues.id,
      playDate: '2026-11-12',
      rawText: 'I solved the daily Clues by Sam, Nov 12th 2026 (Easy), in 01:00\n🟩🟩🟩🟩',
    },
  });
  assert.equal(e1.status, 201);
  assert.equal(e1.json.entry.difficulty, 'Easy');
  assert.equal(e1.json.entry.metadata.difficultyOverride, undefined);

  await alice.call('/api/entries', {
    method: 'POST',
    body: {
      gameId: aliceClues.id,
      playDate: '2026-11-13',
      rawText: 'I solved the daily Clues by Sam, Nov 13th 2026 (Hard), in 04:00\n🟩🟩🟩🟨',
    },
  });
  await alice.call('/api/entries', {
    method: 'POST',
    body: {
      gameId: aliceClues.id,
      playDate: '2026-11-14',
      rawText: 'I solved the daily Clues by Sam, Nov 14th 2026 (Easy), in 01:30\n🟩🟩🟩🟩',
    },
  });
  const e4 = await alice.call('/api/entries', {
    method: 'POST',
    body: {
      gameId: aliceClues.id,
      playDate: '2026-11-15',
      rawText: 'I solved the daily Clues by Sam, Nov 15th 2026 (Medium), in 03:00\n🟩🟩🟩🟩',
      difficulty: 'hard',
    },
  });
  assert.equal(e4.status, 201);
  assert.equal(e4.json.entry.difficulty, 'Hard');
  assert.equal(e4.json.entry.metadata.difficulty, 'Hard');
  assert.equal(e4.json.entry.metadata.difficultyOverride, true);

  // 3. Stats unfiltered & difficulty-filtered (unified streaks)
  const statsAll = await alice.call(`/api/stats?gameId=${aliceClues.id}&date=2026-11-15&days=30`);
  assert.equal(statsAll.status, 200);
  const gsAll = statsAll.json.gameStats;
  assert.equal(gsAll.supportsDifficulty, true);
  assert.equal(gsAll.filters.difficulty, null);
  assert.equal(gsAll.kpis.currentStreak, 4);
  assert.equal(gsAll.kpis.longestStreak, 4);
  assert.deepEqual(gsAll.difficultySummary, [
    { key: 'Easy', label: 'Easy', average: 75, latest: 90, best: 60, count: 2, color: DIFFICULTY_COLORS.Easy },
    { key: 'Hard', label: 'Hard', average: 210, latest: 180, best: 180, count: 2, color: DIFFICULTY_COLORS.Hard },
  ]);

  const statsHard = await alice.call(
    `/api/stats?gameId=${aliceClues.id}&date=2026-11-15&days=30&difficulty=Hard`,
  );
  assert.equal(statsHard.status, 200);
  const gsHard = statsHard.json.gameStats;
  assert.equal(gsHard.filters.difficulty, 'Hard');
  assert.equal(gsHard.kpis.currentStreak, 4);
  assert.equal(gsHard.kpis.longestStreak, 4);
  assert.equal(gsHard.kpis.totalPlayed, 2);
  assert.equal(gsHard.kpis.averageValue, 210);
  assert.equal(gsHard.kpis.personalBest.value, 180);
  assert.equal(gsHard.trendSeries.length, 2);
  assert.equal(gsHard.entries.length, 2);

  // 4. Bob logs Easy + Hard for Leaderboard filtering verification (with gameId fallback)
  await bob.call('/api/entries', {
    method: 'POST',
    body: {
      gameId: bobClues.id,
      playDate: '2026-11-12',
      rawText: 'I solved Clues by Sam (Easy) in 00:45\n🟩🟩🟩🟩',
    },
  });
  await bob.call('/api/entries', {
    method: 'POST',
    body: {
      gameId: bobClues.id,
      playDate: '2026-11-15',
      rawText: 'I solved Clues by Sam (Hard) in 03:30\n🟩🟩🟩🟩',
    },
  });

  const lbEasy = await alice.call(
    `/api/leaderboard?date=2026-11-15&days=30&gameId=${aliceClues.id}&difficulty=Easy`,
  );
  assert.equal(lbEasy.status, 200);
  assert.equal(lbEasy.json.filters.difficulty, 'Easy');
  assert.equal(lbEasy.json.gameBoard.game.supportsDifficulty, true);
  assert.equal(lbEasy.json.gameBoard.game.filters.difficulty, 'Easy');
  // todayMatrix keeps today's actual Hard difficulty badge & points unchanged
  const aliceMatrix = lbEasy.json.todayMatrix.rows.find((r) => r.displayName === 'Alice');
  const bobMatrix = lbEasy.json.todayMatrix.rows.find((r) => r.displayName === 'Bob');
  assert.equal(aliceMatrix.cells.cluesbysam.difficulty, 'Hard');
  assert.equal(bobMatrix.cells.cluesbysam.difficulty, 'Hard');
  assert.equal(aliceMatrix.todayPoints, 3);
  assert.equal(bobMatrix.todayPoints, 2);
  // Head-to-head Easy board: Alice (2 Easy entries: 2+3=5 pts) over Bob (1 Easy entry: 3 pts, PB 45s), today=null since today's solve is Hard
  const h2h = lbEasy.json.gameBoard.standings;
  assert.equal(h2h[0].displayName, 'Alice');
  assert.equal(h2h[0].gamePoints, 5);
  assert.equal(h2h[0].totalPlayed, 2);
  assert.equal(h2h[0].personalBestValue, 60);
  assert.equal(h2h[0].currentStreak, 4);
  assert.equal(h2h[0].today, null);
  assert.equal(h2h[1].displayName, 'Bob');
  assert.equal(h2h[1].gamePoints, 3);
  assert.equal(h2h[1].totalPlayed, 1);
  assert.equal(h2h[1].personalBestValue, 45);
  assert.equal(h2h[1].today, null);

  const lbHard = await alice.call(
    `/api/leaderboard?date=2026-11-15&days=30&gameSlug=cluesbysam&difficulty=Hard`,
  );
  assert.equal(lbHard.status, 200);
  assert.equal(lbHard.json.gameBoard.standings[0].today.difficulty, 'Hard');
  assert.equal(lbHard.json.gameBoard.standings[1].today.difficulty, 'Hard');

  // 5. Explicit clear via PUT difficulty: '' -> removes metadata.difficulty and persists across fresh calls
  const cleared = await alice.call(`/api/entries/${e4.json.entry.id}`, {
    method: 'PUT',
    body: { difficulty: '' },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.entry.difficulty, null);
  assert.equal(cleared.json.entry.metadata.difficulty, undefined);
  assert.equal(cleared.json.entry.metadata.difficultyOverride, undefined);

  const afterClear = await alice.call(`/api/entries?gameId=${aliceClues.id}&date=2026-11-15`);
  assert.equal(afterClear.json.entries[0].difficulty, null);
  assert.equal(afterClear.json.entries[0].metadata.difficulty, undefined);

  // 6. Plain & TimeGuessr parse-preview + entry logging + stats in D1
  const plainPreview = await alice.call('/api/entries/parse-preview', {
    method: 'POST',
    body: { rawText: 'Plain #123 ✈️\nAltitude: 6,420m\nhttps://playplain.app/' },
  });
  assert.equal(plainPreview.status, 200);
  assert.equal(plainPreview.json.matchedGame.id, alicePlain.id);
  assert.equal(plainPreview.json.supportsDifficulty, false);
  assert.equal(plainPreview.json.parsed.primaryValue, 6420);

  const plainEntry = await alice.call('/api/entries', {
    method: 'POST',
    body: {
      gameId: alicePlain.id,
      playDate: '2026-11-15',
      rawText: 'Plain #123 ✈️\nAltitude: 6,420m\nhttps://playplain.app/',
    },
  });
  assert.equal(plainEntry.status, 201);
  assert.equal(plainEntry.json.entry.parserId, 'plain');
  assert.equal(plainEntry.json.entry.primaryValue, 6420);
  assert.equal(plainEntry.json.entry.puzzleId, '#123');

  const tgPreview = await alice.call('/api/entries/parse-preview', {
    method: 'POST',
    body: { rawText: 'TimeGuessr #412 43,210/50,000\n🟩🟩🟨⬛🟩' },
  });
  assert.equal(tgPreview.status, 200);
  assert.equal(tgPreview.json.matchedGame.id, aliceTg.id);
  assert.equal(tgPreview.json.parsed.primaryValue, 43210);

  const tgEntry = await alice.call('/api/entries', {
    method: 'POST',
    body: {
      gameId: aliceTg.id,
      playDate: '2026-11-15',
      rawText: 'TimeGuessr #412 43,210/50,000\n🟩🟩🟨⬛🟩',
    },
  });
  assert.equal(tgEntry.status, 201);
  assert.equal(tgEntry.json.entry.parserId, 'timeguessr');
  assert.equal(tgEntry.json.entry.primaryValue, 43210);
  assert.equal(tgEntry.json.entry.puzzleId, '#412');

  const plainStats = await alice.call(`/api/stats?gameId=${alicePlain.id}&date=2026-11-15`);
  assert.equal(plainStats.status, 200);
  assert.equal(plainStats.json.gameStats.supportsDifficulty, false);
  assert.equal(plainStats.json.gameStats.kpis.personalBest.value, 6420);

  const tgStats = await alice.call(`/api/stats?gameId=${aliceTg.id}&date=2026-11-15`);
  assert.equal(tgStats.status, 200);
  assert.equal(tgStats.json.gameStats.supportsDifficulty, false);
  assert.equal(tgStats.json.gameStats.kpis.personalBest.value, 43210);

  harness.sqliteDb.close();
});

test('Worker Perceptle per-round breakdown: auto-parse, manual breakdown CRUD, 400 validation, and 5-row breakdownSummary', async () => {
  const harness = createWorkerHarness({ applyMigration: true });
  const client = harness.createSessionClient();

  await client.call('/api/auth/register', {
    method: 'POST',
    body: { name: 'Percy', email: 'percy-d1@example.com', password: 'password123' },
  });

  const boot = await client.call('/api/bootstrap?date=2026-11-15');
  const perceptleGame = boot.json.games.find((g) => g.slug === 'perceptle');
  assert.equal(perceptleGame.parserId, 'perceptle');
  assert.equal(perceptleGame.resolvedParser.id, 'perceptle');

  // 1. Auto-parse Perceptle share text with grade & 5 round chips
  const pasteRes = await client.call('/api/entries', {
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

  // 2. Manual breakdown save (omits primaryValue -> computes rounded avg) + PUT edit
  const manualRes = await client.call('/api/entries', {
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

  const editRes = await client.call(`/api/entries/${manualRes.json.entry.id}`, {
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

  // 3. 400 validation errors on invalid breakdown payloads
  assert.equal(
    (
      await client.call('/api/entries', {
        method: 'POST',
        body: { gameId: perceptleGame.id, playDate: '2026-11-13', breakdown: 'bad' },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await client.call('/api/entries', {
        method: 'POST',
        body: {
          gameId: perceptleGame.id,
          playDate: '2026-11-13',
          breakdown: [{ key: 'count', label: '🔢 Count', value: 'nan' }],
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await client.call('/api/entries', {
        method: 'POST',
        body: {
          gameId: perceptleGame.id,
          playDate: '2026-11-13',
          breakdown: [{ key: 'count', label: '🔢 Count', value: null }],
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await client.call(`/api/entries/${manualRes.json.entry.id}`, {
        method: 'PUT',
        body: { breakdown: [{ key: 'count', value: 50, max: -5 }] },
      })
    ).status,
    400,
  );

  // 4. Stats 5-row breakdownSummary (avgValue, latestValue, bestValue, max: 100, count)
  const statsRes = await client.call(`/api/stats?gameId=${perceptleGame.id}&date=2026-11-15&days=30`);
  assert.equal(statsRes.status, 200);
  assert.deepEqual(statsRes.json.gameStats.breakdownSummary, [
    { label: '🔢 Count', icon: '🔢', avgValue: 71, max: 100, latestValue: 57, bestValue: 85, count: 2 },
    { label: '🎯 Track', icon: '🎯', avgValue: 84, max: 100, latestValue: 93, bestValue: 93, count: 2 },
    { label: '📐 Angle', icon: '📐', avgValue: 97.5, max: 100, latestValue: 100, bestValue: 100, count: 2 },
    { label: '🥁 Tempo', icon: '🥁', avgValue: 34, max: 100, latestValue: 3, bestValue: 65, count: 2 },
    { label: '✂️ Split', icon: '✂️', avgValue: 94, max: 100, latestValue: 93, bestValue: 95, count: 2 },
  ]);

  harness.sqliteDb.close();
});

test('Worker perceptle_parser_and_backfill_v1 migration: upgrades perceptle parser_id and backfills empty breakdown rows while respecting manual_override', async () => {
  const harness = createWorkerHarness({ applyMigration: true });
  const now = '2026-11-16T00:00:00.000Z';

  const catalogSql = fs.readFileSync(
    path.join(PROJECT_ROOT, 'migrations', '0002_game_catalog.sql'),
    'utf8',
  );
  harness.sqliteDb.exec(catalogSql);

  const { sha256Hex } = await import('../shared/auth-crypto.js');
  const rawToken = 'perceptle-mig-session-token';
  const tokenHash = await sha256Hex(rawToken);

  harness.sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_migrations (id, applied_at) VALUES
      ('wave2_starters_and_cluesbysam_v1', '2026-11-16T00:00:00.000Z'),
      ('cluesbysam_difficulty_backfill_v1', '2026-11-16T00:00:00.000Z');
    INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at)
    VALUES (1, 'p-d1@example.com', 'Player', 'h', 's', '2026-11-01T00:00:00Z');
    INSERT INTO games (id, user_id, name, slug, url, metric_label, metric_format, metric_direction, parser_id, sort_order, archived, created_at)
    VALUES (1, 1, 'Perceptle', 'perceptle', 'https://perceptle.com', 'Score', 'number', 'higher_is_better', 'auto', 4, 0, '2026-11-01T00:00:00Z');
    INSERT INTO game_catalog (slug, name, url, metric_label, metric_format, metric_direction, parser_id, created_at, updated_at)
    VALUES ('perceptle', 'Perceptle', 'https://perceptle.com', 'Score', 'number', 'higher_is_better', 'auto', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z');
    INSERT INTO entries (id, user_id, game_id, play_date, raw_text, parser_id, parser_version, completed, solved, primary_value, display_value, puzzle_id, breakdown_json, metadata_json, manual_override, created_at, updated_at)
    VALUES
      (1, 1, 1, '2026-11-16', 'Perceptle #122 - C (69)\n🔢 57  🎯 93  📐 100  🥁 3  ✂️ 93\nhttps://perceptle.com', 'generic', 1, 1, NULL, 69, '69', NULL, '[]', '{}', 0, '2026-11-16T01:00:00Z', '2026-11-16T01:00:00Z'),
      (2, 1, 1, '2026-11-15', 'Perceptle #121 - B (75)\n🔢 60  🎯 70  📐 80  🥁 75  ✂️ 90', 'generic', 1, 1, NULL, 99, '99 custom', '#999', '[]', '{}', 1, '2026-11-15T01:00:00Z', '2026-11-15T01:00:00Z');
  `);
  harness.sqliteDb
    .prepare(
      'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run('sess-p', 1, tokenHash, '2099-01-01T00:00:00.000Z', now);

  await ensureSchema(harness.d1);
  // Idempotent second pass
  await ensureSchema(harness.d1);

  const client = harness.createSessionClient();
  const authHeader = { Cookie: `__Host-dg_session=${rawToken}` };

  const gamesRes = await client.call('/api/games', { headers: authHeader });
  const perceptleGame = gamesRes.json.games.find((g) => g.slug === 'perceptle');
  assert.equal(perceptleGame.parserId, 'perceptle');
  assert.equal(perceptleGame.resolvedParser.id, 'perceptle');

  const catRow = harness.sqliteDb
    .prepare("SELECT parser_id FROM game_catalog WHERE slug = 'perceptle'")
    .get();
  assert.equal(catRow.parser_id, 'perceptle');
  assert.ok(
    harness.sqliteDb
      .prepare("SELECT 1 FROM schema_migrations WHERE id = 'perceptle_parser_and_backfill_v1'")
      .get(),
  );

  const entriesRes = await client.call(`/api/entries?gameId=${perceptleGame.id}`, {
    headers: authHeader,
  });
  const autoBackfilled = entriesRes.json.entries.find((e) => e.id === 1);
  assert.equal(autoBackfilled.parserId, 'perceptle');
  assert.equal(autoBackfilled.primaryValue, 69);
  assert.equal(autoBackfilled.displayValue, '69 (C)');
  assert.equal(autoBackfilled.puzzleId, '#122');
  assert.equal(autoBackfilled.breakdown.length, 5);
  assert.equal(autoBackfilled.metadata.grade, 'C');
  assert.equal(autoBackfilled.metadata.roundScores.tempo, 3);

  const manualRow = entriesRes.json.entries.find((e) => e.id === 2);
  assert.equal(manualRow.parserId, 'perceptle');
  assert.equal(manualRow.primaryValue, 99);
  assert.equal(manualRow.displayValue, '99 custom');
  assert.equal(manualRow.puzzleId, '#999');
  assert.equal(manualRow.breakdown.length, 5);
  assert.equal(manualRow.metadata.grade, 'B');
  assert.equal(manualRow.metadata.roundScores.split, 90);

  harness.sqliteDb.close();
});

test('Worker GET /api/leaderboard days=1 off-local targetDate parity + todayPoints, todayMedals, and Olympic todayRank on overallStandings & todayMatrix', async () => {
  const harness = createWorkerHarness({ applyMigration: true });
  const alice = harness.createSessionClient();
  const bob = harness.createSessionClient();
  const charlie = harness.createSessionClient();
  const dana = harness.createSessionClient();

  await alice.call('/api/auth/register', {
    method: 'POST',
    body: { name: 'Alice', email: 'alice-d1lb@example.com', password: 'password123' },
  });
  await bob.call('/api/auth/register', {
    method: 'POST',
    body: { name: 'Bob', email: 'bob-d1lb@example.com', password: 'password123' },
  });
  await charlie.call('/api/auth/register', {
    method: 'POST',
    body: { name: 'Charlie', email: 'charlie-d1lb@example.com', password: 'password123' },
  });
  await dana.call('/api/auth/register', {
    method: 'POST',
    body: { name: 'Dana', email: 'dana-d1lb@example.com', password: 'password123' },
  });

  const tz = 'Pacific/Kiritimati';
  const createHonolulu = await alice.call('/api/games', {
    method: 'POST',
    body: {
      name: 'Honolulu Puzzle',
      url: 'https://honolulu-d1-lb.example.com',
      resetTimezone: 'Pacific/Honolulu',
      resetTime: '00:00',
    },
  });
  assert.equal(createHonolulu.status, 201);
  const honoluluSlug = createHonolulu.json.game.slug;

  await bob.call('/api/catalog/subscribe', { method: 'POST', body: { slug: honoluluSlug } });
  await charlie.call('/api/catalog/subscribe', { method: 'POST', body: { slug: honoluluSlug } });

  const [aliceBoot, bobBoot, charlieBoot] = await Promise.all([
    alice.call(`/api/bootstrap?live=1&tz=${encodeURIComponent(tz)}`),
    bob.call(`/api/bootstrap?live=1&tz=${encodeURIComponent(tz)}`),
    charlie.call(`/api/bootstrap?live=1&tz=${encodeURIComponent(tz)}`),
  ]);

  const aliceHon = aliceBoot.json.games.find((g) => g.slug === honoluluSlug);
  const bobHon = bobBoot.json.games.find((g) => g.slug === honoluluSlug);
  const charlieHon = charlieBoot.json.games.find((g) => g.slug === honoluluSlug);
  const honTargetDate = aliceBoot.json.cardSummaries[aliceHon.id].puzzleStatus.activePuzzleDate;
  assert.notEqual(honTargetDate, aliceBoot.json.date);

  const aliceKril = aliceBoot.json.games.find((g) => g.slug === 'krillion');
  const bobKril = bobBoot.json.games.find((g) => g.slug === 'krillion');
  const krilTargetDate = aliceBoot.json.cardSummaries[aliceKril.id].puzzleStatus.activePuzzleDate;

  // Prior day play on Honolulu (yesterday relative to Honolulu cycle)
  const d = new Date(`${honTargetDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  const honPriorDate = d.toISOString().slice(0, 10);

  await charlie.call('/api/entries', {
    method: 'POST',
    body: { gameId: charlieHon.id, playDate: honPriorDate, primaryValue: 1500 },
  });

  // Active cycle plays on Honolulu + Krillion
  await alice.call('/api/entries', {
    method: 'POST',
    body: { gameId: aliceHon.id, playDate: honTargetDate, primaryValue: 900 },
  });
  await bob.call('/api/entries', {
    method: 'POST',
    body: { gameId: bobHon.id, playDate: honTargetDate, primaryValue: 900 },
  });
  await charlie.call('/api/entries', {
    method: 'POST',
    body: { gameId: charlieHon.id, playDate: honTargetDate, primaryValue: 500 },
  });
  await alice.call('/api/entries', {
    method: 'POST',
    body: { gameId: aliceKril.id, playDate: krilTargetDate, primaryValue: 400 },
  });
  await bob.call('/api/entries', {
    method: 'POST',
    body: { gameId: bobKril.id, playDate: krilTargetDate, primaryValue: 400 },
  });

  const lb1 = await alice.call(`/api/leaderboard?days=1&live=1&tz=${encodeURIComponent(tz)}`);
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
  assert.equal(findRow(lb1.json.overallStandings, 'Alice').todayRank, 1);
  assert.equal(findRow(lb1.json.overallStandings, 'Bob').todayRank, 1);
  assert.equal(findRow(lb1.json.overallStandings, 'Charlie').todayRank, 3);
  assert.equal(findRow(lb1.json.overallStandings, 'Dana').todayRank, null);

  const lb30 = await alice.call(`/api/leaderboard?days=30&live=1&tz=${encodeURIComponent(tz)}`);
  assert.equal(lb30.status, 200);
  const c30 = findRow(lb30.json.overallStandings, 'Charlie');
  const cMatrix30 = findRow(lb30.json.todayMatrix.rows, 'Charlie');
  const d30 = findRow(lb30.json.overallStandings, 'Dana');
  assert.equal(c30.arcadePoints, 4);
  assert.equal(c30.todayPoints, 1);
  assert.deepEqual(c30.todayMedals, { gold: 0, silver: 0, bronze: 1 });
  assert.equal(c30.todayRank, 3);
  assert.equal(cMatrix30.todayPoints, 1);
  assert.deepEqual(cMatrix30.todayMedals, { gold: 0, silver: 0, bronze: 1 });
  assert.equal(cMatrix30.todayRank, 3);
  assert.equal(d30.todayRank, null);

  harness.sqliteDb.close();
});

test('Worker fermi_magnitudle_grids_backfill_v1: repairs Fermi 1.19 -> 1.30× & 134 -> 27.6×, respects manual_override, and backfills Magnitudle, Perceptle & TimeGuessr grids', async () => {
  const harness = createWorkerHarness({ applyMigration: true });
  const now = '2026-11-16T00:00:00.000Z';

  const catalogSql = fs.readFileSync(
    path.join(PROJECT_ROOT, 'migrations', '0002_game_catalog.sql'),
    'utf8',
  );
  harness.sqliteDb.exec(catalogSql);

  const { sha256Hex } = await import('../shared/auth-crypto.js');
  const rawToken = 'fermi-mig-session-token';
  const tokenHash = await sha256Hex(rawToken);

  harness.sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_migrations (id, applied_at) VALUES
      ('wave2_starters_and_cluesbysam_v1', '2026-11-16T00:00:00.000Z'),
      ('cluesbysam_difficulty_backfill_v1', '2026-11-16T00:00:00.000Z'),
      ('perceptle_parser_and_backfill_v1', '2026-11-16T00:00:00.000Z');
    INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at)
    VALUES (1, 'fm-d1@example.com', 'Player', 'h', 's', '2026-11-01T00:00:00Z');
    INSERT INTO games (id, user_id, name, slug, url, metric_label, metric_format, metric_direction, parser_id, sort_order, archived, created_at)
    VALUES
      (1, 1, 'Fermi', 'fermi', 'https://fermi.gg', 'Avg Multiplier', 'number', 'lower_is_better', 'auto', 6, 0, '2026-11-01T00:00:00Z'),
      (2, 1, 'Magnitudle', 'magnitudle', 'https://magnitudle.com', 'Score', 'number', 'higher_is_better', 'auto', 7, 0, '2026-11-01T00:00:00Z'),
      (3, 1, 'Perceptle', 'perceptle', 'https://perceptle.com', 'Score', 'number', 'higher_is_better', 'perceptle', 4, 0, '2026-11-01T00:00:00Z'),
      (4, 1, 'TimeGuessr', 'timeguessr', 'https://timeguessr.com', 'Score', 'number', 'higher_is_better', 'timeguessr', 9, 0, '2026-11-01T00:00:00Z');
    INSERT INTO game_catalog (slug, name, url, metric_label, metric_format, metric_direction, parser_id, created_at, updated_at)
    VALUES
      ('fermi', 'Fermi', 'https://fermi.gg', 'Avg Multiplier', 'number', 'lower_is_better', 'auto', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z'),
      ('magnitudle', 'Magnitudle', 'https://magnitudle.com', 'Score', 'number', 'higher_is_better', 'auto', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z');
  `);
  harness.sqliteDb
    .prepare(
      'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run('sess-fm', 1, tokenHash, '2099-01-01T00:00:00.000Z', now);

  const ins = harness.sqliteDb.prepare(`
    INSERT INTO entries (
      id, user_id, game_id, play_date, raw_text, parser_id, parser_version,
      completed, solved, primary_value, display_value, puzzle_id,
      breakdown_json, metadata_json, manual_override, created_at, updated_at
    ) VALUES (?, 1, ?, ?, ?, ?, 1, 1, NULL, ?, ?, ?, ?, ?, ?, '2026-11-16T00:00:00Z', '2026-11-16T00:00:00Z')
  `);

  // 1. Legacy Fermi wrong 1.19 (manual_override = 0)
  ins.run(
    1,
    1,
    '2026-11-16',
    'Fermi · No. 113\n01 ↑ 1.28×\n02 ↓ 1.42×\n03 ↓ 1.19×\n─────────\n1.30× score · top 2%\n<https://fermi.gg/s/daily>',
    'generic',
    1.19,
    '1.19',
    null,
    '[]',
    '{}',
    0,
  );
  // 2. Legacy Fermi wrong 134 (manual_override = 0)
  ins.run(
    2,
    1,
    '2026-11-15',
    'Fermi · No. 112\n01 ↑ 64.1×\n02 ↑ 2.46×\n03 ↑ 134×\n─────────\n27.6× score · top 89%',
    'generic',
    134,
    '134',
    null,
    '[]',
    '{}',
    0,
  );
  // 3. Manual Fermi 6.11 with unprefixed puzzle_id '113' -> preserves 6.11 / display, normalizes '#113', adds breakdown + grid
  ins.run(
    3,
    1,
    '2026-11-14',
    'Fermi · No. 113\n01 ↑ 1.28×\n02 ↓ 1.42×\n03 ↓ 1.19×\n─────────\n1.30× score · top 2%',
    'generic',
    6.11,
    '6.11× manual',
    '113',
    '[]',
    '{}',
    1,
  );
  // 4. Double-pasted Magnitudle Size It Up #99 -> dedupes grid & adds 5-row breakdown
  const magGridDup =
    '🟥🟥⬜⬜⬜ 39\n🟥🟥🟥⬜⬜ 53\n⬜⬜⬜⬜⬜ 4\n⬜⬜⬜⬜⬜ 0\n🟥⬜⬜⬜⬜ 20\n🟥🟥⬜⬜⬜ 39\n🟥🟥🟥⬜⬜ 53\n⬜⬜⬜⬜⬜ 4\n⬜⬜⬜⬜⬜ 0\n🟥⬜⬜⬜⬜ 20';
  ins.run(
    4,
    2,
    '2026-11-16',
    'Size It Up\n#99\n\nScore: 116/500\n\n🟥🟥⬜⬜⬜ 39\n🟥🟥🟥⬜⬜ 53\n⬜⬜⬜⬜⬜ 4\n⬜⬜⬜⬜⬜ 0\n🟥⬜⬜⬜⬜ 20\nSize It Up\n#99\n\nScore: 116/500\n\n🟥🟥⬜⬜⬜ 39\n🟥🟥🟥⬜⬜ 53\n⬜⬜⬜⬜⬜ 4\n⬜⬜⬜⬜⬜ 0\n🟥⬜⬜⬜⬜ 20',
    'generic',
    116,
    '116/500',
    '#99',
    '[]',
    JSON.stringify({ emojiGrid: magGridDup }),
    0,
  );
  // 5. Perceptle with breakdown already populated (missing emojiGrid)
  ins.run(
    5,
    3,
    '2026-11-16',
    'Perceptle #122 - C (69)\n🔢 57  🎯 93  📐 100  🥁 3  ✂️ 93\nhttps://perceptle.com',
    'perceptle',
    69,
    '69 (C)',
    '#122',
    JSON.stringify([
      { key: 'count', icon: '🔢', name: 'Count', label: '🔢 Count', value: 57, max: 100, display: '57' },
    ]),
    JSON.stringify({ grade: 'C', maxScore: 100, roundScores: { count: 57 } }),
    0,
  );
  // 6. TimeGuessr with 🏆 rounds (missing breakdown & 🏆 grid)
  ins.run(
    6,
    4,
    '2026-11-16',
    'TimeGuessr #1265 — 27,292/50,000\n\n1️⃣ 🏆4,706 · 📅 3y · 🌍 12226.3km\n2️⃣ 🏆3,351 · 📅 21y · 🌍 1651.6km\n3️⃣ 🏆4,448 · 📅 6y · 🌍 4135.0km\n4️⃣ 🏆7,371 · 📅 7y · 🌍 574.7km\n5️⃣ 🏆7,416 · 📅 12y · 🌍 8.3km',
    'timeguessr',
    27292,
    '27,292 / 50,000',
    '#1265',
    '[]',
    JSON.stringify({ emojiGrid: '1️⃣ 📅 3y\n2️⃣ 📅 21y' }),
    0,
  );

  await ensureSchema(harness.d1);
  // Idempotent second pass
  await ensureSchema(harness.d1);

  const client = harness.createSessionClient();
  const authHeader = { Cookie: `__Host-dg_session=${rawToken}` };

  const gamesRes = await client.call('/api/games', { headers: authHeader });
  const fermiGame = gamesRes.json.games.find((g) => g.slug === 'fermi');
  const magGame = gamesRes.json.games.find((g) => g.slug === 'magnitudle');
  assert.equal(fermiGame.parserId, 'fermi');
  assert.equal(magGame.parserId, 'magnitudle');

  assert.equal(
    harness.sqliteDb.prepare("SELECT parser_id FROM game_catalog WHERE slug = 'fermi'").get().parser_id,
    'fermi',
  );
  assert.equal(
    harness.sqliteDb.prepare("SELECT parser_id FROM game_catalog WHERE slug = 'magnitudle'").get().parser_id,
    'magnitudle',
  );
  assert.ok(
    harness.sqliteDb
      .prepare("SELECT 1 FROM schema_migrations WHERE id = 'fermi_magnitudle_grids_backfill_v1'")
      .get(),
  );

  const entriesRes = await client.call('/api/entries', { headers: authHeader });
  const byId = new Map(entriesRes.json.entries.map((e) => [e.id, e]));

  const f1 = byId.get(1);
  assert.equal(f1.parserId, 'fermi');
  assert.equal(f1.primaryValue, 1.3);
  assert.equal(f1.displayValue, '1.30×');
  assert.equal(f1.puzzleId, '#113');
  assert.equal(f1.breakdown.length, 3);
  assert.equal(f1.metadata.topPercent, 2);
  assert.ok(f1.metadata.emojiGrid.includes('01 ↑ 1.28×'));

  const f2 = byId.get(2);
  assert.equal(f2.primaryValue, 27.6);
  assert.equal(f2.displayValue, '27.6×');
  assert.equal(f2.puzzleId, '#112');

  const fManual = byId.get(3);
  assert.equal(fManual.primaryValue, 6.11);
  assert.equal(fManual.displayValue, '6.11× manual');
  assert.equal(fManual.puzzleId, '#113');
  assert.equal(fManual.breakdown.length, 3);
  assert.equal(fManual.metadata.topPercent, 2);
  assert.ok(fManual.metadata.emojiGrid.includes('01 ↑ 1.28×'));

  const mRow = byId.get(4);
  assert.equal(mRow.parserId, 'magnitudle');
  assert.equal(mRow.breakdown.length, 5);
  assert.equal(mRow.metadata.maxScore, 500);
  assert.equal(mRow.metadata.emojiGrid.split('\n').length, 5);

  const pRow = byId.get(5);
  assert.ok(pRow.metadata.emojiGrid.includes('🔢 Count · 57'));

  const tgRow = byId.get(6);
  assert.equal(tgRow.breakdown.length, 5);
  assert.equal(tgRow.breakdown[0].value, 4706);
  assert.ok(tgRow.metadata.emojiGrid.includes('1️⃣ 🏆4,706'));

  harness.sqliteDb.close();
});

test('Worker eraly_starter_v1 migration appends Eraly onto 9-game legacy D1 shelf without reviving deleted games + Eraly #32 logging & stats', async () => {
  const harness = createWorkerHarness({ applyMigration: true });
  const now = '2026-11-16T00:00:00.000Z';

  const catalogSql = fs.readFileSync(
    path.join(PROJECT_ROOT, 'migrations', '0002_game_catalog.sql'),
    'utf8',
  );
  harness.sqliteDb.exec(catalogSql);

  const { sha256Hex } = await import('../shared/auth-crypto.js');
  const rawToken = 'eraly-mig-session-token';
  const tokenHash = await sha256Hex(rawToken);

  harness.sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_migrations (id, applied_at) VALUES
      ('wave2_starters_and_cluesbysam_v1', '2026-11-16T00:00:00.000Z'),
      ('cluesbysam_difficulty_backfill_v1', '2026-11-16T00:00:00.000Z'),
      ('perceptle_parser_and_backfill_v1', '2026-11-16T00:00:00.000Z'),
      ('fermi_magnitudle_grids_backfill_v1', '2026-11-16T00:00:00.000Z');
    INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at)
    VALUES (1, 'eraly-d1@example.com', 'Player', 'h', 's', '2026-11-01T00:00:00Z');
    -- 9-game user who intentionally deleted TimeGuessr (8 rows before migration)
    INSERT INTO games (id, user_id, name, slug, url, metric_label, metric_format, metric_direction, parser_id, sort_order, archived, created_at)
    VALUES
      (1, 1, 'Clues by Sam', 'cluesbysam', 'https://cluesbysam.com', 'Solve Time', 'duration_sec', 'lower_is_better', 'cluesbysam', 1, 0, '2026-11-01T00:00:00Z'),
      (2, 1, 'Krillion', 'krillion', 'https://krillion.io', 'Score', 'number', 'higher_is_better', 'auto', 2, 0, '2026-11-01T00:00:00Z'),
      (3, 1, 'Farflung', 'farflung', 'https://farflunggame.fun', 'Score', 'number', 'higher_is_better', 'auto', 3, 0, '2026-11-01T00:00:00Z'),
      (4, 1, 'Perceptle', 'perceptle', 'https://perceptle.com', 'Score', 'number', 'higher_is_better', 'perceptle', 4, 0, '2026-11-01T00:00:00Z'),
      (5, 1, 'PricePoint', 'pricepoint', 'https://pricepoint.gg', 'Score', 'number', 'higher_is_better', 'auto', 5, 0, '2026-11-01T00:00:00Z'),
      (6, 1, 'Fermi', 'fermi', 'https://fermi.gg', 'Avg Multiplier', 'number', 'lower_is_better', 'fermi', 6, 0, '2026-11-01T00:00:00Z'),
      (7, 1, 'Magnitudle', 'magnitudle', 'https://magnitudle.com', 'Score', 'number', 'higher_is_better', 'magnitudle', 7, 0, '2026-11-01T00:00:00Z'),
      (8, 1, 'Plain', 'plain', 'https://playplain.app/', 'Altitude', 'number', 'higher_is_better', 'plain', 8, 0, '2026-11-01T00:00:00Z');
  `);
  harness.sqliteDb
    .prepare(
      'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run('sess-eraly', 1, tokenHash, '2099-01-01T00:00:00.000Z', now);

  await ensureSchema(harness.d1);
  await ensureSchema(harness.d1);

  const client = harness.createSessionClient();
  const authHeader = { Cookie: `__Host-dg_session=${rawToken}` };

  const gamesRes = await client.call('/api/games', { headers: authHeader });
  assert.equal(gamesRes.status, 200);
  assert.equal(gamesRes.json.games.length, 9);
  assert.equal(gamesRes.json.games.some((g) => g.slug === 'timeguessr'), false);
  const eraly = gamesRes.json.games.find((g) => g.slug === 'eraly');
  assert.ok(eraly);
  assert.equal(eraly.parserId, 'eraly');
  assert.equal(eraly.resolvedParser.id, 'eraly');
  assert.equal(
    harness.sqliteDb.prepare("SELECT parser_id FROM game_catalog WHERE slug = 'eraly'").get()
      .parser_id,
    'eraly',
  );
  assert.ok(
    harness.sqliteDb
      .prepare("SELECT 1 FROM schema_migrations WHERE id = 'eraly_starter_v1'")
      .get(),
  );

  // Log Eraly #32 share text and check stats
  const eralyRaw =
    'Eraly #32 · I travelled to 1842 AD\n▰▰▰▰▰▰▰▱▱▱ 515/700\n🟨🟦🟩🟧🟥🟨💤\nhttps://eraly.io';
  const eralyEntry = await client.call('/api/entries', {
    method: 'POST',
    headers: authHeader,
    body: { gameId: eraly.id, playDate: '2026-11-16', rawText: eralyRaw },
  });
  assert.equal(eralyEntry.status, 201);
  assert.equal(eralyEntry.json.entry.parserId, 'eraly');
  assert.equal(eralyEntry.json.entry.puzzleId, '#32');
  assert.equal(eralyEntry.json.entry.primaryValue, 515);
  assert.equal(eralyEntry.json.entry.displayValue, '515/700');
  assert.equal(eralyEntry.json.entry.breakdown.length, 7);
  assert.ok(eralyEntry.json.entry.metadata.emojiGrid.includes('🟨🟦🟩🟧🟥🟨💤'));

  const eralyStats = await client.call(`/api/stats?gameId=${eraly.id}&date=2026-11-16`, {
    headers: authHeader,
  });
  assert.equal(eralyStats.status, 200);
  assert.equal(eralyStats.json.gameStats.kpis.personalBest.value, 515);
  assert.equal(eralyStats.json.gameStats.breakdownSummary.length, 7);

  // If user deletes Eraly, subsequent ensureSchema runs must NOT revive it
  const delEraly = await client.call(`/api/games/${eraly.id}`, {
    method: 'DELETE',
    headers: authHeader,
  });
  assert.equal(delEraly.status, 200);
  await ensureSchema(harness.d1);
  const gamesAfterDelete = await client.call('/api/games', { headers: authHeader });
  assert.equal(gamesAfterDelete.json.games.some((g) => g.slug === 'eraly'), false);

  harness.sqliteDb.close();
});

test('Worker D1 verifiedSchemaDbs WeakSet + 1-query cold fast-path + single-round-trip d1.batch datasets', async () => {
  const harness = createWorkerHarness({ applyMigration: false });
  await ensureSchema(harness.d1);

  // Create a fresh D1 adapter instance around the already-migrated sqliteDb to simulate a cold isolate
  function createCountedD1(baseD1) {
    let prepareCalls = 0;
    let batchCalls = 0;
    return {
      get counts() {
        return { prepareCalls, batchCalls };
      },
      resetCounts() {
        prepareCalls = 0;
        batchCalls = 0;
      },
      prepare(sql) {
        prepareCalls += 1;
        return baseD1.prepare(sql);
      },
      async batch(stmts) {
        batchCalls += 1;
        return baseD1.batch(stmts);
      },
      async exec(sql) {
        return baseD1.exec(sql);
      },
    };
  }

  const coldD1 = createCountedD1(createD1Adapter(harness.sqliteDb));
  const dbCold = createD1Database(coldD1);

  // 1st call on a cold isolate hits 1-query cold fast-path (SELECT id FROM schema_migrations) + listUsersPublic (1 query)
  await dbCold.listUsersPublic();
  assert.equal(coldD1.counts.prepareCalls, 2);

  // 2nd call on a fresh createD1Database(coldD1) skips ensureSchema completely (0 schema queries via verifiedSchemaDbs WeakSet)
  coldD1.resetCounts();
  const dbWarm = createD1Database(coldD1);
  await dbWarm.listUsersPublic();
  assert.equal(coldD1.counts.prepareCalls, 1);

  // Verify batched getAuthBootstrapStatus, getBootstrapDataset, getLeaderboardDataset, and upsertEntry
  coldD1.resetCounts();
  const status = await dbWarm.getAuthBootstrapStatus();
  assert.equal(status.hasUsers, false);
  assert.equal(coldD1.counts.batchCalls, 1);

  const user = await dbWarm.registerUser({
    name: 'Fast',
    email: 'fast-d1@example.com',
    passwordHash: 'hash',
    passwordSalt: 'salt',
  });
  assert.equal(user.displayName, 'Fast');

  coldD1.resetCounts();
  const bootData = await dbWarm.getBootstrapDataset(user.id);
  assert.equal(bootData.games.length, 10);
  assert.equal(bootData.catalog.length, BUILTIN_CATALOG_GAMES.length);
  assert.equal(coldD1.counts.batchCalls, 1);

  coldD1.resetCounts();
  const lbData = await dbWarm.getLeaderboardDataset();
  assert.equal(lbData.users.length, 1);
  assert.equal(lbData.allGames.length, 10);
  assert.equal(coldD1.counts.batchCalls, 1);

  coldD1.resetCounts();
  const saved = await dbWarm.upsertEntry(
    {
      gameId: bootData.games[0].id,
      playDate: '2026-11-16',
      primaryValue: 120,
      displayValue: '2:00',
    },
    user.id,
  );
  assert.equal(saved.primaryValue, 120);
  // 2 batches total: [getGame, getExistingEntry] + [upsertEntry, selectSaved]
  assert.equal(coldD1.counts.batchCalls, 2);

  harness.sqliteDb.close();
});

test('Worker GET /api/bootstrap entries parity and GET /api/leaderboard gameBoardsBySlug parity (including cluesbysam.byDifficulty)', async () => {
  const harness = createWorkerHarness({ applyMigration: true });
  const alice = harness.createSessionClient();
  const bob = harness.createSessionClient();

  await alice.call('/api/auth/register', {
    method: 'POST',
    body: { name: 'Alice', email: 'alice-gb-d1@example.com', password: 'password123' },
  });
  await bob.call('/api/auth/register', {
    method: 'POST',
    body: { name: 'Bob', email: 'bob-gb-d1@example.com', password: 'password123' },
  });

  const aliceGames = (await alice.call('/api/games')).json.games;
  const bobGames = (await bob.call('/api/games')).json.games;
  const aClues = aliceGames.find((g) => g.slug === 'cluesbysam');
  const aFermi = aliceGames.find((g) => g.slug === 'fermi');
  const bClues = bobGames.find((g) => g.slug === 'cluesbysam');
  const bFermi = bobGames.find((g) => g.slug === 'fermi');

  await alice.call('/api/entries', {
    method: 'POST',
    body: { gameId: aClues.id, playDate: '2026-11-15', rawText: 'I solved Clues by Sam (Easy) in 01:20' },
  });
  await alice.call('/api/entries', {
    method: 'POST',
    body: { gameId: aClues.id, playDate: '2026-11-16', rawText: 'I solved Clues by Sam (Hard) in 02:30' },
  });
  await alice.call('/api/entries', {
    method: 'POST',
    body: { gameId: aFermi.id, playDate: '2026-11-16', rawText: 'Fermi · No. 113\n01 ↑ 1.28×\n─────────\n1.30× score' },
  });

  await bob.call('/api/entries', {
    method: 'POST',
    body: { gameId: bClues.id, playDate: '2026-11-15', rawText: 'I solved Clues by Sam (Easy) in 00:55' },
  });
  await bob.call('/api/entries', {
    method: 'POST',
    body: { gameId: bClues.id, playDate: '2026-11-16', rawText: 'I solved Clues by Sam (Hard) in 03:00' },
  });
  await bob.call('/api/entries', {
    method: 'POST',
    body: { gameId: bFermi.id, playDate: '2026-11-16', rawText: 'Fermi · No. 113\n01 ↑ 2.10×\n─────────\n2.10× score' },
  });

  const [bootRes, entriesRes] = await Promise.all([
    alice.call('/api/bootstrap?date=2026-11-16'),
    alice.call('/api/entries'),
  ]);
  assert.equal(bootRes.status, 200);
  assert.equal(entriesRes.status, 200);
  assert.deepEqual(bootRes.json.entries, entriesRes.json.entries);
  assert.equal(bootRes.json.entries.length, 3);

  const lbRes = await alice.call('/api/leaderboard?date=2026-11-16&days=30');
  assert.equal(lbRes.status, 200);
  assert.ok(lbRes.json.gameBoardsBySlug);

  for (const cg of lbRes.json.catalogGames) {
    assert.ok(lbRes.json.gameBoardsBySlug[cg.slug], `Missing gameBoardsBySlug for ${cg.slug}`);
    const individual = await alice.call(
      `/api/leaderboard?date=2026-11-16&days=30&gameSlug=${encodeURIComponent(cg.slug)}`,
    );
    assert.deepEqual(
      {
        game: lbRes.json.gameBoardsBySlug[cg.slug].game,
        standings: lbRes.json.gameBoardsBySlug[cg.slug].standings,
      },
      individual.json.gameBoard,
    );
  }

  const cluesBundle = lbRes.json.gameBoardsBySlug.cluesbysam;
  assert.ok(cluesBundle.byDifficulty);
  for (const diff of ['Easy', 'Medium', 'Tricky', 'Hard', 'Brutal']) {
    assert.ok(cluesBundle.byDifficulty[diff], `Missing byDifficulty.${diff}`);
    const individualDiff = await alice.call(
      `/api/leaderboard?date=2026-11-16&days=30&gameSlug=cluesbysam&difficulty=${diff}`,
    );
    assert.deepEqual(cluesBundle.byDifficulty[diff], individualDiff.json.gameBoard);
  }

  harness.sqliteDb.close();
});

test('Worker signupCatalog, selective competingSlugs (fresh + unclaimed claim), compete toggle, and optional catalog orphan protection', async () => {
  const harness = createWorkerHarness({ applyMigration: true });
  const anon = harness.createSessionClient();
  const alice = harness.createSessionClient();
  const bob = harness.createSessionClient();

  const me = await anon.call('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.signupCatalog.length, BUILTIN_CATALOG_GAMES.length);
  assert.equal(me.json.signupCatalog.find((g) => g.slug === 'magnitudle')?.name, 'Size It Up');
  assert.equal(me.json.signupCatalog.find((g) => g.slug === 'weigh-it-up')?.isOptional, true);
  assert.equal(me.json.signupCatalog.find((g) => g.slug === 'skyq')?.collection, 'FlightQ');

  // Invalid competingSlugs -> 400 with zero orphan user created
  for (const badSlugs of ['cluesbysam', [123], [], ['does-not-exist']]) {
    const badReg = await alice.call('/api/auth/register', {
      method: 'POST',
      body: {
        name: 'Bad',
        email: 'bad-slugs@example.com',
        password: 'password123',
        competingSlugs: badSlugs,
      },
    });
    assert.equal(badReg.status, 400);
  }
  assert.equal(Number(harness.sqliteDb.prepare('SELECT COUNT(*) AS c FROM users').get().c), 0);

  // Alice registers with selective competingSlugs (1 starter + 1 optional)
  const regAlice = await alice.call('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Alice',
      email: 'alice-sel-d1@example.com',
      password: 'password123',
      competingSlugs: ['cluesbysam', 'weigh-it-up'],
    },
  });
  assert.equal(regAlice.status, 201);
  const aliceGames = (await alice.call('/api/games')).json.games;
  assert.deepEqual(
    aliceGames.map((g) => g.slug),
    ['cluesbysam', 'weigh-it-up'],
  );
  assert.equal(aliceGames.every((g) => g.compete === true), true);

  const aliceCat = await alice.call('/api/catalog');
  assert.equal(aliceCat.status, 200);
  const weighCat = aliceCat.json.catalog.find((c) => c.slug === 'weigh-it-up');
  assert.equal(weighCat.viewerStatus, 'active');
  assert.equal(weighCat.viewerCompete, true);
  assert.equal(weighCat.competingCount, 1);

  // Bob registers normally, subscribes to SkyQ with compete: false (validated boolean)
  await bob.call('/api/auth/register', {
    method: 'POST',
    body: { name: 'Bob', email: 'bob-sel-d1@example.com', password: 'password123' },
  });
  const badSub = await bob.call('/api/catalog/subscribe', {
    method: 'POST',
    body: { slug: 'skyq', compete: 'nope' },
  });
  assert.equal(badSub.status, 400);

  const bobSub = await bob.call('/api/catalog/subscribe', {
    method: 'POST',
    body: { slug: 'skyq', compete: false },
  });
  assert.equal(bobSub.status, 201);
  assert.equal(bobSub.json.game.slug, 'skyq');
  assert.equal(bobSub.json.game.compete, false);

  await bob.call('/api/entries', {
    method: 'POST',
    body: {
      gameId: bobSub.json.game.id,
      playDate: '2026-11-16',
      rawText: 'SkyQ #10\n✈️🟩🟩 3/6',
    },
  });

  const bobBoot = await bob.call('/api/bootstrap?date=2026-11-16');
  assert.equal(bobBoot.status, 200);
  assert.equal(bobBoot.json.games.some((g) => g.slug === 'skyq' && g.compete === false), true);
  assert.equal(bobBoot.json.entries.some((e) => e.gameId === bobSub.json.game.id), true);

  const bobCat = await bob.call('/api/catalog');
  const skyCat = bobCat.json.catalog.find((c) => c.slug === 'skyq');
  assert.equal(skyCat.viewerStatus, 'active');
  assert.equal(skyCat.viewerCompete, false);
  assert.equal(skyCat.playerCount, 1);
  assert.equal(skyCat.competingCount, 0);

  const bobLb = await bob.call('/api/leaderboard?date=2026-11-16&days=30&gameSlug=skyq');
  assert.equal(bobLb.status, 200);
  assert.equal(bobLb.json.catalogGames.some((g) => g.slug === 'skyq'), false);
  assert.equal(
    bobLb.json.overallStandings.find((p) => p.displayName === 'Bob').arcadePoints,
    0,
  );

  // Alice toggles weigh-it-up to compete: false -> excluded from leaderboard; delete keeps optional catalog entry
  const aliceWeigh = aliceGames.find((g) => g.slug === 'weigh-it-up');
  const toggled = await alice.call(`/api/games/${aliceWeigh.id}`, {
    method: 'PUT',
    body: { compete: false },
  });
  assert.equal(toggled.status, 200);
  assert.equal(toggled.json.game.compete, false);

  const aliceLb = await alice.call('/api/leaderboard?date=2026-11-16&days=30');
  assert.equal(aliceLb.json.catalogGames.some((g) => g.slug === 'weigh-it-up'), false);

  assert.equal((await alice.call(`/api/games/${aliceWeigh.id}`, { method: 'DELETE' })).status, 200);
  assert.ok(
    harness.sqliteDb.prepare("SELECT 1 FROM game_catalog WHERE slug = 'weigh-it-up'").get(),
    'Built-in optional catalog game should survive last-user deletion',
  );
  harness.sqliteDb.close();

  // Claiming unclaimed legacy data with competingSlugs flips unselected unclaimed games to compete=0 & inserts selected optional games
  const claimHarness = createWorkerHarness({ applyMigration: true });
  await ensureSchema(claimHarness.d1);
  const now = new Date().toISOString();
  claimHarness.sqliteDb
    .prepare(
      `INSERT INTO games (user_id, name, slug, url, icon, color, category, metric_label, metric_format, metric_direction, parser_id, reset_timezone, reset_time, sort_order, archived, compete, created_at)
       VALUES (NULL, 'Krillion', 'krillion', 'https://krillion.io', '🦑', '#06b6d4', 'Trivia', 'Score', 'number', 'higher_is_better', 'auto', 'America/New_York', '00:00', 1, 0, 1, ?)`,
    )
    .run(now);
  const charlie = claimHarness.createSessionClient();
  const regCharlie = await charlie.call('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Charlie',
      email: 'charlie-claim-d1@example.com',
      password: 'password123',
      competingSlugs: ['cluesbysam', 'skyq'],
    },
  });
  assert.equal(regCharlie.status, 201);
  const charlieGames = (await charlie.call('/api/games')).json.games;
  assert.equal(charlieGames.find((g) => g.slug === 'krillion')?.compete, false);
  assert.equal(charlieGames.find((g) => g.slug === 'cluesbysam')?.compete, true);
  assert.equal(charlieGames.find((g) => g.slug === 'skyq')?.compete, true);
  claimHarness.sqliteDb.close();
});

test('Worker Clues by Sam accuracy-first weighted Leaderboard ranking, spoiler shield, and export/import compete round-trip', async () => {
  const harness = createWorkerHarness({ applyMigration: true });
  const alice = harness.createSessionClient();
  const bob = harness.createSessionClient();
  const charlie = harness.createSessionClient();
  const dana = harness.createSessionClient();
  const eve = harness.createSessionClient();

  for (const [client, name, email] of [
    [alice, 'Alice', 'alice-acc-d1@example.com'],
    [bob, 'Bob', 'bob-acc-d1@example.com'],
    [charlie, 'Charlie', 'charlie-acc-d1@example.com'],
    [dana, 'Dana', 'dana-acc-d1@example.com'],
    [eve, 'Eve', 'eve-acc-d1@example.com'],
  ]) {
    await client.call('/api/auth/register', {
      method: 'POST',
      body: { name, email, password: 'password123', competingSlugs: ['cluesbysam'] },
    });
  }

  const getCluesId = async (c) => (await c.call('/api/games')).json.games[0].id;
  const aliceCluesId = await getCluesId(alice);
  const aliceBoot = await alice.call('/api/bootstrap?live=1');
  const playDate = aliceBoot.json.cardSummaries[aliceCluesId].puzzleStatus.activePuzzleDate;

  // Alice: slower (03:00) but PERFECT grid (penalty 0) -> Rank 1
  const aEntry = await alice.call('/api/entries', {
    method: 'POST',
    body: {
      gameId: aliceCluesId,
      playDate,
      rawText: 'I solved the daily #CluesBySam, Nov 16th 2026 (Hard), in 03:00\n🟩🟩🟩🟩\n🟩🟩🟩🟩',
    },
  });
  assert.equal(aEntry.json.entry.metadata.isPerfect, true);
  assert.equal(aEntry.json.entry.metadata.accuracyPenalty, 0);

  // Bob: faster (01:30) with 1 mistake 🟨 (penalty 1) -> Rank 2
  const bEntry = await bob.call('/api/entries', {
    method: 'POST',
    body: {
      gameId: await getCluesId(bob),
      playDate,
      rawText: 'I solved the daily #CluesBySam, Nov 16th 2026 (Hard), in 01:30\n🟩🟩🟩🟨\n🟩🟩🟩🟩',
    },
  });
  assert.equal(bEntry.json.entry.metadata.yellowCount, 1);
  assert.equal(bEntry.json.entry.metadata.accuracyPenalty, 1);

  // Charlie: faster still (01:00) with 1 single hint 🟡 (weight 1, penalty 2) -> Rank 3
  const cEntry = await charlie.call('/api/entries', {
    method: 'POST',
    body: {
      gameId: await getCluesId(charlie),
      playDate,
      rawText: 'I solved the daily #CluesBySam, Nov 16th 2026 (Hard), in 01:00\n🟩🟩🟩🟡\n🟩🟩🟩🟩',
    },
  });
  assert.equal(cEntry.json.entry.metadata.singleHintCount, 1);
  assert.equal(cEntry.json.entry.metadata.totalHintWeight, 1);
  assert.equal(cEntry.json.entry.metadata.accuracyPenalty, 2);

  // Dana: fastest (00:45) with 1 double hint 🟠 (weight 2, penalty 3) -> Rank 4
  const dEntry = await dana.call('/api/entries', {
    method: 'POST',
    body: {
      gameId: await getCluesId(dana),
      playDate,
      rawText: 'I solved the daily #CluesBySam, Nov 16th 2026 (Hard), in 00:45\n🟩🟩🟩🟠\n🟩🟩🟩🟩',
    },
  });
  assert.equal(dEntry.json.entry.metadata.doubleHintCount, 1);
  assert.equal(dEntry.json.entry.metadata.totalHintWeight, 2);
  assert.equal(dEntry.json.entry.metadata.accuracyPenalty, 3);

  // Unplayed viewer (Eve) sees spoiler-redacted Clues grid & accuracy on active puzzle
  const eveLb = await eve.call(`/api/leaderboard?date=${playDate}&live=1&days=30&gameSlug=cluesbysam`);
  assert.equal(eveLb.status, 200);
  const eveAliceCell = eveLb.json.todayMatrix.rows.find((r) => r.displayName === 'Alice').cells
    .cluesbysam;
  assert.equal(eveAliceCell.spoilerProtected, true);
  assert.equal(eveAliceCell.emojiGrid, null);
  assert.equal(eveAliceCell.accuracySummary, null);

  // Alice checks leaderboard -> exact weighted accuracy order: Alice > Bob > Charlie > Dana
  const lb = await alice.call(`/api/leaderboard?date=${playDate}&live=1&days=30&gameSlug=cluesbysam`);
  assert.equal(lb.status, 200);
  const standings = lb.json.gameBoard.standings;
  assert.equal(standings[0].displayName, 'Alice');
  assert.equal(standings[0].today.rank, 1);
  assert.equal(standings[0].today.medal, 'gold');
  assert.equal(standings[0].today.accuracyPenalty, 0);
  assert.equal(standings[0].today.accuracySummary, '8/8 🟩');
  assert.equal(standings[1].displayName, 'Bob');
  assert.equal(standings[1].today.rank, 2);
  assert.equal(standings[1].today.medal, 'silver');
  assert.equal(standings[1].today.accuracyPenalty, 1);
  assert.equal(standings[2].displayName, 'Charlie');
  assert.equal(standings[2].today.rank, 3);
  assert.equal(standings[2].today.medal, 'bronze');
  assert.equal(standings[2].today.accuracyPenalty, 2);
  assert.equal(standings[3].displayName, 'Dana');
  assert.equal(standings[3].today.rank, 4);
  assert.equal(standings[3].today.medal, null);
  assert.equal(standings[3].today.accuracyPenalty, 3);

  // Export/Import preserves compete: false across replace mode
  const cluesId = await getCluesId(alice);
  await alice.call(`/api/games/${cluesId}`, { method: 'PUT', body: { compete: false } });
  const exported = await alice.call('/api/export');
  assert.equal(exported.status, 200);
  assert.equal(exported.json.games[0].compete, false);
  const imported = await alice.call('/api/import', {
    method: 'POST',
    body: { mode: 'replace', games: exported.json.games, entries: exported.json.entries },
  });
  assert.equal(imported.status, 200);
  const gamesAfterImport = (await alice.call('/api/games')).json.games;
  assert.equal(gamesAfterImport[0].compete, false);

  harness.sqliteDb.close();
});

test('Worker clues_accuracy_sizeitup_and_collections_v1 legacy D1 migration: adds compete, renames Size It Up safely, seeds optional catalog, and backfills Clues accuracy', async () => {
  const harness = createWorkerHarness({ applyMigration: true });
  const now = '2026-11-16T00:00:00.000Z';

  const catalogSql = fs.readFileSync(
    path.join(PROJECT_ROOT, 'migrations', '0002_game_catalog.sql'),
    'utf8',
  );
  harness.sqliteDb.exec(catalogSql);

  const { sha256Hex } = await import('../shared/auth-crypto.js');
  const rawToken = 'wave2a-mig-session-token';
  const tokenHash = await sha256Hex(rawToken);

  // Verify 0001_init legacy games table lacks `compete` before ensureSchema
  const colsBefore = harness.sqliteDb
    .prepare('PRAGMA table_info(games)')
    .all()
    .map((c) => c.name);
  assert.equal(colsBefore.includes('compete'), false);

  harness.sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_migrations (id, applied_at) VALUES
      ('wave2_starters_and_cluesbysam_v1', '2026-11-16T00:00:00.000Z'),
      ('cluesbysam_difficulty_backfill_v1', '2026-11-16T00:00:00.000Z'),
      ('perceptle_parser_and_backfill_v1', '2026-11-16T00:00:00.000Z'),
      ('fermi_magnitudle_grids_backfill_v1', '2026-11-16T00:00:00.000Z'),
      ('eraly_starter_v1', '2026-11-16T00:00:00.000Z');
    INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at)
    VALUES
      (1, 'p1-w2a@example.com', 'Player 1', 'h', 's', '2026-11-01T00:00:00Z'),
      (2, 'p2-w2a@example.com', 'Player 2', 'h', 's', '2026-11-01T00:00:00Z');
    INSERT INTO games (id, user_id, name, slug, url, category, metric_label, metric_format, metric_direction, parser_id, sort_order, archived, created_at)
    VALUES
      (1, 1, 'Clues by Sam', 'cluesbysam', 'https://cluesbysam.com', 'Logic', 'Solve Time', 'duration_sec', 'lower_is_better', 'cluesbysam', 1, 0, '2026-11-01T00:00:00Z'),
      (2, 1, 'Magnitudle', 'magnitudle', 'https://magnitudle.com', 'Trivia', 'Score', 'number', 'higher_is_better', 'magnitudle', 7, 0, '2026-11-01T00:00:00Z'),
      (3, 2, 'My Custom Mag', 'magnitudle', 'https://magnitudle.com', 'Trivia', 'Score', 'number', 'higher_is_better', 'magnitudle', 7, 0, '2026-11-01T00:00:00Z');
    INSERT INTO game_catalog (slug, name, url, category, parser_id, created_at, updated_at)
    VALUES ('magnitudle', 'Magnitudle', 'https://magnitudle.com', 'Trivia', 'magnitudle', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z');
    INSERT INTO entries (
      id, user_id, game_id, play_date, raw_text, parser_id, parser_version,
      completed, solved, primary_value, display_value, puzzle_id,
      breakdown_json, metadata_json, manual_override, created_at, updated_at
    ) VALUES
      (1, 1, 1, '2026-11-16', 'I solved the daily #CluesBySam, Nov 16th 2026 (Hard), in 02:15\n🟩🟩🟨🟡\n🟩🟩🟩🟠', 'cluesbysam', 2, 1, 1, 135, '2:15', '2026-11-16', '[]', '{"difficulty":"Hard","seconds":135}', 0, '2026-11-16T00:00:00Z', '2026-11-16T00:00:00Z'),
      (2, 1, 1, '2026-11-15', 'I solved the daily Clues by Sam, Nov 15th 2026 (Easy), in 01:40\n🟩🟩🟩🟩', 'cluesbysam', 2, 1, 1, 100, '1:40', '2026-11-15', '[]', '{"difficulty":"Brutal","difficultyOverride":true}', 0, '2026-11-15T00:00:00Z', '2026-11-15T00:00:00Z'),
      (3, 1, 1, '2026-11-14', 'I solved the daily Clues by Sam, Nov 14th 2026 (Easy), in 01:40\n🟩🟩🟨🟡', 'cluesbysam', 2, 1, 1, 99, '1:39', 'manual-id', '[]', '{}', 1, '2026-11-14T00:00:00Z', '2026-11-14T00:00:00Z');
  `);
  harness.sqliteDb
    .prepare(
      'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run('sess-w2a', 1, tokenHash, '2099-01-01T00:00:00.000Z', now);

  await ensureSchema(harness.d1);
  // Idempotent second pass + fresh createD1Database cold/warm fast-path
  await ensureSchema(harness.d1);
  let coldPrepares = 0;
  const freshBase = createD1Adapter(harness.sqliteDb);
  const coldWrapper = {
    prepare(sql) {
      coldPrepares += 1;
      return freshBase.prepare(sql);
    },
    batch: (stmts) => freshBase.batch(stmts),
    exec: (sql) => freshBase.exec(sql),
  };
  const dbCold = createD1Database(coldWrapper);
  await dbCold.listUsersPublic();
  assert.equal(coldPrepares, 2);
  coldPrepares = 0;
  const dbWarm = createD1Database(coldWrapper);
  await dbWarm.listUsersPublic();
  assert.equal(coldPrepares, 1);

  const client = harness.createSessionClient();
  const authHeader = { Cookie: `__Host-dg_session=${rawToken}` };
  const gamesRes = await client.call('/api/games', { headers: authHeader });
  assert.equal(gamesRes.status, 200);
  const magP1 = gamesRes.json.games.find((g) => g.slug === 'magnitudle');
  assert.equal(magP1.name, 'Size It Up');
  assert.equal(magP1.url, 'https://magnitudle.com/size-it-up');
  assert.equal(magP1.category, 'Estimation');
  assert.equal(magP1.compete, true);

  const magP2 = harness.sqliteDb.prepare('SELECT name FROM games WHERE id = 3').get();
  assert.equal(magP2.name, 'My Custom Mag');

  const catalogRes = await client.call('/api/catalog', { headers: authHeader });
  assert.equal(catalogRes.json.catalog.find((c) => c.slug === 'magnitudle')?.name, 'Size It Up');
  for (const opt of OPTIONAL_CATALOG_GAMES) {
    assert.ok(
      catalogRes.json.catalog.some((c) => c.slug === opt.slug),
      `Missing optional catalog game ${opt.slug}`,
    );
  }

  const entriesRes = await client.call('/api/entries?gameId=1', { headers: authHeader });
  const e1 = entriesRes.json.entries.find((e) => e.playDate === '2026-11-16');
  const e2 = entriesRes.json.entries.find((e) => e.playDate === '2026-11-15');
  const e3 = entriesRes.json.entries.find((e) => e.playDate === '2026-11-14');

  assert.equal(e1.metadata.yellowCount, 1);
  assert.equal(e1.metadata.singleHintCount, 1);
  assert.equal(e1.metadata.doubleHintCount, 1);
  assert.equal(e1.metadata.totalHintWeight, 3);
  assert.equal(e1.metadata.accuracyPenalty, 6);
  assert.equal(e1.metadata.isPerfect, false);

  assert.equal(e2.difficulty, 'Brutal');
  assert.equal(e2.metadata.difficultyOverride, true);
  assert.equal(e2.metadata.isPerfect, true);

  // manual_override = 1 keeps primary_value=99 & display_value='1:39' while adding accuracy metadata
  assert.equal(e3.primaryValue, 99);
  assert.equal(e3.displayValue, '1:39');
  assert.equal(e3.metadata.singleHintCount, 1);
  assert.equal(e3.metadata.accuracyPenalty, 3);

  assert.ok(
    harness.sqliteDb
      .prepare("SELECT 1 FROM schema_migrations WHERE id = 'clues_accuracy_sizeitup_and_collections_v1'")
      .get(),
  );

  harness.sqliteDb.close();
});
