/**
 * Static asset loaders for the two built-in web pages.
 *
 * Both are single self-contained HTML files kept next to this module so they can
 * be edited without a build step. If one is missing — a partial deployment —
 * a minimal fallback page is served instead of failing the route.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const PANEL_FALLBACK = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nami · Agent Server</title>
<style>
 body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
      background:#0b0e14;color:#d7dce5;margin:0;padding:48px;line-height:1.6}
 code{font-family:ui-monospace,Consolas,monospace;background:#161b24;padding:2px 6px;border-radius:4px}
 h1{font-size:20px;margin:0 0 4px} p{color:#8b94a3}
 .warn{background:#241a12;border:1px solid #6b4a1f;color:#f0b866;padding:12px 16px;border-radius:8px;margin:20px 0}
 li{margin:4px 0}
</style></head><body>
<h1>🌊 Nami · Agent Server</h1>
<p>服务器正在运行，但管理面板文件 <code>src/web/panel.html</code> 缺失。</p>
<div class="warn">请恢复该文件后刷新本页，即可使用完整的可视化管理面板。</div>
<p>在此之前，可访问 <a href="/docs" style="color:#5fb3ff">/docs</a> 查看 API 参考，或直接调用：</p>
<ul>
 <li><code>GET /healthz</code> · <code>GET /readyz</code></li>
 <li><code>GET /v1/models</code> · <code>POST /v1/chat/completions</code></li>
 <li><code>POST /v1/agent/run</code> (SSE 事件流)</li>
 <li><code>GET /admin/api/overview</code> · <code>/admin/api/models</code> · <code>/admin/api/tools</code></li>
</ul>
</body></html>`;

const DOCS_FALLBACK = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nami · API</title>
<style>
 body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
      background:#0b0e14;color:#d7dce5;margin:0;padding:48px;line-height:1.6}
 code{font-family:ui-monospace,Consolas,monospace;background:#161b24;padding:2px 6px;border-radius:4px}
 h1{font-size:20px;margin:0 0 4px} p{color:#8b94a3}
 .warn{background:#241a12;border:1px solid #6b4a1f;color:#f0b866;padding:12px 16px;border-radius:8px;margin:20px 0}
</style></head><body>
<h1>🌊 Nami · API 参考</h1>
<p>文档页文件 <code>src/web/docs.html</code> 缺失，但机器可读的规范仍然可用。</p>
<div class="warn"><a href="/openapi.json" style="color:#5fb8ff">/openapi.json</a> — 完整的 OpenAPI 3.1 规范。</div>
</body></html>`;

const cache = new Map<string, string>();

function loadStatic(file: string, fallback: string): string {
  const cached = cache.get(file);
  if (cached !== undefined) return cached;
  let html: string;
  try {
    html = readFileSync(join(HERE, file), 'utf8');
  } catch {
    html = fallback;
  }
  cache.set(file, html);
  return html;
}

/** Admin panel HTML (`/admin`). */
export function getPanelHtml(): string {
  return loadStatic('panel.html', PANEL_FALLBACK);
}

/** API reference HTML (`/docs`). */
export function getDocsHtml(): string {
  return loadStatic('docs.html', DOCS_FALLBACK);
}
