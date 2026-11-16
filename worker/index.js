/**
 * Cloudflare Worker entrypoint for Daily Games Hub.
 * Pure Web Standards + D1 + Workers Static Assets — ZERO Node built-ins,
 * ZERO module-level mutable request state.
 */
import {
  SECURITY_HEADERS,
  isValidEmail,
  normalizeEmail,
  validateDisplayName,
  validatePassword,
  hashPassword,
  verifyPassword,
  dummyVerifyPassword,
  sha256Hex,
  generateSessionToken,
  isHttpsRequest,
  buildSessionCookie,
  buildClearSessionCookies,
  parseSessionCookie,
  isDisallowedCrossSiteRequest,
} from '../shared/auth-crypto.js';
import {
  PARSERS,
  GENERIC_PARSER,
  detectGameAndParse,
  parseForGame,
  normalizeDifficultyLabel,
  getLocalDateString,
  isValidResetTimezone,
  getGamePuzzleStatus,
} from '../shared/parsers/registry.js';
import {
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  isValidYmd,
  serializeResolvedParser,
  createD1Database,
} from './db-d1.js';
import {
  computeCardSummaries,
  computeDailyOverview,
  computeHeatmap,
  computeLeaderboard,
  computeGameStats,
  computePlayersLeaderboard,
} from '../server/stats.js';

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const API_VARY_HEADER = 'Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site';

function buildHeaders(baseHeaders, extraHeaders = {}) {
  const headers = new Headers(baseHeaders);
  for (const [key, value] of Object.entries(extraHeaders || {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, String(item));
      }
    } else {
      headers.set(key, String(value));
    }
  }
  return headers;
}

function jsonResponse(status, payload, extraHeaders = {}) {
  const headers = buildHeaders(
    {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    extraHeaders,
  );
  return new Response(JSON.stringify(payload), { status, headers });
}

function serializeParserOption(parser) {
  const base = serializeResolvedParser(parser);
  return {
    ...base,
    supportedSlugs: Array.isArray(parser?.supportedSlugs) ? [...parser.supportedSlugs] : [],
    supportedDomains: Array.isArray(parser?.supportedDomains) ? [...parser.supportedDomains] : [],
  };
}

function parseDaysParam(rawDays) {
  if (rawDays === null || rawDays === undefined || rawDays === '' || rawDays === 'all') {
    return null;
  }
  const num = Number(rawDays);
  if (!Number.isInteger(num) || num <= 0) {
    throw new ValidationError('Invalid days query parameter');
  }
  return num;
}

async function readJsonBody(request) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    const err = new Error('Request body too large');
    err.statusCode = 413;
    throw err;
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    const err = new Error('Request body too large');
    err.statusCode = 413;
    throw err;
  }

  const trimmed = raw.trim();
  if (!trimmed) return {};

  try {
    return JSON.parse(trimmed);
  } catch {
    throw new ValidationError('Invalid JSON request body');
  }
}

async function resolveSession(request, db) {
  const rawToken = parseSessionCookie(request.headers.get('cookie') || '');
  if (!rawToken) return null;
  const tokenHash = await sha256Hex(rawToken);
  return db.getSessionByTokenHash(tokenHash);
}

async function requireSession(request, db) {
  const session = await resolveSession(request, db);
  if (!session) {
    throw new UnauthorizedError('Authentication required');
  }
  return session;
}

function hasDifficultySupport(game, parsedOrDetection, difficulty) {
  return Boolean(
    game?.slug === 'cluesbysam' ||
      game?.parserId === 'cluesbysam' ||
      game?.resolvedParser?.id === 'cluesbysam' ||
      parsedOrDetection?.parserId === 'cluesbysam' ||
      difficulty,
  );
}

async function detectWithDifficulty(db, userId, rawText) {
  const activeGames = await db.listGames({ userId, includeArchived: false });
  const detection = detectGameAndParse(rawText, activeGames);
  const difficulty = normalizeDifficultyLabel(detection?.parsed?.metadata?.difficulty) || null;
  return {
    ...detection,
    difficulty,
    supportsDifficulty: hasDifficultySupport(detection?.matchedGame, detection, difficulty),
  };
}

