#!/usr/bin/env node
// WorkBuddy 补丁启动器（跨平台 Node 版）。
//
// 为什么有这个文件：
//   补丁链路原先只有 PowerShell 实现（launch-patched.ps1 + wait-patch-state.ps1），
//   macOS 上没有 PowerShell，于是「mac 上能不能打补丁」一直只是纸面结论。
//   本文件把启动、注入、等待确认三步搬成 Node，两端共用；Windows 侧仍可继续用 .ps1，
//   但两边判定规则必须是同一套（runId / 时间窗 / pid），所以逻辑以 .ps1 为行为源逐条照抄。
//
// 注入方式（与 .ps1 的实测结论一致）：
//   默认 --inspect-brk —— WorkBuddy 以 --inspect-brk=PORT 启动并暂停，inject.cjs 连上去
//   在主进程里设 process.env.NODE_OPTIONS=--require <preload>，然后放行；daemon 子进程
//   （child_process.fork）继承 NODE_OPTIONS 后加载 preload.cjs。
//   ANC_WB_METHOD=env（直接把 NODE_OPTIONS 交给 Electron）实测被丢弃，只留作对照。
//
// 判定为什么必须带 runId：
//   patch-state.json 只在补丁体包装成功时被覆盖写；注入失败时它根本不变，
//   会一直留着上一次成功的 applied=true。只看 applied + pid 会把 2 小时前的陈旧状态判成成功。
//
// 用法：
//   node launch-patched.mjs [--install-dir <WorkBuddy 安装目录或 .app>] [--port 9229]
//                           [--state-dir <目录>] [--no-patch] [--strict] [--wait-timeout-sec 150]
//                           [--dry-run] [--json]
//
// 退出码：0 成功 / 1 版本或注入失败（含「已降级无补丁启动」，降级不等于成功）
//         2 用法或环境错误 / 4 manifest.json 损坏或字段缺失

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { macExecutable, probeWorkbuddy, sideRoot } from '../platform/anc-platform.mjs';

const here = import.meta.dirname;

class UsageError extends Error {}

// ── 参数 ─────────────────────────────────────────────────
export function parseArgs(argv) {
  const out = { port: 9229, waitTimeoutSec: 150, strict: false, noPatch: false, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(a + ' 缺少值');
      return v;
    };
    if (a === '--install-dir') out.installDir = val();
    else if (a === '--port') out.port = Number(val());
    else if (a === '--state-dir') out.stateDir = val();
    else if (a === '--wait-timeout-sec') out.waitTimeoutSec = Number(val());
    else if (a === '--no-patch') out.noPatch = true;
    else if (a === '--strict') out.strict = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new UsageError('未知参数: ' + a);
  }
  if (!Number.isInteger(out.port) || out.port < 1024 || out.port > 65535) throw new UsageError('--port 必须是 1024..65535');
  if (!Number.isInteger(out.waitTimeoutSec) || out.waitTimeoutSec < 5) throw new UsageError('--wait-timeout-sec 必须 >= 5');
  return out;
}

// ── 定位 WorkBuddy ───────────────────────────────────────
/**
 * 两个平台的安装形态不同：Windows 是目录 + WorkBuddy.exe，macOS 是 .app 包 + Contents/MacOS/WorkBuddy。
 * installDir 显式给了就按它推；没给就走平台层探测（与 doctor / 补丁守卫同一套候选）。
 */
export function resolveTarget(opts = {}) {
  const os = opts.os ?? process.platform;
  const explicit = opts.installDir;
  if (explicit) {
    if (os === 'darwin') {
      const bundle = explicit;
      // 包内主程序名不一定等于产品名（实测 5.9.3 是 Electron），所以按 Info.plist + 候选名解析。
      return {
        os,
        installDir: bundle,
        exec: macExecutable(bundle) ?? join(bundle, 'Contents', 'MacOS', 'WorkBuddy'),
        appAsar: join(bundle, 'Contents', 'Resources', 'app.asar'),
        infoPlist: join(bundle, 'Contents', 'Info.plist'),
      };
    }
    return {
      os,
      installDir: explicit,
      exec: join(explicit, 'WorkBuddy.exe'),
      appAsar: join(explicit, 'resources', 'app.asar'),
      infoPlist: null,
    };
  }
  const probe = probeWorkbuddy({ os });
  if (!probe.found) throw new UsageError('没找到 WorkBuddy：macOS 默认看 /Applications/WorkBuddy.app，Windows 看 %LOCALAPPDATA%\\Programs\\WorkBuddy；也可以用 --install-dir 指定');
  return {
    os,
    installDir: probe.installDir,
    exec: probe.exec,
    appAsar: probe.appAsar,
    infoPlist: os === 'darwin' ? join(probe.bundle, 'Contents', 'Info.plist') : null,
  };
}

