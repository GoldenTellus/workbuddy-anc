#!/usr/bin/env node
// 统一部署入口（macOS 一条命令装完；Windows 转调原 ps1，行为零变化）。
//
// 为什么要有它：
//   Windows 侧有 install-company.ps1 固化 11 步顺序；macOS 上如果让部署者自己敲
//   mkdir / deploy.mjs / scheduler.mjs / verify 四条命令，装错的概率和 Windows 早期一样高。
//   这个入口只做一件事：把 mac 侧的 4 步固化成一个顺序，失败即停、可 --from 续跑、每步记账。
//
// 阶段（与 deploy-state 的阶段 id 对齐，记账时把 scheduler 映射到 tasks）：
//   dirs → files → scheduler → verify
//   dirs      建 <root> 的 15 个目录 + vault 两区 5 个目录（幂等）
//   files     调部署引擎 scripts/deploy/deploy.mjs（T3 产出；本文件不 import 它）
//   scheduler 调本仓库的 launchd 调度器（写 plist + bootstrap，公司侧要 sudo）
//   verify    自检：目录 / 关键文件 / plist 是否加载 / deploy-state 进度
//
// 外部命令契约（**按 CLI 调，不 import**：它们由别的任务产出，可能还没到位）：
//   node scripts/deploy/deploy.mjs --repo <repo> --root <root> --side <side> [--apply] [--json]
//   node scripts/deploy/deploy-state.mjs --side <side> --root <root> --mark <stage> --as-done --json
// 不存在时给 "先完成部署引擎" 的 ERROR，而不是崩在 ERR_MODULE_NOT_FOUND 堆栈上。
//
// 用法：
//   node scripts/deploy/anc.mjs doctor                  # 体检（人读）
//   node scripts/deploy/anc.mjs plan --side company      # 预演会建什么/复制什么/注册什么（不落盘）
//   node scripts/deploy/anc.mjs install --side company            # 预演四步
//   sudo -E node scripts/deploy/anc.mjs install --side company --apply   # 真装（公司侧）
//   node scripts/deploy/anc.mjs install --side company --apply --from files   # 续跑
//   node scripts/deploy/anc.mjs verify --side company    # 只跑自检
//   公共参数：--root --repo --vault --os --json --from <阶段> --skip <阶段> --uid <n>
//
// 退出码：0 全好 / 1 有失败 / 2 用法错误 / 3 平台不支持或缺权限（要 sudo）

import { existsSync, accessSync, chmodSync, constants as fsConstants, copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir as osHomedir } from 'node:os';
import {
  OS, DEPLOY_DIRS, VAULT_DIRS,
  sideRoot, defaultVaultRoot, capabilities, facts, launchdDir, logDir,
  taskPlan, unsupportedTasks, probeWorkbuddy,
} from '../platform/anc-platform.mjs';
import {
  apply as schedulerApply, status as schedulerStatus, consoleUser,
  formatApply as formatSchedulerApply, formatStatus as formatSchedulerStatus,
} from './scheduler.mjs';

// 退出码（与 docs/PLATFORMS.md 的命令面约定一致）：
//   0 成功 / 1 失败（含缺 sudo：FIX 里给命令）/ 2 用法错误 / 3 已应用但复验失败
export const EXIT = Object.freeze({ OK: 0, FAIL: 1, USAGE: 2, VERIFY_FAIL: 3 });

// 阶段顺序是契约：--from 用这里的名字，deploy-state 用 STAGE_ALIAS 的值记账。
export const STAGES = Object.freeze(['dirs', 'files', 'perms', 'scheduler', 'verify']);
// 记账阶段映射：mac 的四步落到 deploy-state 的哪个 id。
//   公司侧 14 阶段：dirs / files / tasks（注册计划任务 = 装调度器）/ verify 都对得上。
//   员工侧 9 阶段（brief/answers/preflight/workbuddy/files/skills/persona/bind/verify）
//   **没有 dirs 也没有 tasks**：这两步在员工侧由 bootstrap 内联完成，所以记 null = 不记账，
//   而不是硬塞一个相邻阶段（塞 files 会让"文件没铺"看起来已完成）。
export const STAGE_ALIAS = Object.freeze({
  // perms 只做属主/权限收尾，没有独立账本阶段（与 deploy-state 对齐：不记）
  company: Object.freeze({ dirs: 'dirs', files: 'files', perms: null, scheduler: 'tasks', verify: 'verify' }),
  employee: Object.freeze({ dirs: null, files: 'files', perms: null, scheduler: null, verify: 'verify' }),
});
// 反向：--from tasks 也认，避免部署者按 deploy-state 的 id 续跑时被拒。
const STAGE_FROM_ALIAS = Object.freeze({ tasks: 'scheduler' });

class UsageError extends Error {}
const usage = (m) => new UsageError(m);

// ── 上下文 ────────────────────────────────────────────────────────────────
export function contextFrom(opts = {}) {
  const os = opts.os ?? process.platform;
  const side = opts.side ?? 'company';
  if (side !== 'company' && side !== 'employee') throw usage('side 必须是 company 或 employee，收到: ' + side);
  const home = opts.homedir ?? osHomedir();
  const repo = opts.repo ?? dirname(dirname(import.meta.dirname));
  const root = opts.root ?? sideRoot(side, { os, homedir: home });
  const vault = opts.vault ?? defaultVaultRoot(side, { os, homedir: home });
  const uid = Number.isInteger(opts.uid) ? opts.uid : (typeof process.getuid === 'function' ? process.getuid() : 0);
  return {
    os, side, repo, root, vault, home, uid,
    // 落点覆盖：默认 /Library/LaunchDaemons 或 ~/Library/LaunchAgents；
    // 指到别处只用于验证（临时目录里跑完整四步），生产不要传。
    // 两种拼写都认：CLI 参数是 --launchd-dir（→ launchdDir），透传的 ctx 里字段叫 plistDir。
    plistDir: opts.plistDir ?? opts.launchdDir,
    system: opts.system === true,
    userPlistDir: opts.userPlistDir,
    logDir: opts.logDir,
    // launchctl 的 runner 从这里透传（测试注入假的，生产走默认 spawnSync）
    run: opts.run,
    apply: opts.apply === true,
    json: opts.json === true,
    osLabel: os === OS.MAC ? 'macOS' : os === OS.WIN ? 'Windows' : os,
  };
}

