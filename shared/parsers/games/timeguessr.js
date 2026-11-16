import { extractEmojiGrid, extractExplicitDate, extractPuzzleId } from '../utils.js';

const TIMEGUESSR_URL_REGEX = /\btimeguessr\.com\b/i;
const TIMEGUESSR_HEADER_REGEX = /\btimeguessr\s+#?(\d[\d,]*)(?![\d,])/i;
const ROUND_SCORE_REGEX =
  /^(?:round\s*(\d+)(?![\d,])|([1-9])\uFE0F?\u20E3)(?:[ \t]*[:=\-–—][ \t]*|[ \t]+)(\d[\d,]*)(?:[ \t]*\/[ \t]*(\d[\d,]*))?/gim;

function parseCleanInt(token) {
  if (!token) return null;
  const num = Number(String(token).replace(/,/g, ''));
  return Number.isFinite(num) ? num : null;
}

function formatScoreNumber(num) {
  return Number.isInteger(num)
    ? num.toLocaleString('en-US')
    : Number(num.toFixed(2)).toLocaleString('en-US');
}

function formatTimeguessrDisplay(score, maxScore = null) {
  if (maxScore !== null && maxScore > 0) {
    return `${formatScoreNumber(score)} / ${formatScoreNumber(maxScore)}`;
  }
  return formatScoreNumber(score);
}

function extractTimeguessrEmojiSummary(rawText) {
  const direct = extractEmojiGrid(rawText);
  if (direct) return direct;

  const lines = rawText.split(/\r?\n/);
  const emojiLines = [];
  for (const rawLine of lines) {
    if (!/[🌎🌍🌏📅🟩🟨⬛⬜🟥🟧🟦]/u.test(rawLine)) continue;
    const stripped = rawLine
      .replace(/^(?:round\s*\d+|[1-9]\uFE0F?\u20E3)\s*[:=\-–—]?\s*/i, '')
      .trim();
    const tiles = stripped.match(/[\p{Extended_Pictographic}\u2B1B\u2B1C]/gu);
    if (tiles && tiles.length >= 3) {
      emojiLines.push(stripped);
    }
  }
  return emojiLines.join('\n');
}

function extractRoundBreakdown(rawText) {
  const breakdown = [];
  let match;
  ROUND_SCORE_REGEX.lastIndex = 0;
  while ((match = ROUND_SCORE_REGEX.exec(rawText)) !== null) {
    const roundNum = Number(match[1] || match[2]);
    const score = parseCleanInt(match[3]);
    const max = match[4] ? parseCleanInt(match[4]) : null;
    if (score !== null) {
      breakdown.push({
        label: `Round ${roundNum}`,
        value: score,
        max: max ?? 10000,
        display: formatTimeguessrDisplay(score, max),
      });
    }
  }
  return breakdown;
}

export const timeguessrParser = {
  id: 'timeguessr',
  name: 'TimeGuessr',
  version: 1,
  isCustomParser: true,
  supportedSlugs: ['timeguessr'],
  supportedDomains: ['timeguessr.com'],

  canParse(rawText) {
    if (typeof rawText !== 'string') return false;
    return TIMEGUESSR_URL_REGEX.test(rawText) || TIMEGUESSR_HEADER_REGEX.test(rawText);
  },

  parse(rawText, _gameContext = {}) {
    const text = typeof rawText === 'string' ? rawText : '';

    let puzzleId = extractPuzzleId(text);
    if (!puzzleId) {
      const headerIdMatch = TIMEGUESSR_HEADER_REGEX.exec(text);
      if (headerIdMatch) {
        puzzleId = `#${headerIdMatch[1].replace(/,/g, '')}`;
      }
    }

    const puzzleDate = extractExplicitDate(text);
    const emojiGrid = extractTimeguessrEmojiSummary(text);
    const breakdown = extractRoundBreakdown(text);

    let primaryValue = null;
    let maxScore = null;

    const textWithoutUrlsAndDates = text
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, ' ')
      .replace(/\b\d{1,4}\/\d{1,2}\/\d{2,4}\b/g, ' ');

    // 1. Inline header total: "TimeGuessr #542 42,150/50,000" or "TimeGuessr #542 — 42,150 / 50,000"
    const inlineHeaderMatch =
      /\btimeguessr\s+#?\d[\d,]*(?![\d,])(?:[ \t]*[—–\-:|•][ \t]*|[ \t]+)(\d[\d,]*)(?:[ \t]*\/[ \t]*(\d[\d,]*))?/i.exec(
        textWithoutUrlsAndDates
      );
    if (inlineHeaderMatch) {
      primaryValue = parseCleanInt(inlineHeaderMatch[1]);
      if (inlineHeaderMatch[2]) {
        maxScore = parseCleanInt(inlineHeaderMatch[2]);
      }
    }

    // 2. Scan remaining non-round lines if header did not include total score
    if (primaryValue === null) {
      const nonRoundText = text
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, ' ')
        .replace(/\b\d{1,4}\/\d{1,2}\/\d{2,4}\b/g, ' ')
        .replace(/\btimeguessr\s+#?\d[\d,]*/gi, ' ')
        .replace(ROUND_SCORE_REGEX, ' ')
        .replace(/(^|[\s(])#\d[\d,]*/gm, '$1 ');

      const ratioMatch = /\b(\d[\d,]*)\s*\/\s*(\d[\d,]*)\b/.exec(nonRoundText);
      if (ratioMatch) {
        primaryValue = parseCleanInt(ratioMatch[1]);
        maxScore = parseCleanInt(ratioMatch[2]);
      } else {
        const labeledMatch = /\b(?:score|total|points|pts)\s*[:=\-]?\s*(\d[\d,]*)\b/i.exec(
          nonRoundText
        );
        if (labeledMatch) {
          primaryValue = parseCleanInt(labeledMatch[1]);
        } else {
          const standalone = /(?<![\d.:#])\b(\d[\d,]*)\b/.exec(nonRoundText);
          if (standalone) {
            primaryValue = parseCleanInt(standalone[1]);
          }
        }
      }
    }

    // 3. Fallback: sum round scores if only per-round scores were pasted
    if (primaryValue === null && breakdown.length > 0) {
      primaryValue = breakdown.reduce((sum, r) => sum + r.value, 0);
      const totalMax = breakdown.reduce((sum, r) => sum + (r.max || 0), 0);
      if (totalMax > 0) {
        maxScore = totalMax;
      }
    }

    const isDnf = /\b(dnf|failed|did not finish|game over)\b/i.test(text);
    const solved = isDnf ? false : null;

    const displayValue =
      primaryValue !== null
        ? formatTimeguessrDisplay(primaryValue, maxScore)
        : solved === false
          ? 'DNF'
          : 'Played';

    const metadata = {};
    if (maxScore !== null && maxScore > 0) {
      metadata.maxScore = maxScore;
    }
    if (emojiGrid) {
      metadata.emojiGrid = emojiGrid;
    }
    if (breakdown.length > 0) {
      metadata.breakdown = breakdown;
    }

    return {
      parserId: 'timeguessr',
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

export default timeguessrParser;
