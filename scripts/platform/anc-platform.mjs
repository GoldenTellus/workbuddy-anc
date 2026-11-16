#!/usr/bin/env node
// 平台抽象层：把「Windows 还是 macOS」这件事收在一个文件里。
//
// 为什么要有它：
//   这个仓库原先只有 Windows 一条路 —— 部署根写死 %ProgramData%\anc，调度写死 schtasks，
//   提权写死 UAC，启动器写死 .cmd/.vbs。换一台 Mac，不是"少装两个包"，而是每条路径都要重来。
//   所以先把**差异**抽出来：根路径、能力矩阵、任务表、launchd 渲染。
//   Windows 侧行为一个字节都不改（仍由 scripts/deploy/*.ps1 负责），macOS 侧由本层 + Node 入口承载。
//
// 边界：
//   - 本文件属 ops（scripts/），零依赖、纯 ESM，**部署前就能跑**（不需要 src 已铺好）。
//   - 运行时（src/）不能 import 它；src 侧的同名规则在 src/core/paths.ts，两边用
//     scripts/platform/platform.test.mjs 的跨层对拍测试钉住，不允许漂。
//
// 用法（人 / agent 都可用）：
//   node scripts/platform/anc-platform.mjs facts            # 平台事实 + 能力矩阵（人读）
//   node scripts/platform/anc-platform.mjs facts --json     # 同上，机器读
//   node scripts/platform/anc-platform.mjs paths --side company
//   node scripts/platform/anc-platform.mjs tasks --side company --json
//   node scripts/platform/anc-platform.mjs plist --task anc-service --side company --root /Library/Application\ Support/anc
//
// 退出码：0 正常 / 2 用法错误 / 3 当前平台不支持

import { existsSync, readFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';

/** 目标平台（只承诺这两个；linux 只做识别，不给能力） */
export const OS = Object.freeze({ WIN: 'win32', MAC: 'darwin', LINUX: 'linux' });

/** 两份部署形态 */
export const SIDES = Object.freeze(['company', 'employee']);

// ── 根路径 ────────────────────────────────────────────────
// Windows：沿用原约定（ProgramData / LOCALAPPDATA），文档、ACL、计划任务全都按这个写。
// macOS：公司侧进系统级 Application Support（要 sudo，等价于 Windows 的首次管理员会话）；
//        员工侧进用户自己的 Application Support（等价于 %LOCALAPPDATA%）。
//
// 不用 ~/.anc 这类"自定义目录"：Mac 上的备份/迁移/Time Machine/卸载清理都认标准位置，
// 自创目录只会让运维重新记一套路径。

/**
 * 部署根（anc 根目录）。
 * @param {'company'|'employee'} side
 * @param {{os?: string, env?: Record<string,string|undefined>, homedir?: string}} [opts]
 */
export function sideRoot(side, opts = {}) {
  if (!SIDES.includes(side)) throw new UsageError('side 必须是 company 或 employee，收到: ' + side);
  const os = opts.os ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.homedir ?? osHomedir();

  if (os === OS.WIN) {
    // 显式判断空串：部分精简镜像会把 ProgramData 设成 ''，|| 能兜住，?? 兜不住。
    if (side === 'company') return join(env.ProgramData || 'C:\\ProgramData', 'anc');
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'anc');
  }
  if (os === OS.MAC) {
    if (side === 'company') return '/Library/Application Support/anc';
    return join(home, 'Library', 'Application Support', 'anc');
  }
  // linux：不承诺支持，但给一个可预测的根，方便 CI 里跑测试而不是炸在路径拼接上。
  return join(home, '.local', 'share', 'anc');
}

/**
 * vault 默认位置。
 * Windows 公司侧历史上习惯放 D: 盘（与系统盘分离）；macOS 用 /Users/Shared（多用户可读的公共目录）。
 */
