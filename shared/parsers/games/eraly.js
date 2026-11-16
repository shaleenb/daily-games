import { extractEmojiGrid, extractExplicitDate, extractPuzzleId } from '../utils.js';

export const ERALY_BANDS = {
  '🟨': { emoji: '🟨', pts: 100, label: 'Timekeeper' },
  '🟦': { emoji: '🟦', pts: 85, label: 'Chronicler' },
  '🟩': { emoji: '🟩', pts: 60, label: 'Historian' },
  '🟧': { emoji: '🟧', pts: 30, label: 'Explorer' },
  '🟥': { emoji: '🟥', pts: 10, label: 'Tourist' },
  '💤': { emoji: '💤', pts: 0, label: 'Lost in time' },
};

const ERALY_DOMAIN_REGEX = /\beraly\.io\b/i;
const ERALY_HEADER_REGEX = /\beraly(?:\s*\(archive\))?\s+#?(\d[\d,]*)(?![\d,])/i;
const ERALY_TRAVEL_REGEX = /\bI\s+travell?ed\s+to\s+(\d[\d,]*(?:\s*(?:BCE|BC|AD|CE)\b)?)/i;
const ERALY_PROGRESS_BAR_REGEX = /[▰▱]{5,}/;
const BAND_EMOJI_REGEX = /[🟨🟦🟩🟧🟥💤]/gu;

function parseCleanInt(token) {
  if (!token) return null;
  const num = Number(String(token).replace(/,/g, ''));
  return Number.isFinite(num) ? num : null;
}

function extractBandRow(rawText) {
  const lines = rawText.split(/\r?\n/);
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || /https?:\/\//i.test(trimmed)) continue;
    const matches = trimmed.match(BAND_EMOJI_REGEX);
    if (!matches || matches.length === 0) continue;
    const remainder = trimmed.replace(BAND_EMOJI_REGEX, '').replace(/\s+/g, '');
    if (remainder.length === 0) {
      return { line: trimmed, emojis: matches };
    }
  }
  return { line: '', emojis: [] };
}

function extractProgressBarLine(rawText) {
  const lines = rawText.split(/\r?\n/);
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (/[▰▱]{3,}/.test(trimmed)) {
      return trimmed;
    }
  }
  return '';
}

export const eralyParser = {
  id: 'eraly',
  name: 'Eraly',
  version: 1,
  isCustomParser: true,
  supportedSlugs: ['eraly'],
  supportedDomains: ['eraly.io'],

  canParse(rawText) {
    if (typeof rawText !== 'string') return false;
    if (ERALY_DOMAIN_REGEX.test(rawText) || ERALY_HEADER_REGEX.test(rawText)) {
      return true;
    }
    return ERALY_TRAVEL_REGEX.test(rawText) && ERALY_PROGRESS_BAR_REGEX.test(rawText);
  },

  parse(rawText, _gameContext = {}) {
    const text = typeof rawText === 'string' ? rawText : '';

    let puzzleId = null;
    const headerMatch = ERALY_HEADER_REGEX.exec(text);
    if (headerMatch) {
      puzzleId = `#${headerMatch[1].replace(/,/g, '')}`;
    } else {
      puzzleId = extractPuzzleId(text);
    }

    const puzzleDate = extractExplicitDate(text);
    const isArchive = /\(\s*archive\s*\)/i.test(text);
    const travelMatch = ERALY_TRAVEL_REGEX.exec(text);
    const yearReached = travelMatch ? travelMatch[1].replace(/\s+/g, ' ').trim() : null;

    const progressLine = extractProgressBarLine(text);
    const { line: bandLine, emojis: bandEmojis } = extractBandRow(text);

    const breakdown = [];
    const roundScores = {};
    const bands = [];

    for (let i = 0; i < bandEmojis.length; i += 1) {
      const emoji = bandEmojis[i];
      const band = ERALY_BANDS[emoji];
      if (!band) continue;
      const key = `q${i + 1}`;
      const name = `Q${i + 1}`;
      roundScores[key] = band.pts;
      bands.push(band.label);
      breakdown.push({
        key,
        icon: emoji,
        name,
        label: `${name} ${emoji}`,
        value: band.pts,
        max: 100,
        display: String(band.pts),
      });
    }

    const scanText = text
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, ' ')
      .replace(/\b\d{1,4}\/\d{1,2}\/\d{2,4}\b/g, ' ')
      .replace(ERALY_HEADER_REGEX, ' ')
      .replace(ERALY_TRAVEL_REGEX, ' ')
      .replace(/(^|[\s(])#\d[\d,]*/gm, '$1 ');

    let primaryValue = null;
    let maxScore = null;

    const ratioMatch = /\b(\d[\d,]*)\s*\/\s*(\d[\d,]*)\b/.exec(scanText);
    if (ratioMatch) {
      primaryValue = parseCleanInt(ratioMatch[1]);
      maxScore = parseCleanInt(ratioMatch[2]);
    } else {
      const labeledMatch =
        /\b(?:score|total|points|pts)\s*[:=\-]?\s*(\d[\d,]*)(?:\s*\/\s*(\d[\d,]*))?\b/i.exec(
          scanText
        );
      if (labeledMatch) {
        primaryValue = parseCleanInt(labeledMatch[1]);
        if (labeledMatch[2]) {
          maxScore = parseCleanInt(labeledMatch[2]);
        }
      }
    }

    if (primaryValue === null && breakdown.length > 0) {
      primaryValue = breakdown.reduce((sum, item) => sum + item.value, 0);
      maxScore = breakdown.length * 100;
    } else if (primaryValue !== null && maxScore === null && breakdown.length === 7) {
      maxScore = 700;
    }

    const isDnf = /\b(dnf|failed|did not finish|game over)\b/i.test(text);
    const solved = isDnf ? false : null;

    let displayValue = 'Played';
    if (primaryValue !== null) {
      displayValue =
        maxScore !== null && maxScore > 0 ? `${primaryValue}/${maxScore}` : String(primaryValue);
    } else if (solved === false) {
      displayValue = 'DNF';
    }

    const gridParts = [];
    if (progressLine) gridParts.push(progressLine);
    if (bandLine) gridParts.push(bandLine);
    const emojiGrid = gridParts.length > 0 ? gridParts.join('\n') : extractEmojiGrid(text);

    const metadata = {};
    if (maxScore !== null && maxScore > 0) {
      metadata.maxScore = maxScore;
    }
    if (yearReached) {
      metadata.yearReached = yearReached;
    }
    if (isArchive) {
      metadata.archive = true;
    }
    if (Object.keys(roundScores).length > 0) {
      metadata.roundScores = roundScores;
      metadata.bands = bands;
    }
    if (emojiGrid) {
      metadata.emojiGrid = emojiGrid;
    }

    return {
      parserId: 'eraly',
      parserVersion: 1,
      isCustomParser: true,
      completed: true,
      solved,
      primaryValue,
      displayValue,
      metricFormat: 'number',
      metricDirection: 'higher_is_better',
      metricLabel: 'Score',
      puzzleId,
      puzzleDate,
      breakdown,
      metadata,
    };
  },
};

export default eralyParser;
