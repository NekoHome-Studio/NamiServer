/**
 * Calculator tool backed by a hand-written recursive-descent evaluator.
 *
 * `eval` / `new Function` are never used: the input is parsed into a token
 * stream and folded with an explicit grammar, so arbitrary code cannot execute.
 */

import type { Tool } from '../types.ts';

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'ident'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'comma' };

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
};

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  trunc: Math.trunc,
  sign: Math.sign,
  exp: Math.exp,
  ln: Math.log,
  log10: Math.log10,
  log2: Math.log2,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  min: (...args) => Math.min(...args),
  max: (...args) => Math.max(...args),
  pow: (base, exponent) => (base ?? 0) ** (exponent ?? 0),
};

const ARITY: Record<string, [number, number]> = {
  min: [1, Infinity],
  max: [1, Infinity],
  pow: [2, 2],
};

const OP_CHARS = '+-*/%^';

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index] as string;

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1;
      continue;
    }

    if (char >= '0' && char <= '9') {
      let end = index;
      while (end < input.length && /[0-9._]/.test(input[end] as string)) end += 1;
      // Scientific notation: 1e3, 2.5e-4
      if (input[end] === 'e' || input[end] === 'E') {
        let expEnd = end + 1;
        if (input[expEnd] === '+' || input[expEnd] === '-') expEnd += 1;
        if (expEnd < input.length && /[0-9]/.test(input[expEnd] as string)) {
          while (expEnd < input.length && /[0-9]/.test(input[expEnd] as string)) expEnd += 1;
          end = expEnd;
        }
      }
      const raw = input.slice(index, end).replace(/_/g, '');
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`invalid number "${raw}"`);
      tokens.push({ kind: 'num', value });
      index = end;
      continue;
    }

    if (/[a-zA-Z_]/.test(char)) {
      let end = index;
      while (end < input.length && /[a-zA-Z0-9_]/.test(input[end] as string)) end += 1;
      tokens.push({ kind: 'ident', value: input.slice(index, end).toLowerCase() });
      index = end;
      continue;
    }

    if (OP_CHARS.includes(char)) {
      tokens.push({ kind: 'op', value: char });
      index += 1;
      continue;
    }
    if (char === '(') {
      tokens.push({ kind: 'lparen' });
      index += 1;
      continue;
    }
    if (char === ')') {
      tokens.push({ kind: 'rparen' });
      index += 1;
      continue;
    }
    if (char === ',') {
      tokens.push({ kind: 'comma' });
      index += 1;
      continue;
    }

    throw new Error(`unexpected character "${char}" at position ${index}`);
  }

  return tokens;
}

/** Evaluates an arithmetic expression. @throws on malformed input. */
export function evaluateExpression(input: string): number {
  if (input.length > 512) throw new Error('expression is too long (max 512 characters)');
  const tokens = tokenize(input);
  if (tokens.length === 0) throw new Error('expression is empty');

  let position = 0;
  const peek = (): Token | undefined => tokens[position];
  const next = (): Token | undefined => tokens[position++];

  function parseExpression(): number {
    let left = parseTerm();
    for (;;) {
      const token = peek();
      if (token?.kind === 'op' && (token.value === '+' || token.value === '-')) {
        next();
        const right = parseTerm();
        left = token.value === '+' ? left + right : left - right;
      } else {
        return left;
      }
    }
  }

  function parseTerm(): number {
    let left = parseUnary();
    for (;;) {
      const token = peek();
      if (token?.kind === 'op' && (token.value === '*' || token.value === '/' || token.value === '%')) {
        next();
        const right = parseUnary();
        if ((token.value === '/' || token.value === '%') && right === 0) {
          throw new Error('division by zero');
        }
        left = token.value === '*' ? left * right : token.value === '/' ? left / right : left % right;
      } else {
        return left;
      }
    }
  }

  function parseUnary(): number {
    const token = peek();
    if (token?.kind === 'op' && (token.value === '-' || token.value === '+')) {
      next();
      const value = parseUnary();
      return token.value === '-' ? -value : value;
    }
    return parsePower();
  }

  function parsePower(): number {
    const base = parsePrimary();
    const token = peek();
    if (token?.kind === 'op' && token.value === '^') {
      next();
      // Right-associative, and the exponent may itself be signed: 2^-1
      return base ** parseUnary();
    }
    return base;
  }

  function parsePrimary(): number {
    const token = next();
    if (!token) throw new Error('unexpected end of expression');

    if (token.kind === 'num') return token.value;

    if (token.kind === 'lparen') {
      const value = parseExpression();
      const close = next();
      if (close?.kind !== 'rparen') throw new Error('missing closing parenthesis');
      return value;
    }

    if (token.kind === 'ident') {
      const name = token.value;
      if (peek()?.kind === 'lparen') {
        next(); // consume '('
        const args: number[] = [];
        if (peek()?.kind !== 'rparen') {
          args.push(parseExpression());
          while (peek()?.kind === 'comma') {
            next();
            args.push(parseExpression());
          }
        }
        const close = next();
        if (close?.kind !== 'rparen') throw new Error(`missing closing parenthesis after ${name}(`);

        const fn = FUNCTIONS[name];
        if (!fn) throw new Error(`unknown function "${name}"`);
        const [minArgs, maxArgs] = ARITY[name] ?? [1, 1];
        if (args.length < minArgs || args.length > maxArgs) {
          throw new Error(
            `function "${name}" expects ${minArgs === maxArgs ? minArgs : `${minArgs}-${maxArgs}`} argument(s), received ${args.length}`,
          );
        }
        return fn(...args);
      }

      const constant = CONSTANTS[name];
      if (constant === undefined) throw new Error(`unknown identifier "${name}"`);
      return constant;
    }

    throw new Error('unexpected token in expression');
  }

  const result = parseExpression();
  if (position < tokens.length) throw new Error('unexpected trailing input');
  if (!Number.isFinite(result)) throw new Error('result is not a finite number');

  // Round away binary floating-point dust (0.1 + 0.2 -> 0.3).
  return Math.abs(result) < 1e15 ? Number(result.toPrecision(12)) : result;
}

export const calcTool: Tool = {
  name: 'calc',
  description:
    'Evaluate an arithmetic expression safely. Supports + - * / % ^, parentheses, ' +
    'constants (pi, e, tau) and functions (sqrt, abs, round, floor, ceil, exp, ln, log10, ' +
    'log2, sin, cos, tan, min, max, pow). Example: "12*(3+4)^2".',
  danger: 'safe',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'The expression to evaluate, e.g. "sqrt(16) + 2^10".',
        minLength: 1,
        maxLength: 512,
      },
    },
    required: ['expression'],
    additionalProperties: false,
  },
  run(args) {
    const expression = String(args.expression ?? '');
    const value = evaluateExpression(expression);
    return { expression, result: value };
  },
};