export function defaultVaultRoot(side, opts = {}) {
  const os = opts.os ?? process.platform;
  const home = opts.homedir ?? osHomedir();
  if (side === 'employee') return join(home, 'anc');
  if (os === OS.WIN) return 'D:\\anc';
  return '/Users/Shared/anc';
}

/** 部署根下的标准子目录。名字与 Windows 侧一致，运维只需要记一套。 */
export function ancPaths(root) {
  const p = (name) => join(root, name);
  return {
    root,
    data: p('data'),
    secrets: p('secrets'),
    bin: p('bin'),
    tools: p('tools'),
    service: p('service'),
    interfaces: p('interfaces'),
    core: p('core'),
    modules: p('modules'),
    shared: p('shared'),
    patch: p('patch'),
    inbox: p('inbox'),
    render: p('render'),
    light: p('light'),
    backup: p('backup'),
    ingest: p('ingest'),
    accounts: p('accounts'),
    evals: p('evals'),
    stage: p('stage'),
    skills: p('skills'),
  };
}

/** 部署时创建的 15 个目录（与 scripts/deploy/setup-dirs.ps1 的 $deployDirs 逐项一致）。 */
export const DEPLOY_DIRS = Object.freeze([
  'accounts', 'backup', 'bin', 'data', 'evals', 'inbox', 'ingest',
  'light', 'patch', 'render', 'secrets', 'service', 'shared', 'skills', 'stage',
]);

/** vault 两区 + 三个工作目录（与 setup-dirs.ps1 的 $vaultDirs 一致）。 */
export const VAULT_DIRS = Object.freeze(['vault-shared', 'vault-internal', 'inbox', 'org', 'build']);

// ── 能力矩阵 ──────────────────────────────────────────────
// 每个字段都是「这个平台上用什么实现」，不是「有没有这个功能」。
// 移植到新平台时，先看这张表，再看 docs/PLATFORMS.md 的差异说明。
export const CAPABILITIES = Object.freeze({
  [OS.WIN]: {
    os: OS.WIN,
    supported: true,
    scheduler: 'schtasks',        // 计划任务
    schedulerOwner: 'scripts/deploy/register-tasks.ps1',
    privilege: 'uac',             // 提权 = UAC + SYSTEM 任务
    privilegeOwner: 'scripts/elevate/*',
    acl: 'icacls',                // 断继承 + Modify 授权
    launcher: 'cmd-vbs',          // .cmd + run-hidden.vbs 隐藏窗口
    logRoot: null,                // Windows 日志写在 <root>\data
    schedulerDir: null,
  },
  [OS.MAC]: {
    os: OS.MAC,
    supported: true,
    scheduler: 'launchd',
    schedulerOwner: 'scripts/deploy/scheduler.mjs',
    privilege: 'sudo',            // 公司侧 LaunchDaemon 由 root 跑；没有 SYSTEM 那层
    privilegeOwner: 'scripts/deploy/anc.mjs',
    acl: 'posix',                 // chmod/chown；没有 ACL 断继承，靠 750/700 表达
    launcher: 'shell',            // .sh 启动器；launchd 本身没有窗口问题
    logRoot: null,                // 运行时按 LaunchDaemon/Agent 填：/Library/Logs/anc 或 ~/Library/Logs/anc
    schedulerDir: null,
  },
  [OS.LINUX]: {
    os: OS.LINUX,
    supported: false,
    scheduler: 'none',
    schedulerOwner: null,
    privilege: 'none',
    privilegeOwner: null,
    acl: 'none',
    launcher: 'none',
    logRoot: null,
    schedulerDir: null,
  },
});

/** 取能力矩阵那一行（不认识的平台按不支持处理，而不是抛错 —— 体检要能报告它）。 */
export function capabilities(os = process.platform) {
  return CAPABILITIES[os] ?? { ...CAPABILITIES[OS.LINUX], os };
}

// ── 调度器落点 ────────────────────────────────────────────
/**
 * launchd 目录：公司侧是 LaunchDaemons（开机即起，不需要人登录），员工侧是 LaunchAgents（登录后起）。
 * 这条差别是 macOS 侧的核心设计约束：公司 bot 要 7×24，就不能依赖登录。
 */
