import { extractEmojiGrid, extractExplicitDate, extractPuzzleId } from '../utils.js';

export const PERCEPTLE_ROUNDS = [
  { key: 'count', icon: '🔢', name: 'Count', label: '🔢 Count', max: 100 },
  { key: 'track', icon: '🎯', name: 'Track', label: '🎯 Track', max: 100 },
  { key: 'angle', icon: '📐', name: 'Angle', label: '📐 Angle', max: 100 },
  { key: 'tempo', icon: '🥁', name: 'Tempo', label: '🥁 Tempo', max: 100 },
  { key: 'split', icon: '✂️', name: 'Split', label: '✂️ Split', max: 100 },
];

const ROUND_BY_ICON = new Map(
  PERCEPTLE_ROUNDS.map((round) => [round.icon.replace(/\uFE0F/g, ''), round])
);

const ROUND_BY_NAME = new Map(
  PERCEPTLE_ROUNDS.map((round) => [round.name.toLowerCase(), round])
);

const PERCEPTLE_DOMAIN_REGEX = /\b(?:the)?perceptle\.com\b/i;
const PERCEPTLE_HEADER_ID_REGEX = /\bperceptle\s+#?(\d[\d,]*)(?![\d,])/i;
const CANONICAL_TOKEN_SCAN_REGEX =
  /[🔢🎯📐🥁✂](?:[ \t]+(?:count|track|angle|tempo|split))?[ \t]*[:=\-]?[ \t]*\d{1,3}(?:\.\d+)?/giu;

function formatCleanScore(num) {
  return Number.isInteger(num) ? String(num) : String(Number(num.toFixed(2)));
}

function stripUrlsAndDates(rawText) {
  return rawText
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, ' ')
    .replace(/\b\d{1,4}\/\d{1,2}\/\d{2,4}\b/g, ' ');
}

function extractHeaderGradeAndScore(scanText) {
  // 1. "Perceptle #122 - C (69)", "Perceptle #122: B+ (84)", "Perceptle #122 - S (98)"
  const gradeScoreMatch =
    /\bperceptle\s+#?\d[\d,]*(?![\d,])[ \t]*(?:[-–—:|•][ \t]*)?([A-Za-z][+-]?)[ \t]*\(\s*(\d{1,3}(?:\.\d+)?)\s*\)/i.exec(
      scanText
    );
  if (gradeScoreMatch) {
    return {
      grade: gradeScoreMatch[1].toUpperCase(),
      headerScore: Number(gradeScoreMatch[2]),
      headerSpanEnd: gradeScoreMatch.index + gradeScoreMatch[0].length,
      headerSpanStart: gradeScoreMatch.index,
    };
  }

  // 2. "Perceptle #122 (69)"
  const parenScoreMatch =
    /\bperceptle\s+#?\d[\d,]*(?![\d,])[ \t]*(?:[-–—:|•][ \t]*)?\(\s*(\d{1,3}(?:\.\d+)?)\s*\)/i.exec(
      scanText
    );
  if (parenScoreMatch) {
    return {
      grade: null,
      headerScore: Number(parenScoreMatch[1]),
      headerSpanEnd: parenScoreMatch.index + parenScoreMatch[0].length,
      headerSpanStart: parenScoreMatch.index,
    };
  }

  // 3. Grade-only header: "Perceptle #122 - C"
  const gradeOnlyMatch =
    /\bperceptle\s+#?\d[\d,]*(?![\d,])[ \t]*[-–—:|•][ \t]*([SABCDEF][+-]?)(?=$|[ \t\r\n(])/i.exec(
      scanText
    );
  if (gradeOnlyMatch) {
    return {
      grade: gradeOnlyMatch[1].toUpperCase(),
      headerScore: null,
      headerSpanEnd: gradeOnlyMatch.index + gradeOnlyMatch[0].length,
      headerSpanStart: gradeOnlyMatch.index,
    };
  }

  // 4. Plain header "Perceptle #122" optionally followed by labeled "Score: 69" / "Total: 69"
  const plainHeader = /\bperceptle\s+#?\d[\d,]*(?![\d,])/i.exec(scanText);
  const labeledScore =
    /\b(?:total|overall|final\s+score|score)\s*[:=\-]?\s*(\d{1,3}(?:\.\d+)?)(?:\s*\/\s*100)?(?![\d.%])/i.exec(
      scanText
    );

  return {
    grade: null,
    headerScore: labeledScore ? Number(labeledScore[1]) : null,
    headerSpanStart: plainHeader ? plainHeader.index : -1,
    headerSpanEnd: plainHeader ? plainHeader.index + plainHeader[0].length : -1,
  };
}

