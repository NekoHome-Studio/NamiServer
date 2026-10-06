/**
 * Serves the built WebUI (Vue + Vuetify) from `src/web/app`.
 *
 * The build output is committed, so a fresh checkout runs with no install and no
 * build step — the same property the rest of the server has. If the directory is
 * missing (someone built from a partial tree), every accessor returns null and
 * the caller falls back to the classic panel rather than 500ing.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(HERE, 'app');

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Matches Vite's hash-suffixed output, e.g. `index-B9-nhqbC.js` or
 * `PageHeader.vue_vue_type_script_setup_true_lang-DDHicWjW.js`.
 *
 * The hash alphabet is base64url, so it contains `-` and `_` as well as
 * alphanumerics — a class of `[A-Za-z0-9_]` silently failed to match real build
 * output, which meant immutable assets were served with `no-cache` and
 * revalidated on every page load.
 */
const HASHED_ASSET = /-[A-Za-z0-9_-]{6,}\.[a-z0-9]+$/;

export interface AppAsset {
  body: Buffer;
  contentType: string;
  /** True for hash-named build output, which is immutable. */
  immutable: boolean;
}

/** Whether a WebUI build is present at all. */
export function appBuildAvailable(): boolean {
  return existsSync(join(APP_DIR, 'index.html'));
}

/**
 * Resolves a request path inside the build directory, requiring exact case at
 * every segment so a Windows-authored build cannot rely on case-insensitivity.
 *
 * @returns the absolute path, or null when it escapes the directory or does not
 *   exist with matching case.
 */
function resolveInApp(relativePath: string): string | null {
  const cleaned = relativePath.replace(/^\/+/, '').split('?')[0] ?? '';
  if (cleaned === '') return join(APP_DIR, 'index.html');

  let current = APP_DIR;
  for (const segment of cleaned.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null; // never allow escaping the build dir
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return null;
    }
    if (!entries.includes(segment)) return null;
    current = join(current, segment);
  }

  try {
    return statSync(current).isFile() ? current : null;
  } catch {
    return null;
  }
}

/** Reads one asset from the build output. */
export function readAppAsset(relativePath: string): AppAsset | null {
  const target = resolveInApp(relativePath);
  if (target === null) return null;

  try {
    const body = readFileSync(target);
    const extension = extname(target).toLowerCase();
    return {
      body,
      contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream',
      // Vite emits `name-<hash>.ext`; those never change for a given build.
      immutable: HASHED_ASSET.test(posix.basename(target)),
    };
  } catch {
    return null;
  }
}

/** The SPA entry document, or null when no build is present. */
export function readAppIndex(): string | null {
  try {
    return readFileSync(join(APP_DIR, 'index.html'), 'utf8');
  } catch {
    return null;
  }
}
