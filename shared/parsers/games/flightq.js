import { extractEmojiGrid, extractExplicitDate, extractPuzzleId } from '../utils.js';
import { passportqParser } from './passportq.js';

const FLIGHTQ_GAME_SLUGS = [
  'skyq',
  'airportq',
  'airlineq',
  'planeq',
  'strata',
  'mapfold',
  'flyover',
  'cityq',
  'headcount',
  'transitq',
  'railq',
  'railpass',
  'getaway',
  'layover',
  'departure-board',
  'vector',
  'misplaced',
  'radius',
  'airspan',
  'livery',
  'airfield',
  'airport-guesser',
  'soar',
];

const FLIGHTQ_SLUG_SET = new Set(FLIGHTQ_GAME_SLUGS);

const SLUG_ALIAS_NORMALIZE = new Map([
  ['pq', 'passportq'],
  ['passportq', 'passportq'],
  ['layers', 'strata'],
  ['scaleq', 'airspan'],
  ['flightq', 'skyq'],
]);

const EXPLICIT_TITLE_PATTERNS = [
  { slug: 'departure-board', regex: /\bdeparture\s+board\b/i },
  { slug: 'airport-guesser', regex: /\bairport\s+guesser\b/i },
  { slug: 'skyq', regex: /\bskyq\b/i },
  { slug: 'airportq', regex: /\bairportq\b/i },
  { slug: 'airlineq', regex: /\bairlineq\b/i },
  { slug: 'planeq', regex: /\bplaneq\b/i },
  { slug: 'strata', regex: /\bstrata\b/i },
  { slug: 'mapfold', regex: /\bmapfold\b/i },
  { slug: 'flyover', regex: /\bflyover\b/i },
  { slug: 'cityq', regex: /\bcityq\b/i },
  { slug: 'headcount', regex: /\bheadcount\b/i },
  { slug: 'transitq', regex: /\btransitq\b/i },
  { slug: 'railq', regex: /\brailq\b/i },
  { slug: 'railpass', regex: /\brailpass\b/i },
  { slug: 'airspan', regex: /\bairspan\b/i },
  { slug: 'airspan', regex: /\bscaleq\b/i },
];

const GENERIC_WORD_TITLES = [
  { slug: 'getaway', regex: /\bgetaway\b/i },
  { slug: 'layover', regex: /\blayover\b/i },
  { slug: 'vector', regex: /\bvector\b/i },
  { slug: 'misplaced', regex: /\bmisplaced\b/i },
  { slug: 'radius', regex: /\bradius\b/i },
  { slug: 'livery', regex: /\blivery\b/i },
  { slug: 'airfield', regex: /\bairfield\b/i },
  { slug: 'soar', regex: /\bsoar\b/i },
];

const FLIGHTQ_DOMAINS_REGEX = /\b(?:flightq|skyq|planeq|mapfold|airportle)\.app\b/i;
const GENERIC_TITLE_WITH_ID_REGEX =
  /\b(?:Radius|Vector|Soar|Livery|Misplaced|Getaway|Layover|Airfield|Layers)\s+(?:No\.?\s*|Day\s*|#)\d+/i;
const PUZZLE_SIGNAL_REGEX =
  /\b(?:score|pts|points|solved|got it|missed|stumped|guesses?|km|mi|miles)\b|[🟩🟨⬛⬜🟦🟧🟥]/iu;

const PURE_SQUARE_LINE_REGEX = /^[🟩🟨⬛⬜🟦🟧🟥🟪🟫\uFE0F\s]+$/u;
const HAS_SQUARE_TILE_REGEX = /[🟩🟨⬛⬜🟦🟧🟥🟪🟫]/u;
const VALID_FORMATS = new Set(['number', 'duration_sec', 'percent', 'fraction']);

function normalizeDetectedSlug(rawSlug) {
  if (typeof rawSlug !== 'string' || !rawSlug.trim()) return null;
  const lower = rawSlug.trim().toLowerCase();
  if (SLUG_ALIAS_NORMALIZE.has(lower)) {
    return SLUG_ALIAS_NORMALIZE.get(lower);
  }
  if (FLIGHTQ_SLUG_SET.has(lower)) {
    return lower;
  }
  return null;
}

function parseCleanNumber(token) {
  if (!token) return null;
  const num = Number(String(token).replace(/,/g, ''));
  return Number.isFinite(num) ? num : null;
}

function formatScoreNumber(num) {
  return Number.isInteger(num) ? String(num) : String(Number(num.toFixed(2)));
}

function formatDistanceNumber(num) {
  return Number.isInteger(num)
    ? num.toLocaleString('en-US')
    : Number(num.toFixed(2)).toLocaleString('en-US');
}

function extractFlightQPuzzleId(text) {
  const baseId = extractPuzzleId(text);
  if (baseId) return baseId;
  const withoutUrls = text.replace(/https?:\/\/\S+/gi, ' ');
  const dayMatch = /\bday[ \t]+(\d[\d,]*)(?=$|[\s).,!?:;])/im.exec(withoutUrls);
  if (dayMatch) {
    return `#${dayMatch[1].replace(/,/g, '')}`;
  }
  return null;
}

