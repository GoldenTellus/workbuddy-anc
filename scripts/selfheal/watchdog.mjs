#!/usr/bin/env node
// watchdog：独立计划任务，盯心跳、outbox 积压、WorkBuddy 进程；异常发运维群，带冷却。
//
// 为什么移植：
//   原 watchdog.ps1 靠 Get-Process / Get-ScheduledTask / Invoke-RestMethod 三件 Windows 能力，
//   在 macOS（launchd）上一条都用不了。判定逻辑本身与平台无关，所以抽成纯函数 +
//   一层平台探测（tasklist/ps/pgrep、launchd plist、fetch），Windows 上仍由 ps1 的行为定义。
//
// 与 ps1 的关系（行为源：scripts/selfheal/watchdog.ps1，逐条保留）：
//   1 心跳：loop.log 不存在 → "没有 loop.log：服务从未跑过"；mtime 超过 N 分钟 → "本地小服务心跳停了 N 分钟（anc-service？）"
//   2 outbox 积压：跑 CLI `outbox list --status pending --limit 100`，**数输出里的 "dedupe_key"**
//     （ps1 就是数这个字符串，不是数数组长度）；失败 → "查 outbox 失败"
//   3 WorkBuddy 进程：没在跑时看 patch-guard.state.json 的 lastStartAt，5 分钟内算"正在重启"宽限
//   4 补丁 canary：patch-canary.json 24 小时内有记录但没有 chatId → 上游字段可能改名
//   5 HTTP 面：注册了 anc-http 才要求；连不上 → "HTTP 面没在监听（anc-http？）"，ok=false → 报 detail
//   冷却：同一组问题在 CooldownMinutes 内不重复发
//   退出码：0 正常或已告警 / 2 环境错误（缺 webhook、发送失败）
//
// 与 ps1 的差异（仅平台适配）：
//   · 进程探测：Windows 用 tasklist，macOS 用 pgrep -x（缺 pgrep 再退 ps）
//   · "注册了 anc-http"：Windows 查 schtasks，macOS 查 LaunchDaemon/LaunchAgent plist
//   · 默认路径由 --root 推导（Windows 默认 %ProgramData%\anc，与 ps1 字面量一致）
//
// 用法：
//   node scripts/selfheal/watchdog.mjs [--root DIR] [--webhook-file F] [--log-file F] [--state-file F]
//                                      [--heartbeat-max-minutes 10] [--pending-max 50] [--cooldown-minutes 30]
//                                      [--http-required|--no-http] [--json]
//
// 判定函数可注入 clock/probe（tests: scripts/platform/ports.test.mjs）：不碰真实进程与网络。

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sideRoot } from '../platform/anc-platform.mjs';

class UsageError extends Error {}

const HEALTH_URL = 'http://127.0.0.1:17891/__anc_health';

/** PS `(Get-Date).ToString('o')` 形态（watchdog.state.json 的 at 字段与 ps1 一致）。 */
export function psDate(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `.${p(d.getMilliseconds(), 3)}0000${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

export function watchdogPaths(root) {
  return {
    root,
    webhook: join(root, 'secrets', 'ops-webhook.txt'),
    log: join(root, 'data', 'loop.log'),
    state: join(root, 'data', 'watchdog.state.json'),
    patchGuard: join(root, 'data', 'patch-guard.state.json'),
    canary: join(root, 'data', 'patch-canary.json'),
    db: join(root, 'data', 'anc.db'),
    cli: join(root, 'service', 'cli.ts'),
  };
}

function readText(file) {
  return readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

function mtimeMs(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

// ── 平台探测（可被测试替换）────────────────────────────────
export function taskExists(name = 'anc-http') {
  if (process.platform === 'win32') {
    const r = spawnSync('schtasks', ['/Query', '/TN', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return r.status === 0;
  }
  const label = 'local.anc.' + name;
  return (
    existsSync('/Library/LaunchDaemons/' + label + '.plist') ||
    existsSync(join(homedir(), 'Library', 'LaunchAgents', label + '.plist'))
  );
}

function psComm() {
  const r = spawnSync('ps', ['-axo', 'comm='], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  return String(r.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
}

export function processRunning(name = 'WorkBuddy') {
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}.exe`, '/NH'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return new RegExp(name + '\\.exe', 'i').test(String(r.stdout ?? ''));
    // 精简镜像可能没有 tasklist：退到 ps
    return psComm().some((c) => c.includes(name));
  }
  const pg = spawnSync('pgrep', ['-x', name], { encoding: 'utf8' });
  if (!pg.error) return pg.status === 0;
  return psComm().some((c) => c.includes(name));
}

