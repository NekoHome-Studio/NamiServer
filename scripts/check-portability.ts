/**
 * Cross-platform portability check.
 *
 * Nami is developed on Windows but primarily deployed on Linux (the Docker image
 * is `node:24-alpine`). The failure modes that differ between the two are
 * narrow and specific, so they are worth pinning down mechanically rather than
 * by hoping:
 *
 *   1. **Case-sensitive module resolution.** Windows resolves `./Types.ts` to
 *      `types.ts`; Linux does not. This is the classic "works on my machine"
 *      break for Node ESM projects, and it stays invisible until deploy.
 *   2. **Case-sensitive asset references.** The same trap for `./app.js`,
 *      `panel.html`, `logo.png` and friends.
 *   3. **Windows-only assumptions.** Drive letters, backslash literals, and
 *      `process.platform` special-casing that becomes dead code on Linux.
 *   4. **CRLF line endings.** Harmless to the TS parser, fatal to a shebang, and
 *      a nuisance in Dockerfiles.
 *   5. **Linux-hostile container instructions.**
 *
 * Run with: npm run check:portability
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), '..');

const COLOR = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const C = {
  reset: COLOR ? '\x1b[0m' : '',
  bold: COLOR ? '\x1b[1m' : '',
  dim: COLOR ? '\x1b[2m' : '',
  green: COLOR ? '\x1b[32m' : '',
  red: COLOR ? '\x1b[31m' : '',
  yellow: COLOR ? '\x1b[33m' : '',
  cyan: COLOR ? '\x1b[36m' : '',
};

interface Problem {
  file: string;
  line: number;
  message: string;
}

const problems: Problem[] = [];
let checks = 0;

function fail(file: string, line: number, message: string): void {
  problems.push({ file: relative(ROOT, file).split(sep).join('/'), line, message });
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.npm-cache',
  'data',
  'dist',
  '__pycache__',
  '.venv',
  'venv',
]);

/** Files with no informative extension that still must be LF. */
const EXACT_TEXT_FILES = new Set([
  'Dockerfile',
  '.env.example',
  '.gitattributes',
  '.gitignore',
  '.npmrc',
  '.dockerignore',
]);

/** Files scanned for Windows-isms and CRLF. */
const CODE_EXT = ['.ts', '.mjs', '.cjs', '.js', '.py'];
const TEXT_EXT = [...CODE_EXT, '.json', '.yaml', '.yml', '.html', '.css', '.md', '.example', '.txt'];

function walk(dir: string, wanted: (name: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), wanted, out);
      continue;
    }
    if (wanted(entry.name)) out.push(join(dir, entry.name));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 1. Case-exact module resolution
 * ------------------------------------------------------------------ */

/**
 * Resolves a relative specifier requiring EXACT case at every segment.
 *
 * `existsSync` is not enough: on Windows (and on a case-insensitive macOS
 * volume) it accepts a wrongly-cased path, which then fails on Linux.
 */
function resolvesWithExactCase(fromDir: string, specifier: string): boolean {
  let current = fromDir;

  for (const part of specifier.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      current = dirname(current);
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return false;
    }
    if (!entries.includes(part)) return false;
    current = join(current, part);
  }

  return existsSync(current);
}

const SPECIFIER = /['"](\.[^'"]*\.(?:ts|js|mjs|cjs|json))['"]/g;

function checkModuleCase(file: string, source: string): void {
  const fromDir = dirname(file);

  source.split(/\r?\n/).forEach((text, index) => {
    SPECIFIER.lastIndex = 0;
    let match = SPECIFIER.exec(text);
    while (match !== null) {
      const specifier = match[1] as string;
      checks += 1;
      if (!resolvesWithExactCase(fromDir, specifier)) {
        const loose = resolve(fromDir, specifier);
        fail(
          file,
          index + 1,
          existsSync(loose)
            ? `模块路径大小写不匹配 "${specifier}"（Windows 能解析，Linux 会失败）`
            : `模块路径不存在 "${specifier}"`,
        );
      }
      match = SPECIFIER.exec(text);
    }
  });
}

/* ------------------------------------------------------------------ *
 * 2. Case-exact asset references
 * ------------------------------------------------------------------ */

/** Every file name present in the tree, used to catch case-only mismatches. */
function collectBasenames(): Set<string> {
  const names = new Set<string>();
  const stack = [ROOT];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(join(dir, entry.name));
      } else {
        names.add(entry.name);
      }
    }
  }
  return names;
}

