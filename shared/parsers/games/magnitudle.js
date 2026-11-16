import { extractEmojiGrid, extractExplicitDate, extractPuzzleId } from '../utils.js';

const MAGNITUDLE_DOMAIN_REGEX = /\bmagnitudle\.com\b/i;
const MAGNITUDLE_NAME_REGEX =
  /\bmagnitudle\b|\bsize\s+it\s+up\b|\bweigh\s+it\s+up\b|\bdaily\s+magnitudle\b/i;
const TILE_SCORE_ROW_REGEX =
  /^\s*((?:[\u{1F7E5}-\u{1F7EB}\u2B1B\u2B1C]\uFE0F?[ \t]*){2,})[ \t]*(\d{1,3}(?:\.\d+)?)\s*$/u;

function parseCleanNumber(token) {
  if (!token) return null;
  const num = Number(String(token).replace(/,/g, ''));
  return Number.isFinite(num) ? num : null;
}

function formatScoreToken(num) {
  return Number.isInteger(num) ? String(num) : String(Number(num.toFixed(2)));
}

function deduplicateRepeatedBlock(rawText) {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length >= 4 && lines.length % 2 === 0) {
    const half = lines.length / 2;
    if (lines.slice(0, half).join('\n') === lines.slice(half).join('\n')) {
      return lines.slice(0, half).join('\n');
    }
  }

  // Handle duplicated block followed by a single trailing URL line
  const urlIndices = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^<?https?:\/\/\S+>?$/i.test(lines[i])) {
      urlIndices.push(i);
    }
  }
  const nonUrlLines = lines.filter((_, idx) => !urlIndices.includes(idx));
  if (nonUrlLines.length >= 4 && nonUrlLines.length % 2 === 0) {
    const half = nonUrlLines.length / 2;
    if (nonUrlLines.slice(0, half).join('\n') === nonUrlLines.slice(half).join('\n')) {
      const firstUrl = urlIndices.length > 0 ? [lines[urlIndices[0]]] : [];
      return [...nonUrlLines.slice(0, half), ...firstUrl].join('\n');
    }
  }

  return lines.join('\n');
}

function deduplicateTileRows(rows) {
  if (rows.length >= 4 && rows.length % 2 === 0) {
    const half = rows.length / 2;
    const firstHalf = rows.slice(0, half).map((r) => r.rawLine).join('\n');
    const secondHalf = rows.slice(half).map((r) => r.rawLine).join('\n');
    if (firstHalf === secondHalf) {
      return rows.slice(0, half);
    }
  }
  return rows;
}

