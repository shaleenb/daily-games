import { extractEmojiGrid, extractExplicitDate, extractPuzzleId } from '../utils.js';

const PLAIN_CAN_PARSE_URL_REGEX = /\bplayplain\.app\b/i;
const PLAIN_HEADER_REGEX = /\bplain\s+#?(\d[\d,]*)/i;
const PLAIN_SIGNAL_REGEX = /(?:✈️|\baltitude\b|\d[\d,]*(?:\.\d+)?\s*(?:m|meters?|ft|feet)\b)/i;

function parseCleanNumber(token) {
  if (!token) return null;
  const num = Number(String(token).replace(/,/g, ''));
  return Number.isFinite(num) ? num : null;
}

function normalizeAltitudeUnit(rawUnit) {
  if (!rawUnit || typeof rawUnit !== 'string') return null;
  const u = rawUnit.trim().toLowerCase();
  if (u === 'm' || u === 'meter' || u === 'meters') return 'm';
  if (u === 'ft' || u === 'foot' || u === 'feet') return 'ft';
  return null;
}

function formatAltitudeDisplay(value, unit) {
  const formatted = Number.isInteger(value)
    ? value.toLocaleString('en-US')
    : Number(value.toFixed(2)).toLocaleString('en-US');
  return unit ? `${formatted} ${unit}` : formatted;
}

function extractRoundBreakdown(scanText) {
  const breakdown = [];
  const lineRegex = /^(?:round|leg|flight|stage)\s*(\d+)\s*[:=\-–—]?\s*(\d[\d,]*(?:\.\d+)?)\s*(m|meters?|ft|feet)?\b/gim;
  let match;
  while ((match = lineRegex.exec(scanText)) !== null) {
    const roundNum = Number(match[1]);
    const val = parseCleanNumber(match[2]);
    const unit = normalizeAltitudeUnit(match[3]);
    if (val !== null) {
      breakdown.push({
        label: `Round ${roundNum}`,
        value: val,
        display: formatAltitudeDisplay(val, unit),
      });
    }
  }
  return breakdown;
}

export const plainParser = {
  id: 'plain',
  name: 'Plain',
  version: 1,
  isCustomParser: true,
  supportedSlugs: ['plain', 'playplain'],
  supportedDomains: ['playplain.app'],

  canParse(rawText) {
    if (typeof rawText !== 'string') return false;
    if (PLAIN_CAN_PARSE_URL_REGEX.test(rawText)) return true;
    return PLAIN_HEADER_REGEX.test(rawText) && PLAIN_SIGNAL_REGEX.test(rawText);
  },

  parse(rawText, _gameContext = {}) {
    const text = typeof rawText === 'string' ? rawText : '';

    let puzzleId = extractPuzzleId(text);
    if (!puzzleId) {
      const headerMatch = PLAIN_HEADER_REGEX.exec(text);
      if (headerMatch) {
        puzzleId = `#${headerMatch[1].replace(/,/g, '')}`;
      }
    }

    const puzzleDate = extractExplicitDate(text);
    const emojiGrid = extractEmojiGrid(text);

    const scanText = text
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, ' ')
      .replace(/\b\d{1,4}\/\d{1,2}\/\d{2,4}\b/g, ' ')
      .replace(/\bplain\s+#?\d[\d,]*/gi, ' ')
      .replace(/(^|[\s(])#\d[\d,]*/gm, '$1 ');

    const breakdown = extractRoundBreakdown(scanText);

    // Strip round lines before extracting total/headline altitude so round values don't shadow Altitude:
    const nonRoundScan = scanText.replace(
      /^(?:round|leg|flight|stage)\s*\d+\s*[:=\-–—]?.*$/gim,
      ' '
    );

    let primaryValue = null;
    let unit = null;

    // 1. Explicit "Altitude: 6,420m" / "Altitude: 6420 ft"
    const labeledMatch = /\baltitude\s*[:=\-]?\s*(\d[\d,]*(?:\.\d+)?)\s*(m|meters?|ft|feet)?\b/i.exec(
      nonRoundScan
    );
    if (labeledMatch) {
      primaryValue = parseCleanNumber(labeledMatch[1]);
      unit = normalizeAltitudeUnit(labeledMatch[2]);
    }

    // 2. Unit-tagged altitude like "8,150 m" or "6,420m" (NEVER parsed as minutes/duration)
    if (primaryValue === null) {
      const unitMatch = /(?<![\d.:#])\b(\d[\d,]*(?:\.\d+)?)\s*(m|meters?|ft|feet)\b/i.exec(
        nonRoundScan
      );
      if (unitMatch) {
        primaryValue = parseCleanNumber(unitMatch[1]);
        unit = normalizeAltitudeUnit(unitMatch[2]);
      }
    }

    // 3. Fallback standalone number if present
    if (primaryValue === null) {
      const stripped = nonRoundScan
        .replace(/\b(?:puzzle|game|day|round|streak|no\.?)[ \t#:.-]*\d[\d,]*/gi, ' ')
        .replace(/\b\d+(?:st|nd|rd|th)\b/gi, ' ');
      const numMatch = /(?<![\d.:#])\b(\d[\d,]*(?:\.\d+)?)\b/.exec(stripped);
      if (numMatch) {
        primaryValue = parseCleanNumber(numMatch[1]);
      }
    }

    const isDnf = /\b(dnf|failed|crashed|did not finish|game over)\b/i.test(text);
    const solved = isDnf ? false : null;

    const displayValue =
      primaryValue !== null
        ? formatAltitudeDisplay(primaryValue, unit)
        : solved === false
          ? 'DNF'
          : 'Played';

    const metadata = {};
    if (unit) {
      metadata.unit = unit;
    }
    if (emojiGrid) {
      metadata.emojiGrid = emojiGrid;
    }

    return {
      parserId: 'plain',
      parserVersion: 1,
      isCustomParser: true,
      completed: true,
      solved,
      primaryValue,
      displayValue,
      metricFormat: 'number',
      metricDirection: 'higher_is_better',
      metricLabel: 'Altitude',
      puzzleId,
      puzzleDate,
      breakdown,
      metadata,
    };
  },
};

export default plainParser;
