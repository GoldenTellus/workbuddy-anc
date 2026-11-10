#!/usr/bin/env node
// 入库 CLI：把一个批次目录写进共享区，归档/转移批次，可选提交
// 用法：node src/ingest/cli.ts apply --batch <批次目录> --shared <共享区目录> [--inbox D:\anc\inbox] [--commit] [--json]

import { existsSync } from 'node:fs';
import { appendAudit, commandName } from '../../../core/index.ts';
import { applyBatch, archiveBatch, failBatch, inferInbox } from './apply.ts';
import { commitVault } from './git.ts';
import { IngestError } from './validate.ts';
import { join } from 'node:path';

const argv = process.argv.slice(2);
function arg(name: string, def = ''): string {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const json = argv.includes('--json');
const doCommit = argv.includes('--commit');
const cmd = argv[0];

/**
 * 护栏（D24，2026-11-02 实测后加）：vault 对 bot 的账号只读，入库只能由服务身份执行。
 * 非服务身份直接调这个 CLI 会在写 vault 时撞 EPERM——更糟的是，撞墙的 bot 可能试图去
 * "修" ACL（它是管理员，做得到），把权限防线拆掉。所以在入口就拦住并指路。
 * 确实要手工入库时：设 ANC_ALLOW_LOCAL_INGEST=1。
 */
if (cmd === 'apply' && process.env.ANC_ALLOW_LOCAL_INGEST !== '1') {
  const who = (process.env.USERNAME || '').trim();
  const isService = /^(SYSTEM|LOCAL SERVICE|NETWORK SERVICE)$/i.test(who);
  if (!isService) {
    process.stderr.write(
      'ERROR 入库必须通过本地服务的 HTTP 端点（POST /__anc_ingest），不要直接调本 CLI。\n' +
      '      原因：vault 对 ' + (who || '当前身份') + ' 是只读的，写操作只能由服务身份完成（D24）。\n' +
      '      做法：把批次写到 <ProgramData>\\anc\\inbox\\pending\\<id>，再 POST 给 /__anc_ingest。\n' +
      '      确实要手工入库时：设 ANC_ALLOW_LOCAL_INGEST=1。\n'
    );
    process.exit(2);
  }
}
const batch = arg('--batch');
const shared = arg('--shared');
// 没给 --inbox 时，从 …\pending\<id> 推断，保证归档不会漏
const inbox = arg('--inbox') || inferInbox(batch) || '';

// 审计：入库每次调用留一行，targets 记录动到的路径。
// bot 绕过 CLI 直接往 vault 复制文件时这里不会有记录——doctor 用这个差异发现绕过。
const dataDir = join(process.env.ProgramData ?? 'C:\\ProgramData', 'anc', 'data');
const audit = {
  at: new Date().toISOString(),
  cmd: 'ingest apply',
  ok: true,
  code: null as string | null,
  targets: [] as string[],
};
process.on('exit', (code) => {
  // fail() 直接 process.exit，不走 catch：用退出码补上 code，别让审计把失败记成"ok"
  audit.ok = code === 0 && !audit.code;
  audit.code = audit.code ?? (code === 0 ? null : 'EXIT_' + code);
  appendAudit(dataDir, audit);
});

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
  audit.targets = [...result.added, ...result.modified, ...result.originals];
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
    // 只提交本批的 markdown；原件不进 git（D14），由 vault 的 .gitignore 保证
    commit = commitVault(shared, `ingest: ${changed.join(', ') || 'batch ' + batch}`, changed);
  } catch (e) { commitError = (e as Error).message; }
}

// 文件已写入、批次已归档，只有提交失败：这是部分成功，必须非 0，否则调用方以为入库完成了
if (commitError) {
  fail('文件已写入但提交失败（批次已归档，需人工提交）: ' + commitError, 'COMMIT_FAILED');
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
