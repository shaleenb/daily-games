import { api } from './api.js';
import {
  renderActivityHeatmap,
  renderBreakdownChart,
  renderDistributionChart,
  renderSparkline,
  renderTrendChart,
} from './charts.js';
import {
  CLUES_BY_SAM_DIFFICULTIES,
  COMMON_RESET_TIMEZONES,
  GENERIC_PARSER,
  PARSERS,
  PERCEPTLE_ROUNDS,
  analyzeCluesBySamGrid,
  detectGameAndParse,
  extractEmojiGrid,
  formatCountdownCompact,
  formatDurationSeconds,
  formatMetricValue,
  getGamePuzzleStatus,
  getLocalDateString,
  getParserForGame,
  isValidResetTime,
  isValidResetTimezone,
  normalizeDifficultyLabel,
  parseDurationSeconds,
  parseForGame,
  slugify,
} from '/shared/parsers/registry.js';
import {
  OPTIONAL_CATALOG_GAMES,
  STARTER_GAMES,
  enrichGameMetadata,
} from '/shared/auth-crypto.js';
import {
  THEMES,
  applyTheme,
  getSavedThemeId,
  getThemeOption,
  initThemeSystem,
  resolveActiveTheme,
} from './themes.js';
import {
  compareCluesBySamEntries,
  computeGameStats,
  computeHeatmap,
  computeLeaderboard,
  getCluesBySamAccuracy,
  isCluesBySamGame,
} from '/shared/stats.js';

const SCORING_PRESETS = {
  points: {
    metricLabel: 'Score',
    metricFormat: 'number',
    metricDirection: 'higher_is_better',
  },
  time: {
    metricLabel: 'Solve Time',
    metricFormat: 'duration_sec',
    metricDirection: 'lower_is_better',
  },
  guesses: {
    metricLabel: 'Guesses',
    metricFormat: 'fraction',
    metricDirection: 'lower_is_better',
  },
  percent: {
    metricLabel: 'Accuracy',
    metricFormat: 'percent',
    metricDirection: 'higher_is_better',
  },
};

const state = {
  user: null,
  authMode: 'signin',
  isSubmittingAuth: false,
  signupCatalog: null,
  signupSelectedSlugs: new Set(),
  signupPickerInitialized: false,
  activeTab: 'today',
  todayStr: getLocalDateString(),
  selectedDate: getLocalDateString(),
  todaySelectedTag: 'All',
  games: [],
  catalog: [],
  subscribingSlugs: new Set(),
  dialogCatalogTag: 'All',
  friendsCatalogTag: 'All',
  friendsCatalogSearch: '',
  openCatalogCollections: new Set(['community', 'magnitudle']),
  parsers: [],
  entriesForDate: [],
  allEntries: [],
  entriesLoaded: false,
  cardSummaries: {},
  dailyOverview: {
    activeGamesCount: 0,
    playedTodayCount: 0,
    routineStreak: 0,
    playedTodayInStreak: false,
    fullSweepDays: 0,
  },
  statsResponse: null,
  leaderboardResponse: null,
  leaderboardCache: new Map(),
  leaderboardPrefetch: null,
  lbDate: getLocalDateString(),
  lbDays: 30,
  lbSelectedGameSlug: null,
  lbOverallSortKey: 'points',
  lbOverallSortDir: 'desc',
  lbGameSortKey: 'points',
  lbGameSortDir: 'desc',
  leaderboardDifficulty: 'all',
  isLoadingLeaderboard: false,
  lastOpenedGameId: null,
  activeCaptureGameId: null,
  justStampedGameId: null,
  selectedStatsGameId: null,
  statsDays: 30,
  statsDifficulty: 'all',
  selectedHeatmapDate: null,
  pendingImportData: null,
  confirmResolve: null,
  quickPasteManualOverride: false,
  quickPasteDateManuallyEdited: false,
  entryModalDateManuallyEdited: false,
  solvedSegMode: 'auto',
  entryModalDifficulty: '',
  entryModalDifficultyTouched: false,
  entryModalRoundsTouched: false,
  entryModalValueAutoFilled: false,
  isSavingEntry: false,
  isSavingGame: false,
  isRefreshingReset: false,
  isBootstrapping: false,
  lastBootstrapDate: null,
  trackedResetEpochs: new Map(),
  resetTickerId: null,
};

const els = {};

function $(id) {
  return document.getElementById(id);
}

/**
 * Keep both `.hidden` utility class and native `[hidden]` attribute synchronized
 * so `@layer utilities` `.hidden { display: none !important; }` never gets stuck.
 */
function setHidden(el, hidden) {
  if (!el) return;
  const flag = Boolean(hidden);
  el.classList.toggle('hidden', flag);
  el.hidden = flag;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeHexColor(value, fallback = '#ff5a36') {
  const raw = String(value ?? '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
    const [, r, g, b] = raw;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return fallback;
}

function getReadableTextColor(hex) {
  const clean = normalizeHexColor(hex, '#ff5a36').slice(1);
  const channels = [0, 2, 4].map((idx) => {
    const val = parseInt(clean.slice(idx, idx + 2), 16) / 255;
    return val <= 0.03928 ? val / 12.92 : Math.pow((val + 0.055) / 1.055, 2.4);
  });
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return luminance > 0.36 ? '#15141a' : '#ffffff';
}

function isSafeHttpUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function addDays(dateStr, delta) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(year, month - 1, day + delta, 12, 0, 0, 0);
  return getLocalDateString(d);
}

function formatPrettyDate(dateStr, todayStr = state.todayStr) {
  if (!dateStr) return 'Today';
  if (dateStr === todayStr) return 'Today';
  if (dateStr === addDays(todayStr, -1)) return 'Yesterday';
  if (dateStr === addDays(todayStr, 1)) return 'Tomorrow';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dateObj = new Date(y, m - 1, d, 12, 0, 0, 0);
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(dateObj);
}

function formatShortDayInitial(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dateObj = new Date(y, m - 1, d, 12, 0, 0, 0);
  return new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(dateObj);
}

function getViewerTimeZone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && tz !== 'local' && isValidResetTimezone(tz)) {
      return tz;
    }
  } catch {
    // fallback below
  }
  return undefined;
}

function isLiveTodayMode() {
  return state.selectedDate === state.todayStr;
}

function getLivePuzzleStatus(game, now = new Date()) {
  if (!game) return null;
  const serverStatus = state.cardSummaries[game.id]?.puzzleStatus;
  try {
    return getGamePuzzleStatus(
      {
        resetTimezone: game.resetTimezone ?? serverStatus?.resetTimezone ?? 'local',
        resetTime: game.resetTime ?? serverStatus?.resetTime ?? '00:00',
      },
      now,
      getViewerTimeZone()
    );
  } catch {
    return serverStatus || null;
  }
}

function getDefaultPlayDateForGame(game) {
  if (!isLiveTodayMode() || !game) {
    return state.selectedDate;
  }
  return getLivePuzzleStatus(game)?.activePuzzleDate || state.selectedDate;
}

function formatResetTooltip(game, puzzleStatus) {
  if (!puzzleStatus) return '';
  const time = isValidResetTime(game?.resetTime) ? game.resetTime : '00:00';
  return `Resets daily at ${time} (${puzzleStatus.resolvedTimezone}) · ${puzzleStatus.nextResetLocalTime} your time (${puzzleStatus.countdownLabel} left)`;
}

function getResetScheduleSummary(game) {
  const tz = game?.resetTimezone || 'local';
  const time = isValidResetTime(game?.resetTime) ? game.resetTime : '00:00';
  if (tz === 'local' && time === '00:00') {
    return 'Local midnight';
  }
  const match = COMMON_RESET_TIMEZONES.find((item) => item.id === tz);
  const tzLabel = tz === 'local' ? 'Local' : match ? match.label : tz;
  return `${tzLabel} · ${time}`;
}

function snapshotResetEpochs(now = new Date()) {
  const nowMs = now.getTime();
  const nextMap = new Map();
  for (const game of state.games) {
    const serverEpoch = state.cardSummaries[game.id]?.puzzleStatus?.nextResetEpochMs;
    const liveStatus = getLivePuzzleStatus(game, now);
    const epoch =
      Number.isFinite(serverEpoch) && serverEpoch > nowMs
        ? serverEpoch
        : liveStatus?.nextResetEpochMs;
    if (Number.isFinite(epoch)) {
      nextMap.set(game.id, epoch);
    }
  }
  state.trackedResetEpochs = nextMap;
}

function formatEntryResult(entry, game) {
  if (!entry) return 'Played';
  if (entry.displayValue) return entry.displayValue;
  const fallback = entry.solved === false ? 'DNF' : 'Played';
  if (entry.primaryValue !== null && entry.primaryValue !== undefined) {
    return formatMetricValue(entry.primaryValue, game?.metricFormat || 'number', fallback);
  }
  if (entry.solved === true) return 'Solved';
  if (entry.solved === false) return 'DNF';
  return 'Played';
}

function computeStatusMeta(entry) {
  if (!entry) return { label: 'Queued', pillClass: 'pill-neutral' };
  if (entry.solved === true) return { label: 'Solved', pillClass: 'pill-success' };
  if (entry.solved === false) return { label: 'DNF', pillClass: 'pill-danger' };
  return { label: 'Played', pillClass: 'pill-neutral' };
}

function getActiveGames() {
  return state.games.filter((g) => !g.archived);
}

function getGameTags(game) {
  const raw = Array.isArray(game?.tags) && game.tags.length > 0 ? game.tags : [];
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    const label = typeof t === 'string' ? t.trim() : '';
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  if (out.length === 0 && typeof game?.category === 'string' && game.category.trim()) {
    out.push(game.category.trim());
  }
  return out;
}

function safeIsCluesBySamGame(game) {
  if (typeof isCluesBySamGame === 'function') {
    return isCluesBySamGame(game);
  }
  if (!game) return false;
  return (
    game.slug === 'cluesbysam' ||
    game.parserId === 'cluesbysam' ||
    game.resolvedParser?.id === 'cluesbysam'
  );
}

function safeGetCluesBySamAccuracy(item) {
  if (!item || typeof item !== 'object') {
    return { hasGrid: false, accuracyPenalty: null, isPerfect: false, accuracySummary: null };
  }
  if (typeof getCluesBySamAccuracy === 'function') {
    const res = getCluesBySamAccuracy(item);
    if (res && typeof res === 'object') return res;
  }
  const m = item.metadata;
  if (m && typeof m === 'object' && m.accuracySummary) {
    return {
      hasGrid: true,
      accuracyPenalty: Number.isFinite(Number(m.accuracyPenalty)) ? Number(m.accuracyPenalty) : null,
      isPerfect: Boolean(m.isPerfect),
      accuracySummary: String(m.accuracySummary),
    };
  }
  const grid =
    (typeof m?.emojiGrid === 'string' && m.emojiGrid.trim()) ||
    (typeof item.rawText === 'string' && extractEmojiGrid(item.rawText)) ||
    '';
  if (grid && typeof analyzeCluesBySamGrid === 'function') {
    const analyzed = analyzeCluesBySamGrid(grid);
    if (analyzed && Number(analyzed.totalTiles) > 0) {
      return { hasGrid: true, ...analyzed };
    }
  }
  return { hasGrid: false, accuracyPenalty: null, isPerfect: false, accuracySummary: null };
}

function safeCompareCluesBySamEntries(entryA, entryB) {
  if (typeof compareCluesBySamEntries === 'function') {
    return compareCluesBySamEntries(entryA, entryB);
  }
  const solvedA = entryA?.solved !== false;
  const solvedB = entryB?.solved !== false;
  if (solvedA !== solvedB) return solvedA ? -1 : 1;
  if (!solvedA && !solvedB) return 0;
  const accA = safeGetCluesBySamAccuracy(entryA);
  const accB = safeGetCluesBySamAccuracy(entryB);
  if (accA.hasGrid && accB.hasGrid && accA.accuracyPenalty !== accB.accuracyPenalty) {
    return accA.accuracyPenalty - accB.accuracyPenalty;
  }
  if (accA.hasGrid !== accB.hasGrid) return accA.hasGrid ? -1 : 1;
  const tA = entryA?.primaryValue !== null && Number.isFinite(Number(entryA?.primaryValue)) ? Number(entryA.primaryValue) : null;
  const tB = entryB?.primaryValue !== null && Number.isFinite(Number(entryB?.primaryValue)) ? Number(entryB.primaryValue) : null;
  if (tA !== null && tB !== null) return tA - tB;
  if (tA !== null || tB !== null) return tA !== null ? -1 : 1;
  return 0;
}

function getGameById(gameId) {
  const idNum = Number(gameId);
  return state.games.find((g) => g.id === idNum) || null;
}

function getParserMeta(parserId) {
  const list = Array.isArray(PARSERS) ? PARSERS : Object.values(PARSERS || {});
  const fromRegistry = list.find((p) => p?.id === parserId);
  if (fromRegistry) return fromRegistry;
  const fromState = state.parsers.find((p) => p?.id === parserId);
  if (fromState) return fromState;
  return GENERIC_PARSER || { id: 'generic', name: 'Generic (Auto-extract)' };
}

function getGameDomainLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function wireDialogLightDismiss(dialog, onCloseCallback) {
  if (!dialog) return;
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const clickedInside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      if (!clickedInside) {
        dialog.close('dismiss');
      }
    });
  }
  if (typeof onCloseCallback === 'function') {
    dialog.addEventListener('close', () => onCloseCallback(dialog.returnValue));
  }
}

function openModalDialog(dialog) {
  if (!dialog) return;
  if (!dialog.open) {
    dialog.showModal();
  }
}

function closeModalDialog(dialog, returnValue = 'cancel') {
  if (!dialog) return;
  if (dialog.open) {
    dialog.close(returnValue);
  }
}

function showToast(message, options = {}) {
  const {
    variant = 'info',
    duration = 4200,
    actionLabel,
    onAction,
    secondaryLabel,
    onSecondaryAction,
  } = options;
  const region = els.toastRegion;
  if (!region) return;

  const variantClass =
    variant === 'success' || variant === 'warning' || variant === 'error'
      ? ` is-${variant}`
      : '';

  const toast = document.createElement('div');
  toast.className = `toast${variantClass}`;
  toast.setAttribute('role', variant === 'error' ? 'alert' : 'status');

  const msgEl = document.createElement('span');
  msgEl.className = 'toast-message';
  msgEl.textContent = message;
  toast.appendChild(msgEl);

  const actionsWrap = document.createElement('div');
  actionsWrap.className = 'toast-actions';

  const dismiss = () => {
    if (!toast.isConnected) return;
    toast.remove();
  };

  if (actionLabel && typeof onAction === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary btn-xs';
    btn.textContent = actionLabel;
    btn.addEventListener('click', () => {
      dismiss();
      onAction();
    });
    actionsWrap.appendChild(btn);
  }

  if (secondaryLabel && typeof onSecondaryAction === 'function') {
    const btn2 = document.createElement('button');
    btn2.type = 'button';
    btn2.className = 'btn btn-secondary btn-xs';
    btn2.textContent = secondaryLabel;
    btn2.addEventListener('click', () => {
      dismiss();
      onSecondaryAction();
    });
    actionsWrap.appendChild(btn2);
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn-ghost btn-xs';
  closeBtn.setAttribute('aria-label', 'Dismiss notification');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', dismiss);
  actionsWrap.appendChild(closeBtn);

  toast.appendChild(actionsWrap);
  region.appendChild(toast);

  if (duration > 0) {
    setTimeout(dismiss, duration);
  }
}

function confirmAction({ title = 'Confirm Action', message = 'Are you sure?', okLabel = 'Confirm' }) {
  return new Promise((resolve) => {
    state.confirmResolve = resolve;
    els.confirmTitle.textContent = title;
    els.confirmMessage.textContent = message;
    els.confirmOkBtn.textContent = okLabel;
    openModalDialog(els.confirmDialog);
    els.confirmOkBtn.focus();
  });
}

function resolveConfirm(accepted) {
  const resolver = state.confirmResolve;
  state.confirmResolve = null;
  if (els.confirmDialog?.open) {
    closeModalDialog(els.confirmDialog, accepted ? 'confirm' : 'cancel');
  }
  if (typeof resolver === 'function') {
    resolver(Boolean(accepted));
  }
}

function cacheElements() {
  els.mainNav = $('main-nav');
  els.mainContent = $('main-content');
  els.tabButtons = Array.from(document.querySelectorAll('.nav-tab[data-tab]'));
  els.viewToday = $('view-today');
  els.viewLeaderboard = $('view-leaderboard');
  els.viewStats = $('view-stats');
  els.viewGames = $('view-games');

  els.btnOpenAddGame = $('btn-open-add-game');
  els.addGameCatalogBadge = $('add-game-catalog-badge');
  els.userPlayerBar = $('user-player-bar');
  els.userBadgeName = $('user-badge-name');
  els.btnLogout = $('btn-logout');
  els.btnThemeMenu = $('btn-theme-menu');
  els.themeTriggerIcon = $('theme-trigger-icon');
  els.themeTriggerName = $('theme-trigger-name');
  els.themePopover = $('theme-popover');
  els.themeOptionsList = $('theme-options-list');
  els.toastRegion = $('toast-region');

  // Auth screen
  els.authScreen = $('auth-screen');
  els.authClaimNotice = $('auth-claim-notice');
  els.btnAuthModeSignin = $('btn-auth-mode-signin');
  els.btnAuthModeSignup = $('btn-auth-mode-signup');
  els.signinForm = $('signin-form');
  els.signinError = $('signin-error');
  els.signinEmail = $('signin-email');
  els.signinPassword = $('current-password');
  els.btnSigninSubmit = $('btn-signin-submit');
  els.signupForm = $('signup-form');
  els.signupError = $('signup-error');
  els.signupName = $('signup-name');
  els.signupEmail = $('signup-email');
  els.signupPassword = $('new-password');
  els.signupGamesFieldset = $('signup-games-fieldset');
  els.signupSelectedCount = $('signup-selected-count');
  els.btnSignupSelectAll = $('btn-signup-select-all');
  els.btnSignupClearAll = $('btn-signup-clear-all');
  els.signupFeaturedGames = $('signup-featured-games');
  els.signupOptionalCollections = $('signup-optional-collections');
  els.signupOptionalCount = $('signup-optional-count');
  els.signupOptionalBody = $('signup-optional-body');
  els.btnSignupSubmit = $('btn-signup-submit');
  els.passwordToggleButtons = Array.from(document.querySelectorAll('[data-toggle-password]'));

  // Today HUD
  els.btnPrevDay = $('btn-prev-day');
  els.hudDatePretty = $('hud-date-pretty');
  els.todayDateInput = $('today-date-input');
  els.btnNextDay = $('btn-next-day');
  els.btnToday = $('btn-today');
  els.kpiPlayedToday = $('kpi-played-today');
  els.kpiRoutineStreak = $('kpi-routine-streak');
  els.kpiFullSweeps = $('kpi-full-sweeps');
  els.hudSegments = $('hud-segments');
  els.btnLaunchNext = $('btn-launch-next');
  els.btnOpenAllUnplayed = $('btn-open-all-unplayed');
  els.btnPasteHud = $('btn-paste-hud');
  els.kbdPasteHint = $('kbd-paste-hint');
  els.popupNotice = $('popup-notice');

  // Quick paste tray
  els.quickPasteTray = $('quick-paste-tray');
  els.btnClipboardPaste = $('btn-clipboard-paste');
  els.btnQuickPasteClear = $('btn-quick-paste-clear');
  els.btnClosePasteTray = $('btn-close-paste-tray');
  els.quickPasteTextarea = $('quick-paste-textarea');
  els.quickPastePreview = $('quick-paste-preview');
  els.quickPasteGameSelect = $('quick-paste-game-select');
  els.quickPasteDateInput = $('quick-paste-date-input');
  els.btnQuickPasteSave = $('btn-quick-paste-save');

  // Today shelves
  els.todayTagFilterBar = $('today-tag-filter-bar');
  els.toPlaySection = $('to-play-section');
  els.countToPlay = $('count-to-play');
  els.toPlayGrid = $('to-play-grid');
  els.completedSection = $('completed-section');
  els.countCompleted = $('count-completed');
  els.completedGrid = $('completed-grid');

  // Players Leaderboard view
  els.leaderboardPlayersSubtitle = $('leaderboard-players-subtitle');
  els.lbCompetingScopeChip = $('lb-competing-scope-chip');
  els.btnLbPrevDay = $('btn-lb-prev-day');
  els.lbDatePretty = $('lb-date-pretty');
  els.lbDateInput = $('lb-date-input');
  els.btnLbNextDay = $('btn-lb-next-day');
  els.btnLbToday = $('btn-lb-today');
  els.lbWindowGroup = $('lb-window-group');
  els.btnLbDays1 = $('btn-lb-days-1');
  els.btnLbRefresh = $('btn-lb-refresh');
  els.overallStandingsCard = $('overall-standings-card');
  els.overallStandingsTitle = $('overall-standings-title');
  els.playersOverallTable = $('players-overall-table');
  els.playersOverallTbody = $('players-overall-tbody');
  els.todayMatrixCard = $('today-matrix-card');
  els.playersMatrixSubtitle = $('players-matrix-subtitle');
  els.playersMatrixThead = $('players-matrix-thead');
  els.playersMatrixTbody = $('players-matrix-tbody');
  els.gamewiseLeaderboardCard = $('gamewise-leaderboard-card');
  els.lbGamePills = $('lb-game-pills');
  els.lbDifficultyBar = $('lb-difficulty-bar');
  els.lbGameHeader = $('lb-game-header');
  els.playersGameTable = $('players-game-table');
  els.playersGameTbody = $('players-game-tbody');

  // Stats view
  els.btnClearHeatmapDay = $('btn-clear-heatmap-day');
  els.activityHeatmapContainer = $('activity-heatmap-container');
  els.heatmapDayDetail = $('heatmap-day-detail');
  els.leaderboardTbody = $('leaderboard-tbody');
  els.statsGamePills = $('stats-game-pills');
  els.statsWindowGroup = $('stats-window-group');
  els.statsDifficultyBar = $('stats-difficulty-bar');
  els.btnReparseGame = $('btn-reparse-game');
  els.statsGameHeader = $('stats-game-header');
  els.statsKpisGrid = $('stats-kpis-grid');
  els.trendChartContainer = $('trend-chart-container');
  els.distributionChartContainer = $('distribution-chart-container');
  els.breakdownChartContainer = $('breakdown-chart-container');
  els.historyCountLabel = $('history-count-label');
  els.historyTbody = $('history-tbody');

  // My Games view & Parser Lab
  els.btnAddGameAdmin = $('btn-add-game-admin');
  els.rosterCompeteBar = $('roster-compete-bar');
  els.manageGamesList = $('manage-games-list');
  els.friendsCatalogShelf = $('friends-catalog-shelf');
  els.friendsCatalogCount = $('friends-catalog-count');
  els.friendsCatalogSearch = $('friends-catalog-search');
  els.friendsCatalogTagBar = $('friends-catalog-tag-bar');
  els.friendsCatalogCollections = $('friends-catalog-collections');
  els.btnExportJson = $('btn-export-json');
  els.importFileInput = $('import-file-input');
  els.importFileSummary = $('import-file-summary');
  els.btnImportJson = $('btn-import-json');
  els.parserLabDrawer = $('parser-lab-drawer');
  els.workbenchMetaStrip = $('workbench-meta-strip');
  els.btnCopyParserRequest = $('btn-copy-parser-request');
  els.workbenchGameSelect = $('workbench-game-select');
  els.workbenchSampleText = $('workbench-sample-text');
  els.workbenchJsonOutput = $('workbench-json-output');

  // Entry dialog
  els.entryDialog = $('entry-dialog');
  els.entryModalIcon = $('entry-modal-icon');
  els.entryModalTitle = $('entry-modal-title');
  els.entryModalSubtitle = $('entry-modal-subtitle');
  els.btnCloseEntryModal = $('btn-close-entry-modal');
  els.entryModalForm = $('entry-modal-form');
  els.entryModalId = $('entry-modal-id');
  els.entryModalGameId = $('entry-modal-game-id');
  els.btnModalPasteClipboard = $('btn-modal-paste-clipboard');
  els.btnMarkPlayedNoscore = $('btn-mark-played-noscore');
  els.entryModalRawText = $('entry-modal-raw-text');
  els.entryModalParsePreview = $('entry-modal-parse-preview');
  els.entryModalManualOverride = $('entry-modal-manual-override');
  els.entryModalValueLabel = $('entry-modal-value-label');
  els.entryModalValueInput = $('entry-modal-value-input');
  els.entryModalPuzzleId = $('entry-modal-puzzle-id');
  els.entryModalSolvedGroup = $('entry-modal-solved-group');
  els.entryModalDifficultyGroup = $('entry-modal-difficulty-group');
  els.entryModalDifficultyPills = $('entry-modal-difficulty-pills');
  els.entryModalRoundsGroup = $('entry-modal-rounds-group');
  els.entryModalRoundsInputs = $('entry-modal-rounds-inputs');
  els.entryModalDate = $('entry-modal-date');
  els.entryModalNotes = $('entry-modal-notes');
  els.btnEntryModalDelete = $('btn-entry-modal-delete');
  els.btnCancelEntryModal = $('btn-cancel-entry-modal');
  els.btnSaveEntryModal = $('btn-save-entry-modal');

  // Game dialog
  els.gameDialog = $('game-dialog');
  els.gameDialogPreviewIcon = $('game-dialog-preview-icon');
  els.gameFormTitle = $('game-form-title');
  els.gameDialogSubtitle = $('game-dialog-subtitle');
  els.btnCloseGameDialog = $('btn-close-game-dialog');
  els.catalogPickerSection = $('catalog-picker-section');
  els.catalogSearchInput = $('catalog-search-input');
  els.catalogTagBar = $('catalog-tag-bar');
  els.catalogAvailableList = $('catalog-available-list');
  els.catalogOwnedDetails = $('catalog-owned-details');
  els.catalogOwnedSummary = $('catalog-owned-summary');
  els.catalogOwnedList = $('catalog-owned-list');
  els.createCustomDivider = $('create-custom-divider');
  els.gameCatalogMatchBanner = $('game-catalog-match-banner');
  els.gameForm = $('game-form');
  els.gameFormId = $('game-form-id');
  els.gameName = $('game-name');
  els.gameUrl = $('game-url');
  els.gameIcon = $('game-icon');
  els.gameColor = $('game-color');
  els.gameColorHex = $('game-color-hex');
  els.gameCategory = $('game-category');
  els.scoringModeGrid = $('scoring-mode-grid');
  els.advancedGameDetails = $('advanced-game-details');
  els.gameMetricLabel = $('game-metric-label');
  els.gameMetricFormat = $('game-metric-format');
  els.gameMetricDirection = $('game-metric-direction');
  els.gameParserId = $('game-parser-id');
  els.gameResetTimezone = $('game-reset-timezone');
  els.gameResetTime = $('game-reset-time');
  els.gameResetPreview = $('game-reset-preview');
  els.btnCancelGameDialog = $('btn-cancel-game-dialog');
  els.btnSaveGame = $('btn-save-game');

  // Confirm dialog
  els.confirmDialog = $('confirm-dialog');
  els.confirmTitle = $('confirm-modal-title');
  els.btnCloseConfirm = $('btn-close-confirm-modal');
  els.confirmMessage = $('confirm-modal-message');
  els.confirmCancelBtn = $('btn-confirm-cancel');
  els.confirmOkBtn = $('btn-confirm-ok');
}

function getThemeCatalog() {
  return Array.isArray(THEMES) ? THEMES : Object.values(THEMES || {});
}

function renderThemeOptions() {
  if (!els.themeOptionsList) return;
  const savedId = getSavedThemeId();
  const resolvedTheme = resolveActiveTheme(savedId);
  const catalog = getThemeCatalog();

  els.themeOptionsList.innerHTML = catalog
    .map((theme) => {
      const id = theme.id;
      const isSelected = savedId === id;
      const name = theme.name || id;
      const desc = theme.description || '';
      const icon = theme.icon || '🎨';
      const swatches = Array.isArray(theme.swatches) ? theme.swatches : [];
      const activeTag = id === 'auto' && resolvedTheme ? ` (${resolvedTheme.name})` : '';

      return `
        <button
          type="button"
          class="theme-option-btn${isSelected ? ' is-active' : ''}"
          data-theme-id="${escapeHtml(id)}"
          role="option"
          aria-selected="${isSelected ? 'true' : 'false'}"
        >
          <span class="theme-option-main">
            <span class="theme-option-icon" aria-hidden="true">${escapeHtml(icon)}</span>
            <span>
              <span class="theme-option-name">${escapeHtml(name)}${escapeHtml(activeTag)}</span>
              <span class="theme-option-desc">${escapeHtml(desc)}</span>
            </span>
          </span>
          <span class="theme-swatches" aria-hidden="true">
            ${swatches
              .slice(0, 4)
              .map((c) => `<span class="theme-swatch-dot" style="background:${escapeHtml(c)};"></span>`)
              .join('')}
          </span>
        </button>
      `;
    })
    .join('');

  updateThemeButtonUI();
}

function updateThemeButtonUI() {
  const savedId = getSavedThemeId();
  const savedOpt = getThemeOption(savedId);
  const resolvedOpt = resolveActiveTheme(savedId);

  if (els.themeTriggerIcon) {
    els.themeTriggerIcon.textContent = savedOpt?.icon || resolvedOpt?.icon || '🎨';
  }
  if (els.themeTriggerName) {
    els.themeTriggerName.textContent =
      savedId === 'auto'
        ? `Auto · ${resolvedOpt?.name || 'Arcade'}`
        : savedOpt?.name || savedId;
  }
  if (els.themeOptionsList) {
    els.themeOptionsList.querySelectorAll('.theme-option-btn[data-theme-id]').forEach((btn) => {
      const selected = btn.dataset.themeId === savedId;
      btn.classList.toggle('is-active', selected);
      btn.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
  }
}

function selectTheme(themeId) {
  applyTheme(themeId);
  renderThemeOptions();
  if (els.themePopover && typeof els.themePopover.hidePopover === 'function') {
    try {
      els.themePopover.hidePopover();
    } catch {
      // Already hidden
    }
  }
  if (state.activeTab === 'stats' && state.statsResponse) {
    renderStatsViewContent();
  }
}

function applyBootstrapPayload(bootstrap, entriesFallback = null) {
  if (bootstrap?.user) {
    state.user = bootstrap.user;
    if (els.userBadgeName) {
      els.userBadgeName.textContent =
        bootstrap.user.displayName || bootstrap.user.name || bootstrap.user.email || 'Player';
    }
  }
  state.games = bootstrap?.games || [];
  state.catalog = Array.isArray(bootstrap?.catalog) ? bootstrap.catalog : [];
  state.parsers = bootstrap?.parsers || [];
  state.entriesForDate = bootstrap?.entriesForDate || [];
  state.cardSummaries = bootstrap?.cardSummaries || {};
  state.dailyOverview = bootstrap?.dailyOverview || state.dailyOverview;
  if (Array.isArray(bootstrap?.entries)) {
    state.allEntries = bootstrap.entries;
    state.entriesLoaded = true;
  } else if (Array.isArray(entriesFallback)) {
    state.allEntries = entriesFallback;
    state.entriesLoaded = true;
  }
  state.lastBootstrapDate = state.selectedDate;
  snapshotResetEpochs();
  updateCatalogDiscoveryBadge();

  const activeGames = getActiveGames();
  if (!state.selectedStatsGameId || !getGameById(state.selectedStatsGameId)) {
    state.selectedStatsGameId = activeGames[0]?.id || state.games[0]?.id || null;
  }
}

async function refreshBootstrapAndEntries() {
  state.todayStr = getLocalDateString();
  const live = isLiveTodayMode();
  const viewerTz = live ? getViewerTimeZone() : undefined;
  const bootstrap = await api.getBootstrap(
    state.selectedDate,
    live ? { live: true, tz: viewerTz } : {}
  );
  let entriesFallback = null;
  if (!Array.isArray(bootstrap?.entries)) {
    const entriesResp = await api.getEntries({ limit: 800 });
    entriesFallback = Array.isArray(entriesResp) ? entriesResp : entriesResp?.entries || [];
  }
  applyBootstrapPayload(bootstrap, entriesFallback);
  return bootstrap;
}

function getTodayEntryMap() {
  const map = new Map();
  for (const entry of state.entriesForDate) {
    map.set(entry.gameId, entry);
  }
  return map;
}

function getEntriesForGame(gameId) {
  const idNum = Number(gameId);
  return state.allEntries
    .filter((e) => e.gameId === idNum)
    .sort((a, b) => a.playDate.localeCompare(b.playDate));
}

function getLastNDaysStrip(gameId, endDate, count = 7) {
  const idNum = Number(gameId);
  const map = new Map();
  for (const e of state.allEntries) {
    if (e.gameId === idNum) {
      map.set(e.playDate, e);
    }
  }
  const days = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = addDays(endDate, -i);
    const entry = map.get(d) || null;
    days.push({
      date: d,
      initial: formatShortDayInitial(d),
      entry,
      isSelectedDay: d === endDate,
    });
  }
  return days;
}

function populateGameSelects() {
  const activeGames = getActiveGames();

  if (els.quickPasteGameSelect) {
    const prev = els.quickPasteGameSelect.value;
    els.quickPasteGameSelect.innerHTML =
      `<option value="">Auto-detect game…</option>` +
      activeGames
        .map(
          (g) =>
            `<option value="${escapeHtml(g.id)}">${escapeHtml(g.icon || '🎮')} ${escapeHtml(g.name)}</option>`
        )
        .join('');
    if (prev && activeGames.some((g) => String(g.id) === String(prev))) {
      els.quickPasteGameSelect.value = prev;
    } else if (state.lastOpenedGameId && activeGames.some((g) => g.id === state.lastOpenedGameId)) {
      els.quickPasteGameSelect.value = String(state.lastOpenedGameId);
    }
  }

  if (els.workbenchGameSelect) {
    const prevWb = els.workbenchGameSelect.value;
    els.workbenchGameSelect.innerHTML = state.games
      .map(
        (g) =>
          `<option value="${escapeHtml(g.id)}">${escapeHtml(g.icon || '🎮')} ${escapeHtml(g.name)}</option>`
      )
      .join('');
    if (prevWb && state.games.some((g) => String(g.id) === String(prevWb))) {
      els.workbenchGameSelect.value = prevWb;
    } else if (state.games[0]) {
      els.workbenchGameSelect.value = String(state.games[0].id);
    }
  }

  if (els.gameParserId) {
    const prevParser = els.gameParserId.value;
    const allParsers = Array.isArray(PARSERS) ? [...PARSERS] : Object.values(PARSERS || {});
    const options = [
      { id: 'auto', name: 'Auto-detect (Recommended)' },
      GENERIC_PARSER || { id: 'generic', name: 'Generic (Auto-extract)' },
      ...allParsers,
    ];
    els.gameParserId.innerHTML = options
      .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.id)}</option>`)
      .join('');
    if (prevParser) {
      els.gameParserId.value = prevParser;
    }
  }
}

function populateResetTimezoneSelect(selectedTz = 'local') {
  if (!els.gameResetTimezone) return;
  const normalized = isValidResetTimezone(selectedTz) ? selectedTz : 'local';
  const options = [...COMMON_RESET_TIMEZONES];
  if (normalized && !options.some((item) => item.id === normalized)) {
    options.push({ id: normalized, label: `${normalized} (Custom)` });
  }
  els.gameResetTimezone.innerHTML = options
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`)
    .join('');
  els.gameResetTimezone.value = normalized;
}

