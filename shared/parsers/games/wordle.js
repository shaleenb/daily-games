import { extractEmojiGrid, extractExplicitDate } from '../utils.js';

const WORDLE_HEADER_REGEX = /\bWordle\s+#?([\d,]+)\s+([1-6Xx])\/6(\*)?/i;
const WORDLE_FALLBACK_SCORE_REGEX = /\b([1-6Xx])\/6(\*)?/;
const WORDLE_TILE_REGEX = /[\u2B1B\u2B1C\u{1F7E6}\u{1F7E7}\u{1F7E8}\u{1F7E9}]/gu;
const EXACT_TILES = new Set(['🟩', '🟧']);
const PRESENT_TILES = new Set(['🟨', '🟦']);

function extractWordleGrid(rawText) {
  const lines = rawText.split(/\r?\n/);
  const rows = [];

  for (const rawLine of lines) {
    const cleaned = rawLine.replace(/\uFE0F/g, '').trim();
    if (!cleaned) continue;
    const tiles = cleaned.match(WORDLE_TILE_REGEX);
    if (!tiles || tiles.length < 4) continue;

    // Ensure the line contains only Wordle tiles and optional whitespace
    const remainder = cleaned.replace(WORDLE_TILE_REGEX, '').replace(/\s+/g, '');
    if (remainder.length === 0) {
      rows.push({ line: rawLine.trim(), tiles });
    }
  }

  return rows;
}

export const wordleParser = {
  id: 'wordle',
  name: 'Wordle',
  version: 1,
  isCustomParser: true,
  supportedSlugs: ['wordle'],
  supportedDomains: ['nytimes.com'],

  canParse(rawText) {
    if (typeof rawText !== 'string') return false;
    return WORDLE_HEADER_REGEX.test(rawText);
  },

  parse(rawText, _gameContext = {}) {
    const text = typeof rawText === 'string' ? rawText : '';
    const headerMatch = WORDLE_HEADER_REGEX.exec(text);

    let puzzleId = null;
    let solved = null;
    let primaryValue = null;
    let displayValue = 'Played';
    let hardMode = false;

    if (headerMatch) {
      puzzleId = `#${headerMatch[1].replace(/,/g, '')}`;
      const scoreToken = headerMatch[2].toUpperCase();
      hardMode = Boolean(headerMatch[3]);

      if (scoreToken === 'X') {
        solved = false;
        primaryValue = null;
        displayValue = 'X/6';
      } else {
        const guesses = Number(scoreToken);
        solved = true;
        primaryValue = guesses;
        displayValue = `${guesses}/6`;
      }
    } else {
      const fallbackMatch = WORDLE_FALLBACK_SCORE_REGEX.exec(text);
      if (fallbackMatch) {
        const scoreToken = fallbackMatch[1].toUpperCase();
        hardMode = Boolean(fallbackMatch[2]);
        if (scoreToken === 'X') {
          solved = false;
          primaryValue = null;
          displayValue = 'X/6';
        } else {
          const guesses = Number(scoreToken);
          solved = true;
          primaryValue = guesses;
          displayValue = `${guesses}/6`;
        }
      }
    }

    const gridRows = extractWordleGrid(text);
    const emojiGrid =
      gridRows.length > 0
        ? gridRows.map((row) => row.line).join('\n')
        : extractEmojiGrid(text);

    const breakdown = gridRows.map((row, index) => {
      let exactCount = 0;
      let presentCount = 0;
      for (const tile of row.tiles) {
        if (EXACT_TILES.has(tile)) exactCount += 1;
        else if (PRESENT_TILES.has(tile)) presentCount += 1;
      }
      return {
        label: `Guess ${index + 1}`,
        value: exactCount,
        max: row.tiles.length,
        display: `${exactCount} exact, ${presentCount} present`,
      };
    });

    const metadata = {
      hardMode,
      maxGuesses: 6,
    };
    if (emojiGrid) {
      metadata.emojiGrid = emojiGrid;
    }
    if (gridRows.length > 0) {
      metadata.guessRows = gridRows.length;
    }

    return {
      parserId: 'wordle',
      parserVersion: 1,
      isCustomParser: true,
      completed: true,
      solved,
      primaryValue,
      displayValue,
      metricFormat: 'fraction',
      metricDirection: 'lower_is_better',
      metricLabel: 'Guesses',
      puzzleId,
      puzzleDate: extractExplicitDate(text),
      breakdown,
      metadata,
    };
  },
};

export default wordleParser;
