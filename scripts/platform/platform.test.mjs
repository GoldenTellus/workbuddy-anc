// 平台抽象层的测试：根路径、能力矩阵、WorkBuddy 探测、任务表、launchd 渲染。
//
// 重点不是"字段存在"，而是三个容易静默错的地方：
//   1. Windows 的根路径**一个字节都不能变**（线上机器、ACL、计划任务全都指着它）；
//   2. macOS 的两个副作用：ProgramData 不存在时不能回落到仓库目录（会在工作副本里造垃圾）；
//   3. launchd plist 的 XML 转义与排期键 —— 渲错了 plist 的表现是「任务注册成功但从不触发」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import {
  OS, SIDES, DEPLOY_DIRS, VAULT_DIRS, WORKBUDDY,
  sideRoot, defaultVaultRoot, ancPaths, capabilities,
  launchdDir, logDir, labelOf,
  probeWorkbuddy, taskPlan, unsupportedTasks, darwinCommand,
  renderLaunchdPlist, facts, TASKS,
} from './anc-platform.mjs';

const HERE = import.meta.dirname;
const HOME = '/Users/example'; // 占位，不是真实用户目录（check-public 会看）

function win(env = {}) {
  return { os: OS.WIN, env: { ProgramData: 'C:\\ProgramData', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ...env }, homedir: 'C:\\Users\\u' };
}
function mac(env = {}) {
  return { os: OS.MAC, env, homedir: HOME };
}

test('Windows 根路径与线上约定完全一致（不许漂）', () => {
  assert.equal(sideRoot('company', win()), join('C:\\ProgramData', 'anc'));
  assert.equal(sideRoot('employee', win()), join('C:\\Users\\u\\AppData\\Local', 'anc'));
  // 精简镜像把 ProgramData 设成空串：不能拼出相对路径
  assert.equal(sideRoot('company', win({ ProgramData: '' })), join('C:\\ProgramData', 'anc'));
  assert.equal(sideRoot('employee', win({ LOCALAPPDATA: '' })), join('C:\\Users\\u', 'AppData', 'Local', 'anc'));
});

test('macOS 根路径落在标准位置，不回落到仓库目录', () => {
  assert.equal(sideRoot('company', mac()), '/Library/Application Support/anc');
  assert.equal(sideRoot('employee', mac()), join(HOME, 'Library', 'Application Support', 'anc'));
  for (const r of [sideRoot('company', mac()), sideRoot('employee', mac())]) {
    assert.ok(r.startsWith('/'), 'macOS 根必须是绝对路径: ' + r);
    assert.ok(!/ProgramData/i.test(r), 'macOS 不能出现 ProgramData: ' + r);
  }
});

test('side 只认两个值，拼错直接报错而不是静默兜底', () => {
  for (const s of SIDES) assert.doesNotThrow(() => sideRoot(s, mac()));
  assert.throws(() => sideRoot('boss', mac()), /company/);
});

test('vault 默认位置：公司侧 mac 用 /Users/Shared，员工侧进家目录', () => {
  assert.equal(defaultVaultRoot('company', win()), 'D:\\anc');
  assert.equal(defaultVaultRoot('company', mac()), '/Users/Shared/anc');
  assert.equal(defaultVaultRoot('employee', mac()), join(HOME, 'anc'));
});

test('目录清单与 Windows 侧脚本逐项一致（15 + 5）', () => {
  assert.equal(DEPLOY_DIRS.length, 15);
  assert.equal(VAULT_DIRS.length, 5);
  assert.deepEqual([...DEPLOY_DIRS].sort(), [
    'accounts', 'backup', 'bin', 'data', 'evals', 'inbox', 'ingest',
    'light', 'patch', 'render', 'secrets', 'service', 'shared', 'skills', 'stage',
  ].sort());
  const p = ancPaths('/tmp/anc');
  assert.equal(p.data, join('/tmp/anc', 'data'));
  assert.equal(p.secrets, join('/tmp/anc', 'secrets'));
});

test('能力矩阵：两个平台都有调度器与提权实现，linux 明确不支持', () => {
  const w = capabilities(OS.WIN);
  assert.equal(w.scheduler, 'schtasks');
  assert.equal(w.privilege, 'uac');
  assert.equal(w.acl, 'icacls');
  assert.equal(w.launcher, 'cmd-vbs');

  const m = capabilities(OS.MAC);
  assert.equal(m.scheduler, 'launchd');
  assert.equal(m.privilege, 'sudo');
  assert.equal(m.acl, 'posix');
  assert.equal(m.launcher, 'shell');

  assert.equal(capabilities(OS.LINUX).supported, false);
  assert.equal(capabilities('freebsd').supported, false, '不认识的平台按不支持处理，不抛错');
});