function parseRoundsFromBody(bodyText) {
  const breakdown = [];
  const roundScores = {};
  const seenKeys = new Set();

  const lines = bodyText.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // 1. Emoji + optional canonical round name + score tokens
    const emojiTokenRegex =
      /([\p{Extended_Pictographic}\u2702]\uFE0F?)(?:[ \t]+(?:count|track|angle|tempo|split))?[ \t]*[:=\-]?[ \t]*(\d{1,3}(?:\.\d+)?)(?:[ \t]*\/[ \t]*100)?(?![a-z0-9.%])/giu;

    let matchedEmojiOnLine = false;
    const isLikelyNonRoundMeta =
      /\bstreak\b|\bdays?\b/i.test(line) && !/[🔢🎯📐🥁✂]/u.test(line.replace(/\uFE0F/g, ''));

    if (!isLikelyNonRoundMeta) {
      let match;
      while ((match = emojiTokenRegex.exec(line)) !== null) {
        const rawIcon = match[1];
        const normIcon = rawIcon.replace(/\uFE0F/g, '');
        const score = Number(match[2]);
        if (!Number.isFinite(score) || score < 0 || score > 100) {
          continue;
        }

        const canonical = ROUND_BY_ICON.get(normIcon);
        if (canonical) {
          matchedEmojiOnLine = true;
          if (!seenKeys.has(canonical.key)) {
            seenKeys.add(canonical.key);
            roundScores[canonical.key] = score;
            breakdown.push({
              key: canonical.key,
              icon: canonical.icon,
              name: canonical.name,
              label: canonical.label,
              value: score,
              max: canonical.max,
              display: formatCleanScore(score),
            });
          }
        } else {
          matchedEmojiOnLine = true;
          const idx = breakdown.length + 1;
          const key = `round_${idx}`;
          const name = `Round ${idx}`;
          roundScores[key] = score;
          breakdown.push({
            key,
            icon: rawIcon,
            name,
            label: `${rawIcon} ${name}`,
            value: score,
            max: 100,
            display: formatCleanScore(score),
          });
        }
      }
    }

    if (matchedEmojiOnLine) continue;

    // 2. Labeled rounds without emojis: "Count: 57", "Track: 93", etc.
    const labeledRoundRegex =
      /\b(count|track|angle|tempo|split)\b[ \t]*[:=\-][ \t]*(\d{1,3}(?:\.\d+)?)(?:[ \t]*\/[ \t]*100)?(?![a-z0-9.%])/gi;
    let labelMatch;
    while ((labelMatch = labeledRoundRegex.exec(line)) !== null) {
      const round = ROUND_BY_NAME.get(labelMatch[1].toLowerCase());
      const score = Number(labelMatch[2]);
      if (!round || !Number.isFinite(score) || score < 0 || score > 100) {
        continue;
      }
      if (!seenKeys.has(round.key)) {
        seenKeys.add(round.key);
        roundScores[round.key] = score;
        breakdown.push({
          key: round.key,
          icon: round.icon,
          name: round.name,
          label: round.label,
          value: score,
          max: round.max,
          display: formatCleanScore(score),
        });
      }
    }
  }

  return { breakdown, roundScores };
}

export const perceptleParser = {
  id: 'perceptle',
  name: 'Perceptle',
  version: 1,
  isCustomParser: true,
  supportedSlugs: ['perceptle'],
  supportedDomains: ['perceptle.com', 'theperceptle.com'],

  canParse(rawText) {
    if (typeof rawText !== 'string') return false;
    if (PERCEPTLE_DOMAIN_REGEX.test(rawText) || PERCEPTLE_HEADER_ID_REGEX.test(rawText)) {
      return true;
    }
    const stripped = rawText.replace(/\uFE0F/g, '');
    const tokens = stripped.match(CANONICAL_TOKEN_SCAN_REGEX);
    return Array.isArray(tokens) && tokens.length >= 3;
  },

  parse(rawText, _gameContext = {}) {
    const text = typeof rawText === 'string' ? rawText : '';

    let puzzleId = null;
    const headerIdMatch = PERCEPTLE_HEADER_ID_REGEX.exec(text);
    if (headerIdMatch) {
      puzzleId = `#${headerIdMatch[1].replace(/,/g, '')}`;
    } else {
      puzzleId = extractPuzzleId(text);
    }

    const puzzleDate = extractExplicitDate(text);
    const emojiGrid = extractEmojiGrid(text);
    const scanText = stripUrlsAndDates(text);

    const { grade, headerScore, headerSpanStart, headerSpanEnd } =
      extractHeaderGradeAndScore(scanText);

    const bodyText =
      headerSpanStart >= 0
        ? `${scanText.slice(0, headerSpanStart)} ${scanText.slice(headerSpanEnd)}`
        : scanText;

    const { breakdown, roundScores } = parseRoundsFromBody(bodyText);

    let explicitPercent = null;
    if (headerScore === null && breakdown.length === 0) {
      const pctMatch = /\b(\d{1,3}(?:\.\d+)?)\s*%/.exec(bodyText);
      if (pctMatch) {
        const pct = Number(pctMatch[1]);
        if (Number.isFinite(pct)) {
          explicitPercent = pct;
        }
      }
    }

    let primaryValue = null;
    if (headerScore !== null && Number.isFinite(headerScore)) {
      primaryValue = headerScore;
    } else if (breakdown.length > 0) {
      const sum = breakdown.reduce((acc, item) => acc + item.value, 0);
      primaryValue = Math.round(sum / breakdown.length);
    } else if (explicitPercent !== null) {
      primaryValue = explicitPercent;
    }

    const isDnf = /\b(dnf|failed|did not finish|game over|unsolved)\b/i.test(text);
    const solved = isDnf ? false : null;

    let displayValue = 'Played';
    if (grade && primaryValue !== null) {
      displayValue = `${formatCleanScore(primaryValue)} (${grade})`;
    } else if (breakdown.length === 0 && headerScore === null && explicitPercent !== null) {
      displayValue = `${formatCleanScore(explicitPercent)}%`;
    } else if (primaryValue !== null) {
      displayValue = formatCleanScore(primaryValue);
    } else if (solved === false) {
      displayValue = 'DNF';
    }

    const metadata = {
      maxScore: 100,
    };
    if (grade) {
      metadata.grade = grade;
    }
    if (Object.keys(roundScores).length > 0) {
      metadata.roundScores = roundScores;
    }
    if (emojiGrid) {
      metadata.emojiGrid = emojiGrid;
    } else if (breakdown.length > 0) {
      metadata.emojiGrid = breakdown
        .map((item) => `${item.label} · ${item.display}`)
        .join('\n');
    }

    return {
      parserId: 'perceptle',
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

export default perceptleParser;
