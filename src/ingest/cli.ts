#!/usr/bin/env node
// 入库 CLI：把一个批次目录写进共享区，归档/转移批次，可选提交
// 用法：node src/ingest/cli.ts apply --batch <批次目录> --shared <共享区目录> [--inbox D:\anc\inbox] [--commit] [--json]

import { existsSync } from 'node:fs';
import { applyBatch, archiveBatch, failBatch } from './apply.ts';
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
const inbox = arg('--inbox');

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

try {
  const result = applyBatch(batch, shared);
  const archived = inbox ? archiveBatch(batch, inbox) : null;
  let commit: string | null = null;
  if (doCommit) {
    const changed = [...result.added, ...result.modified];
    commit = commitVault(shared, `ingest: ${changed.join(', ') || 'batch ' + batch}`);
  }
  if (json) console.log(JSON.stringify({ ok: true, ...result, archived, commit }));
  else {
    console.log('added   : ' + (result.added.join(', ') || '-'));
    console.log('modified: ' + (result.modified.join(', ') || '-'));
    console.log('original: ' + (result.originals.join(', ') || '-'));
    if (archived) console.log('archived: ' + archived);
    console.log('commit  : ' + (commit || (doCommit ? '(无改动)' : '(未提交，等复核)')));
  }
} catch (e) {
  const err = e as IngestError;
  const code = err.code || 'ERROR';
  let moved = null;
  if (inbox && existsSync(batch)) {
    try { moved = failBatch(batch, inbox, `${code}: ${err.message}`); } catch { /* ignore */ }
  }
  fail(err.message + (moved ? `（批次已移到 ${moved}）` : ''), code);
}
