import {
  extractEmojiGrid,
  extractExplicitDate,
  extractPuzzleId,
  formatDurationSeconds,
  formatMetricValue,
  parseDurationSeconds,
} from './utils.js';

const VALID_FORMATS = new Set(['number', 'duration_sec', 'percent', 'fraction']);

function sanitizeForScoreScan(rawText) {
  return rawText
    // Strip URLs so path numbers or ports are never mistaken for scores
    .replace(/https?:\/\/\S+/gi, ' ')
    // Strip ISO dates (2026-11-15) and slash dates (11/15/2026, 2026/11/15)
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, ' ')
    .replace(/\b\d{1,4}\/\d{1,2}\/\d{2,4}\b/g, ' ')
    // Strip grid dimension tokens like 4x4, 5×5, 4 x 4 so they are never mistaken for multipliers/scores
    .replace(/(?<![.\d])\d+(?:[x×]|\s+[x×]\s+)\d+(?![.\d%x×])/gi, ' ')
    // Strip explicit #puzzleId tokens (#142, #1,234) while preserving preceding whitespace/newlines
    .replace(/(^|[\s(])#\d[\d,]*/gm, '$1 ');
}

function parseCleanNumber(token) {
  if (!token) return null;
  const cleaned = String(token).replace(/,/g, '');
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function tryExtractDuration(scanText) {
  // 1. Colon format: h:mm:ss or m:ss (not preceded by digit: and not followed by AM/PM)
  const colonRegex = /(?:^|[^\d:])(\d{1,3}:[0-5]\d(?::[0-5]\d)?)(?!\s*(?:am|pm)\b)(?=$|[^\d:])/gi;
  let match;
  while ((match = colonRegex.exec(scanText)) !== null) {
    const sec = parseDurationSeconds(match[1]);
    if (sec !== null) {
      return {
        primaryValue: sec,
        displayValue: formatDurationSeconds(sec),
        detectedFormat: 'duration_sec',
      };
    }
  }

  // 2. Unit format: e.g., "1h 2m 3s", "1m 20s", "2 min 10 sec", "45s"
  // Note: guard 4-digit decade strings like "1990s" / "2020s"
  const unitRegex =
    /\b(?!(?:19|20)\d{2}s\b)(\d+\s*(?:h|hr|hrs|hour|hours)\s*(?:\d+\s*(?:m|min|mins|minute|minutes)\s*)?(?:\d+\s*(?:s|sec|secs|second|seconds))?|\d+\s*(?:m|min|mins|minute|minutes)\s*(?:\d+\s*(?:s|sec|secs|second|seconds))?|\d+\s*(?:s|sec|secs|second|seconds))\b/gi;
  while ((match = unitRegex.exec(scanText)) !== null) {
    const sec = parseDurationSeconds(match[1]);
    if (sec !== null) {
      return {
        primaryValue: sec,
        displayValue: formatDurationSeconds(sec),
        detectedFormat: 'duration_sec',
      };
    }
  }

  return null;
}

function tryExtractPercent(scanText) {
  const match = /\b(\d{1,3}(?:\.\d+)?)\s*%/.exec(scanText);
  if (!match) return null;
  const num = parseCleanNumber(match[1]);
  if (num === null) return null;
  return {
    primaryValue: num,
    displayValue: formatMetricValue(num, 'percent'),
    detectedFormat: 'percent',
  };
}

function tryExtractLabeledScore(scanText) {
  // "Score: 840/1000", "Score: 840", "Points: 1,200", "Average: 1.8×"
  // Negative lookahead avoids truncating "Score: 88%" or "Score: 2:14"
  const prefixMatch =
    /\b(?:score|points|pts|total|avg|average|multiplier)\s*[:=\-]?\s*(\d[\d,]*(?:\.\d+)?)(?:\s*\/\s*(\d[\d,]*(?:\.\d+)?))?(?:(?:\s*×|x)(?!\s*\d))?(?!(?:\.\d|\s*(?:%|:\d|\/\d)|[a-z0-9]))/i.exec(
      scanText
    );
  if (prefixMatch) {
    const num = parseCleanNumber(prefixMatch[1]);
    if (num !== null) {
      const den = prefixMatch[2] ? parseCleanNumber(prefixMatch[2]) : null;
      if (den !== null && den > 0) {
        return {
          primaryValue: num,
          displayValue: `${formatMetricValue(num, 'number')}/${formatMetricValue(den, 'number')}`,
          detectedFormat: 'number',
          maxScore: den,
        };
      }
      return {
        primaryValue: num,
        displayValue: formatMetricValue(num, 'number'),
        detectedFormat: 'number',
      };
    }
  }

  // "840 pts", "840 points", "840/1000 pts"
  const suffixMatch =
    /(?<![\d:])\b(\d[\d,]*(?:\.\d+)?)(?:\s*\/\s*(\d[\d,]*(?:\.\d+)?))?\s*(?:pts?|points?)\b/i.exec(scanText);
  if (suffixMatch) {
    const num = parseCleanNumber(suffixMatch[1]);
    if (num !== null) {
      const den = suffixMatch[2] ? parseCleanNumber(suffixMatch[2]) : null;
      if (den !== null && den > 0) {
        return {
          primaryValue: num,
          displayValue: `${formatMetricValue(num, 'number')}/${formatMetricValue(den, 'number')}`,
          detectedFormat: 'number',
          maxScore: den,
        };
      }
      return {
        primaryValue: num,
        displayValue: formatMetricValue(num, 'number'),
        detectedFormat: 'number',
      };
    }
  }

  // "1.30× score", "27.6× score", "840 score"
  const suffixScoreMatch =
    /(?<![a-z0-9.:#])\b(\d[\d,]*(?:\.\d+)?)(?:\s*\/\s*(\d[\d,]*(?:\.\d+)?))?(?:[ \t]*[×x])?[ \t]+score\b/i.exec(
      scanText
    );
  if (suffixScoreMatch) {
    const num = parseCleanNumber(suffixScoreMatch[1]);
    if (num !== null) {
      const den = suffixScoreMatch[2] ? parseCleanNumber(suffixScoreMatch[2]) : null;
      if (den !== null && den > 0) {
        return {
          primaryValue: num,
          displayValue: `${formatMetricValue(num, 'number')}/${formatMetricValue(den, 'number')}`,
          detectedFormat: 'number',
          maxScore: den,
        };
      }
      return {
        primaryValue: num,
        displayValue: formatMetricValue(num, 'number'),
        detectedFormat: 'number',
      };
    }
  }

  return null;
}

function tryExtractMultiplierScore(scanText) {
  // Fermi-style multiplier scores: "1.45×", "2.3x", "Fermi #42 - 1.62×"
  const match =
    /(?<![a-z0-9.:#])(\d[\d,]*(?:\.\d+)?)(?:\s*×|x)(?![a-z0-9]|[ \t]*\d)/i.exec(scanText);
  if (!match) return null;
  const num = parseCleanNumber(match[1]);
  if (num === null) return null;
  return {
    primaryValue: num,
    displayValue: formatMetricValue(num, 'number'),
    detectedFormat: 'number',
  };
}

function tryExtractFraction(scanText) {
  const match = /\b(X|\d[\d,]*(?:\.\d+)?)\s*\/\s*(\d[\d,]*(?:\.\d+)?)\b/i.exec(scanText);
  if (!match) return null;

  const rawNum = match[1].toUpperCase();
  const den = parseCleanNumber(match[2]);
  if (den === null || den <= 0) return null;

  if (rawNum === 'X') {
    return {
      primaryValue: null,
      displayValue: `X/${formatMetricValue(den, 'number')}`,
      detectedFormat: 'fraction',
      solved: false,
      maxScore: den,
    };
  }

  const num = parseCleanNumber(rawNum);
  if (num === null) return null;

  return {
    primaryValue: num,
    displayValue: `${formatMetricValue(num, 'number')}/${formatMetricValue(den, 'number')}`,
    detectedFormat: 'fraction',
    maxScore: den,
  };
}

function tryExtractStandaloneNumber(scanText, contextFormat) {
  // Remove common non-score numeric metadata on the same line before standalone fallback
  const stripped = scanText
    .replace(/\b(?:puzzle|game|day|round|level|streak|edition|no\.?)[ \t#:.-]*\d[\d,]*/gi, ' ')
    .replace(/\b\d+(?:st|nd|rd|th)\b/gi, ' ')
    .replace(/\bv\d+(?:\.\d+)*\b/gi, ' ');

  const match = /(?<![\d.:#])\b(\d[\d,]*(?:\.\d+)?)\b(?![:%/]\d|\s*%)/.exec(stripped);
  if (!match) return null;
  const num = parseCleanNumber(match[1]);
  if (num === null) return null;

  if (contextFormat === 'percent') {
    return {
      primaryValue: num,
      displayValue: formatMetricValue(num, 'percent'),
      detectedFormat: 'percent',
    };
  }

  return {
    primaryValue: num,
    displayValue: formatMetricValue(num, 'number'),
    detectedFormat: 'number',
  };
}

function inferSolvedStatus(rawText, extracted) {
  if (extracted && typeof extracted.solved === 'boolean') {
    return extracted.solved;
  }
  if (/\b(dnf|failed|did not finish|game over|better luck next time|unsolved)\b/i.test(rawText)) {
    return false;
  }
  if (/\b(solved|i solved|completed|victory|you won)\b/i.test(rawText)) {
    return true;
  }
  return null;
}

export const GENERIC_PARSER = {
  id: 'generic',
  name: 'Generic (Auto-extract)',
  version: 1,
  isCustomParser: false,
  supportedSlugs: [],
  supportedDomains: [],

  canParse(rawText) {
    return typeof rawText === 'string';
  },

  parse(rawText, gameContext = {}) {
    const text = typeof rawText === 'string' ? rawText : '';
    const hasContextFormat = Boolean(
      gameContext && typeof gameContext.metricFormat === 'string' && VALID_FORMATS.has(gameContext.metricFormat)
    );
    const contextFormat = hasContextFormat ? gameContext.metricFormat : 'number';
    const metricDirection =
      gameContext?.metricDirection === 'lower_is_better' ? 'lower_is_better' : 'higher_is_better';
    const metricLabel =
      typeof gameContext?.metricLabel === 'string' && gameContext.metricLabel.trim()
        ? gameContext.metricLabel.trim()
        : 'Score';

    const puzzleId = extractPuzzleId(text);
    const puzzleDate = extractExplicitDate(text);
    const emojiGrid = extractEmojiGrid(text);
    const scanText = sanitizeForScoreScan(text);

    let extracted = null;

    if (hasContextFormat && contextFormat === 'duration_sec') {
      extracted = tryExtractDuration(scanText);
    } else if (hasContextFormat && contextFormat === 'percent') {
      extracted =
        tryExtractPercent(scanText) ||
        tryExtractLabeledScore(scanText) ||
        tryExtractFraction(scanText) ||
        tryExtractStandaloneNumber(scanText, 'percent');
      if (extracted && extracted.detectedFormat === 'number') {
        extracted.displayValue = formatMetricValue(extracted.primaryValue, 'percent');
      }
    } else if (hasContextFormat && contextFormat === 'fraction') {
      extracted =
        tryExtractFraction(scanText) ||
        tryExtractLabeledScore(scanText) ||
        tryExtractPercent(scanText) ||
        tryExtractStandaloneNumber(scanText, 'fraction');
    } else {
      // 'number' or unspecified format: run priority extractors cleanly
      extracted =
        tryExtractLabeledScore(scanText) ||
        tryExtractMultiplierScore(scanText) ||
        tryExtractDuration(scanText) ||
        tryExtractPercent(scanText) ||
        tryExtractFraction(scanText) ||
        tryExtractStandaloneNumber(scanText, 'number');
    }

    const solved = inferSolvedStatus(text, extracted);
    const primaryValue = extracted ? extracted.primaryValue : null;
    let displayValue = extracted ? extracted.displayValue : 'Played';
    if (!extracted && solved === false) {
      displayValue = 'DNF';
    }

    const metricFormat = hasContextFormat
      ? contextFormat
      : extracted?.detectedFormat || 'number';

    const metadata = {};
    if (emojiGrid) {
      metadata.emojiGrid = emojiGrid;
    }
    if (extracted?.maxScore !== undefined) {
      metadata.maxScore = extracted.maxScore;
    }

    return {
      parserId: 'generic',
      parserVersion: 1,
      isCustomParser: false,
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

export default GENERIC_PARSER;
