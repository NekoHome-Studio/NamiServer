/**
 * A small, dependency-free JSON Schema validator.
 *
 * Deliberately scoped to the keywords Nami tools actually declare. It rejects
 * rather than coerces, so a malformed model-generated payload produces a clear
 * error the agent can read and correct on its next round.
 */

import type { JsonSchema } from '../core/types.ts';

export interface ValidationIssue {
  path: string;
  message: string;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value: unknown, declared: string): boolean {
  switch (declared) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true; // unknown keyword: never fail closed on a typo in the schema
  }
}

/** Returns every violation found; an empty array means the args are valid. */
export function validateArgs(schema: JsonSchema, args: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  walk(schema, args, 'args', issues);
  return issues;
}

function walk(schema: JsonSchema, value: unknown, path: string, issues: ValidationIssue[]): void {
  if (value === undefined) return;

  const declared = schema.type;
  if (declared !== undefined) {
    const allowed = Array.isArray(declared) ? declared : [declared];
    if (!allowed.some((candidate) => matchesType(value, candidate))) {
      issues.push({
        path,
        message: `expected ${allowed.join(' | ')}, received ${typeOf(value)}`,
      });
      return; // deeper checks would be noise once the type is wrong
    }
  }

  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    issues.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
  }

  if (schema.enum && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    issues.push({
      path,
      message: `must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`,
    });
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ path, message: `must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ path, message: `must be <= ${schema.maximum}` });
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({ path, message: `must be at least ${schema.minLength} characters` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push({ path, message: `must be at most ${schema.maxLength} characters` });
    }
    if (schema.pattern !== undefined) {
      let re: RegExp | null = null;
      try {
        re = new RegExp(schema.pattern);
      } catch {
        re = null; // invalid pattern in the schema definition: skip
      }
      if (re && !re.test(value)) {
        issues.push({ path, message: `must match /${schema.pattern}/` });
      }
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({ path, message: `must contain at least ${schema.minItems} items` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push({ path, message: `must contain at most ${schema.maxItems} items` });
    }
    if (schema.items) {
      value.forEach((item, index) => walk(schema.items as JsonSchema, item, `${path}[${index}]`, issues));
    }
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;

    for (const key of schema.required ?? []) {
      if (record[key] === undefined) {
        issues.push({ path: `${path}.${key}`, message: 'is required' });
      }
    }

    for (const [key, child] of Object.entries(record)) {
      const declaredChild = schema.properties?.[key];
      if (declaredChild) {
        walk(declaredChild, child, `${path}.${key}`, issues);
        continue;
      }
      if (schema.additionalProperties === false) {
        issues.push({ path: `${path}.${key}`, message: 'is not an accepted parameter' });
      } else if (typeof schema.additionalProperties === 'object') {
        walk(schema.additionalProperties, child, `${path}.${key}`, issues);
      }
    }
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Renders issues into a compact, model-readable sentence. */
export function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((issue) => `${issue.path} ${issue.message}`).join('; ');
}
