/**
 * OneBot v11 tools: let the agent act on QQ through SnowLuma (or any OneBot
 * implementation).
 *
 * Sending is deliberately hard to enable by accident. An agent that can post to
 * arbitrary QQ groups is an abuse vector, so `onebot_send_*` requires the
 * connector to be on **and** an explicit group/user allowlist to be configured;
 * with an empty allowlist the tools stay registered but disabled, which is
 * visible in the admin panel instead of failing silently.
 */

import type { Config } from '../../config.ts';
import type { OneBotClient } from '../../onebot/client.ts';
import { textSegment } from '../../onebot/client.ts';
import type { Tool } from '../types.ts';

function normaliseId(value: unknown): string {
  return String(value ?? '').trim();
}

export function createOneBotTools(config: Config, client: OneBotClient | null): Tool[] {
  const masterOn = config.onebot.enabled && client !== null;
  const groups = config.onebot.tools.allowGroups;
  const users = config.onebot.tools.allowUsers;
  const canSend = masterOn && config.onebot.tools.enabled;

  const sendGroup: Tool = {
    name: 'onebot_send_group_msg',
    description:
      'Send a plain-text message to a QQ group. Only groups on the server allowlist may ' +
      'be messaged. Use this to notify a group proactively; to answer the message you ' +
      'are replying to, just answer normally.',
    danger: 'dangerous',
    enabled: canSend && groups.length > 0,
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'Target QQ group id.', minLength: 1, maxLength: 20 },
        text: { type: 'string', description: 'Plain text to send.', minLength: 1, maxLength: 4000 },
      },
      required: ['group_id', 'text'],
      additionalProperties: false,
    },
    async run(args) {
      if (!client) throw new Error('the OneBot connector is not enabled');
      const groupId = normaliseId(args.group_id);
      if (!groups.includes(groupId)) {
        throw new Error(
          `group "${groupId}" is not on the send allowlist ` +
            `(NAMI_ONEBOT_TOOL_ALLOW_GROUPS=${groups.join(', ')}); refusing to send`,
        );
      }
      const result = await client.sendGroupMsg(groupId, [textSegment(String(args.text))]);
      return { sent: true, groupId, messageId: result?.message_id ?? null };
    },
  };

  const sendPrivate: Tool = {
    name: 'onebot_send_private_msg',
    description:
      'Send a plain-text QQ private message to a user. Only users on the server ' +
      'allowlist may be messaged.',
    danger: 'dangerous',
    enabled: canSend && users.length > 0,
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'Target QQ user id.', minLength: 1, maxLength: 20 },
        text: { type: 'string', description: 'Plain text to send.', minLength: 1, maxLength: 4000 },
      },
      required: ['user_id', 'text'],
      additionalProperties: false,
    },
    async run(args) {
      if (!client) throw new Error('the OneBot connector is not enabled');
      const userId = normaliseId(args.user_id);
      if (!users.includes(userId)) {
        throw new Error(
          `user "${userId}" is not on the send allowlist ` +
            `(NAMI_ONEBOT_TOOL_ALLOW_USERS=${users.join(', ')}); refusing to send`,
        );
      }
      const result = await client.sendPrivateMsg(userId, [textSegment(String(args.text))]);
      return { sent: true, userId, messageId: result?.message_id ?? null };
    },
  };

  const loginInfo: Tool = {
    name: 'onebot_login_info',
    description:
      'Report which QQ account the connected OneBot implementation is logged in as, ' +
      'plus its online status. Useful to confirm the QQ bridge is alive.',
    danger: 'safe',
    enabled: masterOn,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      if (!client) throw new Error('the OneBot connector is not enabled');
      const [login, status] = await Promise.all([
        client.getLoginInfo().catch(() => null),
        client.getStatus().catch(() => null),
      ]);
      return {
        url: client.url,
        account: login ? { userId: login.user_id, nickname: login.nickname } : null,
        online: status?.online ?? null,
        good: status?.good ?? null,
      };
    },
  };

  const groupList: Tool = {
    name: 'onebot_get_group_list',
    description: 'List the QQ groups the connected bot account has joined.',
    danger: 'safe',
    enabled: masterOn,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      if (!client) throw new Error('the OneBot connector is not enabled');
      const groups = await client.getGroupList();
      return {
        count: groups.length,
        groups: groups.map((group) => ({
          group_id: group.group_id,
          group_name: group.group_name,
          member_count: group.member_count ?? null,
        })),
      };
    },
  };

  const memberList: Tool = {
    name: 'onebot_get_group_member_list',
    description:
      'List the members of a QQ group: user id, nickname, group card and role. ' +
      'Personal data — use only when the task actually needs it.',
    danger: 'caution',
    enabled: masterOn,
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'QQ group id.', minLength: 1, maxLength: 20 },
      },
      required: ['group_id'],
      additionalProperties: false,
    },
    async run(args) {
      if (!client) throw new Error('the OneBot connector is not enabled');
      const groupId = normaliseId(args.group_id);
      const members = await client.getGroupMemberList(groupId);
      return {
        group_id: groupId,
        count: members.length,
        members: members.slice(0, 200).map((member) => ({
          user_id: member.user_id,
          nickname: member.nickname,
          card: member.card ?? '',
          role: member.role ?? 'member',
        })),
        truncated: members.length > 200,
      };
    },
  };

  return [loginInfo, groupList, sendGroup, sendPrivate, memberList];
}
