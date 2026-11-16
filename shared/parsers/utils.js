/**
 * Pure browser- & Node-compatible utility helpers for Daily Games parsers.
 * Zero Node built-ins and zero external dependencies.
 */

const VALID_METRIC_FORMATS = new Set(['number', 'duration_sec', 'percent', 'fraction']);

/**
 * Convert a string into a lowercase hyphenated slug.
 * e.g. "Clues by Sam" -> "clues-by-sam"
 */
export function slugify(str) {
  if (str == null) return '';
  return String(str)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Convert a string into a lowercase alphanumeric-only slug.
 * e.g. "Clues by Sam" -> "cluesbysam"
 */
export function compactSlug(str) {
  if (str == null) return '';
  return String(str)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Extract lowercase hostname without leading "www." from a URL string.
 * Returns "" safely on invalid or empty input.
 */
export function extractDomain(url) {
  if (typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  let candidate = trimmed;

  if (!hasScheme) {
    // Reject obvious non-URLs (whitespace, missing dot, emails, bare paths)
    if (/[\s@]/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('.') || !trimmed.includes('.')) {
      return '';
    }
    candidate = `https://${trimmed}`;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (!hostname || hostname.endsWith('.')) return '';
    // Ensure a bare scheme-less input actually had a valid host with a dot
    if (!hasScheme && !hostname.includes('.')) return '';
    return hostname;
  } catch {
    return '';
  }
}

/**
 * Format a Date object into local YYYY-MM-DD (never using UTC toISOString()).
 */
export function getLocalDateString(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  const year = String(d.getFullYear()).padStart(4, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Parse a duration string ("2:14", "01:02:03", "1m 20s", "45s") into seconds.
 * Returns null if the string is not a recognized duration.
 */
export function parseDurationSeconds(str) {
  if (typeof str !== 'string') return null;
  const trimmed = str.trim();
  if (!trimmed) return null;

  const hmsMatch = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/.exec(trimmed);
  if (hmsMatch) {
    const hours = Number(hmsMatch[1]);
    const minutes = Number(hmsMatch[2]);
    const seconds = Number(hmsMatch[3]);
    return hours * 3600 + minutes * 60 + seconds;
  }

  const msMatch = /^(\d{1,4}):([0-5]\d)$/.exec(trimmed);
  if (msMatch) {
    const minutes = Number(msMatch[1]);
    const seconds = Number(msMatch[2]);
    return minutes * 60 + seconds;
  }

  const unitMatch =
    /^(?:(\d+)\s*(?:h|hr|hrs|hour|hours)\s*)?(?:(\d+)\s*(?:m|min|mins|minute|minutes)\s*)?(?:(\d+)\s*(?:s|sec|secs|second|seconds))?$/i.exec(
      trimmed
    );
  if (unitMatch && (unitMatch[1] !== undefined || unitMatch[2] !== undefined || unitMatch[3] !== undefined)) {
    const hours = unitMatch[1] !== undefined ? Number(unitMatch[1]) : 0;
    const minutes = unitMatch[2] !== undefined ? Number(unitMatch[2]) : 0;
    const seconds = unitMatch[3] !== undefined ? Number(unitMatch[3]) : 0;
    return hours * 3600 + minutes * 60 + seconds;
  }

  return null;
}

/**
 * Format seconds into "m:ss" or "h:mm:ss".
 * Handles 0 -> "0:00", non-finite/null/negative -> "".
 */
export function formatDurationSeconds(sec) {
  if (sec === null || sec === undefined || sec === '' || typeof sec === 'boolean') {
    return '';
  }
  const num = Number(sec);
  if (!Number.isFinite(num) || num < 0) {
    return '';
  }

  const total = Math.round(num);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatNumericClean(num) {
  if (Number.isInteger(num)) {
    return String(num);
  }
  return String(Number(num.toFixed(2)));
}

/**
 * Format a numeric metric value according to metricFormat.
 * Returns fallbackDisplay ?? 'Played' when value is null/undefined/NaN/non-finite.
 */
export function formatMetricValue(value, metricFormat = 'number', fallbackDisplay = null) {
  const fallback = fallbackDisplay ?? 'Played';
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return fallback;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }

  const format = VALID_METRIC_FORMATS.has(metricFormat) ? metricFormat : 'number';

  if (format === 'duration_sec') {
    return formatDurationSeconds(num) || fallback;
  }
  if (format === 'percent') {
    return `${formatNumericClean(num)}%`;
  }
  // Both 'number' and 'fraction' (when only a scalar number is provided, e.g. average guesses)
  return formatNumericClean(num);
}

/**
 * Extract an explicit YYYY-MM-DD calendar date from text if present and valid.
 */
export function extractExplicitDate(text) {
  if (typeof text !== 'string' || !text) return null;
  const regex = /\b((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const check = new Date(year, month - 1, day);
    if (
      check.getFullYear() === year &&
      check.getMonth() === month - 1 &&
      check.getDate() === day
    ) {
      return match[0];
    }
  }
  return null;
}

/**
 * Extract #puzzleId (e.g. "#142", "#1,234" -> "#1234") outside of URLs.
 */
export function extractPuzzleId(text) {
  if (typeof text !== 'string' || !text) return null;
  const withoutUrls = text.replace(/https?:\/\/\S+/gi, ' ');
  const match = /(?:^|[\s(])#(\d[\d,]*)(?=$|[\s).,!?:;])/m.exec(withoutUrls);
  if (!match) return null;
  return `#${match[1].replace(/,/g, '')}`;
}

/**
 * Extract lines representing an emoji share grid (Wordle squares, status pips, etc.).
 */
export function extractEmojiGrid(text) {
  if (typeof text !== 'string' || !text) return '';
  const lines = text.split(/\r?\n/);
  const gridLines = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // Must not contain normal ASCII alphanumeric characters or punctuation used in prose
    if (/[a-z0-9]/i.test(line)) continue;

    const stripped = line.replace(/\s+/g, '');
    if (!stripped) continue;

    // Count pictographic / game-tile symbols
    const symbols = stripped.match(/[\p{Extended_Pictographic}\u2B1B\u2B1C\u2B50\u2705\u274C\u2B55]/gu);
    if (!symbols || symbols.length < 2) continue;

    // Ensure the line consists exclusively of pictographs, variation selectors, ZWJ, and whitespace
    const remainder = line
      .replace(/[\p{Extended_Pictographic}\u2B1B\u2B1C\u2B50\u2705\u274C\u2B55\uFE0F\u200D\s]/gu, '');
    if (remainder.length === 0) {
      gridLines.push(line);
    }
  }

  // Require at least 2 rows, or 1 row of >= 3 emojis (e.g., 1-row share bar like 🟩🟩🟩🟩🟩 or ✅✅❌✅)
  if (gridLines.length === 1) {
    const symbols = gridLines[0].match(/[\p{Extended_Pictographic}\u2B1B\u2B1C\u2B50\u2705\u274C\u2B55]/gu);
    if (!symbols || symbols.length < 3) {
      return '';
    }
  }

  return gridLines.join('\n');
}

export const COMMON_RESET_TIMEZONES = [
  { id: 'local', label: 'Local midnight (Device time)' },
  { id: 'UTC', label: 'UTC' },
  { id: 'America/New_York', label: 'US Eastern (ET)' },
  { id: 'America/Los_Angeles', label: 'US Pacific (PT)' },
  { id: 'America/Chicago', label: 'US Central (CT)' },
  { id: 'Europe/London', label: 'UK (London)' },
  { id: 'Europe/Berlin', label: 'Central Europe (CET/CEST)' },
  { id: 'Asia/Kolkata', label: 'India (IST)' },
  { id: 'Asia/Tokyo', label: 'Japan (JST)' },
  { id: 'Australia/Sydney', label: 'Australia Eastern (AEST/AEDT)' },
];

const RESET_TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const zonedPartsFormatterCache = new Map();
const localTimeFormatterCache = new Map();

/**
 * Return true if tz is 'local' or a valid IANA timezone recognized by Intl.DateTimeFormat.
 */
export function isValidResetTimezone(tz) {
  if (typeof tz !== 'string' || !tz || tz !== tz.trim()) {
    return false;
  }
  if (tz === 'local') {
    return true;
  }
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return true if hhmm matches 24-hour "HH:MM" (00:00 - 23:59).
 */
export function isValidResetTime(hhmm) {
  return typeof hhmm === 'string' && RESET_TIME_REGEX.test(hhmm);
}

/**
 * Format a non-negative duration in milliseconds into compact countdown text
 * ("< 1m", "42m", "2h 45m", "12h 0m").
 */
export function formatCountdownCompact(ms) {
  if (ms === null || ms === undefined || ms === '' || typeof ms === 'boolean') {
    return '';
  }
  const num = Number(ms);
  if (!Number.isFinite(num)) {
    return '';
  }
  const safeMs = Math.max(0, num);
  if (safeMs < 60_000) {
    return '< 1m';
  }
  const totalMinutes = Math.floor(safeMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return `${minutes}m`;
  }
  return `${hours}h ${minutes}m`;
}

function resolveViewerTimeZone(viewerTimeZone) {
  if (
    typeof viewerTimeZone === 'string' &&
    viewerTimeZone !== 'local' &&
    isValidResetTimezone(viewerTimeZone)
  ) {
    return viewerTimeZone;
  }
  try {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof detected === 'string' && detected !== 'local' && isValidResetTimezone(detected)) {
      return detected;
    }
  } catch {
    // ignore
  }
  return 'UTC';
}

function getZonedPartsFormatter(timeZone) {
  let formatter = zonedPartsFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    zonedPartsFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function getLocalTimeFormatter(timeZone) {
  let formatter = localTimeFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
    });
    localTimeFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function getZonedParts(epochMs, timeZone) {
  const parts = getZonedPartsFormatter(timeZone).formatToParts(new Date(epochMs));
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;

  for (const part of parts) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') day = Number(part.value);
    else if (part.type === 'hour') hour = Number(part.value);
    else if (part.type === 'minute') minute = Number(part.value);
    else if (part.type === 'second') second = Number(part.value);
  }

  if (hour === 24) hour = 0;
  return { year, month, day, hour, minute, second };
}

function formatYmd(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addDaysYmd(year, month, day, deltaDays) {
  const utc = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
}

function getTimeZoneOffsetMs(epochMs, timeZone) {
  const wholeSecondEpoch = Math.floor(epochMs / 1000) * 1000;
  const p = getZonedParts(wholeSecondEpoch, timeZone);
  const wallAsUtcMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtcMs - wholeSecondEpoch;
}

function wallPartsToUtcMs(p) {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second ?? 0);
}

/**
 * DST-safe 2-pass offset refinement mapping a target wall-clock time in timeZone
 * to UTC epoch milliseconds (matching Temporal 'compatible' disambiguation).
 */
function zonedWallClockToEpochMs(target, timeZone) {
  const targetWallAsUtcMs = wallPartsToUtcMs(target);

  // Pass 1: estimate using offset at the target timestamp treated as UTC
  const offset1 = getTimeZoneOffsetMs(targetWallAsUtcMs, timeZone);
  let guessMs = targetWallAsUtcMs - offset1;

  // Pass 2: refine using offset at the first-pass instant
  const offset2 = getTimeZoneOffsetMs(guessMs, timeZone);
  guessMs = targetWallAsUtcMs - offset2;

  const actualWallAsUtcMs = wallPartsToUtcMs(getZonedParts(guessMs, timeZone));
  if (actualWallAsUtcMs !== targetWallAsUtcMs) {
    // Handle Spring Forward non-existent wall clock (or large offset shift)
    const offset3 = getTimeZoneOffsetMs(guessMs, timeZone);
    guessMs = targetWallAsUtcMs - offset3;
  } else {
    // Handle Fall Back ambiguous wall clock: prefer the earlier ('compatible') occurrence
    const earlierOffset = getTimeZoneOffsetMs(guessMs - 3_600_000, timeZone);
    const earlierGuessMs = targetWallAsUtcMs - earlierOffset;
    if (
      earlierGuessMs < guessMs &&
      wallPartsToUtcMs(getZonedParts(earlierGuessMs, timeZone)) === targetWallAsUtcMs
    ) {
      guessMs = earlierGuessMs;
    }
  }

  return guessMs;
}

/**
 * Compute active puzzle date, next reset timestamp, and countdown status for a game
 * based on its configured resetTimezone and resetTime.
 */
export function getGamePuzzleStatus(game = {}, now = new Date(), viewerTimeZone = undefined) {
  const rawTz = game?.resetTimezone;
  const resetTimezone = typeof rawTz === 'string' && isValidResetTimezone(rawTz) ? rawTz : 'local';
  const rawTime = game?.resetTime;
  const resetTime = isValidResetTime(rawTime) ? rawTime : '00:00';

  const resolvedViewerTz = resolveViewerTimeZone(viewerTimeZone);
  const resolvedTimezone = resetTimezone === 'local' ? resolvedViewerTz : resetTimezone;

  const parsedNow = now instanceof Date ? now : new Date(now);
  const safeNow = Number.isNaN(parsedNow.getTime()) ? new Date() : parsedNow;
  const nowMs = safeNow.getTime();

  const [resetHour, resetMinute] = resetTime.split(':').map(Number);

  let activePuzzleDate;
  let localTodayDate;
  let nextResetEpochMs;
  let msUntilReset;

  if (typeof globalThis.Temporal !== 'undefined') {
    const instant = globalThis.Temporal.Instant.fromEpochMilliseconds(nowMs);
    const currentZdt = instant.toZonedDateTimeISO(resolvedTimezone);
    const viewerZdt = currentZdt.withTimeZone(resolvedViewerTz);

    const isBeforeReset =
      currentZdt.hour * 60 + currentZdt.minute < resetHour * 60 + resetMinute;
    const currentPlainDate = currentZdt.toPlainDate();
    const activePlainDate = isBeforeReset
      ? currentPlainDate.subtract({ days: 1 })
      : currentPlainDate;
    const nextResetPlainDate = isBeforeReset
      ? currentPlainDate
      : currentPlainDate.add({ days: 1 });

    const nextResetZdt = globalThis.Temporal.ZonedDateTime.from(
      {
        timeZone: resolvedTimezone,
        year: nextResetPlainDate.year,
        month: nextResetPlainDate.month,
        day: nextResetPlainDate.day,
        hour: resetHour,
        minute: resetMinute,
        second: 0,
      },
      { disambiguation: 'compatible' }
    );

    const duration = currentZdt.until(nextResetZdt, { largestUnit: 'hour' });
    activePuzzleDate = activePlainDate.toString();
    localTodayDate = viewerZdt.toPlainDate().toString();
    nextResetEpochMs = nextResetZdt.epochMilliseconds;
    msUntilReset = Math.max(
      0,
      duration.total({ unit: 'millisecond', relativeTo: currentZdt })
    );
  } else {
    const currentParts = getZonedParts(nowMs, resolvedTimezone);
    const viewerParts =
      resolvedViewerTz === resolvedTimezone
        ? currentParts
        : getZonedParts(nowMs, resolvedViewerTz);

    const isBeforeReset =
      currentParts.hour * 60 + currentParts.minute < resetHour * 60 + resetMinute;
    const activeYmd = isBeforeReset
      ? addDaysYmd(currentParts.year, currentParts.month, currentParts.day, -1)
      : { year: currentParts.year, month: currentParts.month, day: currentParts.day };
    const nextResetYmd = isBeforeReset
      ? { year: currentParts.year, month: currentParts.month, day: currentParts.day }
      : addDaysYmd(currentParts.year, currentParts.month, currentParts.day, 1);

    activePuzzleDate = formatYmd(activeYmd.year, activeYmd.month, activeYmd.day);
    localTodayDate = formatYmd(viewerParts.year, viewerParts.month, viewerParts.day);
    nextResetEpochMs = zonedWallClockToEpochMs(
      {
        year: nextResetYmd.year,
        month: nextResetYmd.month,
        day: nextResetYmd.day,
        hour: resetHour,
        minute: resetMinute,
        second: 0,
      },
      resolvedTimezone
    );
    msUntilReset = Math.max(0, nextResetEpochMs - nowMs);
  }

  return {
    resetTimezone,
    resolvedTimezone,
    resetTime,
    activePuzzleDate,
    localTodayDate,
    isOffLocalDate: activePuzzleDate !== localTodayDate,
    nextResetEpochMs,
    nextResetIso: new Date(nextResetEpochMs).toISOString(),
    msUntilReset,
    secondsUntilReset: Math.max(0, Math.floor(msUntilReset / 1000)),
    countdownLabel: formatCountdownCompact(msUntilReset),
    nextResetLocalTime: getLocalTimeFormatter(resolvedViewerTz).format(new Date(nextResetEpochMs)),
  };
}
