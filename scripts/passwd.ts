/**
 * Console account administration from the command line.
 *
 * Exists because a forgotten password must not require hand-editing the SQLite
 * file: this is the way back in, and the only way to create an account before
 * the console is reachable.
 *
 *   npm run passwd -- --list
 *   npm run passwd -- --user admin --generate
 *   npm run passwd -- --user admin --password 'correct horse battery staple'
 *   npm run passwd -- --add alice --password '...' --admin
 *   npm run passwd -- --disable alice
 *
 * Passwords given on the command line are visible in the process list and in
 * shell history — `--generate` is the safe choice on a shared machine, and the
 * password is printed once.
 */

import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.ts';
import { assertPasswordAcceptable, hashPassword } from '../src/auth/passwords.ts';
import { assertUsernameAcceptable, normaliseUsername, toPublicUser } from '../src/auth/users.ts';
import { openDatabase } from '../src/store/db.ts';
import { SessionStore } from '../src/store/store.ts';

const COLOR = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const c = {
  reset: COLOR ? '\x1b[0m' : '',
  bold: COLOR ? '\x1b[1m' : '',
  dim: COLOR ? '\x1b[2m' : '',
  green: COLOR ? '\x1b[32m' : '',
  red: COLOR ? '\x1b[31m' : '',
  yellow: COLOR ? '\x1b[33m' : '',
};

const PASSWORD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generatePassword(length = 24): string {
  return [...randomBytes(length)]
    .map((byte) => PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length])
    .join('');
}

interface Args {
  user: string | null;
  password: string | null;
  generate: boolean;
  add: string | null;
  admin: boolean;
  disable: string | null;
  enable: string | null;
  list: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    user: null,
    password: null,
    generate: false,
    add: null,
    admin: false,
    disable: null,
    enable: null,
    list: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const next = (): string => argv[++i] ?? '';
    switch (arg) {
      case '--user': args.user = next(); break;
      case '--password': args.password = next(); break;
      case '--generate': args.generate = true; break;
      case '--add': args.add = next(); break;
      case '--admin': args.admin = true; break;
      case '--disable': args.disable = next(); break;
      case '--enable': args.enable = next(); break;
      case '--list': args.list = true; break;
      case '--help':
      case '-h': args.help = true; break;
      default:
        if (arg.startsWith('--')) {
          process.stderr.write(`${c.red}未知参数：${arg}${c.reset}\n`);
          args.help = true;
        }
    }
  }
  return args;
}

const USAGE = `
${c.bold}Nami 控制台账号管理${c.reset}

  npm run passwd -- --list
  npm run passwd -- --user <名> --generate
  npm run passwd -- --user <名> --password '<密码>'
  npm run passwd -- --add <名> --password '<密码>' [--admin]
  npm run passwd -- --disable <名> | --enable <名>

选项
  --list              列出所有账号
  --add <名>          新建账号（默认普通用户，最小权限）
  --user <名>         指定要改密码的账号
  --password <密码>   直接给出新密码（会进入 shell 历史，慎用）
  --generate          随机生成新密码并打印一次
  --admin             配合 --add：创建管理员
  --disable/--enable <名>  停用 / 恢复账号

改密码会同时注销该账号的所有登录会话。
`;

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const store = new SessionStore(db);

  try {
    process.stdout.write(`${c.dim}数据库：${config.dbPath}${c.reset}\n`);

    if (args.list) {
      const users = store.listUsers();
      if (users.length === 0) {
        process.stdout.write(`${c.yellow}没有任何账号。启动一次 Nami 会自动创建，或用 --add。${c.reset}\n`);
        return 0;
      }
      process.stdout.write(`${c.bold}${users.length} 个账号：${c.reset}\n`);
      for (const user of users) {
        const publicUser = toPublicUser(user);
        const flags = [
          publicUser.isAdmin ? 'admin' : 'user',
          publicUser.disabled ? 'disabled' : 'active',
        ].join(', ');
        const last = publicUser.lastLoginAt === null ? '从未登录' : new Date(publicUser.lastLoginAt).toLocaleString('zh-CN');
        process.stdout.write(`  ${publicUser.username.padEnd(20)} ${c.dim}${flags} · 上次登录 ${last}${c.reset}\n`);
      }
      return 0;
    }

    if (args.add !== null) {
      const username = normaliseUsername(args.add);
      assertUsernameAcceptable(username);
      if (store.findUserByUsername(username)) {
        process.stderr.write(`${c.red}账号已存在：${username}${c.reset}\n`);
        return 1;
      }
      const password = args.password ?? generatePassword();
      if (args.password !== null) assertPasswordAcceptable(password);
      store.createUser({ username, passwordHash: await hashPassword(password), isAdmin: args.admin });
      process.stdout.write(
        `${c.green}已创建账号 ${c.bold}${username}${c.reset}${c.dim}（${args.admin ? '管理员' : '普通用户'}）${c.reset}\n`,
      );
      if (args.password === null) {
        process.stdout.write(`  ${c.yellow}密码（只显示这一次）：${c.bold}${password}${c.reset}\n`);
      }
      return 0;
    }

    for (const [flag, disabled] of [['--disable', true], ['--enable', false]] as const) {
      const name = flag === '--disable' ? args.disable : args.enable;
      if (name === null) continue;
      const username = normaliseUsername(name);
      const user = store.findUserByUsername(username);
      if (!user) {
        process.stderr.write(`${c.red}账号不存在：${username}${c.reset}\n`);
        return 1;
      }
      if (disabled && user.isAdmin && !user.disabled && store.countActiveAdmins() <= 1) {
        process.stderr.write(`${c.red}拒绝停用最后一个可用的管理员账号。${c.reset}\n`);
        return 1;
      }
      store.setUserDisabled(user.id, disabled);
      const revoked = disabled ? store.deleteUserAuthSessions(user.id) : 0;
      process.stdout.write(
        `${c.green}${disabled ? '已停用' : '已恢复'} ${c.bold}${username}${c.reset}` +
          `${revoked > 0 ? c.dim + `（已注销 ${revoked} 个会话）` + c.reset : ''}\n`,
      );
      return 0;
    }

    if (args.user === null) {
      process.stderr.write(`${c.red}需要 --user <名>、--add <名> 或 --list。${c.reset}\n${USAGE}`);
      return 1;
    }

    const username = normaliseUsername(args.user);
    const user = store.findUserByUsername(username);
    if (!user) {
      process.stderr.write(`${c.red}账号不存在：${username}${c.reset}\n`);
      return 1;
    }

    const password = args.password ?? generatePassword();
    if (args.password !== null) assertPasswordAcceptable(password);
    store.setUserPassword(user.id, await hashPassword(password));
    const revoked = store.deleteUserAuthSessions(user.id);
    process.stdout.write(`${c.green}已更新 ${c.bold}${username}${c.reset}${c.dim} 的密码（已注销 ${revoked} 个会话）${c.reset}\n`);
    if (args.password === null || args.generate) {
      process.stdout.write(`  ${c.yellow}新密码（只显示这一次）：${c.bold}${password}${c.reset}\n`);
    }
    return 0;
  } finally {
    store.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith('passwd.ts');

if (invokedDirectly) {
  void main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(`\n${c.red}✗ ${error instanceof Error ? error.message : String(error)}${c.reset}\n\n`);
      process.exit(1);
    });
}