test('launchd 落点：公司侧 LaunchDaemons，员工侧 LaunchAgents', () => {
  assert.equal(launchdDir('company', mac()), '/Library/LaunchDaemons');
  assert.equal(launchdDir('employee', mac()), join(HOME, 'Library', 'LaunchAgents'));
  assert.equal(launchdDir('company', win()), null, 'Windows 没有 launchd 目录');
  assert.equal(logDir('company', mac()), '/Library/Logs/anc');
  assert.equal(logDir('employee', mac()), join(HOME, 'Library', 'Logs', 'anc'));
  assert.equal(labelOf('anc-service'), 'local.anc.anc-service');
});

test('WorkBuddy 探测：两个平台各自的安装布局，找不到时明确返回 null', () => {
  const w = probeWorkbuddy({ os: OS.WIN, env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, probe: (p) => p.endsWith('WorkBuddy.exe') });
  assert.equal(w.found, true);
  assert.ok(w.exec.endsWith('WorkBuddy.exe'));
  assert.ok(w.appAsar.endsWith(join('resources', 'app.asar')));

  // 包内主程序名不一定是 WorkBuddy（实测 5.9.3 是 `Electron`），所以按 MacOS 目录里任一候选命中即 found
  const m = probeWorkbuddy({ os: OS.MAC, probe: (p) => p === join('/Applications/WorkBuddy.app', 'Contents', 'MacOS', 'WorkBuddy') });
  assert.equal(m.found, true);
  assert.equal(m.bundle, '/Applications/WorkBuddy.app');
  assert.ok(m.appAsar.endsWith(join('Contents', 'Resources', 'app.asar')));

  for (const os of [OS.WIN, OS.MAC]) {
    const none = probeWorkbuddy({ os, env: {}, probe: () => false });
    assert.deepEqual([none.found, none.exec, none.appAsar], [false, null, null]);
  }
});

test('任务表：14 个任务名与 OPS 契约一致，mac 上跳过 4 个并给出原因', () => {
  assert.equal(TASKS.length, 14, '计划任务在 OPS.md 里是 14 个');
  const names = TASKS.map((t) => t.name);
  assert.equal(new Set(names).size, 14, '任务名不能重复');
  for (const n of ['anc-service', 'anc-http', 'anc-backup', 'anc-elevate', 'anc-devbot']) {
    assert.ok(names.includes(n), '缺任务: ' + n);
  }

  const planned = taskPlan({ os: OS.MAC, side: 'company', workbuddy: { found: true } }).map((t) => t.name);
  assert.ok(planned.includes('anc-service'));
  assert.ok(planned.includes('anc-workbuddy-launch'));
  assert.ok(!planned.includes('anc-elevate'), 'root daemon 不需要提权通道');

  const unsupported = unsupportedTasks({ os: OS.MAC, side: 'company' });
  assert.deepEqual(unsupported.map((u) => u.name).sort(), ['anc-devbot', 'anc-elevate', 'anc-patch-guard', 'anc-update-watch'].sort());
  for (const u of unsupported) assert.ok(u.reason && u.reason.length > 10, '不注册的任务必须写原因: ' + u.name);
});

test('任务表：没有 WorkBuddy 时，依赖它的任务不进计划（只装确定性服务的机器）', () => {
  const planned = taskPlan({ os: OS.MAC, side: 'company', workbuddy: { found: false } }).map((t) => t.name);
  assert.ok(planned.includes('anc-service'));
  assert.ok(planned.includes('anc-backup'));
  assert.ok(!planned.includes('anc-workbuddy-launch'));
  assert.ok(!planned.includes('anc-executor-wake'));

  // Windows 侧同一规则：只用来对账，真注册仍归 register-tasks.ps1
  const w = taskPlan({ os: OS.WIN, side: 'company', workbuddy: { found: false } }).map((t) => t.name);
  assert.equal(w.length, 14 - 8, '去掉 8 个 requiresWorkbuddy 的任务（executor 三件套 + launch/guard/update/boot-alert/devbot）');
  assert.ok(!w.includes('anc-boot-alert'), 'boot-alert 依赖 WorkBuddy，没有就注册了只会误报');
});