/** 读 WorkBuddy 版本：Windows 用文件版本，macOS 用 Info.plist 的 CFBundleShortVersionString。 */
export function readVersion(target) {
  if (target.os === 'darwin') {
    const r = spawnSync('/usr/bin/defaults', ['read', target.infoPlist, 'CFBundleShortVersionString'], { encoding: 'utf8' });
    if (r.status === 0) return String(r.stdout).trim();
    // defaults 读不到（权限/损坏）时退解析二进制 plist 里的 XML 片段
    try {
      const raw = readFileSync(target.infoPlist, 'latin1');
      const m = raw.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
      if (m) return m[1];
    } catch { /* ignore */ }
    return '';
  }
  // Windows：不做 WMI/版本资源解析，交给调用方用 --strict 之外的方式对账；
  // 这里只回空串，启动逻辑按「版本未登记、走锚点模式」处理（与 .ps1 的告警分支一致）。
  return '';
}

// ── manifest 与锚点 ──────────────────────────────────────
export function loadManifest(dir = here) {
  const p = join(dir, 'manifest.json');
  if (!existsSync(p)) throw new UsageError('manifest.json 不存在: ' + p);
  let mf;
  try {
    mf = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    const err = new Error('manifest.json 无法解析：' + e.message);
    err.code = 4;
    throw err;
  }
  if (!mf.workbuddyVersion || !mf.sha256) {
    const err = new Error('manifest.json 缺少 workbuddyVersion / sha256');
    err.code = 4;
    throw err;
  }
  return mf;
}

/**
 * 读 asar 里的目标文件（不加载应用，纯字节操作）。inspect.mjs 与本文件共用同一段解析。
 * 返回 { files: Map, read(path): Buffer|null }。
 */
export function openAsar(asarPath) {
  const buf = readFileSync(asarPath);
  const headerSize = buf.readUInt32LE(4);
  const jsonLen = buf.readUInt32LE(12);
  const base = 8 + headerSize;
  const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'));
  const files = new Map();
  (function walk(node, prefix) {
    for (const [name, v] of Object.entries(node.files || {})) {
      const p = prefix ? prefix + '/' + name : name;
      if (v.files) walk(v, p);
      else files.set(p, v);
    }
  })(header, '');
  const read = (p) => {
    const m = files.get(p);
    if (!m) return null;
    return buf.subarray(base + Number(m.offset), base + Number(m.offset) + m.size);
  };
  return { files, read, size: buf.length };
}

/** 补丁锚点是否还在（结构锚点：上游改名字就 miss，需要重新侦察）。 */
export function inspectAnchors(asarPath, manifest) {
  const asar = openAsar(asarPath);
  const body = asar.read(manifest.target);
  if (!body) return { target: manifest.target, found: false, sha256: null, size: 0, anchors: {} };
  const text = body.toString('utf8');
  return {
    target: manifest.target,
    found: true,
    sha256: createHash('sha256').update(body).digest('hex'),
    size: body.length,
    anchors: {
      emitMessage: text.includes('emitMessage'),
      classWecom: text.includes('WecomAiBotClient'),
      bootstrapStart: text.includes('runStartupForceAutoUpdate'),
      bootstrapEarly: text.includes('runEarlyForceUpgradeCheck'),
    },
  };
}