async function handleApiRequest(request, env, url, pathname) {
  const method = request.method || 'GET';

  if (isDisallowedCrossSiteRequest(method, request.headers.get('sec-fetch-site'))) {
    return jsonResponse(
      403,
      { error: 'Cross-site request blocked' },
      { Vary: API_VARY_HEADER },
    );
  }

  if (method === 'GET' && pathname === '/api/health') {
    return jsonResponse(200, { ok: true, timestamp: new Date().toISOString() });
  }

  const db = createD1Database(env?.DB);

  if (method === 'GET' && pathname === '/api/auth/me') {
    const session = await resolveSession(request, db);
    if (session) {
      return jsonResponse(200, {
        authenticated: true,
        user: session.user,
      });
    }
    const status = await db.getAuthBootstrapStatus();
    const signupCatalog = await db.listPublicSignupCatalog();
    return jsonResponse(200, {
      authenticated: false,
      user: null,
      hasUsers: status.hasUsers,
      unclaimed: {
        gamesCount: status.unclaimedGamesCount,
        entriesCount: status.unclaimedEntriesCount,
      },
      signupCatalog,
    });
  }

  if (method === 'POST' && pathname === '/api/auth/register') {
    const body = await readJsonBody(request);
    const nameCheck = validateDisplayName(body?.name);
    if (!nameCheck.valid) {
      throw new ValidationError(nameCheck.error);
    }
    if (!isValidEmail(body?.email)) {
      throw new ValidationError('Please enter a valid email address');
    }
    const passwordCheck = validatePassword(body?.password);
    if (!passwordCheck.valid) {
      throw new ValidationError(passwordCheck.error);
    }
    if (body?.competingSlugs !== undefined) {
      if (
        !Array.isArray(body.competingSlugs) ||
        body.competingSlugs.some((s) => typeof s !== 'string')
      ) {
        throw new ValidationError('competingSlugs must be an array of strings');
      }
      if (body.competingSlugs.length === 0) {
        throw new ValidationError('Please select at least one valid game to compete in');
      }
    }

    const email = normalizeEmail(body.email);
    if (await db.getUserByEmail(email)) {
      throw new ConflictError('An account with this email already exists');
    }

    const { hashHex, saltHex } = await hashPassword(body.password);
    const user = await db.registerUser({
      name: nameCheck.value,
      email,
      passwordHash: hashHex,
      passwordSalt: saltHex,
      competingSlugs: body?.competingSlugs,
    });

    const { rawToken, tokenHash, sessionId, expiresAt } = await generateSessionToken();
    await db.createSession({
      id: sessionId,
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    return jsonResponse(
      201,
      { authenticated: true, user },
      { 'Set-Cookie': buildSessionCookie(rawToken, isHttpsRequest(request)) },
    );
  }

  if (method === 'POST' && pathname === '/api/auth/login') {
    const body = await readJsonBody(request);
    const email = normalizeEmail(body?.email);
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email || !password) {
      throw new ValidationError('Email and password are required');
    }

    const userRow = await db.getUserByEmail(email);
    if (!userRow) {
      await dummyVerifyPassword(password);
      throw new UnauthorizedError('Invalid email or password');
    }

    const valid = await verifyPassword(password, userRow.passwordSalt, userRow.passwordHash);
    if (!valid) {
      throw new UnauthorizedError('Invalid email or password');
    }

    const { rawToken, tokenHash, sessionId, expiresAt } = await generateSessionToken();
    await db.createSession({
      id: sessionId,
      userId: userRow.id,
      tokenHash,
      expiresAt,
    });

    const user = {
      id: userRow.id,
      email: userRow.email,
      displayName: userRow.displayName,
      createdAt: userRow.createdAt,
    };

    return jsonResponse(
      200,
      { authenticated: true, user },
      { 'Set-Cookie': buildSessionCookie(rawToken, isHttpsRequest(request)) },
    );
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    const rawToken = parseSessionCookie(request.headers.get('cookie') || '');
    if (rawToken) {
      const tokenHash = await sha256Hex(rawToken);
      await db.deleteSessionByTokenHash(tokenHash);
    }
    return jsonResponse(
      200,
      { ok: true },
      {
        'Set-Cookie': buildClearSessionCookies(isHttpsRequest(request)),
        'Clear-Site-Data': '"cookies"',
      },
    );
  }

  const session = await requireSession(request, db);
  const userId = session.user.id;

  if (method === 'GET' && pathname === '/api/bootstrap') {
    const dateParam = url.searchParams.get('date');
    const liveParam = url.searchParams.get('live');
    const tzParam = url.searchParams.get('tz');
    const live = liveParam === '1' || liveParam === 'true';

    if (tzParam !== null && tzParam !== '' && !isValidResetTimezone(tzParam)) {
      throw new ValidationError(`Invalid tz: ${tzParam}`);
    }
    const viewerTimeZone =
      tzParam && tzParam.trim() && tzParam.trim() !== 'local' ? tzParam.trim() : undefined;
    const now = new Date();

    const date = dateParam
      ? dateParam
      : viewerTimeZone
        ? getGamePuzzleStatus({ resetTimezone: 'local', resetTime: '00:00' }, now, viewerTimeZone)
            .localTodayDate
        : getLocalDateString(now);

    if (!isValidYmd(date)) {
      throw new ValidationError('Invalid date (expected YYYY-MM-DD)');
    }

    const { games, allEntries, catalog } = await db.getBootstrapDataset(userId);

    const cardSummaries = computeCardSummaries(games, allEntries, date, {
      live,
      now,
      viewerTimeZone,
    });
    const dailyOverview = computeDailyOverview(games, allEntries, date, {
      live,
      now,
      viewerTimeZone,
    });

    let entriesForDate;
    if (live) {
      const entryByGameAndDate = new Map();
      for (const e of allEntries) {
        entryByGameAndDate.set(`${e.gameId}:${e.playDate}`, e);
      }
      entriesForDate = [];
      for (const game of games) {
        const activeDate = cardSummaries[game.id]?.puzzleStatus?.activePuzzleDate || date;
        const match = entryByGameAndDate.get(`${game.id}:${activeDate}`);
        if (match) {
          entriesForDate.push(match);
        }
      }
    } else {
      entriesForDate = allEntries.filter((e) => e.playDate === date);
    }

    const parsers = [GENERIC_PARSER, ...PARSERS].map(serializeParserOption);

    return jsonResponse(200, {
      date,
      user: session.user,
      games,
      entries: allEntries,
      entriesForDate,
      cardSummaries,
      dailyOverview,
      parsers,
      catalog,
    });
  }

  if (method === 'GET' && pathname === '/api/catalog') {
    const catalog = await db.listCatalogGames({ userId });
    return jsonResponse(200, { catalog });
  }

  if (method === 'POST' && pathname === '/api/catalog/subscribe') {
    const body = await readJsonBody(request);
    if (body?.compete !== undefined && typeof body.compete !== 'boolean') {
      throw new ValidationError('compete must be a boolean');
    }
    const result = await db.subscribeCatalogGame(body?.slug, userId, {
      compete: body?.compete ?? true,
    });
    return jsonResponse(result.status === 'subscribed' ? 201 : 200, result);
  }

  if (method === 'GET' && pathname === '/api/games') {
    const includeArchivedParam = url.searchParams.get('includeArchived');
    const includeArchived = includeArchivedParam !== 'false';
    const games = await db.listGames({ userId, includeArchived });
    return jsonResponse(200, { games });
  }

  if (method === 'POST' && pathname === '/api/games') {
    const body = await readJsonBody(request);
    const game = await db.createGame(body, userId);
    return jsonResponse(201, { game });
  }

  if (method === 'PUT' && pathname === '/api/games/reorder') {
    const body = await readJsonBody(request);
    const games = await db.reorderGames(body.orderedIds, userId);
    return jsonResponse(200, { games });
  }

  const reparseMatch = /^\/api\/games\/([^/]+)\/reparse$/.exec(pathname);
  if (method === 'POST' && reparseMatch) {
    const body = await readJsonBody(request);
    const result = await db.reparseGameEntries(
      reparseMatch[1],
      { force: Boolean(body?.force) },
      userId,
    );
    return jsonResponse(200, result);
  }

  const gameIdMatch = /^\/api\/games\/([^/]+)$/.exec(pathname);
  if (gameIdMatch) {
    const id = gameIdMatch[1];
    if (method === 'PUT') {
      const body = await readJsonBody(request);
      const game = await db.updateGame(id, body, userId);
      return jsonResponse(200, { game });
    }
    if (method === 'DELETE') {
      await db.deleteGame(id, userId);
      return jsonResponse(200, { ok: true });
    }
  }

  if (method === 'POST' && pathname === '/api/detect') {
    const body = await readJsonBody(request);
    if (typeof body?.rawText !== 'string') {
      throw new ValidationError('rawText must be a string');
    }
    return jsonResponse(200, await detectWithDifficulty(db, userId, body.rawText));
  }

  if (method === 'POST' && pathname === '/api/entries/parse-preview') {
    const body = await readJsonBody(request);
    if (typeof body?.rawText !== 'string') {
      throw new ValidationError('rawText must be a string');
    }
    if (body.gameId !== undefined && body.gameId !== null && body.gameId !== '') {
      const game = await db.getGameById(body.gameId, userId);
      if (!game) {
        throw new NotFoundError('Game not found');
      }
      const parsed = parseForGame(body.rawText, game);
      const difficulty = normalizeDifficultyLabel(parsed?.metadata?.difficulty) || null;
      return jsonResponse(200, {
        matchedGame: game,
        gameId: game.id,
        parserId: parsed.parserId,
        parsed,
        difficulty,
        supportsDifficulty: hasDifficultySupport(game, parsed, difficulty),
      });
    }
    return jsonResponse(200, await detectWithDifficulty(db, userId, body.rawText));
  }

  if (method === 'GET' && pathname === '/api/entries') {
    const entries = await db.listEntries({
      userId,
      gameId: url.searchParams.get('gameId'),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      date: url.searchParams.get('date'),
      limit: url.searchParams.get('limit'),
    });
    return jsonResponse(200, { entries });
  }

  if (method === 'POST' && pathname === '/api/entries') {
    const body = await readJsonBody(request);
    const entry = await db.upsertEntry(body, userId);
    return jsonResponse(201, { entry });
  }

  const entryIdMatch = /^\/api\/entries\/([^/]+)$/.exec(pathname);
  if (entryIdMatch) {
    const id = entryIdMatch[1];
    if (method === 'PUT') {
      const body = await readJsonBody(request);
      const entry = await db.updateEntry(id, body, userId);
      return jsonResponse(200, { entry });
    }
    if (method === 'DELETE') {
      await db.deleteEntry(id, userId);
      return jsonResponse(200, { ok: true });
    }
  }

  if (method === 'GET' && pathname === '/api/stats') {
    const dateParam = url.searchParams.get('date');
    const referenceDate = dateParam ? dateParam : getLocalDateString();
    if (!isValidYmd(referenceDate)) {
      throw new ValidationError('Invalid date (expected YYYY-MM-DD)');
    }

    const days = parseDaysParam(url.searchParams.get('days'));
    const gameIdParam = url.searchParams.get('gameId');
    const difficultyParam = url.searchParams.get('difficulty');
    const [games, allEntries] = await Promise.all([
      db.listGames({ userId, includeArchived: true }),
      db.listEntries({ userId }),
    ]);

    let selectedGame = null;
    if (gameIdParam !== null && gameIdParam !== '') {
      selectedGame = await db.getGameById(gameIdParam, userId);
      if (!selectedGame) {
        throw new NotFoundError('Game not found');
      }
    } else {
      selectedGame = games.find((g) => !g.archived) || games[0] || null;
    }

    const heatmap = computeHeatmap(games, allEntries, referenceDate, 91);
    const leaderboard = computeLeaderboard(games, allEntries, referenceDate);
    const gameEntries = selectedGame
      ? allEntries.filter((e) => e.gameId === selectedGame.id)
      : [];
    const gameStats = selectedGame
      ? computeGameStats(selectedGame, gameEntries, {
          days,
          referenceDate,
          difficulty: difficultyParam,
        })
      : null;

    return jsonResponse(200, {
      heatmap,
      leaderboard,
      gameStats,
    });
  }

  if (method === 'GET' && pathname === '/api/leaderboard') {
    const dateParam = url.searchParams.get('date');
    const liveParam = url.searchParams.get('live');
    const tzParam = url.searchParams.get('tz');
    const daysParam = url.searchParams.get('days');
    const gameSlugParam = url.searchParams.get('gameSlug');
    const gameIdParam = url.searchParams.get('gameId');
    const difficultyParam = url.searchParams.get('difficulty');

    const live = liveParam === '1' || liveParam === 'true';
    if (tzParam !== null && tzParam !== '' && !isValidResetTimezone(tzParam)) {
      throw new ValidationError(`Invalid tz: ${tzParam}`);
    }
    const viewerTimeZone =
      tzParam && tzParam.trim() && tzParam.trim() !== 'local' ? tzParam.trim() : undefined;
    const now = new Date();

    const referenceDate = dateParam
      ? dateParam
      : viewerTimeZone
        ? getGamePuzzleStatus({ resetTimezone: 'local', resetTime: '00:00' }, now, viewerTimeZone)
            .localTodayDate
        : getLocalDateString(now);

    if (!isValidYmd(referenceDate)) {
      throw new ValidationError('Invalid date (expected YYYY-MM-DD)');
    }

    let days = 30;
    if (daysParam !== null && daysParam !== '') {
      days = daysParam === 'all' ? null : parseDaysParam(daysParam);
    }

    const { users, allGames, allEntries } = await db.getLeaderboardDataset();

    let gameSlug = gameSlugParam && gameSlugParam.trim() ? gameSlugParam.trim() : null;
    if (!gameSlug && gameIdParam !== null && gameIdParam !== '') {
      const matchedGame = allGames.find((g) => String(g.id) === String(gameIdParam.trim()));
      if (matchedGame) {
        gameSlug = matchedGame.slug;
      }
    }

    const payload = computePlayersLeaderboard({
      users,
      allGames,
      allEntries,
      viewerUserId: userId,
      referenceDate,
      days,
      gameSlug,
      difficulty: difficultyParam,
      live,
      now,
      viewerTimeZone,
    });

    return jsonResponse(200, payload);
  }

  if (method === 'GET' && pathname === '/api/export') {
    const data = await db.exportData(userId);
    return jsonResponse(200, data);
  }

  if (method === 'POST' && pathname === '/api/import') {
    const body = await readJsonBody(request);
    const result = await db.importData(body, userId);
    return jsonResponse(200, result);
  }

  return jsonResponse(404, { error: 'Not found' });
}

export default {
  async fetch(request, env, _ctx) {
    try {
      const url = new URL(request.url);
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        return jsonResponse(400, { error: 'Malformed URL path' });
      }

      if (pathname.startsWith('/api/')) {
        return await handleApiRequest(request, env, url, pathname);
      }

      if (env?.ASSETS && typeof env.ASSETS.fetch === 'function') {
        const assetRes = await env.ASSETS.fetch(request);
        const headers = new Headers(assetRes.headers);
        for (const [key, val] of Object.entries(SECURITY_HEADERS)) {
          if (!headers.has(key)) {
            headers.set(key, val);
          }
        }
        return new Response(assetRes.body, {
          status: assetRes.status,
          statusText: assetRes.statusText,
          headers,
        });
      }

      return new Response('Not Found', {
        status: 404,
        headers: buildHeaders(SECURITY_HEADERS, { 'Content-Type': 'text/plain; charset=utf-8' }),
      });
    } catch (err) {
      if (
        err instanceof ValidationError ||
        err instanceof UnauthorizedError ||
        err instanceof ForbiddenError ||
        err instanceof NotFoundError ||
        err instanceof ConflictError ||
        typeof err?.statusCode === 'number'
      ) {
        return jsonResponse(err.statusCode, { error: err.message });
      }
      console.error('Unhandled worker error:', err);
      return jsonResponse(500, { error: 'Internal server error' });
    }
  },
};
