import { STARTER_GAMES } from '../shared/auth-crypto.js';
import {
  CLUES_BY_SAM_DIFFICULTIES,
  normalizeDifficultyLabel,
  getLocalDateString,
  formatMetricValue,
  getGamePuzzleStatus,
} from '../shared/parsers/registry.js';

export const DIFFICULTY_COLORS = Object.freeze({
  Easy: '#10b981',
  Medium: '#f59e0b',
  Tricky: '#8b5cf6',
  Hard: '#f97316',
  Brutal: '#ef4444',
});

export function getDifficultyColor(difficulty) {
  return DIFFICULTY_COLORS[difficulty] || '#64748b';
}

export function getEntryDifficulty(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const candidate =
    entry.difficulty !== undefined && entry.difficulty !== null && entry.difficulty !== ''
      ? entry.difficulty
      : entry.metadata?.difficulty;
  return normalizeDifficultyLabel(candidate) || null;
}

export function normalizeDifficultyFilter(raw) {
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim();
  if (!str || str.toLowerCase() === 'all') return null;
  return normalizeDifficultyLabel(str);
}

function isDifficultyNativeGame(game) {
  if (!game) return false;
  return (
    game.slug === 'cluesbysam' ||
    game.parserId === 'cluesbysam' ||
    game.resolvedParser?.id === 'cluesbysam'
  );
}

function sortDifficultyLabels(labels) {
  const canonicalRank = new Map(CLUES_BY_SAM_DIFFICULTIES.map((d, idx) => [d, idx]));
  return [...labels].sort((a, b) => {
    const ra = canonicalRank.has(a) ? canonicalRank.get(a) : Number.MAX_SAFE_INTEGER;
    const rb = canonicalRank.has(b) ? canonicalRank.get(b) : Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });
}

export function buildDifficultyOptions(game, entries = []) {
  const counts = new Map();
  for (const e of entries) {
    if (!e || !e.completed) continue;
    const diff = getEntryDifficulty(e);
    if (!diff) continue;
    counts.set(diff, (counts.get(diff) || 0) + 1);
  }

  if (!isDifficultyNativeGame(game) && counts.size === 0) {
    return [];
  }

  const seen = new Set();
  const options = [];
  for (const d of CLUES_BY_SAM_DIFFICULTIES) {
    seen.add(d);
    options.push({
      value: d,
      label: d,
      count: counts.get(d) || 0,
      color: getDifficultyColor(d),
    });
  }

  const customLabels = sortDifficultyLabels(
    Array.from(counts.keys()).filter((d) => !seen.has(d)),
  );
  for (const d of customLabels) {
    options.push({
      value: d,
      label: d,
      count: counts.get(d) || 0,
      color: getDifficultyColor(d),
    });
  }

  return options;
}

export function computeDifficultySummary(completedEntriesAsc, metricDirection = 'higher_is_better') {
  const groups = new Map();
  for (const entry of completedEntriesAsc) {
    if (!entry || !entry.completed) continue;
    const diff = getEntryDifficulty(entry);
    if (!diff) continue;

    let grp = groups.get(diff);
    if (!grp) {
      grp = { count: 0, numericValues: [] };
      groups.set(diff, grp);
    }
    grp.count += 1;
    if (
      entry.solved !== false &&
      entry.primaryValue !== null &&
      entry.primaryValue !== undefined &&
      Number.isFinite(Number(entry.primaryValue))
    ) {
      grp.numericValues.push(Number(entry.primaryValue));
    }
  }

  if (groups.size === 0) return [];

  const lowerIsBetter = metricDirection === 'lower_is_better';
  return sortDifficultyLabels(groups.keys()).map((diff) => {
    const grp = groups.get(diff);
    const nums = grp.numericValues;
    let average = null;
    let latest = null;
    let best = null;
    if (nums.length > 0) {
      const sum = nums.reduce((acc, v) => acc + v, 0);
      average = round2(sum / nums.length);
      latest = nums[nums.length - 1];
      best = lowerIsBetter ? Math.min(...nums) : Math.max(...nums);
    }
    return {
      key: diff,
      label: diff,
      average,
      latest,
      best,
      count: grp.count,
      color: getDifficultyColor(diff),
    };
  });
}

export function parseYmd(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) {
    return null;
  }
  return dt;
}

export function addDays(ymd, deltaDays) {
  const dt = parseYmd(ymd);
  if (!dt) return null;
  dt.setDate(dt.getDate() + deltaDays);
  return getLocalDateString(dt);
}

export function diffDaysYmd(ymdA, ymdB) {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymdA || '').trim());
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymdB || '').trim());
  if (!a || !b) return null;
  const utcA = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const utcB = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  return Math.round((utcA - utcB) / 86_400_000);
}

function round2(num) {
  return Math.round(num * 100) / 100;
}

function formatStatNumber(value, metricFormat) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const normalized = metricFormat === 'duration_sec' ? Math.round(value) : round2(value);
  return formatMetricValue(normalized, metricFormat);
}

export function computeStreaksFromDateSet(playedDates, referenceDate = getLocalDateString()) {
  if (!playedDates || playedDates.size === 0) {
    return { currentStreak: 0, longestStreak: 0 };
  }

  let currentStreak = 0;
  let cursor = null;
  if (playedDates.has(referenceDate)) {
    cursor = referenceDate;
  } else {
    const yesterday = addDays(referenceDate, -1);
    if (yesterday && playedDates.has(yesterday)) {
      cursor = yesterday;
    }
  }

  while (cursor && playedDates.has(cursor)) {
    currentStreak += 1;
    cursor = addDays(cursor, -1);
  }

  const sorted = Array.from(playedDates).sort();
  let longestStreak = 0;
  let run = 0;
  let prev = null;
  for (const date of sorted) {
    if (prev && addDays(prev, 1) === date) {
      run += 1;
    } else {
      run = 1;
    }
    if (run > longestStreak) {
      longestStreak = run;
    }
    prev = date;
  }

  return { currentStreak, longestStreak };
}

