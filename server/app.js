import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
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
  PROJECT_ROOT,
  DEFAULT_DB_PATH,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  isValidYmd,
  serializeResolvedParser,
  createDatabase,
} from './db.js';
import {
  computeCardSummaries,
  computeDailyOverview,
  computeHeatmap,
  computeLeaderboard,
  computeGameStats,
  computePlayersLeaderboard,
} from './stats.js';

const SHARED_ROOT = path.join(PROJECT_ROOT, 'shared');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'public');
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const API_VARY_HEADER = 'Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      const err = new Error('Request body too large');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError('Invalid JSON request body');
  }
}

function serializeParserOption(parser) {
  const base = serializeResolvedParser(parser);
  return {
    ...base,
    supportedSlugs: Array.isArray(parser?.supportedSlugs) ? [...parser.supportedSlugs] : [],
    supportedDomains: Array.isArray(parser?.supportedDomains) ? [...parser.supportedDomains] : [],
  };
}

function serveStaticFile(req, res, rootDir, relUrlPath) {
  if (relUrlPath.includes('\0')) {
    sendText(res, 400, 'Bad Request');
    return;
  }

  const normalizedRel = relUrlPath.replace(/^\/+/, '');
  const resolved = path.resolve(rootDir, normalizedRel);

  if (resolved !== rootDir && !resolved.startsWith(rootDir + path.sep)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    sendText(res, 404, 'Not Found');
    return;
  }

  if (!stat.isFile()) {
    sendText(res, 404, 'Not Found');
    return;
  }

  const ext = path.extname(resolved).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const data = fs.readFileSync(resolved);

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
  });

  if (req.method === 'HEAD') {
    res.end();
  } else {
    res.end(data);
  }
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

