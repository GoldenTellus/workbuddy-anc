#!/usr/bin/env node
// 入库 CLI：把一个批次目录写进共享区
// 用法：node src/ingest/cli.ts apply --batch <批次目录> --shared <共享区目录> [--json]

import { applyBatch } from './apply.ts';
import { IngestError } from './validate.ts';

const argv = process.argv.slice(2);
function arg(name: string, def = ''): string {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const json = argv.includes('--json');
const cmd = argv[0];
const batch = arg('--batch');
const shared = arg('--shared');

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
  if (json) console.log(JSON.stringify({ ok: true, ...result }));
  else {
    console.log('added   : ' + (result.added.join(', ') || '-'));
    console.log('modified: ' + (result.modified.join(', ') || '-'));
    console.log('original: ' + (result.originals.join(', ') || '-'));
    console.log('（未提交 git；复核 diff 后再提交）');
  }
} catch (e) {
  const err = e as IngestError;
  fail(err.message, err.code || 'ERROR');
}
