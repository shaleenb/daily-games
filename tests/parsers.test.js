import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  slugify,
  compactSlug,
  extractDomain,
  extractEmojiGrid,
  getLocalDateString,
  parseDurationSeconds,
  formatDurationSeconds,
  formatMetricValue,
  COMMON_RESET_TIMEZONES,
  isValidResetTimezone,
  isValidResetTime,
  formatCountdownCompact,
  getGamePuzzleStatus,
  CLUES_BY_SAM_DIFFICULTIES,
  normalizeDifficultyLabel,
  ERALY_BANDS,
  PERCEPTLE_ROUNDS,
  PARSERS,
  GENERIC_PARSER,
  getParserById,
  getParserForGame,
  parseForGame,
  detectGameAndParse,
} from '../shared/parsers/registry.js';
import { cluesBySamParser } from '../shared/parsers/games/cluesbysam.js';
import { eralyParser } from '../shared/parsers/games/eraly.js';
import { fermiParser } from '../shared/parsers/games/fermi.js';
import { magnitudleParser } from '../shared/parsers/games/magnitudle.js';
import { perceptleParser } from '../shared/parsers/games/perceptle.js';
import { plainParser } from '../shared/parsers/games/plain.js';
import { timeguessrParser } from '../shared/parsers/games/timeguessr.js';
import { wordleParser } from '../shared/parsers/games/wordle.js';
import { extractPuzzleId } from '../shared/parsers/utils.js';
import { STARTER_GAMES } from '../shared/auth-crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARED_PARSERS_DIR = path.resolve(__dirname, '../shared/parsers');

function collectJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(fullPath);
    }
  }
  return out;
}