// ── 状态文件 ─────────────────────────────────────────────
export function statePaths(opts = {}) {
  const os = opts.os ?? process.platform;
  const root = opts.root ?? sideRoot(opts.side ?? 'company', { os });
  const dir = opts.stateDir ?? join(root, 'data');
  const logFile = opts.patchLog ?? (os === 'win32'
    ? join(process.env.USERPROFILE || homedir(), 'anc', 'workbuddy-patch.log')
    : join(homedir(), 'anc', 'workbuddy-patch.log'));
  return {
    dir,
    state: join(dir, 'patch-state.json'),
    run: join(dir, 'patch-run.json'),
    logFile,
  };
}

function logLine(file, msg) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, new Date().toISOString() + ' [launch] ' + msg + '\n');
  } catch { /* 日志不能挡流程 */ }
}

export function writeRun(paths, runId, startedAt) {
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.run, JSON.stringify({ runId, startedAt, launcherPid: process.pid }, null, 2) + '\n', 'utf8');
}

/**
 * 判定「本次启动」是否真的把补丁装上了（照抄 wait-patch-state.ps1 的四条判据）：
 *   applied=true；runId 一致（旧 preload 不写 runId 时退化为时间窗）；at 不早于本次启动 15 秒；pid 还活着。
 */
export function evaluateState(state, ctx) {
  if (!state || typeof state !== 'object') return { ok: false, reason: 'patch-state.json 一直没出现（preload 没被加载）' };
  if (!state.applied) {
    const extra = (state.miss ? '（ANCHOR-MISS：没找到 emitMessage）' : '') + (state.error ? '：' + state.error : '');
    return { ok: false, reason: 'patch-state applied=false' + extra };
  }
  if (state.runId && String(state.runId) !== ctx.runId) {
    return { ok: false, reason: 'patch-state 属于上一次启动（runId=' + state.runId + '，本次=' + ctx.runId + '）' };
  }
  const atMs = Date.parse(state.at || '');
  if (Number.isFinite(atMs) && atMs < ctx.startedAtMs - 15000) {
    return { ok: false, reason: 'patch-state 是陈旧记录（at=' + state.at + '）' };
  }
  if (state.pid && !alive(Number(state.pid))) {
    return { ok: false, reason: 'patch-state 里的 pid=' + state.pid + ' 已退出' };
  }
  return { ok: true, reason: 'applied=true, mode=' + (state.mode ?? '?') + ', pid=' + (state.pid ?? 0) };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function waitForState(paths, runId, startedAtMs, timeoutSec, { pollMs = 2000, readFile = readFileSync } = {}) {
  const deadline = Date.now() + timeoutSec * 1000;
  let last = { ok: false, reason: 'patch-state.json 一直没出现（preload 没被加载）' };
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    if (!existsSync(paths.state)) continue;
    let state = null;
    try { state = JSON.parse(readFile(paths.state, 'utf8').replace(/^\uFEFF/, '')); }
    catch (e) { last = { ok: false, reason: 'patch-state.json 无法解析：' + e.message }; continue; }
    last = evaluateState(state, { runId, startedAtMs });
    if (last.ok) return last;
  }
  return last;
}

function writeFailedState(paths, runId, reason) {
  try {
    writeFileSync(paths.state, JSON.stringify({
      applied: false, mode: 'launch-timeout', pid: 0, at: new Date().toISOString(), runId, error: reason,
    }, null, 2) + '\n', 'utf8');
  } catch { /* ignore */ }
}

// ── 启动 ─────────────────────────────────────────────────
export function buildLaunchArgs(port) {
  // Electron 的 --inspect-brk 会让主进程在第一行暂停，等调试器连上来再放行。
  return ['--inspect-brk=' + port];
}

/**
 * 启动应用时要清掉的环境变量。
 *
 * 2026-11-16 真机实测（本机 macOS）：agent 宿主（Electron 应用）会给子进程设 ELECTRON_RUN_AS_NODE=1，
 * 于是 WorkBuddy 被当成**纯 Node** 拉起来 —— 主进程解析完参数就退出，无窗口、无日志、无崩溃报告。
 * 表现极像"补丁把应用弄崩了"，实际跟补丁无关。同样的变量还有 ELECTRON_NO_ATTACH_CONSOLE。
 * NODE_OPTIONS 也一律清掉：补丁只能由 inject.cjs 在运行时设，不能靠外部环境偷偷带进来
 * （否则 patch-state 会指向错误来源，排障时无法区分"补丁生效"和"环境残留"）。
 */
