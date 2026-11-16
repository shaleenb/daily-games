# Daily Games Hub

A personal and multi-player daily puzzle score tracker, parser, stats dashboard, and leaderboard. Runs locally on Node.js (`>=24`) with built-in SQLite (`node:sqlite`) and deploys to Cloudflare Workers + D1 (`daily-games-hub`).

Live production deployment: https://daily-games-hub.shaleenb.workers.dev

## Features

- **36 Built-in Catalog Games (10 Core Starters + 26 Optional Collections)**:
  - **10 Starters**: Clues by Sam (`🕵️`), Krillion (`🦑`), Farflung (`🌍`), Perceptle (`👁️`), PricePoint (`🏷️`), Fermi (`🧮`), **Size It Up** (`📏`, `magnitudle.com/size-it-up`), Plain (`✈️`), TimeGuessr (`🕰️`), and Eraly (`⏳`), plus custom game creation and timezone-aware puzzle reset tracking (`local`, `UTC`, IANA timezones).
  - **Optional Collections**: **Magnitudle** (`Weigh It Up`, `Daily Question`) and **FlightQ** (24 games including `PassportQ`, `SkyQ`, `AirportQ`, `AirlineQ`, `PlaneQ`, `Strata`, `Mapfold`, `CityQ`, `TransitQ`, `RailQ`, etc.), organized by collapsible Collections and Category/Topic tag filter pills.
- **Selective Competitive Sign-Up & Hub Game Catalog**:
  - Choose which games to add and compete in during sign-up (`Select All` / `Clear` + collapsible optional Collections), and toggle any game between **🏆 Competing** and **Solo only** anytime in `My Games`.
  - Browse all built-in and friend-added games in the Shared Hub Catalog with search, tag filters, collapsible collections, and 1-click subscribe/restore, backed by canonical URL deduplication.
- **Smart Share-Text Auto-Parsing & Universal Grids** (`shared/parsers/`):
  - Paste any puzzle share text to auto-detect the game (`POST /api/detect`, `POST /api/entries/parse-preview`).
  - **Clues by Sam**: Parses solve time, date, puzzle ID, emoji grid stats (`🟩`, `🟨`, `🟡`, `🟠`), weighted accuracy penalty metrics, and difficulty (`Easy`, `Medium`, `Tricky`, `Hard`, `Brutal`), with manual difficulty override/clear, **Solve Time by Difficulty** breakdown chart, and difficulty-filtered stats/head-to-head leaderboards while keeping streaks unified.
  - **Perceptle**: Parses grade, overall score, and all 5 round scores (`🔢 Count`, `🎯 Track`, `📐 Angle`, `🥁 Tempo`, `✂️ Split`), supports direct 5-round numeric input/editing, and renders a dual-bar (`Latest` vs `Average`) round breakdown chart.
  - **FlightQ & Magnitudle**: Dedicated `passportqParser`, `flightqParser`, and `magnitudleParser` (Size It Up + optional Magnitudle games with double-paste deduplication).
  - **Fermi**, **Plain**, **TimeGuessr**, **Eraly** (`eraly.io` time-band decoding), **Wordle**, plus a generic fallback parser for numbers, durations, fractions, percentages, dates, puzzle IDs, and hybrid share grids displayed in Today tickets, Parse Preview, Stats History, and unlocked Leaderboard cells.
- **Selective Competitive Leaderboard & Accuracy Ranking**:
  - Today's Matrix with spoiler protection until you clear a game for the active cycle.
  - Viewer-scoped standings, Arcade Points (`3` / `2` / `1` pts using Olympic 1-2-2-4 ties), medals, and streaks filtered to your active **Competing** games (keeping `Solo only` games on Today/Stats without affecting friend leaderboards).
  - **Clues by Sam Accuracy-First Ranking**: Ranks solves by weighted penalty first (`🟩 = 0`, `🟨 mistake = 1`, `🟡 hint = 2`, `🟠 double hint = 3` penalty points), breaking ties by faster solve time.
  - Sortable Overall Standings and Gamewise Head-to-Head tables (`aria-sort`), expandable **Arcade Points** scoring rules, and `Today` (`1d`), `7d`, `30d`, and `All` windows.
- **Performance Architecture**:
  - Single-call authenticated boot (`/api/bootstrap` returning `games`, `entries`, `catalog`, and Today summaries), precomputed `gameBoardsBySlug` leaderboard payload, and client-side stats calculation via shared pure `shared/stats.js` for zero-network tab/game/window/difficulty switching.
  - Cloudflare Worker isolate schema memoization (`WeakSet`), 1-query cold fast-path against `schema_migrations`, and single-round-trip `d1.batch` queries in `worker/db-d1.js`, plus `<link rel="modulepreload">` and below-the-fold `content-visibility: auto`.
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
- `shared/` — Pure Web-Standard auth/crypto helpers, starter game definitions, stats/leaderboard engine (`stats.js`), and puzzle share-text parsers
- `server/` — Local Node HTTP server and SQLite adapter (re-exporting `shared/stats.js`)
- `worker/` — Cloudflare Worker entrypoint and async D1 database adapter
- `migrations/` — D1 SQL schema migrations
- `scripts/` — Static asset build (`build-cf-assets.mjs`) and backup utilities
- `tests/` — `node:test` suites (`parsers.test.js`, `api.test.js`, `e2e-smoke.test.js`, `worker-d1.test.js`)