export function computeStreaks(entries, referenceDate = getLocalDateString()) {
  const playedDates = new Set();
  for (const entry of entries) {
    if (entry && entry.completed && parseYmd(entry.playDate)) {
      playedDates.add(entry.playDate);
    }
  }
  return computeStreaksFromDateSet(playedDates, referenceDate);
}

export function computePersonalBest(entries, metricDirection = 'higher_is_better') {
  let best = null;
  const lowerIsBetter = metricDirection === 'lower_is_better';

  for (const entry of entries) {
    if (!entry || !entry.completed || entry.solved === false) continue;
    if (entry.primaryValue === null || entry.primaryValue === undefined) continue;
    const val = Number(entry.primaryValue);
    if (!Number.isFinite(val)) continue;

    const isBetter =
      best === null ||
      (lowerIsBetter ? val < best.value : val > best.value) ||
      (val === best.value && entry.playDate > best.playDate);

    if (isBetter) {
      best = {
        value: val,
        displayValue: entry.displayValue ?? String(val),
        playDate: entry.playDate,
      };
    }
  }

  return best;
}

function groupEntriesByGameId(entries) {
  const map = new Map();
  for (const entry of entries) {
    let list = map.get(entry.gameId);
    if (!list) {
      list = [];
      map.set(entry.gameId, list);
    }
    list.push(entry);
  }
  return map;
}

export function computeCardSummaries(
  games,
  allEntries,
  referenceDate = getLocalDateString(),
  { live = false, now = new Date(), viewerTimeZone } = {},
) {
  const byGame = groupEntriesByGameId(allEntries);

  const summaries = {};
  for (const game of games) {
    const puzzleStatus = getGamePuzzleStatus(game, now, viewerTimeZone);
    const anchorDate = live ? puzzleStatus.activePuzzleDate : referenceDate;

    const windowDates = [];
    for (let i = -13; i <= 0; i += 1) {
      windowDates.push(addDays(anchorDate, i));
    }

    const gameEntries = (byGame.get(game.id) || []).filter((e) => e.completed);
    const { currentStreak, longestStreak } = computeStreaks(gameEntries, anchorDate);
    const personalBest = computePersonalBest(gameEntries, game.metricDirection);

    const byDate = new Map();
    for (const e of gameEntries) {
      byDate.set(e.playDate, e);
    }

    const recentSparkline = windowDates.map((playDate) => {
      const e = byDate.get(playDate);
      if (e && e.completed) {
        return {
          playDate,
          value: e.primaryValue,
          displayValue: e.displayValue,
          completed: true,
        };
      }
      return {
        playDate,
        value: null,
        displayValue: null,
        completed: false,
      };
    });

    summaries[game.id] = {
      currentStreak,
      longestStreak,
      totalPlayed: gameEntries.length,
      personalBest,
      recentSparkline,
      puzzleStatus,
    };
  }

  return summaries;
}

export function computeDailyOverview(
  games,
  allEntries,
  referenceDate = getLocalDateString(),
  { live = false, now = new Date(), viewerTimeZone } = {},
) {
  const activeGames = games.filter((g) => !g.archived);
  const activeGamesCount = activeGames.length;
  const activeOffsetByGameId = new Map();
  const activeDateByGameId = new Map();

  const liveRoutineToday = live
    ? referenceDate ||
      getGamePuzzleStatus({ resetTimezone: 'local', resetTime: '00:00' }, now, viewerTimeZone)
        .localTodayDate
    : referenceDate;

  for (const g of activeGames) {
    if (live) {
      const status = getGamePuzzleStatus(g, now, viewerTimeZone);
      activeDateByGameId.set(g.id, status.activePuzzleDate);
      activeOffsetByGameId.set(g.id, diffDaysYmd(status.activePuzzleDate, liveRoutineToday) ?? 0);
    } else {
      activeDateByGameId.set(g.id, referenceDate);
      activeOffsetByGameId.set(g.id, 0);
    }
  }

  const byDate = new Map();
  let playedTodayCount = 0;
  const clearedTodayIds = new Set();

  for (const entry of allEntries) {
    if (!entry.completed || !activeDateByGameId.has(entry.gameId) || !parseYmd(entry.playDate)) {
      continue;
    }

    if (entry.playDate === activeDateByGameId.get(entry.gameId)) {
      clearedTodayIds.add(entry.gameId);
    }

    const offsetDays = activeOffsetByGameId.get(entry.gameId) || 0;
    const routineDate = offsetDays === 0 ? entry.playDate : addDays(entry.playDate, -offsetDays);
    if (!routineDate) continue;

    let set = byDate.get(routineDate);
    if (!set) {
      set = new Set();
      byDate.set(routineDate, set);
    }
    set.add(entry.gameId);
  }

  playedTodayCount = activeGamesCount > 0 ? clearedTodayIds.size : 0;
  const activeDatesWithPlay = new Set();
  let fullSweepDays = 0;

  for (const [date, gameSet] of byDate.entries()) {
    if (gameSet.size > 0) {
      activeDatesWithPlay.add(date);
    }
    if (activeGamesCount > 0 && gameSet.size >= activeGamesCount) {
      fullSweepDays += 1;
    }
  }

  const { currentStreak: routineStreak } = computeStreaksFromDateSet(
    activeDatesWithPlay,
    liveRoutineToday,
  );

  return {
    activeGamesCount,
    playedTodayCount,
    routineStreak,
    playedTodayInStreak: playedTodayCount > 0,
    fullSweepDays,
  };
}