export const APP_ENV_DENY = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'NODE_OPTIONS'];

export function sanitizedEnv(base = process.env, extra = {}) {
  const env = { ...base, ...extra };
  for (const k of APP_ENV_DENY) delete env[k];
  return env;
}

export function spawnApp(target, args, { env } = {}) {
  const cleanEnv = env ?? sanitizedEnv();
  // 直接 exec 主程序（不用 `open`）：本机实测 open --args 传不进 --inspect-brk，
  // 而直接 exec 在清掉 ELECTRON_RUN_AS_NODE 之后是好的（9229 能正常监听并暂停）。
  // 注意：这里必须显式 cwd 到安装目录，否则部分构建会按 cwd 解析相对资源。
  const child = spawn(target.exec, args, { cwd: target.installDir, detached: true, stdio: 'ignore', env: cleanEnv });
  child.unref();
  return child;
}

export async function probeInspector(port, timeoutMs = 40000, fetchImpl = globalThis.fetch) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetchImpl('http://127.0.0.1:' + port + '/json/list');
      const list = await r.json();
      if (Array.isArray(list) && list.length) return list;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/** 同步小睡：不用子进程（Windows 上没有 sleep）。 */
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function killApp(target) {
  // 按**实际主程序路径**匹配：包内可执行文件可能叫 Electron，按 'WorkBuddy' 匹配会一个都杀不掉，
  // 于是新实例因单例锁起不来、inject 永远连不上 inspector。
  // 按 bundle 路径匹配：主进程与 helper 的 argv 都含 /Applications/WorkBuddy.app，
  // 但主进程名可能是 Electron（实测），按名字杀会漏。
  if (target.os === 'darwin') spawnSync('/usr/bin/pkill', ['-f', target.installDir]);
  else spawnSync('taskkill', ['/IM', 'WorkBuddy.exe', '/F']);
  sleepSync(2000);
}

