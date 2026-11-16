# Daily Games Custom Result Parsers

This directory holds dedicated per-game result parsers for the Daily Games Hub & Score Tracker.

## Browser & Node Compatibility Rules

Every `.js` file inside `shared/parsers/` is imported **both** by the browser (`public/js/app.js` via `/shared/parsers/registry.js`) and by Node.js (`server/` via `../shared/parsers/registry.js`).

Therefore, all parser files MUST follow these rules:
1. Pure standard ES module syntax (`import` / `export`).
2. Explicit `.js` file extensions on all relative imports (e.g., `import { extractExplicitDate } from '../utils.js'`).
3. **ZERO** Node.js built-ins (`node:*`, `fs`, `path`, `process`, `Buffer`, etc.).
4. **ZERO** external npm dependencies.

## Parser Plugin Interface

A custom game parser object (see [`wordle.js`](./wordle.js) for a complete reference implementation) must expose:

```js
export const myGameParser = {
  id: 'mygame',                     // Unique lowercase identifier (matches game.parserId or slug)
  name: 'My Game',                  // Display name shown in parser dropdowns
  version: 1,                       // Integer >= 1; bump when extraction logic improves
  isCustomParser: true,             // Always true for dedicated parsers
  supportedSlugs: ['mygame', 'my-game'],
  supportedDomains: ['mygame.com'], // Lowercase hostnames without "www."

  /**
   * Return true if rawText unambiguously belongs to this game's share format.
   */
  canParse(rawText) {
    return typeof rawText === 'string' && /My Game #\d+/i.test(rawText);
  },

  /**
   * Parse rawText into a ParsedGameResult object.
   */
  parse(rawText, gameContext = {}) {
    // ...
  },
};
```

## `ParsedGameResult` Shape

Every `parser.parse(rawText, gameContext)` call must return an object matching:

```js
{
  parserId: string,              // e.g. 'wordle', 'cluesbysam', 'generic'
  parserVersion: number,         // integer >= 1
  isCustomParser: boolean,       // true for dedicated parsers, false for 'generic'
  completed: boolean,            // true
  solved: boolean | null,        // true = won/solved, false = failed/DNF, null = open-ended score
  primaryValue: number | null,   // numeric score for charts (seconds, points, guesses, %)
  displayValue: string | null,   // human-readable badge (e.g. "2:14", "4/6", "840", "Played")
  metricFormat: 'number' | 'duration_sec' | 'percent' | 'fraction',
  metricDirection: 'higher_is_better' | 'lower_is_better',
  metricLabel: string,           // e.g. 'Score', 'Solve Time', 'Guesses'
  puzzleId: string | null,       // e.g. '#142' if present, else null
  puzzleDate: string | null,     // 'YYYY-MM-DD' if explicitly present in text, else null
  breakdown: Array<{ label: string, value: number, max?: number | null, display?: string }>,
  metadata: Record<string, any>  // e.g. { emojiGrid: string }
}
```

## 1-Step Registration in `shared/parsers/registry.js`

1. Create `shared/parsers/games/<game>.js` exporting your parser object (e.g. `export const cluesBySamParser = { ... }`).
2. Register it in `shared/parsers/registry.js`:
   ```js
   import { cluesBySamParser } from './games/cluesbysam.js';

   export const PARSERS = [wordleParser, cluesBySamParser];
   ```

Once registered:
- Matching games (`parserId: 'auto'` with matching slug, name, or domain) automatically resolve to your custom parser.
- On server startup (or via `POST /api/games/:id/reparse`), previously logged entries with non-empty `raw_text` and `manual_override = 0` that used `'generic'` or an older `parserVersion` are automatically re-parsed with the new parser.