export function createApp({ dbPath = DEFAULT_DB_PATH } = {}) {
  const db = createDatabase({ dbPath });
  let closed = false;

  async function resolveSession(req) {
    const rawToken = parseSessionCookie(req.headers.cookie);
    if (!rawToken) return null;
    const tokenHash = await sha256Hex(rawToken);
    return db.getSessionByTokenHash(tokenHash);
  }

  async function requireSession(req) {
    const session = await resolveSession(req);
    if (!session) {
      throw new UnauthorizedError('Authentication required');
    }
    return session;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const rawUrl = req.url || '/';
      const safePath = rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`;
      const url = new URL(`http://${req.headers.host || '127.0.0.1'}${safePath}`);
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        sendJson(res, 400, { error: 'Malformed URL path' });
        return;
      }

      if (pathname.startsWith('/api/')) {
        await handleApiRequest(req, res, url, pathname);
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(res, 405, 'Method Not Allowed');
        return;
      }

      if (pathname === '/shared' || pathname.startsWith('/shared/')) {
        const rel = pathname.slice('/shared'.length);
        if (!rel || rel === '/') {
          sendText(res, 404, 'Not Found');
          return;
        }
        serveStaticFile(req, res, SHARED_ROOT, rel);
        return;
      }

      const publicRel = pathname === '/' ? 'index.html' : pathname;
      serveStaticFile(req, res, PUBLIC_ROOT, publicRel);
    } catch (err) {
      if (
        err instanceof ValidationError ||
        err instanceof UnauthorizedError ||
        err instanceof ForbiddenError ||
        err instanceof NotFoundError ||
        err instanceof ConflictError ||
        typeof err.statusCode === 'number'
      ) {
        sendJson(res, err.statusCode, { error: err.message });
        return;
      }
      console.error('Unhandled server error:', err);
      sendJson(res, 500, { error: 'Internal server error' });
    }
  });

  async function handleApiRequest(req, res, url, pathname) {
    const method = req.method || 'GET';

    if (isDisallowedCrossSiteRequest(method, req.headers['sec-fetch-site'])) {
      sendJson(
        res,
        403,
        { error: 'Cross-site request blocked' },
        { Vary: API_VARY_HEADER },
      );
      return;
    }

    if (method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { ok: true, timestamp: new Date().toISOString() });
      return;
    }

    if (method === 'GET' && pathname === '/api/auth/me') {
      const session = await resolveSession(req);
      if (session) {
        sendJson(res, 200, {
          authenticated: true,
          user: session.user,
        });
        return;
      }
      const status = db.getAuthBootstrapStatus();
      sendJson(res, 200, {
        authenticated: false,
        user: null,
        hasUsers: status.hasUsers,
        unclaimed: {
          gamesCount: status.unclaimedGamesCount,
          entriesCount: status.unclaimedEntriesCount,
        },
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/auth/register') {
      const body = await readJsonBody(req);
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

      const email = normalizeEmail(body.email);
      if (db.getUserByEmail(email)) {
        throw new ConflictError('An account with this email already exists');
      }

      const { hashHex, saltHex } = await hashPassword(body.password);
      const user = db.registerUser({
        name: nameCheck.value,
        email,
        passwordHash: hashHex,
        passwordSalt: saltHex,
      });

      const { rawToken, tokenHash, sessionId, expiresAt } = await generateSessionToken();
      db.createSession({
        id: sessionId,
        userId: user.id,
        tokenHash,
        expiresAt,
      });

      sendJson(
        res,
        201,
        { authenticated: true, user },
        { 'Set-Cookie': buildSessionCookie(rawToken, isHttpsRequest(req)) },
      );
      return;
    }

    if (method === 'POST' && pathname === '/api/auth/login') {
      const body = await readJsonBody(req);
      const email = normalizeEmail(body?.email);
      const password = typeof body?.password === 'string' ? body.password : '';
      if (!email || !password) {
        throw new ValidationError('Email and password are required');
      }

      const userRow = db.getUserByEmail(email);
      if (!userRow) {
        await dummyVerifyPassword(password);
        throw new UnauthorizedError('Invalid email or password');
      }

      const valid = await verifyPassword(password, userRow.passwordSalt, userRow.passwordHash);
      if (!valid) {
        throw new UnauthorizedError('Invalid email or password');
      }

      const { rawToken, tokenHash, sessionId, expiresAt } = await generateSessionToken();
      db.createSession({
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

      sendJson(
        res,
        200,
        { authenticated: true, user },
        { 'Set-Cookie': buildSessionCookie(rawToken, isHttpsRequest(req)) },
      );
      return;
    }

    if (method === 'POST' && pathname === '/api/auth/logout') {
      const rawToken = parseSessionCookie(req.headers.cookie);
      if (rawToken) {
        const tokenHash = await sha256Hex(rawToken);
        db.deleteSessionByTokenHash(tokenHash);
      }
      sendJson(
        res,
        200,
        { ok: true },
        {
          'Set-Cookie': buildClearSessionCookies(isHttpsRequest(req)),
          'Clear-Site-Data': '"cookies"',
        },
      );
      return;
    }

    const session = await requireSession(req);
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

      const games = db.listGames({ userId, includeArchived: true });
      const allEntries = db.listEntries({ userId });
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
      const catalog = db.listCatalogGames({ userId });

      sendJson(res, 200, {
        date,
        user: session.user,
        games,
        entriesForDate,
        cardSummaries,
        dailyOverview,
        parsers,
        catalog,
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/catalog') {
      sendJson(res, 200, { catalog: db.listCatalogGames({ userId }) });
      return;
    }

    if (method === 'POST' && pathname === '/api/catalog/subscribe') {
      const body = await readJsonBody(req);
      const result = db.subscribeCatalogGame(body?.slug, userId);
      sendJson(res, result.status === 'subscribed' ? 201 : 200, result);
      return;
    }

    if (method === 'GET' && pathname === '/api/games') {
      const includeArchivedParam = url.searchParams.get('includeArchived');
      const includeArchived = includeArchivedParam !== 'false';
      sendJson(res, 200, { games: db.listGames({ userId, includeArchived }) });
      return;
    }

    if (method === 'POST' && pathname === '/api/games') {
      const body = await readJsonBody(req);
      const game = db.createGame(body, userId);
      sendJson(res, 201, { game });
      return;
    }

    if (method === 'PUT' && pathname === '/api/games/reorder') {
      const body = await readJsonBody(req);
      const games = db.reorderGames(body.orderedIds, userId);
      sendJson(res, 200, { games });
      return;
    }

    const reparseMatch = /^\/api\/games\/([^/]+)\/reparse$/.exec(pathname);
    if (method === 'POST' && reparseMatch) {
      const body = await readJsonBody(req);
      const result = db.reparseGameEntries(
        reparseMatch[1],
        { force: Boolean(body?.force) },
        userId,
      );
      sendJson(res, 200, result);
      return;
    }

    const gameIdMatch = /^\/api\/games\/([^/]+)$/.exec(pathname);
    if (gameIdMatch) {
      const id = gameIdMatch[1];
      if (method === 'PUT') {
        const body = await readJsonBody(req);
        const game = db.updateGame(id, body, userId);
        sendJson(res, 200, { game });
        return;
      }
      if (method === 'DELETE') {
        db.deleteGame(id, userId);
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    if (method === 'POST' && pathname === '/api/detect') {
      const body = await readJsonBody(req);
      if (typeof body?.rawText !== 'string') {
        throw new ValidationError('rawText must be a string');
      }
      const activeGames = db.listGames({ userId, includeArchived: false });
      const detection = detectGameAndParse(body.rawText, activeGames);
      const difficulty = normalizeDifficultyLabel(detection?.parsed?.metadata?.difficulty) || null;
      const g = detection?.matchedGame;
      const supportsDifficulty = Boolean(
        g?.slug === 'cluesbysam' ||
          g?.parserId === 'cluesbysam' ||
          g?.resolvedParser?.id === 'cluesbysam' ||
          detection?.parserId === 'cluesbysam' ||
          difficulty,
      );
      sendJson(res, 200, { ...detection, difficulty, supportsDifficulty });
      return;
    }

    if (method === 'POST' && pathname === '/api/entries/parse-preview') {
      const body = await readJsonBody(req);
      if (typeof body?.rawText !== 'string') {
        throw new ValidationError('rawText must be a string');
      }
      if (body.gameId !== undefined && body.gameId !== null && body.gameId !== '') {
        const game = db.getGameById(body.gameId, userId);
        if (!game) {
          throw new NotFoundError('Game not found');
        }
        const parsed = parseForGame(body.rawText, game);
        const difficulty = normalizeDifficultyLabel(parsed?.metadata?.difficulty) || null;
        const supportsDifficulty = Boolean(
          game.slug === 'cluesbysam' ||
            game.parserId === 'cluesbysam' ||
            game.resolvedParser?.id === 'cluesbysam' ||
            difficulty,
        );
        sendJson(res, 200, {
          matchedGame: game,
          gameId: game.id,
          parserId: parsed.parserId,
          parsed,
          difficulty,
          supportsDifficulty,
        });
        return;
      }
      const activeGames = db.listGames({ userId, includeArchived: false });
      const detection = detectGameAndParse(body.rawText, activeGames);
      const difficulty = normalizeDifficultyLabel(detection?.parsed?.metadata?.difficulty) || null;
      const g = detection?.matchedGame;
      const supportsDifficulty = Boolean(
        g?.slug === 'cluesbysam' ||
          g?.parserId === 'cluesbysam' ||
          g?.resolvedParser?.id === 'cluesbysam' ||
          detection?.parserId === 'cluesbysam' ||
          difficulty,
      );
      sendJson(res, 200, { ...detection, difficulty, supportsDifficulty });
      return;
    }

    if (method === 'GET' && pathname === '/api/entries') {
      const entries = db.listEntries({
        userId,
        gameId: url.searchParams.get('gameId'),
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        date: url.searchParams.get('date'),
        limit: url.searchParams.get('limit'),
      });
      sendJson(res, 200, { entries });
      return;
    }

    if (method === 'POST' && pathname === '/api/entries') {
      const body = await readJsonBody(req);
      const entry = db.upsertEntry(body, userId);
      sendJson(res, 201, { entry });
      return;
    }

    const entryIdMatch = /^\/api\/entries\/([^/]+)$/.exec(pathname);
    if (entryIdMatch) {
      const id = entryIdMatch[1];
      if (method === 'PUT') {
        const body = await readJsonBody(req);
        const entry = db.updateEntry(id, body, userId);
        sendJson(res, 200, { entry });
        return;
      }
      if (method === 'DELETE') {
        db.deleteEntry(id, userId);
        sendJson(res, 200, { ok: true });
        return;
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
      const games = db.listGames({ userId, includeArchived: true });
      const allEntries = db.listEntries({ userId });

      let selectedGame = null;
      if (gameIdParam !== null && gameIdParam !== '') {
        selectedGame = db.getGameById(gameIdParam, userId);
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

      sendJson(res, 200, {
        heatmap,
        leaderboard,
        gameStats,
      });
      return;
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

      const allGamesForLeaderboard = db.listAllGamesForLeaderboard();
      let gameSlug = gameSlugParam && gameSlugParam.trim() ? gameSlugParam.trim() : null;
      if (!gameSlug && gameIdParam !== null && gameIdParam !== '') {
        const matchedGame = allGamesForLeaderboard.find(
          (g) => String(g.id) === String(gameIdParam.trim()),
        );
        if (matchedGame) {
          gameSlug = matchedGame.slug;
        }
      }

      const payload = computePlayersLeaderboard({
        users: db.listUsersPublic(),
        allGames: allGamesForLeaderboard,
        allEntries: db.listAllEntriesForLeaderboard(),
        viewerUserId: userId,
        referenceDate,
        days,
        gameSlug,
        difficulty: difficultyParam,
        live,
        now,
        viewerTimeZone,
      });

      sendJson(res, 200, payload);
      return;
    }

    if (method === 'GET' && pathname === '/api/export') {
      sendJson(res, 200, db.exportData(userId));
      return;
    }

    if (method === 'POST' && pathname === '/api/import') {
      const body = await readJsonBody(req);
      const result = db.importData(body, userId);
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  }

  function close() {
    if (closed) return Promise.resolve();
    closed = true;

    if (!server.listening) {
      try {
        db.close();
      } catch {
        // ignore double-close
      }
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      server.close(() => {
        try {
          db.close();
        } catch {
          // ignore
        }
        resolve();
      });
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
    });
  }

  return { server, db, close };
}
