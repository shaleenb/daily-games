/**
 * Pluggable Theme Registry & Switcher for Daily Games Hub.
 *
 * HOW TO ADD A NEW THEME:
 * 1. Add a matching `html[data-theme="<id>"]` token block in `/public/css/themes.css`.
 * 2. Append a metadata object to `THEMES` below.
 */

export const THEME_STORAGE_KEY = 'daily-games-theme';

export const THEMES = [
  {
    id: 'auto',
    name: 'Auto (Follow OS)',
    icon: '🌗',
    colorScheme: 'light dark',
    description: 'Pocket Sunburst by day, Midnight Cabinet by night',
    swatches: ['#F6F0E2', '#252031', '#FF5A36'],
  },
  {
    id: 'arcade-day',
    name: 'Pocket Sunburst',
    icon: '☀️',
    colorScheme: 'light',
    description: 'Warm handheld cream & coral keycaps',
    swatches: ['#F6F0E2', '#FFFDF8', '#FF5A36'],
  },
  {
    id: 'arcade-night',
    name: 'Midnight Cabinet',
    icon: '🕹️',
    colorScheme: 'dark',
    description: 'Cozy plum-charcoal & arcade neon',
    swatches: ['#17141F', '#252031', '#FF7A3D'],
  },
  {
    id: 'mint-cartridge',
    name: 'Matcha Boy',
    icon: '🍵',
    colorScheme: 'light',
    description: 'Retro mint shell & jade keycaps',
    swatches: ['#E3F2E9', '#F9FDFA', '#00A86B'],
  },
];

const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';
const THEME_BY_ID = new Map(THEMES.map((t) => [t.id, t]));

/**
 * Normalize legacy ('light'/'dark') or unknown IDs into a valid registry theme ID.
 */
export function normalizeThemePreference(rawPref) {
  if (rawPref === 'light') return 'arcade-day';
  if (rawPref === 'dark') return 'arcade-night';
  if (typeof rawPref === 'string' && THEME_BY_ID.has(rawPref)) {
    return rawPref;
  }
  return 'auto';
}

export function getSavedThemeId() {
  try {
    return normalizeThemePreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'auto';
  }
}

export function isSystemDark() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(DARK_MEDIA_QUERY).matches
  );
}

/**
 * Resolve a theme preference ('auto' or a concrete theme ID) to the concrete theme object.
 */
export function resolveActiveTheme(prefId) {
  const normalized = normalizeThemePreference(prefId);
  if (normalized === 'auto') {
    const concreteId = isSystemDark() ? 'arcade-night' : 'arcade-day';
    return THEME_BY_ID.get(concreteId) || THEMES[1];
  }
  return THEME_BY_ID.get(normalized) || THEMES[1];
}

export function getThemeOption(prefId) {
  const normalized = normalizeThemePreference(prefId);
  return THEME_BY_ID.get(normalized) || THEMES[0];
}

/**
 * Apply the selected theme to `<html>` and `<meta name="color-scheme">`,
 * persisting the preference in localStorage.
 */
export function applyTheme(prefId) {
  const normalizedPref = normalizeThemePreference(prefId);
  const resolved = resolveActiveTheme(normalizedPref);

  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = resolved.id;
    document.documentElement.dataset.themePreference = normalizedPref;

    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) {
      meta.content = normalizedPref === 'auto' ? 'light dark' : resolved.colorScheme || 'light';
    }
  }

  try {
    localStorage.setItem(THEME_STORAGE_KEY, normalizedPref);
  } catch {
    // Ignore storage unavailability
  }

  return { preference: normalizedPref, resolved };
}

/**
 * Initialize theme state and subscribe to OS color-scheme changes when in 'auto' mode.
 */
export function initThemeSystem(onThemeChanged = null) {
  const currentPref = getSavedThemeId();
  const state = applyTheme(currentPref);

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const media = window.matchMedia(DARK_MEDIA_QUERY);
    const handleOsChange = () => {
      if (getSavedThemeId() === 'auto') {
        const next = applyTheme('auto');
        if (typeof onThemeChanged === 'function') {
          onThemeChanged(next);
        }
      }
    };
    media.addEventListener('change', handleOsChange);
  }

  return state;
}