export function launchdDir(side, opts = {}) {
  const os = opts.os ?? process.platform;
  if (os !== OS.MAC) return null;
  const home = opts.homedir ?? osHomedir();
  return side === 'company' ? '/Library/LaunchDaemons' : join(home, 'Library', 'LaunchAgents');
}

/** launchd 标签：反 DNS 命名，卸载时按它 kill。一个任务一个标签。 */
export function labelOf(name) {
  return 'local.anc.' + name;
}

/** 日志目录：LaunchDaemon 写 /Library/Logs/anc，LaunchAgent 写 ~/Library/Logs/anc。 */
export function logDir(side, opts = {}) {
  const os = opts.os ?? process.platform;
  const home = opts.homedir ?? osHomedir();
  if (os === OS.MAC) {
    return side === 'company' ? '/Library/Logs/anc' : join(home, 'Library', 'Logs', 'anc');
  }
  return join(sideRoot(side, opts), 'data');
}

// ── WorkBuddy 探测 ────────────────────────────────────────
// 两个平台都有 WorkBuddy（官方安装指南：Windows 10+ / macOS 12+），但安装位置不同：
//   Windows：%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe（或 Program Files）
//   macOS  ：/Applications/WorkBuddy.app（Contents/MacOS/WorkBuddy 是主程序，
//            Contents/Resources/app.asar 是补丁目标，与 Windows 的 resources\app.asar 同构）
export const WORKBUDDY = Object.freeze({
  version: '5.9.3',
  electron: '37.10.3',
  win: { exe: 'WorkBuddy.exe', appAsar: join('resources', 'app.asar') },
  mac: {
    bundle: 'WorkBuddy.app',
    // 主程序名不一定是 WorkBuddy：2026-11-16 实测本机 5.9.3 的包内可执行文件叫 `Electron`
    // （打包时没改名，CFBundleExecutable=Electron）。所以按候选 + Info.plist 的 CFBundleExecutable 一起找，
    // 写死 'WorkBuddy' 会让 probe 永远 found=false，doctor 就报「只装确定性服务」。
    exe: 'WorkBuddy',
    exeCandidates: ['WorkBuddy', 'Electron'],
    appAsar: join('Contents', 'Resources', 'app.asar'),
  },
});

/** macOS 包内主程序：先按候选名找，再读 Info.plist 的 CFBundleExecutable（打包名可能不是产品名）。 */
export function macExecutable(bundle, exists = existsSync) {
  const macosDir = join(bundle, 'Contents', 'MacOS');
  const names = [...WORKBUDDY.mac.exeCandidates];
  try {
    const raw = readFileSync(join(bundle, 'Contents', 'Info.plist'), 'latin1');
    const m = raw.match(/CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/);
    if (m && m[1]) names.unshift(m[1]);
  } catch { /* Info.plist 读不到就只用候选名 */ }
  for (const name of names) {
    const p = join(macosDir, name);
    if (exists(p)) return p;
  }
  return null;
}

/**
 * 探测本机 WorkBuddy。返回 installDir 是为了让补丁器知道去改哪个文件；
 * 找不到不算错误（可能有机器只装确定性服务），只是 requiresWorkbuddy 的任务不注册。
 *
 * @param {{os?: string, env?: Record<string,string|undefined>, homedir?: string, probe?: (p: string) => boolean}} [opts]
 */
