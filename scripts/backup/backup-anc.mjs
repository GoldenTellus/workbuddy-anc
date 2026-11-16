#!/usr/bin/env node
// 备份计划任务（跨平台 Node 版，对应 Windows 的 scripts/backup/backup-anc.ps1）。
//
// 为什么单独一个文件而不是直接把 CLI `backup` 挂到计划任务里：
//   CLI 的 `backup --to` 收的是**文件路径**（SQLite VACUUM INTO 的目标），而且目标已存在会直接报错。
//   计划任务需要「每次一个新文件 + 保留策略」，文件名里的时间戳必须由执行者算 —— shell/launchd
//   算不了，所以由本脚本算好再把文件路径交给 CLI。
//   Windows 的 backup-anc.ps1 早就是这个语义（-Destination 目录 + 保留 N 份），这里对齐。
//
// 用法：
//   node backup-anc.mjs --root <部署根> [--destination <目录>] [--keep 7] [--db <库>] [--json]
//
// 默认 destination = <root>/backup；文件名 anc-<YYYYMMDD-HHmmss>.db；只清理本前缀的旧文件。
// 退出码：0 成功（含 skip）/ 1 备份失败 / 2 用法错误

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sideRoot } from '../platform/anc-platform.mjs';

class UsageError extends Error {}

function parseArgs(argv) {
  const out = { keep: 7 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(a + ' 缺少值');
      return v;
    };
    if (a === '--root') out.root = val();
    else if (a === '--destination') out.destination = val();
    else if (a === '--db') out.db = val();
    else if (a === '--keep') out.keep = Number(val());
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new UsageError('未知参数: ' + a);
  }
  if (!Number.isInteger(out.keep) || out.keep < 1) throw new UsageError('--keep 必须是 >= 1 的整数');
  return out;
}

/** 文件名时间戳：本地时间，按小时/分钟/秒排得动（不依赖 locale）。 */
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 保留策略：只认本脚本产出的 anc-*.db，按 mtime 留最新 keep 份。返回删掉的文件名。 */
export function prune(dir, keep) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => /^anc-\d{8}-\d{6}\.db$/.test(f))
    .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  const removed = [];
  for (const { f } of files.slice(keep)) {
    try {
      rmSync(join(dir, f), { force: true });
      removed.push(f);
    } catch { /* 删不掉不算备份失败 */ }
  }
  return removed;
}

function log(root, msg) {
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    appendFileSync(join(root, 'data', 'backup.log'), new Date().toISOString() + ' [backup] ' + msg + '\n');
  } catch { /* 日志不能挡备份 */ }
}

export function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write('用法: node backup-anc.mjs --root <部署根> [--destination <目录>] [--keep 7] [--db <库>] [--json]\n');
    return 0;
  }
  const root = opts.root ?? sideRoot('company');
  const db = opts.db ?? join(root, 'data', 'anc.db');
  const dest = opts.destination ?? join(root, 'backup');

  if (!existsSync(db)) {
    log(root, 'skip: 没有数据库 ' + db);
    report({ ok: true, skipped: 'no-db', db });
    return 0;
  }
  mkdirSync(dest, { recursive: true });
  const target = join(dest, 'anc-' + stamp() + '.db');
  const cli = join(root, 'service', 'cli.ts');
  const r = spawnSync(process.execPath, ['--no-warnings', cli, 'backup', '--to', target, '--db', db], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--experimental-strip-types'].filter(Boolean).join(' ') },
  });
  if (r.status !== 0) {
    const err = String(r.stderr || r.stdout || '').trim().split('\n').slice(0, 2).join(' | ');
    log(root, 'FAIL ' + err);
    report({ ok: false, error: err, db, target });
    return 1;
  }
  const removed = prune(dest, opts.keep);
  log(root, `ok ${target}（保留 ${opts.keep} 份${removed.length ? '，清理 ' + removed.join(',') : ''}）`);
  report({ ok: true, target, removed, db });
  return 0;

  function report(obj) {
    if (opts.json) process.stdout.write(JSON.stringify(obj) + '\n');
    else if (!obj.ok) process.stderr.write('ERROR 备份失败：' + obj.error + '\n');
    else if (obj.skipped) process.stdout.write('skip: ' + obj.skipped + '\n');
    else process.stdout.write('OK ' + obj.target + '\n');
  }
}

if (process.argv[1] && process.argv[1].endsWith('backup-anc.mjs')) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write('ERROR ' + e.message + '\n');
      process.exit(2);
    }
    process.stderr.write('ERROR ' + (e?.message ?? String(e)) + '\n');
    process.exit(1);
  }
}
