/**
 * Configuration endpoints backing the WebUI's config editor.
 *
 *   GET  /admin/api/config/schema   every editable setting, typed and described
 *   PUT  /admin/api/config          validate and write `.env`
 *
 * Writing config from a browser is a sharp tool, so three rules apply:
 *
 *   1. **Explicit confirmation.** A write must carry `confirm: true`; a stray
 *      request body cannot silently rewrite the environment.
 *   2. **No secret ever comes back.** Secrets are read as `null`, and the
 *      `applied` list masks their new value. An operator can set a key without
 *      the API ever echoing it.
 *   3. **Validated, not coerced.** A bad value is rejected with a reason rather
 *      than being silently reinterpreted.
 *
 * Nothing here hot-reloads: `loadConfig` runs once at boot, so every field is
 * reported as `restartRequired` and the response says so plainly.
 */

import { accessSync, constants, writeFileSync } from 'node:fs';
import type { AppDeps } from '../app.ts';
import {
  CONFIG_FIELD_BY_KEY,
  CONFIG_GROUPS,
  describeConfig,
  validateConfigValue,
} from '../config-schema.ts';
import { isWritableEnvKey, readEnvFile, upsertEnv } from '../env-file.ts';
import { asObject } from '../http/body.ts';
import type { Router } from '../http/router.ts';
import { HttpError, sendJson } from '../http/response.ts';

export function registerConfigRoutes(router: Router, deps: AppDeps): void {
  const { config, log } = deps;

  router.get('/admin/api/config/schema', (ctx) => {
    let exists = false;
    let writable = false;
    try {
      accessSync(config.envPath, constants.F_OK);
      exists = true;
    } catch {
      exists = false;
    }
    try {
      // Creation is legal, so writability is judged on the containing behaviour:
      // an existing file must be writable; a missing one is created on write.
      if (exists) accessSync(config.envPath, constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }

    sendJson(ctx.res, 200, {
      object: 'config.schema',
      groups: CONFIG_GROUPS,
      fields: describeConfig(config),
      envFile: { path: config.envPath, exists, writable },
      note: '所有修改都写入 .env，需要重启 Nami 才会生效（本服务不做热重载）。',
    });
  });

  router.put('/admin/api/config', (ctx) => {
    const body = asObject(ctx.body);

    if (body.confirm !== true) {
      throw new HttpError(
        400,
        'Refusing to write configuration without "confirm": true.',
        'confirmation_required',
      );
    }

    const rawChanges = body.changes;
    if (rawChanges === undefined || rawChanges === null || typeof rawChanges !== 'object' || Array.isArray(rawChanges)) {
      throw new HttpError(400, 'Field "changes" must be an object of key/value pairs.', 'invalid_changes');
    }

    const entries = Object.entries(rawChanges as Record<string, unknown>);
    if (entries.length === 0) {
      throw new HttpError(400, 'Field "changes" must not be empty.', 'empty_changes');
    }
    if (entries.length > 200) {
      throw new HttpError(400, 'Too many changes in one request (max 200).', 'too_many_changes');
    }

    const updates: Record<string, string> = {};
    const errors: Array<{ key: string; message: string }> = [];

    for (const [key, rawValue] of entries) {
      if (!isWritableEnvKey(key)) {
        errors.push({ key, message: '只有 NAMI_* 开头的配置项可以修改' });
        continue;
      }
      const field = CONFIG_FIELD_BY_KEY.get(key);
      if (!field) {
        errors.push({ key, message: '未知的配置项' });
        continue;
      }
      if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') {
        errors.push({ key, message: '值必须是字符串、数字或布尔' });
        continue;
      }
      const checked = validateConfigValue(field, String(rawValue));
      if (!checked.ok) {
        errors.push({ key, message: checked.message });
        continue;
      }
      updates[key] = checked.value;
    }

    if (errors.length > 0) {
      throw new HttpError(400, 'Some settings were rejected; nothing was written.', 'invalid_config', errors);
    }

    const existing = readEnvFile(config.envPath);
    let result;
    try {
      result = upsertEnv(existing, updates);
    } catch (error) {
      throw new HttpError(
        500,
        `Failed to apply configuration: ${error instanceof Error ? error.message : String(error)}`,
        'config_write_failed',
      );
    }

    try {
      writeFileSync(config.envPath, result.content, 'utf8');
    } catch (error) {
      throw new HttpError(
        500,
        `Could not write ${config.envPath}: ${error instanceof Error ? error.message : String(error)}. ` +
          'Check that the process owns the file and its directory.',
        'config_write_failed',
      );
    }

    // Secret values are masked in the response, so the API never echoes one back.
    const applied = result.applied.map((change) => {
      const field = CONFIG_FIELD_BY_KEY.get(change.key);
      return {
        key: change.key,
        from: field?.secret ? (change.from === null ? null : '***') : change.from,
        to: field?.secret ? '***' : change.to,
        secret: field?.secret === true,
      };
    });

    log.info('configuration updated via the WebUI', {
      path: config.envPath,
      keys: result.applied.map((change) => change.key),
    });

    sendJson(ctx.res, 200, {
      object: 'config.saved',
      written: config.envPath,
      applied,
      // Stated explicitly rather than left for the operator to discover.
      restartRequired: true,
      note: `已写入 ${config.envPath}。重启 Nami 后生效。`,
    });
  });
}