const BARE_ASSET = /['"]([A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:html|css|png|yaml|yml))['"]/g;

function checkAssetCase(file: string, source: string, basenames: Set<string>): void {
  source.split(/\r?\n/).forEach((text, index) => {
    // Skip the checker's own rule text; it contains sample file names.
    BARE_ASSET.lastIndex = 0;
    let match = BARE_ASSET.exec(text);
    while (match !== null) {
      const name = match[1] as string;
      checks += 1;
      if (!basenames.has(name)) {
        // A same-name-different-case file is the dangerous case; a truly absent
        // one is merely a stale reference.
        const caseOnly = [...basenames].find((n) => n.toLowerCase() === name.toLowerCase());
        fail(
          file,
          index + 1,
          caseOnly
            ? `资源名大小写不匹配 "${name}"（实际文件是 "${caseOnly}"，Linux 上会 404）`
            : `引用的资源不存在 "${name}"`,
        );
      }
      match = BARE_ASSET.exec(text);
    }
  });
}

/** Relative refs inside HTML: `./app.js`, `style.css`. */
const HTML_ASSET = /(?:src|href)\s*=\s*["']([^"'#?][^"']*)["']/g;

function checkHtmlAssets(file: string, source: string): void {
  const dir = dirname(file);
  source.split(/\r?\n/).forEach((text, index) => {
    HTML_ASSET.lastIndex = 0;
    let match = HTML_ASSET.exec(text);
    while (match !== null) {
      const ref = (match[1] as string).trim();
      if (ref === '' || ref.startsWith('data:') || /^[a-z]+:/i.test(ref)) {
        match = HTML_ASSET.exec(text);
        continue;
      }
      checks += 1;
      if (!resolvesWithExactCase(dir, ref.replace(/^\.\//, ''))) {
        const loose = resolve(dir, ref);
        fail(
          file,
          index + 1,
          existsSync(loose)
            ? `HTML 资源大小写不匹配 "${ref}"`
            : `HTML 引用的资源不存在 "${ref}"`,
        );
      }
      match = HTML_ASSET.exec(text);
    }
  });
}

/* ------------------------------------------------------------------ *
 * 3. Windows-isms
 * ------------------------------------------------------------------ */

const WINDOWSISMS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /['"][A-Za-z]:[\\/]{1,2}[^'"]*['"]/, message: '硬编码的 Windows 盘符路径' },
  { pattern: /path\.win32/, message: '直接使用了 path.win32' },
  {
    pattern: /process\.platform\s*===?\s*['"]win32['"]/,
    message: '对 win32 做了特殊分支（Linux 上这段永远不会执行）',
  },
  { pattern: /LOCALAPPDATA|APPDATA/, message: '引用了 Windows 专有环境变量' },
  { pattern: /\bos\.EOL\b/, message: '依赖 os.EOL（跨平台会产生不同输出）' },
  // A backslash *between* path-ish characters, e.g. `foo\bar`. Deliberately
  // narrow: regex escapes like `\\$&` and `[\\/]` are not paths.
  {
    pattern: /['"][^'"]*[A-Za-z0-9_-]\\\\[A-Za-z0-9_-][^'"]*['"]/,
    message: '字符串里的 Windows 反斜杠路径',
  },
];

/**
 * Escape hatch for the heuristics below.
 *
 * Any pattern-matching linter needs one: asserting that a Windows-style path is
 * *rejected* is legitimate code that looks exactly like the thing being banned.
 * Append `portability-ok` in a comment on the line.
 */
const SUPPRESS = /portability-ok/;

function checkWindowsisms(file: string, source: string): void {
  source.split(/\r?\n/).forEach((text, index) => {
    if (SUPPRESS.test(text)) return;
    const code = text.replace(/\/\/.*$/, '').replace(/^\s*[#*].*$/, '');
    if (code.trim() === '') return;
    for (const { pattern, message } of WINDOWSISMS) {
      if (pattern.test(code)) {
        checks += 1;
        fail(file, index + 1, `${message}：${text.trim().slice(0, 90)}`);
      }
    }
  });
}

/* ------------------------------------------------------------------ *
 * 4. Line endings
 * ------------------------------------------------------------------ */

function checkLineEndings(file: string, source: string): void {
  checks += 1;
  if (source.includes('\r\n')) {
    fail(file, 0, '包含 CRLF 换行（Linux 上 Dockerfile / shebang 会出问题，建议统一 LF）');
  }
}

/* ------------------------------------------------------------------ *
 * 5. Dockerfile and package.json
 * ------------------------------------------------------------------ */

function checkDockerfile(): void {
  const path = join(ROOT, 'Dockerfile');
  if (!existsSync(path)) {
    fail(path, 0, '缺少 Dockerfile');
    return;
  }
  const source = readFileSync(path, 'utf8');

  checks += 1;
  if (!/^FROM\s+\S*(alpine|linux)/m.test(source)) {
    fail(path, 0, '基础镜像看起来不是 Linux 镜像');
  }

  source.split(/\r?\n/).forEach((text, index) => {
    const code = text.replace(/#.*$/, '');
    if (code.trim() === '') return;
    checks += 1;
    // A trailing backslash is a legitimate line continuation; anything else is not.
    if (code.replace(/\\\s*$/, '').includes('\\')) {
      fail(path, index + 1, 'Dockerfile 里出现非续行的反斜杠');
    }
    if (/^\s*(COPY|ADD)\s+[A-Za-z]:/i.test(code)) fail(path, index + 1, 'COPY 使用了 Windows 盘符路径');
    if (/cmd\.exe|powershell/i.test(code)) fail(path, index + 1, 'Dockerfile 调用了 Windows 命令');
  });

  // Alpine's BusyBox adduser/addgroup take different flags than Debian's.
  checks += 1;
  if (/\badduser\b/.test(source) && !/-[SG]\b/.test(source)) {
    fail(path, 0, 'adduser 未使用 BusyBox 风格参数（alpine 基础镜像）');
  }
}

function checkPackageJson(): void {
  const path = join(ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8')) as {
    engines?: { node?: string };
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
  };

  checks += 1;
  if (!pkg.engines?.node) fail(path, 0, '未声明 engines.node');

  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    checks += 1;
    // POSIX-only shell on Linux: Windows built-ins would break there.
    if (/\b(set|copy|xcopy|del|rd|md)\s+\w/i.test(command) && !/\bnode\b|\btsc\b/.test(command)) {
      fail(path, 0, `npm script "${name}" 可能只在 Windows shell 下可用：${command}`);
    }
  }

  checks += 1;
  if (Object.keys(pkg.dependencies ?? {}).length > 0) {
    // Zero runtime dependencies is also a portability guarantee: no native
    // builds, no prebuilt binaries, so alpine/musl and arm64 just work.
    fail(path, 0, '存在运行时依赖（会削弱跨平台/跨架构的可移植性保证）');
  }
}

/** The AstrBot plugin ships separately but must survive a Linux checkout too. */
function checkPythonPlugin(): void {
  const dir = join(ROOT, 'integrations');
  if (!existsSync(dir)) return;

  const pythons = walk(dir, (name) => name.endsWith('.py'));
  checks += 1;
  if (pythons.length === 0) return;

  for (const file of pythons) {
    const source = readFileSync(file, 'utf8');
    checkLineEndings(file, source);
    checkWindowsisms(file, source);
  }

  // The plugin's own file references must match on disk exactly.
  const selftest = join(dir, 'selftest_plugin_nami.py');
  if (existsSync(selftest)) {
    const source = readFileSync(selftest, 'utf8');
    const REF = /PLUGIN_DIR\s*\/\s*"([^"]+)"/g;
    const pluginDir = join(dir, 'astrbot_plugin_nami');
    let match = REF.exec(source);
    while (match !== null) {
      checks += 1;
      const name = match[1] as string;
      if (!resolvesWithExactCase(pluginDir, name)) {
        fail(selftest, 0, `自检引用的插件文件大小写/名称不匹配："${name}"`);
      }
      match = REF.exec(source);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

function main(): void {
  process.stdout.write(`${C.bold}🌊 Nami · 跨平台可移植性检查${C.reset}\n`);
  process.stdout.write(
    `${C.dim}开发在 Windows，部署在 Linux（Dockerfile 基于 node:24-alpine）${C.reset}\n\n`,
  );

  const sources = walk(ROOT, (name) => CODE_EXT.some((ext) => name.endsWith(ext)));
  const texts = walk(ROOT, (name) => {
    if (EXACT_TEXT_FILES.has(name)) return true;
    return TEXT_EXT.some((ext) => name.endsWith(ext));
  });

  process.stdout.write(
    `${C.dim}扫描 ${sources.length} 个源文件、${texts.length} 个文本文件…${C.reset}\n`,
  );

  const basenames = collectBasenames();

  for (const file of texts) {
    const source = readFileSync(file, 'utf8');
    if (file !== SELF) checkLineEndings(file, source);
  }

  for (const file of sources) {
    // A linter must not lint its own rule definitions; the sample patterns and
    // example file names inside this file are not real references.
    if (file === SELF) continue;
    const source = readFileSync(file, 'utf8');
    if (file.endsWith('.ts') || file.endsWith('.js') || file.endsWith('.mjs')) {
      checkModuleCase(file, source);
      checkAssetCase(file, source, basenames);
    }
    if (file.endsWith('.html')) checkHtmlAssets(file, source);
    checkWindowsisms(file, source);
  }

  checkDockerfile();
  checkPackageJson();
  checkPythonPlugin();

  if (problems.length === 0) {
    process.stdout.write(
      `\n${C.green}${C.bold}✓ 通过${C.reset}  ${checks} 项检查，未发现阻碍 Linux 运行的问题\n` +
        `${C.dim}注意：静态检查不能替代在真实 Linux 上跑一遍 npm test（见 HANDOVER.md）${C.reset}\n\n`,
    );
    process.exit(0);
  }

  process.stdout.write(`\n${C.red}${C.bold}✗ ${problems.length} 个问题${C.reset} / 共 ${checks} 项检查\n\n`);
  for (const problem of problems) {
    const where = problem.line > 0 ? `${problem.file}:${problem.line}` : problem.file;
    process.stdout.write(`  ${C.red}✗${C.reset} ${C.cyan}${where}${C.reset} ${problem.message}\n`);
  }
  process.stdout.write('\n');
  process.exit(1);
}

main();