export function probeWorkbuddy(opts = {}) {
  const os = opts.os ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.homedir ?? osHomedir();
  const exists = opts.probe ?? existsSync;

  if (os === OS.WIN) {
    const candidates = [
      env.ANC_WORKBUDDY_DIR,
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'WorkBuddy') : null,
      'C:\\Program Files\\WorkBuddy',
      'C:\\Program Files (x86)\\WorkBuddy',
    ].filter(Boolean);
    for (const dir of candidates) {
      const exe = join(dir, WORKBUDDY.win.exe);
      if (exists(exe)) {
        return { found: true, os, installDir: dir, exec: exe, bundle: null, appAsar: join(dir, WORKBUDDY.win.appAsar) };
      }
    }
    return { found: false, os, installDir: null, exec: null, bundle: null, appAsar: null };
  }

  if (os === OS.MAC) {
    const candidates = [
      env.ANC_WORKBUDDY_APP,
      '/Applications/WorkBuddy.app',
      join(home, 'Applications', 'WorkBuddy.app'),
    ].filter(Boolean);
    for (const bundle of candidates) {
      const exe = macExecutable(bundle, exists);
      if (exe) {
        return {
          found: true,
          os,
          installDir: bundle,
          exec: exe,
          bundle,
          appAsar: join(bundle, WORKBUDDY.mac.appAsar),
        };
      }
    }
    return { found: false, os, installDir: null, exec: null, bundle: null, appAsar: null };
  }

  return { found: false, os, installDir: null, exec: null, bundle: null, appAsar: null };
}