function updateGameResetPreview(now = new Date()) {
  if (!els.gameResetPreview) return;
  const rawTz = els.gameResetTimezone?.value || 'local';
  const resetTimezone = isValidResetTimezone(rawTz) ? rawTz : 'local';
  const rawTime = els.gameResetTime?.value || '00:00';
  const resetTime = isValidResetTime(rawTime) ? rawTime : '00:00';
  const status = getGamePuzzleStatus({ resetTimezone, resetTime }, now, getViewerTimeZone());
  els.gameResetPreview.textContent = `Refreshes daily at ${status.nextResetLocalTime} your time · Active puzzle date: ${status.activePuzzleDate} (next in ${status.countdownLabel})`;
}

function renderPopupNotice(blockedGames, headingText) {
  if (!els.popupNotice) return;
  if (!blockedGames || blockedGames.length === 0) {
    setHidden(els.popupNotice, true);
    els.popupNotice.innerHTML = '';
    return;
  }

  els.popupNotice.innerHTML = `
    <div class="inline-notice-head">
      <span>${escapeHtml(headingText)}</span>
      <button type="button" class="btn btn-ghost btn-xs" data-action="dismiss-popup-notice" aria-label="Dismiss popup notice">Dismiss</button>
    </div>
    <div class="inline-notice-links">
      ${blockedGames
        .filter((g) => isSafeHttpUrl(g.url))
        .map(
          (g) =>
            `<a class="btn btn-secondary btn-sm" href="${escapeHtml(g.url)}" target="_blank" rel="noopener noreferrer" data-action="manual-popup-open" data-game-id="${escapeHtml(g.id)}">${escapeHtml(g.icon || '🎮')} ${escapeHtml(g.name)} ↗</a>`
        )
        .join('')}
    </div>
  `;
  setHidden(els.popupNotice, false);
}

function renderTodayView() {
  updateCatalogDiscoveryBadge();
  const activeGames = getActiveGames();
  const entryMap = getTodayEntryMap();
  const totalGames = activeGames.length;
  const unplayedGames = activeGames.filter((g) => !entryMap.has(g.id));
  const doneCount = activeGames.filter((g) => entryMap.has(g.id)).length;
  const completedPairs = state.games
    .filter((g) => entryMap.has(g.id))
    .map((game) => ({ game, entry: entryMap.get(game.id) }));

  // Date & controls
  if (els.hudDatePretty) {
    els.hudDatePretty.textContent = formatPrettyDate(state.selectedDate, state.todayStr);
  }
  if (els.todayDateInput) {
    els.todayDateInput.value = state.selectedDate;
  }
  setHidden(els.btnToday, state.selectedDate === state.todayStr);

  if (els.quickPasteDateInput && !state.quickPasteDateManuallyEdited) {
    const selectedQuickGame = els.quickPasteGameSelect?.value
      ? getGameById(els.quickPasteGameSelect.value)
      : null;
    els.quickPasteDateInput.value = selectedQuickGame
      ? getDefaultPlayDateForGame(selectedQuickGame)
      : state.selectedDate;
  }

  // HUD KPIs
  const overview = state.dailyOverview || {};
  if (els.kpiPlayedToday) {
    els.kpiPlayedToday.textContent = `${doneCount} / ${totalGames} Cleared`;
  }
  if (els.kpiRoutineStreak) {
    const streakVal = overview.routineStreak || 0;
    els.kpiRoutineStreak.textContent = `🔥 ${streakVal}d streak`;
    setHidden(els.kpiRoutineStreak, streakVal <= 0);
  }
  if (els.kpiFullSweeps) {
    const sweepsVal = overview.fullSweepDays || 0;
    els.kpiFullSweeps.textContent = `✨ ${sweepsVal} ${sweepsVal === 1 ? 'sweep' : 'sweeps'}`;
    setHidden(els.kpiFullSweeps, sweepsVal <= 0);
  }

  // HUD Segmented Meter
  if (els.hudSegments) {
    if (totalGames === 0) {
      els.hudSegments.innerHTML = '';
    } else {
      els.hudSegments.innerHTML = activeGames
        .map((game) => {
          const isDone = entryMap.has(game.id);
          const color = normalizeHexColor(game.color);
          return `<span class="hud-seg${isDone ? ' is-done' : ''}" style="--seg-color:${escapeHtml(color)};" title="${escapeHtml(game.name)}: ${isDone ? 'Cleared' : 'Unplayed'}"></span>`;
        })
        .join('');
    }
  }

  // Launch Next & Open All
  if (els.btnLaunchNext) {
    setHidden(els.btnLaunchNext, totalGames === 0);
    if (unplayedGames.length === 0) {
      els.btnLaunchNext.disabled = true;
      els.btnLaunchNext.textContent = '★ All Cleared!';
    } else {
      const nextGame = unplayedGames[0];
      els.btnLaunchNext.disabled = false;
      els.btnLaunchNext.textContent = `▶ Play ${nextGame.name}`;
    }
  }

  if (els.btnOpenAllUnplayed) {
    const openableCount = unplayedGames.filter((g) => isSafeHttpUrl(g.url)).length;
    setHidden(els.btnOpenAllUnplayed, openableCount <= 1);
    els.btnOpenAllUnplayed.textContent = `Open All (${openableCount}) ↗`;
  }

  // Today Shelf Tag Filter Strip
  const tagGameCounts = new Map();
  const shelfGamesSeen = new Set();
  for (const g of [...activeGames, ...completedPairs.map((p) => p.game)]) {
    if (!g || shelfGamesSeen.has(g.id)) continue;
    shelfGamesSeen.add(g.id);
    for (const tag of getGameTags(g)) {
      tagGameCounts.set(tag, (tagGameCounts.get(tag) || 0) + 1);
    }
  }
  const sortedShelfTags = Array.from(tagGameCounts.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  );
  if (sortedShelfTags.length < 2) {
    state.todaySelectedTag = 'All';
    if (els.todayTagFilterBar) {
      els.todayTagFilterBar.innerHTML = '';
      setHidden(els.todayTagFilterBar, true);
    }
  } else {
    if (state.todaySelectedTag !== 'All' && !tagGameCounts.has(state.todaySelectedTag)) {
      state.todaySelectedTag = 'All';
    }
    if (els.todayTagFilterBar) {
      els.todayTagFilterBar.innerHTML = [
        `<button type="button" class="tag-filter-pill${state.todaySelectedTag === 'All' ? ' is-active' : ''}" data-tag="All" aria-pressed="${state.todaySelectedTag === 'All' ? 'true' : 'false'}"><span>All</span><span class="difficulty-pill-count">${escapeHtml(String(shelfGamesSeen.size))}</span></button>`,
        ...sortedShelfTags.map(([tag, count]) => {
          const active = state.todaySelectedTag === tag;
          return `<button type="button" class="tag-filter-pill${active ? ' is-active' : ''}" data-tag="${escapeHtml(tag)}" aria-pressed="${active ? 'true' : 'false'}"><span>${escapeHtml(tag)}</span><span class="difficulty-pill-count">${escapeHtml(String(count))}</span></button>`;
        }),
      ].join('');
      setHidden(els.todayTagFilterBar, false);
    }
  }

  const visibleUnplayedGames =
    state.todaySelectedTag === 'All'
      ? unplayedGames
      : unplayedGames.filter((g) => getGameTags(g).includes(state.todaySelectedTag));
  const visibleCompletedPairs =
    state.todaySelectedTag === 'All'
      ? completedPairs
      : completedPairs.filter(({ game }) => getGameTags(game).includes(state.todaySelectedTag));

  // Shelf 1: Up Next
  if (els.countToPlay) {
    els.countToPlay.textContent = String(visibleUnplayedGames.length);
  }

  if (els.toPlayGrid) {
    if (totalGames === 0) {
      els.toPlayGrid.innerHTML = `
        <div class="empty-grid-card">
          <p><strong>Insert Your First Daily Game</strong> — Add Wordle, Clues by Sam, Krillion, Perceptle, or any daily puzzle you play.</p>
          <button type="button" class="btn btn-primary btn-sm" data-action="open-add-game">＋ Add First Game</button>
        </div>
      `;
    } else if (unplayedGames.length === 0) {
      els.toPlayGrid.innerHTML = `
        <div class="sweep-banner">
          <div class="sweep-banner-left">
            <div class="sweep-trophy" aria-hidden="true">🏆</div>
            <div>
              <h3 class="sweep-title">Daily Sweep Complete!</h3>
              <p class="sweep-sub">All ${totalGames} games cleared for ${escapeHtml(formatPrettyDate(state.selectedDate, state.todayStr))}. Check Stats for streaks and charts.</p>
            </div>
          </div>
          <div class="sweep-actions">
            <button type="button" class="btn btn-secondary btn-sm" data-action="go-stats">View Stats →</button>
          </div>
        </div>
      `;
    } else if (visibleUnplayedGames.length === 0) {
      els.toPlayGrid.innerHTML = `
        <div class="empty-grid-card">
          <p><strong>All ${escapeHtml(state.todaySelectedTag)} games cleared!</strong> — Switch back to All to see the remaining ${unplayedGames.length} unplayed ${unplayedGames.length === 1 ? 'game' : 'games'}.</p>
          <button type="button" class="btn btn-secondary btn-sm" data-action="clear-today-tag">Show All Games</button>
        </div>
      `;
    } else {
      els.toPlayGrid.innerHTML = visibleUnplayedGames.map((game) => renderUnplayedCard(game)).join('');
      for (const game of visibleUnplayedGames) {
        const sparkHost = els.toPlayGrid.querySelector(
          `[data-sparkline-game="${CSS.escape(String(game.id))}"]`
        );
        if (!sparkHost) continue;
        const summary = state.cardSummaries[game.id];
        const points = summary?.recentSparkline || [];
        renderSparkline(sparkHost, {
          points,
          metricDirection: game.metricDirection,
          accentColor: normalizeHexColor(game.color),
        });
      }
    }
  }

  // Shelf 2: Cleared Today
  if (els.countCompleted) {
    els.countCompleted.textContent = String(visibleCompletedPairs.length);
  }
  setHidden(els.completedSection, visibleCompletedPairs.length === 0);
  if (els.completedGrid) {
    els.completedGrid.innerHTML = visibleCompletedPairs
      .map(({ game, entry }) => renderCompletedTicket(game, entry))
      .join('');
  }

  populateGameSelects();
}

function renderPunchStripHtml(gameId, endDate = state.selectedDate) {
  const days = getLastNDaysStrip(gameId, endDate, 7);
  return `
    <div class="punch-strip" aria-label="7-day play history">
      ${days
        .map((d) => {
          const stampedCls = d.entry ? ' is-stamped' : '';
          const todayCls = d.isSelectedDay ? ' is-today' : '';
          const tip = d.entry ? `${d.date}: ${d.entry.displayValue || 'Played'}` : `${d.date}: Not played`;
          return `<span class="punch-slot${stampedCls}${todayCls}" title="${escapeHtml(tip)}">${escapeHtml(d.initial)}</span>`;
        })
        .join('')}
    </div>
  `;
}

function renderUnplayedCard(game) {
  const color = normalizeHexColor(game.color);
  const onColor = getReadableTextColor(color);
  const summary = state.cardSummaries[game.id] || {};
  const streak = summary.currentStreak || 0;
  const pb = summary.personalBest;
  const domain = getGameDomainLabel(game.url);
  const safeUrl = isSafeHttpUrl(game.url) ? game.url : '';
  const hasCaptureOpen = state.activeCaptureGameId === game.id;
  const liveToday = isLiveTodayMode();
  const puzzleStatus = liveToday ? getLivePuzzleStatus(game) : null;
  const punchEndDate =
    liveToday && puzzleStatus?.activePuzzleDate ? puzzleStatus.activePuzzleDate : state.selectedDate;

  const metaTags = [
    `<span class="game-category-tag">${escapeHtml(game.category || domain || 'Daily Game')}</span>`,
  ];
  if (game.compete === false) {
    metaTags.push('<span class="game-category-tag">Solo</span>');
  }

  const recentPts = summary.recentSparkline || [];
  const numericPointsCount = recentPts.filter(
    (p) => p.value !== null && Number.isFinite(Number(p.value))
  ).length;

  const statsPills = [];
  if (streak > 0) {
    statsPills.push(`<span class="pill pill-warning tabular-nums" title="Current streak">🔥 ${streak}d</span>`);
  }
  if (pb?.displayValue) {
    statsPills.push(
      `<span class="pill pill-accent tabular-nums" title="Personal best">PB ${escapeHtml(pb.displayValue)}</span>`
    );
  }

  return `
    <article
      class="game-card${hasCaptureOpen ? ' is-awaiting' : ''}"
      data-game-id="${escapeHtml(game.id)}"
      style="--game-color:${escapeHtml(color)}; --game-on-color:${escapeHtml(onColor)};"
    >
      <div class="game-card-top">
        <div class="game-identity">
          <div class="game-icon-box" aria-hidden="true">${escapeHtml(game.icon || '🎮')}</div>
          <div class="game-title-wrap">
            <h3 class="game-name" title="${escapeHtml(game.name)}">${escapeHtml(game.name)}</h3>
            <div class="game-meta-line">
              ${metaTags.join('')}
            </div>
          </div>
        </div>
        <button
          type="button"
          class="btn-icon btn-icon-sm"
          data-action="view-game-stats"
          data-game-id="${escapeHtml(game.id)}"
          title="View ${escapeHtml(game.name)} stats"
          aria-label="View ${escapeHtml(game.name)} stats"
        >📊</button>
      </div>

      ${statsPills.length > 0 ? `<div class="game-stats-row">${statsPills.join('')}</div>` : ''}

      <div class="punch-strip-wrap">
        ${renderPunchStripHtml(game.id, punchEndDate)}
        ${
          numericPointsCount >= 2
            ? `<div class="mini-sparkline-box" data-sparkline-game="${escapeHtml(game.id)}" aria-label="Recent trend"></div>`
            : ''
        }
      </div>

      <div class="game-card-actions">
        ${
          safeUrl
            ? `<button type="button" class="btn btn-game-play" data-action="play-game" data-game-id="${escapeHtml(game.id)}">Play ↗</button>`
            : `<button type="button" class="btn btn-secondary btn-sm" disabled>No Link</button>`
        }
        <button type="button" class="btn btn-secondary btn-sm" data-action="toggle-capture" data-game-id="${escapeHtml(game.id)}">${hasCaptureOpen ? 'Hide Paste' : 'Log Result'}</button>
      </div>

      ${
        hasCaptureOpen
          ? `
        <div class="card-capture-bar" data-capture-for="${escapeHtml(game.id)}">
          <div class="card-capture-head">
            <span>Back from ${escapeHtml(game.name)}? Paste result:</span>
            <button type="button" class="btn btn-ghost btn-xs" data-action="close-capture" aria-label="Dismiss quick capture">✕</button>
          </div>
          <div class="card-capture-row">
            <textarea
              class="text-input card-capture-input"
              rows="1"
              placeholder="Paste share text…"
              data-capture-input="${escapeHtml(game.id)}"
            ></textarea>
            <button type="button" class="btn btn-primary btn-sm" data-action="save-inline-capture" data-game-id="${escapeHtml(game.id)}">Save</button>
            <button type="button" class="btn btn-secondary btn-sm" data-action="mark-played-inline" data-game-id="${escapeHtml(game.id)}">Played ✓</button>
          </div>
          <div class="card-capture-footer">
            <div class="preview-badges-row" data-capture-preview="${escapeHtml(game.id)}"></div>
            <button type="button" class="btn btn-ghost btn-xs" data-action="open-entry-modal" data-game-id="${escapeHtml(game.id)}">Full Form</button>
          </div>
        </div>
      `
          : ''
      }
    </article>
  `;
}

const KNOWN_DIFFICULTY_SET = new Set(CLUES_BY_SAM_DIFFICULTIES);

function getCanonicalDifficulty(value) {
  return normalizeDifficultyLabel(value) || '';
}

function getEntryDifficulty(item) {
  return getCanonicalDifficulty(item?.difficulty || item?.metadata?.difficulty);
}

function getDifficultyAttrValue(label) {
  const canonical = getCanonicalDifficulty(label);
  return KNOWN_DIFFICULTY_SET.has(canonical) ? canonical : '';
}

function gameSupportsDifficulty(game, parsed = null, entry = null) {
  if (getCanonicalDifficulty(parsed?.metadata?.difficulty)) return true;
  if (getEntryDifficulty(entry)) return true;
  if (!game) return false;
  if (game.supportsDifficulty) return true;
  if (Array.isArray(game.difficultyOptions) && game.difficultyOptions.length > 0) return true;
  if (game.resolvedParser?.id === 'cluesbysam') return true;
  const parser = getParserForGame(game);
  if (parser?.id === 'cluesbysam') return true;
  const slugVal = slugify(game.slug || game.name || '');
  return slugVal === 'clues-by-sam' || slugVal === 'cluesbysam';
}

function renderDifficultyBadgeHtml(rawDifficulty, { compact = false } = {}) {
  const label = getCanonicalDifficulty(rawDifficulty);
  if (!label) return '';
  const diffAttr = getDifficultyAttrValue(label);
  const attrHtml = diffAttr ? ` data-diff="${escapeHtml(diffAttr)}"` : '';
  return `<span class="difficulty-badge${compact ? ' is-compact' : ''}"${attrHtml}><span class="difficulty-dot" aria-hidden="true"></span><span>${escapeHtml(label)}</span></span>`;
}

function renderDifficultyFilterBar(
  container,
  { selectedDifficulty = 'all', options = [], visible = false, label = 'Difficulty' } = {}
) {
  if (!container) return;

  const normalizedSelected =
    selectedDifficulty && selectedDifficulty !== 'all'
      ? getCanonicalDifficulty(selectedDifficulty) || 'all'
      : 'all';

  const normalizedOptions = [];
  const seen = new Set();
  for (const item of Array.isArray(options) ? options : []) {
    const rawVal = typeof item === 'string' ? item : item?.value || item?.label || item?.key;
    const val = getCanonicalDifficulty(rawVal);
    if (!val || seen.has(val)) continue;
    seen.add(val);
    const count =
      typeof item === 'object' && item !== null && Number.isFinite(Number(item.count))
        ? Number(item.count)
        : null;
    normalizedOptions.push({ value: val, label: item?.label || val, count });
  }

  if (!visible || normalizedOptions.length === 0) {
    container.innerHTML = '';
    setHidden(container, true);
    return;
  }

  const hasCounts = normalizedOptions.some((opt) => opt.count !== null);
  const allCount = hasCounts
    ? normalizedOptions.reduce((sum, opt) => sum + (opt.count ?? 0), 0)
    : null;

  const pills = [
    `<button type="button" class="difficulty-pill${normalizedSelected === 'all' ? ' is-active' : ''}" data-difficulty="all" aria-pressed="${normalizedSelected === 'all' ? 'true' : 'false'}"><span>All</span>${allCount !== null ? `<span class="difficulty-pill-count">${escapeHtml(String(allCount))}</span>` : ''}</button>`,
    ...normalizedOptions.map((opt) => {
      const active = normalizedSelected === opt.value;
      const diffAttr = getDifficultyAttrValue(opt.value);
      const attrHtml = diffAttr ? ` data-diff="${escapeHtml(diffAttr)}"` : '';
      return `
        <button
          type="button"
          class="difficulty-pill${active ? ' is-active' : ''}"
          data-difficulty="${escapeHtml(opt.value)}"${attrHtml}
          aria-pressed="${active ? 'true' : 'false'}"
        >
          <span class="difficulty-dot" aria-hidden="true"></span>
          <span>${escapeHtml(opt.label)}</span>
          ${opt.count !== null ? `<span class="difficulty-pill-count">${escapeHtml(String(opt.count))}</span>` : ''}
        </button>
      `;
    }),
  ];

  container.innerHTML = `
    <span class="difficulty-filter-label">${escapeHtml(label)}</span>
    ${pills.join('')}
  `;
  setHidden(container, false);
}

function gameSupportsRoundInputs(game) {
  if (!game) return false;
  const slugVal = slugify(game.slug || game.name || '');
  return (
    slugVal === 'perceptle' ||
    game.slug === 'perceptle' ||
    game.parserId === 'perceptle' ||
    game.resolvedParser?.id === 'perceptle'
  );
}

function shouldShowRoundChips(breakdown, parserId) {
  if (!Array.isArray(breakdown) || breakdown.length === 0) return false;
  if (String(parserId || '').toLowerCase() === 'wordle') return false;
  return breakdown.some((item) => {
    if (!item || typeof item !== 'object') return false;
    if (/^Guess\s+\d+$/i.test(String(item.label || '').trim())) return false;
    return item.value !== null && item.value !== undefined && Number.isFinite(Number(item.value));
  });
}

function renderRoundChipsHtml(breakdown, { compact = false } = {}) {
  if (!Array.isArray(breakdown) || breakdown.length === 0) return '';
  return breakdown
    .filter((item) => {
      if (!item || typeof item !== 'object') return false;
      if (/^Guess\s+\d+$/i.test(String(item.label || '').trim())) return false;
      return item.value !== null && item.value !== undefined && Number.isFinite(Number(item.value));
    })
    .map((item) => {
      const valStr =
        item.display !== undefined && item.display !== null && String(item.display).trim() !== ''
          ? String(item.display)
          : String(item.value);
      const icon = item.icon ? String(item.icon) : '';
      let name = '';
      if (item.name) {
        name = String(item.name);
      } else if (item.label) {
        const rawLabel = String(item.label);
        name = icon ? rawLabel.replace(icon, '').trim() : rawLabel;
      }
      const titleLeft = item.label || [icon, name].filter(Boolean).join(' ') || 'Round';
      const maxSuffix =
        item.max !== null && item.max !== undefined && Number.isFinite(Number(item.max))
          ? ` / ${item.max}`
          : '';
      const titleText = `${titleLeft}: ${valStr}${maxSuffix}`;

      if (compact) {
        return `
          <span class="round-chip is-compact" title="${escapeHtml(titleText)}">
            ${
              icon
                ? `<span class="round-chip-icon" aria-hidden="true">${escapeHtml(icon)}</span>`
                : name
                  ? `<span class="round-chip-name">${escapeHtml(name)}</span>`
                  : ''
            }
            <span class="round-chip-val">${escapeHtml(valStr)}</span>
          </span>
        `;
      }

      return `
        <span class="round-chip" title="${escapeHtml(titleText)}">
          ${icon ? `<span class="round-chip-icon" aria-hidden="true">${escapeHtml(icon)}</span>` : ''}
          ${name ? `<span class="round-chip-name">${escapeHtml(name)}</span>` : ''}
          <span class="round-chip-val">${escapeHtml(valStr)}</span>
        </span>
      `;
    })
    .join('');
}

function getEntryShareGrid(item) {
  const fromMeta =
    typeof item?.metadata?.emojiGrid === 'string' ? item.metadata.emojiGrid.trim() : '';
  if (fromMeta) return fromMeta;
  const raw = typeof item?.rawText === 'string' ? item.rawText : '';
  return raw ? extractEmojiGrid(raw) || '' : '';
}

function renderCompletedTicket(game, entry) {
  const color = normalizeHexColor(game.color);
  const onColor = getReadableTextColor(color);
  const summary = state.cardSummaries[game.id] || {};
  const streak = summary.currentStreak || 0;
  const resultText = formatEntryResult(entry, game);
  const isDnf = entry.solved === false;
  const isJustStamped = state.justStampedGameId === game.id;
  const safeUrl = isSafeHttpUrl(game.url);
  const emojiGrid = getEntryShareGrid(entry);
  const liveToday = isLiveTodayMode();
  const puzzleStatus = liveToday ? getLivePuzzleStatus(game) : null;
  const difficulty = getEntryDifficulty(entry);
  const cluesAcc = safeIsCluesBySamGame(game) ? safeGetCluesBySamAccuracy(entry) : null;
  const showRoundChips = shouldShowRoundChips(
    entry.breakdown,
    entry.parserId || game.resolvedParser?.id || game.parserId
  );

  const ticketMetaTags = [];
  if (game.compete === false) {
    ticketMetaTags.push('<span class="pill pill-neutral">Solo</span>');
  }
  if (entry.puzzleId) {
    ticketMetaTags.push(`<span class="game-category-tag tabular-nums">${escapeHtml(entry.puzzleId)}</span>`);
  }
  if (difficulty) {
    ticketMetaTags.push(renderDifficultyBadgeHtml(difficulty, { compact: true }));
  }
  if (cluesAcc?.accuracySummary) {
    ticketMetaTags.push(
      `<span class="pill ${cluesAcc.isPerfect ? 'pill-success' : 'pill-neutral'} tabular-nums">${escapeHtml(cluesAcc.accuracySummary)}</span>`
    );
  }

  return `
    <article
      class="ticket-card${isJustStamped ? ' is-just-stamped' : ''}"
      data-game-id="${escapeHtml(game.id)}"
      data-entry-id="${escapeHtml(entry.id)}"
      style="--game-color:${escapeHtml(color)}; --game-on-color:${escapeHtml(onColor)};"
    >
      <div class="ticket-top">
        <div class="game-identity">
          <div class="game-icon-box game-icon-box-sm" aria-hidden="true">${escapeHtml(game.icon || '🎮')}</div>
          <div class="game-title-wrap">
            <h3 class="game-name" title="${escapeHtml(game.name)}">${escapeHtml(game.name)}</h3>
            ${
              ticketMetaTags.length > 0
                ? `<div class="game-meta-line">${ticketMetaTags.join('')}</div>`
                : ''
            }
          </div>
        </div>
        <span class="ticket-score-pill tabular-nums">${escapeHtml(resultText)}</span>
      </div>

      <div class="ticket-stamp-row">
        <div class="ticket-stamp-badges">
          <span class="ticket-stamp${isDnf ? ' is-dnf' : ''}">${isDnf ? '✕ DNF' : '✓ CLEARED'}</span>
          ${streak > 0 ? `<span class="pill pill-warning tabular-nums">🔥 ${streak}d</span>` : ''}
        </div>
        ${
          liveToday && puzzleStatus
            ? `<span class="ticket-next-badge tabular-nums" data-reset-countdown="ticket" data-game-id="${escapeHtml(game.id)}" title="${escapeHtml(formatResetTooltip(game, puzzleStatus))}">⏳ Next in ${escapeHtml(puzzleStatus.countdownLabel)} (${escapeHtml(puzzleStatus.nextResetLocalTime)})</span>`
            : ''
        }
      </div>

      ${
        showRoundChips
          ? `<div class="ticket-rounds-strip">${renderRoundChipsHtml(entry.breakdown, { compact: true })}</div>`
          : ''
      }

      ${
        emojiGrid
          ? `
        <details class="share-grid-details">
          <summary>Show grid</summary>
          <pre class="share-grid-pre">${escapeHtml(emojiGrid)}</pre>
        </details>
      `
          : ''
      }

      <div class="ticket-actions">
        <button type="button" class="btn btn-secondary btn-xs" data-action="edit-entry" data-entry-id="${escapeHtml(entry.id)}" data-game-id="${escapeHtml(game.id)}">Edit</button>
        <button type="button" class="btn btn-ghost btn-xs" data-action="view-ticket-stats" data-game-id="${escapeHtml(game.id)}">Stats</button>
        ${safeUrl ? `<button type="button" class="btn btn-ghost btn-xs" data-action="open-game-url" data-game-id="${escapeHtml(game.id)}" title="Open ${escapeHtml(game.name)}">Play ↗</button>` : ''}
      </div>
    </article>
  `;
}