// ── 外部命令（部署引擎 / 记账引擎）────────────────────────────────────────
/** 跑仓库里的一个 node 脚本；不存在时返回 missing 标记，绝不抛 ERR_MODULE_NOT_FOUND。 */
export function runNodeScript(script, args, opts = {}) {
  if (!existsSync(script)) return { code: 127, missing: true, stdout: '', stderr: '' };
  const r = spawnSync(opts.nodeExe ?? process.execPath, [script, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd,
    timeout: opts.timeout ?? 600000,
    windowsHide: true,
  });
  // node 在文件存在但自身 import 失败时也会 exit 1；这种情况要把 stderr 带出去，不能吞。
  return { code: r.status ?? 1, missing: false, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ?? null };
}

const ENGINE_MISSING = '先完成部署引擎（scripts/deploy/deploy.mjs 还没产出）';
const STATE_MISSING = '先完成部署引擎（scripts/deploy/deploy-state.mjs 还没产出）';

function lastErrorLine(r, lines = 2) {
  const text = [r.stderr, r.stdout].filter(Boolean).join('\n').trim();
  if (!text) return 'exit=' + r.code;
  return text.split('\n').filter(Boolean).slice(-lines).join(' ');
}

/** 解析子命令的 --json 输出（引擎的输出里可能混了日志行，取最后一个能解析的对象）。 */
export function parseJsonLoose(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch { /* 继续往下找 */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch { /* 放弃 */ }
  }
  return null;
}

// ── doctor ────────────────────────────────────────────────────────────────
function nodeMajor(version) {
  const m = /^v?(\d+)/.exec(String(version ?? ''));
  return m ? parseInt(m[1], 10) : 0;
}

