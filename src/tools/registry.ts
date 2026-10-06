/**
 * Tool registry: the single source of truth for what the agent may call.
 */

import type { DangerLevel, ToolDefinition } from '../core/types.ts';
import type { Logger } from '../logger.ts';
import type { Tool } from './types.ts';

const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export interface ToolDescription extends ToolDefinition {
  /** Handler arity is irrelevant; this flags that a real implementation exists. */
  implemented: boolean;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly log: Logger;

  constructor(log: Logger) {
    this.log = log;
  }

  /** @throws when the name is malformed or already taken. */
  register(tool: Tool): void {
    if (!NAME_PATTERN.test(tool.name)) {
      throw new Error(
        `invalid tool name "${tool.name}": must match ${NAME_PATTERN.source}`,
      );
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`duplicate tool name "${tool.name}"`);
    }
    this.tools.set(tool.name, tool);
  }

  /** Registers many tools, skipping (and logging) any that collide. */
  registerAll(tools: Tool[]): void {
    for (const tool of tools) {
      try {
        this.register(tool);
      } catch (error) {
        this.log.warn('skipped tool registration', {
          tool: tool.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** Tools the model is allowed to see. */
  enabled(): Tool[] {
    return this.list().filter((tool) => tool.enabled !== false);
  }

  /** Wire definitions for the LLM request. */
  definitions(): ToolDefinition[] {
    return this.enabled().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      danger: dangerOf(tool),
      enabled: true,
    }));
  }

  /** Full inventory for the admin panel, including disabled tools. */
  describe(): ToolDescription[] {
    return this.list()
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        danger: dangerOf(tool),
        enabled: tool.enabled !== false,
        implemented: typeof tool.run === 'function',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get size(): number {
    return this.tools.size;
  }
}

function dangerOf(tool: Tool): DangerLevel {
  return tool.danger ?? 'safe';
}
