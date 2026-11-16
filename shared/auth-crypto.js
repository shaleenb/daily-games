/**
 * Pure Web-Standard auth, crypto, cookie, CSRF, and canonical starter game constants.
 * ZERO Node built-ins — runs identically in Cloudflare Workers and Node.js v24+.
 */

export const STARTER_GAMES = [
  {
    name: 'Clues by Sam',
    slug: 'cluesbysam',
    url: 'https://cluesbysam.com',
    icon: '🕵️',
    color: '#f59e0b',
    category: 'Logic',
    collection: null,
    tags: ['Logic'],
    metricLabel: 'Solve Time',
    metricFormat: 'duration_sec',
    metricDirection: 'lower_is_better',
    parserId: 'cluesbysam',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    sortOrder: 1,
  },
  {
    name: 'Krillion',
    slug: 'krillion',
    url: 'https://krillion.io',
    icon: '🦑',
    color: '#06b6d4',
    category: 'Trivia',
    collection: null,
    tags: ['Trivia'],
    metricLabel: 'Score',
    metricFormat: 'number',
    metricDirection: 'higher_is_better',
    parserId: 'auto',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    sortOrder: 2,
  },
  {
    name: 'Farflung',
    slug: 'farflung',
    url: 'https://farflunggame.fun',
    icon: '🌍',
    color: '#10b981',
    category: 'Geography',
    collection: null,
    tags: ['Geography'],
    metricLabel: 'Score',
    metricFormat: 'number',
    metricDirection: 'higher_is_better',
    parserId: 'auto',
    resetTimezone: 'UTC',
    resetTime: '00:00',
    sortOrder: 3,
  },
  {
    name: 'Perceptle',
    slug: 'perceptle',
    url: 'https://perceptle.com',
    icon: '👁️',
    color: '#8b5cf6',
    category: 'Perception',
    collection: null,
    tags: ['Perception'],
    metricLabel: 'Score',
    metricFormat: 'number',
    metricDirection: 'higher_is_better',
    parserId: 'perceptle',
    resetTimezone: 'local',
    resetTime: '00:00',
    sortOrder: 4,
  },
  {
    name: 'PricePoint',
    slug: 'pricepoint',
    url: 'https://pricepoint.gg',
    icon: '🏷️',
    color: '#ff5a36',
    category: 'Pricing',
    collection: null,
    tags: ['Pricing', 'Estimation'],
    metricLabel: 'Score',
    metricFormat: 'number',
    metricDirection: 'higher_is_better',
    parserId: 'auto',
    resetTimezone: 'America/Los_Angeles',
    resetTime: '00:00',
    sortOrder: 5,
  },
  {
    name: 'Fermi',
    slug: 'fermi',
    url: 'https://fermi.gg',
    icon: '🧮',
    color: '#ec4899',
    category: 'Estimation',
    collection: null,
    tags: ['Estimation', 'Math'],
    metricLabel: 'Avg Multiplier',
    metricFormat: 'number',
    metricDirection: 'lower_is_better',
    parserId: 'fermi',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    sortOrder: 6,
  },
  {
    name: 'Size It Up',
    slug: 'magnitudle',
    url: 'https://magnitudle.com/size-it-up',
    icon: '📏',
    color: '#0ea5e9',
    category: 'Estimation',
    collection: 'Magnitudle',
    tags: ['Estimation', 'Scale'],
    tagline: 'Five-round daily size estimation puzzle',
    metricLabel: 'Score',
    metricFormat: 'number',
    metricDirection: 'higher_is_better',
    parserId: 'magnitudle',
    resetTimezone: 'local',
    resetTime: '00:00',
    sortOrder: 7,
  },
  {
    name: 'Plain',
    slug: 'plain',
    url: 'https://playplain.app/',
    icon: '✈️',
    color: '#3b82f6',
    category: 'Aviation',
    collection: null,
    tags: ['Aviation', 'Geography'],
    metricLabel: 'Altitude',
    metricFormat: 'number',
    metricDirection: 'higher_is_better',
    parserId: 'plain',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    sortOrder: 8,
  },
  {
    name: 'TimeGuessr',
    slug: 'timeguessr',
    url: 'https://timeguessr.com',
    icon: '🕰️',
    color: '#f59e0b',
    category: 'History',
    collection: null,
    tags: ['History', 'Geography'],
    metricLabel: 'Score',
    metricFormat: 'number',
    metricDirection: 'higher_is_better',
    parserId: 'timeguessr',
    resetTimezone: 'UTC',
    resetTime: '00:00',
    sortOrder: 9,
  },
  {
    name: 'Eraly',
    slug: 'eraly',
    url: 'https://eraly.io',
    icon: '⏳',
    color: '#14b8a6',
    category: 'History',
    collection: null,
    tags: ['History'],
    metricLabel: 'Score',
    metricFormat: 'number',
    metricDirection: 'higher_is_better',
    parserId: 'eraly',
    resetTimezone: 'local',
    resetTime: '00:00',
    sortOrder: 10,
  },
];

