/**
 * Assembles the built-in tool set for a given configuration.
 *
 * Tools that need configuration (network, filesystem) are still registered when
 * disabled, so the admin panel can show them and explain why they are off.
 */

import type { Config } from '../../config.ts';
import type { OneBotClient } from '../../onebot/client.ts';
import type { Tool } from '../types.ts';
import { echoTool, nowTool } from './basic.ts';
import { calcTool } from './calc.ts';
import { createFsTools } from './fs.ts';
import { memoryTools } from './memory.ts';
import { createHttpGetTool } from './net.ts';
import { createOneBotTools } from './onebot.ts';

export function createServerInfoTool(config: Config): Tool {
  const bootedAt = Date.now();
  return {
    name: 'server_info',
    description:
      'Describe the Nami agent server itself: version, runtime, active model, ' +
      'enabled capabilities and uptime. Use it to answer questions about this deployment.',
    danger: 'safe',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run() {
      return {
        name: 'nami-agent-server',
        version: config.version,
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        uptimeSeconds: Math.round((Date.now() - bootedAt) / 1000),
        provider: config.llm.provider,
        model: config.llm.model,
        capabilities: {
          streaming: true,
          websocket: true,
          persistence: true,
          httpTool: config.tools.httpEnabled && config.tools.httpAllowHosts.length > 0,
          filesystemTool: config.tools.fsEnabled && config.tools.fsAllowRoots.length > 0,
          memory: config.tools.memoryEnabled,
        },
      };
    },
  };
}

export interface BuiltinToolOptions {
  /** The OneBot client, once the connector has been constructed. */
  onebot?: OneBotClient | null;
}

export function buildBuiltinTools(config: Config, options: BuiltinToolOptions = {}): Tool[] {
  const tools: Tool[] = [echoTool, nowTool, calcTool, createServerInfoTool(config)];

  if (config.tools.memoryEnabled) tools.push(...memoryTools);

  tools.push(createHttpGetTool(config));
  tools.push(...createFsTools(config));
  tools.push(...createOneBotTools(config, options.onebot ?? null));

  return tools;
}
