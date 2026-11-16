import { extractEmojiGrid, extractExplicitDate, extractPuzzleId } from '../utils.js';

const PASSPORTQ_NAME_REGEX = /\bpassportq\b/i;
const PASSPORTQ_DOMAIN_REGEX = /\bpassportq\.app\b/i;
const FLIGHTQ_PASSPORTQ_PATH_REGEX = /\bflightq\.app\/passportq\b/i;
const FLIGHTQ_SHARE_PATH_REGEX = /\bflightq\.app\/sp\//i;
const PQ_REF_REGEX = /[?&]ref=pq\b/i;
const PQ_PHRASE_REGEX = /Solved in \d+\/5|stumped me/i;

const PURE_SQUARE_LINE_REGEX = /^[🟩🟨⬛⬜🟦🟧🟥🟪🟫\uFE0F\s]+$/u;
const HAS_SQUARE_TILE_REGEX = /[🟩🟨⬛⬜🟦🟧🟥🟪🟫]/u;

function extractPassportQPuzzleId(text) {
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

export const passportqParser = {
  id: 'passportq',
  name: 'PassportQ',
  version: 1,
  isCustomParser: true,
  supportedSlugs: ['passportq'],
  supportedDomains: ['passportq.app'],

  canParse(rawText) {
    if (typeof rawText !== 'string') return false;
    if (
      PASSPORTQ_NAME_REGEX.test(rawText) ||
      PASSPORTQ_DOMAIN_REGEX.test(rawText) ||
      FLIGHTQ_PASSPORTQ_PATH_REGEX.test(rawText)
    ) {
      return true;
    }
    return (
      FLIGHTQ_SHARE_PATH_REGEX.test(rawText) &&
      (PQ_REF_REGEX.test(rawText) || PQ_PHRASE_REGEX.test(rawText))
    );
  },

  detectGameSlug() {
    return 'passportq';
  },

  parse(rawText, _gameContext = {}) {
    const text = typeof rawText === 'string' ? rawText : '';

    const puzzleId = extractPassportQPuzzleId(text);
    const puzzleDate = extractExplicitDate(text);
    const emojiGrid = extractSquareEmojiGrid(text);

    const scanText = text
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, ' ')
      .replace(/\b\d{1,4}\/\d{1,2}\/\d{2,4}\b/g, ' ')
      .replace(/(^|[\s(])#\d[\d,]*/gm, '$1 ')
      .replace(/\b(?:no\.?|puzzle|day)[ \t]*\d[\d,]*/gi, ' ');

    let solved = null;
    let primaryValue = null;
    let displayValue = 'Played';
    let maxGuesses = 5;

    const failMatch = /\bX\s*\/\s*(\d+)\b/i.exec(scanText);
    if (failMatch || /\b(?:stumped me|missed it|dnf|failed|game over)\b/i.test(scanText)) {
      solved = false;
      primaryValue = null;
      if (failMatch && Number(failMatch[1]) > 0) {
        maxGuesses = Number(failMatch[1]);
      }
      displayValue = `X/${maxGuesses}`;
    } else {
      const solvedInMatch =
        /\b(?:solved|got it|guessed|finished)[ \t]+in[ \t]+(\d+)\s*\/\s*(\d+)\b/i.exec(scanText);
      const frac5Match = solvedInMatch || /\b(\d+)\s*\/\s*(5)\b/.exec(scanText);
      if (frac5Match) {
        const guesses = Number(frac5Match[1]);
        const max = Number(frac5Match[2]) || 5;
        if (Number.isFinite(guesses) && max > 0) {
          solved = true;
          primaryValue = guesses;
          maxGuesses = max;
          displayValue = `${guesses}/${max}`;
        }
      }
    }

    const metadata = {
      maxGuesses,
    };
    if (emojiGrid) {
      metadata.emojiGrid = emojiGrid;
    }

    return {
      parserId: 'passportq',
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
      puzzleDate,
      breakdown: [],
      metadata,
    };
  },
};

export default passportqParser;