// ── 任务表（平台无关的声明）────────────────────────────────
// 14 个计划任务的名字与职责是契约（docs/OPS.md）。这里只声明**是什么**；
// 每个平台怎么实现（schtasks 参数 / launchd plist）分别由 register-tasks.ps1 和 scheduler.mjs 展开。
//
// 字段：
//   name            任务名（launchd 标签去掉 local.anc. 前缀后同名）
//   side            哪一侧需要它
//   requiresWorkbuddy 没有 WorkBuddy 就不注册（只部署确定性服务时跳过）
//   darwin          在 macOS 上能跑吗；不能跑的要写 reason，进 docs/PLATFORMS.md 的缺口表
//   schedule        平台无关的排期（见 SCHEDULE 说明）
//   action          平台无关的动作（用 node / sh / workbuddy 三种描述）
//
// 排期形态：
//   { kind: 'interval', seconds, runAtLoad? }   固定间隔
//   { kind: 'calendar', at: 'HH:MM' }           每天定点
//   { kind: 'keepalive' }                       常驻，挂了就拉
//   { kind: 'logon' }                           登录后一次（仅 WorkBuddy 交互类）
export const TASKS = Object.freeze([
  {
    name: 'anc-service',
    desc: '本地小服务：每分钟一次 tick',
    side: 'company',
    requiresWorkbuddy: false,
    darwin: { ok: true },
    schedule: { kind: 'interval', seconds: 60, runAtLoad: true },
    action: { type: 'cli', args: ['loop', '--once'] },
  },
  {
    name: 'anc-http',
    desc: '本地 HTTP 面：只监听 127.0.0.1，供 watchdog 与后台任务用',
    side: 'company',
    requiresWorkbuddy: false,
    darwin: { ok: true },
    schedule: { kind: 'keepalive' },
    action: { type: 'cli', args: ['serve', '--port', '17891'] },
  },
  {
    name: 'anc-backup',
    desc: 'SQLite + vault 备份（每小时，幂等）',
    side: 'company',
    requiresWorkbuddy: false,
    darwin: { ok: true },
    schedule: { kind: 'interval', seconds: 3600, runAtLoad: false },
    // CLI 的 backup --to 收的是文件路径且目标已存在会报错 → 交给 backup-anc.mjs 算时间戳 + 保留策略
    action: { type: 'node', script: 'backup-anc.mjs', args: ['--destination', ':backupDestination', '--keep', '7'] },
  },
  {
    name: 'anc-cleanup',
    desc: '清企微附件（每天 03:00）',
    side: 'company',
    requiresWorkbuddy: false,
    darwin: { ok: true },
    schedule: { kind: 'calendar', at: '03:00' },
    action: { type: 'sh', script: 'cleanup-media.sh', args: ['--days', '7'] },
  },
  {
    name: 'anc-watchdog',
    desc: '心跳/积压/进程告警（每 10 分钟）',
    side: 'company',
    requiresWorkbuddy: false,
    darwin: { ok: true },
    schedule: { kind: 'interval', seconds: 600 },
    action: { type: 'sh', script: 'watchdog.sh' },
  },
  {
    name: 'anc-executor-wake',
    desc: '主干2 每分钟检查队列，有 queued 才唤醒 WorkBuddy',
    side: 'company',
    requiresWorkbuddy: true,
    darwin: { ok: true },
    schedule: { kind: 'interval', seconds: 60 },
    action: { type: 'node', script: 'executor-tasks.mjs', subcommand: 'wake' },
  },
  {
    name: 'anc-executor-new-host',
    desc: '主干2 03:00 自动创建新 host 对话；失败由 host-tick 兜底',
    side: 'company',
    requiresWorkbuddy: true,
    darwin: { ok: true },
    schedule: { kind: 'calendar', at: '03:00' },
    action: { type: 'node', script: 'executor-tasks.mjs', subcommand: 'new-host' },
  },
  {
    name: 'anc-executor-host-tick',
    desc: '主干2 03:00 host 自动兜底：无新对话时只标 deferred',
    side: 'company',
    requiresWorkbuddy: true,
    darwin: { ok: true },
    schedule: { kind: 'calendar', at: '03:00' },
    action: { type: 'node', script: 'executor-tasks.mjs', subcommand: 'host-tick' },
  },
  {
    name: 'anc-workbuddy-launch',
    desc: '登录 30 秒后用补丁启动器拉起 WorkBuddy（交互）',
    side: 'company',
    // macOS：GUI 应用不能由 root daemon 拉起 → 这条必须是用户域 LaunchAgent
    scope: 'user',
    requiresWorkbuddy: true,
    darwin: { ok: true },
    schedule: { kind: 'logon' },
    action: { type: 'workbuddy' },
  },
  {
    name: 'anc-patch-guard',
    desc: '补丁守卫：每分钟看 applied=false 就自愈（交互）',
    side: 'company',
    requiresWorkbuddy: true,
    darwin: { ok: false, reason: 'patch-guard 依赖 Win32_Process 与自愈链路，待移植（PLATFORMS §5）' },
    schedule: { kind: 'interval', seconds: 60 },
    action: { type: 'shell', script: 'patch-guard.sh' },
  },
  {
    name: 'anc-elevate',
    desc: '提权执行器：每分钟处理一条白名单运维请求（SYSTEM）',
    side: 'company',
    requiresWorkbuddy: false,
    darwin: { ok: false, reason: 'macOS 公司侧 LaunchDaemon 本身以 root 跑，不需要 SYSTEM 提权通道' },
    schedule: { kind: 'interval', seconds: 60 },
    action: { type: 'shell', script: 'elevate-runner.sh' },
  },
  {
    name: 'anc-update-watch',
    desc: '每天 09:00 查厂商更新接口，有新版本发运维群',
    side: 'company',
    requiresWorkbuddy: true,
    darwin: { ok: false, reason: '厂商更新接口探测按 Windows 安装布局写，macOS 待实测（PLATFORMS §5）' },
    schedule: { kind: 'calendar', at: '09:00' },
    action: { type: 'shell', script: 'check-workbuddy-update.sh' },
  },
  {
    name: 'anc-boot-alert',
    desc: '开机后 WorkBuddy 没起来就告警（每 10 分钟，持续 2 小时）',
    side: 'company',
    requiresWorkbuddy: true,
    darwin: { ok: true },
    schedule: { kind: 'interval', seconds: 600, runAtLoad: true },
    action: { type: 'sh', script: 'boot-alert.sh' },
  },
  {
    name: 'anc-devbot',
    desc: 'devbot 自动启动：工作日 22:00~06:00 每 30 分钟查「全员下班」',
    side: 'company',
    // devbot 要动 WorkBuddy 的 persona 与 git 身份 → 用户域
    scope: 'user',
    requiresWorkbuddy: true,
    darwin: { ok: false, reason: 'devbot 依赖 WorkBuddy persona 路径与 git 身份，待移植（PLATFORMS §5）' },
    schedule: { kind: 'interval', seconds: 1800 },
    action: { type: 'shell', script: 'devbot-scheduler.sh' },
  },
]);

