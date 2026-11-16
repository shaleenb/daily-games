/**
 * Backend REST API client for Daily Games Hub.
 * Zero external dependencies; native fetch + ES Modules.
 */

async function requestJson(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  let body = options.body;

  if (body !== undefined && typeof body !== 'string') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }

  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers,
    body,
  });

  const contentType = response.headers.get('content-type') || '';
  let payload = null;
  if (contentType.includes('application/json')) {
    payload = await response.json().catch(() => null);
  } else {
    const text = await response.text().catch(() => '');
    payload = text ? { message: text } : null;
  }

  if (!response.ok) {
    if (response.status === 401 && !String(url).startsWith('/api/auth/')) {
      window.dispatchEvent(new CustomEvent('dg:unauthorized'));
    }
    const message =
      (payload && (payload.error || payload.message)) ||
      `Request failed with status ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    err.payload = payload;
    throw err;
  }

  return payload;
}

function buildQuery(params) {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') {
      sp.set(key, String(value));
    }
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

export const api = {
  getHealth() {
    return requestJson('/api/health');
  },

  getMe() {
    return requestJson('/api/auth/me');
  },

  register(payload) {
    return requestJson('/api/auth/register', {
      method: 'POST',
      body: payload,
    });
  },

  login(payload) {
    return requestJson('/api/auth/login', {
      method: 'POST',
      body: payload,
    });
  },

  logout() {
    return requestJson('/api/auth/logout', {
      method: 'POST',
    });
  },

  getBootstrap(date, { live = false, tz } = {}) {
    return requestJson(
      `/api/bootstrap${buildQuery({ date, live: live ? '1' : undefined, tz })}`
    );
  },

  getCatalog() {
    return requestJson('/api/catalog');
  },

  subscribeCatalogGame(slug, options = {}) {
    return requestJson('/api/catalog/subscribe', {
      method: 'POST',
      body: { slug, ...options },
    });
  },

  getGames() {
    return requestJson('/api/games');
  },

  createGame(payload) {
    return requestJson('/api/games', {
      method: 'POST',
      body: payload,
    });
  },

  reorderGames(orderedIds) {
    return requestJson('/api/games/reorder', {
      method: 'PUT',
      body: { orderedIds },
    });
  },

  updateGame(id, payload) {
    return requestJson(`/api/games/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: payload,
    });
  },

  deleteGame(id) {
    return requestJson(`/api/games/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  detectResult(rawText) {
    return requestJson('/api/detect', {
      method: 'POST',
      body: { rawText },
    });
  },

  parsePreview(rawText, gameId) {
    const body =
      gameId !== undefined && gameId !== null && gameId !== ''
        ? { rawText, gameId }
        : { rawText };
    return requestJson('/api/entries/parse-preview', {
      method: 'POST',
      body,
    });
  },

  getEntries(params = {}) {
    return requestJson(`/api/entries${buildQuery(params)}`);
  },

  saveEntry(payload) {
    return requestJson('/api/entries', {
      method: 'POST',
      body: payload,
    });
  },

  updateEntry(id, payload) {
    return requestJson(`/api/entries/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: payload,
    });
  },

  deleteEntry(id) {
    return requestJson(`/api/entries/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  reparseGame(id, { force = false } = {}) {
    return requestJson(`/api/games/${encodeURIComponent(id)}/reparse`, {
      method: 'POST',
      body: { force },
    });
  },

  getStats({ gameId, days, difficulty } = {}) {
    return requestJson(
      `/api/stats${buildQuery({
        gameId,
        days,
        difficulty: difficulty && difficulty !== 'all' ? difficulty : undefined,
      })}`
    );
  },

  getLeaderboard({ date, live = false, tz, days, gameSlug, gameId, difficulty } = {}) {
    return requestJson(
      `/api/leaderboard${buildQuery({
        date,
        live: live ? '1' : undefined,
        tz,
        days,
        gameSlug,
        gameId,
        difficulty: difficulty && difficulty !== 'all' ? difficulty : undefined,
      })}`
    );
  },

  exportData() {
    return requestJson('/api/export');
  },

  importData(payload) {
    return requestJson('/api/import', {
      method: 'POST',
      body: payload,
    });
  },
};

export default api;
