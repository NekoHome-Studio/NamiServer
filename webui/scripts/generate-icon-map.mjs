/**
 * One-off generator for the WebUI icon alias map.
 *
 * Vuetify's `mdi-svg` iconset resolves an icon prop as an SVG path. A bare
 * string such as `"mdiSend"` is therefore passed straight through and renders
 * `<path d="mdiSend">` — a blank icon and a console warning, not an error. The
 * only silence-free fix is to map every name used to its real `@mdi/js` path.
 *
 * This script scans the sources for `mdi*` names, confirms each exists in the
 * installed `@mdi/js`, and prints the import list plus alias map to paste into
 * `src/plugins/vuetify.ts`. Run with: node scripts/generate-icon-map.mjs
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SRC = join(ROOT, 'src');
const MDI_ENTRY = join(ROOT, 'node_modules', '@mdi', 'js', 'mdi.js');

if (!existsSync(MDI_ENTRY)) {
  console.error('找不到 @mdi/js，请先在 webui/ 下执行 npm install');
  process.exit(1);
}

const mdi = await import(pathToFileURL(MDI_ENTRY).href);
const available = new Set(Object.keys(mdi));

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, out);
    } else if (/\.(vue|ts)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Names that are placeholders or illustrative, never real props. */
const IGNORE = new Set(['mdiXxx']);

const used = new Set();
for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8');
  // Drop `@mdi/js` import statements so their symbol names are not counted twice.
  const stripped = text.replace(/import\s*\{[^}]*\}\s*from\s*'@mdi\/js'/g, '');
  for (const match of stripped.matchAll(/\bmdi[A-Z][A-Za-z0-9]+\b/g)) {
    if (!IGNORE.has(match[0])) used.add(match[0]);
  }
}

const unknown = [...used].filter((name) => !available.has(name)).sort();
if (unknown.length > 0) {
  console.error(`以下名称在 @mdi/js 中不存在，请改名或从使用处移除：\n  ${unknown.join('\n  ')}`);
  process.exit(1);
}

const names = [...used].sort();

// Emit wrapped import lines so the result stays readable.
const importLines = [];
let current = 'import {';
for (const name of names) {
  if (`${current} ${name},`.length > 96) {
    importLines.push(current);
    current = '  ';
  }
  current += ` ${name},`;
}
current += " } from '@mdi/js';";
importLines.push(current);

const body = [
  '/**',
  ' * AUTO-GENERATED — do not edit by hand.',
  ' *',
  ' * Regenerate with: node scripts/generate-icon-map.mjs',
  ' *',
  ' * Why this file exists: `plugins/vuetify.ts` uses the `mdi-svg` icon set, which',
  ' * treats an icon prop as raw SVG path data. A bare string like "mdiSend" would',
  ' * therefore render `<path d="mdiSend">` — a blank icon and a console warning,',
  ' * never an error. Mapping every name used to its real @mdi/js path is the only',
  ' * way to make that failure impossible rather than merely unlikely.',
  ' *',
  ' * Importing the paths individually (rather than `import * as mdi`) keeps the',
  ' * bundle tree-shaken: only the icons actually referenced ship.',
  ' */',
  '',
  ...importLines,
  '',
  `/** ${names.length} icons currently referenced by the WebUI. */`,
  'export const namiIconAliases: Record<string, string> = {',
  ...names.map((name) => `  ${name},`),
  '};',
  '',
];

const target = join(SRC, 'plugins', 'icons.generated.ts');
writeFileSync(target, body.join('\n'), 'utf8');
console.log(`已写入 ${target}`);
console.log(`共 ${names.length} 个图标`);