/**
 * 本平台要注册哪些任务。Windows 侧只用来对账（真注册仍由 register-tasks.ps1 做）。
 * @param {{os?: string, side?: string, workbuddy?: {found: boolean}}} [opts]
 */
export function taskPlan(opts = {}) {
  const os = opts.os ?? process.platform;
  const side = opts.side ?? 'company';
  const wb = opts.workbuddy ?? probeWorkbuddy({ os });
  return TASKS.filter((t) => {
    if (t.side !== side) return false;
    if (t.requiresWorkbuddy && !wb.found) return false;
    if (os === OS.MAC) return t.darwin.ok;
    return true;
  }).map((t) => ({ ...t, label: labelOf(t.name) }));
}

/** 本平台跑不了的任务及原因（体检与文档都用它，不留"以为装了"的空洞）。 */
export function unsupportedTasks(opts = {}) {
  const os = opts.os ?? process.platform;
  const side = opts.side ?? 'company';
  const wb = opts.workbuddy ?? probeWorkbuddy({ os });
  return TASKS.filter((t) => t.side === side)
    .filter((t) => (os === OS.MAC ? !t.darwin.ok : false))
    .map((t) => ({ name: t.name, reason: os === OS.MAC ? t.darwin.reason : null, requiresWorkbuddy: t.requiresWorkbuddy, workbuddyFound: wb.found }));
}

// ── 命令展开 ──────────────────────────────────────────────
/**
 * 把平台无关的动作展开成 macOS 上要执行的具体 argv。
 * Windows 侧的等价展开在 register-tasks.ps1（本函数不负责，避免两套实现打架）。
 *
 * @param {object} task TASKS 里的一项
 * @param {{root: string, nodeExe: string, workbuddy?: {exec: string|null}, backupDestination?: string}} ctx
 */
export function darwinCommand(task, ctx) {
  const root = ctx.root;
  const cli = join(root, 'service', 'cli.ts');
  const db = join(root, 'data', 'anc.db');
  const a = task.action;
  const argv = (...args) => ({ program: ctx.nodeExe, args });

  if (a.type === 'cli') {
    const args = ['--no-warnings', cli, ...a.args];
    if (a.args.includes('--to')) {
      const idx = args.indexOf('--to');
      args[idx + 1] = ctx.backupDestination ?? join(root, 'backup');
    }
    // --db 一律显式给：launchd 拉起的是裸进程，没有 ANC_DB，CLI 会退回平台默认根
    // （公司侧 /Library/Application Support/anc），演练/用户态部署就会 EACCES。
    // 2026-11-16 真机验收：anc-backup 缺 --db 时 exit 1（EACCES mkdir /Library/...）。
    if (!args.includes('--db')) args.push('--db', db);
    return argv(...args);
  }
  if (a.type === 'node') {
    const head = ['--no-warnings', join(root, 'bin', a.script)];
    if (a.subcommand) head.push(a.subcommand);
    // 占位符在展开时替换（:backupDestination 等），保持 TASKS 里不写死路径
    const args = (a.args ?? []).map((x) => (x === ':backupDestination' ? (ctx.backupDestination ?? join(root, 'backup')) : x));
    return argv(...head, '--root', root, ...args);
  }
  if (a.type === 'sh') {
    return { program: '/bin/sh', args: [join(root, 'bin', a.script), ...(a.args ?? [])] };
  }
  if (a.type === 'workbuddy') {
    return { program: join(root, 'bin', 'anc-launch.sh'), args: [] };
  }
  throw new UsageError('未知动作类型: ' + a.type);
}