function extractSquareEmojiGrid(text) {
  const lines = text.split(/\r?\n/);
  const squareLines = [];
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (PURE_SQUARE_LINE_REGEX.test(trimmed) && HAS_SQUARE_TILE_REGEX.test(trimmed)) {
      squareLines.push(trimmed);
    }
  }
  if (squareLines.length > 0) {
    return squareLines.join('\n');
  }
  return extractEmojiGrid(text);
}

export const flightqParser = {
  id: 'flightq',
  name: 'FlightQ Suite',
  version: 1,
  isCustomParser: true,
  supportedSlugs: [...FLIGHTQ_GAME_SLUGS, 'flightq', 'layers', 'scaleq'],
  supportedDomains: ['flightq.app', 'skyq.app', 'planeq.app', 'mapfold.app', 'airportle.app'],

  canParse(rawText) {
    if (typeof rawText !== 'string') return false;
    if (passportqParser.canParse(rawText)) return false;

    if (FLIGHTQ_DOMAINS_REGEX.test(rawText)) {
      return true;
    }
    if (/\bflightq\b/i.test(rawText)) {
      return true;
    }
    if (EXPLICIT_TITLE_PATTERNS.some((entry) => entry.regex.test(rawText))) {
      return true;
    }
    if (GENERIC_TITLE_WITH_ID_REGEX.test(rawText) && PUZZLE_SIGNAL_REGEX.test(rawText)) {
      return true;
    }
    return false;
  },

  detectGameSlug(rawText) {
    if (typeof rawText !== 'string' || !rawText.trim()) return null;

    // 1. Check URLs (?ref= param, dedicated domains, flightq.app/<slug>)
    const urlMatches = rawText.match(/https?:\/\/[^\s<>)]+/gi) || [];
    for (const rawUrl of urlMatches) {
      try {
        const parsed = new URL(rawUrl);
        const ref = parsed.searchParams.get('ref');
        const fromRef = normalizeDetectedSlug(ref);
        if (fromRef) return fromRef;

        const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
        if (host === 'skyq.app') return 'skyq';
        if (host === 'planeq.app') return 'planeq';
        if (host === 'mapfold.app') return 'mapfold';
        if (host === 'airportle.app') return 'airportq';
        if (host === 'passportq.app') return 'passportq';

        if (host === 'flightq.app' || host.endsWith('.flightq.app')) {
          const segments = parsed.pathname
            .split('/')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
          for (const seg of segments) {
            if (seg === 'sp' || seg === 'daily') continue;
            const fromPath = normalizeDetectedSlug(seg);
            if (fromPath) return fromPath;
          }
        }
      } catch {
        // fallback regex below
      }
    }

    // Also handle bare domain references without https://
    const refRegex = /[?&]ref=([a-z0-9_-]+)/i.exec(rawText);
    if (refRegex) {
      const fromRef = normalizeDetectedSlug(refRegex[1]);
      if (fromRef) return fromRef;
    }
    const barePath = /\bflightq\.app\/([a-z0-9-]+)\b/i.exec(rawText);
    if (barePath && barePath[1].toLowerCase() !== 'sp') {
      const fromBarePath = normalizeDetectedSlug(barePath[1]);
      if (fromBarePath) return fromBarePath;
    }
    if (/\bskyq\.app\b/i.test(rawText)) return 'skyq';
    if (/\bplaneq\.app\b/i.test(rawText)) return 'planeq';
    if (/\bmapfold\.app\b/i.test(rawText)) return 'mapfold';
    if (/\bairportle\.app\b/i.test(rawText)) return 'airportq';

    // 2. Explicit title match in share text
    for (const entry of EXPLICIT_TITLE_PATTERNS) {
      if (entry.regex.test(rawText)) {
        return entry.slug;
      }
    }

    // 3. Generic English FlightQ titles when paired with puzzle ID or FlightQ URL
    const hasFlightqContext =
      /\bflightq\.app\b|\bflightq\b/i.test(rawText) || GENERIC_TITLE_WITH_ID_REGEX.test(rawText);
    if (hasFlightqContext) {
      if (/\blayers\b/i.test(rawText)) return 'strata';
      for (const entry of GENERIC_WORD_TITLES) {
        if (entry.regex.test(rawText)) {
          return entry.slug;
        }
      }
    }

    // 4. Generic "FlightQ" header only
    if (/\bflightq\b/i.test(rawText)) {
      return 'skyq';
    }

    return null;
  },

  parse(rawText, gameContext = {}) {
    const text = typeof rawText === 'string' ? rawText : '';

    const hasCtxFormat =
      typeof gameContext?.metricFormat === 'string' && VALID_FORMATS.has(gameContext.metricFormat);
    const ctxFormat = hasCtxFormat ? gameContext.metricFormat : null;
    const ctxDirection =
      gameContext?.metricDirection === 'lower_is_better' ||
      gameContext?.metricDirection === 'higher_is_better'
        ? gameContext.metricDirection
        : null;
    const ctxLabel =
      typeof gameContext?.metricLabel === 'string' && gameContext.metricLabel.trim()
        ? gameContext.metricLabel.trim()
        : null;

    const puzzleId = extractFlightQPuzzleId(text);
    const puzzleDate = extractExplicitDate(text);
    const emojiGrid = extractSquareEmojiGrid(text);

    const withoutUrls = text.replace(/https?:\/\/\S+/gi, ' ');
    const diffMatch = /\(\s*(Easy|Medium|Hard)\s*\)/i.exec(withoutUrls);
    const difficulty = diffMatch
      ? diffMatch[1].charAt(0).toUpperCase() + diffMatch[1].slice(1).toLowerCase()
      : null;

    const modeMatch = /\(\s*(US|World|Historic)\s*\)/i.exec(withoutUrls);
    let mode = null;
    if (modeMatch) {
      const m = modeMatch[1].toLowerCase();
      mode = m === 'us' ? 'US' : m === 'world' ? 'World' : 'Historic';
    }

    const scanText = withoutUrls
      .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, ' ')
      .replace(/\b\d{1,4}\/\d{1,2}\/\d{2,4}\b/g, ' ')
      .replace(/(^|[\s(])#\d[\d,]*/gm, '$1 ')
      .replace(/\b(?:no\.?|puzzle|day)[ \t]*\d[\d,]*/gi, ' ');

    let solved = null;
    let primaryValue = null;
    let displayValue = 'Played';
    let metricFormat = ctxFormat || 'number';
    let metricDirection = ctxDirection || 'higher_is_better';
    let metricLabel = ctxLabel || 'Score';
    let maxScore = null;
    let maxGuesses = null;

    const xFailMatch = /\bX\s*\/\s*(\d+)\b/i.exec(scanText);
    const isMiss =
      Boolean(xFailMatch) ||
      /\b(?:missed it|stumped me|dnf|failed|game over)\b/i.test(scanText);

    if (isMiss) {
      solved = false;
      primaryValue = null;
      const den = xFailMatch && Number(xFailMatch[1]) > 0 ? Number(xFailMatch[1]) : 5;
      metricFormat = ctxFormat || 'fraction';
      metricDirection = ctxDirection || 'lower_is_better';
      metricLabel = ctxLabel || 'Guesses';
      displayValue = metricFormat === 'fraction' ? `X/${den}` : 'DNF';
    } else {
      // Check guess fractions ("solved in 3/5", "got it in 2/6", or small denominator <= 20)
      const solvedInMatch =
        /\b(?:solved|got it|guessed|finished)[ \t]+in[ \t]+(\d+)\s*\/\s*(\d+)\b/i.exec(scanText);
      const smallFracMatch =
        ctxFormat !== 'number'
          ? /\b(\d{1,2})\s*\/\s*(\d{1,2})\b/.exec(scanText)
          : null;
      const guessMatch =
        solvedInMatch ||
        (smallFracMatch && Number(smallFracMatch[2]) > 0 && Number(smallFracMatch[2]) <= 20
          ? smallFracMatch
          : null);

      if (guessMatch && (ctxFormat === 'fraction' || !hasCtxFormat)) {
        const guesses = Number(guessMatch[1]);
        const max = Number(guessMatch[2]);
        if (Number.isFinite(guesses) && max > 0) {
          solved = true;
          primaryValue = guesses;
          maxGuesses = max;
          displayValue = `${guesses}/${max}`;
          metricFormat = ctxFormat || 'fraction';
          metricDirection = ctxDirection || 'lower_is_better';
          metricLabel = ctxLabel || 'Guesses';
        }
      }

      if (primaryValue === null) {
        const labeledScore =
          /\b(?:score|points|pts|total)\s*[:=\-]?\s*(\d[\d,]*(?:\.\d+)?)(?:\s*\/\s*(\d[\d,]*(?:\.\d+)?))?\b(?!(?:\.\d|\s*(?:%|\/\d)))/i.exec(
            scanText
          );
        const ratioScore =
          !labeledScore && /\b(\d[\d,]*(?:\.\d+)?)\s*\/\s*(\d[\d,]*(?:\.\d+)?)\b/.exec(scanText);
        const suffixPts =
          !labeledScore &&
          !ratioScore &&
          /\b(\d[\d,]*(?:\.\d+)?)\s*(?:pts?|points?)\b/i.exec(scanText);
        const distMatch =
          !labeledScore &&
          !ratioScore &&
          !suffixPts &&
          /\b(\d[\d,]*(?:\.\d+)?)\s*(km|mi|miles?)\b/i.exec(scanText);
        const pctMatch =
          !labeledScore &&
          !ratioScore &&
          !suffixPts &&
          !distMatch &&
          /\b(\d{1,3}(?:\.\d+)?)\s*%/.exec(scanText);

        if (labeledScore) {
          primaryValue = parseCleanNumber(labeledScore[1]);
          if (labeledScore[2]) {
            maxScore = parseCleanNumber(labeledScore[2]);
          }
          displayValue =
            maxScore !== null && maxScore > 0
              ? `${formatScoreNumber(primaryValue)}/${formatScoreNumber(maxScore)}`
              : formatScoreNumber(primaryValue);
        } else if (ratioScore) {
          primaryValue = parseCleanNumber(ratioScore[1]);
          maxScore = parseCleanNumber(ratioScore[2]);
          displayValue =
            maxScore !== null && maxScore > 0
              ? `${formatScoreNumber(primaryValue)}/${formatScoreNumber(maxScore)}`
              : formatScoreNumber(primaryValue);
        } else if (suffixPts) {
          primaryValue = parseCleanNumber(suffixPts[1]);
          displayValue = formatScoreNumber(primaryValue);
        } else if (distMatch) {
          primaryValue = parseCleanNumber(distMatch[1]);
          const rawUnit = distMatch[2].toLowerCase();
          const unit = rawUnit === 'km' ? 'km' : 'mi';
          displayValue = `${formatDistanceNumber(primaryValue)} ${unit}`;
          metricLabel = ctxLabel || 'Distance';
          metricDirection = ctxDirection || 'higher_is_better';
        } else if (pctMatch) {
          primaryValue = parseCleanNumber(pctMatch[1]);
          displayValue = `${Number.isInteger(primaryValue) ? primaryValue : Number(primaryValue.toFixed(2))}%`;
          metricFormat = ctxFormat || 'percent';
        } else {
          const standalone = /(?<![\d.:#])\b(\d[\d,]*(?:\.\d+)?)\b/.exec(scanText);
          if (standalone) {
            primaryValue = parseCleanNumber(standalone[1]);
            displayValue = formatScoreNumber(primaryValue);
          }
        }
      }
    }

    const metadata = {};
    if (difficulty) {
      metadata.difficulty = difficulty;
    }
    if (mode) {
      metadata.mode = mode;
    }
    if (maxScore !== null && maxScore > 0) {
      metadata.maxScore = maxScore;
    }
    if (maxGuesses !== null && maxGuesses > 0) {
      metadata.maxGuesses = maxGuesses;
    }
    if (emojiGrid) {
      metadata.emojiGrid = emojiGrid;
    }

    return {
      parserId: 'flightq',
      parserVersion: 1,
      isCustomParser: true,
      completed: true,
      solved,
      primaryValue,
      displayValue,
      metricFormat,
      metricDirection,
      metricLabel,
      puzzleId,
      puzzleDate,
      breakdown: [],
      metadata,
    };
  },
};

export default flightqParser;
