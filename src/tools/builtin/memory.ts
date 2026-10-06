/**
 * Session-scoped key/value memory, persisted in the `kv` table.
 *
 * Scope is the conversation, not the server, so one session can never read
 * another's notes.
 */

import type { Tool } from '../types.ts';

const KEY_SCHEMA = {
  type: 'string' as const,
  description: 'Memory key (letters, digits, dot, dash, underscore).',
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9._-]+$',
};

export const memoryWriteTool: Tool = {
  name: 'memory_write',
  description:
    'Store a value under a key in this session\'s long-term memory. ' +
    'Overwrites any previous value for the same key.',
  danger: 'safe',
  parameters: {
    type: 'object',
    properties: {
      key: KEY_SCHEMA,
      value: {
        description: 'Any JSON value to remember (string, number, object, array).',
      },
    },
    required: ['key', 'value'],
    additionalProperties: false,
  },
  run(args, context) {
    const key = String(args.key);
    context.store.kvSet(context.sessionId, key, args.value);
    return { stored: true, key, sessionId: context.sessionId };
  },
};

export const memoryReadTool: Tool = {
  name: 'memory_read',
  description: 'Read a value previously stored with memory_write in this session.',
  danger: 'safe',
  parameters: {
    type: 'object',
    properties: { key: KEY_SCHEMA },
    required: ['key'],
    additionalProperties: false,
  },
  run(args, context) {
    const key = String(args.key);
    const value = context.store.kvGet(context.sessionId, key);
    if (value === undefined) {
      return { found: false, key, note: 'No value is stored under this key.' };
    }
    return { found: true, key, value };
  },
};

export const memoryListTool: Tool = {
  name: 'memory_list',
  description: 'List every key currently stored in this session\'s memory.',
  danger: 'safe',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  run(_args, context) {
    const all = context.store.kvList(context.sessionId);
    return { keys: Object.keys(all), entries: all };
  },
};

export const memoryDeleteTool: Tool = {
  name: 'memory_delete',
  description: 'Delete a key from this session\'s memory.',
  danger: 'caution',
  parameters: {
    type: 'object',
    properties: { key: KEY_SCHEMA },
    required: ['key'],
    additionalProperties: false,
  },
  run(args, context) {
    const key = String(args.key);
    const deleted = context.store.kvDelete(context.sessionId, key);
    return { deleted, key };
  },
};

export const memoryTools: Tool[] = [
  memoryWriteTool,
  memoryReadTool,
  memoryListTool,
  memoryDeleteTool,
];
