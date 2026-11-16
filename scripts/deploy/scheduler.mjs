#!/usr/bin/env node
// macOS 调度器：把 TASKS 渲染成 launchd plist，注册/卸载/对账。
//
// 为什么单独一个文件：
//   Windows 侧的计划任务在 scripts/deploy/register-tasks.ps1（schtasks，14 个任务，行为不动）。
//   macOS 没有 schtasks，但有 launchd —— 它不是"另一个 cron"，是**两类不同的 service 域**：
//     公司侧 → /Library/LaunchDaemons（system 域，开机即起，不需要任何人登录；写它要 root）
//     员工侧 → ~/Library/LaunchAgents（gui/<uid> 域，登录后起；普通用户就能写）
//   这条差别决定了"谁在跑、什么时候跑、失败怎么回退"，所以注册逻辑集中在本文，不散在入口脚本里。
//
// 边界：
//   - 只**读** scripts/platform/anc-platform.mjs（任务表、命令展开、plist 渲染都在那边，是唯一真相）。
//   - 不写 secrets：plist 的 EnvironmentVariables 只允许 ANC_SIDE / ANC_ROOT / PATH / 需要时的 NODE_OPTIONS。
//     token、webhook、corpid/corpsecret 一律走 <root>/secrets 下的文件，由运行时读 —— plist 是明文可读的。
//   - launchctl 通过注入的 runner 调用：测试里不真跑，生产里走 spawnSync。
//
// 用法：
//   node scripts/deploy/scheduler.mjs status                      # 对账（默认动作，不落盘）
//   node scripts/deploy/scheduler.mjs apply                       # 预演：打印将写什么
//   node scripts/deploy/scheduler.mjs apply --apply               # 落盘 + bootstrap
//   node scripts/deploy/scheduler.mjs apply --apply --dry-run     # --dry-run 赢，仍然不落盘
//   node scripts/deploy/scheduler.mjs --uninstall                 # bootout 后删 plist
//   node scripts/deploy/scheduler.mjs --uninstall --apply
//   公共参数：--side company|employee  --root <部署根>  --repo <仓库根>  --json
//             --launchd-dir <目录>（系统域）  --user-launchd-dir <目录>（用户域）
//             --system（系统级安装：GUI 任务落登录用户的 LaunchAgents）
//             --log-dir <目录>  --node <node 路径>  --uid <数字>
//
// 退出码：0 正常 / 1 有任务失败 / 2 用法错误 / 3 平台不支持或缺权限

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir as osHomedir } from 'node:os';
import {
  OS, SIDES,
  sideRoot, launchdDir, logDir,
  taskPlan, unsupportedTasks, darwinCommand, renderLaunchdPlist, probeWorkbuddy,
} from '../platform/anc-platform.mjs';

// ── 退出码（与 install-company.ps1 的语义对齐：2 是用法/环境，3 是平台能力）─────
export const EXIT = Object.freeze({ OK: 0, FAIL: 1, USAGE: 2, UNSUPPORTED: 3 });

// plist 里允许出现的环境变量。多一个都算事故：这个文件全局可读。
export const ALLOWED_ENV_KEYS = Object.freeze(['ANC_ROOT', 'ANC_SIDE', 'NODE_OPTIONS', 'PATH']);
const FORBIDDEN_ENV = /(token|secret|webhook|passw|corp|credential|cookie|private)/i;

const PLIST_PREFIX = 'local.anc.';
const PLIST_RE = /^local\.anc\..+\.plist$/;

// ── runner：生产用 spawnSync，测试注入假的 ────────────────────────────────
/**
 * 默认 runner。返回统一结构，调用方不关心子进程细节。
 * @param {string} program
 * @param {string[]} args
 * @param {{timeout?: number}} [opts]
 */
export function defaultRunner(program, args, opts = {}) {
  const r = spawnSync(program, args, {
    encoding: 'utf8',
    timeout: opts.timeout ?? 30000,
    windowsHide: true,
  });
  return {
    code: r.status ?? (r.error ? 127 : 1),
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error ?? null,
  };
}

