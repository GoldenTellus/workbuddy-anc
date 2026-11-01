#!/usr/bin/env node
// 入库 CLI：把一个批次目录写进共享区，归档/转移批次，可选提交
// 用法：node src/ingest/cli.ts apply --batch <批次目录> --shared <共享区目录> [--inbox D:\anc\inbox] [--commit] [--json]

import { existsSync } from 'node:fs';
import { applyBatch, archiveBatch, failBatch, inferInbox } from './apply.ts';
import { commitVault } from './git.ts';
import { IngestError } from './validate.ts';

const argv = process.argv.slice(2);
function arg(name: string, def = ''): string {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const json = argv.includes('--json');
const doCommit = argv.includes('--commit');
const cmd = argv[0];
const batch = arg('--batch');
const shared = arg('--shared');
// 没给 --inbox 时，从 …\pending\<id> 推断，保证归档不会漏
const inbox = arg('--inbox') || inferInbox(batch) || '';

function fail(msg: string, code: string, exit = 1): never {
  if (json) console.log(JSON.stringify({ ok: false, code, error: msg }));
  else {
    console.error('ERROR ' + msg);
    console.error('FIX   看 docs/INGEST.md');
  }
  process.exit(exit);
}

if (cmd !== 'apply') fail('未知命令（只支持 apply）', 'USAGE', 2);
if (!batch) fail('缺少 --batch', 'USAGE', 2);
if (!shared) fail('缺少 --shared', 'USAGE', 2);

let result;
try {
  result = applyBatch(batch, shared);
} catch (e) {
  const err = e as IngestError;
  const code = err.code || 'ERROR';
  let moved: string | null = null;
  let moveError: string | null = null;
  if (inbox && existsSync(batch)) {
    try { moved = failBatch(batch, inbox, `${code}: ${err.message}`); } catch (me) { moveError = (me as Error).message; }
  }
  // 转移失败也要说出来：批次会留在 pending，调度可能反复重试同一个坏批次
  fail(err.message + (moved ? `（批次已移到 ${moved}）` : '') + (moveError ? `（转移到 failed 失败：${moveError}，批次仍在 pending）` : ''), code);
}

// 到这里文件已经写进 vault：归档/提交的失败只报告，不再判入库失败
let archived: string | null = null;
let archiveError: string | null = null;
if (inbox && existsSync(batch)) {
  try { archived = archiveBatch(batch, inbox); } catch (e) { archiveError = (e as Error).message; }
}

let commit: string | null = null;
let commitError: string | null = null;
if (doCommit) {
  try {
    const changed = [...result.added, ...result.modified];
    // 只提交本批写入的文件（含原件），不带上其他未复核的改动
    commit = commitVault(shared, `ingest: ${changed.join(', ') || 'batch ' + batch}`, [...changed, ...result.originals]);
  } catch (e) { commitError = (e as Error).message; }
}

if (json) {
  console.log(JSON.stringify({ ok: true, ...result, archived, archive_error: archiveError, commit, commit_error: commitError }));
} else {
  console.log('added   : ' + (result.added.join(', ') || '-'));
  console.log('modified: ' + (result.modified.join(', ') || '-'));
  console.log('original: ' + (result.originals.join(', ') || '-'));
  console.log('archived: ' + (archived || (archiveError ? 'FAILED ' + archiveError : '-')));
  console.log('commit  : ' + (commit || (doCommit ? ('FAILED ' + (commitError || '无改动')) : '(未提交，等复核)')));
}