export const OPTIONAL_CATALOG_GAMES = [
  // Magnitudle optional games
  {
    slug: 'weigh-it-up',
    name: 'Weigh It Up',
    url: 'https://magnitudle.com/weigh-it-up',
    icon: '⚖️',
    color: '#0284c7',
    category: 'Estimation',
    collection: 'Magnitudle',
    tags: ['Estimation', 'Scale'],
    metricLabel: 'Score',
    metricFormat: 'number',
    metricDirection: 'higher_is_better',
    parserId: 'magnitudle',
    resetTimezone: 'local',
    resetTime: '00:00',
    tagline: 'Daily weight estimation challenge on Magnitudle',
  },
  {
    slug: 'magnitudle-daily',
    name: 'Daily Question',
    url: 'https://magnitudle.com/daily',
    icon: '❓',
    color: '#0ea5e9',
    category: 'Estimation',
    collection: 'Magnitudle',
    tags: ['Estimation', 'Trivia'],
    metricLabel: 'Score',
    metricFormat: 'number',
    metricDirection: 'higher_is_better',
    parserId: 'magnitudle',
    resetTimezone: 'local',
    resetTime: '00:00',
    tagline: 'Single daily real-world number estimation question on Magnitudle',
  },

  // FlightQ Daily Collection
  {
    slug: 'passportq',
    name: 'PassportQ',
    url: 'https://flightq.app/passportq',
    icon: '🛂',
    color: '#f0a90a',
    category: 'Cities',
    collection: 'FlightQ',
    tags: ['Cities', 'Geography'],
    metricLabel: 'Guesses',
    metricFormat: 'fraction',
    metricDirection: 'lower_is_better',
    parserId: 'passportq',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    tagline: 'Guess the city from travel, weather, and map clues',
  },
  {
    slug: 'skyq',
    name: 'SkyQ',
    url: 'https://flightq.app/skyq',
    icon: '✈️',
    color: '#0ea5e9',
    category: 'Aviation',
    collection: 'FlightQ',
    tags: ['Aviation'],
    aliases: ['FlightQ', 'flightq'],
    metricLabel: 'Guesses',
    metricFormat: 'fraction',
    metricDirection: 'lower_is_better',
    parserId: 'flightq',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    tagline: "Guess today's mystery flight route",
  },
  {
    slug: 'airportq',
    name: 'AirportQ',
    url: 'https://flightq.app/airportq',
    icon: '🛫',
    color: '#f0a90a',
    category: 'Aviation',
    collection: 'FlightQ',
    tags: ['Aviation'],
    metricLabel: 'Guesses',
    metricFormat: 'fraction',
    metricDirection: 'lower_is_better',
    parserId: 'flightq',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    tagline: 'Find the hidden airport from its route network',
  },
  {
    slug: 'airlineq',
    name: 'AirlineQ',
    url: 'https://flightq.app/airlineq',
    icon: '🎫',
    color: '#14b8a6',
    category: 'Aviation',
    collection: 'FlightQ',
    tags: ['Aviation'],
    metricLabel: 'Guesses',
    metricFormat: 'fraction',
    metricDirection: 'lower_is_better',
    parserId: 'flightq',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    tagline: 'Name the airport from real airline clues',
  },
  {
    slug: 'planeq',
    name: 'PlaneQ',
    url: 'https://flightq.app/planeq',
    icon: '🛩️',
    color: '#38bdf8',
    category: 'Aviation',
    collection: 'FlightQ',
    tags: ['Aviation'],
    metricLabel: 'Guesses',
    metricFormat: 'fraction',
    metricDirection: 'lower_is_better',
    parserId: 'flightq',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    tagline: 'Guess the aircraft from its operators',
  },
  {
    slug: 'strata',
    name: 'Strata',
    url: 'https://flightq.app/strata',
    icon: '🗺️',
    color: '#3e6b8c',
    category: 'Cities',
    collection: 'FlightQ',
    tags: ['Cities', 'Geography'],
    aliases: ['layers'],
    metricLabel: 'Guesses',
    metricFormat: 'fraction',
    metricDirection: 'lower_is_better',
    parserId: 'flightq',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    tagline: 'Peel back a 3D map layer by layer to name the city',
  },
  {
    slug: 'mapfold',
    name: 'Mapfold',
    url: 'https://flightq.app/mapfold',
    icon: '🧭',
    color: '#cd6a44',
    category: 'Geography',
    collection: 'FlightQ',
    tags: ['Geography'],
    metricLabel: 'Score',
    metricFormat: 'number',
    metricDirection: 'higher_is_better',
    parserId: 'flightq',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    tagline: 'Every question folds the world map in half',
  },
  {
    slug: 'flyover',
    name: 'Flyover',
    url: 'https://flightq.app/flyover',
    icon: '🪟',
    color: '#7d94a4',
    category: 'Geography',
    collection: 'FlightQ',
    tags: ['Geography', 'Aviation'],
    metricLabel: 'Guesses',
    metricFormat: 'fraction',
    metricDirection: 'lower_is_better',
    parserId: 'flightq',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    tagline: 'Name the country seen through the airplane window',
  },
  {
    slug: 'cityq',
    name: 'CityQ',
    url: 'https://flightq.app/cityq',
    icon: '🏙️',
    color: '#ec4899',
    category: 'Cities',
    collection: 'FlightQ',
    tags: ['Cities', 'Geography'],
    metricLabel: 'Score',
    metricFormat: 'number',
    metricDirection: 'higher_is_better',
    parserId: 'flightq',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    tagline: 'Fill a 3×3 geography grid with cities that fit',
  },
  {
    slug: 'headcount',
    name: 'Headcount',
    url: 'https://flightq.app/headcount',
    icon: '👥',
    color: '#0284c7',
    category: 'Geography',
    collection: 'FlightQ',
    tags: ['Geography'],
    metricLabel: 'Score',
    metricFormat: 'number',
    metricDirection: 'higher_is_better',
    parserId: 'flightq',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    tagline: 'Draw a loop around the target population',
  },
  {
    slug: 'transitq',
    name: 'TransitQ',
    url: 'https://flightq.app/transitq',
    icon: '🚇',
    color: '#ef4444',
    category: 'Transit',
    collection: 'FlightQ',
    tags: ['Transit', 'Cities'],
    metricLabel: 'Guesses',
    metricFormat: 'fraction',
    metricDirection: 'lower_is_better',
    parserId: 'flightq',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    tagline: 'Guess the city from one metro line and service clues',
  },
  {
    slug: 'railq',
    name: 'RailQ',
    url: 'https://flightq.app/railq',
    icon: '🚆',
    color: '#8b5cf6',
    category: 'Transit',
    collection: 'FlightQ',
    tags: ['Transit', 'Geography'],
    metricLabel: 'Guesses',
    metricFormat: 'fraction',
    metricDirection: 'lower_is_better',
    parserId: 'flightq',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    tagline: 'Guess the train route from map and service clues',
  },
  {
    slug: 'railpass',
    name: 'RailPass',
    url: 'https://flightq.app/railpass',
    icon: '🎟️',
    color: '#2f6b4f',
    category: 'Transit',
    collection: 'FlightQ',
    tags: ['Transit', 'Geography'],
    metricLabel: 'Score',
    metricFormat: 'number',
    metricDirection: 'higher_is_better',
    parserId: 'flightq',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    tagline: 'Cross Europe on the real timetable before time runs out',
  },
  {
    slug: 'getaway',
    name: 'Getaway',
    url: 'https://flightq.app/getaway',
    icon: '🌴',
    color: '#14b8a6',
    category: 'Aviation',
    collection: 'FlightQ',
    tags: ['Aviation', 'Geography'],
    metricLabel: 'Distance',
    metricFormat: 'number',
    metricDirection: 'higher_is_better',
    parserId: 'flightq',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    tagline: 'Travel as far as you can on a budget',
  },
  {
    slug: 'layover',
    name: 'Layover',
    url: 'https://flightq.app/layover',
    icon: '🧳',
    color: '#fb923c',
    category: 'Aviation',
    collection: 'FlightQ',
    tags: ['Aviation'],
    metricLabel: 'Score',
    metricFormat: 'number',
    metricDirection: 'higher_is_better',
    parserId: 'flightq',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    tagline: 'Plan the best multi-stop flight connection',
  },
  {
    slug: 'departure-board',
    name: 'Departure Board',
    url: 'https://flightq.app/departure-board',
    icon: '📋',
    color: '#b88b36',
    category: 'Aviation',
    collection: 'FlightQ',
    tags: ['Aviation', 'Geography'],
    metricLabel: 'Guesses',
    metricFormat: 'fraction',
    metricDirection: 'lower_is_better',
    parserId: 'flightq',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    tagline: 'Match five destinations to flight clues',
  },
  {
    slug: 'vector',
    name: 'Vector',
    url: 'https://flightq.app/vector',
    icon: '📐',
    color: '#1d6a8c',
    category: 'Aviation',
    collection: 'FlightQ',
    tags: ['Aviation', 'Geography'],
    metricLabel: 'Points',
    metricFormat: 'number',
    metricDirection: 'higher_is_better',
    parserId: 'flightq',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    tagline: 'Five real flights — pin the destination or mid-flight position',
  },
  {
    slug: 'misplaced',
    name: 'Misplaced',
    url: 'https://flightq.app/misplaced',
    icon: '📍',
    color: '#365a4f',
    category: 'Cities',
    collection: 'FlightQ',
    tags: ['Cities', 'Geography'],
    metricLabel: 'Score',
    metricFormat: 'number',
    metricDirection: 'higher_is_better',
    parserId: 'flightq',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    tagline: 'Find the misplaced city and move its pin back',
  },
  {
    slug: 'radius',
    name: 'Radius',
    url: 'https://flightq.app/radius',
    icon: '⭕',
    color: '#aa4e31',
    category: 'Geography',
    collection: 'FlightQ',
    tags: ['Geography', 'Cities'],
    metricLabel: 'Score',
    metricFormat: 'number',
    metricDirection: 'higher_is_better',
    parserId: 'flightq',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    tagline: 'Find five cities — smaller circle earns more points',
  },
  {
    slug: 'airspan',
    name: 'Airspan',
    url: 'https://flightq.app/airspan',
    icon: '📏',
    color: '#5c8b9d',
    category: 'Aviation',
    collection: 'FlightQ',
    tags: ['Aviation', 'Scale'],
    aliases: ['scaleq'],
    metricLabel: 'Score',
    metricFormat: 'number',
    metricDirection: 'higher_is_better',
    parserId: 'flightq',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    tagline: 'Resize aircraft, airports, and landmarks in two daily challenges',
  },
  {
    slug: 'livery',
    name: 'Livery',
    url: 'https://flightq.app/livery',
    icon: '🎨',
    color: '#6b9dcc',
    category: 'Aviation',
    collection: 'FlightQ',
    tags: ['Aviation'],
    metricLabel: 'Guesses',
    metricFormat: 'fraction',
    metricDirection: 'lower_is_better',
    parserId: 'flightq',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    tagline: 'Recognise the airline from its tail colours',
  },
  {
    slug: 'airfield',
    name: 'Airfield',
    url: 'https://flightq.app/airfield',
    icon: '🛬',
    color: '#b97548',
    category: 'Aviation',
    collection: 'FlightQ',
    tags: ['Aviation'],
    metricLabel: 'Guesses',
    metricFormat: 'fraction',
    metricDirection: 'lower_is_better',
    parserId: 'flightq',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    tagline: 'Recognize the airport from its runways and surroundings',
  },
  {
    slug: 'airport-guesser',
    name: 'Airport Guesser',
    url: 'https://flightq.app/airport-guesser',
    icon: '📷',
    color: '#294c5e',
    category: 'Aviation',
    collection: 'FlightQ',
    tags: ['Aviation', 'Geography'],
    metricLabel: 'Score',
    metricFormat: 'number',
    metricDirection: 'higher_is_better',
    parserId: 'flightq',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    tagline: 'Explore real airport Street View across 5 rounds',
  },
  {
    slug: 'soar',
    name: 'Soar',
    url: 'https://flightq.app/soar',
    icon: '🦅',
    color: '#245963',
    category: 'Aviation',
    collection: 'FlightQ',
    tags: ['Aviation', 'Geography'],
    metricLabel: 'Score',
    metricFormat: 'number',
    metricDirection: 'higher_is_better',
    parserId: 'flightq',
    resetTimezone: 'America/New_York',
    resetTime: '00:00',
    tagline: 'Keep your plane flying with aviation and geography questions',
  },
];