export function computeHeatmap(
  games,
  allEntries,
  referenceDate = getLocalDateString(),
  daysCount = 91,
) {
  const activeGames = games.filter((g) => !g.archived);
  const activeById = new Map(activeGames.map((g) => [g.id, g]));
  const totalActive = activeGames.length;

  const entriesByDate = new Map();
  for (const entry of allEntries) {
    if (!entry.completed) continue;
    const game = activeById.get(entry.gameId);
    if (!game) continue;
    let list = entriesByDate.get(entry.playDate);
    if (!list) {
      list = [];
      entriesByDate.set(entry.playDate, list);
    }
    list.push({ game, entry });
  }

  const result = [];
  for (let i = -(daysCount - 1); i <= 0; i += 1) {
    const date = addDays(referenceDate, i);
    const items = (entriesByDate.get(date) || []).sort(
      (a, b) => a.game.sortOrder - b.game.sortOrder || a.game.id - b.game.id,
    );
    result.push({
      date,
      count: items.length,
      totalActive,
      games: items.map(({ game, entry }) => ({
        gameId: game.id,
        name: game.name,
        icon: game.icon,
        displayValue: entry.displayValue,
      })),
    });
  }

  return result;
}

export function computeLeaderboard(games, allEntries, referenceDate = getLocalDateString()) {
  const activeGames = games.filter((g) => !g.archived);
  const byGame = groupEntriesByGameId(allEntries);
  const cutoff30d = addDays(referenceDate, -29);

  const rows = activeGames.map((game) => {
    const gameEntries = (byGame.get(game.id) || []).filter((e) => e.completed);
    const { currentStreak, longestStreak } = computeStreaks(gameEntries, referenceDate);
    const personalBest = computePersonalBest(gameEntries, game.metricDirection);

    const played30d = gameEntries.filter(
      (e) => e.playDate >= cutoff30d && e.playDate <= referenceDate,
    ).length;
    const completionRate30d = Math.round((played30d / 30) * 100);

    return {
      gameId: game.id,
      name: game.name,
      icon: game.icon,
      color: game.color,
      totalPlayed: gameEntries.length,
      currentStreak,
      longestStreak,
      completionRate30d,
      personalBestDisplay: personalBest ? personalBest.displayValue : null,
      _sortOrder: game.sortOrder,
    };
  });

  rows.sort(
    (a, b) =>
      b.currentStreak - a.currentStreak ||
      b.longestStreak - a.longestStreak ||
      b.totalPlayed - a.totalPlayed ||
      a._sortOrder - b._sortOrder,
  );

  return rows.map(({ _sortOrder, ...rest }) => rest);
}

function formatBucketBoundary(val, metricFormat) {
  if (metricFormat === 'duration_sec') {
    return formatMetricValue(Math.round(val), 'duration_sec');
  }
  if (metricFormat === 'percent') {
    return `${round2(val)}%`;
  }
  return String(round2(val));
}

export function computeDistribution(values, metricFormat = 'number') {
  if (!values || values.length === 0) return [];
  const total = values.length;
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);

  if (minVal === maxVal) {
    return [
      {
        label: formatBucketBoundary(minVal, metricFormat),
        min: minVal,
        max: maxVal,
        count: total,
        percentage: 100,
      },
    ];
  }

  const allIntegers = values.every((v) => Number.isInteger(v));
  if (allIntegers && maxVal - minVal < 6) {
    const buckets = [];
    for (let v = minVal; v <= maxVal; v += 1) {
      const count = values.filter((x) => x === v).length;
      buckets.push({
        label: formatBucketBoundary(v, metricFormat),
        min: v,
        max: v,
        count,
        percentage: Math.round((count / total) * 1000) / 10,
      });
    }
    return buckets;
  }

  const bucketCount = Math.min(6, Math.max(3, Math.ceil(Math.sqrt(total))));
  const span = maxVal - minVal;

  const buckets = [];
  for (let i = 0; i < bucketCount; i += 1) {
    const isLast = i === bucketCount - 1;
    const rawLow = minVal + (i * span) / bucketCount;
    const rawHigh = isLast ? maxVal : minVal + ((i + 1) * span) / bucketCount;
    const low = allIntegers ? Math.round(rawLow) : round2(rawLow);
    const high = allIntegers ? (isLast ? maxVal : Math.round(rawHigh)) : round2(rawHigh);

    const count = values.filter((v) =>
      isLast
        ? v >= (allIntegers ? low : rawLow) && v <= maxVal
        : v >= (allIntegers ? low : rawLow) && v < (allIntegers ? high : rawHigh),
    ).length;

    const label =
      low === high
        ? formatBucketBoundary(low, metricFormat)
        : `${formatBucketBoundary(low, metricFormat)}–${formatBucketBoundary(high, metricFormat)}`;

    buckets.push({
      label,
      min: low,
      max: high,
      count,
      percentage: Math.round((count / total) * 1000) / 10,
    });
  }

  return buckets;
}

export function computeBreakdownSummary(entriesAsc, metricDirection = 'higher_is_better') {
  const agg = new Map();
  const lowerIsBetter = metricDirection === 'lower_is_better';

  for (const entry of entriesAsc) {
    if (!entry.completed || !Array.isArray(entry.breakdown)) continue;
    for (const item of entry.breakdown) {
      if (!item || typeof item.label !== 'string' || !item.label.trim()) continue;
      const val = Number(item.value);
      if (!Number.isFinite(val)) continue;
      const label = item.label.trim();
      const icon = typeof item.icon === 'string' && item.icon.trim() ? item.icon.trim() : null;
      const itemMax =
        item.max !== undefined && item.max !== null && Number.isFinite(Number(item.max))
          ? Number(item.max)
          : null;

      let rec = agg.get(label);
      if (!rec) {
        rec = {
          label,
          icon,
          sum: 0,
          count: 0,
          max: itemMax,
          latestValue: val,
          bestValue: val,
        };
        agg.set(label, rec);
      } else {
        rec.bestValue = lowerIsBetter
          ? Math.min(rec.bestValue, val)
          : Math.max(rec.bestValue, val);
        if (!rec.icon && icon) {
          rec.icon = icon;
        }
      }
      rec.sum += val;
      rec.count += 1;
      rec.latestValue = val;
      if (itemMax !== null) {
        rec.max = rec.max === null ? itemMax : Math.max(rec.max, itemMax);
      }
    }
  }

  return Array.from(agg.values()).map((rec) => ({
    label: rec.label,
    ...(rec.icon ? { icon: rec.icon } : {}),
    avgValue: round2(rec.sum / rec.count),
    max: rec.max,
    latestValue: rec.latestValue,
    bestValue: rec.bestValue,
    count: rec.count,
  }));
}