function setActiveTab(tabName, { skipLoad = false } = {}) {
  const validTabs = ['today', 'leaderboard', 'stats', 'games'];
  const nextTab = validTabs.includes(tabName) ? tabName : 'today';
  state.activeTab = nextTab;

  for (const btn of els.tabButtons || []) {
    const active = btn.dataset.tab === nextTab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
    btn.setAttribute('tabindex', active ? '0' : '-1');
  }

  const panels = [
    ['today', els.viewToday],
    ['leaderboard', els.viewLeaderboard],
    ['stats', els.viewStats],
    ['games', els.viewGames],
  ];
  for (const [name, panel] of panels) {
    if (!panel) continue;
    const active = name === nextTab;
    panel.classList.toggle('is-active', active);
    panel.classList.remove('hidden');
    panel.hidden = false;
  }

  if (skipLoad || !state.user) return;

  if (nextTab === 'leaderboard') {
    loadAndRenderLeaderboardView();
  } else if (nextTab === 'stats') {
    loadAndRenderStatsView();
  } else if (nextTab === 'games') {
    renderGamesAdminView();
  }
}

async function handleDateChange(nextDate) {
  if (!nextDate) return;
  state.todayStr = getLocalDateString();
  state.selectedDate = nextDate;
  state.activeCaptureGameId = null;
  state.quickPasteDateManuallyEdited = false;
  setHidden(els.popupNotice, true);
  try {
    await refreshBootstrapAndEntries();
    renderTodayView();
  } catch (err) {
    showToast(`Failed to load ${nextDate}: ${err.message}`, { variant: 'error' });
  }
}

function openGameUrl(gameId, openCapture = true) {
  const game = getGameById(gameId);
  if (!game || !isSafeHttpUrl(game.url)) {
    showToast('No valid URL configured for this game.', { variant: 'warning' });
    return false;
  }
  state.lastOpenedGameId = game.id;
  if (openCapture) {
    state.activeCaptureGameId = game.id;
  }
  const win = window.open(game.url, '_blank', 'noopener,noreferrer');
  if (!win) {
    renderPopupNotice([game], `Popup blocked for ${game.name}. Click below to open it:`);
  } else {
    setHidden(els.popupNotice, true);
  }
  renderTodayView();
  if (openCapture) {
    requestAnimationFrame(() => {
      const input = els.toPlayGrid?.querySelector(
        `[data-capture-input="${CSS.escape(String(game.id))}"]`
      );
      input?.focus();
    });
  }
  return Boolean(win);
}

function handleOpenAllUnplayed() {
  const activeGames = getActiveGames();
  const entryMap = getTodayEntryMap();
  const unplayed = activeGames.filter((g) => !entryMap.has(g.id) && isSafeHttpUrl(g.url));
  if (unplayed.length === 0) return;

  const blocked = [];
  for (const game of unplayed) {
    const win = window.open(game.url, '_blank', 'noopener,noreferrer');
    if (win) {
      state.lastOpenedGameId = game.id;
    } else {
      blocked.push(game);
    }
  }

  if (blocked.length > 0) {
    renderPopupNotice(
      blocked,
      `Your browser blocked opening ${blocked.length} popup tab(s). Click any game below to launch directly:`
    );
    showToast(`${blocked.length} popup tab(s) blocked by your browser.`, { variant: 'warning' });
  } else {
    setHidden(els.popupNotice, true);
    showToast(`Opened ${unplayed.length} game tabs!`, { variant: 'success' });
  }
}

function buildParsePreviewHtml(parsed, game, { emptyHint = 'Waiting for pasted result text…', unmatched = false } = {}) {
  if (!parsed) {
    return `<p class="empty-hint">${escapeHtml(emptyHint)}</p>`;
  }

  const badges = [];
  if (game && !unmatched) {
    badges.push(
      `<span class="pill pill-accent">${escapeHtml(game.icon || '🎮')} ${escapeHtml(game.name)}</span>`
    );
  } else {
    badges.push(`<span class="pill pill-warning">Select a game below</span>`);
  }

  if (parsed.solved === true) {
    badges.push(`<span class="pill pill-success">Solved</span>`);
  } else if (parsed.solved === false) {
    badges.push(`<span class="pill pill-danger">DNF</span>`);
  } else {
    badges.push(`<span class="pill pill-neutral">Open</span>`);
  }

  if (parsed.puzzleId) {
    badges.push(`<span class="pill pill-neutral tabular-nums">${escapeHtml(parsed.puzzleId)}</span>`);
  }

  const cluesAcc =
    safeIsCluesBySamGame(game) || parsed.parserId === 'clues_by_sam'
      ? safeGetCluesBySamAccuracy(parsed)
      : null;
  if (cluesAcc?.accuracySummary) {
    badges.push(
      `<span class="pill ${cluesAcc.isPerfect ? 'pill-success' : 'pill-neutral'} tabular-nums">${escapeHtml(cluesAcc.accuracySummary)}</span>`
    );
  }

  const parsedDifficulty = getCanonicalDifficulty(parsed.metadata?.difficulty);
  if (parsedDifficulty) {
    badges.push(renderDifficultyBadgeHtml(parsedDifficulty));
  }

  const displayStr =
    parsed.displayValue ??
    formatMetricValue(
      parsed.primaryValue,
      game?.metricFormat || parsed.metricFormat || 'number',
      parsed.solved === false ? 'DNF' : 'Played'
    );

  const metricLabel = parsed.metricLabel || game?.metricLabel || 'Score';
  const datePill = parsed.puzzleDate
    ? `<span class="pill pill-neutral tabular-nums">${escapeHtml(parsed.puzzleDate)}</span>`
    : '';
  const showRounds = shouldShowRoundChips(
    parsed.breakdown,
    parsed.parserId || game?.resolvedParser?.id || game?.parserId
  );
  const previewGrid = getEntryShareGrid(parsed);

  return `
    <div class="preview-badges-row">${badges.join('')}</div>
    <div class="preview-metrics-row">
      <span class="muted-text">${escapeHtml(metricLabel)}:</span>
      <span class="preview-score-strong tabular-nums">${escapeHtml(displayStr)}</span>
      ${datePill}
    </div>
    ${
      previewGrid
        ? `<pre class="share-grid-pre preview-grid-pre">${escapeHtml(previewGrid)}</pre>`
        : ''
    }
    ${
      showRounds
        ? `<div class="round-breakdown-pills">${renderRoundChipsHtml(parsed.breakdown, { compact: false })}</div>`
        : ''
    }
  `;
}

function updateQuickPastePreview() {
  if (!els.quickPasteTextarea || !els.quickPastePreview) return;
  const raw = els.quickPasteTextarea.value.trim();
  const manualGameId = els.quickPasteGameSelect?.value || '';

  setHidden(els.btnQuickPasteClear, !raw);

  if (!raw) {
    const manualGame = manualGameId ? getGameById(manualGameId) : null;
    if (els.quickPasteDateInput && !state.quickPasteDateManuallyEdited) {
      els.quickPasteDateInput.value = manualGame
        ? getDefaultPlayDateForGame(manualGame)
        : state.selectedDate;
    }
    els.quickPastePreview.innerHTML = buildParsePreviewHtml(null, null, {
      emptyHint: 'Waiting for pasted result text…',
    });
    if (els.btnQuickPasteSave) els.btnQuickPasteSave.disabled = !manualGameId;
    return;
  }

  let matchedGame = manualGameId ? getGameById(manualGameId) : null;
  let parsed = null;
  const activeGames = getActiveGames();

  if (matchedGame && state.quickPasteManualOverride) {
    parsed = parseForGame(raw, matchedGame);
  } else {
    const detection = detectGameAndParse(raw, activeGames);
    if (detection?.matchedGame && detection.confidence !== 'none') {
      matchedGame = detection.matchedGame;
      parsed = detection.parsed;
      if (els.quickPasteGameSelect) {
        els.quickPasteGameSelect.value = String(matchedGame.id);
      }
    } else if (matchedGame) {
      parsed = parseForGame(raw, matchedGame);
    } else if (state.lastOpenedGameId && getGameById(state.lastOpenedGameId)) {
      matchedGame = getGameById(state.lastOpenedGameId);
      parsed = parseForGame(raw, matchedGame);
      if (els.quickPasteGameSelect) {
        els.quickPasteGameSelect.value = String(matchedGame.id);
      }
    } else {
      parsed = detection.parsed;
    }
  }

  if (els.quickPasteDateInput && !state.quickPasteDateManuallyEdited) {
    els.quickPasteDateInput.value =
      parsed?.puzzleDate ||
      (matchedGame ? getDefaultPlayDateForGame(matchedGame) : state.selectedDate);
  }

  els.quickPastePreview.innerHTML = buildParsePreviewHtml(parsed, matchedGame, {
    unmatched: !matchedGame,
  });
  if (els.btnQuickPasteSave) {
    els.btnQuickPasteSave.disabled = !matchedGame;
  }
}

function toggleQuickPasteTray(forceOpen) {
  if (!els.quickPasteTray) return;
  const currentlyOpen = !els.quickPasteTray.classList.contains('hidden') && !els.quickPasteTray.hidden;
  const nextOpen = typeof forceOpen === 'boolean' ? forceOpen : !currentlyOpen;

  setHidden(els.quickPasteTray, !nextOpen);
  if (els.btnPasteHud) {
    els.btnPasteHud.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
  }

  if (nextOpen) {
    state.quickPasteDateManuallyEdited = false;
    populateGameSelects();
    if (els.quickPasteDateInput) {
      const selectedQuickGame = els.quickPasteGameSelect?.value
        ? getGameById(els.quickPasteGameSelect.value)
        : null;
      els.quickPasteDateInput.value = selectedQuickGame
        ? getDefaultPlayDateForGame(selectedQuickGame)
        : state.selectedDate;
    }
    updateQuickPastePreview();
    els.quickPasteTextarea?.focus();
  }
}

async function saveParsedEntry(
  game,
  { rawText = '', playDate = state.selectedDate, markPlayedOnly = false, notes = '', difficulty } = {}
) {
  if (!game || state.isSavingEntry) return null;
  state.isSavingEntry = true;

  try {
    const existing = state.allEntries.find((e) => e.gameId === game.id && e.playDate === playDate);

    const payload = markPlayedOnly
      ? {
          gameId: game.id,
          playDate,
          rawText: '',
          completed: true,
          solved: null,
          primaryValue: null,
          displayValue: 'Played',
          notes,
          manualOverride: false,
        }
      : {
          gameId: game.id,
          playDate,
          rawText,
          completed: true,
          notes,
          manualOverride: false,
        };

    if (difficulty !== undefined) {
      payload.difficulty = difficulty;
    }

    const resp = await api.saveEntry(payload);
    const saved = resp?.entry || resp;

    state.justStampedGameId = game.id;
    state.activeCaptureGameId = null;
    invalidateLeaderboardCache();
    await refreshBootstrapAndEntries();
    renderTodayView();
    if (state.activeTab === 'stats') {
      await loadAndRenderStatsView();
    } else if (state.activeTab === 'leaderboard') {
      await loadAndRenderLeaderboardView();
    }

    setTimeout(() => {
      if (state.justStampedGameId === game.id) {
        state.justStampedGameId = null;
      }
    }, 1800);

    return { saved, previous: existing || null };
  } finally {
    state.isSavingEntry = false;
  }
}

async function handleSaveQuickPaste() {
  const rawText = els.quickPasteTextarea?.value.trim() || '';
  const selectedGameId = els.quickPasteGameSelect?.value || '';

  let game = selectedGameId ? getGameById(selectedGameId) : null;
  let parsed = null;
  if (!game && rawText) {
    const detected = detectGameAndParse(rawText, getActiveGames());
    if (detected?.matchedGame && detected.confidence !== 'none') {
      game = detected.matchedGame;
      parsed = detected.parsed;
    }
  } else if (game && rawText) {
    parsed = parseForGame(rawText, game);
  }

  if (!game) {
    showToast('Select a game before saving.', { variant: 'warning' });
    els.quickPasteGameSelect?.focus();
    return;
  }

  const playDate =
    els.quickPasteDateInput?.value || parsed?.puzzleDate || getDefaultPlayDateForGame(game);

  try {
    const res = await saveParsedEntry(game, {
      rawText,
      playDate,
      markPlayedOnly: !rawText,
    });
    if (els.quickPasteTextarea) els.quickPasteTextarea.value = '';
    state.quickPasteManualOverride = false;
    state.quickPasteDateManuallyEdited = false;
    updateQuickPastePreview();
    toggleQuickPasteTray(false);

    if (res?.saved) {
      showSavedEntryToast(game, res.saved, res.previous);
    }
  } catch (err) {
    showToast(`Could not save entry: ${err.message}`, { variant: 'error' });
  }
}

function showSavedEntryToast(game, saved, previous) {
  const resultSummary = formatEntryResult(saved, game);
  showToast(`Saved ${game.icon || ''} ${game.name}: ${resultSummary}`, {
    variant: 'success',
    duration: 5500,
    actionLabel: 'Edit',
    onAction: () => openEntryModal(game.id, saved.id),
    secondaryLabel: previous ? undefined : 'Undo',
    onSecondaryAction: previous
      ? undefined
      : async () => {
          try {
            await api.deleteEntry(saved.id);
            invalidateLeaderboardCache();
            await refreshBootstrapAndEntries();
            renderTodayView();
            if (state.activeTab === 'stats') {
              await loadAndRenderStatsView();
            } else if (state.activeTab === 'leaderboard') {
              await loadAndRenderLeaderboardView();
            }
            showToast(`Undid ${game.name} entry.`, { variant: 'info' });
          } catch (err) {
            showToast(`Undo failed: ${err.message}`, { variant: 'error' });
          }
        },
  });
}

async function handleGlobalPaste(event) {
  if (!state.user) return;
  if (state.activeTab !== 'today') return;
  if (els.entryDialog?.open || els.gameDialog?.open || els.confirmDialog?.open) return;

  const activeEl = document.activeElement;
  if (
    activeEl &&
    (activeEl.tagName === 'INPUT' ||
      activeEl.tagName === 'TEXTAREA' ||
      activeEl.tagName === 'SELECT' ||
      activeEl.isContentEditable)
  ) {
    return;
  }

  const text = event.clipboardData?.getData('text/plain')?.trim();
  if (!text) return;

  event.preventDefault();
  const detection = detectGameAndParse(text, getActiveGames());

  if (detection?.matchedGame && (detection.confidence === 'high' || detection.confidence === 'medium')) {
    const targetPlayDate =
      detection.parsed?.puzzleDate || getDefaultPlayDateForGame(detection.matchedGame);
    try {
      const res = await saveParsedEntry(detection.matchedGame, {
        rawText: text,
        playDate: targetPlayDate,
      });
      if (res?.saved) {
        showSavedEntryToast(detection.matchedGame, res.saved, res.previous);
      }
      return;
    } catch (err) {
      showToast(`Paste save failed: ${err.message}`, { variant: 'error' });
    }
  }

  toggleQuickPasteTray(true);
  if (els.quickPasteTextarea) {
    els.quickPasteTextarea.value = text;
  }
  state.quickPasteManualOverride = false;
  state.quickPasteDateManuallyEdited = false;
  updateQuickPastePreview();
  showToast('Pasted text ready — confirm the game to save.', { variant: 'info' });
}

function handleInlineCapturePreview(gameId, rawText) {
  const preview = els.toPlayGrid?.querySelector(
    `[data-capture-preview="${CSS.escape(String(gameId))}"]`
  );
  const game = getGameById(gameId);
  if (!preview || !game) return;
  const trimmed = rawText.trim();
  if (!trimmed) {
    preview.innerHTML = '';
    return;
  }
  const parsed = parseForGame(trimmed, game);
  const displayStr =
    parsed.displayValue ??
    formatMetricValue(parsed.primaryValue, game.metricFormat, parsed.solved === false ? 'DNF' : 'Played');
  const outcomePill =
    parsed.solved === true
      ? '<span class="pill pill-success">Solved</span>'
      : parsed.solved === false
        ? '<span class="pill pill-danger">DNF</span>'
        : '';
  const cluesAcc = safeIsCluesBySamGame(game) ? safeGetCluesBySamAccuracy(parsed) : null;
  const showRounds = shouldShowRoundChips(
    parsed.breakdown,
    parsed.parserId || game.resolvedParser?.id || game.parserId
  );
  preview.innerHTML = `
    <span class="pill pill-accent tabular-nums">${escapeHtml(displayStr)}</span>
    ${cluesAcc?.accuracySummary ? `<span class="pill ${cluesAcc.isPerfect ? 'pill-success' : 'pill-neutral'} tabular-nums">${escapeHtml(cluesAcc.accuracySummary)}</span>` : ''}
    ${parsed.puzzleId ? `<span class="pill pill-neutral tabular-nums">${escapeHtml(parsed.puzzleId)}</span>` : ''}
    ${outcomePill}
    ${
      showRounds
        ? `<div class="round-breakdown-pills">${renderRoundChipsHtml(parsed.breakdown, { compact: true })}</div>`
        : ''
    }
  `;
}

// ---------- Entry Modal ----------