export const magnitudleParser = {
  id: 'magnitudle',
  name: 'Magnitudle',
  version: 2,
  isCustomParser: true,
  supportedSlugs: [
    'magnitudle',
    'size-it-up',
    'sizeitup',
    'weigh-it-up',
    'weighitup',
    'magnitudle-daily',
  ],
  supportedDomains: ['magnitudle.com'],

  canParse(rawText) {
    if (typeof rawText !== 'string') return false;
    return MAGNITUDLE_DOMAIN_REGEX.test(rawText) || MAGNITUDLE_NAME_REGEX.test(rawText);
  },

  detectGameSlug(rawText) {
    if (typeof rawText !== 'string') return null;
    if (/weigh[- ]it[- ]up/i.test(rawText)) return 'weigh-it-up';
    if (/magnitudle\.com\/daily\b|\bdaily\s+(?:magnitudle\s+)?question\b/i.test(rawText)) {
      return 'magnitudle-daily';
    }
    if (/size[- ]it[- ]up/i.test(rawText)) return 'magnitudle';
    return null;
  },

  parse(rawText, _gameContext = {}) {
    const text = typeof rawText === 'string' ? rawText : '';
    const dedupedText = deduplicateRepeatedBlock(text);

    const puzzleId = extractPuzzleId(dedupedText);
    const puzzleDate = extractExplicitDate(dedupedText);

    const lines = dedupedText.split(/\r?\n/);
    const rawTileRows = [];
    const nonRowLines = [];

    for (const line of lines) {
      const trimmed = line.trim();
      const rowMatch = TILE_SCORE_ROW_REGEX.exec(trimmed);
      if (rowMatch) {
        const val = parseCleanNumber(rowMatch[2]);
        if (val !== null) {
          rawTileRows.push({ rawLine: trimmed, value: val });
          continue;
        }
      }
      nonRowLines.push(line);
    }

    const tileRows = deduplicateTileRows(rawTileRows);
    const breakdown = tileRows.map((row, idx) => ({
      key: `r${idx + 1}`,
      label: `Round ${idx + 1}`,
      value: row.value,
      max: 100,
      display: formatScoreToken(row.value),
    }));

    const scanText = nonRowLines
      .join('\n')
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, ' ')
      .replace(/\b\d{1,4}\/\d{1,2}\/\d{2,4}\b/g, ' ')
      .replace(/(^|[\s(])#\d[\d,]*/gm, '$1 ')
      .replace(/\b(?:no\.?|puzzle)[ \t]*\d[\d,]*/gi, ' ');

    let primaryValue = null;
    let maxScore = null;
    let isPercent = false;

    const labeledScore =
      /\b(?:score|total|points|pts|accuracy)\s*[:=\-]?\s*(\d[\d,]*(?:\.\d+)?)(?:\s*\/\s*(\d[\d,]*(?:\.\d+)?))?\b(?!(?:\.\d|\s*(?:%|\/\d)))/i.exec(
        scanText
      );
    if (labeledScore) {
      primaryValue = parseCleanNumber(labeledScore[1]);
      if (labeledScore[2]) {
        maxScore = parseCleanNumber(labeledScore[2]);
      }
    }

    if (primaryValue === null) {
      const ratioMatch = /\b(\d[\d,]*(?:\.\d+)?)\s*\/\s*(\d[\d,]*(?:\.\d+)?)\b/.exec(scanText);
      if (ratioMatch) {
        primaryValue = parseCleanNumber(ratioMatch[1]);
        maxScore = parseCleanNumber(ratioMatch[2]);
      }
    }

    if (primaryValue === null) {
      const pctMatch = /\b(\d{1,3}(?:\.\d+)?)\s*%/.exec(scanText);
      if (pctMatch) {
        primaryValue = parseCleanNumber(pctMatch[1]);
        isPercent = primaryValue !== null;
      }
    }

    if (primaryValue === null) {
      const standalone = /(?<![\d.:#])\b(\d[\d,]*(?:\.\d+)?)\b(?![\s]*%)/.exec(scanText);
      if (standalone) {
        primaryValue = parseCleanNumber(standalone[1]);
      }
    }

    if (primaryValue === null && breakdown.length > 0) {
      primaryValue = breakdown.reduce((sum, item) => sum + item.value, 0);
      maxScore = breakdown.length * 100;
    }

    const isDnf = /\b(dnf|failed|did not finish|game over)\b/i.test(dedupedText);
    const solved = isDnf ? false : null;

    let displayValue = 'Played';
    if (primaryValue !== null) {
      if (isPercent) {
        displayValue = `${formatScoreToken(primaryValue)}%`;
      } else if (maxScore !== null && maxScore > 0) {
        displayValue = `${formatScoreToken(primaryValue)}/${formatScoreToken(maxScore)}`;
      } else {
        displayValue = formatScoreToken(primaryValue);
      }
    } else if (solved === false) {
      displayValue = 'DNF';
    }

    const emojiGrid =
      tileRows.length > 0
        ? tileRows.map((row) => row.rawLine).join('\n')
        : extractEmojiGrid(dedupedText);

    const metadata = {};
    if (maxScore !== null && maxScore > 0) {
      metadata.maxScore = maxScore;
    }
    if (emojiGrid) {
      metadata.emojiGrid = emojiGrid;
    }

    return {
      parserId: 'magnitudle',
      parserVersion: 2,
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

export default magnitudleParser;
