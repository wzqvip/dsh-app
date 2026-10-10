/**
 * 诊断：`dsh` 命令在**干净环境**（只带持久 PATH）下是否可用。
 *
 * 背景：本会话 PATH 里含 `C:\Users\WANGZ\node_modules\.bin`，
 * 而它**不在用户级持久 PATH** 中（注册表里没有）。若 `dsh` 只靠这一条解析，
 * 那么换个终端就找不到 —— 本脚本把"换个终端"这件事变成可复现的检查。
 *
 * 用法：node scripts/diagnose-dsh-on-path.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const userPath = process.env.PATH ?? '';
const persistent =
  (process.env.__PERSISTENT_PATH__ ?? null) ||
  // 从注册表读用户级 + 机器级（PowerShell 一条命令，避免依赖 Node 无注册表 API）
  (() => {
    try {
      return execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          "[Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH','User')",
        ],
        { encoding: 'utf8' },
      ).trim();
    } catch {
      return null;
    }
  })();

console.log('[dsh-path] 1) 持久 PATH（机器级 + 用户级）是否含关键目录');
const checks = [
  ['C:\\Users\\WANGZ\\node_modules\\.bin', '本会话解析 dsh 的来源'],
  [join(process.env.APPDATA ?? '', 'npm'), 'npm 全局 bin（本该装 dsh 的地方）'],
  [join(process.env.LOCALAPPDATA ?? '', 'pnpm', 'bin'), 'pnpm 全局 bin'],
];
for (const [dir, why] of checks) {
  const inPersistent = persistent ? persistent.toLowerCase().includes(dir.toLowerCase()) : null;
  const inSession = userPath.toLowerCase().includes(dir.toLowerCase());
  console.log(
    `  ${dir}\n      在持久 PATH: ${inPersistent === null ? '(读不到注册表)' : inPersistent ? '✅' : '❌'}   在本次会话 PATH: ${inSession ? '✅' : '❌'}   ← ${why}`,
  );
}

console.log('');
console.log('[dsh-path] 2) 该目录里到底有没有 dsh 可执行文件');
for (const dir of ['C:\\Users\\WANGZ\\node_modules\\.bin', join(process.env.APPDATA ?? '', 'npm')]) {
  const found = ['dsh', 'dsh.cmd', 'dsh.ps1'].filter((n) => existsSync(join(dir, n)));
  console.log(`  ${dir}\n      ${found.length ? `✅ ${found.join(', ')}` : '❌ 没有 dsh'}`);
}

console.log('');
console.log('[dsh-path] 3) 用【只含持久 PATH】的环境跑 dsh（模拟"新开一个终端"）');
if (!persistent) {
  console.log('  ⚠️ 读不到持久 PATH，跳过');
} else {
  // ⚠️ 判据要按 **Windows 的解析规则**来：
  //    Node 的 spawnSync('dsh', …, {shell:false}) **不会**应用 PATHEXT，
  //    所以即使 PATH 里有 dsh.cmd 也会报 ENOENT —— 那是**脚本的锅**，不是环境的问题。
  //    （第一版就栽在这：装好全局后仍报"不可用"。）
  //    正确做法：自己按 PATHEXT 在 PATH 的每个目录里找 dsh.{cmd,exe,bat,ps1}，
  //    再用 shell:true 跑它。
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = persistent.split(';').map((s) => s.trim()).filter(Boolean);
  let resolved = null;
  for (const d of dirs) {
    for (const ext of ['', ...exts]) {
      const cand = join(d, `dsh${ext}`);
      if (existsSync(cand)) {
        resolved = cand;
        break;
      }
    }
    if (resolved) break;
  }
  console.log(`  按 PATHEXT 在持久 PATH 中解析: ${resolved ?? '❌ 未找到任何 dsh.*'}`);

  if (resolved) {
    const r = spawnSync(resolved, ['--version'], { env: { ...process.env, PATH: persistent }, encoding: 'utf8', shell: true });
    const ok = r.status === 0;
    const outStr = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').filter(Boolean);
    console.log(`  ${ok ? '✅ 可用' : '❌ 不可用'}  status=${r.status}`);
    if (outStr.length) console.log(`  输出: ${outStr.slice(0, 3).join(' | ').slice(0, 160)}`);
    console.log(
      ok
        ? '  → 结论：新终端可以直接用 `dsh`（全局安装已生效）'
        : '  → 结论：能找到 shim 但执行失败，需看上面的输出',
    );
  } else {
    console.log('  → 结论：dsh 只在注入过的会话 PATH 下可用；新终端会报「无法将 dsh 识别为 cmdlet」');
  }
}

console.log('');
console.log('[dsh-path] 4) 本包/本仓库脚本里是怎么调用 dsh 的');
console.log('  （若脚本依赖 PATH 里的 dsh，同样会在干净环境下失败）');
