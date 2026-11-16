# Daily Games Hub

A personal and multi-player daily puzzle score tracker, parser, stats dashboard, and leaderboard. Runs locally on Node.js (`>=24`) with built-in SQLite (`node:sqlite`) and deploys to Cloudflare Workers + D1 (`daily-games-hub`).

Live production deployment: https://daily-games-hub.shaleenb.workers.dev

## Features

- **9 Built-in Starter Games**: Clues by Sam (`🕵️`), Krillion (`🦑`), Farflung (`🌍`), Perceptle (`👁️`), PricePoint (`🏷️`), Fermi (`🧮`), Magnitudle (`📏`), Plain (`✈️`), and TimeGuessr (`🕰️`), plus custom game creation and timezone-aware puzzle reset tracking (`local`, `UTC`, IANA timezones).
- **Shared Hub Game Catalog**: Browse games added by other players on the hub and subscribe (or restore archived games) with one click, backed by canonical URL deduplication.
- **Smart Share-Text Auto-Parsing & Detection** (`shared/parsers/`):
  - Paste any puzzle share text to auto-detect the game (`POST /api/detect`, `POST /api/entries/parse-preview`).
  - **Clues by Sam**: Parses solve time, date, puzzle ID, emoji grid stats, and difficulty (`Easy`, `Medium`, `Tricky`, `Hard`, `Brutal`), with manual difficulty override/clear, **Solve Time by Difficulty** breakdown chart, and difficulty-filtered stats/head-to-head leaderboards while keeping streaks unified.
  - **Perceptle**: Parses grade, overall score, and all 5 round scores (`🔢 Count`, `🎯 Track`, `📐 Angle`, `🥁 Tempo`, `✂️ Split`), supports direct 5-round numeric input/editing, and renders a dual-bar (`Latest` vs `Average`) round breakdown chart.
  - **Plain**, **TimeGuessr**, **Wordle**, plus a generic fallback parser for numbers, durations, fractions, percentages, dates, puzzle IDs, and emoji grids.
- **Multi-Player Leaderboard & Arcade Points**:
  - Today's Matrix with spoiler protection until you clear a game for the active cycle.
  - Sortable Overall Standings and Gamewise Head-to-Head tables (`aria-sort`), expandable **Arcade Points** scoring rules (`3` / `2` / `1` pts using Olympic 1-2-2-4 ties), and `Today` (`1d`), `7d`, `30d`, and `All` windows.
- **Auth, Privacy & Data Portability**:
  - PBKDF2-SHA256 authentication, `HttpOnly` signed session cookies (`__Host-dg_session` over HTTPS), `Sec-Fetch-Site` CSRF protection, strict user-scoped isolation, and JSON export/import (`merge` and `replace` modes).

## Prerequisites

- **Node.js `>= 24.0.0`** (uses built-in `node:sqlite`, `node:http`, `node:test`, and Web Crypto; zero production npm dependencies)

## Local Development

Install dev dependencies (used for Cloudflare bundling/deployment):

```bash
npm install
```

Start the local server (`http://127.0.0.1:4321`, configurable via `PORT`):

```bash
npm start
```

Run the test suite (parsers, REST API + SQLite migrations, end-to-end smoke, and Cloudflare Worker + D1 tests):

```bash
npm test
```

## Cloudflare Workers + D1 Deployment

Configured via `cloudflare.config.ts` and `vite.config.ts` using `@cloudflare/vite-plugin` and the `cf` CLI:

```bash
# Build static assets into dist/ and compile Worker bundle
npm run cf:build

# Build assets + bundle and deploy to Cloudflare Workers
npm run deploy
```

D1 SQL schema migrations live in `migrations/`, with idempotent runtime checks and data backfills handled in `worker/db-d1.js`.

## Project Structure

- `public/` — Vanilla HTML/CSS/ESM frontend and SVG charts (`public/js/charts.js`)
- `shared/` — Pure Web-Standard auth/crypto helpers, starter game definitions, and puzzle share-text parsers
- `server/` — Local Node HTTP server, SQLite adapter, and pure stats/leaderboard engine
- `worker/` — Cloudflare Worker entrypoint and async D1 database adapter
- `migrations/` — D1 SQL schema migrations
- `scripts/` — Static asset build (`build-cf-assets.mjs`) and backup utilities
- `tests/` — `node:test` suites (`parsers.test.js`, `api.test.js`, `e2e-smoke.test.js`, `worker-d1.test.js`)