function setSolvedSegMode(mode) {
  const valid = new Set(['auto', 'true', 'false', 'null']);
  const nextMode = valid.has(mode) ? mode : 'auto';
  state.solvedSegMode = nextMode;
  if (!els.entryModalSolvedGroup) return;
  els.entryModalSolvedGroup.querySelectorAll('.seg-btn[data-solved]').forEach((btn) => {
    const active = btn.dataset.solved === nextMode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function getSolvedSegValue(parsed = null) {
  if (state.solvedSegMode === 'true') return true;
  if (state.solvedSegMode === 'false') return false;
  if (state.solvedSegMode === 'null') return null;
  return parsed?.solved ?? null;
}

function setEntryModalDifficulty(diff) {
  const normalized = getCanonicalDifficulty(diff);
  state.entryModalDifficulty = normalized;
  if (!els.entryModalDifficultyPills) return;
  els.entryModalDifficultyPills.querySelectorAll('.difficulty-pill[data-difficulty]').forEach((btn) => {
    const btnDiff = btn.dataset.difficulty || '';
    const active = btnDiff === normalized;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function updateEntryDifficultyVisibility(game, parsed = null, existing = null) {
  const show = gameSupportsDifficulty(game, parsed, existing);
  setHidden(els.entryModalDifficultyGroup, !show);
  return show;
}

function stripEmojiVs(str) {
  return String(str || '').replace(/\uFE0F/g, '').trim();
}

function ensureEntryRoundInputsRendered() {
  if (!els.entryModalRoundsInputs || els.entryModalRoundsInputs.childElementCount > 0) return;
  els.entryModalRoundsInputs.innerHTML = PERCEPTLE_ROUNDS.map((round) => {
    const inputId = `entry-round-${round.key}`;
    return `
      <label class="perceptle-round-field" for="${escapeHtml(inputId)}">
        <span class="perceptle-round-label">
          <span aria-hidden="true">${escapeHtml(round.icon)}</span>
          <span>${escapeHtml(round.name)}</span>
        </span>
        <input
          type="number"
          id="${escapeHtml(inputId)}"
          class="perceptle-round-input"
          data-round-key="${escapeHtml(round.key)}"
          min="0"
          max="${escapeHtml(String(round.max ?? 100))}"
          step="1"
          inputmode="numeric"
          placeholder="0–100"
        >
      </label>
    `;
  }).join('');
}

function matchBreakdownForRound(breakdown, roundDef) {
  if (!Array.isArray(breakdown)) return null;
  const targetIcon = stripEmojiVs(roundDef.icon);
  const targetName = roundDef.name.toLowerCase();
  return (
    breakdown.find((item) => {
      if (!item || typeof item !== 'object') return false;
      if (item.key && String(item.key).toLowerCase() === roundDef.key) return true;
      if (item.icon && stripEmojiVs(item.icon) === targetIcon) return true;
      if (item.name && String(item.name).trim().toLowerCase() === targetName) return true;
      const lbl = stripEmojiVs(item.label).toLowerCase();
      if (lbl && (lbl.includes(targetName) || (targetIcon && lbl.includes(targetIcon)))) return true;
      return false;
    }) || null
  );
}

function setEntryModalRoundsFromBreakdown(breakdown = []) {
  ensureEntryRoundInputsRendered();
  if (!els.entryModalRoundsInputs) return;
  for (const round of PERCEPTLE_ROUNDS) {
    const input = els.entryModalRoundsInputs.querySelector(
      `[data-round-key="${CSS.escape(round.key)}"]`
    );
    if (!input) continue;
    const match = matchBreakdownForRound(breakdown, round);
    input.value =
      match && match.value !== null && match.value !== undefined && Number.isFinite(Number(match.value))
        ? String(match.value)
        : '';
  }
}

function collectEntryRoundInputs({ validate = true } = {}) {
  if (!els.entryModalRoundsInputs) {
    return { error: false, breakdown: [], filledCount: 0 };
  }
  const breakdown = [];
  for (const round of PERCEPTLE_ROUNDS) {
    const input = els.entryModalRoundsInputs.querySelector(
      `[data-round-key="${CSS.escape(round.key)}"]`
    );
    if (!input) continue;
    const raw = input.value.trim();
    if (raw === '') continue;
    const num = Number(raw);
    const maxVal = round.max ?? 100;
    if (!Number.isFinite(num) || num < 0 || num > maxVal) {
      if (validate) {
        showToast(`Round score for ${round.name} must be between 0 and ${maxVal}.`, {
          variant: 'error',
        });
        input.focus();
      }
      return { error: true, breakdown: [], filledCount: 0 };
    }
    const cleanNum = Number.isInteger(num) ? num : Number(num.toFixed(2));
    breakdown.push({
      key: round.key,
      icon: round.icon,
      name: round.name,
      label: round.label,
      value: cleanNum,
      max: maxVal,
      display: String(cleanNum),
    });
  }
  return { error: false, breakdown, filledCount: breakdown.length };
}

function rawTextHasExplicitScore(rawText) {
  if (!rawText) return false;
  return /\bperceptle\s+#?\d[\d,]*(?![\d,])[ \t]*(?:[-–—:|•][ \t]*)?(?:[A-Za-z][+-]?[ \t]*)?\(\s*\d{1,3}(?:\.\d+)?\s*\)|(?:score|accuracy)\s*[:=\-]\s*\d|\b\d+(?:\.\d+)?%/i.test(
    rawText
  );
}

function maybeSyncScoreFromRounds() {
  state.entryModalRoundsTouched = true;
  const game = getGameById(els.entryModalGameId?.value);
  if (!game || !gameSupportsRoundInputs(game)) return;
  if (els.entryModalManualOverride?.checked) return;

  const raw = els.entryModalRawText?.value.trim() || '';
  const currentVal = els.entryModalValueInput?.value.trim() || '';
  if (raw && rawTextHasExplicitScore(raw) && currentVal !== '' && !state.entryModalValueAutoFilled) {
    return;
  }

  const { error, breakdown } = collectEntryRoundInputs({ validate: false });
  if (error) return;
  if (breakdown.length > 0) {
    const sum = breakdown.reduce((acc, item) => acc + item.value, 0);
    const avg = Math.round(sum / breakdown.length);
    if (els.entryModalValueInput) {
      els.entryModalValueInput.value = String(avg);
      state.entryModalValueAutoFilled = true;
    }
  } else if (state.entryModalValueAutoFilled && els.entryModalValueInput) {
    els.entryModalValueInput.value = '';
    state.entryModalValueAutoFilled = false;
  }
}

function updateEntryParsePreview() {
  const game = getGameById(els.entryModalGameId.value);
  if (!game) return;
  const raw = els.entryModalRawText.value.trim();
  const showRounds = gameSupportsRoundInputs(game);
  setHidden(els.entryModalRoundsGroup, !showRounds);

  if (!raw) {
    els.entryModalParsePreview.innerHTML = buildParsePreviewHtml(null, game, {
      emptyHint: 'Paste result text above or enter values manually below.',
    });
    updateEntryDifficultyVisibility(
      game,
      null,
      state.entryModalDifficulty ? { difficulty: state.entryModalDifficulty } : null
    );
    if (!state.entryModalDifficultyTouched && !els.entryModalId.value) {
      setEntryModalDifficulty('');
    }
    if (showRounds && !state.entryModalRoundsTouched && !els.entryModalManualOverride.checked && !els.entryModalId.value) {
      setEntryModalRoundsFromBreakdown([]);
    }
    if (!els.entryModalManualOverride.checked && state.entryModalValueAutoFilled && !els.entryModalId.value) {
      els.entryModalValueInput.value = '';
      state.entryModalValueAutoFilled = false;
    }
    if (!state.entryModalDateManuallyEdited && !els.entryModalId.value) {
      els.entryModalDate.value = getDefaultPlayDateForGame(game);
    }
    return;
  }

  const parsed = parseForGame(raw, game);
  els.entryModalParsePreview.innerHTML = buildParsePreviewHtml(parsed, game);
  updateEntryDifficultyVisibility(
    game,
    parsed,
    state.entryModalDifficulty ? { difficulty: state.entryModalDifficulty } : null
  );

  if (!state.entryModalDifficultyTouched) {
    const parsedDiff = getCanonicalDifficulty(parsed?.metadata?.difficulty);
    if (parsedDiff) {
      setEntryModalDifficulty(parsedDiff);
    } else if (!els.entryModalId.value) {
      setEntryModalDifficulty('');
    }
  }

  if (showRounds && !state.entryModalRoundsTouched && !els.entryModalManualOverride.checked) {
    setEntryModalRoundsFromBreakdown(parsed?.breakdown || []);
  }

  if (!state.entryModalDateManuallyEdited && !els.entryModalId.value) {
    els.entryModalDate.value = parsed.puzzleDate || getDefaultPlayDateForGame(game);
  }

  if (!els.entryModalManualOverride.checked) {
    if (parsed.primaryValue !== null && parsed.primaryValue !== undefined) {
      state.entryModalValueAutoFilled = false;
      if (game.metricFormat === 'duration_sec') {
        els.entryModalValueInput.value = formatDurationSeconds(parsed.primaryValue);
      } else if (game.metricFormat === 'fraction' && parsed.displayValue?.includes('/')) {
        els.entryModalValueInput.value = parsed.displayValue;
      } else {
        els.entryModalValueInput.value = String(parsed.primaryValue);
      }
    }
    if (parsed.puzzleId) {
      els.entryModalPuzzleId.value = parsed.puzzleId;
    }
  }
}

function openEntryModal(gameId, entryId = null, prefillRawText = '') {
  const game = getGameById(gameId);
  if (!game) return;

  const defaultDate = getDefaultPlayDateForGame(game);
  const entryIdNum = entryId ? Number(entryId) : null;
  const existing = entryIdNum
    ? state.allEntries.find((e) => e.id === entryIdNum)
    : state.allEntries.find((e) => e.gameId === game.id && e.playDate === defaultDate);

  const effectiveDate = existing?.playDate || defaultDate;
  const puzzleStatus = getLivePuzzleStatus(game);
  const cycleSuffix =
    !existing && isLiveTodayMode() && puzzleStatus?.isOffLocalDate
      ? ` · Active cycle (resets ${puzzleStatus.nextResetLocalTime})`
      : '';

  els.entryModalIcon.textContent = game.icon || '🎮';
  els.entryModalIcon.style.background = normalizeHexColor(game.color);
  els.entryModalIcon.style.color = getReadableTextColor(game.color);
  els.entryModalTitle.textContent = existing ? `Edit ${game.name}` : `Log ${game.name}`;
  els.entryModalSubtitle.textContent = `${game.metricLabel || 'Score'} · ${formatPrettyDate(
    effectiveDate,
    state.todayStr
  )}${cycleSuffix}`;

  state.entryModalDateManuallyEdited = Boolean(existing);
  els.entryModalId.value = existing?.id ? String(existing.id) : '';
  els.entryModalGameId.value = String(game.id);
  els.entryModalDate.value = effectiveDate;
  els.entryModalRawText.value = prefillRawText || existing?.rawText || '';
  els.entryModalPuzzleId.value = existing?.puzzleId || '';
  els.entryModalNotes.value = existing?.notes || '';

  const isDuration = game.metricFormat === 'duration_sec';
  const isFraction = game.metricFormat === 'fraction';
  const isPercent = game.metricFormat === 'percent';

  if (isDuration) {
    els.entryModalValueLabel.textContent = `${game.metricLabel || 'Time'} (mm:ss or sec)`;
    els.entryModalValueInput.placeholder = 'e.g. 2:14 or 134';
  } else if (isFraction) {
    els.entryModalValueLabel.textContent = `${game.metricLabel || 'Guesses'} (e.g. 4/6)`;
    els.entryModalValueInput.placeholder = 'e.g. 4/6 or 4';
  } else if (isPercent) {
    els.entryModalValueLabel.textContent = `${game.metricLabel || 'Accuracy'} (%)`;
    els.entryModalValueInput.placeholder = 'e.g. 92%';
  } else {
    els.entryModalValueLabel.textContent = game.metricLabel || 'Metric Value';
    els.entryModalValueInput.placeholder = 'e.g. 840';
  }

  if (existing?.primaryValue !== null && existing?.primaryValue !== undefined) {
    if (isDuration) {
      els.entryModalValueInput.value = formatDurationSeconds(existing.primaryValue);
    } else if (isFraction && existing.displayValue && existing.displayValue.includes('/')) {
      els.entryModalValueInput.value = existing.displayValue;
    } else {
      els.entryModalValueInput.value = String(existing.primaryValue);
    }
  } else {
    els.entryModalValueInput.value = '';
  }

  const hasManualOverride = Boolean(existing && (!existing.rawText || existing.manualOverride));
  els.entryModalManualOverride.checked = hasManualOverride;
  if (hasManualOverride) {
    const mode = existing.solved === true ? 'true' : existing.solved === false ? 'false' : 'null';
    setSolvedSegMode(mode);
  } else {
    setSolvedSegMode('auto');
  }

  const existingDifficulty = getEntryDifficulty(existing);
  setEntryModalDifficulty(existingDifficulty);
  state.entryModalDifficultyTouched = Boolean(
    existing && (existingDifficulty || existing.manualOverride)
  );
  updateEntryDifficultyVisibility(game, null, existing);

  const showRounds = gameSupportsRoundInputs(game);
  setHidden(els.entryModalRoundsGroup, !showRounds);
  const existingRounds = Array.isArray(existing?.breakdown) ? existing.breakdown : [];
  if (showRounds) {
    setEntryModalRoundsFromBreakdown(existingRounds);
  }
  state.entryModalRoundsTouched = Boolean(
    existing && (existingRounds.length > 0 || existing.manualOverride)
  );
  state.entryModalValueAutoFilled = false;

  setHidden(els.btnEntryModalDelete, !existing);

  updateEntryParsePreview();
  openModalDialog(els.entryDialog);
  els.entryModalRawText.focus();
}

async function handleSubmitEntryModal(event) {
  event.preventDefault();
  if (state.isSavingEntry) return;

  const game = getGameById(els.entryModalGameId.value);
  if (!game) return;

  const rawText = els.entryModalRawText.value.trim();
  const entryId = els.entryModalId.value;
  const playDate = els.entryModalDate.value || getDefaultPlayDateForGame(game);
  const parsed = rawText ? parseForGame(rawText, game) : null;
  const manualChecked = Boolean(els.entryModalManualOverride.checked);

  let primaryValue = null;
  let explicitDisplay = null;
  const rawVal = els.entryModalValueInput.value.trim();

  if (rawVal !== '') {
    if (game.metricFormat === 'duration_sec') {
      const parsedDuration = parseDurationSeconds(rawVal);
      const numericFallback = Number(rawVal);
      if (parsedDuration !== null) {
        primaryValue = parsedDuration;
      } else if (Number.isFinite(numericFallback) && numericFallback >= 0) {
        primaryValue = Math.round(numericFallback);
      } else {
        showToast('Enter duration as mm:ss (e.g. 2:14) or seconds.', { variant: 'error' });
        els.entryModalManualOverride.checked = true;
        els.entryModalValueInput.focus();
        return;
      }
    } else if (game.metricFormat === 'fraction') {
      const fracMatch = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(rawVal);
      if (fracMatch) {
        primaryValue = Number(fracMatch[1]);
        explicitDisplay = `${fracMatch[1]}/${fracMatch[2]}`;
      } else {
        const num = Number(rawVal);
        if (!Number.isFinite(num)) {
          showToast('Enter a fraction (e.g. 4/6) or number.', { variant: 'error' });
          els.entryModalManualOverride.checked = true;
          els.entryModalValueInput.focus();
          return;
        }
        primaryValue = num;
      }
    } else if (game.metricFormat === 'percent') {
      const num = Number(rawVal.replace(/%$/, '').trim());
      if (!Number.isFinite(num)) {
        showToast('Enter a valid percentage number (e.g. 92%).', { variant: 'error' });
        els.entryModalManualOverride.checked = true;
        els.entryModalValueInput.focus();
        return;
      }
      primaryValue = num;
    } else {
      const num = Number(rawVal.replace(/,/g, ''));
      if (!Number.isFinite(num)) {
        showToast('Enter a valid number for score/metric.', { variant: 'error' });
        els.entryModalManualOverride.checked = true;
        els.entryModalValueInput.focus();
        return;
      }
      primaryValue = num;
    }
  } else if (parsed?.primaryValue !== null && parsed?.primaryValue !== undefined && !manualChecked) {
    primaryValue = parsed.primaryValue;
  }

  const solved = getSolvedSegValue(parsed);
  const puzzleIdInput = els.entryModalPuzzleId.value.trim();
  const puzzleId = puzzleIdInput || (!manualChecked ? parsed?.puzzleId || null : null);
  const notes = els.entryModalNotes.value.trim();

  const manualDiffers =
    manualChecked ||
    Boolean(!rawText) ||
    (rawVal !== '' && (!parsed || primaryValue !== parsed.primaryValue)) ||
    (state.solvedSegMode !== 'auto' && (!parsed || solved !== parsed.solved));

  const payload = {
    gameId: game.id,
    playDate,
    rawText,
    completed: true,
    solved,
    primaryValue,
    puzzleId,
    notes,
    manualOverride: manualDiffers,
  };

  const difficultyVisible = gameSupportsDifficulty(
    game,
    parsed,
    state.entryModalDifficulty ? { difficulty: state.entryModalDifficulty } : null
  );
  if (difficultyVisible || state.entryModalDifficulty) {
    payload.difficulty = state.entryModalDifficulty || '';
  }

  const roundsVisible = gameSupportsRoundInputs(game);
  if (roundsVisible) {
    const roundsRes = collectEntryRoundInputs({ validate: true });
    if (roundsRes.error) return;
    if (roundsRes.breakdown.length > 0) {
      payload.breakdown = roundsRes.breakdown;
      if (payload.primaryValue === null || payload.primaryValue === undefined) {
        const sum = roundsRes.breakdown.reduce((acc, item) => acc + item.value, 0);
        primaryValue = Math.round(sum / roundsRes.breakdown.length);
        payload.primaryValue = primaryValue;
      }
    } else if (entryId && state.entryModalRoundsTouched) {
      payload.breakdown = [];
    }
  }

  if (explicitDisplay) {
    payload.displayValue = explicitDisplay;
  } else if (manualDiffers) {
    payload.displayValue =
      primaryValue !== null
        ? formatMetricValue(primaryValue, game.metricFormat, solved === false ? 'DNF' : 'Played')
        : solved === false
          ? 'DNF'
          : 'Played';
  } else if (parsed?.displayValue) {
    payload.displayValue = parsed.displayValue;
  } else if (roundsVisible && primaryValue !== null) {
    payload.displayValue = formatMetricValue(
      primaryValue,
      game.metricFormat,
      solved === false ? 'DNF' : 'Played'
    );
  }

  state.isSavingEntry = true;
  try {
    const resp = entryId ? await api.updateEntry(entryId, payload) : await api.saveEntry(payload);
    const saved = resp?.entry || resp;

    state.justStampedGameId = game.id;
    state.activeCaptureGameId = null;
    closeModalDialog(els.entryDialog, 'saved');
    invalidateLeaderboardCache();
    await refreshBootstrapAndEntries();
    renderTodayView();
    if (state.activeTab === 'stats') {
      await loadAndRenderStatsView();
    } else if (state.activeTab === 'leaderboard') {
      await loadAndRenderLeaderboardView();
    }
    showToast(`Saved ${game.name}: ${formatEntryResult(saved, game)}`, { variant: 'success' });
  } catch (err) {
    showToast(`Failed to save result: ${err.message}`, { variant: 'error' });
  } finally {
    state.isSavingEntry = false;
  }
}

async function handleDeleteEntryFromModal() {
  const entryId = els.entryModalId.value;
  const game = getGameById(els.entryModalGameId.value);
  if (!entryId) return;

  const ok = await confirmAction({
    title: 'Delete Play Entry',
    message: `Delete this ${game?.name || 'game'} entry?`,
    okLabel: 'Delete Entry',
  });
  if (!ok) return;

  try {
    await api.deleteEntry(entryId);
    closeModalDialog(els.entryDialog, 'deleted');
    invalidateLeaderboardCache();
    await refreshBootstrapAndEntries();
    renderTodayView();
    if (state.activeTab === 'stats') {
      await loadAndRenderStatsView();
    } else if (state.activeTab === 'leaderboard') {
      await loadAndRenderLeaderboardView();
    }
    showToast('Entry deleted.', { variant: 'info' });
  } catch (err) {
    showToast(`Failed to delete entry: ${err.message}`, { variant: 'error' });
  }
}

// ---------- Game Dialog ----------

function updateGameDialogPreview() {
  const color = normalizeHexColor(els.gameColor.value);
  const onColor = getReadableTextColor(color);
  if (els.gameDialogPreviewIcon) {
    els.gameDialogPreviewIcon.textContent = els.gameIcon.value.trim() || '🎮';
    els.gameDialogPreviewIcon.style.background = color;
    els.gameDialogPreviewIcon.style.color = onColor;
  }
  if (els.gameColorHex) {
    els.gameColorHex.textContent = color;
  }
  document.querySelectorAll('.color-swatch-btn[data-color]').forEach((btn) => {
    btn.classList.toggle('is-active', normalizeHexColor(btn.dataset.color) === color);
  });
}

function syncScoringTileSelection() {
  const label = els.gameMetricLabel.value.trim();
  const format = els.gameMetricFormat.value;
  const direction = els.gameMetricDirection.value;

  let matchedKey = null;
  for (const [key, preset] of Object.entries(SCORING_PRESETS)) {
    if (
      preset.metricLabel === label &&
      preset.metricFormat === format &&
      preset.metricDirection === direction
    ) {
      matchedKey = key;
      break;
    }
  }

  els.scoringModeGrid?.querySelectorAll('.scoring-tile[data-preset]').forEach((btn) => {
    const active = btn.dataset.preset === matchedKey;
    btn.classList.toggle('is-selected', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  return matchedKey;
}

function applyScoringPreset(presetKey) {
  const preset = SCORING_PRESETS[presetKey];
  if (!preset) return;
  els.gameMetricLabel.value = preset.metricLabel;
  els.gameMetricFormat.value = preset.metricFormat;
  els.gameMetricDirection.value = preset.metricDirection;
  syncScoringTileSelection();
}

function slugifyName(name) {
  return slugify(name);
}

function getUrlMatchKey(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : trimmed.includes('.') && !/[\s@]/.test(trimmed)
      ? `https://${trimmed}`
      : '';
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (!host || host === 'example.com' || host === 'localhost' || host === '127.0.0.1') {
      return null;
    }
    const pathname = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    return `${host}${pathname}`;
  } catch {
    return null;
  }
}

const CATALOG_COLLECTION_GROUPS = [
  { key: 'community', title: "✨ Friends' Picks & Community Games", defaultOpen: true },
  { key: 'magnitudle', title: '📏 Magnitudle Collection', defaultOpen: true },
  { key: 'flightq', title: '✈️ FlightQ Daily Collection', defaultOpen: false },
];

function getNormalizedCollectionKey(item) {
  const rawCol = String(item?.collection || '').trim().toLowerCase();
  if (rawCol === 'magnitudle' || String(item?.slug || '').toLowerCase().startsWith('magnitudle-')) {
    return 'magnitudle';
  }
  if (rawCol === 'flightq' || String(item?.slug || '').toLowerCase().startsWith('flightq-')) {
    return 'flightq';
  }
  return null;
}

function isOptionalCollectionItem(item) {
  if (item?.isStarter) return false;
  if (item?.isOptional === true) return true;
  if (item?.isOptional === false) return false;
  return Boolean(getNormalizedCollectionKey(item));
}

function getCatalogCollectionKey(item) {
  return getNormalizedCollectionKey(item) || 'community';
}

function getCatalogTagsWithCounts(items) {
  const counts = new Map();
  for (const item of items || []) {
    for (const tag of getGameTags(item)) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { counts, tags: sorted.map(([tag]) => tag) };
}

function renderCatalogTagBarHtml(items, selectedTag) {
  const { counts, tags } = getCatalogTagsWithCounts(items);
  if (tags.length === 0) return '';
  const allActive = selectedTag === 'All';
  const buttons = [
    `<button type="button" class="tag-filter-pill ${allActive ? 'is-active' : ''}" data-tag="All" aria-pressed="${allActive ? 'true' : 'false'}">All <span class="tabular-nums">(${items.length})</span></button>`,
  ];
  for (const tag of tags) {
    const active = selectedTag === tag;
    buttons.push(
      `<button type="button" class="tag-filter-pill ${active ? 'is-active' : ''}" data-tag="${escapeHtml(tag)}" aria-pressed="${active ? 'true' : 'false'}">${escapeHtml(tag)} <span class="tabular-nums">(${counts.get(tag)})</span></button>`
    );
  }
  return buttons.join('');
}

function renderCatalogCollectionsHtml(items, { contextKey, forceOpen = false } = {}) {
  const grouped = new Map();
  for (const group of CATALOG_COLLECTION_GROUPS) {
    grouped.set(group.key, []);
  }
  for (const item of items || []) {
    const key = getCatalogCollectionKey(item);
    grouped.get(key).push(item);
  }

  const sections = [];
  for (const group of CATALOG_COLLECTION_GROUPS) {
    const groupItems = grouped.get(group.key) || [];
    if (groupItems.length === 0) continue;
    const stateKey = `${contextKey}:${group.key}`;
    const storedOpen = state.openCatalogCollections?.[stateKey];
    const isOpen =
      typeof storedOpen === 'boolean'
        ? storedOpen || forceOpen
        : forceOpen || group.defaultOpen;
    sections.push(`
      <details class="catalog-collection-group" data-collection-context="${escapeHtml(contextKey)}" data-collection-key="${escapeHtml(group.key)}" ${isOpen ? 'open' : ''}>
        <summary class="catalog-collection-summary">
          <span>${escapeHtml(group.title)}</span>
          <span class="pill pill-neutral catalog-collection-count tabular-nums">${escapeHtml(String(groupItems.length))}</span>
        </summary>
        <div class="catalog-collection-items catalog-list">
          ${groupItems.map((item) => renderCatalogItemHtml(item)).join('')}
        </div>
      </details>
    `);
  }
  return sections.join('');
}

function matchesCatalogFilters(item, query, selectedTag) {
  if (selectedTag && selectedTag !== 'All') {
    const tags = getGameTags(item);
    if (!tags.includes(selectedTag)) return false;
  }
  if (!query) return true;
  return [
    item.name,
    item.slug,
    item.category,
    item.url,
    item.createdByName,
    ...getGameTags(item),
  ]
    .filter(Boolean)
    .some((field) => String(field).toLowerCase().includes(query));
}

function updateCatalogDiscoveryBadge() {
  const discoverableCount = (state.catalog || []).filter(
    (item) =>
      item.viewerStatus === 'not_added' &&
      (Number(item.playerCount || 0) > 0 || Boolean(item.createdByName))
  ).length;
  if (els.addGameCatalogBadge) {
    if (discoverableCount > 0) {
      els.addGameCatalogBadge.textContent = String(discoverableCount);
      setHidden(els.addGameCatalogBadge, false);
    } else {
      els.addGameCatalogBadge.textContent = '';
      setHidden(els.addGameCatalogBadge, true);
    }
  }
  if (els.btnOpenAddGame) {
    els.btnOpenAddGame.setAttribute(
      'aria-label',
      discoverableCount > 0
        ? `Add Game (${discoverableCount} friend ${discoverableCount === 1 ? 'game' : 'games'} available)`
        : 'Add Game'
    );
  }
}

function renderCatalogItemHtml(item) {
  const color = normalizeHexColor(item.color, '#6366f1');
  const onColor = getReadableTextColor(color);
  const domain = getGameDomainLabel(item.url) || item.url;
  const playerCount = Number(item.playerCount || 0);
  const isBusy = state.subscribingSlugs.has(item.slug);

  let actionHtml = '<span class="pill pill-success">On Shelf ✓</span>';
  if (item.viewerStatus === 'not_added') {
    actionHtml = `<button type="button" class="btn btn-primary btn-xs" data-action="subscribe-catalog-game" data-slug="${escapeHtml(item.slug)}" ${isBusy ? 'disabled' : ''}>${isBusy ? 'Adding…' : '＋ Add to Shelf'}</button>`;
  } else if (item.viewerStatus === 'archived') {
    actionHtml = `<button type="button" class="btn btn-secondary btn-xs" data-action="subscribe-catalog-game" data-slug="${escapeHtml(item.slug)}" ${isBusy ? 'disabled' : ''}>${isBusy ? 'Restoring…' : '↺ Restore'}</button>`;
  }

  return `
    <div class="catalog-item" data-catalog-slug="${escapeHtml(item.slug)}">
      <div class="catalog-item-main">
        <div class="game-icon-box game-icon-box-sm" style="background:${escapeHtml(color)}; color:${escapeHtml(onColor)};" aria-hidden="true">${escapeHtml(item.icon || '🎮')}</div>
        <div class="game-title-wrap">
          <div class="game-name">${escapeHtml(item.name)}</div>
          <div class="catalog-item-meta">
            <span class="pill pill-neutral">${escapeHtml(item.category || 'Daily')}</span>
            <span class="tabular-nums">${escapeHtml(String(playerCount))} ${playerCount === 1 ? 'player' : 'players'}</span>
            ${domain ? `<span>· ${escapeHtml(domain)}</span>` : ''}
            ${!item.isStarter && item.createdByName ? `<span>· Added by ${escapeHtml(item.createdByName)}</span>` : ''}
          </div>
        </div>
      </div>
      <div>${actionHtml}</div>
    </div>
  `;
}

function renderCatalogPicker(searchTerm = '', selectedTag = state.dialogCatalogTag) {
  if (!els.catalogAvailableList || !els.catalogOwnedList) return;
  const catalog = state.catalog || [];
  const allAvailable = catalog.filter((item) => item.viewerStatus !== 'active');
  const { tags: availableTags } = getCatalogTagsWithCounts(catalog);
  if (selectedTag !== 'All' && !availableTags.includes(selectedTag)) {
    state.dialogCatalogTag = 'All';
    selectedTag = 'All';
  } else {
    state.dialogCatalogTag = selectedTag || 'All';
  }

  if (els.catalogTagBar) {
    const tagBarHtml = renderCatalogTagBarHtml(catalog, state.dialogCatalogTag);
    els.catalogTagBar.innerHTML = tagBarHtml;
    setHidden(els.catalogTagBar, !tagBarHtml);
  }

  const query = String(searchTerm || '').trim().toLowerCase();
  const filtered = catalog.filter((item) =>
    matchesCatalogFilters(item, query, state.dialogCatalogTag)
  );
  const available = filtered.filter((item) => item.viewerStatus !== 'active');
  const owned = filtered.filter((item) => item.viewerStatus === 'active');

  if (available.length === 0) {
    els.catalogAvailableList.innerHTML =
      allAvailable.length > 0
        ? '<p class="empty-hint">No matching catalog games — clear filters or create a brand-new game below.</p>'
        : `<p class="empty-hint">All ${catalog.length} catalog games are already on your shelf!</p>`;
  } else {
    els.catalogAvailableList.innerHTML = renderCatalogCollectionsHtml(available, {
      contextKey: 'dialog',
      forceOpen: Boolean(query) || state.dialogCatalogTag !== 'All',
    });
  }

  if (els.catalogOwnedSummary) {
    els.catalogOwnedSummary.textContent = `Already on your shelf (${owned.length})`;
  }
  if (els.catalogOwnedDetails) {
    setHidden(els.catalogOwnedDetails, owned.length === 0);
  }
  els.catalogOwnedList.innerHTML = owned.map((item) => renderCatalogItemHtml(item)).join('');
}

function renderFriendsCatalogShelf() {
  if (!els.friendsCatalogShelf || !els.friendsCatalogCollections) return;
  const discoverable = (state.catalog || []).filter((item) => item.viewerStatus !== 'active');
  if (discoverable.length === 0) {
    setHidden(els.friendsCatalogShelf, true);
    els.friendsCatalogCollections.innerHTML = '';
    if (els.friendsCatalogTagBar) els.friendsCatalogTagBar.innerHTML = '';
    return;
  }

  setHidden(els.friendsCatalogShelf, false);
  if (els.friendsCatalogCount) {
    els.friendsCatalogCount.textContent = `${discoverable.length} available`;
  }

  const { tags } = getCatalogTagsWithCounts(discoverable);
  if (state.friendsCatalogTag !== 'All' && !tags.includes(state.friendsCatalogTag)) {
    state.friendsCatalogTag = 'All';
  }
  if (els.friendsCatalogTagBar) {
    const tagBarHtml = renderCatalogTagBarHtml(discoverable, state.friendsCatalogTag);
    els.friendsCatalogTagBar.innerHTML = tagBarHtml;
    setHidden(els.friendsCatalogTagBar, !tagBarHtml);
  }

  const query = String(state.friendsCatalogSearch || '').trim().toLowerCase();
  const filtered = discoverable.filter((item) =>
    matchesCatalogFilters(item, query, state.friendsCatalogTag)
  );
  if (filtered.length === 0) {
    els.friendsCatalogCollections.innerHTML =
      '<p class="empty-hint">No catalog games match your search or tag filter.</p>';
  } else {
    els.friendsCatalogCollections.innerHTML = renderCatalogCollectionsHtml(filtered, {
      contextKey: 'friends',
      forceOpen: Boolean(query) || state.friendsCatalogTag !== 'All',
    });
  }
}

function renderCatalogMatchBanner() {
  if (!els.gameCatalogMatchBanner) return;
  if (els.gameFormId?.value) {
    els.gameCatalogMatchBanner.innerHTML = '';
    setHidden(els.gameCatalogMatchBanner, true);
    return;
  }

  const nameSlug = slugifyName(els.gameName?.value || '');
  const urlKey = getUrlMatchKey(els.gameUrl?.value || '');
  const match = (state.catalog || []).find((item) => {
    if (item.viewerStatus === 'active') return false;
    const itemUrlKey = getUrlMatchKey(item.url);
    if (urlKey && itemUrlKey && itemUrlKey === urlKey) return true;
    if (nameSlug && nameSlug.length >= 2 && item.slug === nameSlug) return true;
    return false;
  });

  if (!match) {
    els.gameCatalogMatchBanner.innerHTML = '';
    setHidden(els.gameCatalogMatchBanner, true);
    return;
  }

  const isBusy = state.subscribingSlugs.has(match.slug);
  const actionLabel =
    match.viewerStatus === 'archived'
      ? `↺ Restore "${match.name}"`
      : `＋ Add "${match.name}"`;
  const creatorNote = match.createdByName ? ` (added by ${match.createdByName})` : '';
  const msg = `"${match.name}" is already in the Hub Catalog${creatorNote}. Subscribe so your scores share the same Leaderboard!`;

  els.gameCatalogMatchBanner.innerHTML = `
    <span>${escapeHtml(msg)}</span>
    <button type="button" class="btn btn-primary btn-xs" data-action="subscribe-matched-catalog" data-slug="${escapeHtml(match.slug)}" ${isBusy ? 'disabled' : ''}>${escapeHtml(actionLabel)}</button>
  `;
  setHidden(els.gameCatalogMatchBanner, false);
}

async function handleSubscribeCatalogGame(
  slug,
  triggerBtn = null,
  { closeGameDialogOnSuccess = false } = {}
) {
  if (!slug || state.subscribingSlugs.has(slug)) return;
  const catalogItem = (state.catalog || []).find((c) => c.slug === slug);
  state.subscribingSlugs.add(slug);
  if (triggerBtn) {
    triggerBtn.disabled = true;
  }

  try {
    const resp = await api.subscribeCatalogGame(slug);
    const gameName = resp?.game?.name || catalogItem?.name || slug;
    invalidateLeaderboardCache();
    await refreshBootstrapAndEntries();
    renderTodayView();
    renderGamesAdminView();
    if (state.activeTab === 'leaderboard') {
      await loadAndRenderLeaderboardView();
    } else if (state.activeTab === 'stats') {
      await loadAndRenderStatsView();
    }

    if (closeGameDialogOnSuccess && els.gameDialog?.open) {
      closeModalDialog(els.gameDialog, 'saved');
    } else if (els.gameDialog?.open && !els.gameFormId?.value) {
      renderCatalogPicker(els.catalogSearchInput?.value || '', state.dialogCatalogTag);
      renderCatalogMatchBanner();
    }

    let message = `Added ${gameName} to your Today shelf!`;
    if (resp?.status === 'restored') {
      message = `Restored ${gameName} to your Today shelf!`;
    } else if (resp?.status === 'already_active') {
      message = `${gameName} is already on your Today shelf.`;
    }

    showToast(message, {
      variant: 'success',
      actionLabel: state.activeTab !== 'today' ? 'Open Today' : undefined,
      onAction: () => setActiveTab('today'),
    });
  } catch (err) {
    showToast(`Could not add game: ${err.message}`, { variant: 'error' });
    if (triggerBtn && triggerBtn.isConnected) {
      triggerBtn.disabled = false;
    }
  } finally {
    state.subscribingSlugs.delete(slug);
    if (triggerBtn && triggerBtn.isConnected) {
      triggerBtn.disabled = false;
    }
  }
}

function openGameModal(gameId = null) {
  populateGameSelects();
  const existing = gameId ? getGameById(gameId) : null;
  const isCreateMode = !existing;

  els.gameFormId.value = existing?.id ? String(existing.id) : '';
  els.gameFormTitle.textContent = existing ? `Edit ${existing.name}` : 'Add Daily Game';
  els.gameDialogSubtitle.textContent = existing
    ? 'Update cartridge styling, game link, or scoring format.'
    : 'Subscribe from the Hub Catalog in 1 click or create a brand-new game.';
  if (els.btnSaveGame) {
    els.btnSaveGame.textContent = existing ? 'Save Changes' : 'Add Game';
  }

  setHidden(els.catalogPickerSection, !isCreateMode);
  setHidden(els.createCustomDivider, !isCreateMode);
  if (isCreateMode) {
    state.dialogCatalogTag = 'All';
    if (els.catalogSearchInput) els.catalogSearchInput.value = '';
    if (els.catalogOwnedDetails) els.catalogOwnedDetails.open = false;
    renderCatalogPicker('', 'All');
  } else if (els.gameCatalogMatchBanner) {
    els.gameCatalogMatchBanner.innerHTML = '';
    setHidden(els.gameCatalogMatchBanner, true);
  }

  els.gameName.value = existing?.name || '';
  els.gameUrl.value = existing?.url || '';
  els.gameIcon.value = existing?.icon || '🧩';
  const color = normalizeHexColor(existing?.color, '#ff5a36');
  els.gameColor.value = color;
  if (els.gameColorHex) {
    els.gameColorHex.textContent = color;
  }
  els.gameCategory.value = existing?.category || 'Daily Puzzle';

  els.gameMetricLabel.value = existing?.metricLabel || SCORING_PRESETS.points.metricLabel;
  els.gameMetricFormat.value = existing?.metricFormat || SCORING_PRESETS.points.metricFormat;
  els.gameMetricDirection.value =
    existing?.metricDirection || SCORING_PRESETS.points.metricDirection;
  els.gameParserId.value = existing?.parserId || 'auto';

  const resetTimezone = existing?.resetTimezone || 'local';
  const resetTime = isValidResetTime(existing?.resetTime) ? existing.resetTime : '00:00';
  populateResetTimezoneSelect(resetTimezone);
  if (els.gameResetTime) {
    els.gameResetTime.value = resetTime;
  }
  updateGameResetPreview();

  const matchedPreset = syncScoringTileSelection();
  els.advancedGameDetails.open = Boolean(
    existing &&
      (!matchedPreset ||
        (existing.parserId && existing.parserId !== 'auto' && existing.parserId !== 'generic'))
  );

  updateGameDialogPreview();
  renderCatalogMatchBanner();
  openModalDialog(els.gameDialog);
  els.gameName.focus();
}

async function handleSubmitGameModal(event) {
  event.preventDefault();
  if (state.isSavingGame) return;

  const name = els.gameName.value.trim();
  const url = els.gameUrl.value.trim();

  if (!name) {
    showToast('Game name is required.', { variant: 'error' });
    els.gameName.focus();
    return;
  }
  if (!isSafeHttpUrl(url)) {
    showToast('Enter a valid http:// or https:// URL.', { variant: 'error' });
    els.gameUrl.focus();
    return;
  }

  const color = normalizeHexColor(els.gameColor.value, '#ff5a36');
  const gameId = els.gameFormId.value;
  const resetTimezone = isValidResetTimezone(els.gameResetTimezone?.value)
    ? els.gameResetTimezone.value
    : 'local';
  const resetTime = isValidResetTime(els.gameResetTime?.value)
    ? els.gameResetTime.value
    : '00:00';
  const payload = {
    name,
    url,
    icon: els.gameIcon.value.trim() || '🎮',
    color,
    category: els.gameCategory.value.trim() || 'Daily Puzzle',
    metricLabel: els.gameMetricLabel.value.trim() || 'Score',
    metricFormat: els.gameMetricFormat.value || 'number',
    metricDirection: els.gameMetricDirection.value || 'higher_is_better',
    parserId: els.gameParserId.value || 'auto',
    resetTimezone,
    resetTime,
  };

  state.isSavingGame = true;
  try {
    if (gameId) {
      await api.updateGame(gameId, payload);
      showToast(`Updated ${name}.`, { variant: 'success' });
    } else {
      await api.createGame(payload);
      showToast(`Added ${name} to your shelf!`, { variant: 'success' });
    }

    closeModalDialog(els.gameDialog, 'saved');
    invalidateLeaderboardCache();
    await refreshBootstrapAndEntries();
    renderTodayView();
    if (state.activeTab === 'games') renderGamesAdminView();
    if (state.activeTab === 'stats') await loadAndRenderStatsView();
    if (state.activeTab === 'leaderboard') await loadAndRenderLeaderboardView();
  } catch (err) {
    showToast(`Could not save game: ${err.message}`, { variant: 'error' });
  } finally {
    state.isSavingGame = false;
  }
}

// ---------- Players Leaderboard View ----------

const PLAYER_AVATAR_PALETTE = [
  '#ff5a36',
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#ef4444',
];

let leaderboardRequestSeq = 0;

function getPlayerAvatarColor(displayName) {
  const str = String(displayName || 'P');
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return PLAYER_AVATAR_PALETTE[hash % PLAYER_AVATAR_PALETTE.length];
}

function getPlayerInitial(displayName) {
  const trimmed = String(displayName || '').trim();
  if (!trimmed) return '?';
  return Array.from(trimmed)[0].toUpperCase();
}

function renderPlayerIdentityHtml(player) {
  const name = player?.displayName || 'Player';
  const bg = getPlayerAvatarColor(name);
  const fg = getReadableTextColor(bg);
  const initial = getPlayerInitial(name);
  return `
    <div class="player-identity">
      <span class="player-avatar" style="background:${escapeHtml(bg)}; color:${escapeHtml(fg)};" aria-hidden="true">${escapeHtml(initial)}</span>
      <span class="player-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
      ${player?.isViewer ? '<span class="player-you-badge">YOU</span>' : ''}
    </div>
  `;
}

function formatRankDisplay(rank) {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  const num = Number(rank);
  if (Number.isFinite(num) && num > 0) return `#${num}`;
  return '—';
}

function formatMedalsSummaryHtml(medals) {
  const gold = Number(medals?.gold || 0);
  const silver = Number(medals?.silver || 0);
  const bronze = Number(medals?.bronze || 0);
  const parts = [];
  if (gold > 0) parts.push(`<span class="medal-count" title="Gold medals">🥇×${gold}</span>`);
  if (silver > 0) parts.push(`<span class="medal-count" title="Silver medals">🥈×${silver}</span>`);
  if (bronze > 0) parts.push(`<span class="medal-count" title="Bronze medals">🥉×${bronze}</span>`);
  if (parts.length === 0) return '<span class="muted-text">—</span>';
  return `<div class="medal-cluster tabular-nums">${parts.join('')}</div>`;
}

function renderMatrixCellHtml(cell) {
  if (!cell) {
    return '<td class="matrix-cell"><span class="matrix-empty muted-text" aria-label="Not played">·</span></td>';
  }
  const scoreStr = cell.displayValue || (cell.solved === false ? 'DNF' : 'Played');
  const medal = cell.rank === 1 ? '🥇' : cell.rank === 2 ? '🥈' : cell.rank === 3 ? '🥉' : '';
  const diffBadge = renderDifficultyBadgeHtml(getEntryDifficulty(cell), { compact: true });
  const dnfBadge = cell.solved === false ? '<span class="pill pill-danger">DNF</span>' : '';
  const lockBadge = cell.spoilerProtected
    ? '<span class="matrix-spoiler-lock" title="Play today\'s puzzle to unlock share grid" aria-label="Spoiler protected">🔒</span>'
    : '';
  const accHtml =
    !cell.spoilerProtected && cell.accuracySummary
      ? `<div class="cell-accuracy-line muted-text tabular-nums">${escapeHtml(cell.accuracySummary)}</div>`
      : '';
  const gridHtml = cell.emojiGrid
    ? `<details class="share-grid-details matrix-grid-details"><summary>Grid</summary><pre class="share-grid-pre">${escapeHtml(cell.emojiGrid)}</pre></details>`
    : '';

  return `
    <td class="matrix-cell">
      <div class="matrix-cell-top">
        <strong class="tabular-nums">${escapeHtml(scoreStr)}</strong>
        ${medal ? `<span aria-label="Rank ${escapeHtml(String(cell.rank))}">${medal}</span>` : ''}
        ${diffBadge}
        ${dnfBadge}
        ${lockBadge}
      </div>
      ${accHtml}
      ${gridHtml}
    </td>
  `;
}

function renderGameTodayCellHtml(cell) {
  if (!cell) {
    return '<span class="muted-text">—</span>';
  }
  const scoreStr = cell.displayValue || (cell.solved === false ? 'DNF' : 'Played');
  const medal = cell.rank === 1 ? '🥇' : cell.rank === 2 ? '🥈' : cell.rank === 3 ? '🥉' : '';
  const diffBadge = renderDifficultyBadgeHtml(getEntryDifficulty(cell), { compact: true });
  const dnfBadge = cell.solved === false ? '<span class="pill pill-danger">DNF</span>' : '';
  const lockBadge = cell.spoilerProtected
    ? '<span class="matrix-spoiler-lock" title="Play today\'s puzzle to unlock share grid" aria-label="Spoiler protected">🔒</span>'
    : '';
  const accHtml =
    !cell.spoilerProtected && cell.accuracySummary
      ? `<div class="cell-accuracy-line muted-text tabular-nums">${escapeHtml(cell.accuracySummary)}</div>`
      : '';
  const gridHtml = cell.emojiGrid
    ? `<details class="share-grid-details matrix-grid-details"><summary>Grid</summary><pre class="share-grid-pre">${escapeHtml(cell.emojiGrid)}</pre></details>`
    : '';
  return `
    <div class="matrix-cell-top">
      <strong class="tabular-nums">${escapeHtml(scoreStr)}</strong>
      ${medal ? `<span>${medal}</span>` : ''}
      ${diffBadge}
      ${dnfBadge}
      ${lockBadge}
    </div>
    ${accHtml}
    ${gridHtml}
  `;
}

function renderLeaderboardControls() {
  if (els.lbDatePretty) {
    els.lbDatePretty.textContent = formatPrettyDate(state.lbDate, state.todayStr);
  }
  if (els.lbDateInput) {
    els.lbDateInput.value = state.lbDate;
  }
  setHidden(els.btnLbToday, state.lbDate === state.todayStr);

  if (els.btnLbDays1) {
    els.btnLbDays1.textContent = state.lbDate === state.todayStr ? 'Today' : '1d';
  }

  els.lbWindowGroup?.querySelectorAll('.seg-btn[data-days]').forEach((btn) => {
    const raw = btn.dataset.days;
    const days = raw === 'all' ? 0 : Number(raw || 30);
    const active = days === state.lbDays;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function getDefaultOverallSortDir(sortKey) {
  return sortKey === 'player' ? 'asc' : 'desc';
}

function getDefaultGameSortDir(sortKey, metricDirection) {
  if (sortKey === 'player') return 'asc';
  if (sortKey === 'today' || sortKey === 'average' || sortKey === 'best') {
    return metricDirection === 'lower_is_better' ? 'asc' : 'desc';
  }
  return 'desc';
}

function renderTableSortHeaders(tableEl, activeKey, activeDir) {
  if (!tableEl?.tHead) return;
  tableEl.tHead.querySelectorAll('th.sortable-th[data-sort-col]').forEach((th) => {
    const isActive = th.dataset.sortCol === activeKey;
    th.classList.toggle('is-sorted', isActive);
    th.setAttribute(
      'aria-sort',
      isActive ? (activeDir === 'asc' ? 'ascending' : 'descending') : 'none'
    );
    const indicator = th.querySelector('.th-sort-indicator');
    if (indicator) {
      indicator.textContent = isActive ? (activeDir === 'asc' ? '↑' : '↓') : '↕';
    }
  });
}

function compareNullableWithDir(aVal, bVal, sortDir) {
  const aValid = aVal !== null && aVal !== undefined && Number.isFinite(Number(aVal));
  const bValid = bVal !== null && bVal !== undefined && Number.isFinite(Number(bVal));
  if (!aValid && !bValid) return 0;
  if (!aValid) return 1;
  if (!bValid) return -1;
  return sortDir === 'asc' ? Number(aVal) - Number(bVal) : Number(bVal) - Number(aVal);
}

function compareMedalTuples(aMedals, bMedals, dirMult) {
  const aG = aMedals?.gold ?? 0;
  const bG = bMedals?.gold ?? 0;
  if (aG !== bG) return (aG - bG) * dirMult;
  const aS = aMedals?.silver ?? 0;
  const bS = bMedals?.silver ?? 0;
  if (aS !== bS) return (aS - bS) * dirMult;
  const aB = aMedals?.bronze ?? 0;
  const bB = bMedals?.bronze ?? 0;
  if (aB !== bB) return (aB - bB) * dirMult;
  return 0;
}

function sortOverallStandings(standings, sortKey, sortDir) {
  const rows = Array.isArray(standings) ? [...standings] : [];
  if (sortKey === 'points' && sortDir === 'desc') {
    return rows;
  }

  const dirMult = sortDir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    let cmp = 0;
    if (sortKey === 'player') {
      cmp =
        String(a.displayName || '').localeCompare(String(b.displayName || ''), undefined, {
          sensitivity: 'base',
        }) * dirMult;
    } else if (sortKey === 'points') {
      cmp = ((a.arcadePoints ?? 0) - (b.arcadePoints ?? 0)) * dirMult;
    } else if (sortKey === 'medals') {
      cmp = compareMedalTuples(a.medals, b.medals, dirMult);
    } else if (sortKey === 'today') {
      cmp = ((a.todayPoints ?? 0) - (b.todayPoints ?? 0)) * dirMult;
      if (cmp === 0) {
        cmp = ((a.clearedTodayCount ?? 0) - (b.clearedTodayCount ?? 0)) * dirMult;
      }
      if (cmp === 0) {
        cmp = compareMedalTuples(a.todayMedals || a.medals, b.todayMedals || b.medals, dirMult);
      }
    } else if (sortKey === 'streak') {
      cmp = ((a.routineStreak ?? 0) - (b.routineStreak ?? 0)) * dirMult;
    } else if (sortKey === 'played') {
      cmp = ((a.totalPlayed ?? 0) - (b.totalPlayed ?? 0)) * dirMult;
    }
    if (cmp !== 0) return cmp;
    if ((a.rank ?? 9999) !== (b.rank ?? 9999)) {
      return (a.rank ?? 9999) - (b.rank ?? 9999);
    }
    return String(a.displayName || '').localeCompare(String(b.displayName || ''));
  });
  return rows;
}

function computeMetricRankMap(standings, field, lowerIsBetter) {
  const rankMap = new Map();
  const validRows = standings
    .filter(
      (p) => p[field] !== null && p[field] !== undefined && Number.isFinite(Number(p[field]))
    )
    .sort((a, b) =>
      lowerIsBetter ? Number(a[field]) - Number(b[field]) : Number(b[field]) - Number(a[field])
    );

  let prevVal = null;
  let prevRank = 0;
  validRows.forEach((p, idx) => {
    const num = Number(p[field]);
    const rank = idx > 0 && prevVal === num ? prevRank : idx + 1;
    prevVal = num;
    prevRank = rank;
    rankMap.set(p.userId, rank);
  });
  return rankMap;
}

function compareCluesRankItems(aPenalty, aVal, bPenalty, bVal) {
  const aHasP = aPenalty !== null && aPenalty !== undefined && Number.isFinite(Number(aPenalty));
  const bHasP = bPenalty !== null && bPenalty !== undefined && Number.isFinite(Number(bPenalty));
  if (aHasP !== bHasP) return aHasP ? -1 : 1;
  if (aHasP && bHasP && Number(aPenalty) !== Number(bPenalty)) {
    return Number(aPenalty) - Number(bPenalty);
  }
  const aValid = aVal !== null && aVal !== undefined && Number.isFinite(Number(aVal));
  const bValid = bVal !== null && bVal !== undefined && Number.isFinite(Number(bVal));
  if (!aValid && !bValid) return 0;
  if (!aValid) return 1;
  if (!bValid) return -1;
  return Number(aVal) - Number(bVal);
}

function computeCluesMetricRankMap(standings, { penaltyField, valueField }) {
  const rankMap = new Map();
  const hasFinite = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
  const validRows = standings
    .filter((p) => hasFinite(p[penaltyField]) || hasFinite(p[valueField]))
    .sort((a, b) =>
      compareCluesRankItems(a[penaltyField], a[valueField], b[penaltyField], b[valueField])
    );

  let prevRow = null;
  let prevRank = 0;
  validRows.forEach((p, idx) => {
    const isTie =
      prevRow !== null &&
      compareCluesRankItems(
        prevRow[penaltyField],
        prevRow[valueField],
        p[penaltyField],
        p[valueField]
      ) === 0;
    const rank = isTie ? prevRank : idx + 1;
    prevRow = p;
    prevRank = rank;
    rankMap.set(p.userId, rank);
  });
  return rankMap;
}

function sortGamewiseStandings(standings, sortKey, sortDir, gameOrDirection) {
  const rows = Array.isArray(standings) ? [...standings] : [];
  const selectedGame =
    gameOrDirection && typeof gameOrDirection === 'object' ? gameOrDirection : null;
  const metricDirection =
    typeof gameOrDirection === 'string' ? gameOrDirection : selectedGame?.metricDirection;
  const isClues = safeIsCluesBySamGame(selectedGame);
  const lowerIsBetter = metricDirection === 'lower_is_better';
  const dirMult = sortDir === 'asc' ? 1 : -1;

  if (sortKey === 'points' && sortDir === 'desc') {
    return rows.map((p) => ({ player: p, displayRank: p.rank }));
  }

  const avgRankMap =
    sortKey === 'average'
      ? isClues
        ? computeCluesMetricRankMap(rows, {
            penaltyField: 'averagePenalty',
            valueField: 'averageValue',
          })
        : computeMetricRankMap(rows, 'averageValue', lowerIsBetter)
      : null;
  const pbRankMap =
    sortKey === 'best'
      ? isClues
        ? computeCluesMetricRankMap(rows, {
            penaltyField: 'personalBestPenalty',
            valueField: 'personalBestValue',
          })
        : computeMetricRankMap(rows, 'personalBestValue', lowerIsBetter)
      : null;

  const hasFinite = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

  rows.sort((a, b) => {
    let cmp = 0;
    if (sortKey === 'player') {
      cmp =
        String(a.displayName || '').localeCompare(String(b.displayName || ''), undefined, {
          sensitivity: 'base',
        }) * dirMult;
    } else if (sortKey === 'points') {
      cmp = ((a.gamePoints ?? 0) - (b.gamePoints ?? 0)) * dirMult;
    } else if (sortKey === 'today') {
      if (a.today && !b.today) return -1;
      if (!a.today && b.today) return 1;
      if (a.today && b.today) {
        const aSolved = a.today.solved !== false;
        const bSolved = b.today.solved !== false;
        if (isClues) {
          if (aSolved !== bSolved) return aSolved ? -1 : 1;
          if (aSolved && bSolved) {
            const aAcc = a.today.accuracyPenalty;
            const bAcc = b.today.accuracyPenalty;
            const aNum = hasFinite(a.today.primaryValue) ? Number(a.today.primaryValue) : null;
            const bNum = hasFinite(b.today.primaryValue) ? Number(b.today.primaryValue) : null;
            const aValid = hasFinite(aAcc) || aNum !== null;
            const bValid = hasFinite(bAcc) || bNum !== null;
            if (aValid !== bValid) return aValid ? -1 : 1;
            if (aValid && bValid) {
              cmp = compareCluesRankItems(aAcc, aNum, bAcc, bNum) * dirMult;
            }
          }
        } else {
          const aNum =
            aSolved && hasFinite(a.today.primaryValue) ? Number(a.today.primaryValue) : null;
          const bNum =
            bSolved && hasFinite(b.today.primaryValue) ? Number(b.today.primaryValue) : null;
          cmp = compareNullableWithDir(aNum, bNum, sortDir);
        }
        if (cmp === 0 && (b.today.points ?? 0) !== (a.today.points ?? 0)) {
          cmp = (b.today.points ?? 0) - (a.today.points ?? 0);
        }
      }
    } else if (sortKey === 'average') {
      if (isClues) {
        const aValid = hasFinite(a.averagePenalty) || hasFinite(a.averageValue);
        const bValid = hasFinite(b.averagePenalty) || hasFinite(b.averageValue);
        if (aValid !== bValid) return aValid ? -1 : 1;
        if (aValid && bValid) {
          cmp =
            compareCluesRankItems(
              a.averagePenalty,
              a.averageValue,
              b.averagePenalty,
              b.averageValue
            ) * dirMult;
        }
      } else {
        cmp = compareNullableWithDir(a.averageValue, b.averageValue, sortDir);
      }
    } else if (sortKey === 'best') {
      if (isClues) {
        const aValid = hasFinite(a.personalBestPenalty) || hasFinite(a.personalBestValue);
        const bValid = hasFinite(b.personalBestPenalty) || hasFinite(b.personalBestValue);
        if (aValid !== bValid) return aValid ? -1 : 1;
        if (aValid && bValid) {
          cmp =
            compareCluesRankItems(
              a.personalBestPenalty,
              a.personalBestValue,
              b.personalBestPenalty,
              b.personalBestValue
            ) * dirMult;
        }
      } else {
        cmp = compareNullableWithDir(a.personalBestValue, b.personalBestValue, sortDir);
      }
    } else if (sortKey === 'streak') {
      cmp = ((a.currentStreak ?? 0) - (b.currentStreak ?? 0)) * dirMult;
    } else if (sortKey === 'played') {
      cmp = ((a.totalPlayed ?? 0) - (b.totalPlayed ?? 0)) * dirMult;
    }

    if (cmp !== 0) return cmp;
    if ((b.gamePoints ?? 0) !== (a.gamePoints ?? 0)) {
      return (b.gamePoints ?? 0) - (a.gamePoints ?? 0);
    }
    if ((b.totalPlayed ?? 0) !== (a.totalPlayed ?? 0)) {
      return (b.totalPlayed ?? 0) - (a.totalPlayed ?? 0);
    }
    return String(a.displayName || '').localeCompare(String(b.displayName || ''));
  });

  return rows.map((p) => {
    let displayRank = p.rank;
    if (sortKey === 'today') {
      displayRank = p.today?.rank ?? null;
    } else if (sortKey === 'average') {
      displayRank = avgRankMap?.get(p.userId) ?? null;
    } else if (sortKey === 'best') {
      displayRank = pbRankMap?.get(p.userId) ?? null;
    }
    return { player: p, displayRank };
  });
}

function renderOverallStandings(resp) {
  renderTableSortHeaders(els.playersOverallTable, state.lbOverallSortKey, state.lbOverallSortDir);
  if (!els.playersOverallTbody) return;
  const standings = resp?.overallStandings || [];
  const defaultGamesCount = resp?.catalogGames?.length || 0;

  if (standings.length === 0) {
    els.playersOverallTbody.innerHTML =
      '<tr><td colspan="7" class="muted-text">No players found yet.</td></tr>';
    return;
  }

  const sortedRows = sortOverallStandings(standings, state.lbOverallSortKey, state.lbOverallSortDir);

  els.playersOverallTbody.innerHTML = sortedRows
    .map((player) => {
      const activeGamesCount = player.activeGamesCount ?? defaultGamesCount;
      const clearedTodayCount = player.clearedTodayCount ?? 0;
      const todayPts = player.todayPoints ?? 0;
      const todayMedal =
        state.lbDays !== 1 && (player.todayRank === 1 || player.todayRank === 2 || player.todayRank === 3)
          ? player.todayRank === 1
            ? '🥇'
            : player.todayRank === 2
              ? '🥈'
              : '🥉'
          : '';
      const streak = player.routineStreak || 0;
      return `
        <tr class="${player.isViewer ? 'leaderboard-row-you' : ''}">
          <td class="rank-cell">${escapeHtml(formatRankDisplay(player.rank))}</td>
          <td>${renderPlayerIdentityHtml(player)}</td>
          <td class="num-col tabular-nums"><strong>${escapeHtml(String(player.arcadePoints ?? 0))} pts</strong></td>
          <td>${formatMedalsSummaryHtml(player.medals)}</td>
          <td class="num-col tabular-nums">
            <div class="today-cell-stack">
              <strong>${todayMedal ? `${todayMedal} ` : ''}${escapeHtml(String(todayPts))} pts</strong>
              <span class="muted-text">${escapeHtml(String(clearedTodayCount))}/${escapeHtml(String(activeGamesCount))}</span>
            </div>
          </td>
          <td class="num-col tabular-nums">${streak > 0 ? `🔥 ${escapeHtml(String(streak))}d` : '—'}</td>
          <td class="num-col tabular-nums">${escapeHtml(String(player.totalPlayed ?? 0))}</td>
        </tr>
      `;
    })
    .join('');
}

function renderTodayMatrix(resp) {
  if (!els.playersMatrixThead || !els.playersMatrixTbody) return;
  const matrix = resp?.todayMatrix || {};
  const games = matrix.games || [];
  const rows = matrix.rows || [];
  const selectedSlug = resp?.selectedGameSlug || state.lbSelectedGameSlug || games[0]?.slug || null;

  if (els.playersMatrixSubtitle) {
    const hasSpoilerLocked = games.some(
      (g) => !g.viewerCleared && rows.some((r) => r.cells?.[g.slug]?.spoilerProtected)
    );
    els.playersMatrixSubtitle.textContent = hasSpoilerLocked
      ? 'Active puzzle scores live · 🔒 share grids unlock after you log today\'s game'
      : 'Scores, medals & share grids across today\'s puzzle cycles';
  }

  els.playersMatrixThead.innerHTML = `
    <tr>
      <th scope="col" class="matrix-player-col">Player</th>
      <th scope="col" class="matrix-pts-col num-col">Today Pts</th>
      ${games
        .map(
          (g) => `
        <th scope="col" class="matrix-game-th">
          <button
            type="button"
            class="matrix-game-head-btn${g.slug === selectedSlug ? ' is-selected' : ''}"
            data-action="select-lb-game"
            data-slug="${escapeHtml(g.slug)}"
            title="Inspect ${escapeHtml(g.name)} standings"
          >
            <span aria-hidden="true">${escapeHtml(g.icon || '🎮')}</span>
            <span>${escapeHtml(g.name)}</span>
          </button>
        </th>
      `
        )
        .join('')}
    </tr>
  `;

  if (games.length === 0) {
    els.playersMatrixTbody.innerHTML = `<tr><td colspan="2" class="muted-text">No competitive games selected yet — solo games stay on your Today shelf. <button type="button" class="btn btn-secondary btn-xs" data-action="go-manage-games">Choose Competing Games in My Games</button></td></tr>`;
    return;
  }

  if (rows.length === 0) {
    els.playersMatrixTbody.innerHTML = `<tr><td colspan="${Math.max(2, games.length + 2)}" class="muted-text">No players found yet.</td></tr>`;
    return;
  }

  els.playersMatrixTbody.innerHTML = rows
    .map((row) => {
      const todayMedal =
        row.todayRank === 1 ? '🥇' : row.todayRank === 2 ? '🥈' : row.todayRank === 3 ? '🥉' : '';
      return `
      <tr class="${row.isViewer ? 'leaderboard-row-you' : ''}">
        <th scope="row" class="matrix-player-col">${renderPlayerIdentityHtml(row)}</th>
        <td class="num-col matrix-pts-cell tabular-nums"><strong>${todayMedal ? `${todayMedal} ` : ''}${escapeHtml(String(row.todayPoints ?? 0))} pts</strong></td>
        ${games
          .map((g) => {
            const cell = row.cells?.[g.slug] || null;
            if (row.isViewer && !cell && !g.viewerHasGame) {
              const isBusy = state.subscribingSlugs.has(g.slug);
              return `<td class="matrix-cell"><button type="button" class="btn btn-ghost btn-xs matrix-add-btn" data-action="subscribe-catalog-game" data-slug="${escapeHtml(g.slug)}" title="Add ${escapeHtml(g.name)} to your Today shelf" ${isBusy ? 'disabled' : ''}>${g.viewerArchivedGame ? '↺ Restore' : '＋ Add'}</button></td>`;
            }
            return renderMatrixCellHtml(cell);
          })
          .join('')}
      </tr>
    `;
    })
    .join('');
}

const LEADERBOARD_CACHE_MAX = 12;

function getLeaderboardCacheKey(
  date = state.lbDate,
  live = date === state.todayStr,
  days = state.lbDays
) {
  return `${date}|${live ? 1 : 0}|${days}`;
}

function setLeaderboardCache(key, resp) {
  if (!key || !resp) return;
  if (state.leaderboardCache.has(key)) {
    state.leaderboardCache.delete(key);
  }
  state.leaderboardCache.set(key, resp);
  while (state.leaderboardCache.size > LEADERBOARD_CACHE_MAX) {
    const oldestKey = state.leaderboardCache.keys().next().value;
    if (oldestKey === undefined) break;
    state.leaderboardCache.delete(oldestKey);
  }
}

function invalidateLeaderboardCache() {
  state.leaderboardCache.clear();
  state.leaderboardPrefetch = null;
  if (state.activeTab !== 'leaderboard') {
    state.leaderboardResponse = null;
  }
}

function resolveGameBoardFromResponse(resp, slug, difficulty = 'all') {
  if (!resp) return null;
  const targetSlug = slug || resp.selectedGameSlug || resp.gameBoard?.game?.slug;
  const entry = targetSlug ? resp?.gameBoardsBySlug?.[targetSlug] : null;
  if (!entry) return null;
  if (!difficulty || difficulty === 'all') {
    return { game: entry.game, standings: entry.standings };
  }
  if (entry.byDifficulty?.[difficulty]) {
    return entry.byDifficulty[difficulty];
  }
  if (
    targetSlug === resp?.selectedGameSlug &&
    resp?.gameBoard?.game?.filters?.difficulty === difficulty
  ) {
    return resp.gameBoard;
  }
  return null;
}

function setLeaderboardAriaBusy(busy) {
  for (const el of [els.overallStandingsCard, els.todayMatrixCard, els.gamewiseLeaderboardCard]) {
    if (!el) continue;
    if (busy) {
      el.setAttribute('aria-busy', 'true');
    } else {
      el.removeAttribute('aria-busy');
    }
  }
}

function scheduleLeaderboardPrefetch() {
  if (!state.user) return;
  const runPrefetch = () => {
    if (!state.user) return;
    const live = state.lbDate === state.todayStr;
    const cacheKey = getLeaderboardCacheKey(state.lbDate, live, state.lbDays);
    if (
      state.leaderboardCache.has(cacheKey) ||
      state.leaderboardPrefetch?.key === cacheKey ||
      state.isLoadingLeaderboard
    ) {
      return;
    }
    const viewerTz = live ? getViewerTimeZone() : undefined;
    const promise = api
      .getLeaderboard({
        date: state.lbDate,
        live,
        tz: viewerTz,
        days: state.lbDays === 0 ? 'all' : state.lbDays,
        gameSlug: state.lbSelectedGameSlug || undefined,
      })
      .then((resp) => {
        if (state.user && resp) {
          setLeaderboardCache(cacheKey, resp);
        }
        return resp;
      })
      .catch(() => null)
      .finally(() => {
        if (state.leaderboardPrefetch?.key === cacheKey) {
          state.leaderboardPrefetch = null;
        }
      });
    state.leaderboardPrefetch = { key: cacheKey, promise };
  };

  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(runPrefetch, { timeout: 1500 });
  } else {
    setTimeout(runPrefetch, 200);
  }
}

function renderGamewiseLeaderboard(resp) {
  const catalogGames = resp?.catalogGames || [];
  const requestedSlug =
    state.lbSelectedGameSlug ||
    resp?.selectedGameSlug ||
    resp?.gameBoard?.game?.slug ||
    catalogGames[0]?.slug ||
    null;
  const resolvedBoard = resolveGameBoardFromResponse(
    resp,
    requestedSlug,
    state.leaderboardDifficulty
  );
  const gameBoard = resolvedBoard || resp?.gameBoard || {};
  const selectedGame =
    gameBoard.game ||
    catalogGames.find((g) => g.slug === requestedSlug) ||
    catalogGames[0] ||
    null;
  const selectedSlug = selectedGame?.slug || requestedSlug;
  const selectedCatalogItem = catalogGames.find((g) => g.slug === selectedSlug) || null;

  if (els.lbGamePills) {
    els.lbGamePills.innerHTML = catalogGames
      .map((game) => {
        const selected = game.slug === selectedSlug;
        const color = normalizeHexColor(game.color);
        const onColor = getReadableTextColor(color);
        return `
          <button
            type="button"
            class="game-pill-btn${selected ? ' is-active' : ''}"
            data-slug="${escapeHtml(game.slug)}"
            style="--game-color:${escapeHtml(color)}; --game-on-color:${escapeHtml(onColor)};"
          >
            <span aria-hidden="true">${escapeHtml(game.icon || '🎮')}</span>
            <span>${escapeHtml(game.name)}</span>
          </button>
        `;
      })
      .join('');
  }

  if (els.lbGameHeader) {
    if (!selectedGame) {
      els.lbGameHeader.innerHTML = `
        <div class="lb-empty-scope">
          <p class="muted-text">No competitive games selected for Leaderboard.</p>
          <button type="button" class="btn btn-primary btn-xs" data-action="go-manage-games">Choose Competing Games in My Games</button>
        </div>
      `;
    } else {
      const color = normalizeHexColor(selectedGame.color);
      const onColor = getReadableTextColor(color);
      const safeUrl = isSafeHttpUrl(selectedGame.url);
      const isBusy = state.subscribingSlugs.has(selectedGame.slug);
      els.lbGameHeader.innerHTML = `
        <div class="game-identity">
          <div class="game-icon-box" style="background:${escapeHtml(color)}; color:${escapeHtml(onColor)};" aria-hidden="true">${escapeHtml(selectedGame.icon || '🎮')}</div>
          <div class="game-title-wrap">
            <h3 class="section-title">${escapeHtml(selectedGame.name)}</h3>
            <div class="game-meta-line">
              <span class="pill pill-neutral">${escapeHtml(selectedGame.category || 'Daily')}</span>
              <span class="pill pill-neutral">${escapeHtml(selectedGame.metricLabel || 'Score')} · ${selectedGame.metricDirection === 'lower_is_better' ? 'Lower is better' : 'Higher is better'}</span>
            </div>
          </div>
        </div>
        <div class="lb-game-header-actions">
          ${
            !selectedGame.viewerHasGame
              ? `<button type="button" class="btn btn-primary btn-sm" data-action="subscribe-catalog-game" data-slug="${escapeHtml(selectedGame.slug)}" ${isBusy ? 'disabled' : ''}>${selectedGame.viewerArchivedGame ? '↺ Restore to My Shelf' : '＋ Add to My Shelf'}</button>`
              : ''
          }
          ${
            safeUrl
              ? `<a class="btn btn-secondary btn-sm" href="${escapeHtml(selectedGame.url)}" target="_blank" rel="noopener noreferrer">Open Game ↗</a>`
              : ''
          }
        </div>
      `;
    }
  }

  const hasLbDiffOptions =
    Array.isArray(selectedGame?.difficultyOptions) && selectedGame.difficultyOptions.length > 0;
  const supportsLbDiff = Boolean(
    selectedGame?.supportsDifficulty ||
      selectedCatalogItem?.supportsDifficulty ||
      hasLbDiffOptions ||
      gameSupportsDifficulty(selectedGame || selectedCatalogItem)
  );
  const lbDiffOptions = hasLbDiffOptions
    ? selectedGame.difficultyOptions
    : supportsLbDiff
      ? CLUES_BY_SAM_DIFFICULTIES.map((d) => ({ value: d, label: d }))
      : [];
  const activeLbDiff =
    getCanonicalDifficulty(selectedGame?.filters?.difficulty ?? resp?.filters?.difficulty) ||
    state.leaderboardDifficulty ||
    'all';
  if (supportsLbDiff && activeLbDiff !== 'all' && state.leaderboardDifficulty !== activeLbDiff) {
    state.leaderboardDifficulty = activeLbDiff;
  }
  renderDifficultyFilterBar(els.lbDifficultyBar, {
    selectedDifficulty: supportsLbDiff ? state.leaderboardDifficulty : 'all',
    options: lbDiffOptions,
    visible: supportsLbDiff,
    label: 'Difficulty',
  });

  renderTableSortHeaders(els.playersGameTable, state.lbGameSortKey, state.lbGameSortDir);

  if (!els.playersGameTbody) return;
  const rawStandings = gameBoard.standings || [];
  if (rawStandings.length === 0) {
    els.playersGameTbody.innerHTML =
      '<tr><td colspan="8" class="muted-text">No player stats available for this game yet.</td></tr>';
    return;
  }

  const isCluesSelected = safeIsCluesBySamGame(selectedGame);
  const sortedRows = sortGamewiseStandings(
    rawStandings,
    state.lbGameSortKey,
    state.lbGameSortDir,
    selectedGame
  );

  els.playersGameTbody.innerHTML = sortedRows
    .map(({ player, displayRank }) => {
      const streak = player.currentStreak || 0;
      const pbAccHtml =
        isCluesSelected && player.personalBestAccuracySummary
          ? `<div class="cell-accuracy-line muted-text tabular-nums">${escapeHtml(player.personalBestAccuracySummary)}</div>`
          : '';
      return `
        <tr class="${player.isViewer ? 'leaderboard-row-you' : ''}">
          <td class="rank-cell">${escapeHtml(formatRankDisplay(displayRank))}</td>
          <td>${renderPlayerIdentityHtml(player)}</td>
          <td class="num-col tabular-nums"><strong>${escapeHtml(String(player.gamePoints ?? 0))} pts</strong></td>
          <td>${renderGameTodayCellHtml(player.today || null)}</td>
          <td class="num-col tabular-nums">${escapeHtml(player.averageDisplay || '—')}</td>
          <td class="num-col tabular-nums">
            <div class="today-cell-stack">
              <strong>${escapeHtml(player.personalBestDisplay || '—')}</strong>
              ${pbAccHtml}
            </div>
          </td>
          <td class="num-col tabular-nums">${streak > 0 ? `🔥 ${escapeHtml(String(streak))}d` : '—'}</td>
          <td class="num-col tabular-nums">${escapeHtml(String(player.totalPlayed ?? 0))}</td>
        </tr>
      `;
    })
    .join('');
}

function renderLeaderboardView() {
  renderLeaderboardControls();
  const resp = state.leaderboardResponse;
  if (!resp) return;

  if (els.lbCompetingScopeChip) {
    const competingCount = resp.competingGamesCount ?? (resp.catalogGames || []).length;
    els.lbCompetingScopeChip.innerHTML = `
      <span>🏆 Competing in <strong class="tabular-nums">${escapeHtml(String(competingCount))}</strong> ${competingCount === 1 ? 'game' : 'games'}</span>
      <button type="button" class="btn btn-ghost btn-xs" data-action="go-manage-games">Change in My Games</button>
    `;
    setHidden(els.lbCompetingScopeChip, false);
  }

  if (els.overallStandingsTitle) {
    els.overallStandingsTitle.textContent =
      state.lbDays === 1
        ? state.lbDate === state.todayStr
          ? "Today's Overall Standings"
          : `${formatPrettyDate(state.lbDate, state.todayStr)} Standings`
        : 'Overall Standings';
  }

  if (els.leaderboardPlayersSubtitle) {
    const totalPlayers = resp.totalPlayers ?? resp.overallStandings?.length ?? 0;
    const windowLabel =
      state.lbDays === 0
        ? 'All time'
        : state.lbDays === 1
          ? state.lbDate === state.todayStr
            ? "Today's ranking"
            : '1-day ranking'
          : `Last ${state.lbDays} days`;
    const dateLabel =
      state.lbDate === state.todayStr ? 'Live active cycles' : formatPrettyDate(state.lbDate, state.todayStr);
    els.leaderboardPlayersSubtitle.textContent = `${totalPlayers} ${totalPlayers === 1 ? 'player' : 'players'} · ${windowLabel} · ${dateLabel}`;
  }

  renderOverallStandings(resp);
  renderTodayMatrix(resp);
  renderGamewiseLeaderboard(resp);
}

async function loadAndRenderLeaderboardView({ forceRefresh = false } = {}) {
  if (!state.user) return;
  state.todayStr = getLocalDateString();
  const reqId = ++leaderboardRequestSeq;
  const live = state.lbDate === state.todayStr;
  const viewerTz = live ? getViewerTimeZone() : undefined;
  const cacheKey = getLeaderboardCacheKey(state.lbDate, live, state.lbDays);

  renderLeaderboardControls();

  if (forceRefresh) {
    state.leaderboardCache.clear();
  } else {
    if (
      state.leaderboardPrefetch?.key === cacheKey &&
      !state.leaderboardCache.has(cacheKey) &&
      state.leaderboardDifficulty === 'all'
    ) {
      try {
        await state.leaderboardPrefetch.promise;
      } catch {
        // Fallback to direct request below
      }
      if (reqId !== leaderboardRequestSeq || !state.user) return;
    }

    const cached = state.leaderboardCache.get(cacheKey);
    const hasRequestedGame =
      !state.lbSelectedGameSlug ||
      Boolean(cached?.gameBoardsBySlug?.[state.lbSelectedGameSlug]) ||
      cached?.selectedGameSlug === state.lbSelectedGameSlug;
    const hasRequestedDifficulty =
      state.leaderboardDifficulty === 'all' ||
      Boolean(
        resolveGameBoardFromResponse(
          cached,
          state.lbSelectedGameSlug || cached?.selectedGameSlug,
          state.leaderboardDifficulty
        )
      );

    if (cached && hasRequestedGame && hasRequestedDifficulty) {
      state.leaderboardResponse = cached;
      if (!state.lbSelectedGameSlug && cached?.selectedGameSlug) {
        state.lbSelectedGameSlug = cached.selectedGameSlug;
      }
      renderLeaderboardView();
      return;
    }
  }

  state.isLoadingLeaderboard = true;
  setLeaderboardAriaBusy(true);
  if (els.btnLbRefresh) {
    els.btnLbRefresh.disabled = true;
  }

  try {
    const resp = await api.getLeaderboard({
      date: state.lbDate,
      live,
      tz: viewerTz,
      days: state.lbDays === 0 ? 'all' : state.lbDays,
      gameSlug: state.lbSelectedGameSlug || undefined,
      difficulty:
        state.leaderboardDifficulty && state.leaderboardDifficulty !== 'all'
          ? state.leaderboardDifficulty
          : undefined,
    });
    if (reqId !== leaderboardRequestSeq || !state.user) return;
    state.leaderboardResponse = resp;
    if (
      resp &&
      (!state.leaderboardDifficulty || state.leaderboardDifficulty === 'all' || resp.gameBoardsBySlug)
    ) {
      setLeaderboardCache(cacheKey, resp);
    }
    if (resp?.selectedGameSlug && !state.lbSelectedGameSlug) {
      state.lbSelectedGameSlug = resp.selectedGameSlug;
    }
    renderLeaderboardView();
  } catch (err) {
    if (reqId === leaderboardRequestSeq) {
      showToast(`Failed to load leaderboard: ${err.message}`, { variant: 'error' });
    }
  } finally {
    if (reqId === leaderboardRequestSeq) {
      state.isLoadingLeaderboard = false;
      setLeaderboardAriaBusy(false);
      if (els.btnLbRefresh) {
        els.btnLbRefresh.disabled = false;
      }
    }
  }
}

async function handleLeaderboardDateChange(nextDate) {
  if (!nextDate) return;
  state.todayStr = getLocalDateString();
  state.lbDate = nextDate;
  await loadAndRenderLeaderboardView();
}

function selectLeaderboardGameSlug(slug) {
  if (!slug || state.lbSelectedGameSlug === slug) return;
  state.lbSelectedGameSlug = slug;
  state.leaderboardDifficulty = 'all';
  if (
    state.lbGameSortKey === 'today' ||
    state.lbGameSortKey === 'average' ||
    state.lbGameSortKey === 'best'
  ) {
    const nextGame = state.leaderboardResponse?.catalogGames?.find((g) => g.slug === slug);
    if (nextGame) {
      state.lbGameSortDir = getDefaultGameSortDir(state.lbGameSortKey, nextGame.metricDirection);
    }
  }

  const instantBoard = resolveGameBoardFromResponse(state.leaderboardResponse, slug, 'all');
  if (instantBoard) {
    els.playersMatrixThead
      ?.querySelectorAll('.matrix-game-head-btn[data-slug]')
      .forEach((btn) => {
        btn.classList.toggle('is-selected', btn.dataset.slug === slug);
      });
    renderGamewiseLeaderboard(state.leaderboardResponse);
    return;
  }

  loadAndRenderLeaderboardView();
}

// ---------- Stats View ----------

function selectStatsGame(gameId, { reload = false } = {}) {
  const nextId = Number(gameId);
  if (!Number.isFinite(nextId)) return;
  if (Number(state.selectedStatsGameId) !== nextId) {
    state.selectedStatsGameId = nextId;
    state.statsDifficulty = 'all';
  }
  if (reload) {
    loadAndRenderStatsView({ includeGlobal: false });
  }
}

function syncStatsLeaderboardSelection() {
  if (!els.leaderboardTbody) return;
  els.leaderboardTbody.querySelectorAll('tr[data-game-id]').forEach((tr) => {
    tr.classList.toggle(
      'is-selected',
      Number(tr.dataset.gameId) === Number(state.selectedStatsGameId)
    );
  });
}

async function loadAndRenderStatsView({ includeGlobal = true } = {}) {
  const activeGames = getActiveGames();
  const prevId = state.selectedStatsGameId;
  const selected =
    getGameById(state.selectedStatsGameId) || activeGames[0] || state.games[0] || null;
  if (selected) {
    if (Number(prevId) !== Number(selected.id)) {
      state.statsDifficulty = 'all';
    }
    state.selectedStatsGameId = selected.id;
  } else {
    state.statsDifficulty = 'all';
  }

  renderStatsGamePills();
  renderStatsWindowButtons();

  if (state.games.length > 0 && !state.entriesLoaded) {
    try {
      state.statsResponse = await api.getStats({
        gameId: selected?.id ?? undefined,
        days: state.statsDays === 0 ? 'all' : state.statsDays,
        difficulty:
          state.statsDifficulty && state.statsDifficulty !== 'all'
            ? state.statsDifficulty
            : undefined,
      });
      renderStatsViewContent({ includeGlobal: true });
    } catch (err) {
      showToast(`Failed to load stats: ${err.message}`, { variant: 'error' });
    }
    return;
  }

  state.todayStr = getLocalDateString();
  const referenceDate = state.todayStr;
  const daysVal = state.statsDays === 0 ? null : state.statsDays;
  const diffVal =
    state.statsDifficulty && state.statsDifficulty !== 'all' ? state.statsDifficulty : null;
  const gameEntries = selected
    ? state.allEntries.filter((e) => e.gameId === selected.id)
    : [];
  const gameStats = selected
    ? computeGameStats(selected, gameEntries, {
        days: daysVal,
        referenceDate,
        difficulty: diffVal,
      })
    : null;

  const needGlobal =
    includeGlobal || !state.statsResponse?.heatmap || !state.statsResponse?.leaderboard;

  if (needGlobal) {
    state.statsResponse = {
      heatmap: computeHeatmap(state.games, state.allEntries, referenceDate, 91),
      leaderboard: computeLeaderboard(state.games, state.allEntries, referenceDate),
      gameStats,
    };
    renderStatsViewContent({ includeGlobal: true });
  } else {
    state.statsResponse = {
      ...state.statsResponse,
      gameStats,
    };
    renderStatsViewContent({ includeGlobal: false });
  }
}

function renderStatsViewContent({ includeGlobal = true } = {}) {
  if (includeGlobal) {
    renderHeatmapSection();
    renderLeaderboard();
  } else {
    syncStatsLeaderboardSelection();
  }
  renderStatsGamePills();
  renderStatsWindowButtons();
  renderStatsGameDetail();
}

function renderHeatmapSection() {
  if (!els.activityHeatmapContainer) return;
  const days = state.statsResponse?.heatmap || [];

  renderActivityHeatmap(els.activityHeatmapContainer, {
    days,
    selectedDate: state.selectedHeatmapDate,
    onSelectDate: (day) => {
      const dateStr = typeof day === 'string' ? day : day?.date;
      if (!dateStr) return;
      state.selectedHeatmapDate = state.selectedHeatmapDate === dateStr ? null : dateStr;
      renderHeatmapSection();
    },
  });

  setHidden(els.btnClearHeatmapDay, !state.selectedHeatmapDate);
  setHidden(els.heatmapDayDetail, !state.selectedHeatmapDate);

  if (els.heatmapDayDetail) {
    if (!state.selectedHeatmapDate) {
      els.heatmapDayDetail.innerHTML = '';
    } else {
      const matchedDay = days.find((d) => d.date === state.selectedHeatmapDate);
      const dayGames = matchedDay?.games || [];
      const totalActive = matchedDay?.totalActive ?? getActiveGames().length;
      els.heatmapDayDetail.innerHTML = `
        <div class="heatmap-day-detail-head">
          <strong>${escapeHtml(formatPrettyDate(state.selectedHeatmapDate))} (${escapeHtml(state.selectedHeatmapDate)}) · ${dayGames.length} / ${totalActive} played</strong>
          <button type="button" class="btn btn-secondary btn-xs" data-action="jump-heatmap-date" data-date="${escapeHtml(state.selectedHeatmapDate)}">Open in Today View →</button>
        </div>
        <div class="heatmap-day-chips">
          ${
            dayGames.length === 0
              ? `<span class="muted-text">No games logged on this date.</span>`
              : dayGames
                  .map(
                    (item) =>
                      `<span class="pill pill-neutral">${escapeHtml(item.icon || '🎮')} ${escapeHtml(item.name)}: <strong class="tabular-nums">${escapeHtml(item.displayValue || 'Played')}</strong></span>`
                  )
                  .join('')
          }
        </div>
      `;
    }
  }
}

function renderLeaderboard() {
  if (!els.leaderboardTbody) return;
  const rows = state.statsResponse?.leaderboard || [];
  if (rows.length === 0) {
    els.leaderboardTbody.innerHTML = `<tr><td colspan="6" class="muted-text">Add games to see your roster leaderboard.</td></tr>`;
    return;
  }

  els.leaderboardTbody.innerHTML = rows
    .map((row) => {
      const color = normalizeHexColor(row.color);
      const onColor = getReadableTextColor(color);
      const selectedCls = Number(state.selectedStatsGameId) === Number(row.gameId) ? ' is-selected' : '';
      return `
        <tr class="leaderboard-row${selectedCls}" data-game-id="${escapeHtml(row.gameId)}">
          <td>
            <div class="game-identity">
              <span class="game-icon-box game-icon-box-sm" style="background:${escapeHtml(color)}; color:${escapeHtml(onColor)};" aria-hidden="true">${escapeHtml(row.icon || '🎮')}</span>
              <span class="game-name">${escapeHtml(row.name)}</span>
            </div>
          </td>
          <td class="num-col">${row.totalPlayed ?? 0}</td>
          <td class="num-col">${row.currentStreak > 0 ? `🔥 ${row.currentStreak}d` : '—'}</td>
          <td class="num-col">${row.longestStreak > 0 ? `${row.longestStreak}d` : '—'}</td>
          <td class="num-col">${row.completionRate30d ?? 0}%</td>
          <td class="num-col"><strong>${escapeHtml(row.personalBestDisplay || '—')}</strong></td>
        </tr>
      `;
    })
    .join('');
}

function renderStatsGamePills() {
  if (!els.statsGamePills) return;
  const visibleGames = state.games.filter(
    (g) => !g.archived || Number(g.id) === Number(state.selectedStatsGameId)
  );
  if (visibleGames.length === 0) {
    els.statsGamePills.innerHTML = '';
    return;
  }

  els.statsGamePills.innerHTML = visibleGames
    .map((game) => {
      const selected = Number(game.id) === Number(state.selectedStatsGameId);
      const color = normalizeHexColor(game.color);
      const onColor = getReadableTextColor(color);
      return `
        <button
          type="button"
          class="game-pill-btn${selected ? ' is-active' : ''}"
          data-game-id="${escapeHtml(game.id)}"
          style="--game-color:${escapeHtml(color)}; --game-on-color:${escapeHtml(onColor)};"
        >
          <span aria-hidden="true">${escapeHtml(game.icon || '🎮')}</span>
          <span>${escapeHtml(game.name)}${game.archived ? ' (Archived)' : ''}</span>
        </button>
      `;
    })
    .join('');
}

function renderStatsWindowButtons() {
  if (!els.statsWindowGroup) return;
  els.statsWindowGroup.querySelectorAll('.seg-btn[data-days]').forEach((btn) => {
    const raw = btn.dataset.days;
    const days = raw === 'all' ? 0 : Number(raw || 30);
    const active = days === state.statsDays;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function renderStatsGameDetail() {
  const gameStats = state.statsResponse?.gameStats;
  const game = gameStats?.game || getGameById(state.selectedStatsGameId);
  if (!game) {
    renderDifficultyFilterBar(els.statsDifficultyBar, { visible: false });
    if (els.statsGameHeader) {
      els.statsGameHeader.innerHTML = '<p class="muted-text">Add a game to explore its charts.</p>';
    }
    if (els.statsKpisGrid) els.statsKpisGrid.innerHTML = '';
    if (els.historyTbody) {
      els.historyTbody.innerHTML = `<tr><td colspan="6" class="muted-text">No games added yet.</td></tr>`;
    }
    if (els.btnReparseGame) els.btnReparseGame.disabled = true;
    return;
  }

  if (els.btnReparseGame) els.btnReparseGame.disabled = false;
  const color = normalizeHexColor(game.color);
  const onColor = getReadableTextColor(color);
  const safeUrl = isSafeHttpUrl(game.url);

  const hasDiffOptions =
    Array.isArray(gameStats?.difficultyOptions) && gameStats.difficultyOptions.length > 0;
  const supportsDiff = Boolean(
    gameStats?.supportsDifficulty || hasDiffOptions || gameSupportsDifficulty(game)
  );
  const diffOptions = hasDiffOptions
    ? gameStats.difficultyOptions
    : supportsDiff
      ? CLUES_BY_SAM_DIFFICULTIES.map((d) => ({ value: d, label: d }))
      : [];
  const activeDiff =
    getCanonicalDifficulty(gameStats?.filters?.difficulty) || state.statsDifficulty || 'all';
  if (supportsDiff && activeDiff !== 'all' && state.statsDifficulty !== activeDiff) {
    state.statsDifficulty = activeDiff;
  }
  renderDifficultyFilterBar(els.statsDifficultyBar, {
    selectedDifficulty: supportsDiff ? state.statsDifficulty : 'all',
    options: diffOptions,
    visible: supportsDiff,
    label: 'Difficulty',
  });

  if (els.statsGameHeader) {
    els.statsGameHeader.innerHTML = `
      <div class="game-identity">
        <div class="game-icon-box" style="background:${escapeHtml(color)}; color:${escapeHtml(onColor)};" aria-hidden="true">${escapeHtml(game.icon || '🎮')}</div>
        <div class="game-title-wrap">
          <h3 class="section-title">${escapeHtml(game.name)}</h3>
          <div class="game-meta-line">
            <span class="pill pill-neutral">${escapeHtml(game.category || 'Daily')}</span>
            <span class="pill pill-neutral">${escapeHtml(game.metricLabel || 'Score')} · ${game.metricDirection === 'lower_is_better' ? 'Lower is better' : 'Higher is better'}</span>
          </div>
        </div>
      </div>
      ${
        safeUrl
          ? `<a class="btn btn-secondary btn-sm" href="${escapeHtml(game.url)}" target="_blank" rel="noopener noreferrer">Open Game ↗</a>`
          : ''
      }
    `;
  }

  const kpis = gameStats?.kpis || {};
  const pbDisplay = kpis.personalBest?.displayValue || '—';
  const pbSub =
    safeIsCluesBySamGame(game) && kpis.personalBest?.accuracySummary
      ? [kpis.personalBest.accuracySummary, kpis.personalBest.playDate].filter(Boolean).join(' · ')
      : kpis.personalBest?.playDate || 'No numeric score yet';
  const kpiCards = [
    { label: 'Total Plays', val: String(kpis.totalPlayed ?? 0), sub: 'Completed in window' },
    {
      label: 'Solve Rate',
      val: kpis.winRate !== null && kpis.winRate !== undefined ? `${kpis.winRate}%` : '—',
      sub: kpis.winRate !== null && kpis.winRate !== undefined ? `${kpis.solvedCount ?? 0} solved` : 'Open score',
    },
    { label: 'Current Streak', val: kpis.currentStreak > 0 ? `🔥 ${kpis.currentStreak}d` : '0d', sub: 'All-time active' },
    { label: 'Longest Streak', val: kpis.longestStreak > 0 ? `${kpis.longestStreak}d` : '0d', sub: 'Best streak' },
    { label: 'Average', val: kpis.averageDisplay || '—', sub: game.metricLabel || 'Score' },
    { label: 'Median', val: kpis.medianDisplay || '—', sub: game.metricLabel || 'Score' },
    {
      label: `Best ${game.metricLabel || 'Score'}`,
      val: pbDisplay,
      sub: pbSub,
    },
  ];

  if (els.statsKpisGrid) {
    els.statsKpisGrid.innerHTML = kpiCards
      .map(
        (item) => `
        <div class="stat-kpi-box">
          <div class="stat-kpi-label">${escapeHtml(item.label)}</div>
          <div class="stat-kpi-val">${escapeHtml(item.val)}</div>
          <div class="stat-kpi-sub">${escapeHtml(item.sub)}</div>
        </div>
      `
      )
      .join('');
  }

  const entries = gameStats?.entries || [];

  if (els.trendChartContainer) {
    renderTrendChart(els.trendChartContainer, {
      points: gameStats?.trendSeries || [],
      metricFormat: game.metricFormat,
      metricDirection: game.metricDirection,
      metricLabel: game.metricLabel || 'Score',
      accentColor: color,
      onSelectPoint: (point) => {
        const match = entries.find((e) => e.playDate === point?.playDate);
        if (match) {
          openEntryModal(game.id, match.id);
        }
      },
    });
  }

  if (els.distributionChartContainer) {
    renderDistributionChart(els.distributionChartContainer, {
      buckets: gameStats?.distribution || [],
      metricFormat: game.metricFormat,
      accentColor: color,
    });
  }

  if (els.breakdownChartContainer) {
    const diffSummary = Array.isArray(gameStats?.difficultySummary)
      ? gameStats.difficultySummary
      : [];
    const standardBreakdown = Array.isArray(gameStats?.breakdownSummary)
      ? gameStats.breakdownSummary
      : [];
    const useDifficultyBreakdown =
      diffSummary.length > 0 &&
      (state.statsDifficulty === 'all' || standardBreakdown.length === 0);

    renderBreakdownChart(els.breakdownChartContainer, {
      breakdownSummary: useDifficultyBreakdown ? diffSummary : standardBreakdown,
      latestDate: entries[0]?.playDate || null,
      accentColor: color,
      metricFormat: game.metricFormat,
      headerTitle:
        useDifficultyBreakdown || supportsDiff
          ? 'Solve Time by Difficulty'
          : 'Round / Category Breakdown',
      subtitle: useDifficultyBreakdown
        ? state.statsDifficulty === 'all'
          ? 'Average solve time per tier (latest & personal best)'
          : `Filtered trend & KPIs: ${state.statsDifficulty}`
        : undefined,
      emptyMessage: supportsDiff
        ? 'Log Clues by Sam puzzles with a difficulty tag to compare solve times.'
        : undefined,
    });
  }

  if (els.historyCountLabel) {
    els.historyCountLabel.textContent = `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`;
  }

  if (els.historyTbody) {
    if (entries.length === 0) {
      els.historyTbody.innerHTML = `<tr><td colspan="6" class="muted-text">No results logged in this window yet.</td></tr>`;
    } else {
      els.historyTbody.innerHTML = entries
        .map((entry) => {
          const status = computeStatusMeta(entry);
          const difficulty = getEntryDifficulty(entry);
          const diffBadgeHtml = difficulty
            ? renderDifficultyBadgeHtml(difficulty, { compact: true })
            : '';
          const cluesAcc = safeIsCluesBySamGame(game) ? safeGetCluesBySamAccuracy(entry) : null;
          const accBadgeHtml = cluesAcc?.accuracySummary
            ? `<span class="pill ${cluesAcc.isPerfect ? 'pill-success' : 'pill-neutral'} tabular-nums">${escapeHtml(cluesAcc.accuracySummary)}</span>`
            : '';
          const showRoundChips = shouldShowRoundChips(
            entry.breakdown,
            entry.parserId || game.resolvedParser?.id || game.parserId
          );
          const historyGrid = getEntryShareGrid(entry);
          const snippet = entry.notes || entry.rawText?.split('\n')[0] || '';
          return `
            <tr data-entry-id="${escapeHtml(entry.id)}">
              <td class="tabular-nums">${escapeHtml(entry.playDate)}</td>
              <td class="tabular-nums">${entry.puzzleId ? escapeHtml(entry.puzzleId) : '—'}</td>
              <td><strong class="tabular-nums">${escapeHtml(formatEntryResult(entry, game))}</strong></td>
              <td>
                <div class="history-status-cell">
                  <span class="pill ${status.pillClass}">${escapeHtml(status.label)}</span>
                  ${diffBadgeHtml}
                  ${accBadgeHtml}
                </div>
              </td>
              <td>
                <div class="snippet-cell" title="${escapeHtml(entry.rawText || entry.notes || '')}">${escapeHtml(snippet || '—')}</div>
                ${
                  showRoundChips
                    ? `<div class="history-rounds-strip">${renderRoundChipsHtml(entry.breakdown, { compact: true })}</div>`
                    : ''
                }
                ${
                  historyGrid
                    ? `<details class="share-grid-details history-grid-details"><summary>Grid</summary><pre class="share-grid-pre">${escapeHtml(historyGrid)}</pre></details>`
                    : ''
                }
              </td>
              <td class="actions-col">
                <button type="button" class="btn btn-ghost btn-xs" data-action="edit-history-entry" data-entry-id="${escapeHtml(entry.id)}" data-game-id="${escapeHtml(game.id)}">Edit</button>
                <button type="button" class="btn btn-danger-ghost btn-xs" data-action="delete-history-entry" data-entry-id="${escapeHtml(entry.id)}">Delete</button>
              </td>
            </tr>
          `;
        })
        .join('');
    }
  }
}

async function handleReparseGame() {
  const game = getGameById(state.selectedStatsGameId);
  if (!game) return;

  try {
    const result = await api.reparseGame(game.id, { force: true });
    invalidateLeaderboardCache();
    await refreshBootstrapAndEntries();
    await loadAndRenderStatsView();
    const updatedCount = result?.updatedCount ?? result?.updated ?? 0;
    showToast(`Re-parsed ${updatedCount} ${game.name} entries.`, { variant: 'success' });
  } catch (err) {
    showToast(`Re-parse failed: ${err.message}`, { variant: 'error' });
  }
}

// ---------- My Games & Parser Lab View ----------

function renderGamesAdminView() {
  populateGameSelects();

  if (els.rosterCompeteBar) {
    const activeGames = state.games.filter((g) => !g.archived);
    const activeCount = activeGames.length;
    const competingCount = activeGames.filter((g) => g.compete !== false).length;
    if (activeCount === 0) {
      els.rosterCompeteBar.innerHTML = '';
      setHidden(els.rosterCompeteBar, true);
    } else {
      els.rosterCompeteBar.innerHTML = `
        <span class="roster-compete-summary tabular-nums">🏆 Competing in <strong>${escapeHtml(String(competingCount))}</strong> of <strong>${escapeHtml(String(activeCount))}</strong> active ${activeCount === 1 ? 'game' : 'games'}</span>
        <div class="roster-compete-actions">
          <button type="button" class="btn btn-secondary btn-xs" data-action="compete-all-games" ${competingCount === activeCount ? 'disabled' : ''}>Compete All</button>
          <button type="button" class="btn btn-ghost btn-xs" data-action="solo-all-games" ${competingCount === 0 ? 'disabled' : ''}>Solo All</button>
        </div>
      `;
      setHidden(els.rosterCompeteBar, false);
    }
  }

  if (els.manageGamesList) {
    if (state.games.length === 0) {
      els.manageGamesList.innerHTML = `<div class="empty-grid-card"><p class="muted-text">No games yet. Click "+ Add Game" to build your roster.</p></div>`;
    } else {
      els.manageGamesList.innerHTML = state.games
        .map((game, idx) => {
          const color = normalizeHexColor(game.color);
          const onColor = getReadableTextColor(color);
          const playsCount = getEntriesForGame(game.id).length;
          const domain = getGameDomainLabel(game.url) || game.url;
          const parserMeta = getParserMeta(game.resolvedParser?.id || game.parserId);
          const resetSummary = getResetScheduleSummary(game);
          const isCompeting = game.compete !== false;
          return `
            <div class="manage-game-item${game.archived ? ' is-archived' : ''}" data-game-id="${escapeHtml(game.id)}">
              <div class="manage-game-left">
                <div class="game-icon-box game-icon-box-sm" style="background:${escapeHtml(color)}; color:${escapeHtml(onColor)};" aria-hidden="true">${escapeHtml(game.icon || '🎮')}</div>
                <div class="game-title-wrap">
                  <div class="game-name">${escapeHtml(game.name)}</div>
                  <div class="game-meta-line">
                    <span class="pill pill-neutral">${escapeHtml(game.category || 'Daily')}</span>
                    <span class="muted-text tabular-nums">${escapeHtml(game.metricLabel || 'Score')} · ${playsCount} plays · ${escapeHtml(domain)}</span>
                    <span class="pill pill-neutral">${escapeHtml(parserMeta.name || game.parserId || 'Generic')}</span>
                    <span class="pill pill-neutral tabular-nums">🕒 ${escapeHtml(resetSummary)}</span>
                    ${!game.archived && !isCompeting ? '<span class="pill pill-neutral">Solo only</span>' : ''}
                    ${game.archived ? '<span class="pill pill-warning">Archived</span>' : ''}
                  </div>
                </div>
              </div>
              <div class="manage-game-actions">
                <button type="button" class="btn btn-secondary btn-xs" data-action="move-game-up" data-game-id="${escapeHtml(game.id)}" ${idx === 0 ? 'disabled' : ''} aria-label="Move ${escapeHtml(game.name)} up">↑</button>
                <button type="button" class="btn btn-secondary btn-xs" data-action="move-game-down" data-game-id="${escapeHtml(game.id)}" ${idx === state.games.length - 1 ? 'disabled' : ''} aria-label="Move ${escapeHtml(game.name)} down">↓</button>
                <button
                  type="button"
                  class="btn btn-xs compete-toggle-btn ${isCompeting ? 'is-competing' : 'is-solo'}"
                  data-action="toggle-compete-game"
                  data-game-id="${escapeHtml(game.id)}"
                  aria-pressed="${isCompeting ? 'true' : 'false'}"
                  aria-label="${escapeHtml(game.name)} leaderboard competition"
                  ${game.archived ? 'disabled' : ''}
                >${isCompeting ? '🏆 Competing' : 'Solo only'}</button>
                <button type="button" class="btn btn-secondary btn-xs" data-action="edit-game" data-game-id="${escapeHtml(game.id)}">Edit</button>
                <button type="button" class="btn btn-ghost btn-xs" data-action="toggle-archive-game" data-game-id="${escapeHtml(game.id)}">${game.archived ? 'Restore' : 'Archive'}</button>
                <button type="button" class="btn btn-danger-ghost btn-xs" data-action="delete-game" data-game-id="${escapeHtml(game.id)}">Delete</button>
              </div>
            </div>
          `;
        })
        .join('');
    }
  }

  renderFriendsCatalogShelf();
  renderParserWorkbench();
}

async function handleToggleCompeteGame(gameId, triggerBtn = null) {
  const game = getGameById(gameId);
  if (!game || game.archived) return;
  const nextCompete = game.compete === false;
  if (triggerBtn) triggerBtn.disabled = true;
  try {
    await api.updateGame(game.id, { compete: nextCompete });
    invalidateLeaderboardCache();
    await refreshBootstrapAndEntries();
    renderGamesAdminView();
    renderTodayView();
    if (state.activeTab === 'leaderboard') {
      await loadAndRenderLeaderboardView();
    }
    showToast(
      nextCompete
        ? `${game.name} is now competing on the Leaderboard.`
        : `${game.name} switched to Solo (kept on Today shelf).`,
      { variant: 'success' }
    );
  } catch (err) {
    showToast(`Failed to update competition setting: ${err.message}`, { variant: 'error' });
  } finally {
    if (triggerBtn && triggerBtn.isConnected) {
      triggerBtn.disabled = false;
    }
  }
}

async function handleBulkCompeteGames(targetCompete) {
  const targets = state.games.filter(
    (g) => !g.archived && (g.compete !== false) !== Boolean(targetCompete)
  );
  if (targets.length === 0) return;

  try {
    await Promise.all(
      targets.map((g) => api.updateGame(g.id, { compete: Boolean(targetCompete) }))
    );
    invalidateLeaderboardCache();
    await refreshBootstrapAndEntries();
    renderGamesAdminView();
    renderTodayView();
    if (state.activeTab === 'leaderboard') {
      await loadAndRenderLeaderboardView();
    }
    showToast(
      targetCompete
        ? 'All active games are now competing on the Leaderboard.'
        : 'All active games switched to Solo mode.',
      { variant: 'success' }
    );
  } catch (err) {
    showToast(`Failed to update games: ${err.message}`, { variant: 'error' });
  }
}

async function handleReorderGame(gameId, delta) {
  const idNum = Number(gameId);
  const index = state.games.findIndex((g) => g.id === idNum);
  if (index === -1) return;
  const targetIndex = index + delta;
  if (targetIndex < 0 || targetIndex >= state.games.length) return;

  const ids = state.games.map((g) => g.id);
  const [moved] = ids.splice(index, 1);
  ids.splice(targetIndex, 0, moved);

  try {
    await api.reorderGames(ids);
    invalidateLeaderboardCache();
    await refreshBootstrapAndEntries();
    renderGamesAdminView();
    renderTodayView();
  } catch (err) {
    showToast(`Failed to reorder: ${err.message}`, { variant: 'error' });
  }
}

async function handleToggleArchiveGame(gameId) {
  const game = getGameById(gameId);
  if (!game) return;
  try {
    await api.updateGame(game.id, { archived: !game.archived });
    invalidateLeaderboardCache();
    await refreshBootstrapAndEntries();
    renderGamesAdminView();
    renderTodayView();
    if (state.activeTab === 'stats') await loadAndRenderStatsView();
    showToast(game.archived ? `Restored ${game.name}.` : `Archived ${game.name}.`, {
      variant: 'success',
    });
  } catch (err) {
    showToast(`Failed to update archive status: ${err.message}`, { variant: 'error' });
  }
}

async function handleDeleteGame(gameId) {
  const game = getGameById(gameId);
  if (!game) return;
  const ok = await confirmAction({
    title: `Delete ${game.name}?`,
    message: `This removes ${game.name} and all its play history entries. You can export a JSON backup first if you want to keep a copy.`,
    okLabel: 'Delete Game',
  });
  if (!ok) return;

  try {
    await api.deleteGame(game.id);
    invalidateLeaderboardCache();
    await refreshBootstrapAndEntries();
    renderGamesAdminView();
    renderTodayView();
    if (state.activeTab === 'stats') await loadAndRenderStatsView();
    showToast(`Deleted ${game.name}.`, { variant: 'info' });
  } catch (err) {
    showToast(`Failed to delete game: ${err.message}`, { variant: 'error' });
  }
}

function renderParserWorkbench() {
  if (!els.workbenchGameSelect || !els.workbenchJsonOutput) return;
  const game = getGameById(els.workbenchGameSelect.value) || state.games[0];
  const sampleText = els.workbenchSampleText?.value || '';

  if (els.workbenchMetaStrip) {
    if (game) {
      const parserMeta = getParserMeta(game.resolvedParser?.id || game.parserId);
      const isCustom = Boolean(game.resolvedParser?.isCustomParser);
      els.workbenchMetaStrip.innerHTML = `
        <span class="pill ${isCustom ? 'pill-custom' : 'pill-generic'}">Parser: ${escapeHtml(parserMeta.name || game.parserId)}</span>
        <span class="pill pill-neutral">Metric: ${escapeHtml(game.metricLabel)} (${escapeHtml(game.metricFormat)}, ${escapeHtml(game.metricDirection)})</span>
      `;
    } else {
      els.workbenchMetaStrip.innerHTML = `<span class="muted-text">Add a game to test share-text parsing.</span>`;
    }
  }

  let outputObj;
  if (!sampleText.trim()) {
    outputObj = {
      hint: 'Paste sample share text above to inspect auto-detection and parser output.',
      selectedGame: game?.name || null,
      parserId: game?.resolvedParser?.id || game?.parserId || null,
    };
  } else {
    const autoDetected = detectGameAndParse(sampleText, getActiveGames());
    const forSelected = game ? parseForGame(sampleText, game) : null;
    outputObj = {
      autoDetect: {
        confidence: autoDetected.confidence,
        matchedGame: autoDetected.matchedGame?.name || null,
        parserId: autoDetected.parserId,
        parsed: autoDetected.parsed,
      },
      selectedGameParse: forSelected,
    };
  }

  const codeEl = els.workbenchJsonOutput.querySelector('code') || els.workbenchJsonOutput;
  codeEl.textContent = JSON.stringify(outputObj, null, 2);
}

async function handleCopyParserRequest() {
  const game = getGameById(els.workbenchGameSelect?.value) || state.games[0];
  const sample = els.workbenchSampleText?.value.trim() || '<paste sample result here>';
  const promptText = [
    `Create a custom Daily Games Hub parser for "${game?.name || 'New Game'}".`,
    game?.url ? `Game URL: ${game.url}` : '',
    game ? `Metric: ${game.metricLabel} (${game.metricFormat}, ${game.metricDirection})` : '',
    'Sample share result:',
    '```',
    sample,
    '```',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    await navigator.clipboard.writeText(promptText);
    showToast('Copied parser request prompt to clipboard!', { variant: 'success' });
  } catch {
    showToast('Clipboard permission unavailable — copy the sample manually.', { variant: 'warning' });
  }
}

async function handleExportJson() {
  try {
    const data = await api.exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `daily-games-backup-${state.todayStr}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Downloaded JSON backup.', { variant: 'success' });
  } catch (err) {
    showToast(`Export failed: ${err.message}`, { variant: 'error' });
  }
}

function handleImportFilePicked(event) {
  const file = event.target.files?.[0];
  if (!file) {
    state.pendingImportData = null;
    setHidden(els.importFileSummary, true);
    if (els.btnImportJson) els.btnImportJson.disabled = true;
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result || '{}'));
      const gCount = Array.isArray(parsed.games) ? parsed.games.length : 0;
      const eCount = Array.isArray(parsed.entries) ? parsed.entries.length : 0;
      state.pendingImportData = parsed;
      if (els.importFileSummary) {
        setHidden(els.importFileSummary, false);
        els.importFileSummary.textContent = `${file.name}: ${gCount} games, ${eCount} entries ready to import.`;
      }
      if (els.btnImportJson) els.btnImportJson.disabled = false;
    } catch {
      state.pendingImportData = null;
      if (els.importFileSummary) {
        setHidden(els.importFileSummary, false);
        els.importFileSummary.textContent = 'Invalid JSON file.';
      }
      if (els.btnImportJson) els.btnImportJson.disabled = true;
    }
  };
  reader.readAsText(file);
}

async function handleImportJson() {
  if (!state.pendingImportData) return;
  const modeInput = document.querySelector('input[name="import-mode"]:checked');
  const mode = modeInput?.value || 'merge';

  if (mode === 'replace') {
    const ok = await confirmAction({
      title: 'Replace All Data?',
      message: 'Replace mode overwrites all existing games and entries with this backup file.',
      okLabel: 'Replace Everything',
    });
    if (!ok) return;
  }

  try {
    await api.importData({ ...state.pendingImportData, mode });
    state.pendingImportData = null;
    if (els.importFileInput) els.importFileInput.value = '';
    setHidden(els.importFileSummary, true);
    if (els.btnImportJson) els.btnImportJson.disabled = true;

    invalidateLeaderboardCache();
    await refreshBootstrapAndEntries();
    renderTodayView();
    renderGamesAdminView();
    if (state.activeTab === 'leaderboard') {
      await loadAndRenderLeaderboardView();
    }
    showToast('Backup imported successfully!', { variant: 'success' });
  } catch (err) {
    showToast(`Import failed: ${err.message}`, { variant: 'error' });
  }
}

function getSignupCatalogItems() {
  if (Array.isArray(state.signupCatalog) && state.signupCatalog.length > 0) {
    return state.signupCatalog;
  }
  return [
    ...STARTER_GAMES.map((g) => ({ ...enrichGameMetadata(g), isFriendAdded: false, playerCount: 0 })),
    ...OPTIONAL_CATALOG_GAMES.map((g) => ({
      ...enrichGameMetadata(g),
      isFriendAdded: false,
      playerCount: 0,
    })),
  ];
}

function syncSignupPickerCounts(catalog = getSignupCatalogItems()) {
  const selected = state.signupSelectedSlugs;
  if (els.signupSelectedCount) {
    els.signupSelectedCount.textContent = `${selected.size} selected`;
  }
  const optionalItems = catalog.filter((g) => isOptionalCollectionItem(g));
  const optionalSelectedCount = optionalItems.filter((g) => selected.has(g.slug)).length;
  if (els.signupOptionalCount) {
    els.signupOptionalCount.textContent =
      optionalSelectedCount > 0
        ? `${optionalSelectedCount} selected · ${optionalItems.length} games`
        : `${optionalItems.length} games`;
  }
  els.signupGamesFieldset?.querySelectorAll('input[name="competingSlugs"]').forEach((input) => {
    const isChecked = selected.has(input.value);
    input.checked = isChecked;
    input.closest('.signup-game-chip')?.classList.toggle('is-checked', isChecked);
  });
}

function renderSignupGameChipHtml(item) {
  const checked = state.signupSelectedSlugs.has(item.slug);
  const isFriendPick =
    Boolean(item.isFriendAdded) || (!item.isStarter && !isOptionalCollectionItem(item));
  return `
    <label class="signup-game-chip${checked ? ' is-checked' : ''}">
      <input type="checkbox" name="competingSlugs" value="${escapeHtml(item.slug)}" ${checked ? 'checked' : ''} />
      <span class="signup-game-chip-icon" aria-hidden="true">${escapeHtml(item.icon || '🎮')}</span>
      <span class="signup-game-chip-name">${escapeHtml(item.name)}</span>
      ${isFriendPick ? '<span class="pill pill-accent signup-friend-badge">Friend\'s pick</span>' : ''}
    </label>
  `;
}

function renderSignupGamePicker() {
  if (!els.signupFeaturedGames || !els.signupOptionalBody) return;
  const catalog = getSignupCatalogItems();
  if (!state.signupPickerInitialized) {
    state.signupSelectedSlugs.clear();
    for (const item of catalog) {
      if (item.isStarter || !isOptionalCollectionItem(item) || item.isFriendAdded) {
        state.signupSelectedSlugs.add(item.slug);
      }
    }
    state.signupPickerInitialized = true;
  }

  const featured = catalog.filter((g) => !isOptionalCollectionItem(g));
  const magnitudleItems = catalog.filter(
    (g) => isOptionalCollectionItem(g) && getNormalizedCollectionKey(g) === 'magnitudle'
  );
  const flightqItems = catalog.filter(
    (g) => isOptionalCollectionItem(g) && getNormalizedCollectionKey(g) === 'flightq'
  );

  els.signupFeaturedGames.innerHTML = featured.map(renderSignupGameChipHtml).join('');

  const collections = [
    { key: 'magnitudle', label: '📏 Magnitudle', items: magnitudleItems },
    { key: 'flightq', label: '✈️ FlightQ Daily', items: flightqItems },
  ].filter((c) => c.items.length > 0);

  if (els.signupOptionalCollections) {
    setHidden(els.signupOptionalCollections, collections.length === 0);
  }
  els.signupOptionalBody.innerHTML = collections
    .map(
      (col) => `
      <div class="signup-optional-collection" data-signup-collection="${escapeHtml(col.key)}">
        <div class="signup-optional-col-head">
          <span class="signup-optional-col-title">${escapeHtml(col.label)} (${escapeHtml(String(col.items.length))})</span>
          <button type="button" class="btn btn-ghost btn-xs" data-action="signup-select-collection" data-collection="${escapeHtml(col.key)}">Select All</button>
        </div>
        <div class="signup-games-grid">
          ${col.items.map(renderSignupGameChipHtml).join('')}
        </div>
      </div>
    `
    )
    .join('');

  syncSignupPickerCounts(catalog);
}

function setAuthMode(mode) {
  const next = mode === 'signup' ? 'signup' : 'signin';
  state.authMode = next;

  const isSignUp = next === 'signup';
  els.authScreen?.classList.toggle('is-signup-mode', isSignUp);
  if (els.btnAuthModeSignin) {
    els.btnAuthModeSignin.classList.toggle('is-active', !isSignUp);
    els.btnAuthModeSignin.setAttribute('aria-pressed', !isSignUp ? 'true' : 'false');
  }
  if (els.btnAuthModeSignup) {
    els.btnAuthModeSignup.classList.toggle('is-active', isSignUp);
    els.btnAuthModeSignup.setAttribute('aria-pressed', isSignUp ? 'true' : 'false');
  }

  setHidden(els.signinForm, isSignUp);
  setHidden(els.signupForm, !isSignUp);
  setHidden(els.signinError, true);
  setHidden(els.signupError, true);
  if (isSignUp) {
    renderSignupGamePicker();
  }
}

function resetPasswordToggleButtons() {
  for (const btn of els.passwordToggleButtons || []) {
    const inputId = btn.dataset.togglePassword;
    const input = inputId ? $(inputId) : null;
    if (input) input.type = 'password';
    btn.textContent = 'Show';
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', 'Show password');
  }
}

function resetAuthForms({ keepEmail = false } = {}) {
  if (els.signinPassword) els.signinPassword.value = '';
  if (els.signupPassword) els.signupPassword.value = '';
  if (!keepEmail) {
    if (els.signinEmail) els.signinEmail.value = '';
    if (els.signupEmail) els.signupEmail.value = '';
    if (els.signupName) els.signupName.value = '';
  }
  setHidden(els.signinError, true);
  setHidden(els.signupError, true);
  if (els.signinError) els.signinError.textContent = '';
  if (els.signupError) els.signupError.textContent = '';
  resetPasswordToggleButtons();
}

function togglePasswordVisibility(btn) {
  const inputId = btn?.dataset?.togglePassword;
  const input = inputId ? $(inputId) : null;
  if (!input) return;
  const reveal = input.type === 'password';
  input.type = reveal ? 'text' : 'password';
  btn.textContent = reveal ? 'Hide' : 'Show';
  btn.setAttribute('aria-pressed', reveal ? 'true' : 'false');
  btn.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
}

function stopResetTicker() {
  if (state.resetTickerId !== null) {
    clearInterval(state.resetTickerId);
    state.resetTickerId = null;
  }
}

function enterUnauthenticatedState() {
  stopResetTicker();
  state.user = null;
  state.games = [];
  state.catalog = [];
  state.subscribingSlugs.clear();
  state.parsers = [];
  state.entriesForDate = [];
  state.allEntries = [];
  state.entriesLoaded = false;
  state.cardSummaries = {};
  state.dailyOverview = {
    activeGamesCount: 0,
    playedTodayCount: 0,
    routineStreak: 0,
    playedTodayInStreak: false,
    fullSweepDays: 0,
  };
  state.statsResponse = null;
  state.leaderboardResponse = null;
  state.leaderboardCache.clear();
  state.leaderboardPrefetch = null;
  state.lbSelectedGameSlug = null;
  state.lbOverallSortKey = 'points';
  state.lbOverallSortDir = 'desc';
  state.lbGameSortKey = 'points';
  state.lbGameSortDir = 'desc';
  state.leaderboardDifficulty = 'all';
  state.lbDays = 30;
  state.isLoadingLeaderboard = false;
  state.lastOpenedGameId = null;
  state.activeCaptureGameId = null;
  state.justStampedGameId = null;
  state.selectedStatsGameId = null;
  state.statsDifficulty = 'all';
  state.todaySelectedTag = 'All';
  state.dialogCatalogTag = 'All';
  state.friendsCatalogTag = 'All';
  state.friendsCatalogSearch = '';
  state.openCatalogCollections = {};
  state.signupSelectedSlugs.clear();
  state.signupPickerInitialized = false;
  state.selectedHeatmapDate = null;
  state.pendingImportData = null;
  state.trackedResetEpochs = new Map();
  state.lastBootstrapDate = null;
  state.todayStr = getLocalDateString();
  state.selectedDate = state.todayStr;
  state.lbDate = state.todayStr;
  state.quickPasteManualOverride = false;
  state.quickPasteDateManuallyEdited = false;
  state.entryModalDateManuallyEdited = false;
  state.entryModalDifficulty = '';
  state.entryModalDifficultyTouched = false;
  state.entryModalRoundsTouched = false;
  state.entryModalValueAutoFilled = false;

  for (const dlg of [els.entryDialog, els.gameDialog, els.confirmDialog]) {
    if (dlg?.open) closeModalDialog(dlg, 'cancel');
  }

  if (els.toPlayGrid) els.toPlayGrid.innerHTML = '';
  if (els.completedGrid) els.completedGrid.innerHTML = '';
  if (els.todayTagFilterBar) {
    els.todayTagFilterBar.innerHTML = '';
    setHidden(els.todayTagFilterBar, true);
  }
  if (els.rosterCompeteBar) {
    els.rosterCompeteBar.innerHTML = '';
    setHidden(els.rosterCompeteBar, true);
  }
  if (els.leaderboardTbody) els.leaderboardTbody.innerHTML = '';
  if (els.historyTbody) els.historyTbody.innerHTML = '';
  if (els.manageGamesList) els.manageGamesList.innerHTML = '';
  if (els.friendsCatalogSearch) els.friendsCatalogSearch.value = '';
  if (els.friendsCatalogTagBar) els.friendsCatalogTagBar.innerHTML = '';
  if (els.friendsCatalogCollections) els.friendsCatalogCollections.innerHTML = '';
  if (els.friendsCatalogShelf) setHidden(els.friendsCatalogShelf, true);
  if (els.signupOptionalCollections) els.signupOptionalCollections.open = false;
  updateCatalogDiscoveryBadge();
  if (els.playersOverallTbody) els.playersOverallTbody.innerHTML = '';
  renderTableSortHeaders(els.playersOverallTable, state.lbOverallSortKey, state.lbOverallSortDir);
  if (els.playersMatrixThead) els.playersMatrixThead.innerHTML = '';
  if (els.playersMatrixTbody) els.playersMatrixTbody.innerHTML = '';
  if (els.lbGamePills) els.lbGamePills.innerHTML = '';
  renderDifficultyFilterBar(els.lbDifficultyBar, { visible: false });
  renderDifficultyFilterBar(els.statsDifficultyBar, { visible: false });
  setHidden(els.entryModalRoundsGroup, true);
  if (els.lbGameHeader) els.lbGameHeader.innerHTML = '';
  if (els.playersGameTbody) els.playersGameTbody.innerHTML = '';
  renderTableSortHeaders(els.playersGameTable, state.lbGameSortKey, state.lbGameSortDir);
  const ptsExplainer = $('arcade-pts-explainer');
  if (ptsExplainer) ptsExplainer.open = false;
  if (els.quickPasteTextarea) els.quickPasteTextarea.value = '';
  toggleQuickPasteTray(false);
  setHidden(els.popupNotice, true);

  if (els.userBadgeName) els.userBadgeName.textContent = '';
  setActiveTab('today', { skipLoad: true });

  setHidden(els.mainNav, true);
  setHidden(els.btnOpenAddGame, true);
  setHidden(els.userPlayerBar, true);
  setHidden(els.mainContent, true);
  if (els.authClaimNotice) {
    els.authClaimNotice.textContent = '';
    setHidden(els.authClaimNotice, true);
  }
  setHidden(els.authScreen, false);
  resetAuthForms({ keepEmail: true });
}

function applyAuthBootstrapHints(meResp = null) {
  state.signupCatalog = Array.isArray(meResp?.signupCatalog) ? meResp.signupCatalog : null;
  state.signupPickerInitialized = false;
  const gamesCount = Number(meResp?.unclaimed?.gamesCount || 0);
  const entriesCount = Number(meResp?.unclaimed?.entriesCount || 0);
  const hasUnclaimed = gamesCount > 0 || entriesCount > 0;

  if (els.authClaimNotice) {
    if (hasUnclaimed) {
      const parts = [];
      if (gamesCount > 0) {
        parts.push(`${gamesCount} ${gamesCount === 1 ? 'game' : 'games'}`);
      }
      if (entriesCount > 0) {
        parts.push(`${entriesCount} ${entriesCount === 1 ? 'saved result' : 'saved results'}`);
      }
      const summary = parts.join(' and ');
      const singular = gamesCount + entriesCount === 1;
      els.authClaimNotice.textContent = `📦 Nothing was lost! Your ${summary} ${singular ? 'is' : 'are'} waiting — create your first account below to claim ${singular ? 'it' : 'them'}.`;
      setHidden(els.authClaimNotice, false);
    } else {
      els.authClaimNotice.textContent = '';
      setHidden(els.authClaimNotice, true);
    }
  }

  renderSignupGamePicker();

  if (meResp?.hasUsers === false || hasUnclaimed) {
    setAuthMode('signup');
  } else {
    setAuthMode('signin');
  }
}

async function enterAuthenticatedApp(user, { prefetchedBootstrap = null } = {}) {
  state.user = user;
  if (els.userBadgeName) {
    els.userBadgeName.textContent = user?.displayName || user?.name || user?.email || 'Player';
  }
  resetAuthForms();
  if (els.authClaimNotice) {
    els.authClaimNotice.textContent = '';
    setHidden(els.authClaimNotice, true);
  }
  setHidden(els.authScreen, true);
  setHidden(els.mainNav, false);
  setHidden(els.btnOpenAddGame, false);
  setHidden(els.userPlayerBar, false);
  setHidden(els.mainContent, false);

  state.todayStr = getLocalDateString();
  state.selectedDate = state.todayStr;
  state.lbDate = state.todayStr;
  state.leaderboardResponse = null;
  state.leaderboardCache.clear();
  state.leaderboardPrefetch = null;
  state.lbSelectedGameSlug = null;
  setActiveTab('today', { skipLoad: true });

  if (prefetchedBootstrap) {
    let entriesFallback = null;
    if (!Array.isArray(prefetchedBootstrap?.entries)) {
      const entriesResp = await api.getEntries({ limit: 800 });
      entriesFallback = Array.isArray(entriesResp) ? entriesResp : entriesResp?.entries || [];
    }
    applyBootstrapPayload(prefetchedBootstrap, entriesFallback);
  } else {
    await refreshBootstrapAndEntries();
  }
  renderTodayView();
  renderGamesAdminView();
  startResetTicker();
  scheduleLeaderboardPrefetch();
}

async function handleSignInSubmit(event) {
  event.preventDefault();
  if (state.isSubmittingAuth) return;

  const email = els.signinEmail?.value.trim() || '';
  const password = els.signinPassword?.value || '';

  if (els.signinError) {
    els.signinError.textContent = '';
    setHidden(els.signinError, true);
  }

  state.isSubmittingAuth = true;
  if (els.btnSigninSubmit) {
    els.btnSigninSubmit.disabled = true;
    els.btnSigninSubmit.textContent = 'Signing in…';
  }

  try {
    const resp = await api.login({ email, password });
    if (!resp?.authenticated || !resp?.user) {
      throw new Error('Sign in failed.');
    }
    await enterAuthenticatedApp(resp.user);
    showToast(`Welcome back, ${resp.user.displayName || resp.user.email}!`, {
      variant: 'success',
    });
  } catch (err) {
    if (els.signinError) {
      els.signinError.textContent = err.message || 'Invalid email or password.';
      setHidden(els.signinError, false);
    }
    els.signinPassword?.focus();
  } finally {
    state.isSubmittingAuth = false;
    if (els.btnSigninSubmit) {
      els.btnSigninSubmit.disabled = false;
      els.btnSigninSubmit.textContent = 'Sign In';
    }
  }
}

async function handleSignUpSubmit(event) {
  event.preventDefault();
  if (state.isSubmittingAuth) return;

  const name = els.signupName?.value.trim() || '';
  const email = els.signupEmail?.value.trim() || '';
  const password = els.signupPassword?.value || '';

  if (els.signupError) {
    els.signupError.textContent = '';
    setHidden(els.signupError, true);
  }

  if (password.length < 8) {
    if (els.signupError) {
      els.signupError.textContent = 'Password must be at least 8 characters.';
      setHidden(els.signupError, false);
    }
    els.signupPassword?.focus();
    return;
  }

  const competingSlugs = [
    ...(els.signupForm?.querySelectorAll('input[name="competingSlugs"]:checked') || []),
  ]
    .map((el) => el.value)
    .filter(Boolean);
  if (competingSlugs.length === 0) {
    if (els.signupError) {
      els.signupError.textContent =
        'Please select at least one game to compete in (or click Select All).';
      setHidden(els.signupError, false);
    }
    els.btnSignupSelectAll?.focus();
    return;
  }

  state.isSubmittingAuth = true;
  if (els.btnSignupSubmit) {
    els.btnSignupSubmit.disabled = true;
    els.btnSignupSubmit.textContent = 'Creating Account…';
  }

  try {
    const resp = await api.register({ name, email, password, competingSlugs });
    if (!resp?.authenticated || !resp?.user) {
      throw new Error('Could not create account.');
    }
    state.signupSelectedSlugs.clear();
    state.signupPickerInitialized = false;
    await enterAuthenticatedApp(resp.user);
    showToast(`Account created! Welcome, ${resp.user.displayName || name}!`, {
      variant: 'success',
    });
  } catch (err) {
    if (els.signupError) {
      els.signupError.textContent = err.message || 'Could not create account.';
      setHidden(els.signupError, false);
    }
  } finally {
    state.isSubmittingAuth = false;
    if (els.btnSignupSubmit) {
      els.btnSignupSubmit.disabled = false;
      els.btnSignupSubmit.textContent = 'Create Account';
    }
  }
}

async function handleLogout() {
  if (els.btnLogout) els.btnLogout.disabled = true;
  try {
    await api.logout().catch(() => {});
    enterUnauthenticatedState();
    const me = await api.getMe().catch(() => null);
    applyAuthBootstrapHints(me);
    showToast('Signed out.', { variant: 'info' });
  } finally {
    if (els.btnLogout) els.btnLogout.disabled = false;
  }
}

// ---------- Event Binding ----------

function bindEvents() {
  // Auth screen & session expiry events
  els.btnAuthModeSignin?.addEventListener('click', () => setAuthMode('signin'));
  els.btnAuthModeSignup?.addEventListener('click', () => setAuthMode('signup'));
  els.signinForm?.addEventListener('submit', handleSignInSubmit);
  els.signupForm?.addEventListener('submit', handleSignUpSubmit);
  els.btnSignupSelectAll?.addEventListener('click', () => {
    const catalog = getSignupCatalogItems();
    for (const g of catalog) {
      if (!isOptionalCollectionItem(g)) {
        state.signupSelectedSlugs.add(g.slug);
      }
    }
    state.signupPickerInitialized = true;
    syncSignupPickerCounts(catalog);
  });
  els.btnSignupClearAll?.addEventListener('click', () => {
    state.signupSelectedSlugs.clear();
    state.signupPickerInitialized = true;
    syncSignupPickerCounts();
  });
  els.signupOptionalBody?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action="signup-select-collection"][data-collection]');
    if (!btn) return;
    const colKey = String(btn.dataset.collection || '').toLowerCase();
    const catalog = getSignupCatalogItems();
    for (const item of catalog) {
      if (isOptionalCollectionItem(item) && getNormalizedCollectionKey(item) === colKey) {
        state.signupSelectedSlugs.add(item.slug);
      }
    }
    state.signupPickerInitialized = true;
    syncSignupPickerCounts(catalog);
  });
  els.signupGamesFieldset?.addEventListener('change', (event) => {
    const input = event.target.closest('input[name="competingSlugs"]');
    if (!input) return;
    state.signupPickerInitialized = true;
    if (input.checked) state.signupSelectedSlugs.add(input.value);
    else state.signupSelectedSlugs.delete(input.value);
    syncSignupPickerCounts();
  });
  for (const btn of els.passwordToggleButtons || []) {
    btn.addEventListener('click', () => togglePasswordVisibility(btn));
  }
  els.btnLogout?.addEventListener('click', handleLogout);

  window.addEventListener('dg:unauthorized', async () => {
    if (state.isBootstrapping) return;
    const hadSession = Boolean(state.user);
    enterUnauthenticatedState();
    const me = await api.getMe().catch(() => null);
    applyAuthBootstrapHints(me);
    if (hadSession) {
      showToast('Session expired — please sign in again.', { variant: 'warning' });
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.user) {
      handleResetTicker();
    }
  });
  // Navigation tabs (click + roving tabindex ArrowLeft/ArrowRight/Home/End)
  els.tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
  });

  els.mainNav?.addEventListener('keydown', (event) => {
    const currentTab = event.target.closest('.nav-tab[data-tab]');
    if (!currentTab || !els.tabButtons.length) return;
    const idx = els.tabButtons.indexOf(currentTab);
    if (idx === -1) return;

    let nextIdx = null;
    if (event.key === 'ArrowRight') nextIdx = (idx + 1) % els.tabButtons.length;
    else if (event.key === 'ArrowLeft') nextIdx = (idx - 1 + els.tabButtons.length) % els.tabButtons.length;
    else if (event.key === 'Home') nextIdx = 0;
    else if (event.key === 'End') nextIdx = els.tabButtons.length - 1;

    if (nextIdx === null) return;
    event.preventDefault();
    const nextBtn = els.tabButtons[nextIdx];
    if (nextBtn) {
      nextBtn.focus();
      setActiveTab(nextBtn.dataset.tab);
    }
  });

  // Topbar actions
  els.btnOpenAddGame?.addEventListener('click', () => openGameModal(null));
  els.btnAddGameAdmin?.addEventListener('click', () => openGameModal(null));

  els.themeOptionsList?.addEventListener('click', (event) => {
    const btn = event.target.closest('.theme-option-btn[data-theme-id]');
    if (!btn) return;
    selectTheme(btn.dataset.themeId);
  });

  // Today HUD navigation
  els.btnPrevDay?.addEventListener('click', () => handleDateChange(addDays(state.selectedDate, -1)));
  els.btnNextDay?.addEventListener('click', () => handleDateChange(addDays(state.selectedDate, 1)));
  els.btnToday?.addEventListener('click', () => handleDateChange(getLocalDateString()));
  els.todayDateInput?.addEventListener('change', (e) => handleDateChange(e.target.value));

  els.btnLaunchNext?.addEventListener('click', () => {
    const entryMap = getTodayEntryMap();
    const nextGame = getActiveGames().find((g) => !entryMap.has(g.id));
    if (nextGame) openGameUrl(nextGame.id, true);
  });

  els.btnOpenAllUnplayed?.addEventListener('click', handleOpenAllUnplayed);
  els.btnPasteHud?.addEventListener('click', () => toggleQuickPasteTray());

  els.popupNotice?.addEventListener('click', (event) => {
    const actionEl = event.target.closest('[data-action]');
    if (!actionEl) return;
    if (actionEl.dataset.action === 'dismiss-popup-notice') {
      setHidden(els.popupNotice, true);
    } else if (actionEl.dataset.action === 'manual-popup-open') {
      const gid = Number(actionEl.dataset.gameId);
      if (gid) {
        state.lastOpenedGameId = gid;
        state.activeCaptureGameId = gid;
        renderTodayView();
      }
    }
  });

  if (els.kbdPasteHint) {
    const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
    els.kbdPasteHint.textContent = isMac ? '⌘V' : 'Ctrl+V';
  }

  // Quick paste tray
  els.btnClosePasteTray?.addEventListener('click', () => toggleQuickPasteTray(false));
  els.btnQuickPasteClear?.addEventListener('click', () => {
    if (els.quickPasteTextarea) els.quickPasteTextarea.value = '';
    state.quickPasteManualOverride = false;
    state.quickPasteDateManuallyEdited = false;
    updateQuickPastePreview();
  });
  els.btnClipboardPaste?.addEventListener('click', async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (!clip.trim()) {
        showToast('Clipboard is empty.', { variant: 'info' });
        return;
      }
      els.quickPasteTextarea.value = clip;
      state.quickPasteManualOverride = false;
      state.quickPasteDateManuallyEdited = false;
      updateQuickPastePreview();
    } catch {
      showToast('Clipboard read blocked — press ⌘V / Ctrl+V inside the text box instead.', {
        variant: 'warning',
      });
      els.quickPasteTextarea?.focus();
    }
  });
  els.quickPasteTextarea?.addEventListener('input', () => {
    if (!els.quickPasteTextarea.value.trim()) {
      state.quickPasteManualOverride = false;
    }
    updateQuickPastePreview();
  });
  els.quickPasteGameSelect?.addEventListener('change', () => {
    state.quickPasteManualOverride = Boolean(els.quickPasteGameSelect.value);
    updateQuickPastePreview();
  });
  els.quickPasteDateInput?.addEventListener('change', () => {
    state.quickPasteDateManuallyEdited = true;
  });
  els.btnQuickPasteSave?.addEventListener('click', handleSaveQuickPaste);

  // Global paste & Escape helper
  document.addEventListener('paste', handleGlobalPaste);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (els.entryDialog?.open || els.gameDialog?.open || els.confirmDialog?.open) return;
    if (state.activeCaptureGameId !== null) {
      state.activeCaptureGameId = null;
      renderTodayView();
    } else if (els.quickPasteTray && !els.quickPasteTray.classList.contains('hidden')) {
      toggleQuickPasteTray(false);
    }
  });

  // Today shelves delegated interactions
  els.toPlayGrid?.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const gameId = btn.dataset.gameId;

    if (action === 'open-add-game') {
      openGameModal(null);
    } else if (action === 'go-stats') {
      setActiveTab('stats');
    } else if (action === 'play-game') {
      openGameUrl(gameId, true);
    } else if (action === 'view-game-stats') {
      selectStatsGame(gameId, { reload: false });
      setActiveTab('stats');
    } else if (action === 'toggle-capture') {
      const idNum = Number(gameId);
      state.activeCaptureGameId = state.activeCaptureGameId === idNum ? null : idNum;
      renderTodayView();
      if (state.activeCaptureGameId !== null) {
        requestAnimationFrame(() => {
          els.toPlayGrid
            ?.querySelector(`[data-capture-input="${CSS.escape(String(gameId))}"]`)
            ?.focus();
        });
      }
    } else if (action === 'close-capture') {
      state.activeCaptureGameId = null;
      renderTodayView();
    } else if (action === 'open-entry-modal') {
      const captureInput = els.toPlayGrid?.querySelector(
        `[data-capture-input="${CSS.escape(String(gameId))}"]`
      );
      openEntryModal(gameId, null, captureInput?.value || '');
    } else if (action === 'mark-played-inline') {
      const game = getGameById(gameId);
      if (!game) return;
      try {
        const res = await saveParsedEntry(game, {
          playDate: getDefaultPlayDateForGame(game),
          markPlayedOnly: true,
        });
        if (res?.saved) showSavedEntryToast(game, res.saved, res.previous);
      } catch (err) {
        showToast(`Failed to mark played: ${err.message}`, { variant: 'error' });
      }
    } else if (action === 'save-inline-capture') {
      const game = getGameById(gameId);
      const captureInput = els.toPlayGrid?.querySelector(
        `[data-capture-input="${CSS.escape(String(gameId))}"]`
      );
      const text = captureInput?.value.trim() || '';
      if (!game) return;
      if (!text) {
        openEntryModal(gameId, null, '');
        return;
      }
      const parsed = parseForGame(text, game);
      const playDate = parsed?.puzzleDate || getDefaultPlayDateForGame(game);
      try {
        const res = await saveParsedEntry(game, { rawText: text, playDate });
        if (res?.saved) showSavedEntryToast(game, res.saved, res.previous);
      } catch (err) {
        showToast(`Could not save: ${err.message}`, { variant: 'error' });
      }
    } else if (action === 'clear-today-tag') {
      state.todaySelectedTag = 'All';
      renderTodayView();
    }
  });

  els.todayTagFilterBar?.addEventListener('click', (event) => {
    const btn = event.target.closest('.tag-filter-pill[data-tag]');
    if (!btn) return;
    const nextTag = btn.dataset.tag || 'All';
    if (state.todaySelectedTag === nextTag) return;
    state.todaySelectedTag = nextTag;
    renderTodayView();
  });

  els.toPlayGrid?.addEventListener('input', (event) => {
    const input = event.target.closest('[data-capture-input]');
    if (!input) return;
    handleInlineCapturePreview(input.dataset.captureInput, input.value);
  });

  els.completedGrid?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'edit-entry') {
      openEntryModal(btn.dataset.gameId, btn.dataset.entryId);
    } else if (action === 'view-ticket-stats') {
      selectStatsGame(btn.dataset.gameId, { reload: false });
      setActiveTab('stats');
    } else if (action === 'open-game-url') {
      openGameUrl(btn.dataset.gameId, false);
    }
  });

  // Players Leaderboard events
  els.btnLbPrevDay?.addEventListener('click', () => handleLeaderboardDateChange(addDays(state.lbDate, -1)));
  els.btnLbNextDay?.addEventListener('click', () => handleLeaderboardDateChange(addDays(state.lbDate, 1)));
  els.btnLbToday?.addEventListener('click', () => handleLeaderboardDateChange(getLocalDateString()));
  els.lbDateInput?.addEventListener('change', (e) => handleLeaderboardDateChange(e.target.value));
  els.btnLbRefresh?.addEventListener('click', () => loadAndRenderLeaderboardView({ forceRefresh: true }));
  els.lbCompetingScopeChip?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action="go-manage-games"]');
    if (!btn) return;
    setActiveTab('games');
  });

  els.lbWindowGroup?.addEventListener('click', (event) => {
    const btn = event.target.closest('.seg-btn[data-days]');
    if (!btn) return;
    const raw = btn.dataset.days;
    state.lbDays = raw === 'all' ? 0 : Number(raw || 30);
    loadAndRenderLeaderboardView();
  });

  els.playersMatrixThead?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action="select-lb-game"][data-slug]');
    if (!btn) return;
    selectLeaderboardGameSlug(btn.dataset.slug);
    els.gamewiseLeaderboardCard?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  els.playersMatrixTbody?.addEventListener('click', (event) => {
    const manageBtn = event.target.closest('[data-action="go-manage-games"]');
    if (manageBtn) {
      setActiveTab('games');
      return;
    }
    const btn = event.target.closest('[data-action="subscribe-catalog-game"][data-slug]');
    if (!btn) return;
    handleSubscribeCatalogGame(btn.dataset.slug, btn);
  });

  els.lbGameHeader?.addEventListener('click', (event) => {
    const manageBtn = event.target.closest('[data-action="go-manage-games"]');
    if (manageBtn) {
      setActiveTab('games');
      return;
    }
    const btn = event.target.closest('[data-action="subscribe-catalog-game"][data-slug]');
    if (!btn) return;
    handleSubscribeCatalogGame(btn.dataset.slug, btn);
  });

  els.lbGamePills?.addEventListener('click', (event) => {
    const pill = event.target.closest('.game-pill-btn[data-slug]');
    if (!pill) return;
    selectLeaderboardGameSlug(pill.dataset.slug);
  });

  els.lbDifficultyBar?.addEventListener('click', (event) => {
    const btn = event.target.closest('.difficulty-pill[data-difficulty]');
    if (!btn) return;
    const nextDiff = btn.dataset.difficulty || 'all';
    if (state.leaderboardDifficulty === nextDiff) return;
    state.leaderboardDifficulty = nextDiff;
    const targetSlug =
      state.lbSelectedGameSlug ||
      state.leaderboardResponse?.selectedGameSlug ||
      state.leaderboardResponse?.gameBoard?.game?.slug;
    const instantBoard = resolveGameBoardFromResponse(
      state.leaderboardResponse,
      targetSlug,
      nextDiff
    );
    if (instantBoard) {
      renderGamewiseLeaderboard(state.leaderboardResponse);
      return;
    }
    loadAndRenderLeaderboardView();
  });

  els.playersOverallTable?.tHead?.addEventListener('click', (event) => {
    const btn = event.target.closest('.th-sort-btn[data-sort-key]');
    if (!btn) return;
    const key = btn.dataset.sortKey;
    if (!key) return;
    if (state.lbOverallSortKey === key) {
      state.lbOverallSortDir = state.lbOverallSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.lbOverallSortKey = key;
      state.lbOverallSortDir = getDefaultOverallSortDir(key);
    }
    if (state.leaderboardResponse) {
      renderOverallStandings(state.leaderboardResponse);
    } else {
      renderTableSortHeaders(
        els.playersOverallTable,
        state.lbOverallSortKey,
        state.lbOverallSortDir
      );
    }
  });

  els.playersGameTable?.tHead?.addEventListener('click', (event) => {
    const btn = event.target.closest('.th-sort-btn[data-sort-key]');
    if (!btn) return;
    const key = btn.dataset.sortKey;
    if (!key) return;
    const selectedGame = state.leaderboardResponse?.gameBoard?.game || null;
    if (state.lbGameSortKey === key) {
      state.lbGameSortDir = state.lbGameSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.lbGameSortKey = key;
      state.lbGameSortDir = getDefaultGameSortDir(key, selectedGame?.metricDirection);
    }
    if (state.leaderboardResponse) {
      renderGamewiseLeaderboard(state.leaderboardResponse);
    } else {
      renderTableSortHeaders(els.playersGameTable, state.lbGameSortKey, state.lbGameSortDir);
    }
  });

  // Stats View events
  els.btnClearHeatmapDay?.addEventListener('click', () => {
    state.selectedHeatmapDate = null;
    renderHeatmapSection();
  });

  els.heatmapDayDetail?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action="jump-heatmap-date"]');
    if (!btn) return;
    const targetDate = btn.dataset.date;
    if (targetDate) {
      setActiveTab('today');
      handleDateChange(targetDate);
    }
  });

  els.leaderboardTbody?.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-game-id]');
    if (!row) return;
    selectStatsGame(row.dataset.gameId, { reload: true });
  });

  els.statsGamePills?.addEventListener('click', (event) => {
    const pill = event.target.closest('.game-pill-btn[data-game-id]');
    if (!pill) return;
    selectStatsGame(pill.dataset.gameId, { reload: true });
  });

  els.statsDifficultyBar?.addEventListener('click', (event) => {
    const btn = event.target.closest('.difficulty-pill[data-difficulty]');
    if (!btn) return;
    const nextDiff = btn.dataset.difficulty || 'all';
    if (state.statsDifficulty === nextDiff) return;
    state.statsDifficulty = nextDiff;
    loadAndRenderStatsView({ includeGlobal: false });
  });

  els.statsWindowGroup?.addEventListener('click', (event) => {
    const btn = event.target.closest('.seg-btn[data-days]');
    if (!btn) return;
    const raw = btn.dataset.days;
    state.statsDays = raw === 'all' ? 0 : Number(raw || 30);
    renderStatsWindowButtons();
    loadAndRenderStatsView({ includeGlobal: false });
  });

  els.btnReparseGame?.addEventListener('click', handleReparseGame);

  els.historyTbody?.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'edit-history-entry') {
      openEntryModal(btn.dataset.gameId, btn.dataset.entryId);
    } else if (btn.dataset.action === 'delete-history-entry') {
      const ok = await confirmAction({
        title: 'Delete Entry',
        message: 'Delete this play record permanently?',
        okLabel: 'Delete',
      });
      if (!ok) return;
      try {
        await api.deleteEntry(btn.dataset.entryId);
        invalidateLeaderboardCache();
        await refreshBootstrapAndEntries();
        renderTodayView();
        await loadAndRenderStatsView();
        if (state.activeTab === 'leaderboard') {
          await loadAndRenderLeaderboardView();
        }
        showToast('Entry deleted.', { variant: 'info' });
      } catch (err) {
        showToast(`Delete failed: ${err.message}`, { variant: 'error' });
      }
    }
  });

  // My Games & Parser Lab events
  els.rosterCompeteBar?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'compete-all-games') {
      handleBulkCompeteGames(true);
    } else if (btn.dataset.action === 'solo-all-games') {
      handleBulkCompeteGames(false);
    }
  });

  els.manageGamesList?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const gameId = btn.dataset.gameId;
    if (action === 'move-game-up') handleReorderGame(gameId, -1);
    else if (action === 'move-game-down') handleReorderGame(gameId, 1);
    else if (action === 'toggle-compete-game') handleToggleCompeteGame(gameId, btn);
    else if (action === 'edit-game') openGameModal(gameId);
    else if (action === 'toggle-archive-game') handleToggleArchiveGame(gameId);
    else if (action === 'delete-game') handleDeleteGame(gameId);
  });

  els.friendsCatalogSearch?.addEventListener('input', () => {
    state.friendsCatalogSearch = els.friendsCatalogSearch.value;
    renderFriendsCatalogShelf();
  });

  els.friendsCatalogTagBar?.addEventListener('click', (event) => {
    const btn = event.target.closest('.tag-filter-pill[data-tag]');
    if (!btn) return;
    const nextTag = btn.dataset.tag || 'All';
    if (state.friendsCatalogTag === nextTag) return;
    state.friendsCatalogTag = nextTag;
    renderFriendsCatalogShelf();
  });

  els.friendsCatalogCollections?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action="subscribe-catalog-game"][data-slug]');
    if (!btn) return;
    handleSubscribeCatalogGame(btn.dataset.slug, btn);
  });

  els.friendsCatalogCollections?.addEventListener(
    'toggle',
    (event) => {
      const details = event.target;
      if (!details?.matches?.('details.catalog-collection-group[data-collection-key]')) return;
      const ctx = details.dataset.collectionContext || 'friends';
      const key = details.dataset.collectionKey;
      state.openCatalogCollections[`${ctx}:${key}`] = details.open;
    },
    true
  );

  els.btnExportJson?.addEventListener('click', handleExportJson);
  els.importFileInput?.addEventListener('change', handleImportFilePicked);
  els.btnImportJson?.addEventListener('click', handleImportJson);
  els.workbenchGameSelect?.addEventListener('change', renderParserWorkbench);
  els.workbenchSampleText?.addEventListener('input', renderParserWorkbench);
  els.btnCopyParserRequest?.addEventListener('click', handleCopyParserRequest);

  // Entry dialog
  wireDialogLightDismiss(els.entryDialog);
  els.btnCloseEntryModal?.addEventListener('click', () => closeModalDialog(els.entryDialog));
  els.btnCancelEntryModal?.addEventListener('click', () => closeModalDialog(els.entryDialog));
  els.entryModalForm?.addEventListener('submit', handleSubmitEntryModal);
  els.entryModalRawText?.addEventListener('input', updateEntryParsePreview);
  els.btnEntryModalDelete?.addEventListener('click', handleDeleteEntryFromModal);

  els.entryModalValueInput?.addEventListener('input', () => {
    els.entryModalManualOverride.checked = true;
    state.entryModalValueAutoFilled = false;
  });
  els.entryModalRoundsInputs?.addEventListener('input', (event) => {
    if (!event.target.closest('.perceptle-round-input')) return;
    maybeSyncScoreFromRounds();
  });
  els.entryModalPuzzleId?.addEventListener('input', () => {
    els.entryModalManualOverride.checked = true;
  });
  els.entryModalDate?.addEventListener('change', () => {
    state.entryModalDateManuallyEdited = true;
  });

  els.btnModalPasteClipboard?.addEventListener('click', async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (!clip.trim()) {
        showToast('Clipboard is empty.', { variant: 'info' });
        return;
      }
      els.entryModalRawText.value = clip;
      updateEntryParsePreview();
    } catch {
      showToast('Clipboard read blocked — press ⌘V / Ctrl+V in the box.', { variant: 'warning' });
      els.entryModalRawText?.focus();
    }
  });

  els.btnMarkPlayedNoscore?.addEventListener('click', async () => {
    const game = getGameById(els.entryModalGameId.value);
    if (!game) return;
    const difficultyVisible = gameSupportsDifficulty(
      game,
      null,
      state.entryModalDifficulty ? { difficulty: state.entryModalDifficulty } : null
    );
    try {
      const res = await saveParsedEntry(game, {
        playDate: els.entryModalDate.value || getDefaultPlayDateForGame(game),
        markPlayedOnly: true,
        notes: els.entryModalNotes.value.trim(),
        difficulty: difficultyVisible || state.entryModalDifficulty ? state.entryModalDifficulty || '' : undefined,
      });
      closeModalDialog(els.entryDialog, 'saved');
      if (res?.saved) showToast(`Marked ${game.name} as played!`, { variant: 'success' });
    } catch (err) {
      showToast(`Failed: ${err.message}`, { variant: 'error' });
    }
  });

  els.entryModalSolvedGroup?.addEventListener('click', (event) => {
    const btn = event.target.closest('.seg-btn[data-solved]');
    if (!btn) return;
    const mode = btn.dataset.solved || 'auto';
    setSolvedSegMode(mode);
    if (mode !== 'auto') {
      els.entryModalManualOverride.checked = true;
    }
  });

  els.entryModalDifficultyPills?.addEventListener('click', (event) => {
    const btn = event.target.closest('.difficulty-pill[data-difficulty]');
    if (!btn) return;
    state.entryModalDifficultyTouched = true;
    setEntryModalDifficulty(btn.dataset.difficulty || '');
  });

  // Game dialog
  wireDialogLightDismiss(els.gameDialog);
  els.btnCloseGameDialog?.addEventListener('click', () => closeModalDialog(els.gameDialog));
  els.btnCancelGameDialog?.addEventListener('click', () => closeModalDialog(els.gameDialog));
  els.catalogSearchInput?.addEventListener('input', () => {
    renderCatalogPicker(els.catalogSearchInput.value, state.dialogCatalogTag);
  });
  els.catalogTagBar?.addEventListener('click', (event) => {
    const btn = event.target.closest('.tag-filter-pill[data-tag]');
    if (!btn) return;
    const nextTag = btn.dataset.tag || 'All';
    if (state.dialogCatalogTag === nextTag) return;
    state.dialogCatalogTag = nextTag;
    renderCatalogPicker(els.catalogSearchInput?.value || '', nextTag);
  });
  els.catalogAvailableList?.addEventListener(
    'toggle',
    (event) => {
      const details = event.target;
      if (!details?.matches?.('details.catalog-collection-group[data-collection-key]')) return;
      const ctx = details.dataset.collectionContext || 'dialog';
      const key = details.dataset.collectionKey;
      state.openCatalogCollections[`${ctx}:${key}`] = details.open;
    },
    true
  );
  els.catalogPickerSection?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action="subscribe-catalog-game"][data-slug]');
    if (!btn) return;
    handleSubscribeCatalogGame(btn.dataset.slug, btn, { closeGameDialogOnSuccess: false });
  });
  els.gameCatalogMatchBanner?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action="subscribe-matched-catalog"][data-slug]');
    if (!btn) return;
    handleSubscribeCatalogGame(btn.dataset.slug, btn, { closeGameDialogOnSuccess: true });
  });
  els.gameName?.addEventListener('input', renderCatalogMatchBanner);
  els.gameUrl?.addEventListener('input', renderCatalogMatchBanner);
  els.gameForm?.addEventListener('submit', handleSubmitGameModal);

  els.gameIcon?.addEventListener('input', updateGameDialogPreview);
  els.gameColor?.addEventListener('input', () => {
    updateGameDialogPreview();
  });

  els.gameDialog?.addEventListener('click', (event) => {
    const emojiBtn = event.target.closest('.emoji-chip[data-emoji]');
    if (emojiBtn) {
      els.gameIcon.value = emojiBtn.dataset.emoji;
      updateGameDialogPreview();
      return;
    }
    const swatchBtn = event.target.closest('.color-swatch-btn[data-color]');
    if (swatchBtn) {
      const norm = normalizeHexColor(swatchBtn.dataset.color);
      els.gameColor.value = norm;
      updateGameDialogPreview();
      return;
    }
    const presetBtn = event.target.closest('.scoring-tile[data-preset]');
    if (presetBtn) {
      applyScoringPreset(presetBtn.dataset.preset);
    }
  });

  els.gameMetricLabel?.addEventListener('input', syncScoringTileSelection);
  els.gameMetricFormat?.addEventListener('change', syncScoringTileSelection);
  els.gameMetricDirection?.addEventListener('change', syncScoringTileSelection);
  els.gameResetTimezone?.addEventListener('change', () => updateGameResetPreview());
  els.gameResetTime?.addEventListener('input', () => updateGameResetPreview());
  els.gameResetTime?.addEventListener('change', () => updateGameResetPreview());

  // Confirm dialog
  wireDialogLightDismiss(els.confirmDialog, (returnVal) => {
    if (returnVal !== 'confirm' && typeof state.confirmResolve === 'function') {
      const resolver = state.confirmResolve;
      state.confirmResolve = null;
      resolver(false);
    }
  });
  els.btnCloseConfirm?.addEventListener('click', () => resolveConfirm(false));
  els.confirmCancelBtn?.addEventListener('click', () => resolveConfirm(false));
  els.confirmOkBtn?.addEventListener('click', () => resolveConfirm(true));
}

function updateResetCountdownsInPlace(now = new Date()) {
  if (isLiveTodayMode() && state.activeTab === 'today') {
    document.querySelectorAll('[data-reset-countdown="ticket"][data-game-id]').forEach((el) => {
      const game = getGameById(el.dataset.gameId);
      if (!game) return;
      const puzzleStatus = getLivePuzzleStatus(game, now);
      if (!puzzleStatus) return;

      el.textContent = `⏳ Next in ${puzzleStatus.countdownLabel} (${puzzleStatus.nextResetLocalTime})`;
      el.title = formatResetTooltip(game, puzzleStatus);
    });
  }

  if (els.gameDialog?.open) {
    updateGameResetPreview(now);
  }
}

async function handleResetTicker() {
  if (!state.user) return;
  const oldTodayStr = state.todayStr;
  const newTodayStr = getLocalDateString();
  const wasLiveToday = state.selectedDate === oldTodayStr;
  const wasLiveLb = state.lbDate === oldTodayStr;
  if (newTodayStr !== oldTodayStr) {
    state.todayStr = newTodayStr;
    if (wasLiveToday) state.selectedDate = newTodayStr;
    if (wasLiveLb) state.lbDate = newTodayStr;
  } else {
    state.todayStr = newTodayStr;
  }

  const now = new Date();
  const nowMs = now.getTime();
  let anyBoundaryCrossed = false;

  if (isLiveTodayMode()) {
    for (const game of getActiveGames()) {
      const trackedEpoch = state.trackedResetEpochs.get(game.id);
      if (Number.isFinite(trackedEpoch) && nowMs >= trackedEpoch) {
        anyBoundaryCrossed = true;
        break;
      }
    }
  }

  const localDayRolledOver =
    wasLiveToday &&
    isLiveTodayMode() &&
    state.lastBootstrapDate &&
    state.lastBootstrapDate !== newTodayStr;

  if (anyBoundaryCrossed || localDayRolledOver) {
    if (!state.isSavingEntry && !state.isSavingGame && !state.isRefreshingReset) {
      state.isRefreshingReset = true;
      try {
        invalidateLeaderboardCache();
        await refreshBootstrapAndEntries();
        if (state.activeTab === 'today') {
          renderTodayView();
        } else if (state.activeTab === 'leaderboard') {
          await loadAndRenderLeaderboardView({ forceRefresh: true });
        } else if (state.activeTab === 'stats') {
          await loadAndRenderStatsView({ includeGlobal: true });
        }
      } catch {
        // Silent retry on next 30s tick
      } finally {
        state.isRefreshingReset = false;
      }
    }
    return;
  }

  updateResetCountdownsInPlace(now);
}

function startResetTicker() {
  stopResetTicker();
  state.resetTickerId = setInterval(handleResetTicker, 30_000);
}

async function init() {
  cacheElements();
  initThemeSystem(() => {
    renderThemeOptions();
    if (state.user && state.activeTab === 'stats' && state.statsResponse) {
      renderStatsViewContent({ includeGlobal: true });
    }
  });
  renderThemeOptions();
  populateResetTimezoneSelect('local');
  updateGameResetPreview();

  bindEvents();

  state.isBootstrapping = true;
  state.todayStr = getLocalDateString();
  state.selectedDate = state.todayStr;
  state.lbDate = state.todayStr;

  try {
    const bootstrap = await api.getBootstrap(state.selectedDate, {
      live: true,
      tz: getViewerTimeZone(),
    });
    if (bootstrap?.user) {
      await enterAuthenticatedApp(bootstrap.user, { prefetchedBootstrap: bootstrap });
    } else {
      enterUnauthenticatedState();
      const me = await api.getMe().catch(() => null);
      applyAuthBootstrapHints(me);
    }
  } catch (err) {
    enterUnauthenticatedState();
    if (err?.status === 401) {
      try {
        const me = await api.getMe();
        applyAuthBootstrapHints(me);
      } catch {
        applyAuthBootstrapHints(null);
      }
    } else {
      applyAuthBootstrapHints(null);
      showToast(`Failed to connect to Daily Games server: ${err.message}`, { variant: 'error' });
    }
  } finally {
    state.isBootstrapping = false;
  }
}

init();