export function computeGameStats(
  game,
  gameEntriesAll,
  { days = null, referenceDate = getLocalDateString(), difficulty = null } = {},
) {
  if (!game) return null;

  const activeDifficulty = normalizeDifficultyFilter(difficulty);
  const allCompleted = gameEntriesAll.filter((e) => e.completed);
  const { currentStreak, longestStreak } = computeStreaks(allCompleted, referenceDate);

  const difficultyOptions = buildDifficultyOptions(game, gameEntriesAll);
  const supportsDifficulty = Boolean(
    isDifficultyNativeGame(game) || difficultyOptions.some((d) => d.count > 0),
  );

  let windowEntries = [...gameEntriesAll];
  const hasDays = days !== null && days !== undefined && Number.isFinite(days) && days > 0;
  if (hasDays) {
    const cutoff = addDays(referenceDate, -(Math.trunc(days) - 1));
    windowEntries = windowEntries.filter(
      (e) => e.playDate >= cutoff && e.playDate <= referenceDate,
    );
  }

  const windowCompletedAsc = [...windowEntries]
    .filter((e) => e.completed)
    .sort((a, b) => a.playDate.localeCompare(b.playDate) || a.id - b.id);
  const difficultySummary = computeDifficultySummary(windowCompletedAsc, game.metricDirection);

  const filteredWindowEntries = activeDifficulty
    ? windowEntries.filter((e) => getEntryDifficulty(e) === activeDifficulty)
    : windowEntries;

  const entriesDesc = [...filteredWindowEntries]
    .sort((a, b) => b.playDate.localeCompare(a.playDate) || b.id - a.id)
    .map((entry) => {
      const diff = getEntryDifficulty(entry);
      return entry.difficulty === diff ? entry : { ...entry, difficulty: diff };
    });
  const entriesAsc = [...filteredWindowEntries].sort(
    (a, b) => a.playDate.localeCompare(b.playDate) || a.id - b.id,
  );

  const completedInWindow = entriesAsc.filter((e) => e.completed);
  const totalPlayed = completedInWindow.length;
  const decided = completedInWindow.filter((e) => e.solved !== null);
  const solvedCount = decided.filter((e) => e.solved === true).length;
  const winRate =
    decided.length > 0 ? Math.round((solvedCount / decided.length) * 1000) / 10 : null;

  const numericEntries = completedInWindow.filter(
    (e) => e.solved !== false && e.primaryValue !== null && Number.isFinite(e.primaryValue),
  );
  const values = numericEntries.map((e) => e.primaryValue);

  let averageValue = null;
  let averageDisplay = null;
  let medianValue = null;
  let medianDisplay = null;

  if (values.length > 0) {
    const sum = values.reduce((acc, v) => acc + v, 0);
    const avg = sum / values.length;
    averageValue = round2(avg);
    averageDisplay = formatStatNumber(avg, game.metricFormat);

    const sortedVals = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sortedVals.length / 2);
    const med =
      sortedVals.length % 2 === 1
        ? sortedVals[mid]
        : (sortedVals[mid - 1] + sortedVals[mid]) / 2;
    medianValue = round2(med);
    medianDisplay = formatStatNumber(med, game.metricFormat);
  }

  const personalBest = computePersonalBest(completedInWindow, game.metricDirection);

  const rollingBuffer = [];
  const trendSeries = completedInWindow.map((entry) => {
    const hasNumeric =
      entry.solved !== false &&
      entry.primaryValue !== null &&
      Number.isFinite(entry.primaryValue);

    let rollingAvg = null;
    let rollingAvgDisplay = null;

    if (hasNumeric) {
      rollingBuffer.push(entry.primaryValue);
      if (rollingBuffer.length > 7) {
        rollingBuffer.shift();
      }
      const avg = rollingBuffer.reduce((acc, v) => acc + v, 0) / rollingBuffer.length;
      rollingAvg = round2(avg);
      rollingAvgDisplay = formatStatNumber(avg, game.metricFormat);
    }

    const isPersonalBest = Boolean(
      personalBest &&
        hasNumeric &&
        entry.primaryValue === personalBest.value,
    );

    const rawSnippet = entry.rawText
      ? entry.rawText.trim().replace(/\s+/g, ' ').slice(0, 120)
      : '';

    return {
      playDate: entry.playDate,
      value: entry.primaryValue,
      displayValue: entry.displayValue,
      rollingAvg,
      rollingAvgDisplay,
      solved: entry.solved,
      puzzleId: entry.puzzleId,
      difficulty: getEntryDifficulty(entry),
      isPersonalBest,
      rawSnippet,
    };
  });

  const distribution = computeDistribution(values, game.metricFormat);
  const breakdownSummary = computeBreakdownSummary(completedInWindow, game.metricDirection);

  return {
    game,
    filters: {
      gameId: game.id,
      days: hasDays ? Math.trunc(days) : null,
      difficulty: activeDifficulty,
    },
    supportsDifficulty,
    difficultyOptions,
    difficultySummary,
    kpis: {
      totalPlayed,
      solvedCount,
      winRate,
      currentStreak,
      longestStreak,
      averageValue,
      averageDisplay,
      medianValue,
      medianDisplay,
      personalBest,
    },
    trendSeries,
    distribution,
    breakdownSummary,
    entries: entriesDesc,
  };
}

const GRID_SYMBOL_REGEX = /[\p{Extended_Pictographic}\u2B1B\u2B1C\u2B50\u2705\u274C\u2B55]/gu;