// ── launchd plist 渲染 ────────────────────────────────────
const xmlEscape = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function scheduleKeys(schedule) {
  if (schedule.kind === 'interval') {
    const out = ['  <key>StartInterval</key>', `  <integer>${schedule.seconds}</integer>`];
    if (schedule.runAtLoad) out.push('  <key>RunAtLoad</key>', '  <true/>');
    return out;
  }
  if (schedule.kind === 'calendar') {
    const [h, m] = schedule.at.split(':').map((n) => parseInt(n, 10));
    return [
      '  <key>StartCalendarInterval</key>',
      '  <dict>',
      `    <key>Hour</key>`,
      `    <integer>${h}</integer>`,
      `    <key>Minute</key>`,
      `    <integer>${m}</integer>`,
      '  </dict>',
    ];
  }
  if (schedule.kind === 'keepalive') {
    return ['  <key>KeepAlive</key>', '  <true/>', '  <key>RunAtLoad</key>', '  <true/>'];
  }
  if (schedule.kind === 'logon') {
    return ['  <key>RunAtLoad</key>', '  <true/>'];
  }
  throw new UsageError('未知排期: ' + JSON.stringify(schedule));
}

/**
 * 渲染一个 LaunchDaemon/LaunchAgent plist。
 * 只覆盖本项目用到的键：Label / ProgramArguments / 排期 / EnvironmentVariables / 日志 / 工作目录 / 会话类型。
 *
 * @param {object} task
 * @param {{command: {program: string, args: string[]}, env?: Record<string,string>, logDir: string, workingDir?: string}} ctx
 */