export const BUILTIN_CATALOG_GAMES = [...STARTER_GAMES, ...OPTIONAL_CATALOG_GAMES];
export const STARTER_SLUG_SET = new Set(STARTER_GAMES.map((g) => g.slug));
export const OPTIONAL_CATALOG_SLUG_SET = new Set(OPTIONAL_CATALOG_GAMES.map((g) => g.slug));
export const BUILTIN_CATALOG_SLUG_SET = new Set(BUILTIN_CATALOG_GAMES.map((g) => g.slug));
export const BUILTIN_CATALOG_BY_SLUG = new Map(BUILTIN_CATALOG_GAMES.map((g) => [g.slug, g]));

export function enrichGameMetadata(game, { createdByUserId = null, createdByName = null } = {}) {
  const slug = typeof game?.slug === 'string' ? game.slug.trim().toLowerCase() : '';
  const canonical = BUILTIN_CATALOG_BY_SLUG.get(slug) || null;
  const isStarter = STARTER_SLUG_SET.has(slug);
  const isOptional = OPTIONAL_CATALOG_SLUG_SET.has(slug);

  const effectiveCreatorId =
    createdByUserId !== null && createdByUserId !== undefined
      ? createdByUserId
      : (game?.createdByUserId ?? null);
  const effectiveCreatorName =
    createdByName !== null && createdByName !== undefined
      ? createdByName
      : (game?.createdByName ?? null);

  let collection = null;
  if (canonical && typeof canonical.collection === 'string' && canonical.collection.trim()) {
    collection = canonical.collection.trim();
  } else if (typeof game?.collection === 'string' && game.collection.trim()) {
    collection = game.collection.trim();
  } else if (!canonical) {
    const rawUrl = typeof game?.url === 'string' ? game.url.toLowerCase() : '';
    if (/(?:flightq\.app|skyq\.app|planeq\.app|mapfold\.app|airportle\.app|passportq\.app)\b/.test(rawUrl)) {
      collection = 'FlightQ';
    } else if (/\bmagnitudle\.com\b/.test(rawUrl)) {
      collection = 'Magnitudle';
    } else if (
      (effectiveCreatorId !== null && effectiveCreatorId !== undefined) ||
      (typeof effectiveCreatorName === 'string' && effectiveCreatorName.trim())
    ) {
      collection = "Friends' Picks";
    }
  }

  const rawTags = [
    ...(Array.isArray(canonical?.tags) ? canonical.tags : []),
    ...(Array.isArray(game?.tags) ? game.tags : []),
    game?.category,
  ];
  const seenTagKeys = new Set();
  const tags = [];
  for (const raw of rawTags) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!seenTagKeys.has(key)) {
      seenTagKeys.add(key);
      tags.push(trimmed);
    }
  }

  const tagline =
    canonical?.tagline ||
    (typeof game?.tagline === 'string' && game.tagline.trim() ? game.tagline.trim() : null);

  return {
    isStarter,
    isOptional,
    collection,
    tags,
    tagline,
  };
}

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export const SESSION_COOKIE_SECURE_NAME = '__Host-dg_session';
export const SESSION_COOKIE_LOCAL_NAME = 'dg_session';
export const SESSION_TTL_DAYS = 30;
export const SESSION_TTL_SECONDS = SESSION_TTL_DAYS * 24 * 60 * 60;

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_BITS = 256;
const DUMMY_SALT_HEX = '00112233445566778899aabbccddeeff';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'same-site', 'none']);

