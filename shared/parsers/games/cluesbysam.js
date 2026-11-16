import {
  extractEmojiGrid,
  extractExplicitDate,
  extractPuzzleId,
  formatDurationSeconds,
  parseDurationSeconds,
} from '../utils.js';

export const CLUES_BY_SAM_DIFFICULTIES = ['Easy', 'Medium', 'Tricky', 'Hard', 'Brutal'];

const CANONICAL_DIFFICULTY_MAP = new Map(
  CLUES_BY_SAM_DIFFICULTIES.map((label) => [label.toLowerCase(), label])
);

const MONTH_MAP = new Map([
  ['jan', 1],
  ['january', 1],
  ['feb', 2],
  ['february', 2],
  ['mar', 3],
  ['march', 3],
  ['apr', 4],
  ['april', 4],
  ['may', 5],
  ['jun', 6],
  ['june', 6],
  ['jul', 7],
  ['july', 7],
  ['aug', 8],
  ['august', 8],
  ['sep', 9],
  ['sept', 9],
  ['september', 9],
  ['oct', 10],
  ['october', 10],
  ['nov', 11],
  ['november', 11],
  ['dec', 12],
  ['december', 12],
]);

const MONTH_PATTERN =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

const MONTH_FIRST_DATE_REGEX = new RegExp(
  `\\b(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,|\\s)+\\s*((?:19|20)\\d{2})\\b`,
  'i'
);