/** 命令展开成人读的一行（日志与报错都用它，不要把 argv 数组直接扔给人）。 */
export function cmdline(program, args) {
  return [program, ...args]
    .map((a) => (/[\s"'$]/.test(a) ? JSON.stringify(a) : a))
    .join(' ');
}

function tail(text, lines = 2) {
  return String(text ?? '').trim().split('\n').slice(-lines).join(' ').trim();
}

// ── 平台与权限 ────────────────────────────────────────────────────────────
function currentUid(opts = {}) {
  if (Number.isInteger(opts.uid)) return opts.uid;
  return typeof process.getuid === 'function' ? process.getuid() : 0;
}

function isRoot(opts = {}) {
  return currentUid(opts) === 0;
}

/**
 * 当前"登录的桌面用户"（root 安装时用来决定 LaunchAgent 的属主与 gui 域）。
 * 来源 /dev/console 的属主 —— 这是 macOS 上判断"谁在图形会话里"的标准做法；
 * 没有图形会话（纯 SSH）时返回 null，调用方就跳过用户域任务。
 */
export function consoleUser() {
  const r = spawnSync('/bin/ls', ['-l', '/dev/console'], { encoding: 'utf8' });
  const m = r.status === 0 ? /^\S+\s+\d+\s+(\S+)\s+(\S+)\s/.exec(r.stdout) : null;
  if (!m) return null;
  const user = m[1];
  const group = m[2];
  if (!user || user === 'root') return null;
  const id = spawnSync('/usr/bin/id', ['-u', user], { encoding: 'utf8' });
  const uid = Number(String(id.stdout || '').trim());
  return Number.isInteger(uid) ? { user, group, uid } : null;
}

/** launchd 域：公司侧 system，员工侧 gui/<uid>。 */
export function domainOf(side, uid) {
  return side === 'company' ? 'system' : 'gui/' + uid;
}

/**
 * 实际 bootstrap 的域由 **plist 所在目录** 决定，而不是 side：
 *   /Library/LaunchDaemons（及其它 /Library 下目录）→ system
 *   其它（~/Library/LaunchAgents、演练用临时目录）→ gui/<uid>
 *
 * 为什么不能只看 side：2026-11-16 真机验收用 `--launchd-dir ~/Library/LaunchAgents` 装公司侧，
 * 域算成 system 后 bootstrap 全部失败；而那 10 个 plist 其实是被 launchd 在登录时自动加载的。
 * 结果就是「plist 已改成新内容，但 job 仍是旧内容」（stdout 还指向旧日志路径），
 * 现象非常像「launchd 不认新配置」，实际是域算错了。
 */
export function domainForDir(dir, side, uid) {
  if (dir && (dir === '/Library/LaunchDaemons' || dir.startsWith('/Library/'))) return 'system';
  return 'gui/' + uid;
}

// ── 环境变量：只放必要四项 ────────────────────────────────────────────────
function nodeMajor(version) {
  const m = /^v?(\d+)/.exec(String(version ?? ''));
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * plist 的 EnvironmentVariables。
 *
 * 为什么需要 NODE_OPTIONS：仓库里的 CLI 是 .ts，Node 22.14 默认不认类型（22.18 才默认开启 strip）。
 * launchd 拉起的是裸进程，没有 shell profile，所以这个开关只能写在 plist 里。
 * 只在**命令里真的带 .ts** 时才加 —— 不要给每个任务都塞一个不需要的开关。
 *
 * 为什么这里不写 patch 的 --require：WorkBuddy 是 Electron pkg，Electron 会丢弃
 * NODE_OPTIONS（实测 "Most NODE_OPTIONs are not supported in packaged apps"），
 * 补丁预载由 scripts/platform/darwin/anc-launch.sh 在 exec 前自己组装。
 */
export function plistEnv(task, ctx) {
  const env = {
    ANC_SIDE: ctx.side,
    ANC_ROOT: ctx.root,
    // launchd 不继承登录 shell 的 PATH；显式把 node 目录放第一位，后面的给 /bin/sh 与系统工具。
    PATH: [
      dirname(ctx.nodeExe),
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].filter((p, i, all) => all.indexOf(p) === i).join(':'),
  };

  const touchesTs = (ctx.command?.args ?? []).some((a) => a.endsWith('.ts')) || /\.ts$/.test(ctx.command?.program ?? '');
  if (touchesTs && nodeMajor(ctx.nodeVersion) <= 22) env.NODE_OPTIONS = '--experimental-strip-types';

  assertSafeEnv(env);
  return env;
}

/** 结构护栏：白名单外、或键名像密钥的，直接报错 —— 不要把凭据写进全局可读的 plist。 */
export function assertSafeEnv(env) {
  for (const k of Object.keys(env)) {
    if (!ALLOWED_ENV_KEYS.includes(k)) throw new Error('plist 环境变量越界: ' + k + '（只允许 ' + ALLOWED_ENV_KEYS.join('/') + '）');
    if (FORBIDDEN_ENV.test(k)) throw new Error('plist 环境变量像密钥: ' + k);
    if (/^https?:\/\//.test(String(env[k]))) throw new Error('plist 环境变量里出现 URL，疑似 webhook: ' + k);
  }
}

// ── 计划：把任务表展开成"要写的文件 + 要跑的命令" ─────────────────────────
/**
 * @param {object} [opts]
 * @param {string} [opts.os] 目标平台（测试用 darwin 固定跑）
 * @param {'company'|'employee'} [opts.side]
 * @param {string} [opts.root]
 * @param {string} [opts.env]
 * @param {string} [opts.homedir]
 * @param {string} [opts.nodeExe]
 * @param {string} [opts.nodeVersion]
 * @param {{found: boolean}} [opts.workbuddy]
 * @param {string} [opts.plistDir] 覆盖 launchdDir（测试写临时目录）
 * @param {string} [opts.logDir]   覆盖 logDir
 * @param {string} [opts.backupDestination]
 */
export function buildPlan(opts = {}) {
  const os = opts.os ?? process.platform;
  const side = opts.side ?? 'company';
  if (!SIDES.includes(side)) throw usage('side 必须是 company 或 employee，收到: ' + side);

  const home = opts.homedir ?? osHomedir();
  const root = opts.root ?? sideRoot(side, { os, env: opts.env, homedir: home });
  const nodeExe = opts.nodeExe ?? process.execPath;
  const nodeVersion = opts.nodeVersion ?? process.version;
  const wb = opts.workbuddy ?? probeWorkbuddy({ os, env: opts.env, homedir: home });
  const dir = opts.plistDir ?? launchdDir(side, { os, homedir: home });
  const logs = opts.logDir ?? logDir(side, { os, homedir: home });
  // 系统域 / 用户域：GUI 相关的任务必须是 LaunchAgent（root daemon 拉不起 WorkBuddy）
  // 用户域目录：
  //   - root 安装（真正上生产）：落到"当前登录桌面用户"的 ~/Library/LaunchAgents，属主改回该用户；
  //   - 普通用户安装（演练 / 员工侧）：与系统域同一个目录，避免多造一套路径。
  // --system：显式系统级安装。root 时用登录用户的 LaunchAgents 承载 GUI 任务；
  // 非 root 时只用于**预演**（能看见"装上后 GUI 任务会落哪"），不落盘。
  const systemMode = opts.system === true;
  const asRoot = (opts.uid ?? currentUid(opts)) === 0;
  const cu = systemMode ? consoleUser() : null;
  const userDir = opts.userPlistDir
    ?? (cu ? join('/Users', cu.user, 'Library', 'LaunchAgents') : dir);
  const uid = cu ? cu.uid : (opts.uid ?? currentUid(opts));

  if (os !== OS.MAC) {
    return {
      os, side, root, nodeExe, nodeVersion, workbuddy: wb,
      dir: null, logDir: logs,
      tasks: [],
      unsupported: [],
      reason: 'macOS 才有 launchd；' + os + ' 走 register-tasks.ps1',
    };
  }

  // 范围过滤：--scope system / user 让"root 装 daemon、用户装 agent"分两次跑（权限模型决定的）
  const scopeFilter = opts.scope ? new Set([opts.scope]) : null;
  const userLogs = opts.userLogDir ?? join(home, 'Library', 'Logs', 'anc');

  const tasks = taskPlan({ os, side, workbuddy: wb })
    .filter((t) => !scopeFilter || (t.scope === 'user' ? 'user' : 'system') === [...scopeFilter][0])
    .map((t) => {
    const command = darwinCommand(t, { root, nodeExe, workbuddy: wb, backupDestination: opts.backupDestination });
    const env = plistEnv(t, { side, root, nodeExe, nodeVersion, command });
    // 用户域任务不能把日志写进 /Library/Logs（root:wheel 755，该用户打不开 → launchd EX_CONFIG 78）
    const taskLogs = (t.scope === 'user') ? userLogs : logs;
    // 心跳契约：anc-service 的 stdout 落 <root>/data/loop.log（health / watchdog 按它判活）
    const content = renderLaunchdPlist(t, {
      command,
      env,
      logDir: taskLogs,
      ...(t.name === 'anc-service' ? { outLog: join(root, 'data', 'loop.log') } : {}),
    });
    const scope = t.scope === 'user' ? 'user' : 'system';
    const taskDir = scope === 'user' ? userDir : dir;
    return {
      name: t.name,
      label: t.label,
      desc: t.desc,
      scope,
      command,
      env,
      content,
      dir: taskDir,
      domain: domainForDir(taskDir, side, uid),
      file: join(taskDir, t.label + '.plist'),
    };
  });

  return { os, side, root, nodeExe, nodeVersion, workbuddy: wb, dir, userDir, userLogDir: userLogs, uid, logDir: logs, tasks, unsupported: unsupportedTasks({ os, side, workbuddy: wb }), reason: null };
}

/** 目录里属于本项目的 plist 文件名（按 local.anc. 前缀认领，不碰别人的 daemon）。 */
export function listPlistFiles(dir) {
  if (!dir || !existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => PLIST_RE.test(f)).sort();
  } catch {
    return [];
  }
}

/**
 * 已加载 job 的配置是否与磁盘 plist 一致（只看 ProgramArguments 与 StandardOutPath）。
 *
 * 为什么需要：launchd 在 bootstrap 时**快照** job 配置。只改了 plist 文件而没重新 bootstrap，
 * `launchctl print` 里还是旧参数/旧日志路径 —— 现象是「plist 明明改了，日志却还写旧地方」。
 * 2026-11-16 真机验收就踩到了：anc-service 的 stdout 应指向 data/loop.log，实际仍写 logs/。
 *
 * 返回 true=一致或无法判定（测试桩/旧系统拿不到 arguments），false=确实漂移。
 */
export function jobConfigMatches(label, ctx, expected = []) {
  const run = ctx.run ?? defaultRunner;
  const domain = ctx.domain ?? domainForDir(ctx.dir, ctx.side, ctx.uid);
  const r = run('launchctl', ['print', domain + '/' + label]);
  if (r.code !== 0) return false;
  const text = String(r.stdout || '');
  // 拿不到参数块就无法判定，按「没漂移」处理（避免测试桩与老系统上每次都重载）
  if (!text.includes('arguments = {')) return true;
  return expected.filter(Boolean).every((p) => text.includes(p));
}

/** 从 plist 文本里取「加载后应当出现在 launchctl print 里的字符串」：ProgramArguments + StandardOutPath。 */
export function plistConfigStrings(content) {
  const out = [];
  const argsBlock = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(content);
  if (argsBlock) {
    for (const m of argsBlock[1].matchAll(/<string>([^<]*)<\/string>/g)) out.push(unescapeXml(m[1]));
  }
  const outPath = /<key>StandardOutPath<\/key>\s*<string>([^<]*)<\/string>/.exec(content);
  if (outPath) out.push(unescapeXml(outPath[1]));
  return out;
}

function unescapeXml(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/** 该标签当前是否已加载。返回 true/false，launchctl 不可用时返回 null（未知）。 */
export function isLoaded(label, ctx) {
  const run = ctx.run ?? defaultRunner;
  const domain = ctx.domain ?? domainForDir(ctx.dir, ctx.side, ctx.uid);
  const r = run('launchctl', ['print', domain + '/' + label]);
  if (r.error && r.error.code === 'ENOENT') return null;
  return r.code === 0;
}

// ── 状态 ──────────────────────────────────────────────────────────────────
/**
 * 对账：应注册 / 已注册 / 缺 / 多余 / 内容漂移 / 是否加载。
 * 不写任何文件，退出码 0（对账本身不是失败）。
 */
export function status(opts = {}) {
  const os = opts.os ?? process.platform;
  if (os === OS.WIN) return windowsForward({ ...opts, os, mode: 'status' });
  if (os !== OS.MAC) return unsupported(os, 'status');

  const plan = buildPlan(opts);
  const run = opts.run ?? defaultRunner;
  const uid = currentUid(opts);
  const files = listPlistFiles(plan.dir);
  // 系统域 + 用户域一起看：--system 时 GUI 任务在 ~/Library/LaunchAgents，不能只扫 daemon 目录
  const userFiles = plan.userDir && plan.userDir !== plan.dir ? listPlistFiles(plan.userDir) : [];
  const presentLabels = [...new Set([...files, ...userFiles].map((f) => f.replace(/\.plist$/, '')))].sort();
  const plannedLabels = plan.tasks.map((t) => t.label);
  const loaded = {};
  for (const t of plan.tasks) loaded[t.label] = isLoaded(t.label, { side: plan.side, uid, run, domain: t.domain });

  // 内容漂移：文件在、但和当前任务表渲染出来的不一样（改了代码没重装 / 有人手改 plist）
  const drift = [];
  for (const t of plan.tasks) {
    if (!presentLabels.includes(t.label)) continue;
    try {
      if (readFileSync(t.file, 'utf8') !== t.content) drift.push(t.name);
    } catch {
      drift.push(t.name);
    }
  }

  return {
    ok: true,
    mode: 'status',
    os, side: plan.side, root: plan.root, dir: plan.dir, userDir: plan.userDir, logDir: plan.logDir,
    planned: plan.tasks.map((t) => t.name),
    present: presentLabels.filter((l) => plannedLabels.includes(l)).map(stripPrefix),
    missing: plan.tasks.filter((t) => !presentLabels.includes(t.label)).map((t) => t.name),
    surplus: presentLabels.filter((l) => !plannedLabels.includes(l)).map((l) => l + '.plist'),
    drift,
    loaded,
    unsupported: plan.unsupported,
    tasks: plan.tasks.map((t) => ({ name: t.name, label: t.label, file: t.file, command: cmdline(t.command.program, t.command.args) })),
  };
}

function stripPrefix(label) {
  return String(label).startsWith(PLIST_PREFIX) ? String(label).slice(PLIST_PREFIX.length) : String(label);
}

// ── 落盘 ──────────────────────────────────────────────────────────────────
function ensureDir(dir, dryRun) {
  if (!dir || existsSync(dir)) return { ok: true, created: false };
  if (dryRun) return { ok: true, created: true };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    return { ok: true, created: true };
  } catch (e) {
    return { ok: false, created: false, error: e.message };
  }
}

function bootstrapOne(t, ctx) {
  const { run } = ctx;
  const domain = t.domain ?? domainForDir(t.dir ?? ctx.dir, ctx.side, ctx.uid);
  const first = run('launchctl', ['bootstrap', domain, t.file]);
  if (first.code === 0) return { ok: true, via: 'bootstrap', attempt: cmdline('launchctl', ['bootstrap', domain, t.file]) };

  // 回退：老的 launchctl 子命令。新系统上 bootstrap 报 "Bootstrap failed: 5: Input/output error"
  // 常见于 plist 刚被覆盖、旧 job 还挂着；load -w 能把它用新内容拉起来（-w 同时清掉 Disabled 标记）。
  const second = run('launchctl', ['load', '-w', t.file]);
  if (second.code === 0) {
    return {
      ok: true, via: 'load',
      attempt: cmdline('launchctl', ['load', '-w', t.file]),
      note: 'bootstrap 失败后回退 load -w：' + tail(first.stderr || first.stdout, 1),
    };
  }
  return {
    ok: false, via: 'none',
    attempt: cmdline('launchctl', ['load', '-w', t.file]),
    error: 'bootstrap: ' + tail(first.stderr || first.stdout, 1) + ' / load: ' + tail(second.stderr || second.stdout, 1),
  };
}

function bootoutOne(label, ctx, task) {
  const { run } = ctx;
  const domain = task?.domain ?? domainForDir(ctx.dir, ctx.side, ctx.uid);
  const r = run('launchctl', ['bootout', domain + '/' + label]);
  return { ok: r.code === 0, code: r.code, stderr: tail(r.stderr || r.stdout, 1) };
}

/**
 * 写 plist + 加载。默认 dry-run（与仓库里其它部署脚本一致）。
 *
 * 幂等三条：
 *   1. 内容相同 → 不重写（保留 mtime，便于人看"最后一次真的变过是什么时候"）
 *   2. 已加载 → 不重复 bootstrap（重复 bootstrap 会报 already loaded，噪音且没必要）
 *   3. 内容变了且已加载 → 先 bootout 再 bootstrap，让新内容生效
 */
export function apply(opts = {}) {
  const os = opts.os ?? process.platform;
  const dryRun = opts.dryRun === true || opts.apply !== true;
  if (os === OS.WIN) return windowsForward({ ...opts, os, mode: 'apply', dryRun });
  if (os !== OS.MAC) return unsupported(os, 'apply');

  const plan = buildPlan(opts);
  const run = opts.run ?? defaultRunner;
  const uid = currentUid(opts);
  const ctx = { run, side: plan.side, uid, dir: plan.dir };

  // 公司侧写 LaunchDaemons 要 root。测试用 --launchd-dir 指到临时目录时跳过这条（不碰系统目录）。
  const systemDir = launchdDir(plan.side, { os, homedir: opts.homedir ?? osHomedir() });
  // 只按"这次真的要写的任务"判断要不要 root：--scope user 时一个系统目录都不碰
  const touchingSystem = plan.tasks.some((t) => t.dir === systemDir);
  if (opts.apply === true && plan.side === 'company' && touchingSystem && !isRoot(opts)) {
    return {
      ok: false, mode: 'apply', os, side: plan.side, dir: plan.dir, dryRun: false,
      needsRoot: true,
      error: '公司侧要写 ' + systemDir + '，只有 root 能写',
      fix: 'sudo -E node scripts/deploy/anc.mjs install --side company --apply（或 sudo node scripts/deploy/scheduler.mjs apply --apply）',
      written: [], unchanged: [], failed: [],
    };
  }

  const actions = [];
  const written = [];
  const unchanged = [];
  const failed = [];
  const skipped = [];

  const neededDirs = [...new Set(plan.tasks.map((t) => t.dir))];
  const dirRes = ensureDir(neededDirs[0] ?? plan.dir, dryRun);
  for (const d of neededDirs.slice(1)) ensureDir(d, dryRun);
  if (!dirRes.ok) {
    return {
      ok: false, mode: 'apply', os, side: plan.side, dryRun,
      needsRoot: plan.side === 'company',
      error: '建不了 plist 目录 ' + plan.dir + ': ' + dirRes.error,
      fix: plan.side === 'company' ? '用 sudo 重跑' : '检查 ' + plan.dir + ' 的权限',
      written, unchanged, failed,
    };
  }
  const neededLogs = [...new Set(plan.tasks.map((t) => (t.scope === 'user' ? plan.userLogDir : plan.logDir)))];
  for (const d of neededLogs) ensureDir(d, dryRun);
  const logRes = { ok: true };
  if (!logRes.ok) {
    // 日志目录写不了不致命：plist 仍然能加载，只是 StandardOutPath 打不开。
    actions.push({ name: '(logdir)', state: 'warn', detail: '日志目录 ' + plan.logDir + ' 建不了: ' + logRes.error });
  }

  for (const t of plan.tasks) {
    const exists = existsSync(t.file);
    let same = false;
    if (exists) {
      try {
        same = readFileSync(t.file, 'utf8') === t.content;
      } catch {
        same = false;
      }
    }
    const tctx = { ...ctx, dir: t.dir, domain: t.domain };
    const loadedNow = isLoaded(t.label, tctx);

    if (same) {
      unchanged.push(t.name);
      if (loadedNow === true) {
        // 内容没变，但**已加载的 job 可能是旧快照**（上次 bootstrap 之后才改的 plist）。
        // 比对 ProgramArguments / StandardOutPath：不一致就重载，否则日志会继续写旧路径。
        const expected = plistConfigStrings(t.content);
        if (jobConfigMatches(t.label, { ...tctx, run }, expected)) {
          actions.push({ name: t.name, state: 'unchanged+loaded', detail: '内容相同且已加载，跳过' });
          continue;
        }
        if (dryRun) {
          actions.push({ name: t.name, state: 'would-reload', detail: '已加载但 job 配置漂移，将 bootout + bootstrap' });
          continue;
        }
        bootoutOne(t.label, tctx, t);
        const b = bootstrapOne(t, tctx);
        if (b.ok) actions.push({ name: t.name, state: 'reloaded', detail: 'job 配置漂移，已 bootout + ' + b.via });
        else {
          failed.push({ name: t.name, error: b.error, attempt: b.attempt });
          actions.push({ name: t.name, state: 'FAIL', detail: b.error });
        }
        continue;
      }
      if (dryRun) {
        actions.push({ name: t.name, state: 'would-load', detail: '内容相同但未加载，将 bootstrap' });
        continue;
      }
      const b = bootstrapOne(t, tctx);
      if (b.ok) actions.push({ name: t.name, state: 'loaded', detail: b.via + (b.note ? '（' + b.note + '）' : '') });
      else {
        failed.push({ name: t.name, error: b.error, attempt: b.attempt });
        actions.push({ name: t.name, state: 'FAIL', detail: b.error });
      }
      continue;
    }

    // 内容不同（或文件不存在）：要写。
    if (dryRun) {
      actions.push({ name: t.name, state: exists ? 'would-replace' : 'would-write', detail: t.file });
      continue;
    }
    try {
      writeFileSync(t.file, t.content, { mode: 0o644 });
      written.push(t.name);
    } catch (e) {
      const needsRoot = e.code === 'EACCES' || e.code === 'EPERM';
      failed.push({ name: t.name, error: e.message, needsRoot });
      actions.push({ name: t.name, state: 'FAIL', detail: e.message + (needsRoot ? '（要 sudo）' : '') });
      continue;
    }

    // 已加载的旧 job 必须先卸掉，否则 bootstrap 会以 "already loaded" 拒绝。
    if (loadedNow === true) {
      const out = bootoutOne(t.label, tctx, t);
      actions.push({ name: t.name, state: 'unloaded', detail: out.ok ? 'bootout 旧 job' : 'bootout 失败（继续尝试 bootstrap）' });
    }
    // 属主：系统域 job 归 root:wheel；用户域 job 归**登录用户**（root 装的时候要改属主，
    // 否则该用户的 launchd 会因为 plist 属于 root 而拒绝加载）。
    if (isRoot(opts)) {
      if (t.scope === 'user') {
        const u = consoleUser();
        if (u) run('chown', [u.user + ':' + u.group, t.file]);
      } else if (plan.side === 'company') {
        run('chown', ['root:wheel', t.file]);
      }
    }

    const b = bootstrapOne(t, tctx);
    if (b.ok) actions.push({ name: t.name, state: 'written+loaded', detail: b.via + (b.note ? '（' + b.note + '）' : '') });
    else {
      failed.push({ name: t.name, error: b.error, attempt: b.attempt });
      actions.push({ name: t.name, state: 'FAIL', detail: b.error });
    }
  }

  // 多余项：默认不动（可能是同事的 daemon，也可能是旧版本残留），只提示。
  // --scope 过滤时只看**本次负责的目录**，否则另一域的 plist 会被误报成"多余"
  const scanDirs = [...new Set(plan.tasks.map((t) => t.dir))];
  const files = scanDirs.includes(plan.dir) ? listPlistFiles(plan.dir) : [];
  const userFiles = plan.userDir && plan.userDir !== plan.dir && scanDirs.includes(plan.userDir) ? listPlistFiles(plan.userDir) : [];
  const plannedLabels = plan.tasks.map((t) => t.label);
  for (const f of userFiles) {
    const label = f.replace(/\.plist$/, '');
    if (!plannedLabels.includes(label)) {
      skipped.push(label);
      actions.push({ name: stripPrefix(label), state: 'surplus', detail: '用户域里不在计划内，未处理（要清理跑 --uninstall）' });
    }
  }
  for (const f of files) {
    const label = f.replace(/\.plist$/, '');
    if (!plannedLabels.includes(label)) {
      skipped.push(label);
      actions.push({ name: stripPrefix(label), state: 'surplus', detail: '不在计划内，未处理（要清理跑 --uninstall）' });
    }
  }

  return {
    ok: failed.length === 0,
    mode: 'apply', os, side: plan.side, root: plan.root, dir: plan.dir, logDir: plan.logDir,
    dryRun,
    written, unchanged, failed, surplus: skipped,
    planned: plan.tasks.map((t) => t.name),
    unsupported: plan.unsupported,
    actions,
  };
}

// ── 卸载 ──────────────────────────────────────────────────────────────────
/** 先 bootout 再删 plist；只认领 local.anc.* —— 不碰别人的 daemon。默认 dry-run。 */
export function uninstall(opts = {}) {
  const os = opts.os ?? process.platform;
  const dryRun = opts.dryRun === true || opts.apply !== true;
  if (os === OS.WIN) return windowsForward({ ...opts, os, mode: 'uninstall', dryRun });
  if (os !== OS.MAC) return unsupported(os, 'uninstall');

  const plan = buildPlan(opts);
  const run = opts.run ?? defaultRunner;
  const uid = currentUid(opts);
  const ctx = { run, side: plan.side, uid, dir: plan.dir };

  const systemDir = launchdDir(plan.side, { os, homedir: opts.homedir ?? osHomedir() });
  if (opts.apply === true && plan.side === 'company' && plan.dir === systemDir && !isRoot(opts)) {
    return {
      ok: false, mode: 'uninstall', os, side: plan.side, dir: plan.dir, dryRun: false, needsRoot: true,
      error: '/Library/LaunchDaemons 下的 daemon 只有 root 能卸载',
      fix: 'sudo node scripts/deploy/scheduler.mjs --uninstall --apply',
      removed: [],
    };
  }

  const removed = [];
  const failed = [];
  const actions = [];
  const dirs = plan.userDir && plan.userDir !== plan.dir ? [plan.dir, plan.userDir] : [plan.dir];
  for (const dir of dirs) {
    for (const f of listPlistFiles(dir)) {
      const label = f.replace(/\.plist$/, '');
      const file = join(dir, f);
      const domain = domainForDir(dir, plan.side, uid);
      if (dryRun) {
        actions.push({ name: stripPrefix(label), state: 'would-remove', detail: file });
        continue;
      }
      const out = bootoutOne(label, { ...ctx, dir, domain }, { domain });
      actions.push({ name: stripPrefix(label), state: 'bootout', detail: out.ok ? 'ok' : '未加载/已停（忽略）' });
      try {
        unlinkSync(file);
        removed.push(label);
      } catch (e) {
        failed.push({ name: label, error: e.message });
      }
    }
  }

  return {
    ok: failed.length === 0,
    mode: 'uninstall', os, side: plan.side, dir: plan.dir, dryRun,
    removed, failed, actions,
  };
}

// ── 其它平台（linux 等）：只报告，不假装支持 ──────────────────────────────
function unsupported(os, mode) {
  return {
    ok: false, mode, os, unsupported: true, side: 'company',
    error: os + ' 没有 launchd，也不走 register-tasks.ps1',
    fix: '本仓库只承诺 Windows（schtasks）与 macOS（launchd）两条部署路径',
  };
}

// ── Windows：不重写逻辑，转调 ps1 ─────────────────────────────────────────
/**
 * Windows 上本文件只做转调：打印命令，--apply 时才真跑 register-tasks.ps1。
 * 行为必须与原来完全一致 —— 所以这里的 argv 就是 register-tasks.ps1 自己的参数表。
 */
export function windowsForward(opts = {}) {
  const mode = opts.mode ?? 'status';
  const repo = opts.repo ?? repoRoot();
  const script = join(repo, 'scripts', 'deploy', 'register-tasks.ps1');
  const root = opts.root ?? sideRoot(opts.side ?? 'company', { os: OS.WIN, env: opts.env, homedir: opts.homedir });

  if (!existsSync(script)) {
    return {
      ok: false, mode, os: OS.WIN, side: opts.side ?? 'company',
      error: '找不到 ' + script + '（仓库不完整）',
      fix: '确认 --repo 指向仓库根',
      cmdline: null,
    };
  }
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Root', root, '-Repo', repo];
  const applyMode = opts.apply === true && opts.dryRun !== true;
  if (applyMode) args.push('-Apply');
  const line = cmdline('powershell', args);

  if (mode === 'uninstall') {
    return {
      ok: true, mode, os: OS.WIN, side: opts.side ?? 'company', ran: false, cmdline: line,
      note: 'Windows 侧仍由 ps1 负责：卸载计划任务用 Unregister-ScheduledTask（register-tasks.ps1 不提供反注册）',
    };
  }

  if (!applyMode) {
    return {
      ok: true, mode, os: OS.WIN, side: opts.side ?? 'company', ran: false, cmdline: line,
      note: 'Windows 侧仍由 ps1 负责；这是预演，加 --apply 才会真跑',
    };
  }

  const run = opts.run ?? defaultRunner;
  const r = run('powershell', args);
  return {
    ok: r.code === 0,
    mode, os: OS.WIN, side: opts.side ?? 'company', ran: true, code: r.code,
    cmdline: line,
    stdout: r.stdout,
    stderr: r.stderr,
    note: 'Windows 侧仍由 ps1 负责',
  };
}

/** 仓库根：本文件在 <repo>/scripts/deploy/ 下。 */
export function repoRoot() {
  return dirname(dirname(import.meta.dirname));
}

// ── 人读输出 ──────────────────────────────────────────────────────────────
export function formatStatus(res) {
  const L = [];
  if (res.os !== OS.MAC) {
    L.push('=== 调度任务（' + res.os + '）===');
    L.push('Windows 侧仍由 ps1 负责。将执行：');
    L.push('  ' + res.cmdline);
    if (res.note) L.push(res.note);
    return L.join('\n');
  }
  L.push('=== launchd 调度（' + res.side + '）===');
  L.push('plist 目录  ' + res.dir);
  L.push('日志目录    ' + res.logDir);
  L.push('');
  const mark = (label) => {
    const state = res.loaded?.[label];
    if (res.missing.includes(stripPrefix(label))) return '[缺]    ';
    if (state === true) return '[已加载]';
    if (state === false) return '[未加载]';
    return '[未知]  ';
  };
  for (const t of res.tasks ?? []) {
    L.push('  ' + mark(t.label) + ' ' + t.label);
    L.push('           ' + t.command);
  }
  L.push('');
  if (res.surplus?.length) L.push('多余（不在计划内，未处理）：' + res.surplus.join(', '));
  if (res.drift?.length) L.push('内容漂移（跑 apply --apply 会重写）：' + res.drift.join(', '));
  if (res.unsupported?.length) {
    L.push('');
    L.push('本平台不注册的任务：');
    for (const u of res.unsupported) L.push('  ' + u.name + '  ' + (u.reason ?? ''));
  }
  return L.join('\n');
}

export function formatApply(res) {
  const L = [];
  if (res.os !== OS.MAC) {
    L.push('=== 调度任务（' + res.os + '）===');
    L.push('将执行：' + res.cmdline);
    if (res.ran) {
      L.push('退出码：' + res.code);
      if (res.stdout) L.push(String(res.stdout).trim());
      if (res.stderr) L.push(String(res.stderr).trim());
    } else if (res.note) L.push(res.note);
    if (res.error) {
      L.push('ERROR ' + res.error);
      if (res.fix) L.push('FIX   ' + res.fix);
    }
    return L.join('\n');
  }
  L.push('=== launchd ' + (res.dryRun ? '预演' : '落地') + '（' + res.side + '）===');
  L.push('plist 目录  ' + res.dir);
  L.push('');
  const m = { 'would-write': '  将写  ', 'would-replace': '  将覆盖', 'would-load': '  将加载', 'unchanged+loaded': '  不变  ', 'written+loaded': '  写入  ', loaded: '  加载  ', unloaded: '  卸载  ', surplus: '  多余  ', FAIL: '  FAIL  ', warn: '  警告  ' };
  for (const a of res.actions) L.push((m[a.state] ?? '  ..    ') + ' ' + a.name + '  ' + (a.detail ?? ''));
  L.push('');
  L.push('写 ' + res.written.length + ' / 不变 ' + res.unchanged.length + ' / 失败 ' + res.failed.length);
  if (res.error) L.push('ERROR ' + res.error);
  if (res.fix) L.push('FIX   ' + res.fix);
  if (res.dryRun && res.ok) L.push('NEXT  这是预演；加 --apply 落盘（公司侧要 sudo）。');
  for (const f of res.failed) L.push('  FAIL ' + f.name + '  ' + (f.error ?? '') + (f.needsRoot ? '（要 sudo）' : ''));
  return L.join('\n');
}

export function formatUninstall(res) {
  const L = [];
  if (res.os !== OS.MAC) {
    L.push('=== 调度任务（' + res.os + '）===');
    if (res.cmdline) L.push('将执行：' + res.cmdline);
    if (res.note) L.push(res.note);
    if (res.error) { L.push('ERROR ' + res.error); if (res.fix) L.push('FIX   ' + res.fix); }
    return L.join('\n');
  }
  L.push('=== launchd 卸载' + (res.dryRun ? '（预演）' : '') + '（' + res.side + '）===');
  if (!res.actions.length) L.push('没有要卸载的 plist（' + res.dir + '）');
  for (const a of res.actions) {
    L.push('  ' + (a.state === 'would-remove' ? '将删  ' : '已停  ') + ' ' + a.name + '  ' + (a.detail ?? ''));
  }
  L.push('');
  L.push('删 ' + res.removed.length + ' / 失败 ' + res.failed.length);
  if (res.error) { L.push('ERROR ' + res.error); if (res.fix) L.push('FIX   ' + res.fix); }
  if (res.dryRun && res.ok) L.push('NEXT  这是预演；加 --apply 才真删。');
  return L.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────
class UsageError extends Error {}
function usage(msg) {
  const e = new UsageError(msg);
  return e;
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--uninstall') out.uninstall = true;
    else if (a === '--system') out.system = true;
    else if (a === '--scope') out.scope = argv[++i];
    else if (a.startsWith('--')) {
      const k = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw usage(a + ' 需要一个值');
      out[k] = v;
      i++;
    } else out._.push(a);
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const cmd = args.uninstall ? 'uninstall' : (args._[0] ?? 'status');
  if (!['status', 'apply', 'uninstall'].includes(cmd)) {
    throw usage('未知动作: ' + cmd + '（status / apply / --uninstall）');
  }

  const opts = {
    os: args.os,
    side: args.side ?? 'company',
    root: args.root,
    repo: args.repo,
    env: process.env,
    nodeExe: args.node,
    plistDir: args.launchdDir,
    userPlistDir: args.userLaunchdDir,
    system: args.system === true,
    scope: args.scope,
    userLogDir: args.userLogDir,
    logDir: args.logDir,
    uid: args.uid !== undefined ? parseInt(args.uid, 10) : undefined,
    apply: args.apply === true,
    dryRun: args.dryRun === true,
  };
  if (Number.isNaN(opts.uid)) throw usage('--uid 要是数字');

  const res = cmd === 'status' ? status(opts) : cmd === 'apply' ? apply({ ...opts, apply: args.apply === true }) : uninstall({ ...opts, apply: args.apply === true });

  if (args.json) process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  else {
    const text = cmd === 'status' ? formatStatus(res) : cmd === 'apply' ? formatApply(res) : formatUninstall(res);
    process.stdout.write(text + '\n');
  }
  if (res.ok) return EXIT.OK;
  if (res.unsupported) return EXIT.UNSUPPORTED;
  return EXIT.FAIL;
}

const isMain = process.argv[1] && import.meta.url === 'file://' + process.argv[1];
if (isMain) {
  try {
    process.exit(main());
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write('ERROR ' + e.message + '\n');
      process.exit(EXIT.USAGE);
    }
    // 不裸抛堆栈：这个文件是部署入口，堆栈对部署者没有信息量。
    process.stderr.write('ERROR ' + (e && e.message ? e.message : String(e)) + '\n');
    process.exit(EXIT.FAIL);
  }
}