function canWrite(dir) {
  try {
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function nearestExisting(path) {
  let p = path;
  for (let i = 0; i < 8; i++) {
    if (existsSync(p)) return p;
    const parent = dirname(p);
    if (parent === p) return null;
    p = parent;
  }
  return existsSync(p) ? p : null;
}

/**
 * 体检：把"这台机器能不能装、缺什么"一次回答完。
 * 与 scripts/deploy/preflight.ps1 的分工：ps1 管 Windows 的 UAC/SYSTEM 那套；
 * 这里只管 mac 的 sudo/launchd/WorkBuddy，以及两个平台都需要的 Node 与部署引擎。
 */
export function doctor(opts = {}) {
  const ctx = contextFrom(opts);
  const f = facts({ os: ctx.os, side: ctx.side, root: ctx.root, vaultRoot: ctx.vault, homedir: ctx.home });
  const checks = [];
  const add = (name, state, detail, fix) => checks.push({ name, state, detail, fix: fix ?? null });

  // 平台
  if (f.capabilities.supported) add('平台', 'ok', ctx.os + ' / ' + f.arch + '（' + f.capabilities.scheduler + '）');
  else add('平台', 'fail', ctx.osLabel + ' 不支持', f.why ?? '只承诺 Windows 与 macOS');

  // Node
  const major = nodeMajor(process.version);
  if (major >= 22) add('node', 'ok', process.version + '  ' + process.execPath);
  else if (major >= 18) add('node', 'warn', process.version + '（低于基线 22 LTS，.ts 直跑要 --experimental-strip-types）', '装 Node 22 LTS');
  else add('node', 'fail', process.version + '（太旧）', '装 Node 22 LTS');

  // 部署根
  if (existsSync(ctx.root)) {
    if (canWrite(ctx.root)) add('部署根', 'ok', ctx.root + '（可写）');
    else if (ctx.side === 'company' && ctx.uid !== 0) add('部署根', 'warn', ctx.root + '（现在不可写：公司侧要 sudo 才能落地）', 'sudo -E node scripts/deploy/anc.mjs install --side company --apply');
    else add('部署根', 'warn', ctx.root + '（存在但不可写）', '检查属主：sudo chown -R root:wheel ' + ctx.root);
  } else {
    const parent = nearestExisting(dirname(ctx.root));
    const pw = parent ? canWrite(parent) : false;
    add(
      '部署根',
      ctx.side === 'company' && ctx.uid !== 0 ? 'warn' : pw ? 'ok' : 'fail',
      ctx.root + '（还没有，父目录 ' + (parent ?? '?') + (pw ? ' 可写' : ' 不可写') + '）',
      ctx.side === 'company' ? 'sudo -E node scripts/deploy/anc.mjs install --side company --apply' : 'install 会创建它',
    );
  }

  // vault
  if (existsSync(ctx.vault)) {
    add('vault', canWrite(ctx.vault) ? 'ok' : 'warn', ctx.vault + (canWrite(ctx.vault) ? '（可写）' : '（不可写）'), canWrite(ctx.vault) ? null : 'sudo chown -R root:wheel ' + ctx.vault);
  } else {
    const parent = nearestExisting(dirname(ctx.vault));
    add('vault', parent && canWrite(parent) ? 'ok' : 'warn', ctx.vault + '（还没有）', 'install 的 dirs 阶段会创建');
  }

  // WorkBuddy
  if (f.workbuddy.found) add('WorkBuddy', 'ok', f.workbuddy.exec);
  else add('WorkBuddy', 'warn', '未找到（只装确定性服务：service/http/backup/cleanup/watchdog 仍会跑）', ctx.os === OS.MAC ? '装到 /Applications/WorkBuddy.app，或用 ANC_WORKBUDDY_APP 指定' : '见 BOOTSTRAP 第 0 步');

  // 调度器落点
  const schedDir = launchdDir(ctx.side, { os: ctx.os, homedir: ctx.home });
  if (ctx.os === OS.MAC) {
    if (!schedDir) add('launchd', 'warn', '没有 launchd 目录（平台不支持）', null);
    else if (!existsSync(schedDir)) add('launchd', 'fail', schedDir + ' 不存在', '确认系统完整性；公司侧可能被 MDM 收走');
    else if (canWrite(schedDir)) add('launchd', 'ok', schedDir + '（可写）');
    else if (ctx.side === 'company') add('launchd', 'warn', schedDir + '（要 root 才能写）', 'sudo -E node scripts/deploy/anc.mjs install --side company --apply');
    else add('launchd', 'fail', schedDir + ' 不可写', '检查 ~/Library 权限');
    const logs = logDir(ctx.side, { os: ctx.os, homedir: ctx.home });
    add('launchd 日志', canWrite(logs) || canWrite(nearestExisting(logs) ?? '/tmp') ? 'ok' : 'warn', logs, null);
  } else {
    add('调度器', 'ok', f.capabilities.scheduler + ' → ' + f.capabilities.schedulerOwner);
  }

  // 提权
  if (ctx.os === OS.MAC) {
    add('权限', ctx.uid === 0 ? 'ok' : (ctx.side === 'company' ? 'warn' : 'ok'),
      ctx.uid === 0 ? 'root' : '普通用户（uid=' + ctx.uid + '）',
      ctx.side === 'company' && ctx.uid !== 0 ? '公司侧装 LaunchDaemon 要一次 sudo' : null);
  } else {
    add('权限', 'warn', '管理员权限由 ps1 自己检查（preflight.ps1）', 'powershell -File scripts\\deploy\\preflight.ps1 -Side ' + ctx.side + ' -Json');
  }

  // 部署引擎（别的任务产出，缺了这里要能看见）
  const engine = join(ctx.repo, 'scripts', 'deploy', 'deploy.mjs');
  const state = join(ctx.repo, 'scripts', 'deploy', 'deploy-state.mjs');
  add('部署引擎', existsSync(engine) ? 'ok' : 'warn', existsSync(engine) ? engine : '缺 scripts/deploy/deploy.mjs', existsSync(engine) ? null : ENGINE_MISSING);
  add('记账引擎', existsSync(state) ? 'ok' : 'warn', existsSync(state) ? state : '缺 scripts/deploy/deploy-state.mjs', existsSync(state) ? null : STATE_MISSING);

  // darwin 启动器（源文件）
  if (ctx.os === OS.MAC) {
    const dir = join(ctx.repo, 'scripts', 'platform', 'darwin');
    const want = ['anc-launch.sh', 'cleanup-media.sh', 'watchdog.sh', 'boot-alert.sh'];
    const missing = want.filter((w) => !existsSync(join(dir, w)));
    add('启动器脚本', missing.length ? 'fail' : 'ok', missing.length ? '缺 ' + missing.join(', ') : dir, missing.length ? '仓库不完整，重新 clone' : null);
  }

  // 进度（有记账引擎才查）
  if (existsSync(state) && existsSync(join(ctx.root, 'data', 'deploy-state.json'))) {
    const r = runNodeScript(state, ['--side', ctx.side, '--root', ctx.root, '--json'], { cwd: ctx.repo });
    const st = parseJsonLoose(r.stdout);
    if (st) add('部署进度', st.ok ? 'ok' : 'warn', (st.progress ?? '?') + (st.failed ? '  卡在 ' + st.failed : ''), st.next ?? null);
  }

  const ok = !checks.some((c) => c.state === 'fail');
  return { ok, os: ctx.os, side: ctx.side, root: ctx.root, vault: ctx.vault, checks, facts: f };
}

// ── plan ──────────────────────────────────────────────────────────────────
/**
 * 预演：绝不写盘。三个部分 —— 目录、文件（部署引擎 dry-run）、调度任务（launchd 预演）。
 */
export function plan(opts = {}) {
  const ctx = contextFrom(opts);
  const sections = [];

  // 1) 目录
  const dirTargets = [
    ctx.root,
    ctx.vault,
    ...DEPLOY_DIRS.map((d) => join(ctx.root, d)),
    ...VAULT_DIRS.map((d) => join(ctx.vault, d)),
  ];
  sections.push({
    step: 'dirs',
    items: dirTargets.map((p) => ({ path: p, exists: existsSync(p) })),
  });

  // 2) 文件：交给部署引擎预演（不 import，按 CLI 契约）
  const deployMjs = join(ctx.repo, 'scripts', 'deploy', 'deploy.mjs');
  let files;
  if (!existsSync(deployMjs)) {
    files = { ok: false, missing: true, error: ENGINE_MISSING };
  } else {
    const r = runNodeScript(deployMjs, ['--repo', ctx.repo, '--root', ctx.root, '--side', ctx.side, '--json'], { cwd: ctx.repo });
    files = {
      ok: r.code === 0,
      code: r.code,
      parsed: parseJsonLoose(r.stdout),
      out: (r.stdout || r.stderr || '').trim(),
      error: r.code === 0 ? null : lastErrorLine(r),
    };
  }
  sections.push({ step: 'files', ...files });

  // 3) 调度：launchd 预演（Windows 打印转调命令）
  const sched = schedulerApply({ os: ctx.os, side: ctx.side, root: ctx.root, repo: ctx.repo, plistDir: ctx.plistDir, system: ctx.system, userPlistDir: ctx.userPlistDir, logDir: ctx.logDir, run: ctx.run, apply: false, dryRun: true, uid: ctx.uid, env: process.env, homedir: ctx.home });
  sections.push({ step: 'scheduler', ok: sched.ok, result: sched, text: formatSchedulerApply(sched) });

  // 4) 自检（预演阶段只报告"将来会检查什么"）
  sections.push({ step: 'verify', note: '落盘后跑 verify 自检（目录 / 关键文件 / plist 加载 / deploy-state 进度）' });

  return { ok: files.ok !== false && sched.ok !== false, os: ctx.os, side: ctx.side, root: ctx.root, vault: ctx.vault, apply: false, sections };
}

// ── install ───────────────────────────────────────────────────────────────
function stageDirs(ctx) {
  const targets = [
    ctx.root,
    ctx.vault,
    ...DEPLOY_DIRS.map((d) => join(ctx.root, d)),
    ...VAULT_DIRS.map((d) => join(ctx.vault, d)),
  ];
  const created = [];
  const existing = [];
  const failed = [];
  for (const p of targets) {
    if (existsSync(p)) {
      existing.push(p);
      continue;
    }
    created.push(p);
    if (!ctx.apply) continue;
    try {
      mkdirSync(p, { recursive: true, mode: 0o755 });
    } catch (e) {
      failed.push({ path: p, error: e.message, needsRoot: e.code === 'EACCES' || e.code === 'EPERM' });
    }
  }
  return { ok: failed.length === 0, created, existing, failed };
}

/**
 * mac 专属运行件（保险层）。
 *
 * 部署清单已经把 darwin-only 项（platform/darwin/*.sh 与几个 .mjs 后端）登记进去了，
 * 所以正常路径由 deploy.mjs 铺。这里仍然补一遍，理由是清单是别人的文件、会随平台对拍调整，
 * 而 launchd 的 plist 直接指着 <root>/bin/anc-launch.sh —— 缺了它任务就是"注册成功但从不工作"。
 *
 * 幂等：目标已存在且字节相同 → 不动（不刷 mtime，不制造假的"刚部署过"）。
 */
function copyMacExtras(ctx) {
  const shSrc = join(ctx.repo, 'scripts', 'platform', 'darwin');
  const items = [
    ...['anc-launch.sh', 'cleanup-media.sh', 'watchdog.sh', 'boot-alert.sh'].map((n) => ({ name: n, from: join(shSrc, n), mode: 0o755 })),
    { name: 'cleanup-media.mjs', from: join(ctx.repo, 'scripts', 'backup', 'cleanup-media.mjs'), mode: 0o644 },
    { name: 'watchdog.mjs', from: join(ctx.repo, 'scripts', 'selfheal', 'watchdog.mjs'), mode: 0o644 },
    { name: 'executor-tasks.mjs', from: join(ctx.repo, 'scripts', 'executor', 'executor-tasks.mjs'), mode: 0o644 },
  ];
  const out = [];
  const bin = join(ctx.root, 'bin');
  for (const it of items) {
    const to = join(bin, it.name);
    if (!existsSync(it.from)) {
      out.push({ name: it.name, state: 'missing-source', from: it.from, to });
      continue;
    }
    if (!ctx.apply) {
      out.push({ name: it.name, state: 'would-copy', from: it.from, to });
      continue;
    }
    try {
      if (existsSync(to) && readFileSync(to).equals(readFileSync(it.from))) {
        // 内容一致也要确保可执行位（清单复制可能不带 mode）
        if ((statSync(to).mode & 0o111) !== (it.mode & 0o111)) chmodSync(to, it.mode);
        out.push({ name: it.name, state: 'unchanged', from: it.from, to });
        continue;
      }
      mkdirSync(bin, { recursive: true, mode: 0o755 });
      copyFileSync(it.from, to);
      chmodSync(to, it.mode);
      out.push({ name: it.name, state: 'copied', from: it.from, to });
    } catch (e) {
      out.push({ name: it.name, state: 'failed', error: e.message, from: it.from, to });
    }
  }
  return out;
}

function stageFiles(ctx) {
  const deployMjs = join(ctx.repo, 'scripts', 'deploy', 'deploy.mjs');
  if (!existsSync(deployMjs)) return { ok: false, missing: true, error: '找不到 ' + deployMjs + '（先完成部署引擎）', fix: ENGINE_MISSING };
  const args = ['--repo', ctx.repo, '--root', ctx.root, '--side', ctx.side];
  if (ctx.apply) args.push('--apply');
  args.push('--json');
  const r = runNodeScript(deployMjs, args, { cwd: ctx.repo });
  const parsed = parseJsonLoose(r.stdout);
  const extras = ctx.os === OS.MAC ? copyMacExtras(ctx) : [];
  const extrasFailed = extras.filter((e) => e.state === 'failed');
  return {
    ok: r.code === 0 && extrasFailed.length === 0,
    code: r.code,
    dryRun: !ctx.apply,
    out: (r.stdout || '').trim(),
    parsed,
    extras,
    error: r.code !== 0 ? lastErrorLine(r) : extrasFailed.length ? '补 mac 运行件失败: ' + extrasFailed.map((e) => e.name + ' ' + e.error).join('; ') : null,
    fix: r.code === 3 ? '部署引擎拒绝执行（通常是缺清单/文件不存在），看上面 ERROR' : null,
  };
}

/**
 * 系统级安装的属主/权限（只 root + company + --system 时执行）。
 *
 * 为什么必须有这一步：
 *   root 铺出来的 <root>/data 是 root:admin 755，而**补丁启动器是以登录用户身份跑的**
 *   （GUI 任务在用户域），它要写 patch-run.json / preload 要写 patch-state.json →
 *   直接 EACCES，表现是"补丁启动成功但状态永远不出现"。Windows 侧对应的是 set-acl.ps1
 *   给部署用户 data Modify（GAP-114），这里是同一件事的 mac 版。
 *
 * 规则：data / inbox / backup 归登录用户（运行时要写）；secrets 留 root、组 staff 可读；
 *       其余代码目录 755/644 只读。
 */
function stagePerms(ctx) {
  if (ctx.os !== OS.MAC) return { ok: true, skipped: 'not-mac' };
  if (!(ctx.side === 'company' && ctx.system)) return { ok: true, skipped: 'not-system-install' };
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    return { ok: false, error: '系统级安装的权限收尾要 root', fix: '用 sudo（或 --system 的安装脚本）重跑' };
  }
  const cu = consoleUser();
  if (!cu) return { ok: false, error: '找不到登录的桌面用户（/dev/console）', fix: '确保有人在这台机器的图形会话里登录，再重跑 --from perms' };
  const owner = cu.user + ':' + cu.group;
  const actions = [];
  const run = (program, args) => {
    const r = spawnSync(program, args, { encoding: 'utf8' });
    actions.push({ cmd: [program, ...args].join(' '), code: r.status ?? 1, err: (r.stderr || '').trim().slice(0, 200) });
    return (r.status ?? 1) === 0;
  };
  for (const rel of ['', 'data', 'inbox', 'backup']) {
    const p = rel ? join(ctx.root, rel) : ctx.root;
    if (!existsSync(p)) continue;
    run('/usr/sbin/chown', [owner, p]);
  }
  for (const rel of ['', 'data', 'inbox', 'backup', 'patch', 'bin', 'service', 'secrets']) {
    const p = rel ? join(ctx.root, rel) : ctx.root;
    if (!existsSync(p)) continue;
    run('/bin/chmod', [rel === 'secrets' ? '750' : '755', p]);
  }
  return { ok: actions.every((a) => a.code === 0), owner, actions };
}

function stageScheduler(ctx) {
  const res = schedulerApply({
    os: ctx.os, side: ctx.side, root: ctx.root, repo: ctx.repo,
    plistDir: ctx.plistDir, system: ctx.system, userPlistDir: ctx.userPlistDir, logDir: ctx.logDir, run: ctx.run,
    apply: ctx.apply, dryRun: !ctx.apply, uid: ctx.uid, env: process.env, homedir: ctx.home,
  });
  return { ok: res.ok, res, text: formatSchedulerApply(res), error: res.error ?? null, fix: res.fix ?? null, needsRoot: res.needsRoot === true };
}

/** 自检项。hard=true 的失败会让 verify 阶段失败。 */
export function collectVerify(ctx) {
  const checks = [];
  const add = (name, state, detail, fix, hard = false) => checks.push({ name, state, detail, fix: fix ?? null, hard });

  for (const d of DEPLOY_DIRS) {
    const p = join(ctx.root, d);
    add('目录 ' + d, existsSync(p) ? 'ok' : 'fail', p, existsSync(p) ? null : '跑 install 的 dirs 阶段（或 sudo 重跑）', true);
  }
  for (const d of VAULT_DIRS) {
    const p = join(ctx.vault, d);
    add('vault ' + d, existsSync(p) ? 'ok' : 'warn', p, existsSync(p) ? null : '跑 install 的 dirs 阶段');
  }

  // 硬项 = 这一层自己必须保证的（仓库入口 + launchd 薄壳）；
  // 软项 = 别的任务产出的 Node 后端，缺了只提示（不在本文件写作用域内）。
  const hardFiles = ctx.os === OS.MAC ? ['service/cli.ts', 'bin/anc-launch.sh'] : ['service/cli.ts', 'bin/anc-loop.cmd'];
  for (const rel of hardFiles) {
    const p = join(ctx.root, rel);
    add('文件 ' + rel, existsSync(p) ? 'ok' : 'fail', p, existsSync(p) ? null : '跑 install 的 files 阶段（deploy.mjs --apply）', true);
  }
  if (ctx.os === OS.MAC) {
    for (const rel of ['bin/cleanup-media.sh', 'bin/watchdog.sh', 'bin/boot-alert.sh', 'bin/cleanup-media.mjs', 'bin/watchdog.mjs', 'bin/executor-tasks.mjs']) {
      const p = join(ctx.root, rel);
      add('文件 ' + rel, existsSync(p) ? 'ok' : 'warn', p, existsSync(p) ? null : '由 files 阶段补拷；缺了对应任务会以 exit 2 报错');
    }
  }

  const preload = join(ctx.root, 'patch', 'preload.cjs');
  add('补丁 preload', existsSync(preload) ? 'ok' : 'warn', preload, existsSync(preload) ? null : 'mac 侧补丁未移植时属预期；无补丁不影响确定性服务');

  if (ctx.os === OS.MAC) {
    const sched = schedulerStatus({ os: ctx.os, side: ctx.side, root: ctx.root, repo: ctx.repo, plistDir: ctx.plistDir, system: ctx.system, userPlistDir: ctx.userPlistDir, logDir: ctx.logDir, run: ctx.run, uid: ctx.uid, env: process.env, homedir: ctx.home });
    if (sched.os === OS.MAC) {
      const missing = sched.missing ?? [];
      const notLoaded = Object.entries(sched.loaded ?? {}).filter(([, v]) => v === false).map(([k]) => k);
      add('plist 齐全', missing.length ? 'fail' : 'ok',
        missing.length ? '缺 ' + missing.join(', ') : sched.planned.length + ' 个 plist 都在 ' + sched.dir,
        missing.length ? '跑 install 的 scheduler 阶段（公司侧要 sudo）' : null, true);
      add('plist 已加载', notLoaded.length ? 'warn' : 'ok',
        notLoaded.length ? '未加载：' + notLoaded.join(', ') : '全部已加载',
        notLoaded.length ? 'launchctl print 看不到；重新跑 scheduler --apply，或看 /Library/Logs/anc' : null);
      if (sched.surplus?.length) add('多余 plist', 'warn', sched.surplus.join(', '), '不在计划内；确认后跑 scheduler --uninstall');
    }
  }

  const stateMjs = join(ctx.repo, 'scripts', 'deploy', 'deploy-state.mjs');
  if (existsSync(stateMjs)) {
    const r = runNodeScript(stateMjs, ['--side', ctx.side, '--root', ctx.root, '--json'], { cwd: ctx.repo });
    const st = parseJsonLoose(r.stdout);
    if (st) {
      add('deploy-state', st.ok ? 'ok' : 'warn', (st.progress ?? '?') + '  done=' + (st.done ?? []).join(',') + (st.failed ? '  failed=' + st.failed : ''), st.next ?? null);
    } else {
      add('deploy-state', 'warn', '有 deploy-state.mjs 但输出解析不了', 'node ' + stateMjs + ' --side ' + ctx.side + ' --json 手工看一眼');
    }
  } else {
    add('deploy-state', 'warn', '没有 scripts/deploy/deploy-state.mjs', STATE_MISSING);
  }

  const ok = !checks.some((c) => c.hard && c.state === 'fail');
  return { ok, checks };
}

function stageVerify(ctx) {
  const v = collectVerify(ctx);
  return { ok: v.ok, checks: v.checks };
}

/** 记账：spawn deploy-state.mjs（不 import）。缺文件只警告 —— 不因为记账引擎没到位就否定安装结果。 */
export function markStage(ctx, stage, ok, reason) {
  const script = join(ctx.repo, 'scripts', 'deploy', 'deploy-state.mjs');
  if (!ctx.apply) return { skipped: true, why: 'dry-run 不记账' };
  const id = (STAGE_ALIAS[ctx.side] ?? {})[stage] ?? null;
  if (!id) {
    return { skipped: true, why: ctx.side + ' 侧 deploy-state 没有对应阶段：' + stage + ' 这一步在该侧不单独记账' };
  }
  if (!existsSync(script)) return { skipped: true, why: STATE_MISSING };
  const args = ['--side', ctx.side, '--root', ctx.root, '--mark', id];
  if (ok) args.push('--as-done');
  else args.push('--as-failed', '--reason', reason || 'anc.mjs 在 ' + stage + ' 阶段失败');
  args.push('--json');
  const r = runNodeScript(script, args, { cwd: ctx.repo });
  // 记 done 时 exit 0；记 failed 时 exit 1 是正常返回值，不是记账失败。
  const codeOk = ok ? r.code === 0 : r.code === 0 || r.code === 1;
  return {
    skipped: false,
    ok: codeOk,
    code: r.code,
    stageId: id,
    note: codeOk ? null : 'deploy-state 拒绝记账（exit=' + r.code + '）' + (r.code === 2 ? '：阶段 id 不匹配，检查 deploy-state 的阶段表' : ''),
    detail: lastErrorLine(r, 1),
  };
}

const STAGE_RUNNERS = { dirs: stageDirs, files: stageFiles, perms: stagePerms, scheduler: stageScheduler, verify: stageVerify };

/**
 * 四步安装。默认预演；--apply 才落盘。
 * 失败即停（和 install-company.ps1 一致），并给出 -From 的续跑提示。
 */
export function install(opts = {}) {
  const ctx = contextFrom(opts);
  const cap = capabilities(ctx.os);
  if (!cap.supported) {
    return { ok: false, os: ctx.os, side: ctx.side, unsupported: true, error: cap.supported ? null : ctx.osLabel + ' 不支持', fix: cap.supported ? null : '只承诺 Windows 与 macOS' };
  }

  // Windows：只转调，不在 mac 语义上执行任何阶段（main 已先路由；这里是直接调用时的护栏）
  if (ctx.os === OS.WIN) {
    const c = windowsCommand(ctx, 'install');
    return {
      ok: true, os: ctx.os, side: ctx.side, apply: ctx.apply, steps: [],
      forwarded: quoteArgs(c.line),
      note: 'Windows 侧仍由 ps1 负责（install-company.ps1）；本入口不重写 Windows 逻辑',
    };
  }

  // 公司侧 LaunchDaemon 要 root：**明确提示用 sudo**，不要装到一半才发现写不进 /Library。
  // 落点被显式覆盖（--launchd-dir 指到临时目录）时不拦：那是验证/演练，不碰系统目录。
  const systemPlistDir = launchdDir(ctx.side, { os: ctx.os, homedir: ctx.home });
  const touchingSystem = !ctx.plistDir || ctx.plistDir === systemPlistDir;
  if (ctx.os === OS.MAC && ctx.side === 'company' && ctx.apply && ctx.uid !== 0 && touchingSystem) {
    return {
      ok: false, os: ctx.os, side: ctx.side, needsRoot: true,
      error: '公司侧要写 /Library/Application Support/anc 与 /Library/LaunchDaemons，需要 root',
      fix: 'sudo -E node scripts/deploy/anc.mjs install --side company --apply' + (opts.from ? ' --from ' + opts.from : ''),
      steps: [],
    };
  }

  // --from / --skip
  const fromRaw = opts.from ? String(opts.from) : null;
  const from = fromRaw ? (STAGE_FROM_ALIAS[fromRaw] ?? fromRaw) : null;
  if (from && !STAGES.includes(from)) {
    return { ok: false, os: ctx.os, side: ctx.side, usage: true, error: '--from 里有未知阶段: ' + fromRaw, fix: '可选: ' + STAGES.join(', ') };
  }
  const skip = (opts.skip ?? []).map((s) => STAGE_FROM_ALIAS[s] ?? s);
  for (const s of skip) {
    if (!STAGES.includes(s)) {
      return { ok: false, os: ctx.os, side: ctx.side, usage: true, error: '--skip 里有未知阶段: ' + s, fix: '可选: ' + STAGES.join(', ') };
    }
  }
  const startIdx = from ? STAGES.indexOf(from) : 0;

  const steps = [];
  for (let i = 0; i < STAGES.length; i++) {
    const stage = STAGES[i];
    if (i < startIdx) {
      steps.push({ stage, state: 'skip', detail: '按 --from 跳过' });
      continue;
    }
    if (skip.includes(stage)) {
      steps.push({ stage, state: 'skip', detail: '按 --skip 跳过' });
      continue;
    }
    if (!ctx.apply) {
      steps.push({ stage, state: 'dry', detail: '(dry) 会执行 ' + stage + (stage === 'scheduler' ? '；公司侧要 sudo' : '') });
      continue;
    }

    const res = STAGE_RUNNERS[stage]({ ...ctx, apply: true });
    if (res.ok && res.skipped) {
      // perms 在非 root / 非 --system 时按 skip 记账：没做事就别显示 ok
      steps.push({ stage, state: 'skip', detail: '跳过：' + res.skipped });
      continue;
    }
    const detail = summarizeStage(stage, res);
    if (!res.ok) {
      const mark = markStage(ctx, stage, false, stage + ' 阶段失败: ' + (res.error ?? ''));
      steps.push({ stage, state: 'fail', detail, res, mark });
      return {
        ok: false, os: ctx.os, side: ctx.side, apply: true, steps,
        failedStage: stage,
        error: detail,
        fix: (res.fix ? res.fix + '；' : '') + '修好后用 --from ' + stage + ' 续跑，不要从头重装',
        needsRoot: res.needsRoot === true,
      };
    }
    const mark = markStage(ctx, stage, true, '');
    steps.push({ stage, state: 'ok', detail, res, mark });
  }

  return { ok: true, os: ctx.os, side: ctx.side, apply: ctx.apply, steps };
}

function summarizeStage(stage, res) {
  if (stage === 'dirs') {
    if (!res.ok) return '失败 ' + res.failed.length + ' 个目录（' + res.failed.map((f) => f.path).join(', ') + '）';
    return '新建 ' + res.created.length + ' / 已存在 ' + res.existing.length;
  }
  if (stage === 'files') {
    if (res.missing) return res.error;
    const p = res.parsed;
    const n = p ? (typeof p.copied === 'number' ? p.copied : typeof p.verified === 'number' ? p.verified : Array.isArray(p.files) ? p.files.length : '?') : '?';
    const extras = res.extras?.length
      ? '  + mac 运行件 补拷 ' + res.extras.filter((e) => e.state === 'copied').length + ' / 已有 ' + res.extras.filter((e) => e.state === 'unchanged').length + ' / 共 ' + res.extras.length
      : '';
    if (p) return (res.dryRun ? '(dry) ' : '') + '文件 ' + n + extras + (p.backup ? '  备份 ' + p.backup : '');
    return (res.dryRun ? '(dry) ' : '') + 'deploy.mjs exit=' + res.code + extras;
  }
  if (stage === 'scheduler') return res.ok ? ('plist 写 ' + (res.res.written?.length ?? 0) + ' / 不变 ' + (res.res.unchanged?.length ?? 0)) : (res.error ?? 'launchd 注册失败');
  if (stage === 'verify') {
    const bad = res.checks.filter((c) => c.state === 'fail').length;
    return '自检 ' + res.checks.length + ' 项，失败 ' + bad;
  }
  return '';
}

// ── Windows 分支：只转调，不重写 ──────────────────────────────────────────
export function windowsCommand(ctx, mode) {
  const repo = ctx.repo;
  const ps = (name) => join(repo, 'scripts', 'deploy', name);
  if (mode === 'install') {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps('install-company.ps1'), '-Side', 'company', '-VaultRoot', ctx.vault, '-Root', ctx.root, '-Repo', repo];
    if (ctx.apply) args.push('-Apply');
    return { line: ['powershell', ...args], script: ps('install-company.ps1') };
  }
  if (mode === 'verify') {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps('deploy-verify.ps1'), '-Side', ctx.side, '-Root', ctx.root, '-Json'];
    return { line: ['powershell', ...args], script: ps('deploy-verify.ps1') };
  }
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps('install-company.ps1'), '-Side', 'company', '-VaultRoot', ctx.vault, '-Root', ctx.root, '-Repo', repo];
  return { line: ['powershell', ...args], script: ps('install-company.ps1') };
}