test('browser compatibility: shared/parsers has zero Node built-ins and uses explicit .js relative imports', () => {
  const files = collectJsFiles(SHARED_PARSERS_DIR);
  assert.ok(files.length >= 4);
  for (const filePath of files) {
    const src = fs.readFileSync(filePath, 'utf8');
    assert.equal(/\bfrom\s+['"]node:/.test(src), false, `Found node: import in ${filePath}`);
    assert.equal(/\bfrom\s+['"](?:fs|path|process|os|url|crypto|http|sqlite)['"]/.test(src), false, `Found bare Node built-in in ${filePath}`);
    assert.equal(/\bprocess\.|\brequire\s*\(/.test(src), false, `Found process/require in ${filePath}`);
    const relativeImports = [...src.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
    for (const imp of relativeImports) {
      assert.ok(imp.endsWith('.js'), `Relative import "${imp}" in ${filePath} must end with .js`);
    }
  }
});

test('utils: slugify and compactSlug', () => {
  assert.equal(slugify('Clues by Sam'), 'clues-by-sam');
  assert.equal(slugify("  Sam's Daily Puzzle!  "), 'sams-daily-puzzle');
  assert.equal(slugify('Café Wordle #2'), 'cafe-wordle-2');
  assert.equal(slugify(''), '');
  assert.equal(slugify(null), '');

  assert.equal(compactSlug('Clues by Sam'), 'cluesbysam');
  assert.equal(compactSlug('NYT Connections: #1'), 'nytconnections1');
  assert.equal(compactSlug(undefined), '');
});

test('utils: extractDomain handles valid, scheme-less, and invalid URLs safely', () => {
  assert.equal(extractDomain('https://www.cluesbysam.com/x'), 'cluesbysam.com');
  assert.equal(extractDomain('http://nytimes.com/games/wordle'), 'nytimes.com');
  assert.equal(extractDomain('https://games.nytimes.com/wordle'), 'games.nytimes.com');
  assert.equal(extractDomain('www.krillion.io/daily'), 'krillion.io');
  assert.equal(extractDomain('farflunggame.fun'), 'farflunggame.fun');
  assert.equal(extractDomain('http://localhost:4321/play'), 'localhost');

  assert.equal(extractDomain(''), '');
  assert.equal(extractDomain('   '), '');
  assert.equal(extractDomain(null), '');
  assert.equal(extractDomain('not a url'), '');
  assert.equal(extractDomain('javascript:alert(1)'), '');
  assert.equal(extractDomain('user@example.com'), '');
});

test('utils: getLocalDateString formats local calendar date', () => {
  const localMidnight = new Date(2026, 0, 5, 0, 5, 0);
  assert.equal(getLocalDateString(localMidnight), '2026-01-05');

  const localLateNight = new Date(2026, 10, 15, 23, 55, 0);
  assert.equal(getLocalDateString(localLateNight), '2026-11-15');
});

test('utils: parseDurationSeconds & formatDurationSeconds', () => {
  assert.equal(parseDurationSeconds('2:14'), 134);
  assert.equal(parseDurationSeconds('01:02:03'), 3723);
  assert.equal(parseDurationSeconds('1m 20s'), 80);
  assert.equal(parseDurationSeconds('45s'), 45);
  assert.equal(parseDurationSeconds('1h 2m 3s'), 3723);
  assert.equal(parseDurationSeconds('0:00'), 0);
  assert.equal(parseDurationSeconds('2 min 5 sec'), 125);

  assert.equal(parseDurationSeconds('1:65'), null);
  assert.equal(parseDurationSeconds('120'), null);
  assert.equal(parseDurationSeconds('abc'), null);
  assert.equal(parseDurationSeconds(''), null);
  assert.equal(parseDurationSeconds(null), null);

  assert.equal(formatDurationSeconds(134), '2:14');
  assert.equal(formatDurationSeconds(3723), '1:02:03');
  assert.equal(formatDurationSeconds(0), '0:00');
  assert.equal(formatDurationSeconds(5), '0:05');
  assert.equal(formatDurationSeconds(null), '');
  assert.equal(formatDurationSeconds(undefined), '');
  assert.equal(formatDurationSeconds(NaN), '');
  assert.equal(formatDurationSeconds(Infinity), '');
  assert.equal(formatDurationSeconds(-5), '');
});

test('utils: formatMetricValue formats all metric types and fallbacks', () => {
  assert.equal(formatMetricValue(134, 'duration_sec'), '2:14');
  assert.equal(formatMetricValue(0, 'duration_sec'), '0:00');
  assert.equal(formatMetricValue(88, 'percent'), '88%');
  assert.equal(formatMetricValue(87.5, 'percent'), '87.5%');
  assert.equal(formatMetricValue(840, 'number'), '840');
  assert.equal(formatMetricValue(4.25, 'fraction'), '4.25');
  assert.equal(formatMetricValue(0, 'number'), '0');

  assert.equal(formatMetricValue(null, 'number'), 'Played');
  assert.equal(formatMetricValue(undefined, 'duration_sec'), 'Played');
  assert.equal(formatMetricValue(NaN, 'percent', '—'), '—');
  assert.equal(formatMetricValue('', 'number', 'DNF'), 'DNF');
});

test('wordleParser: parses standard wins, hard mode, colorblind tiles, and X/6 losses', () => {
  const winText = [
    'Wordle 1,234 4/6',
    '',
    '⬜🟨⬜⬜⬜',
    '⬜🟩🟨⬜⬜',
    '🟩🟩⬜🟩⬜',
    '🟩🟩🟩🟩🟩',
  ].join('\n');

  assert.equal(wordleParser.canParse(winText), true);
  const win = wordleParser.parse(winText);
  assert.equal(win.parserId, 'wordle');
  assert.equal(win.parserVersion, 1);
  assert.equal(win.isCustomParser, true);
  assert.equal(win.completed, true);
  assert.equal(win.solved, true);
  assert.equal(win.primaryValue, 4);
  assert.equal(win.displayValue, '4/6');
  assert.equal(win.metricFormat, 'fraction');
  assert.equal(win.metricDirection, 'lower_is_better');
  assert.equal(win.metricLabel, 'Guesses');
  assert.equal(win.puzzleId, '#1234');
  assert.equal(win.puzzleDate, null);
  assert.equal(win.metadata.hardMode, false);
  assert.ok(win.metadata.emojiGrid.includes('🟩🟩🟩🟩🟩'));
  assert.equal(win.breakdown.length, 4);
  assert.deepEqual(win.breakdown[0], {
    label: 'Guess 1',
    value: 0,
    max: 5,
    display: '0 exact, 1 present',
  });
  assert.deepEqual(win.breakdown[3], {
    label: 'Guess 4',
    value: 5,
    max: 5,
    display: '5 exact, 0 present',
  });

  const hardColorblind = [
    'Wordle 999 3/6*',
    '⬛️🟦⬛️⬛️⬛️',
    '🟧🟧🟦⬛️⬛️',
    '🟧🟧🟧🟧🟧',
  ].join('\n');
  const hard = wordleParser.parse(hardColorblind);
  assert.equal(hard.solved, true);
  assert.equal(hard.primaryValue, 3);
  assert.equal(hard.displayValue, '3/6');
  assert.equal(hard.puzzleId, '#999');
  assert.equal(hard.metadata.hardMode, true);
  assert.equal(hard.breakdown.length, 3);
  assert.equal(hard.breakdown[2].value, 5);

  const lossText = [
    'Wordle 1,234 X/6',
    '⬛🟨⬛⬛⬛',
    '⬛🟩⬛⬛⬛',
    '⬛🟩⬛🟨⬛',
    '🟩🟩⬛🟨⬛',
    '🟩🟩🟩⬛⬛',
    '🟩🟩🟩⬛⬛',
  ].join('\n');
  assert.equal(wordleParser.canParse(lossText), true);
  const loss = wordleParser.parse(lossText);
  assert.equal(loss.solved, false);
  assert.equal(loss.primaryValue, null);
  assert.equal(loss.displayValue, 'X/6');
  assert.equal(loss.puzzleId, '#1234');
  assert.equal(loss.breakdown.length, 6);

  assert.equal(wordleParser.canParse('Clues by Sam #142 2:14'), false);
});

test('GENERIC_PARSER: extracts durations, scores, fractions, percents, dates, puzzleIds, grids, and falls back cleanly', () => {
  // Duration guided by gameContext
  const clues = GENERIC_PARSER.parse(
    'I solved Clues by Sam #142 in 2:14!\nhttps://cluesbysam.com/puzzle/142',
    { metricFormat: 'duration_sec', metricDirection: 'lower_is_better', metricLabel: 'Solve Time' }
  );
  assert.equal(clues.parserId, 'generic');
  assert.equal(clues.isCustomParser, false);
  assert.equal(clues.primaryValue, 134);
  assert.equal(clues.displayValue, '2:14');
  assert.equal(clues.puzzleId, '#142');
  assert.equal(clues.solved, true);
  assert.equal(clues.metricFormat, 'duration_sec');
  assert.equal(clues.metricDirection, 'lower_is_better');
  assert.equal(clues.metricLabel, 'Solve Time');

  // Human unit duration
  const unitDur = GENERIC_PARSER.parse('Finished in 1m 20s', { metricFormat: 'duration_sec' });
  assert.equal(unitDur.primaryValue, 80);
  assert.equal(unitDur.displayValue, '1:20');

  // Clock time like 2:14 PM should NOT be parsed as duration
  const clockTime = GENERIC_PARSER.parse('Played at 2:14 PM today', { metricFormat: 'duration_sec' });
  assert.equal(clockTime.primaryValue, null);
  assert.equal(clockTime.displayValue, 'Played');

  // Score: N / 840 pts / 840/1000
  const labeled = GENERIC_PARSER.parse('Farflung #42 (2026-11-15)\nScore: 840/1000\n🟩🟩🟨⬜⬜', {
    metricFormat: 'number',
  });
  assert.equal(labeled.puzzleId, '#42');
  assert.equal(labeled.puzzleDate, '2026-11-15');
  assert.equal(labeled.primaryValue, 840);
  assert.equal(labeled.displayValue, '840/1000');
  assert.equal(labeled.metadata.emojiGrid, '🟩🟩🟨⬜⬜');
  assert.equal(labeled.metadata.maxScore, 1000);

  const pts = GENERIC_PARSER.parse('Krillion #88 - 1,250 pts', { metricFormat: 'number' });
  assert.equal(pts.puzzleId, '#88');
  assert.equal(pts.primaryValue, 1250);
  assert.equal(pts.displayValue, '1250');

  // Percentage (including when labeled "Score: 88.5%")
  const pct = GENERIC_PARSER.parse('Daily Quiz #12\nScore: 88.5%');
  assert.equal(pct.primaryValue, 88.5);
  assert.equal(pct.displayValue, '88.5%');
  assert.equal(pct.metricFormat, 'percent');

  // Fraction
  const frac = GENERIC_PARSER.parse('Daily Trivia #19\n4/5', { metricFormat: 'fraction' });
  assert.equal(frac.primaryValue, 4);
  assert.equal(frac.displayValue, '4/5');

  const dnfFrac = GENERIC_PARSER.parse('Puzzle #7 X/5', { metricFormat: 'fraction' });
  assert.equal(dnfFrac.primaryValue, null);
  assert.equal(dnfFrac.displayValue, 'X/5');
  assert.equal(dnfFrac.solved, false);

  // Standalone number without confusing #puzzleId or date
  const standalone = GENERIC_PARSER.parse('2026-11-15 Puzzle #142\n920');
  assert.equal(standalone.puzzleDate, '2026-11-15');
  assert.equal(standalone.puzzleId, '#142');
  assert.equal(standalone.primaryValue, 920);
  assert.equal(standalone.displayValue, '920');

  // Invalid calendar date ignored
  const badDate = GENERIC_PARSER.parse('2026-02-30 Played!');
  assert.equal(badDate.puzzleDate, null);

  // No-number fallback with emoji grid
  const noScore = GENERIC_PARSER.parse('Clues by Sam #142\n🟩🟩🟩\n🟩🟨🟩');
  assert.equal(noScore.puzzleId, '#142');
  assert.equal(noScore.primaryValue, null);
  assert.equal(noScore.displayValue, 'Played');
  assert.equal(noScore.metadata.emojiGrid, '🟩🟩🟩\n🟩🟨🟩');
});

test('registry: getParserById, getParserForGame, parseForGame', () => {
  assert.equal(PARSERS.length >= 1, true);
  assert.equal(getParserById('wordle'), wordleParser);
  assert.equal(getParserById('generic'), GENERIC_PARSER);
  assert.equal(getParserById('nonexistent'), null);

  // Auto-match by slug, name, compactSlug, and domain
  assert.equal(getParserForGame({ name: 'Wordle', slug: 'wordle', parserId: 'auto' }), wordleParser);
  assert.equal(getParserForGame({ name: 'NYT Wordle', url: 'https://www.nytimes.com/games/wordle' }), wordleParser);
  assert.equal(getParserForGame({ name: 'Custom', parserId: 'wordle' }), wordleParser);

  // Explicit 'generic' overrides auto domain/slug match
  assert.equal(
    getParserForGame({ name: 'Wordle', slug: 'wordle', url: 'https://nytimes.com/games/wordle', parserId: 'generic' }),
    GENERIC_PARSER
  );

  // Unmatched games fall back to GENERIC_PARSER (e.g. Krillion)
  const krillionGame = {
    name: 'Krillion',
    slug: 'krillion',
    url: 'https://krillion.io',
    metricFormat: 'number',
    metricDirection: 'higher_is_better',
    metricLabel: 'Score',
    parserId: 'auto',
  };
  assert.equal(getParserForGame(krillionGame), GENERIC_PARSER);

  const parsedKrillion = parseForGame('Krillion #88 - 840 pts', krillionGame);
  assert.equal(parsedKrillion.parserId, 'generic');
  assert.equal(parsedKrillion.primaryValue, 840);
  assert.equal(parsedKrillion.displayValue, '840');

  // Clues by Sam resolves to cluesBySamParser for both 'auto' and 'cluesbysam'
  assert.equal(
    getParserForGame({ name: 'Clues by Sam', slug: 'cluesbysam', url: 'https://cluesbysam.com', parserId: 'auto' }),
    cluesBySamParser
  );
  assert.equal(
    getParserForGame({ name: 'Clues by Sam', slug: 'cluesbysam', parserId: 'cluesbysam' }),
    cluesBySamParser
  );
  assert.equal(getParserById('cluesbysam'), cluesBySamParser);
  assert.equal(getParserById('plain'), plainParser);
  assert.equal(getParserById('timeguessr'), timeguessrParser);
});

test('registry: detectGameAndParse matches custom parsers, domains, names, compactSlugs, and unmatched text', () => {
  const games = [
    {
      id: 1,
      name: 'Clues by Sam',
      slug: 'cluesbysam',
      url: 'https://cluesbysam.com',
      metricFormat: 'duration_sec',
      metricDirection: 'lower_is_better',
      metricLabel: 'Solve Time',
      parserId: 'auto',
      archived: false,
      sortOrder: 1,
    },
    {
      id: 2,
      name: 'Krillion',
      slug: 'krillion',
      url: 'https://krillion.io',
      metricFormat: 'number',
      metricDirection: 'higher_is_better',
      metricLabel: 'Score',
      parserId: 'auto',
      archived: false,
      sortOrder: 2,
    },
    {
      id: 3,
      name: 'Farflung',
      slug: 'farflung',
      url: 'https://farflunggame.fun',
      metricFormat: 'number',
      metricDirection: 'higher_is_better',
      metricLabel: 'Score',
      parserId: 'auto',
      archived: false,
      sortOrder: 3,
    },
    {
      id: 4,
      name: 'Wordle',
      slug: 'wordle',
      url: 'https://www.nytimes.com/games/wordle',
      metricFormat: 'fraction',
      metricDirection: 'lower_is_better',
      metricLabel: 'Guesses',
      parserId: 'auto',
      archived: false,
      sortOrder: 4,
    },
    {
      id: 5,
      name: 'Old Archived Game',
      slug: 'oldarchived',
      url: 'https://oldarchived.example',
      metricFormat: 'number',
      metricDirection: 'higher_is_better',
      metricLabel: 'Score',
      parserId: 'auto',
      archived: true,
      sortOrder: 5,
    },
  ];

  // 1. Custom parser match (Wordle in games list)
  const wordleRes = detectGameAndParse('Wordle 1,234 4/6\n🟩🟩🟩🟩🟩', games);
  assert.equal(wordleRes.matchedGame?.id, 4);
  assert.equal(wordleRes.confidence, 'high');
  assert.equal(wordleRes.parserId, 'wordle');
  assert.equal(wordleRes.parsed.primaryValue, 4);

  // 2. Custom parser match when Wordle is NOT in games list
  const wordleUnlisted = detectGameAndParse('Wordle 1,234 5/6', games.slice(0, 3));
  assert.equal(wordleUnlisted.matchedGame, null);
  assert.equal(wordleUnlisted.confidence, 'high');
  assert.equal(wordleUnlisted.parserId, 'wordle');
  assert.equal(wordleUnlisted.parsed.primaryValue, 5);

  // 3. Generic domain match (Krillion)
  const domainMatch = detectGameAndParse('Today puzzle #55: 840 pts\nhttps://www.krillion.io/play', games);
  assert.equal(domainMatch.matchedGame?.id, 2);
  assert.equal(domainMatch.confidence, 'high');
  assert.equal(domainMatch.parserId, 'generic');
  assert.equal(domainMatch.parsed.primaryValue, 840);

  // 4. Name match
  const nameMatch = detectGameAndParse('Farflung #42 - Score: 910/1000', games);
  assert.equal(nameMatch.matchedGame?.id, 3);
  assert.equal(nameMatch.confidence, 'high');
  assert.equal(nameMatch.parsed.primaryValue, 910);

  // 5. Custom Clues by Sam match via #CluesBySam
  const cluesMatch = detectGameAndParse('#CluesBySam #142 45s', games);
  assert.equal(cluesMatch.matchedGame?.id, 1);
  assert.equal(cluesMatch.confidence, 'high');
  assert.equal(cluesMatch.parserId, 'cluesbysam');
  assert.equal(cluesMatch.parsed.puzzleId, '#142');
  assert.equal(cluesMatch.parsed.primaryValue, 45);
  assert.equal(cluesMatch.parsed.displayValue, '0:45');

  // 5b. CompactSlug hashtag match on generic game
  const compactGames = [
    ...games,
    {
      id: 6,
      name: 'Daily Mix',
      slug: 'dailymix',
      url: 'https://dailymix.example',
      metricFormat: 'number',
      metricDirection: 'higher_is_better',
      metricLabel: 'Score',
      parserId: 'auto',
      archived: false,
      sortOrder: 6,
    },
  ];
  const compactMatch = detectGameAndParse('#DailyMix #99 777 pts', compactGames);
  assert.equal(compactMatch.matchedGame?.id, 6);
  assert.equal(compactMatch.confidence, 'medium');
  assert.equal(compactMatch.parserId, 'generic');
  assert.equal(compactMatch.parsed.primaryValue, 777);

  // 6. Archived games are skipped
  const archivedRes = detectGameAndParse('Old Archived Game 500 pts', games);
  assert.equal(archivedRes.matchedGame, null);
  assert.equal(archivedRes.confidence, 'none');

  // 7. Unmatched text falls back cleanly
  const unmatched = detectGameAndParse('Unknown Daily 750 pts', games);
  assert.equal(unmatched.matchedGame, null);
  assert.equal(unmatched.confidence, 'none');
  assert.equal(unmatched.parserId, 'generic');
  assert.equal(unmatched.parsed.primaryValue, 750);
});

test('GENERIC_PARSER: extracts multiplier and suffix scores while ignoring grid dimensions', () => {
  const plainUnicode = GENERIC_PARSER.parse('1.45×', {
    metricFormat: 'number',
    metricDirection: 'lower_is_better',
    metricLabel: 'Avg Multiplier',
  });
  assert.equal(plainUnicode.primaryValue, 1.45);
  assert.equal(plainUnicode.displayValue, '1.45');
  assert.equal(plainUnicode.metricDirection, 'lower_is_better');

  const plainAscii = GENERIC_PARSER.parse('2.3x');
  assert.equal(plainAscii.primaryValue, 2.3);
  assert.equal(plainAscii.displayValue, '2.3');
  assert.equal(plainAscii.metricFormat, 'number');

  const labeledAvg = GENERIC_PARSER.parse('Average: 1.8×');
  assert.equal(labeledAvg.primaryValue, 1.8);
  assert.equal(labeledAvg.displayValue, '1.8');

  const suffixScore = GENERIC_PARSER.parse('1.30× score · top 2%');
  assert.equal(suffixScore.primaryValue, 1.3);
  assert.equal(suffixScore.displayValue, '1.3');

  const multilineMult = GENERIC_PARSER.parse('1.28×\n02 next');
  assert.equal(multilineMult.primaryValue, 1.28);
  assert.equal(multilineMult.displayValue, '1.28');

  const genericMultShare = GENERIC_PARSER.parse('Multiplier #42 - 1.62×\nhttps://multiplier.example');
  assert.equal(genericMultShare.puzzleId, '#42');
  assert.equal(genericMultShare.primaryValue, 1.62);
  assert.equal(genericMultShare.displayValue, '1.62');

  const multWithGrid = GENERIC_PARSER.parse('Multiplier #42 (4x4)\n1.62×');
  assert.equal(multWithGrid.puzzleId, '#42');
  assert.equal(multWithGrid.primaryValue, 1.62);

  for (const gridOnly of ['Grid 4x4\nPlayed', '5x5 puzzle', '4×4 board', '4 x 4 grid']) {
    const res = GENERIC_PARSER.parse(gridOnly);
    assert.equal(res.primaryValue, null, `Grid text "${gridOnly}" must not extract a score`);
    assert.equal(res.displayValue, 'Played');
  }
});

test('timezone utils: COMMON_RESET_TIMEZONES, isValidResetTimezone, isValidResetTime, formatCountdownCompact', () => {
  assert.ok(Array.isArray(COMMON_RESET_TIMEZONES) && COMMON_RESET_TIMEZONES.length >= 10);
  for (const item of COMMON_RESET_TIMEZONES) {
    assert.equal(isValidResetTimezone(item.id), true, `Expected ${item.id} to be valid`);
    assert.equal(typeof item.label, 'string');
  }

  assert.equal(isValidResetTimezone('local'), true);
  assert.equal(isValidResetTimezone('UTC'), true);
  assert.equal(isValidResetTimezone('America/New_York'), true);
  assert.equal(isValidResetTimezone('America/Los_Angeles'), true);
  assert.equal(isValidResetTimezone('Asia/Kolkata'), true);
  assert.equal(isValidResetTimezone('Mars/Olympus'), false);
  assert.equal(isValidResetTimezone(' UTC '), false);
  assert.equal(isValidResetTimezone(''), false);
  assert.equal(isValidResetTimezone(null), false);

  assert.equal(isValidResetTime('00:00'), true);
  assert.equal(isValidResetTime('09:30'), true);
  assert.equal(isValidResetTime('23:59'), true);
  assert.equal(isValidResetTime('24:00'), false);
  assert.equal(isValidResetTime('9:00'), false);
  assert.equal(isValidResetTime('12:60'), false);
  assert.equal(isValidResetTime(''), false);
  assert.equal(isValidResetTime(null), false);

  assert.equal(formatCountdownCompact(0), '< 1m');
  assert.equal(formatCountdownCompact(59_999), '< 1m');
  assert.equal(formatCountdownCompact(60_000), '1m');
  assert.equal(formatCountdownCompact(42 * 60_000), '42m');
  assert.equal(formatCountdownCompact((2 * 60 + 45) * 60_000), '2h 45m');
  assert.equal(formatCountdownCompact(12 * 3_600_000), '12h 0m');
  assert.equal(formatCountdownCompact(-500), '< 1m');
  assert.equal(formatCountdownCompact(null), '');
});

test('timezone engine: getGamePuzzleStatus handles local, UTC, NY, LA, IST, non-midnight resets, and DST transitions', () => {
  // Confirm Node 24 Temporal-undefined fallback path is exercised
  assert.equal(typeof globalThis.Temporal, 'undefined');

  // 2026-11-16T04:00:00.000Z:
  // - UTC: 2026-11-16 04:00
  // - America/New_York (EST -5): 2026-11-15 23:00
  // - America/Los_Angeles (PST -8): 2026-11-15 20:00
  // - Asia/Kolkata (IST +5:30): 2026-11-16 09:30
  const instant = new Date('2026-11-16T04:00:00.000Z');
  const viewerTz = 'Asia/Kolkata';

  const localStatus = getGamePuzzleStatus({ resetTimezone: 'local', resetTime: '00:00' }, instant, viewerTz);
  assert.equal(localStatus.resetTimezone, 'local');
  assert.equal(localStatus.resolvedTimezone, 'Asia/Kolkata');
  assert.equal(localStatus.activePuzzleDate, '2026-11-16');
  assert.equal(localStatus.localTodayDate, '2026-11-16');
  assert.equal(localStatus.isOffLocalDate, false);
  assert.equal(localStatus.nextResetIso, '2026-11-16T18:30:00.000Z');
  assert.equal(localStatus.countdownLabel, '14h 30m');

  const utcStatus = getGamePuzzleStatus({ resetTimezone: 'UTC', resetTime: '00:00' }, instant, viewerTz);
  assert.equal(utcStatus.resolvedTimezone, 'UTC');
  assert.equal(utcStatus.activePuzzleDate, '2026-11-16');
  assert.equal(utcStatus.isOffLocalDate, false);
  assert.equal(utcStatus.nextResetIso, '2026-11-17T00:00:00.000Z');
  assert.equal(utcStatus.countdownLabel, '20h 0m');

  const nyStatus = getGamePuzzleStatus(
    { resetTimezone: 'America/New_York', resetTime: '00:00' },
    instant,
    viewerTz
  );
  assert.equal(nyStatus.resolvedTimezone, 'America/New_York');
  assert.equal(nyStatus.activePuzzleDate, '2026-11-15');
  assert.equal(nyStatus.localTodayDate, '2026-11-16');
  assert.equal(nyStatus.isOffLocalDate, true);
  assert.equal(nyStatus.nextResetIso, '2026-11-16T05:00:00.000Z');
  assert.equal(nyStatus.countdownLabel, '1h 0m');
  assert.equal(typeof nyStatus.nextResetLocalTime, 'string');
  assert.ok(nyStatus.nextResetLocalTime.length > 0);

  const laStatus = getGamePuzzleStatus(
    { resetTimezone: 'America/Los_Angeles', resetTime: '00:00' },
    instant,
    viewerTz
  );
  assert.equal(laStatus.activePuzzleDate, '2026-11-15');
  assert.equal(laStatus.isOffLocalDate, true);
  assert.equal(laStatus.nextResetIso, '2026-11-16T08:00:00.000Z');
  assert.equal(laStatus.countdownLabel, '4h 0m');

  // Non-midnight resetTime: 06:00 America/New_York
  // 2026-11-16T10:30:00Z = 05:30 EST (before 06:00 -> still 2026-11-15 puzzle, 30m left)
  const beforeCustomReset = getGamePuzzleStatus(
    { resetTimezone: 'America/New_York', resetTime: '06:00' },
    new Date('2026-11-16T10:30:00.000Z'),
    'America/New_York'
  );
  assert.equal(beforeCustomReset.activePuzzleDate, '2026-11-15');
  assert.equal(beforeCustomReset.isOffLocalDate, true);
  assert.equal(beforeCustomReset.nextResetIso, '2026-11-16T11:00:00.000Z');
  assert.equal(beforeCustomReset.countdownLabel, '30m');

  // Exact reset boundary 06:00 EST -> flips to 2026-11-16 puzzle, 24h until tomorrow 06:00
  const atCustomReset = getGamePuzzleStatus(
    { resetTimezone: 'America/New_York', resetTime: '06:00' },
    new Date('2026-11-16T11:00:00.000Z'),
    'America/New_York'
  );
  assert.equal(atCustomReset.activePuzzleDate, '2026-11-16');
  assert.equal(atCustomReset.isOffLocalDate, false);
  assert.equal(atCustomReset.nextResetIso, '2026-11-17T11:00:00.000Z');
  assert.equal(atCustomReset.countdownLabel, '24h 0m');

  // DST Spring Forward in America/New_York (2026-03-08 02:00 EST -> 03:00 EDT):
  // 2026-03-08T05:30:00Z = 00:30 EST -> next midnight 2026-03-09 00:00 EDT is 2026-03-09T04:00:00Z (22h 30m)
  const springForward = getGamePuzzleStatus(
    { resetTimezone: 'America/New_York', resetTime: '00:00' },
    new Date('2026-03-08T05:30:00.000Z'),
    'America/New_York'
  );
  assert.equal(springForward.activePuzzleDate, '2026-03-08');
  assert.equal(springForward.nextResetIso, '2026-03-09T04:00:00.000Z');
  assert.equal(springForward.countdownLabel, '22h 30m');

  // Spring Forward across 02:00->03:00 gap when resetTime is 03:00:
  // 2026-03-08T06:30:00Z = 01:30 EST -> 03:00 EDT is 2026-03-08T07:00:00Z (only 30m away!)
  const springGap = getGamePuzzleStatus(
    { resetTimezone: 'America/New_York', resetTime: '03:00' },
    new Date('2026-03-08T06:30:00.000Z'),
    'America/New_York'
  );
  assert.equal(springGap.activePuzzleDate, '2026-03-07');
  assert.equal(springGap.nextResetIso, '2026-03-08T07:00:00.000Z');
  assert.equal(springGap.countdownLabel, '30m');

  // DST Fall Back in America/New_York (2026-11-01 02:00 EDT -> 01:00 EST):
  // 2026-11-01T04:30:00Z = 00:30 EDT -> next midnight 2026-11-02 00:00 EST is 2026-11-02T05:00:00Z (24h 30m)
  const fallBack = getGamePuzzleStatus(
    { resetTimezone: 'America/New_York', resetTime: '00:00' },
    new Date('2026-11-01T04:30:00.000Z'),
    'America/New_York'
  );
  assert.equal(fallBack.activePuzzleDate, '2026-11-01');
  assert.equal(fallBack.nextResetIso, '2026-11-02T05:00:00.000Z');
  assert.equal(fallBack.countdownLabel, '24h 30m');

  // Invalid resetTimezone/resetTime falls back cleanly
  const fallbackStatus = getGamePuzzleStatus(
    { resetTimezone: 'Invalid/Zone', resetTime: '99:99' },
    instant,
    'UTC'
  );
  assert.equal(fallbackStatus.resetTimezone, 'local');
  assert.equal(fallbackStatus.resolvedTimezone, 'UTC');
  assert.equal(fallbackStatus.resetTime, '00:00');
  assert.equal(fallbackStatus.activePuzzleDate, '2026-11-16');
});

test('cluesBySamParser: difficulties, month-name dates, emoji grid stats, and puzzle numbers', () => {
  assert.deepEqual(CLUES_BY_SAM_DIFFICULTIES, ['Easy', 'Medium', 'Tricky', 'Hard', 'Brutal']);

  assert.equal(normalizeDifficultyLabel('easy'), 'Easy');
  assert.equal(normalizeDifficultyLabel('MEDIUM'), 'Medium');
  assert.equal(normalizeDifficultyLabel('  tricky '), 'Tricky');
  assert.equal(normalizeDifficultyLabel('Hard'), 'Hard');
  assert.equal(normalizeDifficultyLabel('brutal'), 'Brutal');
  assert.equal(normalizeDifficultyLabel('expert'), 'Expert');
  assert.equal(normalizeDifficultyLabel('super hard'), 'Super Hard');
  assert.equal(normalizeDifficultyLabel(''), null);
  assert.equal(normalizeDifficultyLabel('   '), null);
  assert.equal(normalizeDifficultyLabel(null), null);
  assert.equal(normalizeDifficultyLabel(123), null);

  const realShare = [
    'I solved the daily #CluesBySam, Nov 16th 2026 (Easy), in 02:26',
    '🟩🟩🟩🟩',
    '🟩🟩🟩🟩',
    '🟩🟩🟩🟩',
    '🟩🟩🟩🟩',
    '🟩🟩🟩🟩',
    'https://cluesbysam.com',
  ].join('\n');

  assert.equal(cluesBySamParser.canParse(realShare), true);
  const parsedReal = cluesBySamParser.parse(realShare);
  assert.equal(parsedReal.parserId, 'cluesbysam');
  assert.equal(parsedReal.parserVersion, 1);
  assert.equal(parsedReal.isCustomParser, true);
  assert.equal(parsedReal.completed, true);
  assert.equal(parsedReal.solved, true);
  assert.equal(parsedReal.primaryValue, 146);
  assert.equal(parsedReal.displayValue, '2:26');
  assert.equal(parsedReal.metricLabel, 'Solve Time');
  assert.equal(parsedReal.metricFormat, 'duration_sec');
  assert.equal(parsedReal.metricDirection, 'lower_is_better');
  assert.equal(parsedReal.puzzleId, null);
  assert.equal(parsedReal.puzzleDate, '2026-11-16');
  assert.equal(parsedReal.metadata.difficulty, 'Easy');
  assert.equal(parsedReal.metadata.seconds, 146);
  assert.equal(parsedReal.metadata.gridRows, 5);
  assert.equal(parsedReal.metadata.gridCols, 4);
  assert.equal(parsedReal.metadata.cleanCount, 20);
  assert.equal(parsedReal.metadata.greenCount, 20);
  assert.equal(parsedReal.metadata.yellowCount, 0);
  assert.equal(parsedReal.metadata.hintCount, 0);
  assert.ok(parsedReal.metadata.emojiGrid.includes('🟩🟩🟩🟩'));
  assert.equal(parsedReal.metadata.grid, parsedReal.metadata.emojiGrid);

  for (const diff of CLUES_BY_SAM_DIFFICULTIES) {
    const res = cluesBySamParser.parse(
      `I solved the daily #CluesBySam, November 16, 2026 (${diff.toLowerCase()}), in 3:05`
    );
    assert.equal(res.metadata.difficulty, diff);
    assert.equal(res.puzzleDate, '2026-11-16');
    assert.equal(res.primaryValue, 185);
  }

  // Day-first date, mixed grid hints, and labeled Difficulty
  const mixedGrid = [
    'Clues by Sam — 16 Nov 2026',
    'Difficulty: brutal',
    'Time: 1:04:10',
    '🟩🟩🟨🟩',
    '🟩🟧💡🟩',
  ].join('\n');
  const mixedRes = cluesBySamParser.parse(mixedGrid);
  assert.equal(mixedRes.puzzleDate, '2026-11-16');
  assert.equal(mixedRes.metadata.difficulty, 'Brutal');
  assert.equal(mixedRes.primaryValue, 3850);
  assert.equal(mixedRes.displayValue, '1:04:10');
  assert.equal(mixedRes.metadata.gridRows, 2);
  assert.equal(mixedRes.metadata.gridCols, 4);
  assert.equal(mixedRes.metadata.greenCount, 5);
  assert.equal(mixedRes.metadata.cleanCount, 5);
  assert.equal(mixedRes.metadata.yellowCount, 1);
  assert.equal(mixedRes.metadata.hintCount, 2);

  // Numeric #142 is extracted while #CluesBySam is NOT mistaken for puzzleId
  const shortShare = '#CluesBySam #142 45s';
  assert.equal(cluesBySamParser.canParse(shortShare), true);
  const shortRes = cluesBySamParser.parse(shortShare);
  assert.equal(shortRes.puzzleId, '#142');
  assert.equal(shortRes.primaryValue, 45);
  assert.equal(shortRes.displayValue, '0:45');
  assert.equal(shortRes.metadata.difficulty, null);
  assert.equal(shortRes.metadata.seconds, 45);
});

test('plainParser: parses altitudes with m/ft units and never confuses meters with minutes', () => {
  const shareMeters = [
    'Plain #123 ✈️',
    'Altitude: 6,420m',
    '2026-11-16',
    'https://playplain.app/',
  ].join('\n');

  assert.equal(plainParser.canParse(shareMeters), true);
  const parsedMeters = plainParser.parse(shareMeters);
  assert.equal(parsedMeters.parserId, 'plain');
  assert.equal(parsedMeters.isCustomParser, true);
  assert.equal(parsedMeters.puzzleId, '#123');
  assert.equal(parsedMeters.puzzleDate, '2026-11-16');
  assert.equal(parsedMeters.primaryValue, 6420);
  assert.equal(parsedMeters.displayValue, '6,420 m');
  assert.equal(parsedMeters.metricLabel, 'Altitude');
  assert.equal(parsedMeters.metricFormat, 'number');
  assert.equal(parsedMeters.metricDirection, 'higher_is_better');
  assert.equal(parsedMeters.metadata.unit, 'm');

  const dashMeters = plainParser.parse('Plain #123 — 8,150 m');
  assert.equal(plainParser.canParse('Plain #123 — 8,150 m'), true);
  assert.equal(dashMeters.puzzleId, '#123');
  assert.equal(dashMeters.primaryValue, 8150);
  assert.equal(dashMeters.displayValue, '8,150 m');

  const shareFeet = plainParser.parse('Plain #456\nAltitude: 6420 ft');
  assert.equal(shareFeet.puzzleId, '#456');
  assert.equal(shareFeet.primaryValue, 6420);
  assert.equal(shareFeet.displayValue, '6,420 ft');
  assert.equal(shareFeet.metadata.unit, 'ft');

  const withRounds = plainParser.parse([
    'Plain #789 ✈️',
    'Altitude: 9,500m',
    'Round 1: 3,000m',
    'Round 2: 6,500m',
  ].join('\n'));
  assert.equal(withRounds.primaryValue, 9500);
  assert.equal(withRounds.breakdown.length, 2);
  assert.equal(withRounds.breakdown[0].value, 3000);
  assert.equal(withRounds.breakdown[1].value, 6500);

  assert.equal(plainParser.canParse('Wordle 1,234 4/6'), false);
});

test('timeguessrParser: parses totals, /max denominators, emoji lines, and per-round breakdowns', () => {
  const share1 = [
    'TimeGuessr #542 42,150/50,000',
    '🌎🟩🟩⬛ 📅🟩🟨⬛',
    '🌎🟩🟨⬛ 📅🟩🟩🟩',
    '🌎🟩🟩🟩 📅🟩🟩⬛',
    '🌎🟨⬛⬛ 📅🟩🟨⬛',
    '🌎🟩🟩🟩 📅🟩🟩🟩',
    'https://timeguessr.com',
  ].join('\n');

  assert.equal(timeguessrParser.canParse(share1), true);
  const parsed1 = timeguessrParser.parse(share1);
  assert.equal(parsed1.parserId, 'timeguessr');
  assert.equal(parsed1.isCustomParser, true);
  assert.equal(parsed1.puzzleId, '#542');
  assert.equal(parsed1.primaryValue, 42150);
  assert.equal(parsed1.displayValue, '42,150 / 50,000');
  assert.equal(parsed1.metricLabel, 'Score');
  assert.equal(parsed1.metricFormat, 'number');
  assert.equal(parsed1.metricDirection, 'higher_is_better');
  assert.equal(parsed1.metadata.maxScore, 50000);
  assert.ok(parsed1.metadata.emojiGrid.includes('🌎🟩🟩⬛ 📅🟩🟨⬛'));

  const share2 = [
    'TimeGuessr #543 — 39,800 / 50,000',
    'Round 1: 8,450/10,000',
    'Round 2: 7,350/10,000',
    'Round 3: 9,000/10,000',
    'Round 4: 6,500/10,000',
    'Round 5: 8,500/10,000',
  ].join('\n');
  const parsed2 = timeguessrParser.parse(share2);
  assert.equal(parsed2.puzzleId, '#543');
  assert.equal(parsed2.primaryValue, 39800);
  assert.equal(parsed2.displayValue, '39,800 / 50,000');
  assert.equal(parsed2.metadata.maxScore, 50000);
  assert.equal(parsed2.breakdown.length, 5);
  assert.equal(parsed2.breakdown[0].label, 'Round 1');
  assert.equal(parsed2.breakdown[0].value, 8450);
  assert.equal(parsed2.metadata.breakdown.length, 5);

  const keycapRounds = timeguessrParser.parse([
    'TimeGuessr #544',
    '1️⃣ 8,450',
    '2️⃣ 9,100',
  ].join('\n'));
  assert.equal(keycapRounds.primaryValue, 17550);
  assert.equal(keycapRounds.displayValue, '17,550 / 20,000');
  assert.equal(keycapRounds.breakdown.length, 2);
});

test('STARTER_GAMES & detectGameAndParse: includes 10 starter games including Eraly', () => {
  assert.equal(STARTER_GAMES.length, 10);
  assert.deepEqual(
    STARTER_GAMES.map((g) => g.slug),
    [
      'cluesbysam',
      'krillion',
      'farflung',
      'perceptle',
      'pricepoint',
      'fermi',
      'magnitudle',
      'plain',
      'timeguessr',
      'eraly',
    ]
  );
  const cluesStarter = STARTER_GAMES.find((g) => g.slug === 'cluesbysam');
  assert.equal(cluesStarter.parserId, 'cluesbysam');

  const perceptleStarter = STARTER_GAMES.find((g) => g.slug === 'perceptle');
  assert.equal(perceptleStarter.parserId, 'perceptle');
  assert.equal(perceptleStarter.sortOrder, 4);

  const fermiStarter = STARTER_GAMES.find((g) => g.slug === 'fermi');
  assert.equal(fermiStarter.parserId, 'fermi');
  assert.equal(fermiStarter.sortOrder, 6);

  const magnitudleStarter = STARTER_GAMES.find((g) => g.slug === 'magnitudle');
  assert.equal(magnitudleStarter.parserId, 'magnitudle');
  assert.equal(magnitudleStarter.sortOrder, 7);

  const plainStarter = STARTER_GAMES.find((g) => g.slug === 'plain');
  assert.equal(plainStarter.parserId, 'plain');
  assert.equal(plainStarter.sortOrder, 8);
  assert.equal(plainStarter.metricLabel, 'Altitude');
  assert.equal(plainStarter.resetTimezone, 'America/New_York');

  const tgStarter = STARTER_GAMES.find((g) => g.slug === 'timeguessr');
  assert.equal(tgStarter.parserId, 'timeguessr');
  assert.equal(tgStarter.sortOrder, 9);
  assert.equal(tgStarter.resetTimezone, 'UTC');

  const eralyStarter = STARTER_GAMES.find((g) => g.slug === 'eraly');
  assert.equal(eralyStarter.parserId, 'eraly');
  assert.equal(eralyStarter.sortOrder, 10);
  assert.equal(eralyStarter.url, 'https://eraly.io');
  assert.equal(eralyStarter.resetTimezone, 'local');

  for (const game of STARTER_GAMES) {
    assert.equal(isValidResetTimezone(game.resetTimezone), true);
    assert.equal(isValidResetTime(game.resetTime), true);
  }

  const starterWithIds = STARTER_GAMES.map((g, i) => ({ ...g, id: i + 1, archived: false }));
  const detectedPlain = detectGameAndParse('Plain #123 ✈️\nAltitude: 6,420m', starterWithIds);
  assert.equal(detectedPlain.matchedGame?.slug, 'plain');
  assert.equal(detectedPlain.parserId, 'plain');
  assert.equal(detectedPlain.parsed.primaryValue, 6420);

  const detectedTg = detectGameAndParse('TimeGuessr #542 42,150/50,000\n🌎🟩🟩⬛ 📅🟩🟨⬛', starterWithIds);
  assert.equal(detectedTg.matchedGame?.slug, 'timeguessr');
  assert.equal(detectedTg.parserId, 'timeguessr');
  assert.equal(detectedTg.parsed.primaryValue, 42150);

  const detectedClues = detectGameAndParse(
    'I solved the daily #CluesBySam, Nov 16th 2026 (Tricky), in 02:26\n🟩🟩🟩🟩\n🟩🟩🟩🟩',
    starterWithIds
  );
  assert.equal(detectedClues.matchedGame?.slug, 'cluesbysam');
  assert.equal(detectedClues.parserId, 'cluesbysam');
  assert.equal(detectedClues.parsed.puzzleDate, '2026-11-16');
  assert.equal(detectedClues.parsed.metadata.difficulty, 'Tricky');
  assert.equal(detectedClues.parsed.primaryValue, 146);

  const detectedPerceptle = detectGameAndParse(
    'Perceptle #122 - C (69)\n🔢 57  🎯 93  📐 100  🥁 3  ✂️ 93\nhttps://perceptle.com',
    starterWithIds
  );
  assert.equal(detectedPerceptle.matchedGame?.slug, 'perceptle');
  assert.equal(detectedPerceptle.confidence, 'high');
  assert.equal(detectedPerceptle.parserId, 'perceptle');
  assert.equal(detectedPerceptle.parsed.primaryValue, 69);
  assert.equal(detectedPerceptle.parsed.displayValue, '69 (C)');

  const detectedFermi = detectGameAndParse(
    'Fermi · No. 113\n01 ↑ 1.28×\n02 ↓ 1.42×\n03 ↓ 1.19×\n─────────\n1.30× score · top 2%\n<https://fermi.gg/s/daily>',
    starterWithIds
  );
  assert.equal(detectedFermi.matchedGame?.slug, 'fermi');
  assert.equal(detectedFermi.confidence, 'high');
  assert.equal(detectedFermi.parserId, 'fermi');
  assert.equal(detectedFermi.parsed.primaryValue, 1.3);
  assert.equal(detectedFermi.parsed.displayValue, '1.30×');

  const detectedMagnitudle = detectGameAndParse(
    'Size It Up\n#99\n\nScore: 116/500\n\n🟥🟥⬜⬜⬜ 39\n🟥🟥🟥⬜⬜ 53\nhttps://magnitudle.com/size-it-up',
    starterWithIds
  );
  assert.equal(detectedMagnitudle.matchedGame?.slug, 'magnitudle');
  assert.equal(detectedMagnitudle.confidence, 'high');
  assert.equal(detectedMagnitudle.parserId, 'magnitudle');
  assert.equal(detectedMagnitudle.parsed.primaryValue, 116);
  assert.equal(detectedMagnitudle.parsed.displayValue, '116/500');

  const detectedEraly = detectGameAndParse(
    'Eraly #32 · I travelled to 1842 AD\n▰▰▰▰▰▰▰▱▱▱ 515/700\n🟨🟦🟩🟧🟥🟨💤\nhttps://eraly.io',
    starterWithIds
  );
  assert.equal(detectedEraly.matchedGame?.slug, 'eraly');
  assert.equal(detectedEraly.confidence, 'high');
  assert.equal(detectedEraly.parserId, 'eraly');
  assert.equal(detectedEraly.parsed.primaryValue, 515);
  assert.equal(detectedEraly.parsed.displayValue, '515/700');
});

test('perceptleParser: PERCEPTLE_ROUNDS, share formats, variation selectors, fallbacks, and registry matching', () => {
  assert.deepEqual(PERCEPTLE_ROUNDS, [
    { key: 'count', icon: '🔢', name: 'Count', label: '🔢 Count', max: 100 },
    { key: 'track', icon: '🎯', name: 'Track', label: '🎯 Track', max: 100 },
    { key: 'angle', icon: '📐', name: 'Angle', label: '📐 Angle', max: 100 },
    { key: 'tempo', icon: '🥁', name: 'Tempo', label: '🥁 Tempo', max: 100 },
    { key: 'split', icon: '✂️', name: 'Split', label: '✂️ Split', max: 100 },
  ]);

  assert.equal(getParserById('perceptle'), perceptleParser);
  assert.equal(
    getParserForGame({ name: 'Perceptle', slug: 'perceptle', url: 'https://perceptle.com', parserId: 'auto' }),
    perceptleParser
  );
  assert.equal(
    getParserForGame({ name: 'Perceptle', slug: 'perceptle', parserId: 'perceptle' }),
    perceptleParser
  );

  // 1. Canonical share text
  const share1 = [
    'Perceptle #122 - C (69)',
    '🔢 57  🎯 93  📐 100  🥁 3  ✂️ 93',
    'https://perceptle.com',
  ].join('\n');
  assert.equal(perceptleParser.canParse(share1), true);
  const res1 = perceptleParser.parse(share1);
  assert.equal(res1.parserId, 'perceptle');
  assert.equal(res1.parserVersion, 1);
  assert.equal(res1.isCustomParser, true);
  assert.equal(res1.completed, true);
  assert.equal(res1.primaryValue, 69);
  assert.equal(res1.displayValue, '69 (C)');
  assert.equal(res1.metricLabel, 'Score');
  assert.equal(res1.metricFormat, 'number');
  assert.equal(res1.metricDirection, 'higher_is_better');
  assert.equal(res1.puzzleId, '#122');
  assert.equal(res1.metadata.grade, 'C');
  assert.equal(res1.metadata.maxScore, 100);
  assert.deepEqual(res1.metadata.roundScores, {
    count: 57,
    track: 93,
    angle: 100,
    tempo: 3,
    split: 93,
  });
  assert.equal(res1.breakdown.length, 5);
  assert.deepEqual(res1.breakdown[0], {
    key: 'count',
    icon: '🔢',
    name: 'Count',
    label: '🔢 Count',
    value: 57,
    max: 100,
    display: '57',
  });
  assert.deepEqual(res1.breakdown[4], {
    key: 'split',
    icon: '✂️',
    name: 'Split',
    label: '✂️ Split',
    value: 93,
    max: 100,
    display: '93',
  });
  assert.equal(
    res1.metadata.emojiGrid,
    '🔢 Count · 57\n🎯 Track · 93\n📐 Angle · 100\n🥁 Tempo · 3\n✂️ Split · 93'
  );

  // 2. Variation selector stripped ("✂ 93") + alternative headers
  const strippedSplit = 'Perceptle #123: B+ (84)\n🔢 80  🎯 85  📐 90  🥁 72  ✂ 93';
  const res2 = perceptleParser.parse(strippedSplit);
  assert.equal(res2.puzzleId, '#123');
  assert.equal(res2.primaryValue, 84);
  assert.equal(res2.displayValue, '84 (B+)');
  assert.equal(res2.metadata.grade, 'B+');
  assert.equal(res2.metadata.roundScores.split, 93);
  assert.equal(res2.breakdown[4].label, '✂️ Split');

  const noGrade = perceptleParser.parse('Perceptle #124 (69)');
  assert.equal(noGrade.primaryValue, 69);
  assert.equal(noGrade.displayValue, '69');
  assert.equal('grade' in noGrade.metadata, false);

  const sGrade = perceptleParser.parse('Perceptle #125 - S (98)');
  assert.equal(sGrade.primaryValue, 98);
  assert.equal(sGrade.displayValue, '98 (S)');
  assert.equal(sGrade.metadata.grade, 'S');

  // 3. Multi-line rounds + missing header score -> average fallback
  const multilineNoHeaderScore = [
    'Perceptle #126',
    '🔢 57',
    '🎯 93',
    '📐 100',
    '🥁 3',
    '✂️ 93',
  ].join('\n');
  const resMulti = perceptleParser.parse(multilineNoHeaderScore);
  assert.equal(resMulti.primaryValue, 69);
  assert.equal(resMulti.displayValue, '69');
  assert.equal(resMulti.breakdown.length, 5);

  // 4. Labeled rounds
  const labeledRounds = [
    'Perceptle #127',
    'Count: 57',
    'Track: 93',
    'Angle: 100',
    'Tempo: 3',
    'Split: 93',
  ].join('\n');
  const resLabeled = perceptleParser.parse(labeledRounds);
  assert.equal(resLabeled.primaryValue, 69);
  assert.equal(resLabeled.breakdown.length, 5);
  assert.equal(resLabeled.metadata.roundScores.split, 93);

  // 5. Unknown emoji token on round line fallback
  const unknownEmoji = perceptleParser.parse('Perceptle #128\n🔢 80  🧩 90');
  assert.equal(unknownEmoji.breakdown.length, 2);
  assert.deepEqual(unknownEmoji.breakdown[1], {
    key: 'round_2',
    icon: '🧩',
    name: 'Round 2',
    label: '🧩 Round 2',
    value: 90,
    max: 100,
    display: '90',
  });
  assert.equal(unknownEmoji.metadata.roundScores.round_2, 90);
  assert.equal(unknownEmoji.primaryValue, 85);

  // 6. Legacy synthetic "Accuracy: 92%" fallback
  const legacyAcc = perceptleParser.parse('Perceptle #42\nAccuracy: 92%');
  assert.equal(legacyAcc.puzzleId, '#42');
  assert.equal(legacyAcc.primaryValue, 92);
  assert.equal(legacyAcc.displayValue, '92%');
  assert.equal(legacyAcc.breakdown.length, 0);
  assert.equal(legacyAcc.metadata.maxScore, 100);

  // 7. canParse via >=3 round tokens without header/URL, and theperceptle.com domain
  assert.equal(perceptleParser.canParse('🔢 57  🎯 93  📐 100'), true);
  assert.equal(perceptleParser.canParse('https://theperceptle.com\nScore: 85'), true);
  assert.equal(perceptleParser.canParse('Wordle 1,234 4/6'), false);
});

test('fermiParser: extracts summary score (1.30× vs 1.19), rounds, percentile, puzzleId, and monospace grid', () => {
  assert.equal(getParserById('fermi'), fermiParser);
  assert.equal(
    getParserForGame({ name: 'Fermi', slug: 'fermi', url: 'https://fermi.gg', parserId: 'auto' }),
    fermiParser
  );
  assert.equal(
    getParserForGame({ name: 'Fermi', slug: 'fermi', parserId: 'fermi' }),
    fermiParser
  );

  const realShare = [
    'Fermi · No. 113',
    '01 ↑ 1.28×',
    '02 ↓ 1.42×',
    '03 ↓ 1.19×',
    '─────────',
    '1.30× score · top 2%',
    '<https://fermi.gg/s/daily>',
  ].join('\n');

  assert.equal(fermiParser.canParse(realShare), true);
  const res = fermiParser.parse(realShare);
  assert.equal(res.parserId, 'fermi');
  assert.equal(res.isCustomParser, true);
  assert.equal(res.puzzleId, '#113');
  assert.equal(res.primaryValue, 1.3);
  assert.equal(res.displayValue, '1.30×');
  assert.equal(res.metricLabel, 'Avg Multiplier');
  assert.equal(res.metricFormat, 'number');
  assert.equal(res.metricDirection, 'lower_is_better');
  assert.equal(res.metadata.topPercent, 2);
  assert.equal(res.metadata.percentileLabel, 'top 2%');
  assert.equal(res.breakdown.length, 3);
  assert.deepEqual(res.breakdown[0], {
    key: 'q1',
    icon: '↑',
    name: 'Q1',
    label: '01 ↑',
    value: 1.28,
    display: '1.28×',
  });
  assert.deepEqual(res.breakdown[2], {
    key: 'q3',
    icon: '↓',
    name: 'Q3',
    label: '03 ↓',
    value: 1.19,
    display: '1.19×',
  });
  assert.equal(
    res.metadata.emojiGrid,
    '01 ↑ 1.28×\n02 ↓ 1.42×\n03 ↓ 1.19×\n─────────\n1.30× · top 2%'
  );

  const slashSample = '01 ↑ 64.1× / 02 ↑ 2.46× / 03 ↑ 134× / ───────── / 27.6× score · top 89%';
  assert.equal(fermiParser.canParse(slashSample), true);
  const slashRes = fermiParser.parse(slashSample);
  assert.equal(slashRes.primaryValue, 27.6);
  assert.equal(slashRes.displayValue, '27.6×');
  assert.equal(slashRes.metadata.topPercent, 89);
  assert.equal(slashRes.breakdown.length, 3);

  const summaryOnly = fermiParser.parse('Fermi\n6.11× score · top 44%');
  assert.equal(summaryOnly.primaryValue, 6.11);
  assert.equal(summaryOnly.displayValue, '6.11×');
  assert.equal(summaryOnly.metadata.topPercent, 44);

  const synthetic = fermiParser.parse('Fermi #42 - 1.62×');
  assert.equal(synthetic.puzzleId, '#42');
  assert.equal(synthetic.primaryValue, 1.62);
  assert.equal(synthetic.displayValue, '1.62×');

  const roundsOnly = fermiParser.parse('01 ↑ 1.00×\n02 ↓ 4.00×');
  assert.equal(roundsOnly.primaryValue, 2);
  assert.equal(roundsOnly.displayValue, '2.00×');
  assert.equal(roundsOnly.breakdown.length, 2);
});

test('magnitudleParser: parses Size It Up / Magnitudle scores, rows, and deduplicates double pastes', () => {
  assert.equal(getParserById('magnitudle'), magnitudleParser);
  assert.equal(
    getParserForGame({
      name: 'Magnitudle',
      slug: 'magnitudle',
      url: 'https://magnitudle.com',
      parserId: 'auto',
    }),
    magnitudleParser
  );
  assert.equal(
    getParserForGame({ name: 'Size It Up', slug: 'size-it-up', parserId: 'auto' }),
    magnitudleParser
  );

  const singleShare = [
    'Size It Up',
    '#99',
    '',
    'Score: 116/500',
    '',
    '🟥🟥⬜⬜⬜ 39',
    '🟥🟥🟥⬜⬜ 53',
    '⬜⬜⬜⬜⬜ 4',
    '⬜⬜⬜⬜⬜ 0',
    '🟥⬜⬜⬜⬜ 20',
    'https://magnitudle.com/size-it-up',
  ].join('\n');

  assert.equal(magnitudleParser.canParse(singleShare), true);
  const res = magnitudleParser.parse(singleShare);
  assert.equal(res.parserId, 'magnitudle');
  assert.equal(res.isCustomParser, true);
  assert.equal(res.puzzleId, '#99');
  assert.equal(res.primaryValue, 116);
  assert.equal(res.displayValue, '116/500');
  assert.equal(res.metadata.maxScore, 500);
  assert.equal(res.breakdown.length, 5);
  assert.deepEqual(res.breakdown[0], {
    key: 'r1',
    label: 'Round 1',
    value: 39,
    max: 100,
    display: '39',
  });
  assert.equal(res.breakdown[3].value, 0);
  assert.equal(res.breakdown[4].value, 20);
  assert.equal(
    res.metadata.emojiGrid,
    '🟥🟥⬜⬜⬜ 39\n🟥🟥🟥⬜⬜ 53\n⬜⬜⬜⬜⬜ 4\n⬜⬜⬜⬜⬜ 0\n🟥⬜⬜⬜⬜ 20'
  );

  // Double-pasted block deduplication
  const doublePaste = `${singleShare}\n${singleShare}`;
  const deduped = magnitudleParser.parse(doublePaste);
  assert.equal(deduped.puzzleId, '#99');
  assert.equal(deduped.primaryValue, 116);
  assert.equal(deduped.displayValue, '116/500');
  assert.equal(deduped.breakdown.length, 5);
  assert.equal(deduped.metadata.emojiGrid, res.metadata.emojiGrid);

  const legacySynthetic = magnitudleParser.parse('Magnitudle #77\nScore: 950');
  assert.equal(legacySynthetic.puzzleId, '#77');
  assert.equal(legacySynthetic.primaryValue, 950);
  assert.equal(legacySynthetic.displayValue, '950');
});

test('timeguessrParser: parses new trophy round format (1️⃣ 🏆4,706 · 📅 3y · 🌍 12226.3km) and preserves grid keycaps', () => {
  const realTg = [
    'TimeGuessr #1265 — 27,292/50,000',
    '',
    '1️⃣ 🏆4,706 · 📅 3y · 🌍 12226.3km',
    '2️⃣ 🏆3,351 · 📅 21y · 🌍 1651.6km',
    '3️⃣ 🏆4,448 · 📅 6y · 🌍 4135.0km',
    '4️⃣ 🏆7,371 · 📅 7y · 🌍 574.7km',
    '5️⃣ 🏆7,416 · 📅 12y · 🌍 8.3km',
    '',
    'https://timeguessr.com',
  ].join('\n');

  assert.equal(timeguessrParser.canParse(realTg), true);
  const res = timeguessrParser.parse(realTg);
  assert.equal(res.puzzleId, '#1265');
  assert.equal(res.primaryValue, 27292);
  assert.equal(res.displayValue, '27,292 / 50,000');
  assert.equal(res.metadata.maxScore, 50000);
  assert.deepEqual(
    res.breakdown.map((b) => ({ label: b.label, value: b.value, max: b.max })),
    [
      { label: 'Round 1', value: 4706, max: 10000 },
      { label: 'Round 2', value: 3351, max: 10000 },
      { label: 'Round 3', value: 4448, max: 10000 },
      { label: 'Round 4', value: 7371, max: 10000 },
      { label: 'Round 5', value: 7416, max: 10000 },
    ]
  );
  assert.equal(
    res.metadata.emojiGrid,
    [
      '1️⃣ 🏆4,706 · 📅 3y · 🌍 12226.3km',
      '2️⃣ 🏆3,351 · 📅 21y · 🌍 1651.6km',
      '3️⃣ 🏆4,448 · 📅 6y · 🌍 4135.0km',
      '4️⃣ 🏆7,371 · 📅 7y · 🌍 574.7km',
      '5️⃣ 🏆7,416 · 📅 12y · 🌍 8.3km',
    ].join('\n')
  );
});

test('utils: extractPuzzleId supports No./Puzzle formats and extractEmojiGrid handles hybrid grids without matching prose', () => {
  assert.equal(extractPuzzleId('Fermi · No. 113'), '#113');
  assert.equal(extractPuzzleId('Daily Puzzle 42 - 800 pts'), '#42');
  assert.equal(extractPuzzleId('Puzzle #99 > No. 12'), '#99');

  const hybridMagnitudle = [
    'Size It Up',
    '#99',
    'Score: 116/500',
    '🟥🟥⬜⬜⬜ 39',
    '🟥🟥🟥⬜⬜ 53',
  ].join('\n');
  assert.equal(extractEmojiGrid(hybridMagnitudle), '🟥🟥⬜⬜⬜ 39\n🟥🟥🟥⬜⬜ 53');

  const hybridTg = [
    'TimeGuessr #1265 — 27,292/50,000',
    '1️⃣ 🏆4,706 · 📅 3y · 🌍 12226.3km',
    '2️⃣ 🏆3,351 · 📅 21y · 🌍 1651.6km',
  ].join('\n');
  assert.equal(
    extractEmojiGrid(hybridTg),
    '1️⃣ 🏆4,706 · 📅 3y · 🌍 12226.3km\n2️⃣ 🏆3,351 · 📅 21y · 🌍 1651.6km'
  );

  // Prose lines must NEVER be captured as emoji grids
  assert.equal(extractEmojiGrid('Top 41% today · 🔥 2-day streak'), '');
  assert.equal(
    extractEmojiGrid('🔥 ⭐ Top 41% today · 2-day streak\n🔥 ⭐ Top 50% today · 3-day streak'),
    ''
  );
  assert.equal(extractEmojiGrid('I solved the daily #CluesBySam, Nov 16th 2026'), '');
  assert.equal(extractEmojiGrid('TimeGuessr #1265 — 27,292/50,000'), '');
});

test('eralyParser: ERALY_BANDS, standard share 515/700, (Archive) 🎃, BC year, emoji-only sum fallback, and registry matching', () => {
  assert.deepEqual(ERALY_BANDS, {
    '🟨': { emoji: '🟨', pts: 100, label: 'Timekeeper' },
    '🟦': { emoji: '🟦', pts: 85, label: 'Chronicler' },
    '🟩': { emoji: '🟩', pts: 60, label: 'Historian' },
    '🟧': { emoji: '🟧', pts: 30, label: 'Explorer' },
    '🟥': { emoji: '🟥', pts: 10, label: 'Tourist' },
    '💤': { emoji: '💤', pts: 0, label: 'Lost in time' },
  });

  assert.equal(getParserById('eraly'), eralyParser);
  assert.equal(
    getParserForGame({ name: 'Eraly', slug: 'eraly', url: 'https://eraly.io', parserId: 'auto' }),
    eralyParser
  );
  assert.equal(
    getParserForGame({ name: 'Eraly', slug: 'eraly', parserId: 'eraly' }),
    eralyParser
  );

  // 1. Standard share 515/700 with 7 decoded rounds
  const standardShare = [
    'Eraly #32 · I travelled to 1842 AD',
    '▰▰▰▰▰▰▰▱▱▱ 515/700',
    '🟨🟦🟩🟧🟥🟨💤',
    'https://eraly.io',
  ].join('\n');

  assert.equal(eralyParser.canParse(standardShare), true);
  const res1 = eralyParser.parse(standardShare);
  assert.equal(res1.parserId, 'eraly');
  assert.equal(res1.parserVersion, 1);
  assert.equal(res1.isCustomParser, true);
  assert.equal(res1.completed, true);
  assert.equal(res1.puzzleId, '#32');
  assert.equal(res1.primaryValue, 515);
  assert.equal(res1.displayValue, '515/700');
  assert.equal(res1.metricLabel, 'Score');
  assert.equal(res1.metricFormat, 'number');
  assert.equal(res1.metricDirection, 'higher_is_better');
  assert.equal(res1.metadata.maxScore, 700);
  assert.equal(res1.metadata.yearReached, '1842 AD');
  assert.equal('archive' in res1.metadata, false);
  assert.equal(res1.breakdown.length, 7);
  assert.deepEqual(res1.breakdown[0], {
    key: 'q1',
    icon: '🟨',
    name: 'Q1',
    label: 'Q1 🟨',
    value: 100,
    max: 100,
    display: '100',
  });
  assert.deepEqual(
    res1.breakdown.map((b) => b.value),
    [100, 85, 60, 30, 10, 100, 0]
  );
  assert.equal(res1.metadata.emojiGrid, '▰▰▰▰▰▰▰▱▱▱ 515/700\n🟨🟦🟩🟧🟥🟨💤');

  // 2. (Archive) 🎃 + BC year + explicit YYYY-MM-DD
  const archiveBcShare = [
    'Eraly #14 (Archive) 🎃 · I travelled to 44 BC (2026-11-16)',
    '▰▰▰▰▰▰▱▱▱▱ 480/700',
    '🟨🟦🟦🟩🟧🟩🟥',
    'https://eraly.io',
  ].join('\n');
  assert.equal(eralyParser.canParse(archiveBcShare), true);
  const res2 = eralyParser.parse(archiveBcShare);
  assert.equal(res2.puzzleId, '#14');
  assert.equal(res2.puzzleDate, '2026-11-16');
  assert.equal(res2.primaryValue, 480);
  assert.equal(res2.displayValue, '480/700');
  assert.equal(res2.metadata.archive, true);
  assert.equal(res2.metadata.yearReached, '44 BC');
  assert.equal(res2.metadata.maxScore, 700);

  // 3. canParse via "I travelled to ... BC/BCE" + progress bar without "Eraly" header/URL
  const barOnly = [
    'I travelled to 350 BCE',
    '▰▰▰▰▰▱▱▱▱▱ 410/700',
    '🟨🟩🟧🟥🟦🟩💤',
  ].join('\n');
  assert.equal(eralyParser.canParse(barOnly), true);
  const res3 = eralyParser.parse(barOnly);
  assert.equal(res3.primaryValue, 410);
  assert.equal(res3.metadata.yearReached, '350 BCE');

  // 4. Emoji-only sum fallback when overall score is omitted
  const emojiOnly = 'Eraly #33\n🟨🟦🟩🟧🟥🟨💤';
  const res4 = eralyParser.parse(emojiOnly);
  assert.equal(res4.puzzleId, '#33');
  assert.equal(res4.primaryValue, 385);
  assert.equal(res4.metadata.maxScore, 700);
  assert.equal(res4.displayValue, '385/700');
  assert.equal(res4.breakdown.length, 7);
  assert.equal(res4.metadata.emojiGrid, '🟨🟦🟩🟧🟥🟨💤');

  assert.equal(eralyParser.canParse('Wordle 1,234 4/6'), false);
});