test('darwinCommand：把平台无关动作展开成绝对路径 argv', () => {
  const ctx = { root: '/Library/Application Support/anc', nodeExe: '/usr/local/bin/node', backupDestination: '/Users/Shared/anc/backup' };
  const service = TASKS.find((t) => t.name === 'anc-service');
  const cmd = darwinCommand(service, ctx);
  assert.equal(cmd.program, '/usr/local/bin/node');
  assert.deepEqual(cmd.args.slice(1, 3), [join(ctx.root, 'service', 'cli.ts'), 'loop']);
  assert.ok(cmd.args.includes('--db'));
  assert.ok(cmd.args[cmd.args.indexOf('--db') + 1].endsWith('anc.db'));

  // 备份走 backup-anc.mjs：CLI 的 --to 是文件路径且目标已存在会报错，文件名时间戳必须由执行者算
  const backup = darwinCommand(TASKS.find((t) => t.name === 'anc-backup'), ctx);
  assert.ok(backup.args.some((a) => a.endsWith('backup-anc.mjs')));
  assert.equal(backup.args[backup.args.indexOf('--destination') + 1], '/Users/Shared/anc/backup');
  assert.equal(backup.args[backup.args.indexOf('--keep') + 1], '7');

  const cleanup = darwinCommand(TASKS.find((t) => t.name === 'anc-cleanup'), ctx);
  assert.equal(cleanup.program, '/bin/sh');
  assert.ok(cleanup.args[0].endsWith('cleanup-media.sh'));

  // 三个 executor 任务共用同一个 mjs，靠子命令区分（移植后合并，避免三份重复代码）
  const wake = darwinCommand(TASKS.find((t) => t.name === 'anc-executor-wake'), ctx);
  assert.ok(wake.args.some((a) => a.endsWith('executor-tasks.mjs')));
  assert.ok(wake.args.includes('wake'), '缺子命令 wake');
  assert.equal(wake.args[wake.args.indexOf('--root') + 1], ctx.root, '子命令后必须带 --root');
  const hostTick = darwinCommand(TASKS.find((t) => t.name === 'anc-executor-host-tick'), ctx);
  assert.ok(hostTick.args.includes('host-tick'));
});

test('plist：间隔/定点/常驻三种排期渲染正确，路径与参数都做 XML 转义', () => {
  const task = { name: 'anc-service', schedule: { kind: 'interval', seconds: 60, runAtLoad: true } };
  const xml = renderLaunchdPlist(task, {
    command: { program: '/usr/local/bin/node', args: ['--no-warnings', '/Library/Application Support/anc/service/cli.ts', '--x', 'a&b<c>'] },
    env: { ANC_SIDE: 'company', NODE_OPTIONS: '--require "/Library/Application Support/anc/patch/preload.cjs"' },
    logDir: '/Library/Logs/anc',
  });
  assert.match(xml, /<string>local\.anc\.anc-service<\/string>/);
  assert.match(xml, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /a&amp;b&lt;c&gt;/, '参数里的尖括号必须转义');
  assert.match(xml, /<key>StandardOutPath<\/key>\s*<string>\/Library\/Logs\/anc\/anc-service\.log<\/string>/);
  assert.ok(xml.trimEnd().endsWith('</plist>'), 'plist 必须闭合');
  assert.ok(!/<key>StartCalendarInterval<\/key>/.test(xml));

  const daily = renderLaunchdPlist({ name: 'anc-cleanup', schedule: { kind: 'calendar', at: '03:00' } }, {
    command: { program: '/bin/sh', args: ['/x.sh'] }, logDir: '/tmp',
  });
  assert.match(daily, /<key>Hour<\/key>\s*<integer>3<\/integer>/);
  assert.match(daily, /<key>Minute<\/key>\s*<integer>0<\/integer>/);

  const keepalive = renderLaunchdPlist({ name: 'anc-http', schedule: { kind: 'keepalive' } }, {
    command: { program: '/usr/local/bin/node', args: [] }, logDir: '/tmp',
  });
  assert.match(keepalive, /<key>KeepAlive<\/key>\s*<true\/>/);
});

test('facts：一次调用就能回答"这台机器装哪套、还缺什么"', () => {
  const f = facts({ os: OS.MAC, side: 'company', workbuddy: { found: true, exec: '/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy' } });
  assert.equal(f.ok, true);
  assert.equal(f.root, '/Library/Application Support/anc');
  assert.equal(f.capabilities.scheduler, 'launchd');
  assert.ok(f.scheduler.planned.length > 0);
  assert.equal(f.scheduler.unsupported.length, 4);

  const l = facts({ os: OS.LINUX, side: 'company' });
  assert.equal(l.ok, false);
  assert.ok(l.why && l.why.length > 10);
});

test('CLI 冒烟：facts --json 只输出 JSON（agent 用 2>&1 调用时不能被日志污染）', () => {
  const out = execFileSync(process.execPath, [resolve(HERE, 'anc-platform.mjs'), 'facts', '--json', '--os', 'darwin', '--side', 'company'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const json = JSON.parse(out);
  assert.equal(json.os, 'darwin');
  assert.equal(json.root, '/Library/Application Support/anc');

  // 用法错误给 ERROR + 退出码 2，不给裸堆栈
  let code = 0;
  let err = '';
  try {
    execFileSync(process.execPath, [resolve(HERE, 'anc-platform.mjs'), 'nope'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    code = e.status;
    err = String(e.stderr);
  }
  assert.equal(code, 2);
  assert.match(err, /ERROR/);
  assert.ok(!/at .*\(.*:\d+:\d+\)/.test(err), '不许输出裸堆栈');
});
