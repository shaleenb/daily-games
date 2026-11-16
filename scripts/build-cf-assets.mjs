import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const SHARED_DIR = path.join(PROJECT_ROOT, 'shared');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const DIST_SHARED_DIR = path.join(DIST_DIR, 'shared');

function filterCopy(src) {
  return path.basename(src) !== '.DS_Store';
}

export function buildCfAssets() {
  if (!fs.existsSync(PUBLIC_DIR)) {
    throw new Error(`Missing public directory: ${PUBLIC_DIR}`);
  }
  if (!fs.existsSync(SHARED_DIR)) {
    throw new Error(`Missing shared directory: ${SHARED_DIR}`);
  }

  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  fs.cpSync(PUBLIC_DIR, DIST_DIR, { recursive: true, filter: filterCopy });
  fs.cpSync(SHARED_DIR, DIST_SHARED_DIR, { recursive: true, filter: filterCopy });

  const requiredFiles = [
    path.join(DIST_DIR, 'index.html'),
    path.join(DIST_SHARED_DIR, 'parsers', 'registry.js'),
    path.join(DIST_SHARED_DIR, 'stats.js'),
    path.join(DIST_SHARED_DIR, 'auth-crypto.js'),
  ];

  for (const filePath of requiredFiles) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Expected built asset missing: ${filePath}`);
    }
  }

  return { distDir: DIST_DIR, distSharedDir: DIST_SHARED_DIR };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const { distDir } = buildCfAssets();
  console.log(`Built Cloudflare static assets in ${distDir}`);
}