function outboxPending(root) {
  const p = watchdogPaths(root);
  const r = spawnSync(
    process.execPath,
    ['--no-warnings', p.cli, '--db', p.db, '--json', 'outbox', 'list', '--status', 'pending', '--limit', '100'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const out = String(r.stdout ?? '') + String(r.stderr ?? '');
  if (r.status !== 0) throw new Error('outbox list exit ' + r.status);
  // 与 ps1 一致：数输出里出现多少次 "dedupe_key"，而不是解析数组
  return (out.match(/"dedupe_key"/g) || []).length;
}

async function httpHealth() {
  const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.json();
}

/**
 * 五项判定（纯函数：clock / probe 都可注入，测试不碰真实机器）。
 * @param {{now?: Date, paths?: object, limits?: object, probe?: object}} [opts]
 * @returns {Promise<{problems: string[], pending: number}>}
 */
export async function evaluateChecks(opts = {}) {
  const now = opts.now ?? new Date();
  const root = opts.root ?? sideRoot('company');
  const p = { ...watchdogPaths(root), ...(opts.paths ?? {}) };
  const limits = { heartbeatMaxMinutes: 10, pendingMax: 50, ...(opts.limits ?? {}) };
  const probe = {
    exists: (f) => existsSync(f),
    mtimeMs,
    readText,
    outboxPending: () => outboxPending(root),
    processRunning: () => processRunning('WorkBuddy'),
    httpHealth,
    httpRequired: () => taskExists('anc-http'),
    ...(opts.probe ?? {}),
  };

  const problems = [];
  const nowMs = now.getTime();

  // 1 心跳
  if (probe.exists(p.log)) {
    const mt = probe.mtimeMs(p.log);
    const age = mt === null ? 0 : Math.floor((nowMs - mt) / 60000);
    if (age > limits.heartbeatMaxMinutes) problems.push(`本地小服务心跳停了 ${age} 分钟（anc-service？）`);
  } else {
    problems.push('没有 loop.log：服务从未跑过');
  }

  // 2 outbox 积压
  let pending = 0;
  try {
    pending = probe.outboxPending();
    if (pending >= limits.pendingMax) problems.push(`outbox 积压 ${pending} 条`);
  } catch {
    problems.push('查 outbox 失败');
  }

  // 3 WorkBuddy（自愈正在重启时给 5 分钟宽限，避免误报）
  if (!probe.processRunning()) {
    let starting = false;
    const gs = p.patchGuard;
    if (probe.exists(gs)) {
      try {
        const last = new Date(JSON.parse(probe.readText(gs)).lastStartAt);
        if (!Number.isNaN(last.getTime()) && (nowMs - last.getTime()) / 60000 < 5) starting = true;
      } catch { /* ps1 也是空 catch */ }
    }
    if (!starting) problems.push('WorkBuddy 没在跑（公司 bot 离线）');
  }

  // 4 补丁 canary：补丁生效但取不到 chatId（上游字段改名）
  if (probe.exists(p.canary)) {
    try {
      const c = JSON.parse(probe.readText(p.canary));
      const hours = (nowMs - new Date(c.at).getTime()) / 3600000;
      if (hours < 24 && !c.chatId) problems.push('补丁生效但取不到 chatId（上游字段可能改名，需人工重放）');
    } catch { /* 同上：坏文件不阻断其它检查 */ }
  }

  // 5 HTTP 面（注册了 anc-http 才要求）
  if (probe.httpRequired()) {
    try {
      const h = await probe.httpHealth();
      if (!h || !h.ok) problems.push('HTTP 面在但心跳不健康：' + (h && h.detail !== undefined ? h.detail : ''));
    } catch {
      problems.push('HTTP 面没在监听（anc-http？）');
    }
  }

  return { problems, pending };
}

/** 冷却判定：同一组问题在 N 分钟内不重复告警（ps1 的 $state.key -eq $key -and $state.at）。 */
export function shouldSuppress(state, key, now, cooldownMinutes) {
  if (!state || state.key !== key || !state.at) return false;
  const at = new Date(state.at).getTime();
  if (Number.isNaN(at)) return false;
  return (now.getTime() - at) / 60000 < cooldownMinutes;
}

function readStateFile(file) {
  try {
    return JSON.parse(readText(file));
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('-')) { out._.push(raw); continue; }
    const key = raw.replace(/^-+/, '');
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('-')) { out[key] = next; i++; }
    else { out[key] = true; }
  }
  return out;
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      '用法: node watchdog.mjs [--root DIR] [--webhook-file F] [--log-file F] [--state-file F]\n' +
        '                          [--heartbeat-max-minutes 10] [--pending-max 50] [--cooldown-minutes 30]\n' +
        '                          [--http-required|--no-http] [--json]\n',
    );
    return 0;
  }

  const root = args.root ? String(args.root) : sideRoot('company');
  const p = watchdogPaths(root);
  const webhookFile = args['webhook-file'] ? String(args['webhook-file']) : p.webhook;
  const logFile = args['log-file'] ? String(args['log-file']) : p.log;
  const stateFile = args['state-file'] ? String(args['state-file']) : p.state;

  const num = (v, dflt) => {
    if (v === undefined) return dflt;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new UsageError('数值参数不合法: ' + v);
    return n;
  };
  const limits = {
    heartbeatMaxMinutes: num(args['heartbeat-max-minutes'], 10),
    pendingMax: num(args['pending-max'], 50),
  };
  const cooldownMinutes = num(args['cooldown-minutes'], 30);

  const probe = {};
  if (args['http-required']) probe.httpRequired = () => true;
  if (args['no-http']) probe.httpRequired = () => false;

  const { problems } = await evaluateChecks({
    root,
    paths: { log: logFile, state: stateFile },
    limits,
    probe,
  });

  if (!problems.length) {
    if (args.json) process.stdout.write(JSON.stringify({ ok: true, problems: [] }, null, 2) + '\n');
    return 0;
  }

  // 冷却：同一组问题在 CooldownMinutes 内不重复发
  const now = new Date();
  const key = problems.join('|');
  if (shouldSuppress(readStateFile(stateFile), key, now, cooldownMinutes)) {
    if (args.json) process.stdout.write(JSON.stringify({ ok: true, problems, suppressed: true }, null, 2) + '\n');
    return 0;
  }

  if (!existsSync(webhookFile)) return 2;
  const url = readText(webhookFile).trim();
  if (!url) return 2;

  const body = JSON.stringify({
    msgtype: 'text',
    text: { content: '[anc] watchdog: ' + problems.join('；') },
  });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const state = { key, at: psDate(now) };
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch {
    return 2;
  }
  if (args.json) process.stdout.write(JSON.stringify({ ok: true, problems, posted: true }, null, 2) + '\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write('ERROR ' + e.message + '\n');
      process.exit(2);
    }
    throw e;
  }
}