export function extractShareGrid(entry) {
  if (typeof entry?.metadata?.emojiGrid === 'string' && entry.metadata.emojiGrid.trim()) {
    return entry.metadata.emojiGrid.trim();
  }
  if (typeof entry?.rawText !== 'string' || !entry.rawText.trim()) {
    return null;
  }

  const lines = entry.rawText.split(/\r?\n/);
  const blocks = [];
  let currentBlock = [];

  const flushBlock = () => {
    if (currentBlock.length >= 2) {
      blocks.push(currentBlock);
    } else if (currentBlock.length === 1) {
      const syms = currentBlock[0].match(GRID_SYMBOL_REGEX);
      if (syms && syms.length >= 3) {
        blocks.push(currentBlock);
      }
    }
    currentBlock = [];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flushBlock();
      continue;
    }
    if (/https?:\/\//i.test(trimmed) || /[a-z]/i.test(trimmed)) {
      flushBlock();
      continue;
    }
    const syms = trimmed.match(GRID_SYMBOL_REGEX);
    if (syms && syms.length >= 2) {
      currentBlock.push(trimmed);
    } else {
      flushBlock();
    }
  }
  flushBlock();

  if (blocks.length === 0) return null;
  let best = blocks[0];
  for (let i = 1; i < blocks.length; i += 1) {
    if (blocks[i].length > best.length) {
      best = blocks[i];
    }
  }
  return best.join('\n');
}

function compareAverageNullable(aVal, bVal, metricDirection) {
  const aNull = aVal === null || aVal === undefined || !Number.isFinite(aVal);
  const bNull = bVal === null || bVal === undefined || !Number.isFinite(bVal);
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  return metricDirection === 'lower_is_better' ? aVal - bVal : bVal - aVal;
}

