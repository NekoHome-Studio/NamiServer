/**
 * Trivial, always-safe builtins: `echo` and `now`.
 */

import type { Tool } from '../types.ts';

export const echoTool: Tool = {
  name: 'echo',
  description: 'Return the given text unchanged. Useful for verifying the tool pipeline.',
  danger: 'safe',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to echo back.', maxLength: 4096 },
    },
    required: ['text'],
    additionalProperties: false,
  },
  run(args) {
    const text = String(args.text ?? '');
    return { echo: text, length: text.length };
  },
};

export const nowTool: Tool = {
  name: 'now',
  description:
    'Return the current server time as ISO 8601, epoch milliseconds, UTC string, ' +
    'local string and IANA time zone name.',
  danger: 'safe',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  run() {
    const now = new Date();
    return {
      iso: now.toISOString(),
      epochMs: now.getTime(),
      utc: now.toUTCString(),
      local: now.toString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  },
};