const DAY_FIRST_DATE_REGEX = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})\\.?(?:,|\\s)+\\s*((?:19|20)\\d{2})\\b`,
  'i'
);

const LEGACY_SINGLE_HINT_TILES = new Set(['🟧', '💡', '❓', '⬜', '⬛']);
const LEGACY_DOUBLE_HINT_TILES = new Set(['🟥']);

/**
 * Normalize a Clues by Sam difficulty label into canonical casing
 * ('Easy' | 'Medium' | 'Tricky' | 'Hard' | 'Brutal') or title-cased custom label.
 * Returns null for empty, null, or non-string input.
 */
export function normalizeDifficultyLabel(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;

  const canonical = CANONICAL_DIFFICULTY_MAP.get(trimmed.toLowerCase());
  if (canonical) return canonical;

  return trimmed
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function validateCalendarDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  const check = new Date(year, month - 1, day);
  if (
    check.getFullYear() !== year ||
    check.getMonth() !== month - 1 ||
    check.getDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function extractCluesBySamDate(rawText) {
  const iso = extractExplicitDate(rawText);
  if (iso) return iso;
  if (typeof rawText !== 'string' || !rawText) return null;

  const monthFirst = MONTH_FIRST_DATE_REGEX.exec(rawText);
  if (monthFirst) {
    const month = MONTH_MAP.get(monthFirst[1].toLowerCase());
    const day = Number(monthFirst[2]);
    const year = Number(monthFirst[3]);
    const valid = validateCalendarDate(year, month, day);
    if (valid) return valid;
  }

  const dayFirst = DAY_FIRST_DATE_REGEX.exec(rawText);
  if (dayFirst) {
    const day = Number(dayFirst[1]);
    const month = MONTH_MAP.get(dayFirst[2].toLowerCase());
    const year = Number(dayFirst[3]);
    const valid = validateCalendarDate(year, month, day);
    if (valid) return valid;
  }

  return null;
}

function extractDifficulty(rawText) {
  if (typeof rawText !== 'string' || !rawText) return null;

  const withoutUrls = rawText.replace(/https?:\/\/\S+/gi, ' ');

  const labeledMatch = /\bdifficulty\s*[:=\-]?\s*([A-Za-z][A-Za-z -]{0,28}?)(?=$|[\r\n,.;)!])/i.exec(
    withoutUrls
  );
  if (labeledMatch) {
    return normalizeDifficultyLabel(labeledMatch[1]);
  }

  const canonicalParen = /\(\s*(Easy|Medium|Tricky|Hard|Brutal)\s*\)/i.exec(withoutUrls);
  if (canonicalParen) {
    return normalizeDifficultyLabel(canonicalParen[1]);
  }

  // Fallback for custom parenthesized difficulty in header line (e.g. "(Expert)")
  const headerParen =
    /(?:clues\s*by\s*sam|#cluesbysam|(?:19|20)\d{2})[^()\r\n]{0,40}\(\s*([A-Za-z][A-Za-z -]{1,24})\s*\)/i.exec(
      withoutUrls
    );
  if (headerParen) {
    const candidate = headerParen[1].trim();
    if (!/^(?:am|pm|utc|est|edt|pst|pdt|ist)$/i.test(candidate)) {
      return normalizeDifficultyLabel(candidate);
    }
  }

  return null;
}

function extractSolveSeconds(rawText) {
  if (typeof rawText !== 'string' || !rawText) return null;

  const scanText = rawText
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, ' ')
    .replace(/\b\d{1,4}\/\d{1,2}\/\d{2,4}\b/g, ' ')
    .replace(new RegExp(MONTH_FIRST_DATE_REGEX.source, 'gi'), ' ')
    .replace(new RegExp(DAY_FIRST_DATE_REGEX.source, 'gi'), ' ')
    .replace(/(^|[\s(])#\d[\d,]*/gm, '$1 ');

  const colonRegex = /(?:^|[^\d:])(\d{1,3}:[0-5]\d(?::[0-5]\d)?)(?!\s*(?:am|pm)\b)(?=$|[^\d:])/gi;
  let match;
  while ((match = colonRegex.exec(scanText)) !== null) {
    const sec = parseDurationSeconds(match[1]);
    if (sec !== null) return sec;
  }

  const unitRegex =
    /\b(?!(?:19|20)\d{2}s\b)(\d+\s*(?:h|hr|hrs|hour|hours)\s*(?:\d+\s*(?:m|min|mins|minute|minutes)\s*)?(?:\d+\s*(?:s|sec|secs|second|seconds))?|\d+\s*(?:m|min|mins|minute|minutes)\s*(?:\d+\s*(?:s|sec|secs|second|seconds))?|\d+\s*(?:s|sec|secs|second|seconds))\b/gi;
  while ((match = unitRegex.exec(scanText)) !== null) {
    const sec = parseDurationSeconds(match[1]);
    if (sec !== null) return sec;
  }

  return null;
}

/**
 * Analyze a Clues by Sam emoji grid into weighted accuracy & hint tile metrics.
 * Returns null if emojiGrid is empty.
 */
export function analyzeCluesBySamGrid(emojiGrid) {
  if (typeof emojiGrid !== 'string' || !emojiGrid.trim()) return null;
  const rows = emojiGrid
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (rows.length === 0) return null;

  const normalizedGrid = rows.join('\n');
  let gridCols = 0;
  let greenCount = 0;
  let yellowCount = 0;
  let singleHintCount = 0;
  let doubleHintCount = 0;

  for (const row of rows) {
    const tiles = Array.from(row.replace(/[\uFE0F\u200D\s]/g, ''));
    if (tiles.length > gridCols) {
      gridCols = tiles.length;
    }
    for (const tile of tiles) {
      if (tile === '🟩') {
        greenCount += 1;
      } else if (tile === '🟨') {
        yellowCount += 1;
      } else if (tile === '🟡' || LEGACY_SINGLE_HINT_TILES.has(tile)) {
        singleHintCount += 1;
      } else if (tile === '🟠' || LEGACY_DOUBLE_HINT_TILES.has(tile)) {
        doubleHintCount += 1;
      }
    }
  }

  const hintCount = singleHintCount + doubleHintCount;
  const totalHintWeight = singleHintCount + 2 * doubleHintCount;
  const totalTiles = greenCount + yellowCount + singleHintCount + doubleHintCount;
  const accuracyPenalty = yellowCount + 2 * singleHintCount + 3 * doubleHintCount;
  const isPerfect = totalTiles > 0 && accuracyPenalty === 0;

  let accuracySummary = null;
  if (totalTiles > 0) {
    if (isPerfect) {
      accuracySummary = `${greenCount}/${totalTiles} 🟩`;
    } else {
      accuracySummary = [
        greenCount && `${greenCount}🟩`,
        yellowCount && `${yellowCount}🟨`,
        singleHintCount && `${singleHintCount}🟡`,
        doubleHintCount && `${doubleHintCount}🟠`,
      ]
        .filter(Boolean)
        .join(' ');
    }
  }

  return {
    emojiGrid: normalizedGrid,
    grid: normalizedGrid,
    gridRows: rows.length,
    gridCols,
    cleanCount: greenCount,
    greenCount,
    yellowCount,
    mistakeCount: yellowCount,
    singleHintCount,
    doubleHintCount,
    hintCount,
    totalHintWeight,
    totalTiles,
    accuracyPenalty,
    isPerfect,
    accuracySummary,
  };
}

export const cluesBySamParser = {
  id: 'cluesbysam',
  name: 'Clues by Sam',
  version: 3,
  isCustomParser: true,
  supportedSlugs: ['cluesbysam', 'clues-by-sam'],
  supportedDomains: ['cluesbysam.com'],

  canParse(rawText) {
    if (typeof rawText !== 'string') return false;
    return /cluesbysam\.com\b|#cluesbysam\b|\bclues\s+by\s+sam\b/i.test(rawText);
  },

  parse(rawText, _gameContext = {}) {
    const text = typeof rawText === 'string' ? rawText : '';

    const puzzleId = extractPuzzleId(text);
    const puzzleDate = extractCluesBySamDate(text);
    const difficulty = extractDifficulty(text);
    const seconds = extractSolveSeconds(text);
    const emojiGrid = extractEmojiGrid(text);
    const gridStats = analyzeCluesBySamGrid(emojiGrid);

    const isDnf = /\b(dnf|failed|did not finish|game over|unsolved|gave up)\b/i.test(text);
    let solved = null;
    if (isDnf) {
      solved = false;
    } else if (seconds !== null || /\bsolved\b/i.test(text)) {
      solved = true;
    }

    const displayValue =
      seconds !== null
        ? formatDurationSeconds(seconds)
        : solved === false
          ? 'DNF'
          : 'Played';

    const metadata = {
      difficulty: difficulty ?? null,
    };
    if (seconds !== null) {
      metadata.seconds = seconds;
    }
    if (gridStats) {
      Object.assign(metadata, gridStats);
    }

    return {
      parserId: 'cluesbysam',
      parserVersion: 3,
      isCustomParser: true,
      completed: true,
      solved,
      primaryValue: seconds,
      displayValue,
      metricFormat: 'duration_sec',
      metricDirection: 'lower_is_better',
      metricLabel: 'Solve Time',
      puzzleId,
      puzzleDate,
      breakdown: [],
      metadata,
    };
  },
};

export default cluesBySamParser;
