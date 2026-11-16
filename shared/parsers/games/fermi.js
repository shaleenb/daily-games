import { extractEmojiGrid, extractExplicitDate, extractPuzzleId } from '../utils.js';

const FERMI_DOMAIN_REGEX = /\bfermi\.gg\b/i;
const FERMI_NAME_REGEX = /\bfermi\b/i;
const ROUND_LINE_REGEX =
  /^\s*(0?[1-9]\d?)[ \t]*([↑↓⬆⬇=✓🎯]\uFE0F?)?[ \t]*(\d[\d,]*(?:\.\d+)?)[ \t]*([×x])\s*$/i;
const DIVIDER_LINE_REGEX = /^\s*[─━—\-]{3,}\s*$/;

function getCandidateLines(rawText) {
  const physicalLines = rawText.split(/\r?\n/);
  const out = [];
  for (const line of physicalLines) {
    if (!/^<?https?:\/\//i.test(line.trim()) && line.includes(' / ')) {
      out.push(...line.split(/\s+\/\s+/));
    } else {
      out.push(line);
    }
  }
  return out;
}

function stripUrlsAndMeta(line) {
  return line
    .replace(/<?https?:\/\/\S+>?/gi, ' ')
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, ' ')
    .replace(/\b\d{1,4}\/\d{1,2}\/\d{2,4}\b/g, ' ')
    .replace(/(^|[\s(])#\d[\d,]*/gm, '$1 ')
    .replace(/\b(?:no\.?|puzzle)[ \t]*\d[\d,]*/gi, ' ');
}

function extractSummaryFromLine(line) {
  const clean = stripUrlsAndMeta(line);

  // 1a. Suffix "score": "1.30× score · top 2%", "27.6× score · top 89%"
  const suffixScore =
    /(?<![a-z0-9.:#])(\d[\d,]*(?:\.\d+)?)[ \t]*[×x][ \t]*score\b/i.exec(clean);
  if (suffixScore) {
    const rawNum = suffixScore[1].replace(/,/g, '');
    const num = Number(rawNum);
    if (Number.isFinite(num)) {
      return { value: num, display: `${suffixScore[1]}×` };
    }
  }

  // 1b. Prefix "score:" / "avg:" / "average:" / "multiplier:": "Score: 1.30×", "avg: 1.30×"
  const prefixScore =
    /\b(?:score|avg|average|multiplier)[ \t]*[:=\-]?[ \t]*(\d[\d,]*(?:\.\d+)?)(?:[ \t]*[×x])?(?![a-z0-9.:%])/i.exec(
      clean
    );
  if (prefixScore) {
    const rawNum = prefixScore[1].replace(/,/g, '');
    const num = Number(rawNum);
    if (Number.isFinite(num)) {
      return { value: num, display: `${prefixScore[1]}×` };
    }
  }

  return null;
}

function extractPostDividerMultiplier(lines, dividerIndices) {
  if (dividerIndices.length === 0) return null;
  const startIdx = dividerIndices[0] + 1;
  for (let i = startIdx; i < lines.length; i += 1) {
    if (ROUND_LINE_REGEX.test(lines[i].trim())) continue;
    const clean = stripUrlsAndMeta(lines[i]);
    const match = /(?<![a-z0-9.:#])(\d[\d,]*(?:\.\d+)?)[ \t]*[×x](?![a-z0-9]|[ \t]*\d)/i.exec(
      clean
    );
    if (match) {
      const num = Number(match[1].replace(/,/g, ''));
      if (Number.isFinite(num)) {
        return { value: num, display: `${match[1]}×` };
      }
    }
  }
  return null;
}

export const fermiParser = {
  id: 'fermi',
  name: 'Fermi',
  version: 1,
  isCustomParser: true,
  supportedSlugs: ['fermi'],
  supportedDomains: ['fermi.gg'],

  canParse(rawText) {
    if (typeof rawText !== 'string') return false;
    if (FERMI_DOMAIN_REGEX.test(rawText) || FERMI_NAME_REGEX.test(rawText)) {
      return true;
    }
    const lines = getCandidateLines(rawText);
    let roundCount = 0;
    for (const line of lines) {
      if (ROUND_LINE_REGEX.test(line.trim())) {
        roundCount += 1;
        if (roundCount >= 2) return true;
      }
    }
    return false;
  },

  parse(rawText, _gameContext = {}) {
    const text = typeof rawText === 'string' ? rawText : '';

    const puzzleId = extractPuzzleId(text);
    const puzzleDate = extractExplicitDate(text);

    const lines = getCandidateLines(text);
    const breakdown = [];
    const nonRoundLines = [];
    const dividerIndices = [];

    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      const roundMatch = ROUND_LINE_REGEX.exec(trimmed);
      if (roundMatch) {
        const idx = Number(roundMatch[1]);
        const padded = String(idx).padStart(2, '0');
        const icon = roundMatch[2] ? roundMatch[2].replace(/\uFE0F/g, '') : '';
        const rawNum = roundMatch[3];
        const val = Number(rawNum.replace(/,/g, ''));
        if (Number.isFinite(val)) {
          const label = icon ? `${padded} ${icon}` : padded;
          const display = `${rawNum}×`;
          const item = {
            key: `q${idx}`,
            name: `Q${idx}`,
            label,
            value: val,
            display,
          };
          if (icon) {
            item.icon = icon;
          }
          breakdown.push(item);
        }
        continue;
      }

      if (DIVIDER_LINE_REGEX.test(trimmed)) {
        dividerIndices.push(i);
      }
      nonRoundLines.push(lines[i]);
    }

    // Extract optional "top X%" percentile
    const nonUrlText = text.replace(/<?https?:\/\/\S+>?/gi, ' ');
    const topMatch = /\btop[ \t]+(\d+(?:\.\d+)?)%/i.exec(nonUrlText);
    const topPercent = topMatch ? Number(topMatch[1]) : null;
    const percentileLabel = topMatch ? `top ${topMatch[1]}%` : null;

    // Priority 1: Summary line with "score"/"avg" or multiplier after divider
    let scoreResult = null;
    for (const line of nonRoundLines) {
      scoreResult = extractSummaryFromLine(line);
      if (scoreResult) break;
    }
    if (!scoreResult) {
      scoreResult = extractPostDividerMultiplier(lines, dividerIndices);
    }

    // Priority 2: Non-round header / single-line multiplier ("Fermi #42 - 1.62×")
    if (!scoreResult) {
      for (const line of nonRoundLines) {
        const clean = stripUrlsAndMeta(line);
        const match =
          /(?<![a-z0-9.:#])(\d[\d,]*(?:\.\d+)?)[ \t]*[×x](?![a-z0-9]|[ \t]*\d)/i.exec(clean);
        if (match) {
          const num = Number(match[1].replace(/,/g, ''));
          if (Number.isFinite(num)) {
            scoreResult = { value: num, display: `${match[1]}×` };
            break;
          }
        }
      }
    }

    // Priority 3: Geometric mean of positive round multipliers rounded to 2 decimals
    if (!scoreResult && breakdown.length > 0) {
      const positives = breakdown.map((r) => r.value).filter((v) => v > 0);
      if (positives.length > 0) {
        const logAvg = positives.reduce((sum, v) => sum + Math.log(v), 0) / positives.length;
        const rounded = Math.round(Math.exp(logAvg) * 100) / 100;
        scoreResult = {
          value: rounded,
          display: `${rounded.toFixed(2)}×`,
        };
      }
    }

    const primaryValue = scoreResult ? scoreResult.value : null;
    const isDnf = /\b(dnf|failed|did not finish|game over)\b/i.test(text);
    const solved = isDnf ? false : null;
    const displayValue = scoreResult
      ? scoreResult.display
      : solved === false
        ? 'DNF'
        : 'Played';

    const metadata = {};
    if (topPercent !== null && Number.isFinite(topPercent)) {
      metadata.topPercent = topPercent;
    }
    if (percentileLabel) {
      metadata.percentileLabel = percentileLabel;
    }

    if (breakdown.length > 0) {
      const roundBlock = breakdown.map((r) => `${r.label} ${r.display}`).join('\n');
      const summaryParts = [];
      if (scoreResult) summaryParts.push(scoreResult.display);
      if (percentileLabel) summaryParts.push(percentileLabel);
      metadata.emojiGrid =
        summaryParts.length > 0
          ? `${roundBlock}\n─────────\n${summaryParts.join(' · ')}`
          : roundBlock;
    } else {
      const fallbackGrid = extractEmojiGrid(text);
      if (fallbackGrid) {
        metadata.emojiGrid = fallbackGrid;
      }
    }

    return {
      parserId: 'fermi',
      parserVersion: 1,
      isCustomParser: true,
      completed: true,
      solved,
      primaryValue,
      displayValue,
      metricFormat: 'number',
      metricDirection: 'lower_is_better',
      metricLabel: 'Avg Multiplier',
      puzzleId,
      puzzleDate,
      breakdown,
      metadata,
    };
  },
};

export default fermiParser;
