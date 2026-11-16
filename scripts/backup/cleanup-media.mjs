#!/usr/bin/env node
// 清理企微附件落地目录：删掉各用户 TEMP 下超过 N 天的文件。
//
// 为什么移植：
//   计划任务 anc-cleanup 每天 03:00 以 SYSTEM/root 跑；这台机器换成 macOS 后 schtasks 那套没了，
//   launchd 需要可直接执行的 node 入口。逻辑本身与平台无关（遍历目录 + 按 mtime 删），
//   所以搬进零依赖 ESM，Windows 上由 cleanup-media.ps1 的行为原样保留。
//
// 与 ps1 的关系：
//   scripts/backup/cleanup-media.ps1 是本文件的行为源，逐条保留：
//     · 不给 --media-dir 时扫 C:\Users\*\AppData\Local\Temp\workbuddy-wecom-media，
//       再补 $env:TEMP 下的同名目录（SYSTEM 的 TEMP 是 C:\Windows\Temp，必须显式扫用户目录，否则等于空跑）
//     · **手写递归**，遇到符号链接/junction 一律跳过并告警：
//       PS 5.1 的 -Recurse 会钻进 reparse point，用户建一个指向系统目录的 junction
//       就能让 SYSTEM 去删那里的文件。Node 侧用 readdir(withFileTypes) + lstat 判断，同样不跟随。
//     · 日志：`yyyy-MM-dd HH:mm:ss <msg>`，写 <root>/data/cleanup.log 同时打屏
//     · 退出码：0 正常 / 2 环境或用法错误
//
// 与 ps1 的差异（仅平台适配）：
//   · 默认扫描目录在 Windows 上完全一致；macOS 用 os.tmpdir() 与 ~/Library/Caches（待实测，PLATFORMS §5）
//   · 日志根由 --root 推导（Windows 默认 %ProgramData%\anc → 与 ps1 的 C:\ProgramData\anc\data\cleanup.log 相同）
//
// 用法：
//   node scripts/backup/cleanup-media.mjs [--media-dir DIR] [--days 7] [--root DIR] [--json]
//
// 退出码：0 正常 / 2 用法错误

import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync, unlinkSync,
} from 'node:fs';
import { homedir as osHomedir, tmpdir as osTmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sideRoot } from '../platform/anc-platform.mjs';

class UsageError extends Error {}

const MB = 1024 * 1024;

/** ps1 的 `Get-Date -Format 'yyyy-MM-dd HH:mm:ss'`（本地时间）。 */
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 找要扫的目录。对应 ps1 的 $targets 构造逻辑。
 * @param {{mediaDir?: string, platform?: string, env?: Record<string,string|undefined>,
 *          homedir?: string, tmpdir?: string, usersRoot?: string}} [opts]
 */
export function collectTargets(opts = {}) {
  const mediaDir = opts.mediaDir;
  if (mediaDir) return [mediaDir];

  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.homedir ?? osHomedir();
  const tmp = opts.tmpdir ?? osTmpdir();
  const targets = [];

  const push = (dir) => {
    if (dir && existsSync(dir) && !targets.includes(dir)) targets.push(dir);
  };

  if (platform === 'win32') {
    const usersRoot = opts.usersRoot ?? 'C:\\Users';
    try {
      for (const ent of readdirSync(usersRoot, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        push(join(usersRoot, ent.name, 'AppData', 'Local', 'Temp', 'workbuddy-wecom-media'));
      }
    } catch { /* 没有 C:\Users 就跳过，等 TEMP 兜底 */ }
    if (env.TEMP) push(join(env.TEMP, 'workbuddy-wecom-media'));
  } else {
    // macOS：WorkBuddy/企微附件目录按缓存位置扫；真实路径待实测（PLATFORMS §5）。
    push(join(tmp, 'workbuddy-wecom-media'));
    push(join(home, 'Library', 'Caches', 'workbuddy-wecom-media'));
    if (env.TMPDIR) push(join(env.TMPDIR, 'workbuddy-wecom-media'));
  }
  return targets;
}

/**
 * 递归收集旧文件。手写栈，遇到符号链接/junction 跳过（不跟随），与 ps1 的 Get-OldFiles 等价。
 * @returns {{path: string, size: number}[]}
 */
export function findOldFiles(dir, cutoffMs, warn = () => {}) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = join(d, ent.name);
      // ent 来自 lstat 语义的 readdir：symlink 与 Windows junction 都标为 isSymbolicLink。
      if (ent.isSymbolicLink()) {
        warn('WARN skip reparse point: ' + full);
        continue;
      }
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        warn('WARN skip reparse point: ' + full);
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.mtimeMs < cutoffMs) {
        out.push({ path: full, size: st.size });
      }
    }
  }
  return out;
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 执行一次清理。
 * @param {{mediaDir?: string, days?: number, now?: Date, root?: string, logPath?: string,
 *          targets?: string[], logger?: (line: string) => void,
 *          platform?: string, env?: object, homedir?: string, tmpdir?: string, usersRoot?: string}} [opts]
 * @returns {{targets: string[], removed: number, bytes: number, skipped: string[]}}
 */
export function runCleanup(opts = {}) {
  const days = opts.days ?? 7;
  const now = opts.now ?? new Date();
  const root = opts.root ?? sideRoot('company');
  const logPath = opts.logPath ?? join(root, 'data', 'cleanup.log');

  const quiet = opts.quiet === true;
  const logger = opts.logger ?? ((line) => {
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, line + '\n', 'utf8');
    } catch { /* ps1 用 -ErrorAction SilentlyContinue：日志写不进去不影响清理 */ }
    if (!quiet) process.stdout.write(line + '\n');
  });
  const say = (msg) => logger(`${stamp(now)} ${msg}`);

  const targets = opts.targets ?? collectTargets(opts);
  const summary = { targets, removed: 0, bytes: 0, skipped: [] };

  if (!targets.length) {
    say('skip: no media dir found');
    return summary;
  }

  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  for (const dir of targets) {
    if (!existsSync(dir)) continue;
    let top;
    try {
      top = statSync(dir);
    } catch {
      top = null;
    }
    if (!top || isLink(dir)) {
      say('WARN skip (reparse point or unreadable): ' + dir);
      summary.skipped.push(dir);
      continue;
    }
    const old = findOldFiles(dir, cutoff, say);
    if (!old.length) {
      say(`clean: nothing older than ${days} day(s) in ${dir}`);
      continue;
    }
    let freed = 0;
    let count = 0;
    for (const f of old) {
      try {
        unlinkSync(f.path);
        count++;
        freed += f.size;
      } catch {
        say('WARN delete failed: ' + f.path);
      }
    }
    summary.removed += count;
    summary.bytes += freed;
    say(`clean: removed ${count} file(s), ${(freed / MB).toFixed(2)} MB from ${dir}`);
  }
  say(`done: ${summary.removed} file(s), ${(summary.bytes / MB).toFixed(2)} MB total`);
  return summary;
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

export function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write('用法: node cleanup-media.mjs [--media-dir DIR] [--days 7] [--root DIR] [--json]\n');
    return 0;
  }
  const days = args.days === undefined ? 7 : Number(args.days);
  if (!Number.isInteger(days) || days < 0) throw new UsageError('--days 必须是非负整数: ' + args.days);
  const summary = runCleanup({
    mediaDir: args['media-dir'] ? String(args['media-dir']) : undefined,
    days,
    root: args.root ? String(args.root) : undefined,
    quiet: args.json === true,
  });
  if (args.json) process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write('ERROR ' + e.message + '\n');
      process.exit(2);
    }
    throw e;
  }
}