function quoteArgs(argv) {
  return argv.map((a) => (/[\s"]/.test(a) ? '"' + a + '"' : a)).join(' ');
}

// ── 输出 ──────────────────────────────────────────────────────────────────
const ICON = { ok: '✓', warn: '!', fail: '✗', dry: '·', skip: '-', '..': '·' };

export function formatDoctor(res) {
  const L = [];
  L.push('=== anc doctor（' + res.side + ' / ' + res.os + '）===');
  L.push('部署根  ' + res.root);
  L.push('vault   ' + res.vault);
  L.push('');
  for (const c of res.checks) {
    L.push('  ' + (ICON[c.state] ?? '?') + ' ' + c.name.padEnd(12) + c.detail);
    if (c.fix && c.state !== 'ok') L.push('    → ' + c.fix);
  }
  L.push('');
  L.push(res.ok ? 'OK    没有阻塞项。' : 'BLOCKER 上面有 ✗，先修再装。');
  if (res.os === OS.MAC) L.push('NEXT  node scripts/deploy/anc.mjs plan --side ' + res.side);
  return L.join('\n');
}

export function formatPlan(res) {
  const L = [];
  L.push('=== anc plan（' + res.side + ' / ' + res.os + '）===');
  L.push('部署根  ' + res.root);
  L.push('vault   ' + res.vault);
  L.push('');
  for (const s of res.sections) {
    if (s.step === 'dirs') {
      const willCreate = s.items.filter((i) => !i.exists).length;
      L.push('[dirs] ' + s.items.length + ' 个目录，需新建 ' + willCreate + ' 个');
      for (const i of s.items) L.push('   ' + (i.exists ? '=' : '+') + ' ' + i.path);
    } else if (s.step === 'files') {
      if (s.missing) {
        L.push('[files] ERROR ' + s.error);
        if (s.fix) L.push('        FIX   ' + s.fix);
      } else if (s.parsed && Array.isArray(s.parsed.groups)) {
        L.push('[files] deploy.mjs 预演 exit=' + s.code + '：' + (s.parsed.total ?? '?') + ' 个文件 / ' + (s.parsed.totalBytes ?? '?') + ' 字节，' + s.parsed.groups.length + ' 组');
        for (const g of s.parsed.groups) L.push('   ' + String(g.target).padEnd(24) + String(g.count).padStart(3) + ' 个  ' + (g.bytes ?? '') + ' 字节');
      } else {
        L.push('[files] deploy.mjs 预演 exit=' + s.code + (s.error ? '  ' + s.error : ''));
        if (s.out) for (const line of s.out.split('\n').slice(0, 20)) L.push('   ' + line);
      }
    } else if (s.step === 'scheduler') {
      L.push('[scheduler]');
      for (const line of String(s.text ?? '').split('\n')) L.push('   ' + line);
    } else if (s.step === 'verify') {
      L.push('[verify] ' + s.note);
    }
  }
  L.push('');
  L.push('NEXT  预演不落盘。加 --apply 落盘' + (res.side === 'company' && res.os === OS.MAC ? '（公司侧要 sudo）' : '') + '。');
  return L.join('\n');
}

export function formatInstall(res) {
  const L = [];
  L.push('=== anc install（' + res.side + ' / ' + res.os + '）===');
  if (res.forwarded) {
    L.push('转调：' + res.forwarded);
    if (res.note) L.push(res.note);
    if (!res.apply) L.push('NEXT  加 --apply 才会真跑。');
    return L.join('\n');
  }
  if (res.error) {
    L.push('ERROR ' + res.error);
    if (res.fix) L.push('FIX   ' + res.fix);
    return L.join('\n');
  }
  L.push('模式    ' + (res.apply ? '落地（--apply）' : '预演（加 --apply 落盘）'));
  L.push('');
  for (const s of res.steps) {
    L.push('  ' + (ICON[s.state] ?? '?') + ' ' + s.stage.padEnd(10) + s.detail);
    if (s.mark && !s.mark.skipped && !s.mark.ok && s.mark.note) L.push('     记账: ' + s.mark.note);
    if (s.mark && s.mark.skipped && s.state === 'ok') L.push('     记账: ' + s.mark.why);
    if (s.res?.res?.failed?.length) {
      for (const f of s.res.res.failed) L.push('      FAIL ' + f.name + '  ' + (f.error ?? '') + (f.needsRoot ? '（要 sudo）' : ''));
    }
    if (s.res?.checks?.length) {
      const fails = s.res.checks.filter((c) => c.state === 'fail');
      for (const c of fails) L.push('      ✗ ' + c.name + '  ' + c.detail + (c.fix ? '  → ' + c.fix : ''));
    }
  }
  L.push('');
  if (!res.ok) {
    L.push('FAILED  ' + (res.failedStage ?? '') + '  ' + (res.error ?? ''));
    if (res.fix) L.push('FIX     ' + res.fix);
  } else if (!res.apply) {
    L.push('NEXT  预演完成，加 --apply 落盘' + (res.side === 'company' && res.os === OS.MAC ? '（公司侧要 sudo）' : '') + '。');
  } else {
    L.push('NEXT  装完了。跑 node scripts/deploy/anc.mjs verify --side ' + res.side + ' 复核，再在群里 @ 一次 bot。');
  }
  return L.join('\n');
}

export function formatVerify(res) {
  const L = [];
  L.push('=== anc verify（' + res.side + ' / ' + res.os + '）===');
  L.push('');
  for (const c of res.checks) {
    L.push('  ' + (ICON[c.state] ?? '?') + ' ' + c.name.padEnd(16) + c.detail);
    if (c.fix && c.state !== 'ok') L.push('    → ' + c.fix);
  }
  L.push('');
  L.push(res.ok ? 'OK    自检通过。' : 'FAIL  自检有硬失败项（目录/关键文件/plist 不全），先修。');
  return L.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const out = { _: [], skip: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--json') out.json = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--system') out.system = true;
    else if (a.startsWith('--')) {
      const k = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const v = argv[i + 1];
      if (v === undefined || (v.startsWith('--') && k !== 'skip' && k !== 'from')) throw usage(a + ' 需要一个值');
      if (k === 'skip') out.skip.push(v);
      else out[k] = v;
      i++;
    } else out._.push(a);
  }
  return out;
}

const HELP = `anc — 统一部署入口（macOS 主导，Windows 转调 ps1）

用法：
  node scripts/deploy/anc.mjs doctor  [--side company] [--root <dir>] [--json]
  node scripts/deploy/anc.mjs plan    [--side company] [--vault <dir>] [--json]
  node scripts/deploy/anc.mjs install [--side company] [--apply] [--from dirs|files|scheduler|verify] [--skip <阶段>] [--json]
  node scripts/deploy/anc.mjs verify  [--side company] [--json]

说明：
  - 默认 dry-run，--apply 才落盘
  - 阶段顺序 dirs → files → scheduler → verify；失败即停，--from <阶段> 续跑
  - 公司侧写 /Library/Application Support/anc 与 /Library/LaunchDaemons，需要一次 sudo：
      sudo -E node scripts/deploy/anc.mjs install --side company --apply --system
    --system 会把 GUI 相关任务（anc-workbuddy-launch / anc-devbot）落到登录用户的
    ~/Library/LaunchAgents，其余进 /Library/LaunchDaemons；不加 --system 时（演练/员工侧）
    两类任务都用同一个 plist 目录。
  - Windows 上本入口只转调 scripts\\deploy\\install-company.ps1（--apply 才 spawn）
  - 退出码：0 成功 / 1 失败 / 2 用法错误 / 3 已应用但复验失败
`;

export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP + '\n');
    return EXIT.OK;
  }
  const args = parseArgs(argv);
  const cmd = args._[0] ?? 'doctor';
  if (!['doctor', 'plan', 'install', 'verify'].includes(cmd)) {
    throw usage('未知命令: ' + cmd + '（doctor / plan / install / verify）');
  }

  const ctx = contextFrom({
    os: args.os, side: args.side, root: args.root, repo: args.repo, vault: args.vault,
    launchdDir: args.launchdDir, logDir: args.logDir,
    system: args.system === true,
    apply: args.apply === true && args.dryRun !== true, json: args.json === true,
    uid: args.uid !== undefined ? parseInt(args.uid, 10) : undefined,
  });
  if (Number.isNaN(ctx.uid)) throw usage('--uid 要是数字');

  // Windows：不重写逻辑，打印/转发 ps1。
  if (ctx.os === OS.WIN) {
    if (cmd === 'doctor') {
      const d = doctor({ ...ctx, json: ctx.json });
      const text = formatDoctor(d) + '\n\nNEXT  Windows 侧用 ps1 体检：\n  ' + quoteArgs(windowsCommand(ctx, 'verify').line);
      if (ctx.json) process.stdout.write(JSON.stringify(d, null, 2) + '\n');
      else process.stdout.write(text + '\n');
      return d.ok ? EXIT.OK : EXIT.FAIL;
    }
    const cmdRes = windowsCommand(ctx, cmd);
    if (!existsSync(cmdRes.script)) {
      process.stderr.write('ERROR 找不到 ' + cmdRes.script + '（仓库不完整；确认 --repo）\n');
      return EXIT.USAGE;
    }
    const line = quoteArgs(cmdRes.line);
    if (cmd === 'install' && ctx.apply && args.dryRun !== true) {
      const r = spawnSync(cmdRes.line[0], cmdRes.line.slice(1), { stdio: 'inherit', windowsHide: true });
      return r.status === 0 ? EXIT.OK : EXIT.FAIL;
    }
    process.stdout.write('=== anc ' + cmd + '（Windows）===\n');
    process.stdout.write('Windows 侧仍由 ps1 负责，这里只转调：\n  ' + line + '\n');
    if (!ctx.apply) process.stdout.write('NEXT  加 --apply 才会真跑。\n');
    return EXIT.OK;
  }

  if (cmd === 'doctor') {
    const d = doctor({ ...ctx, json: ctx.json });
    process.stdout.write(ctx.json ? JSON.stringify(d, null, 2) + '\n' : formatDoctor(d) + '\n');
    return d.ok ? EXIT.OK : EXIT.FAIL;
  }
  if (cmd === 'plan') {
    const p = plan(ctx);
    process.stdout.write(ctx.json ? JSON.stringify(p, null, 2) + '\n' : formatPlan(p) + '\n');
    return p.ok ? EXIT.OK : EXIT.FAIL;
  }
  if (cmd === 'verify') {
    const v = { ...ctx, ...collectVerify(ctx) };
    process.stdout.write(ctx.json ? JSON.stringify(v, null, 2) + '\n' : formatVerify({ ...ctx, ...v }) + '\n');
    return v.ok ? EXIT.OK : EXIT.FAIL;
  }

  const res = install({ ...ctx, from: args.from, skip: args.skip, json: ctx.json });
  process.stdout.write(ctx.json ? JSON.stringify(res, null, 2) + '\n' : formatInstall(res) + '\n');
  if (res.ok) return EXIT.OK;
  if (res.usage) return EXIT.USAGE;
  // 已落盘但复验没过：3（区别于"根本没装成"的 1）
  if (res.apply && res.failedStage === 'verify') return EXIT.VERIFY_FAIL;
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
    process.stderr.write('ERROR ' + (e && e.message ? e.message : String(e)) + '\n');
    process.exit(EXIT.FAIL);
  }
}
