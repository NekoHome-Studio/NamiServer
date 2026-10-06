/**
 * Filesystem tools.
 *
 * Disabled by default. When enabled they are confined to an explicit list of
 * roots, and containment is re-checked after `realpath` so a symlink inside an
 * allowed root cannot be used to escape it.
 */

import { readdirSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Config } from '../../config.ts';
import type { Tool } from '../types.ts';

/** Normalises the configured roots once, resolving symlinks where possible. */
export function resolveRoots(roots: string[]): string[] {
  return roots.map((root) => {
    const absolute = resolve(root);
    try {
      return realpathSync(absolute);
    } catch {
      return absolute;
    }
  });
}

function isInside(target: string, root: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Resolves a user-supplied path and proves it stays inside an allowed root.
 *
 * @throws when the path escapes, or when no roots are configured.
 */
export function resolveInRoots(input: string, roots: string[]): string {
  if (roots.length === 0) {
    throw new Error('no filesystem roots are configured (set NAMI_TOOL_FS_ALLOW_ROOTS)');
  }
  if (input.includes('\0')) throw new Error('path contains a null byte');

  const candidate = resolve(input);
  let resolved = candidate;
  try {
    resolved = realpathSync(candidate);
  } catch {
    // The path may not exist yet; containment is still checked on the literal form.
  }

  const ok = roots.some((root) => isInside(resolved, root) || isInside(candidate, root));
  if (!ok) {
    throw new Error(
      `path "${input}" resolves outside the allowed roots (${roots.join(', ')})`,
    );
  }
  return resolved;
}

export function createFsTools(config: Config): Tool[] {
  const roots = resolveRoots(config.tools.fsAllowRoots);
  const enabled = config.tools.fsEnabled && roots.length > 0;
  const maxBytes = config.tools.fsMaxBytes;

  const readTool: Tool = {
    name: 'fs_read',
    description:
      'Read a UTF-8 text file from the server filesystem. Access is limited to the ' +
      'configured root directories.',
    danger: 'caution',
    enabled,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path, absolute or relative to the server working directory.',
          minLength: 1,
          maxLength: 1024,
        },
        offset: {
          type: 'integer',
          description: 'Byte offset to start reading from.',
          minimum: 0,
        },
        maxBytes: {
          type: 'integer',
          description: 'Maximum number of bytes to read.',
          minimum: 64,
          maximum: Math.max(64, maxBytes),
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async run(args) {
      const target = resolveInRoots(String(args.path), roots);
      const stats = statSync(target);
      if (stats.isDirectory()) {
        throw new Error(`"${target}" is a directory; use fs_list instead`);
      }
      const offset = Math.max(0, Number(args.offset ?? 0) || 0);
      const limit = Math.min(Number(args.maxBytes ?? maxBytes) || maxBytes, maxBytes);

      const handle = await readFile(target);
      const slice = handle.subarray(offset, offset + limit);
      return {
        path: target,
        sizeBytes: stats.size,
        offset,
        returnedBytes: slice.byteLength,
        truncated: offset + slice.byteLength < stats.size,
        content: slice.toString('utf8'),
      };
    },
  };

  const listTool: Tool = {
    name: 'fs_list',
    description:
      'List the entries of a directory on the server filesystem, within the ' +
      'configured root directories.',
    danger: 'caution',
    enabled,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path.', minLength: 1, maxLength: 1024 },
        recursive: { type: 'boolean', description: 'Walk subdirectories (max 500 entries).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    run(args) {
      const target = resolveInRoots(String(args.path), roots);
      const stats = statSync(target);
      if (!stats.isDirectory()) throw new Error(`"${target}" is not a directory`);

      const recursive = args.recursive === true;
      const entries: Array<{ path: string; type: string; sizeBytes: number }> = [];
      const LIMIT = 500;

      const walk = (dir: string): void => {
        if (entries.length >= LIMIT) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entries.length >= LIMIT) return;
          const full = `${dir}${sep}${entry.name}`;
          if (entry.isDirectory()) {
            entries.push({ path: full, type: 'directory', sizeBytes: 0 });
            if (recursive) walk(full);
          } else {
            let size = 0;
            try {
              size = statSync(full).size;
            } catch {
              size = 0;
            }
            entries.push({ path: full, type: 'file', sizeBytes: size });
          }
        }
      };

      walk(target);
      return { path: target, count: entries.length, truncated: entries.length >= LIMIT, entries };
    },
  };

  return [readTool, listTool];
}