const textEncoder = new TextEncoder();

function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('Invalid hex string');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function toUint8Array(bufOrHex) {
  if (bufOrHex instanceof Uint8Array) return bufOrHex;
  if (ArrayBuffer.isView(bufOrHex)) {
    return new Uint8Array(bufOrHex.buffer, bufOrHex.byteOffset, bufOrHex.byteLength);
  }
  if (bufOrHex instanceof ArrayBuffer) {
    return new Uint8Array(bufOrHex);
  }
  return textEncoder.encode(String(bufOrHex ?? ''));
}

export function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

export function isValidEmail(email) {
  const norm = normalizeEmail(email);
  if (!norm || norm.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(norm);
}

/**
 * Validate Unicode-safe display name (1..80 chars after trim).
 * Returns { valid, value, error }.
 */
export function validateDisplayName(name) {
  if (typeof name !== 'string') {
    return { valid: false, value: '', error: 'Display name is required' };
  }
  const trimmed = name.trim();
  const charCount = [...trimmed].length;
  if (charCount < 1 || charCount > 80) {
    return {
      valid: false,
      value: '',
      error: 'Display name must be between 1 and 80 characters',
    };
  }
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) {
    return { valid: false, value: '', error: 'Display name contains invalid control characters' };
  }
  return { valid: true, value: trimmed, error: null };
}

