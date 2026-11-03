/**
 * 只读探针：列出 dsh-im（dsh-telegram 集成）里已配置的 bot 与投递目标。
 *
 * 目的：拿到主动投递需要的 `botId` / `targetId`。
 * ⚠️ 绝不打印任何 token / secret —— 只输出 id、名称、渠道类型。
 *
 * 用法：node scripts/probe-im-targets.mjs [--config <path>]
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const configPath = arg(
  'config',
  join(homedir(), '.dsh', 'integrations', 'dsh-telegram', 'config.json'),
);

if (!existsSync(configPath)) {
  console.error(`[im] 找不到配置：${configPath}`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const bots = Array.isArray(config.bots) ? config.bots : [];

console.log(`[im] 配置：${configPath}`);
console.log(`[im] bot 数量：${bots.length}`);

const SECRET = /token|secret|key|password|hash/i;

for (const [index, bot] of bots.entries()) {
  console.log('');
  console.log(`[im] --- bot[${index}] ---`);

  for (const [key, value] of Object.entries(bot)) {
    if (SECRET.test(key)) {
      console.log(`  ${key} = ••••（已脱敏）`);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const inner = Object.entries(value)
        .map(([k2, v2]) => `${k2}=${SECRET.test(k2) ? '••••' : JSON.stringify(v2)}`)
        .join(', ');
      console.log(`  ${key} = { ${inner} }`);
      continue;
    }
    if (Array.isArray(value)) {
      console.log(`  ${key} = [数组 ×${value.length}]`);
      for (const [i2, entry] of value.entries()) {
        if (entry && typeof entry === 'object') {
          const flat = Object.entries(entry)
            .map(([k2, v2]) => `${k2}=${SECRET.test(k2) ? '••••' : JSON.stringify(v2)}`)
            .join(', ');
          console.log(`      [${i2}] { ${flat} }`);
        } else {
          console.log(`      [${i2}] ${JSON.stringify(entry)}`);
        }
      }
      continue;
    }
    console.log(`  ${key} = ${JSON.stringify(value)}`);
  }
}

console.log('');
console.log('[im] 提示：主动投递需要上面每个 bot 的 `id`（botId）与目标的 `id`（targetId）。');