// ── 主流程 ───────────────────────────────────────────────
export async function main(argv, deps = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(
      '用法: node launch-patched.mjs [--install-dir <WorkBuddy 安装目录/.app>] [--port 9229]\n' +
      '                              [--state-dir <目录>] [--no-patch] [--strict] [--wait-timeout-sec 150] [--dry-run] [--json]\n');
    return 0;
  }

  const target = resolveTarget(opts);
  if (!existsSync(target.exec)) throw new UsageError('找不到主程序: ' + target.exec);
  if (!existsSync(target.appAsar)) throw new UsageError('找不到 app.asar: ' + target.appAsar);

  const mf = loadManifest();
  const paths = statePaths({ os: target.os, stateDir: opts.stateDir });
  const version = readVersion(target);

  const report = { ok: false, os: target.os, installDir: target.installDir, version, manifestVersion: mf.workbuddyVersion, state: paths.state, log: paths.logFile };

  if (version && version !== mf.workbuddyVersion && opts.strict) {
    report.error = `WorkBuddy 版本不符：期望 ${mf.workbuddyVersion}，实际 ${version}`;
    if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else { process.stdout.write('ERROR ' + report.error + '\n'); process.stdout.write('FIX   升级后先重测，再更新 manifest.json；本次拒绝启动\n'); }
    return 1;
  }

  const anchors = inspectAnchors(target.appAsar, mf);
  report.anchors = anchors;

  if (opts.noPatch || process.env.ANC_WB_PATCH === '0') {
    if (opts.dryRun) { report.mode = 'no-patch'; report.ok = true; print(); return 0; }
    spawnApp(target, []);
    report.mode = 'no-patch';
    report.ok = true;
    print();
    return 0;
  }

  const preload = join(here, 'preload.cjs');
  const inject = join(here, 'inject.cjs');
  if (!existsSync(preload)) throw new UsageError('preload.cjs 不存在: ' + preload);
  if (!existsSync(inject)) throw new UsageError('inject.cjs 不存在: ' + inject);
  // 路径可以有空格，但注入时会给 NODE_OPTIONS 加引号（Node 22 支持 shell 风格引号）。
  // 系统级部署根 /Library/Application Support/anc 就带空格 —— 早期"见空格即拒绝"会让 mac 永远打不上补丁。
  if (/[\r\n"]/.test(preload)) throw new UsageError('preload 路径含引号或换行，NODE_OPTIONS 无法安全表达：' + preload);

  if (opts.dryRun) {
    report.mode = 'inspect-brk';
    report.ok = true;
    report.command = [target.exec, ...buildLaunchArgs(opts.port)];
    print();
    return 0;
  }

  // 对照路径：直接把 NODE_OPTIONS 交给 Electron。实测会被丢弃（stderr: Most NODE_OPTIONs are not
  // supported in packaged apps），只留作对照，不要当默认。
  if (process.env.ANC_WB_METHOD === 'env') {
    if (opts.dryRun) { report.mode = 'env'; report.ok = true; print(); return 0; }
    killApp(target);
    const env = sanitizedEnv();
    env.NODE_OPTIONS = '--require ' + preload;
    spawnApp(target, [], { env });
    report.mode = 'env';
    report.ok = true;
    report.detail = '对照路径（Electron 通常会丢弃 NODE_OPTIONS）';
    print();
    return 0;
  }

  const runId = randomBytes(8).toString('hex');
  const startedAtMs = Date.now();
  writeRun(paths, runId, new Date(startedAtMs).toISOString());
  logLine(paths.logFile, `run ${runId} start installDir=${target.installDir} port=${opts.port}`);

  killApp(target);
  spawnApp(target, buildLaunchArgs(opts.port));

  const list = await probeInspector(opts.port);
  if (!list) {
    logLine(paths.logFile, 'inspector 40 秒内没就绪，降级无补丁启动');
    killApp(target);
    spawnApp(target, []);
    report.mode = 'inspector-timeout';
    report.error = 'inspector ' + opts.port + ' 在 40 秒内没就绪';
    writeFailedState(paths, runId, report.error);
    print();
    return 1;
  }

  const inj = spawnSync(process.execPath, [inject, '--port', String(opts.port), '--preload', preload], {
    encoding: 'utf8',
    env: { ...process.env, ANC_PATCH_LOG: paths.logFile },
  });
  if (inj.status !== 0) {
    logLine(paths.logFile, 'inject 失败 exit=' + inj.status + ' ' + String(inj.stderr || '').split('\n')[0]);
    killApp(target);
    spawnApp(target, []);
    report.mode = 'inject-failed';
    report.error = 'inject.cjs exit=' + inj.status;
    writeFailedState(paths, runId, report.error);
    print();
    return 1;
  }

  const verdict = await waitForState(paths, runId, startedAtMs, opts.waitTimeoutSec);
  report.ok = verdict.ok;
  report.mode = 'inspect-brk';
  report.runId = runId;
  report.detail = verdict.reason;
  if (!verdict.ok) writeFailedState(paths, runId, verdict.reason);
  print();
  return verdict.ok ? 0 : 1;

  function print() {
    if (opts.json) { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); return; }
    const w = (k, v) => process.stdout.write(k.padEnd(14) + v + '\n');
    w('平台', report.os);
    w('WorkBuddy', report.installDir + (report.version ? '  版本 ' + report.version : '  版本未读到'));
    w('manifest', report.manifestVersion + (report.anchors.found ? '  目标命中 ' + report.anchors.sha256.slice(0, 12) + '…' : '  目标缺失'));
    if (report.mode) w('模式', report.mode);
    if (report.ok) w('结果', 'OK  ' + (report.detail ?? ''));
    else w('结果', 'FAIL  ' + (report.error ?? report.detail ?? ''));
    if (!report.ok) process.stdout.write('FIX    看 ' + paths.logFile + ' 与 ' + paths.state + '；补丁没装上时 WorkBuddy 仍会起来（群身份不可用）\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (e) {
    if (e instanceof UsageError) { process.stderr.write('ERROR ' + e.message + '\n'); process.exit(2); }
    if (e && e.code === 4) { process.stderr.write('ERROR ' + e.message + '\n'); process.exit(4); }
    process.stderr.write('ERROR ' + (e?.message ?? String(e)) + '\n');
    process.exit(2);
  }
}