/**
 * Validate password length (8..128 Unicode codepoints).
 * Returns { valid, error }.
 */
export function validatePassword(password) {
  if (typeof password !== 'string') {
    return { valid: false, error: 'Password is required' };
  }
  const charCount = [...password].length;
  if (charCount < 8 || charCount > 128) {
    return { valid: false, error: 'Password must be between 8 and 128 characters' };
  }
  return { valid: true, error: null };
}

/**
 * Derive a 256-bit PBKDF2-HMAC-SHA256 hash (100,000 iterations).
 * Returns { hashHex, saltHex }.
 */
export async function hashPassword(password, existingSaltHex = null) {
  const saltBytes = existingSaltHex
    ? hexToBytes(existingSaltHex)
    : crypto.getRandomValues(new Uint8Array(16));
  const saltHex = existingSaltHex ? existingSaltHex.toLowerCase() : bytesToHex(saltBytes);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(String(password ?? '')),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    PBKDF2_BITS,
  );

  return {
    hashHex: bytesToHex(new Uint8Array(derivedBits)),
    saltHex,
  };
}

/**
 * Constant-time equality over equal-length SHA-256 digests.
 * Uses crypto.subtle.timingSafeEqual when available (Cloudflare Workers)
 * and constant-time XOR loop in Node/other Web Crypto environments.
 * @returns {Promise<boolean>}
 */
