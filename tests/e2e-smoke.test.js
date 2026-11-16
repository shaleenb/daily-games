import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';

function createCookieSession(baseUrl) {
  const cookies = new Map();

  function captureCookies(headers) {
    const setCookies =
      typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : headers.get('set-cookie')
          ? [headers.get('set-cookie')]
          : [];
    for (const raw of setCookies) {
      const first = raw.split(';')[0];
      const idx = first.indexOf('=');
      if (idx <= 0) continue;
      const name = first.slice(0, idx).trim();
      const val = first.slice(idx + 1).trim();
      if (!val || /Max-Age=0/i.test(raw)) {
        cookies.delete(name);
      } else {
        cookies.set(name, val);
      }
    }
  }

  function applyCookieHeader(headers) {
    if (cookies.size > 0 && !headers.Cookie && !headers.cookie) {
      headers.Cookie = Array.from(cookies.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
    }
  }

  async function fetchRaw(pathname, options = {}) {
    const headers = { ...(options.headers || {}) };
    applyCookieHeader(headers);
    const res = await fetch(`${baseUrl}${pathname}`, { ...options, headers });
    captureCookies(res.headers);
    const text = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      headers: res.headers,
      text,
    };
  }

  async function fetchJson(pathname, { method = 'GET', body, headers: extraHeaders = {} } = {}) {
    const headers = { ...extraHeaders };
    applyCookieHeader(headers);
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}${pathname}`, { method, headers, body: payload });
    captureCookies(res.headers);
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    return {
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      headers: res.headers,
      json,
      text,
    };
  }

  return { fetchRaw, fetchJson };
}

async function startE2EApp() {
  const { server, db, close } = createApp({ dbPath: ':memory:' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const defaultSession = createCookieSession(baseUrl);

  return {
    baseUrl,
    db,
    close,
    fetchRaw: defaultSession.fetchRaw,
    fetchJson: defaultSession.fetchJson,
    createSession: () => createCookieSession(baseUrl),
  };
}

test('E2E smoke: static assets, auth lifecycle, isolation, bootstrap, detect, entries, stats PBs, reparse, and export/import', async (t) => {
  const app = await startE2EApp();
  t.after(() => app.close());

  // 1. Static asset serving & Content-Type checks
  const staticChecks = [
    { path: '/', type: /text\/html/i, needle: 'Daily Games Hub' },
    { path: '/css/themes.css', type: /text\/css/i, needle: 'html[data-theme=' },
    { path: '/css/app.css', type: /text\/css/i, needle: '--accent' },
    { path: '/css/charts.css', type: /text\/css/i, needle: '.dg-chart-wrap' },
    { path: '/js/themes.js', type: /application\/javascript/i, needle: 'export const THEMES' },
    { path: '/js/api.js', type: /application\/javascript/i, needle: 'export const api' },
    { path: '/js/app.js', type: /application\/javascript/i, needle: 'detectGameAndParse' },
    { path: '/js/charts.js', type: /application\/javascript/i, needle: 'renderTrendChart' },
    { path: '/shared/auth-crypto.js', type: /application\/javascript/i, needle: 'STARTER_GAMES' },
    { path: '/shared/parsers/registry.js', type: /application\/javascript/i, needle: 'export function detectGameAndParse' },
    { path: '/shared/parsers/utils.js', type: /application\/javascript/i, needle: 'export function getLocalDateString' },
    { path: '/shared/parsers/generic.js', type: /application\/javascript/i, needle: 'GENERIC_PARSER' },
    { path: '/shared/parsers/games/wordle.js', type: /application\/javascript/i, needle: 'wordleParser' },
  ];

  for (const asset of staticChecks) {
    const res = await app.fetchRaw(asset.path);
    assert.equal(res.status, 200, `Expected 200 for ${asset.path}`);
    assert.match(res.contentType, asset.type, `Unexpected Content-Type for ${asset.path}: ${res.contentType}`);
    assert.ok(res.text.includes(asset.needle), `Missing expected content in ${asset.path}`);
  }

  // 2. Public Health, Auth Gate, Register & Login
  const health = await app.fetchJson('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.ok(typeof health.json.timestamp === 'string' && health.json.timestamp.length > 0);

  const meAnon = await app.fetchJson('/api/auth/me');
  assert.equal(meAnon.status, 200);
  assert.equal(meAnon.json.authenticated, false);

  const unauthBoot = await app.fetchJson('/api/bootstrap');
  assert.equal(unauthBoot.status, 401);

  const crossSite = await app.fetchJson('/api/auth/register', {
    method: 'POST',
    headers: { 'Sec-Fetch-Site': 'cross-site' },
    body: { name: 'Attacker', email: 'attacker@example.com', password: 'password123' },
  });
  assert.equal(crossSite.status, 403);

  const regAlice = await app.fetchJson('/api/auth/register', {
    method: 'POST',
    body: { name: 'Alice', email: 'alice@example.com', password: 'password123' },
  });
  assert.equal(regAlice.status, 201);
  assert.equal(regAlice.json.authenticated, true);
  assert.equal(regAlice.json.user.email, 'alice@example.com');

  const boot1 = await app.fetchJson('/api/bootstrap?date=2026-11-15');
  assert.equal(boot1.status, 200);
  assert.equal(boot1.json.date, '2026-11-15');
  assert.equal(boot1.json.user.email, 'alice@example.com');
  assert.deepEqual(
    boot1.json.games.map((g) => g.name),
    [
      'Clues by Sam',
      'Krillion',
      'Farflung',
      'Perceptle',
      'PricePoint',
      'Fermi',
      'Magnitudle',
      'Plain',
      'TimeGuessr',
    ],
  );
  assert.deepEqual(
    boot1.json.games.map((g) => g.slug),
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
  assert.equal(boot1.json.dailyOverview.activeGamesCount, 9);
  assert.equal(boot1.json.dailyOverview.playedTodayCount, 0);
  assert.equal(boot1.json.dailyOverview.routineStreak, 0);
  assert.equal(boot1.json.dailyOverview.fullSweepDays, 0);
  for (const g of boot1.json.games) {
    assert.ok(boot1.json.cardSummaries[g.id], `Missing cardSummary for ${g.name}`);
    assert.equal(boot1.json.cardSummaries[g.id].recentSparkline.length, 14);
    assert.ok(boot1.json.cardSummaries[g.id].puzzleStatus, `Missing puzzleStatus for ${g.name}`);
    assert.ok(boot1.json.cardSummaries[g.id].puzzleStatus.activePuzzleDate);
  }

  const bootLive = await app.fetchJson('/api/bootstrap?live=1&tz=America/New_York');
  assert.equal(bootLive.status, 200);
  assert.equal(bootLive.json.games.length, 9);

  const cluesGame = boot1.json.games.find((g) => g.name === 'Clues by Sam');
  const krillionGame = boot1.json.games.find((g) => g.name === 'Krillion');
  const farflungGame = boot1.json.games.find((g) => g.name === 'Farflung');
  const perceptleGame = boot1.json.games.find((g) => g.name === 'Perceptle');
  const pricepointGame = boot1.json.games.find((g) => g.name === 'PricePoint');
  const fermiGame = boot1.json.games.find((g) => g.name === 'Fermi');
  const magnitudleGame = boot1.json.games.find((g) => g.name === 'Magnitudle');
  const plainGame = boot1.json.games.find((g) => g.name === 'Plain');
  const timeguessrGame = boot1.json.games.find((g) => g.name === 'TimeGuessr');

  // 3. Create Wordle game
  const createWordle = await app.fetchJson('/api/games', {
    method: 'POST',
    body: {
      name: 'Wordle',
      url: 'https://www.nytimes.com/games/wordle',
      icon: '🟩',
      color: '#22c55e',
      category: 'Word',
      metricLabel: 'Guesses',
      metricFormat: 'fraction',
      metricDirection: 'lower_is_better',
      parserId: 'auto',
    },
  });
  assert.equal(createWordle.status, 201);
  const wordleGame = createWordle.json.game;
  assert.equal(wordleGame.slug, 'wordle');
  assert.equal(wordleGame.resolvedParser.id, 'wordle');
  assert.equal(wordleGame.resolvedParser.isCustomParser, true);

  // 4. POST /api/detect for Wordle & seeded generic games
  const wordleShareText = [
    'Wordle 1,234 4/6',
    '',
    '⬛🟨⬛⬛🟩',
    '🟨⬛⬛🟨🟩',
    '🟩🟩⬛🟩🟩',
    '🟩🟩🟩🟩🟩',
  ].join('\n');

  const detectWordle = await app.fetchJson('/api/detect', {
    method: 'POST',
    body: { rawText: wordleShareText },
  });
  assert.equal(detectWordle.status, 200);
  assert.equal(detectWordle.json.matchedGame?.id, wordleGame.id);
  assert.equal(detectWordle.json.confidence, 'high');
  assert.equal(detectWordle.json.parserId, 'wordle');
  assert.equal(detectWordle.json.parsed.primaryValue, 4);
  assert.equal(detectWordle.json.parsed.displayValue, '4/6');
  assert.equal(detectWordle.json.parsed.puzzleId, '#1234');
  assert.equal(detectWordle.json.parsed.solved, true);
  assert.equal(detectWordle.json.parsed.breakdown.length, 4);
  assert.ok(detectWordle.json.parsed.metadata.emojiGrid.includes('🟩🟩🟩🟩🟩'));

  const detectClues = await app.fetchJson('/api/detect', {
    method: 'POST',
    body: { rawText: 'Clues by Sam #142 (Easy)\nSolved in 2:14\n🟩🟩🟩🟩' },
  });
  assert.equal(detectClues.status, 200);
  assert.equal(detectClues.json.matchedGame?.id, cluesGame.id);
  assert.equal(detectClues.json.parserId, 'cluesbysam');
  assert.equal(detectClues.json.parsed.primaryValue, 134);
  assert.equal(detectClues.json.parsed.displayValue, '2:14');
  assert.equal(detectClues.json.parsed.puzzleId, '#142');
  assert.equal(detectClues.json.parsed.metadata.difficulty, 'Easy');
  assert.equal(detectClues.json.difficulty, 'Easy');
  assert.equal(detectClues.json.supportsDifficulty, true);

  const previewPlain = await app.fetchJson('/api/entries/parse-preview', {
    method: 'POST',
    body: {
      gameId: plainGame.id,
      rawText: 'Plain #45 ✈️\nAltitude: 4,215 m',
    },
  });
  assert.equal(previewPlain.status, 200);
  assert.equal(previewPlain.json.parserId, 'plain');
  assert.equal(previewPlain.json.parsed.primaryValue, 4215);
  assert.equal(previewPlain.json.supportsDifficulty, false);

  const detectFermi = await app.fetchJson('/api/detect', {
    method: 'POST',
    body: { rawText: 'Fermi #42 - 1.62×' },
  });
  assert.equal(detectFermi.status, 200);
  assert.equal(detectFermi.json.matchedGame?.id, fermiGame.id);
  assert.equal(detectFermi.json.parserId, 'fermi');
  assert.equal(detectFermi.json.parsed.primaryValue, 1.62);
  assert.equal(detectFermi.json.parsed.puzzleId, '#42');

  // 5. Log entries for all 10 games (plus prior-day scores to verify PB & difficulty filtering)
  const entriesToSave = [
    {
      gameId: cluesGame.id,
      playDate: '2026-11-14',
      rawText: 'Clues by Sam #141 (Hard)\nSolved in 3:05\n🟩🟩🟨🟩',
      expectedValue: 185,
      expectedDisplay: '3:05',
    },
    {
      gameId: krillionGame.id,
      playDate: '2026-11-14',
      rawText: 'Krillion #18\nScore: 620',
      expectedValue: 620,
      expectedDisplay: '620',
    },
    {
      gameId: wordleGame.id,
      playDate: '2026-11-14',
      rawText: 'Wordle 1,233 5/6\n\n⬛⬛⬛⬛⬛\n🟩🟩🟩🟩🟩',
      expectedValue: 5,
      expectedDisplay: '5/6',
    },
    {
      gameId: cluesGame.id,
      playDate: '2026-11-15',
      rawText: 'Clues by Sam #142 (Easy)\nSolved in 2:14\n🟩🟩🟩🟩',
      expectedValue: 134,
      expectedDisplay: '2:14',
    },
    {
      gameId: krillionGame.id,
      playDate: '2026-11-15',
      rawText: 'Krillion #19\nScore: 840',
      expectedValue: 840,
      expectedDisplay: '840',
    },
    {
      gameId: farflungGame.id,
      playDate: '2026-11-15',
      rawText: 'Farflung #88\nScore: 1250',
      expectedValue: 1250,
      expectedDisplay: '1250',
    },
    {
      gameId: perceptleGame.id,
      playDate: '2026-11-14',
      rawText: 'Perceptle #121 - B+ (82)\n🔢 80  🎯 85  📐 90  🥁 70  ✂️ 85',
      expectedValue: 82,
      expectedDisplay: '82 (B+)',
    },
    {
      gameId: perceptleGame.id,
      playDate: '2026-11-15',
      rawText: 'Perceptle #122 - C (69)\n🔢 57  🎯 93  📐 100  🥁 3  ✂️ 93\nhttps://perceptle.com',
      expectedValue: 69,
      expectedDisplay: '69 (C)',
    },
    {
      gameId: pricepointGame.id,
      playDate: '2026-11-15',
      rawText: 'PricePoint #12\nScore: 4100',
      expectedValue: 4100,
      expectedDisplay: '4100',
    },
    {
      gameId: fermiGame.id,
      playDate: '2026-11-15',
      rawText: 'Fermi #42 - 1.62×',
      expectedValue: 1.62,
      expectedDisplay: '1.62×',
    },
    {
      gameId: magnitudleGame.id,
      playDate: '2026-11-15',
      rawText: 'Magnitudle #77\nScore: 950',
      expectedValue: 950,
      expectedDisplay: '950',
    },
    {
      gameId: plainGame.id,
      playDate: '2026-11-15',
      rawText: 'Plain #45 ✈️\nAltitude: 4,215 m',
      expectedValue: 4215,
      expectedDisplay: '4,215 m',
    },
    {
      gameId: timeguessrGame.id,
      playDate: '2026-11-15',
      rawText: 'TimeGuessr #212 43,850/50,000\nRound 1: 9,200/10,000\nRound 2: 8,650/10,000',
      expectedValue: 43850,
      expectedDisplay: '43,850 / 50,000',
    },
    {
      gameId: wordleGame.id,
      playDate: '2026-11-15',
      rawText: wordleShareText,
      expectedValue: 4,
      expectedDisplay: '4/6',
    },
  ];

  for (const item of entriesToSave) {
    const res = await app.fetchJson('/api/entries', {
      method: 'POST',
      body: {
        gameId: item.gameId,
        playDate: item.playDate,
        rawText: item.rawText,
      },
    });
    assert.equal(res.status, 201, `Failed saving entry for game ${item.gameId} on ${item.playDate}`);
    assert.equal(res.json.entry.primaryValue, item.expectedValue);
    assert.equal(res.json.entry.displayValue, item.expectedDisplay);
  }

  const boot2 = await app.fetchJson('/api/bootstrap?date=2026-11-15');
  assert.equal(boot2.status, 200);
  assert.equal(boot2.json.entriesForDate.length, 10);
  assert.equal(boot2.json.dailyOverview.activeGamesCount, 10);
  assert.equal(boot2.json.dailyOverview.playedTodayCount, 10);
  assert.equal(boot2.json.dailyOverview.routineStreak, 2);
  assert.equal(boot2.json.dailyOverview.fullSweepDays, 1);

  // 6. Verify GET /api/stats?gameId=... for lower_is_better, higher_is_better PBs, Plain, TimeGuessr & Clues difficulty filtering
  const cluesStats = await app.fetchJson(`/api/stats?gameId=${cluesGame.id}&date=2026-11-15`);
  assert.equal(cluesStats.status, 200);
  assert.equal(cluesStats.json.heatmap.length, 91);
  assert.equal(cluesStats.json.leaderboard.length, 10);
  assert.equal(cluesStats.json.gameStats.kpis.totalPlayed, 2);
  assert.equal(cluesStats.json.gameStats.kpis.currentStreak, 2);
  assert.equal(cluesStats.json.gameStats.supportsDifficulty, true);
  assert.equal(cluesStats.json.gameStats.difficultySummary.length, 2);
  assert.equal(cluesStats.json.gameStats.kpis.personalBest.value, 134);
  assert.equal(cluesStats.json.gameStats.kpis.personalBest.displayValue, '2:14');
  assert.equal(cluesStats.json.gameStats.kpis.personalBest.playDate, '2026-11-15');

  const cluesStatsHard = await app.fetchJson(`/api/stats?gameId=${cluesGame.id}&date=2026-11-15&difficulty=Hard`);
  assert.equal(cluesStatsHard.status, 200);
  assert.equal(cluesStatsHard.json.gameStats.filters.difficulty, 'Hard');
  assert.equal(cluesStatsHard.json.gameStats.kpis.totalPlayed, 1);
  assert.equal(cluesStatsHard.json.gameStats.kpis.currentStreak, 2);
  assert.equal(cluesStatsHard.json.gameStats.kpis.personalBest.value, 185);
  assert.equal(
    cluesStats.json.gameStats.trendSeries.find((p) => p.playDate === '2026-11-15')?.isPersonalBest,
    true,
  );
  assert.equal(
    cluesStats.json.gameStats.trendSeries.find((p) => p.playDate === '2026-11-14')?.isPersonalBest,
    false,
  );

  const plainStats = await app.fetchJson(`/api/stats?gameId=${plainGame.id}&date=2026-11-15`);
  assert.equal(plainStats.status, 200);
  assert.equal(plainStats.json.gameStats.kpis.personalBest.value, 4215);
  assert.equal(plainStats.json.gameStats.kpis.personalBest.displayValue, '4,215 m');

  const tgStats = await app.fetchJson(`/api/stats?gameId=${timeguessrGame.id}&date=2026-11-15`);
  assert.equal(tgStats.status, 200);
  assert.equal(tgStats.json.gameStats.kpis.personalBest.value, 43850);
  assert.equal(tgStats.json.gameStats.breakdownSummary.length, 2);

  const krillionStats = await app.fetchJson(`/api/stats?gameId=${krillionGame.id}&date=2026-11-15`);
  assert.equal(krillionStats.status, 200);
  assert.equal(krillionStats.json.gameStats.kpis.personalBest.value, 840);
  assert.equal(krillionStats.json.gameStats.kpis.personalBest.displayValue, '840');
  assert.equal(krillionStats.json.gameStats.kpis.personalBest.playDate, '2026-11-15');

  const farflungStats = await app.fetchJson(`/api/stats?gameId=${farflungGame.id}&date=2026-11-15`);
  assert.equal(farflungStats.status, 200);
  assert.equal(farflungStats.json.gameStats.kpis.personalBest.value, 1250);
  assert.equal(farflungStats.json.gameStats.kpis.personalBest.displayValue, '1250');

  const perceptleStats = await app.fetchJson(`/api/stats?gameId=${perceptleGame.id}&date=2026-11-15`);
  assert.equal(perceptleStats.status, 200);
  assert.equal(perceptleStats.json.gameStats.kpis.personalBest.value, 82);
  assert.equal(perceptleStats.json.gameStats.kpis.personalBest.displayValue, '82 (B+)');
  assert.equal(perceptleStats.json.gameStats.breakdownSummary.length, 5);
  assert.equal(perceptleStats.json.gameStats.breakdownSummary[0].label, '🔢 Count');
  assert.equal(perceptleStats.json.gameStats.breakdownSummary[0].bestValue, 80);
  assert.equal(perceptleStats.json.gameStats.breakdownSummary[2].bestValue, 100);

  const wordleStats = await app.fetchJson(`/api/stats?gameId=${wordleGame.id}&date=2026-11-15`);
  assert.equal(wordleStats.status, 200);
  assert.equal(wordleStats.json.gameStats.kpis.totalPlayed, 2);
  assert.equal(wordleStats.json.gameStats.kpis.solvedCount, 2);
  assert.equal(wordleStats.json.gameStats.kpis.winRate, 100);
  assert.equal(wordleStats.json.gameStats.kpis.personalBest.value, 4);
  assert.equal(wordleStats.json.gameStats.kpis.personalBest.displayValue, '4/6');
  assert.equal(wordleStats.json.gameStats.kpis.personalBest.playDate, '2026-11-15');
  assert.ok(wordleStats.json.gameStats.breakdownSummary.length >= 2);

  // 7. POST /api/games/:id/reparse
  const reparseWordle = await app.fetchJson(`/api/games/${wordleGame.id}/reparse`, {
    method: 'POST',
    body: { force: true },
  });
  assert.equal(reparseWordle.status, 200);
  assert.equal(reparseWordle.json.updatedCount, 2);
  assert.equal(reparseWordle.json.parser.id, 'wordle');

  const reparseClues = await app.fetchJson(`/api/games/${cluesGame.id}/reparse`, {
    method: 'POST',
    body: { force: true },
  });
  assert.equal(reparseClues.status, 200);
  assert.equal(reparseClues.json.updatedCount, 2);
  assert.equal(reparseClues.json.parser.id, 'cluesbysam');

  // 8. Export & Import into a clean second user account on another instance + same instance isolation
  const exported = await app.fetchJson('/api/export');
  assert.equal(exported.status, 200);
  assert.equal(exported.json.version, 1);
  assert.equal(exported.json.games.length, 10);
  assert.equal(exported.json.entries.length, 14);

  // Logout & verify cookie cleared, then log back in
  const logout = await app.fetchJson('/api/auth/logout', { method: 'POST' });
  assert.equal(logout.status, 200);
  assert.equal(logout.headers.get('clear-site-data'), '"cookies"');
  assert.equal((await app.fetchJson('/api/bootstrap')).status, 401);

  const login = await app.fetchJson('/api/auth/login', {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'password123' },
  });
  assert.equal(login.status, 200);

  // Second user on app2 registers & imports Alice's backup cleanly
  const app2 = await startE2EApp();
  t.after(() => app2.close());

  const regApp2 = await app2.fetchJson('/api/auth/register', {
    method: 'POST',
    body: { name: 'Bob', email: 'bob@example.com', password: 'password123' },
  });
  assert.equal(regApp2.status, 201);

  const imported = await app2.fetchJson('/api/import', {
    method: 'POST',
    body: {
      games: exported.json.games,
      entries: exported.json.entries,
      mode: 'replace',
    },
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.json.ok, true);
  assert.equal(imported.json.gamesCount, 10);
  assert.equal(imported.json.entriesCount, 14);

  const restoredBoot = await app2.fetchJson('/api/bootstrap?date=2026-11-15');
  assert.equal(restoredBoot.status, 200);
  assert.equal(restoredBoot.json.games.length, 10);
  assert.equal(restoredBoot.json.entriesForDate.length, 10);
  assert.equal(restoredBoot.json.dailyOverview.fullSweepDays, 1);

  const restoredWordleStats = await app2.fetchJson(`/api/stats?gameId=${wordleGame.id}&date=2026-11-15`);
  assert.equal(restoredWordleStats.status, 200);
  assert.equal(restoredWordleStats.json.gameStats.kpis.personalBest.value, 4);
  assert.equal(restoredWordleStats.json.gameStats.kpis.personalBest.displayValue, '4/6');
});
