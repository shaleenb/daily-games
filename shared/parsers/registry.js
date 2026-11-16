import { GENERIC_PARSER } from './generic.js';
import {
  CLUES_BY_SAM_DIFFICULTIES,
  cluesBySamParser,
  normalizeDifficultyLabel,
} from './games/cluesbysam.js';
import { PERCEPTLE_ROUNDS, perceptleParser } from './games/perceptle.js';
import { plainParser } from './games/plain.js';
import { timeguessrParser } from './games/timeguessr.js';
import { wordleParser } from './games/wordle.js';
import {
  COMMON_RESET_TIMEZONES,
  compactSlug,
  extractDomain,
  formatCountdownCompact,
  formatDurationSeconds,
  formatMetricValue,
  getGamePuzzleStatus,
  getLocalDateString,
  isValidResetTime,
  isValidResetTimezone,
  parseDurationSeconds,
  slugify,
} from './utils.js';

export const PARSERS = [
  cluesBySamParser,
  perceptleParser,
  plainParser,
  timeguessrParser,
  wordleParser,
];

export {
  GENERIC_PARSER,
  CLUES_BY_SAM_DIFFICULTIES,
  normalizeDifficultyLabel,
  PERCEPTLE_ROUNDS,
  COMMON_RESET_TIMEZONES,
  slugify,
  compactSlug,
  extractDomain,
  getLocalDateString,
  parseDurationSeconds,
  formatDurationSeconds,
  formatMetricValue,
  isValidResetTimezone,
  isValidResetTime,
  formatCountdownCompact,
  getGamePuzzleStatus,
};

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasWordMatch(lowerText, term) {
  if (!term) return false;
  const regex = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(term)}(?=$|[^a-z0-9])`, 'i');
  return regex.test(lowerText);
}

function hasDomainMatch(lowerText, domain) {
  if (!domain) return false;
  const regex = new RegExp(
    `(?:^|[^a-z0-9-])(?:www\\.)?${escapeRegExp(domain)}(?=$|[^a-z0-9.-]|\\.(?!\\w))`,
    'i'
  );
  return regex.test(lowerText);
}

function matchesDomainList(domain, supportedDomains = []) {
  if (!domain || !Array.isArray(supportedDomains)) return false;
  return supportedDomains.some((d) => {
    const target = typeof d === 'string' ? d.trim().toLowerCase().replace(/^www\./, '') : '';
    return target && (domain === target || domain.endsWith(`.${target}`));
  });
}

function getGameSlugCandidates(game) {
  const candidates = new Set();
  for (const raw of [game?.slug, slugify(game?.name), compactSlug(game?.name)]) {
    if (typeof raw === 'string' && raw.trim()) {
      candidates.add(raw.trim().toLowerCase());
    }
  }
  return candidates;
}

function parserMatchesGameSlugs(parser, candidates) {
  const parserKeys = [parser.id, ...(parser.supportedSlugs || [])];
  for (const key of parserKeys) {
    if (typeof key !== 'string' || !key.trim()) continue;
    const lower = key.trim().toLowerCase();
    if (candidates.has(lower) || candidates.has(slugify(lower)) || candidates.has(compactSlug(lower))) {
      return true;
    }
  }
  return false;
}

/**
 * Look up a parser by its exact ID ('generic', 'wordle', etc.).
 * Returns null if unknown.
 */
export function getParserById(parserId) {
  if (typeof parserId !== 'string' || !parserId.trim()) return null;
  const normalized = parserId.trim().toLowerCase();
  if (normalized === 'generic') return GENERIC_PARSER;
  return PARSERS.find((parser) => parser.id.toLowerCase() === normalized) || null;
}

/**
 * Resolve the best parser for a given game configuration object.
 */
export function getParserForGame(game) {
  if (!game || typeof game !== 'object') {
    return GENERIC_PARSER;
  }

  const requestedId = typeof game.parserId === 'string' ? game.parserId.trim().toLowerCase() : '';
  if (requestedId === 'generic') {
    return GENERIC_PARSER;
  }
  if (requestedId && requestedId !== 'auto') {
    const explicit = getParserById(requestedId);
    if (explicit) return explicit;
  }

  const candidates = getGameSlugCandidates(game);
  for (const parser of PARSERS) {
    if (parserMatchesGameSlugs(parser, candidates)) {
      return parser;
    }
  }

  const gameDomain = extractDomain(game.url);
  if (gameDomain) {
    for (const parser of PARSERS) {
      if (matchesDomainList(gameDomain, parser.supportedDomains)) {
        return parser;
      }
    }
  }

  return GENERIC_PARSER;
}

/**
 * Parse raw share text for a specific game using its resolved parser.
 */
export function parseForGame(rawText, game = {}) {
  const parser = getParserForGame(game);
  return parser.parse(rawText, game || {});
}

function findGameForCustomParser(customParser, activeGames) {
  // 1. Explicit parserId match
  const explicit = activeGames.find(
    (g) => typeof g.parserId === 'string' && g.parserId.trim().toLowerCase() === customParser.id.toLowerCase()
  );
  if (explicit) return explicit;

  // 2. Slug / name match (excluding games explicitly forced to 'generic')
  const slugMatch = activeGames.find((g) => {
    const pid = typeof g.parserId === 'string' ? g.parserId.trim().toLowerCase() : '';
    if (pid === 'generic') return false;
    return parserMatchesGameSlugs(customParser, getGameSlugCandidates(g));
  });
  if (slugMatch) return slugMatch;

  // 3. Domain match (excluding games explicitly forced to 'generic')
  const domainMatch = activeGames.find((g) => {
    const pid = typeof g.parserId === 'string' ? g.parserId.trim().toLowerCase() : '';
    if (pid === 'generic') return false;
    return matchesDomainList(extractDomain(g.url), customParser.supportedDomains);
  });
  return domainMatch || null;
}

/**
 * Detect which game (and parser) matches raw share text and parse it.
 * Returns { matchedGame, confidence, parserId, parsed }.
 */
export function detectGameAndParse(rawText, games = []) {
  const text = typeof rawText === 'string' ? rawText : '';
  const activeGames = Array.isArray(games) ? games.filter((g) => g && !g.archived) : [];

  if (!text.trim()) {
    const parsed = GENERIC_PARSER.parse(text, {});
    return {
      matchedGame: null,
      confidence: 'none',
      parserId: parsed.parserId,
      parsed,
    };
  }

  // 1. Custom parser auto-detection via canParse()
  const matchedCustomParser = PARSERS.find(
    (parser) => typeof parser.canParse === 'function' && parser.canParse(text)
  );
  if (matchedCustomParser) {
    const matchedGame = findGameForCustomParser(matchedCustomParser, activeGames);
    const parser = matchedGame ? getParserForGame(matchedGame) : matchedCustomParser;
    const parsed = parser.parse(text, matchedGame || {});
    return {
      matchedGame,
      confidence: 'high',
      parserId: parsed.parserId,
      parsed,
    };
  }

  // 2. Match against known games by domain, name, slug, or compactSlug
  const lowerText = text.toLowerCase();
  const tokens = new Set(lowerText.split(/[^a-z0-9]+/).filter(Boolean));
  const compactText = compactSlug(text);

  let bestMatch = null;

  for (let i = 0; i < activeGames.length; i += 1) {
    const game = activeGames[i];
    const domain = extractDomain(game.url);
    const name = typeof game.name === 'string' ? game.name.trim().toLowerCase() : '';
    const slug = typeof game.slug === 'string' ? game.slug.trim().toLowerCase() : '';
    const nameSlug = slugify(game.name);
    const nameCompact = compactSlug(game.name);
    const slugCompact = compactSlug(game.slug);

    let score = 0;
    let confidence = 'none';

    if (domain && domain.length >= 4 && hasDomainMatch(lowerText, domain)) {
      score = 1000 + domain.length;
      confidence = 'high';
    } else if (name && name.length >= 3 && hasWordMatch(lowerText, name)) {
      score = 800 + name.length;
      confidence = 'high';
    } else if (
      (slug && slug.length >= 3 && hasWordMatch(lowerText, slug)) ||
      (nameSlug && nameSlug.length >= 3 && hasWordMatch(lowerText, nameSlug))
    ) {
      score = 600 + Math.max(slug.length, nameSlug.length);
      confidence = 'medium';
    } else if (
      (nameCompact && nameCompact.length >= 3 && tokens.has(nameCompact)) ||
      (slugCompact && slugCompact.length >= 3 && tokens.has(slugCompact))
    ) {
      score = 500 + Math.max(nameCompact.length, slugCompact.length);
      confidence = 'medium';
    } else if (
      (nameCompact && nameCompact.length >= 6 && compactText.includes(nameCompact)) ||
      (slugCompact && slugCompact.length >= 6 && compactText.includes(slugCompact))
    ) {
      score = 300 + Math.max(nameCompact.length, slugCompact.length);
      confidence = 'low';
    }

    if (score > 0) {
      const sortOrder = Number.isFinite(Number(game.sortOrder)) ? Number(game.sortOrder) : i;
      if (
        !bestMatch ||
        score > bestMatch.score ||
        (score === bestMatch.score && sortOrder < bestMatch.sortOrder)
      ) {
        bestMatch = { game, score, confidence, sortOrder };
      }
    }
  }

  if (bestMatch) {
    const parsed = parseForGame(text, bestMatch.game);
    return {
      matchedGame: bestMatch.game,
      confidence: bestMatch.confidence,
      parserId: parsed.parserId,
      parsed,
    };
  }

  const parsed = GENERIC_PARSER.parse(text, {});
  return {
    matchedGame: null,
    confidence: 'none',
    parserId: parsed.parserId,
    parsed,
  };
}