export function computePlayersLeaderboard({
  users = [],
  allGames = [],
  allEntries = [],
  viewerUserId = null,
  referenceDate = getLocalDateString(),
  days = 30,
  gameSlug = null,
  difficulty = null,
  live = false,
  now = new Date(),
  viewerTimeZone = undefined,
} = {}) {
  const activeDifficulty = normalizeDifficultyFilter(difficulty);
  const gameById = new Map();
  const viewerGamesBySlug = new Map();
  const anyGameBySlug = new Map();
  const slugsWithActive = new Set();
  const slugsWithCompletedEntries = new Set();
  const viewerActiveSlugs = new Set();
  const viewerArchivedSlugs = new Set();
  const activePlayersBySlug = new Map();
  const starterIndexBySlug = new Map(STARTER_GAMES.map((g, idx) => [g.slug, idx]));
  const starterBySlug = new Map(STARTER_GAMES.map((g) => [g.slug, g]));

  for (const g of allGames) {
    if (!g) continue;
    gameById.set(g.id, g);
    if (!g.archived) {
      slugsWithActive.add(g.slug);
      if (g.userId !== null && g.userId !== undefined) {
        let userSet = activePlayersBySlug.get(g.slug);
        if (!userSet) {
          userSet = new Set();
          activePlayersBySlug.set(g.slug, userSet);
        }
        userSet.add(g.userId);
      }
    }
    if (g.userId === viewerUserId) {
      if (!viewerGamesBySlug.has(g.slug)) {
        viewerGamesBySlug.set(g.slug, g);
      }
      if (g.archived) {
        viewerArchivedSlugs.add(g.slug);
      } else {
        viewerActiveSlugs.add(g.slug);
      }
    }
    const existingAny = anyGameBySlug.get(g.slug);
    if (!existingAny || (existingAny.archived && !g.archived)) {
      anyGameBySlug.set(g.slug, g);
    }
  }

  for (const e of allEntries) {
    if (!e || !e.completed || !parseYmd(e.playDate)) continue;
    const g = gameById.get(e.gameId);
    if (g) {
      slugsWithCompletedEntries.add(g.slug);
    }
  }

  const includedSlugs = Array.from(new Set([...slugsWithActive, ...slugsWithCompletedEntries]));
  const viewerActiveOrder = new Map();
  const viewerActiveGames = allGames
    .filter((g) => g && g.userId === viewerUserId && !g.archived)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  viewerActiveGames.forEach((g, idx) => {
    if (!viewerActiveOrder.has(g.slug)) {
      viewerActiveOrder.set(g.slug, idx);
    }
  });

  includedSlugs.sort((a, b) => {
    const va = viewerActiveOrder.has(a);
    const vb = viewerActiveOrder.has(b);
    if (va && vb) return viewerActiveOrder.get(a) - viewerActiveOrder.get(b);
    if (va !== vb) return va ? -1 : 1;

    const sa = starterIndexBySlug.has(a);
    const sb = starterIndexBySlug.has(b);
    if (sa && sb) return starterIndexBySlug.get(a) - starterIndexBySlug.get(b);
    if (sa !== sb) return sa ? -1 : 1;

    return a.localeCompare(b);
  });

  const catalogGames = includedSlugs.map((slug) => {
    const meta = viewerGamesBySlug.get(slug) || starterBySlug.get(slug) || anyGameBySlug.get(slug);
    const base = {
      slug,
      name: String(meta?.name || slug),
      icon: String(meta?.icon || '🎮'),
      color: String(meta?.color || '#6366f1'),
      category: String(meta?.category || 'Daily'),
      url: String(meta?.url || ''),
      metricLabel: String(meta?.metricLabel || 'Score'),
      metricFormat: String(meta?.metricFormat || 'number'),
      metricDirection:
        meta?.metricDirection === 'lower_is_better' ? 'lower_is_better' : 'higher_is_better',
      parserId: String(meta?.parserId || 'auto'),
      resetTimezone: String(meta?.resetTimezone || 'local'),
      resetTime: String(meta?.resetTime || '00:00'),
    };
    const puzzleStatus = getGamePuzzleStatus(base, now, viewerTimeZone);
    const targetDate = live ? puzzleStatus.activePuzzleDate : referenceDate;
    return {
      ...base,
      puzzleStatus,
      targetDate,
      viewerCleared: false,
    };
  });

  const catalogBySlug = new Map(catalogGames.map((cg) => [cg.slug, cg]));

  let upperDate = referenceDate;
  for (const cg of catalogGames) {
    if (cg.targetDate > upperDate) {
      upperDate = cg.targetDate;
    }
  }

  const hasWindowDays = days !== null && days !== undefined && Number.isFinite(days) && days > 0;
  const normalizedDays = hasWindowDays ? Math.trunc(days) : null;
  const cutoffDate = normalizedDays ? addDays(referenceDate, -(normalizedDays - 1)) : null;
  const cgCutoffBySlug = new Map();
  if (normalizedDays && normalizedDays > 1) {
    for (const cg of catalogGames) {
      cgCutoffBySlug.set(cg.slug, addDays(cg.targetDate, -(normalizedDays - 1)));
    }
  }
  const isEntryInGameWindow = (slug, playDate) => {
    const cg = catalogBySlug.get(slug);
    if (!cg) {
      return playDate <= upperDate && (cutoffDate === null || playDate >= cutoffDate);
    }
    if (!normalizedDays) {
      return playDate <= cg.targetDate;
    }
    if (normalizedDays === 1) {
      return playDate === cg.targetDate;
    }
    const cgCutoff = cgCutoffBySlug.get(slug);
    return playDate >= cgCutoff && playDate <= cg.targetDate;
  };

  // Deduplicate completed entries by (userId, slug, playDate), keeping latest updatedAt/id
  const dedupedByUserSlugDate = new Map();
  for (const entry of allEntries) {
    if (!entry || !entry.completed || !parseYmd(entry.playDate)) continue;
    const game = gameById.get(entry.gameId);
    if (!game || !catalogBySlug.has(game.slug)) continue;
    const userId = entry.userId ?? game.userId;
    if (userId === null || userId === undefined) continue;

    const key = `${userId}:${game.slug}:${entry.playDate}`;
    const existing = dedupedByUserSlugDate.get(key);
    if (
      !existing ||
      String(entry.updatedAt || '') > String(existing.entry.updatedAt || '') ||
      (String(entry.updatedAt || '') === String(existing.entry.updatedAt || '') &&
        entry.id > existing.entry.id)
    ) {
      dedupedByUserSlugDate.set(key, {
        userId,
        slug: game.slug,
        entry,
      });
    }
  }

  // Group into (slug, playDate) buckets for Olympic "1224" daily ranking
  const buckets = new Map();
  const dedupedByUserSlug = new Map();
  const dedupedEntriesBySlug = new Map();
  for (const item of dedupedByUserSlugDate.values()) {
    const bucketKey = `${item.slug}:${item.entry.playDate}`;
    let list = buckets.get(bucketKey);
    if (!list) {
      list = [];
      buckets.set(bucketKey, list);
    }
    list.push(item);

    const userSlugKey = `${item.userId}:${item.slug}`;
    let usList = dedupedByUserSlug.get(userSlugKey);
    if (!usList) {
      usList = [];
      dedupedByUserSlug.set(userSlugKey, usList);
    }
    usList.push(item);

    let slugList = dedupedEntriesBySlug.get(item.slug);
    if (!slugList) {
      slugList = [];
      dedupedEntriesBySlug.set(item.slug, slugList);
    }
    slugList.push(item.entry);
  }

  const scoredByUserSlugDate = new Map();
  const scoredWindowByUser = new Map();
  const scoredWindowByUserSlug = new Map();

  for (const [bucketKey, items] of buckets.entries()) {
    const slug = bucketKey.split(':')[0];
    const cg = catalogBySlug.get(slug);
    const lowerIsBetter = cg.metricDirection === 'lower_is_better';

    const numericItems = [];
    const unrankedItems = [];

    for (const item of items) {
      const val = item.entry.primaryValue;
      if (item.entry.solved !== false && val !== null && val !== undefined && Number.isFinite(Number(val))) {
        numericItems.push({ ...item, numericValue: Number(val) });
      } else {
        unrankedItems.push(item);
      }
    }

    numericItems.sort((a, b) =>
      lowerIsBetter ? a.numericValue - b.numericValue : b.numericValue - a.numericValue,
    );

    let prevRank = 0;
    let prevValue = null;
    numericItems.forEach((item, idx) => {
      const rank = prevValue !== null && item.numericValue === prevValue ? prevRank : idx + 1;
      prevRank = rank;
      prevValue = item.numericValue;

      const medal = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : null;
      const points = rank === 1 ? 3 : rank === 2 ? 2 : 1;
      const scored = {
        userId: item.userId,
        slug: item.slug,
        entry: item.entry,
        rank,
        medal,
        points,
      };
      scoredByUserSlugDate.set(`${item.userId}:${item.slug}:${item.entry.playDate}`, scored);
    });

    for (const item of unrankedItems) {
      const scored = {
        userId: item.userId,
        slug: item.slug,
        entry: item.entry,
        rank: null,
        medal: null,
        points: 1,
      };
      scoredByUserSlugDate.set(`${item.userId}:${item.slug}:${item.entry.playDate}`, scored);
    }
  }

  for (const scored of scoredByUserSlugDate.values()) {
    if (!isEntryInGameWindow(scored.slug, scored.entry.playDate)) continue;
    let uList = scoredWindowByUser.get(scored.userId);
    if (!uList) {
      uList = [];
      scoredWindowByUser.set(scored.userId, uList);
    }
    uList.push(scored);

    const usKey = `${scored.userId}:${scored.slug}`;
    let usList = scoredWindowByUserSlug.get(usKey);
    if (!usList) {
      usList = [];
      scoredWindowByUserSlug.set(usKey, usList);
    }
    usList.push(scored);
  }

  for (const cg of catalogGames) {
    cg.viewerCleared = Boolean(
      viewerUserId !== null &&
        viewerUserId !== undefined &&
        scoredByUserSlugDate.has(`${viewerUserId}:${cg.slug}:${cg.targetDate}`),
    );
  }

  const formatCell = (cg, scored) => {
    const { entry, rank, medal, points } = scored;
    const isActiveCycle = live
      ? entry.playDate === cg.puzzleStatus.activePuzzleDate
      : entry.playDate >= cg.puzzleStatus.activePuzzleDate;
    const redact = Boolean(isActiveCycle && entry.userId !== viewerUserId && !cg.viewerCleared);

    return {
      displayValue:
        entry.displayValue ??
        formatMetricValue(
          entry.primaryValue,
          cg.metricFormat,
          entry.solved === false ? 'DNF' : 'Played',
        ),
      primaryValue: entry.primaryValue,
      solved: entry.solved,
      puzzleId: entry.puzzleId ?? null,
      difficulty: getEntryDifficulty(entry),
      rank,
      medal,
      points,
      spoilerProtected: redact,
      emojiGrid: redact ? null : extractShareGrid(entry),
      notes: redact ? '' : String(entry.notes || ''),
    };
  };

  const gamesByUserId = new Map();
  for (const g of allGames) {
    if (!g || g.userId === null || g.userId === undefined) continue;
    let list = gamesByUserId.get(g.userId);
    if (!list) {
      list = [];
      gamesByUserId.set(g.userId, list);
    }
    list.push(g);
  }

  const entriesByUserId = new Map();
  for (const e of allEntries) {
    if (!e || e.userId === null || e.userId === undefined) continue;
    let list = entriesByUserId.get(e.userId);
    if (!list) {
      list = [];
      entriesByUserId.set(e.userId, list);
    }
    list.push(e);
  }

  const overallRows = users.map((user) => {
    const windowScored = scoredWindowByUser.get(user.id) || [];
    let arcadePoints = 0;
    const medals = { gold: 0, silver: 0, bronze: 0 };

    for (const s of windowScored) {
      arcadePoints += s.points;
      if (s.medal === 'gold') medals.gold += 1;
      else if (s.medal === 'silver') medals.silver += 1;
      else if (s.medal === 'bronze') medals.bronze += 1;
    }

    const userGames = gamesByUserId.get(user.id) || [];
    const userEntries = entriesByUserId.get(user.id) || [];
    const completedUserEntries = userEntries.filter((e) => e.completed);

    let clearedTodayCount = 0;
    let todayPoints = 0;
    const todayMedals = { gold: 0, silver: 0, bronze: 0 };
    for (const cg of catalogGames) {
      const todayScored = scoredByUserSlugDate.get(`${user.id}:${cg.slug}:${cg.targetDate}`);
      if (todayScored) {
        clearedTodayCount += 1;
        todayPoints += todayScored.points;
        if (todayScored.medal === 'gold') todayMedals.gold += 1;
        else if (todayScored.medal === 'silver') todayMedals.silver += 1;
        else if (todayScored.medal === 'bronze') todayMedals.bronze += 1;
      }
    }

    const routineOverview = computeDailyOverview(userGames, userEntries, referenceDate, {
      live,
      now,
      viewerTimeZone,
    });
    const activeGamesCount = userGames.filter((g) => !g.archived).length || catalogGames.length;
    const routineStreak = completedUserEntries.length === 0 ? 0 : routineOverview.routineStreak;
    const fullSweepDays = completedUserEntries.length === 0 ? 0 : routineOverview.fullSweepDays;

    return {
      rank: 0,
      userId: user.id,
      displayName: user.displayName,
      isViewer: user.id === viewerUserId,
      arcadePoints,
      medals,
      clearedTodayCount,
      todayPoints,
      todayMedals,
      todayRank: null,
      activeGamesCount,
      routineStreak,
      fullSweepDays,
      totalPlayed: windowScored.length,
    };
  });

  const todayQualified = overallRows.filter(
    (row) => row.clearedTodayCount > 0 || row.todayPoints > 0,
  );
  todayQualified.sort(
    (a, b) =>
      b.todayPoints - a.todayPoints ||
      b.clearedTodayCount - a.clearedTodayCount ||
      b.todayMedals.gold - a.todayMedals.gold ||
      a.displayName.localeCompare(b.displayName),
  );
  let prevToday = null;
  todayQualified.forEach((row, idx) => {
    if (
      prevToday &&
      prevToday.todayPoints === row.todayPoints &&
      prevToday.clearedTodayCount === row.clearedTodayCount &&
      prevToday.todayMedals.gold === row.todayMedals.gold
    ) {
      row.todayRank = prevToday.todayRank;
    } else {
      row.todayRank = idx + 1;
    }
    prevToday = row;
  });

  overallRows.sort(
    (a, b) =>
      b.arcadePoints - a.arcadePoints ||
      b.routineStreak - a.routineStreak ||
      b.clearedTodayCount - a.clearedTodayCount ||
      b.medals.gold - a.medals.gold ||
      b.totalPlayed - a.totalPlayed ||
      a.displayName.localeCompare(b.displayName),
  );

  let prevOverall = null;
  overallRows.forEach((row, idx) => {
    if (
      prevOverall &&
      prevOverall.arcadePoints === row.arcadePoints &&
      prevOverall.routineStreak === row.routineStreak &&
      prevOverall.clearedTodayCount === row.clearedTodayCount &&
      prevOverall.medals.gold === row.medals.gold &&
      prevOverall.totalPlayed === row.totalPlayed
    ) {
      row.rank = prevOverall.rank;
    } else {
      row.rank = idx + 1;
    }
    prevOverall = row;
  });

  const serializeCatalogGame = (cg) => {
    const slugEntries = dedupedEntriesBySlug.get(cg.slug) || [];
    const diffOptions = buildDifficultyOptions(cg, slugEntries);
    const supportsDiff = Boolean(
      isDifficultyNativeGame(cg) || diffOptions.some((d) => d.count > 0),
    );
    return {
      slug: cg.slug,
      name: cg.name,
      icon: cg.icon,
      color: cg.color,
      category: cg.category,
      url: cg.url,
      metricLabel: cg.metricLabel,
      metricFormat: cg.metricFormat,
      metricDirection: cg.metricDirection,
      resetTimezone: cg.resetTimezone,
      resetTime: cg.resetTime,
      targetDate: cg.targetDate,
      viewerCleared: cg.viewerCleared,
      viewerHasGame: viewerActiveSlugs.has(cg.slug),
      viewerArchivedGame: !viewerActiveSlugs.has(cg.slug) && viewerArchivedSlugs.has(cg.slug),
      playerCount: activePlayersBySlug.get(cg.slug)?.size || 0,
      supportsDifficulty: supportsDiff,
    };
  };

  const catalogGamesOut = catalogGames.map(serializeCatalogGame);

  const matrixRows = overallRows.map((player) => {
    const cells = {};
    let clearedCount = 0;
    let todayPoints = 0;
    for (const cg of catalogGames) {
      const scored = scoredByUserSlugDate.get(`${player.userId}:${cg.slug}:${cg.targetDate}`);
      if (scored) {
        cells[cg.slug] = formatCell(cg, scored);
        clearedCount += 1;
        todayPoints += scored.points;
      } else {
        cells[cg.slug] = null;
      }
    }
    return {
      userId: player.userId,
      displayName: player.displayName,
      isViewer: player.isViewer,
      clearedCount,
      todayPoints: player.todayPoints,
      todayMedals: player.todayMedals,
      todayRank: player.todayRank,
      cells,
    };
  });

  const selectedCatalogGame =
    (gameSlug && catalogGames.find((g) => g.slug === gameSlug)) || catalogGames[0] || null;
  const selectedCatalogGameOut = selectedCatalogGame
    ? {
        ...serializeCatalogGame(selectedCatalogGame),
        difficultyOptions: buildDifficultyOptions(
          selectedCatalogGame,
          dedupedEntriesBySlug.get(selectedCatalogGame.slug) || [],
        ),
        filters: {
          difficulty: activeDifficulty,
        },
      }
    : null;

  let gameStandings = [];
  if (selectedCatalogGame) {
    const slug = selectedCatalogGame.slug;
    gameStandings = users.map((user) => {
      const usKey = `${user.id}:${slug}`;
      const windowScoredAll = scoredWindowByUserSlug.get(usKey) || [];
      const windowScored = activeDifficulty
        ? windowScoredAll.filter((s) => getEntryDifficulty(s.entry) === activeDifficulty)
        : windowScoredAll;
      const allSlugEntries = (dedupedByUserSlug.get(usKey) || []).map((item) => item.entry);

      let gamePoints = 0;
      const medals = { gold: 0, silver: 0, bronze: 0 };
      const numericVals = [];

      for (const s of windowScored) {
        gamePoints += s.points;
        if (s.medal === 'gold') medals.gold += 1;
        else if (s.medal === 'silver') medals.silver += 1;
        else if (s.medal === 'bronze') medals.bronze += 1;

        if (
          s.entry.solved !== false &&
          s.entry.primaryValue !== null &&
          s.entry.primaryValue !== undefined &&
          Number.isFinite(Number(s.entry.primaryValue))
        ) {
          numericVals.push(Number(s.entry.primaryValue));
        }
      }

      let averageValue = null;
      let averageDisplay = null;
      if (numericVals.length > 0) {
        const avg = numericVals.reduce((acc, v) => acc + v, 0) / numericVals.length;
        averageValue = round2(avg);
        averageDisplay = formatStatNumber(avg, selectedCatalogGame.metricFormat);
      }

      const pb = computePersonalBest(
        windowScored.map((s) => s.entry),
        selectedCatalogGame.metricDirection,
      );
      const { currentStreak, longestStreak } = computeStreaks(
        allSlugEntries,
        selectedCatalogGame.targetDate,
      );

      const todayScoredRaw = scoredByUserSlugDate.get(
        `${user.id}:${slug}:${selectedCatalogGame.targetDate}`,
      );
      const todayScored =
        todayScoredRaw &&
        (!activeDifficulty || getEntryDifficulty(todayScoredRaw.entry) === activeDifficulty)
          ? todayScoredRaw
          : null;

      return {
        rank: 0,
        userId: user.id,
        displayName: user.displayName,
        isViewer: user.id === viewerUserId,
        gamePoints,
        medals,
        totalPlayed: windowScored.length,
        currentStreak,
        longestStreak,
        averageValue,
        averageDisplay,
        personalBestDisplay: pb ? pb.displayValue : null,
        personalBestValue: pb ? pb.value : null,
        today: todayScored ? formatCell(selectedCatalogGame, todayScored) : null,
      };
    });

    gameStandings.sort(
      (a, b) =>
        b.gamePoints - a.gamePoints ||
        compareAverageNullable(a.averageValue, b.averageValue, selectedCatalogGame.metricDirection) ||
        b.currentStreak - a.currentStreak ||
        b.totalPlayed - a.totalPlayed ||
        a.displayName.localeCompare(b.displayName),
    );

    let prevGameRow = null;
    gameStandings.forEach((row, idx) => {
      if (
        prevGameRow &&
        prevGameRow.gamePoints === row.gamePoints &&
        prevGameRow.averageValue === row.averageValue &&
        prevGameRow.currentStreak === row.currentStreak &&
        prevGameRow.totalPlayed === row.totalPlayed
      ) {
        row.rank = prevGameRow.rank;
      } else {
        row.rank = idx + 1;
      }
      prevGameRow = row;
    });
  }

  return {
    date: referenceDate,
    live: Boolean(live),
    days: hasWindowDays ? Math.trunc(days) : null,
    totalPlayers: users.length,
    selectedGameSlug: selectedCatalogGame ? selectedCatalogGame.slug : null,
    filters: {
      gameSlug: selectedCatalogGame ? selectedCatalogGame.slug : null,
      difficulty: activeDifficulty,
    },
    catalogGames: catalogGamesOut,
    overallStandings: overallRows,
    todayMatrix: {
      games: catalogGamesOut,
      rows: matrixRows,
    },
    gameBoard: {
      game: selectedCatalogGameOut,
      standings: gameStandings,
    },
  };
}