export async function constantTimeEqual(bufOrHexA, bufOrHexB) {
  const [digestABuf, digestBBuf] = await Promise.all([
    crypto.subtle.digest('SHA-256', toUint8Array(bufOrHexA)),
    crypto.subtle.digest('SHA-256', toUint8Array(bufOrHexB)),
  ]);
  const digestA = new Uint8Array(digestABuf);
  const digestB = new Uint8Array(digestBBuf);

  if (typeof crypto?.subtle?.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(digestA, digestB);
  }

  let diff = 0;
  for (let i = 0; i < digestA.length; i += 1) {
    diff |= digestA[i] ^ digestB[i];
  }
  return diff === 0;
}

export async function verifyPassword(password, saltHex, expectedHashHex) {
  if (typeof password !== 'string' || !saltHex || !expectedHashHex) {
    await dummyVerifyPassword(typeof password === 'string' ? password : '');
    return false;
  }
  try {
    const { hashHex } = await hashPassword(password, saltHex);
    return await constantTimeEqual(hashHex, String(expectedHashHex).toLowerCase());
  } catch {
    return false;
  }
}

export async function dummyVerifyPassword(password) {
  try {
    const { hashHex } = await hashPassword(typeof password === 'string' ? password : '', DUMMY_SALT_HEX);
    await constantTimeEqual(hashHex, DUMMY_SALT_HEX);
  } catch {
    // ignore
  }
  return false;
}