export function renderLaunchdPlist(task, ctx) {
  const { command, env = {}, logDir: logs } = ctx;
  const label = labelOf(task.name);
  // 个别任务的心跳文件是**契约**（不是排障日志）：anc-service 的 stdout 必须是 <root>/data/loop.log，
  // 因为 /__anc_health 与 watchdog 都按 loop.log 的 mtime 判活（Windows 的 anc-loop.cmd 也是这么重定向的）。
  // 允许调用方按任务覆盖，避免在 macOS 上出现「服务在跑、health 说没有 loop.log」的假故障。
  const outLog = ctx.outLog ?? join(logs, task.name + '.log');
  const errLog = ctx.errLog ?? join(logs, task.name + '.err.log');
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xmlEscape(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xmlEscape(command.program)}</string>`,
    ...command.args.map((a) => `    <string>${xmlEscape(a)}</string>`),
    '  </array>',
    ...scheduleKeys(task.schedule),
  ];
  const envKeys = Object.keys(env).sort();
  if (envKeys.length) {
    lines.push('  <key>EnvironmentVariables</key>', '  <dict>');
    for (const k of envKeys) {
      lines.push(`    <key>${xmlEscape(k)}</key>`, `    <string>${xmlEscape(env[k])}</string>`);
    }
    lines.push('  </dict>');
  }
  if (ctx.workingDir) {
    lines.push('  <key>WorkingDirectory</key>', `  <string>${xmlEscape(ctx.workingDir)}</string>`);
  }
  lines.push(
    '  <key>StandardOutPath</key>',
    `  <string>${xmlEscape(outLog)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xmlEscape(errLog)}</string>`,
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '</dict>',
    '</plist>',
    '',
  );
  return lines.join('\n');
}

// ── 平台事实（体检与文档共用）──────────────────────────────
/**
 * 一次调用回答「这台机器能装哪套、装到哪、还缺什么」。
 * 与 Windows 的 scripts/deploy/preflight.ps1 的 facts 字段尽量对齐，agent 换平台不用重学。
 */
export function facts(opts = {}) {
  const os = opts.os ?? process.platform;
  const env = opts.env ?? process.env;
  const side = opts.side ?? 'company';
  const home = opts.homedir ?? osHomedir();
  const cap = capabilities(os);
  const wb = opts.workbuddy ?? probeWorkbuddy({ os, env, homedir: home });
  const root = opts.root ?? sideRoot(side, { os, env, homedir: home });
  return {
    ok: cap.supported,
    os,
    arch: opts.arch ?? process.arch,
    side,
    platform: cap.supported ? os : 'unsupported',
    root,
    vaultRoot: opts.vaultRoot ?? defaultVaultRoot(side, { os, homedir: home }),
    paths: ancPaths(root),
    capabilities: cap,
    workbuddy: wb,
    scheduler: {
      kind: cap.scheduler,
      dir: launchdDir(side, { os, homedir: home }),
      logDir: logDir(side, { os, homedir: home }),
      planned: taskPlan({ os, side, workbuddy: wb }).map((t) => t.name),
      unsupported: unsupportedTasks({ os, side, workbuddy: wb }),
    },
    node: { exec: process.execPath, version: process.version },
    homedir: home,
    why: cap.supported
      ? null
      : '本仓库只承诺 Windows 与 macOS 两套部署路径；' + os + ' 未验证，且调度/提权实现不同',
  };
}

// ── CLI ───────────────────────────────────────────────────
class UsageError extends Error {}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

function main(argv) {
  const cmd = argv[0] ?? 'facts';
  const args = parseArgs(argv.slice(1));
  const side = args.side ?? 'company';
  const os = args.os ?? process.platform;

  if (cmd === 'facts' || cmd === 'doctor') {
    const f = facts({ os, side, root: args.root, vaultRoot: args.vault });
    if (args.json) {
      process.stdout.write(JSON.stringify(f, null, 2) + '\n');
    } else {
      const w = (k, v) => process.stdout.write(k.padEnd(22) + v + '\n');
      w('平台', f.os + ' / ' + f.arch + (f.capabilities.supported ? '' : '（不支持）'));
      w('部署根', f.root);
      w('vault', f.vaultRoot);
      w('调度', f.capabilities.scheduler + (f.scheduler.dir ? ' → ' + f.scheduler.dir : ''));
      w('提权', f.capabilities.privilege);
      w('launcher', f.capabilities.launcher);
      w('WorkBuddy', f.workbuddy.found ? f.workbuddy.exec : '未找到（只装确定性服务）');
      w('计划任务', f.scheduler.planned.length + ' 个：' + f.scheduler.planned.join(', '));
      if (f.scheduler.unsupported.length) {
        process.stdout.write('\n本平台不注册的任务：\n');
        for (const u of f.scheduler.unsupported) process.stdout.write('  ' + u.name + '  ' + (u.reason ?? '') + '\n');
      }
      if (f.why) process.stdout.write('\n' + f.why + '\n');
    }
    return 0;
  }

  if (cmd === 'paths') {
    const f = facts({ os, side, root: args.root });
    process.stdout.write(JSON.stringify({ root: f.root, vaultRoot: f.vaultRoot, paths: f.paths }, null, 2) + '\n');
    return 0;
  }

  if (cmd === 'tasks') {
    const plan = taskPlan({ os, side });
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    return 0;
  }

  if (cmd === 'plist') {
    const name = args.task;
    const task = TASKS.find((t) => t.name === name);
    if (!task) throw new UsageError('未知任务: ' + name + '（可选: ' + TASKS.map((t) => t.name).join(', ') + '）');
    if (os !== OS.MAC) throw new UsageError('plist 只对 macOS 有意义');
    const root = args.root ?? sideRoot(side, { os });
    const cmd2 = darwinCommand(task, { root, nodeExe: args.node ?? process.execPath });
    process.stdout.write(renderLaunchdPlist(task, { command: cmd2, logDir: logDir(side, { os }) }));
    return 0;
  }

  throw new UsageError('未知命令: ' + cmd + '（facts / paths / tasks / plist）');
}

if (import.meta.url === 'file://' + process.argv[1]) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    // 用法错误给一句人话，不要裸堆栈：这个文件是部署第一步会碰到的入口。
    if (e instanceof UsageError) {
      process.stderr.write('ERROR ' + e.message + '\n');
      process.exit(2);
    }
    throw e;
  }
}