export async function sha256Hex(str) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(String(str ?? '')));
  return bytesToHex(new Uint8Array(digest));
}

export async function generateSessionToken() {
  const rawBytes = crypto.getRandomValues(new Uint8Array(32));
  const rawToken = bytesToHex(rawBytes);
  const tokenHash = await sha256Hex(rawToken);
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  return {
    rawToken,
    tokenHash,
    sessionId,
    expiresAt,
  };
}

function readHeaderValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return headers.get(name) || '';
  }
  const lower = name.toLowerCase();
  const direct = headers[lower] ?? headers[name];
  if (Array.isArray(direct)) return String(direct[0] || '');
  return typeof direct === 'string' ? direct : '';
}

export function isHttpsRequest(requestOrHeadersUrl) {
  if (!requestOrHeadersUrl) return false;
  if (typeof requestOrHeadersUrl === 'string') {
    return requestOrHeadersUrl.toLowerCase().startsWith('https://');
  }

  const forwardedProto = readHeaderValue(requestOrHeadersUrl.headers, 'x-forwarded-proto');
  if (forwardedProto) {
    const firstProto = forwardedProto.split(',')[0].trim().toLowerCase();
    if (firstProto === 'https') return true;
    if (firstProto === 'http') return false;
  }

  const rawUrl = requestOrHeadersUrl.url;
  if (typeof rawUrl === 'string' && rawUrl.toLowerCase().startsWith('https://')) {
    return true;
  }

  if (requestOrHeadersUrl.socket?.encrypted === true) {
    return true;
  }

  return false;
}

export function buildSessionCookie(rawToken, isHttps) {
  if (isHttps) {
    return `${SESSION_COOKIE_SECURE_NAME}=${rawToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
  }
  return `${SESSION_COOKIE_LOCAL_NAME}=${rawToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function buildClearSessionCookies(isHttps) {
  const cookies = [
    `${SESSION_COOKIE_LOCAL_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  ];
  if (isHttps) {
    cookies.unshift(
      `${SESSION_COOKIE_SECURE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    );
  }
  return cookies;
}

export function parseSessionCookie(cookieHeader) {
  if (typeof cookieHeader !== 'string' || !cookieHeader) return null;
  const cookies = new Map();
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (name && val) {
      cookies.set(name, val);
    }
  }
  const token = cookies.get(SESSION_COOKIE_SECURE_NAME) || cookies.get(SESSION_COOKIE_LOCAL_NAME);
  if (!token) return null;
  try {
    return decodeURIComponent(token);
  } catch {
    return token;
  }
}

export function isDisallowedCrossSiteRequest(method, secFetchSiteHeader) {
  const upperMethod = typeof method === 'string' ? method.toUpperCase() : 'GET';
  if (!MUTATING_METHODS.has(upperMethod)) {
    return false;
  }
  if (typeof secFetchSiteHeader !== 'string' || !secFetchSiteHeader.trim()) {
    return false;
  }
  const site = secFetchSiteHeader.trim().toLowerCase();
  return !ALLOWED_FETCH_SITES.has(site);
}
