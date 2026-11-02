#!/usr/bin/env node
// V3 五类故障注入：webhook / clock / lock / kill / disk
//
// 为什么要脚本而不是手敲：2026-11-02 第一轮手敲时，清理 SQL 的引号在 PowerShell 里
// 坏过两次、测试批次因 BOM 被判成"缺少 frontmatter"、脏数据把后续判断全带偏。
// 故障注入必须可重复、自建现场、自清理，并且**留下一份恢复日志**（PLAN V3 的要求）。
//
// 用法：
//   node scripts/fault-inject.mjs                 # 只跑安全的：webhook clock lock
//   node scripts/fault-inject.mjs --all --yes     # 连 kill / disk 一起跑（会停服务、改 ACL）
//   node scripts/fault-inject.mjs --only clock
// 退出码：0 全 PASS / 1 有 FAIL / 2 用法错误

import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const PROGRAM_DATA = process.env.ProgramData ?? 'C:\\ProgramData';
const ROOT = join(PROGRAM_DATA, 'anc');
const DB = join(ROOT, 'data', 'anc.db');
const VAULT = 'D:\\anc\\vault-shared';
const SECRETS = join(ROOT, 'secrets');
const INBOX = join(ROOT, 'inbox');

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const all = argv.includes('--all');
const confirmed = argv.includes('--yes');
const logPath = argv.includes('--log') ? argv[argv.indexOf('--log') + 1] : join('_research', `fault-injection-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}.md`);

const lines = [];
function log(msg) {
  const line = `- ${msg}`;
  lines.push(line);
  console.log('  ' + msg);
}

let CURRENT_DETAILS = [];
function must(ok, msg) {
  if (!ok) {
    const e = new Error(msg);
    e.faultDetails = CURRENT_DETAILS;
    throw e;
  }
}

function withDb(fn) {
  const db = new DatabaseSync(DB);
  try { return fn(db); } finally { db.close(); }
}

// 合法批次：三个字段都不能少，且**不能带 BOM**（当前实现不容忍 BOM，见 V3 发现 3）
function makeBatch(dir, targetRel, title = '故障注入测试') {
  mkdirSync(dir, { recursive: true });
  const md = `---\ntitle: ${title}\nsource_file: 故障注入脚本\nupdated_at: 2026-11-02\n---\n\n# ${title}\n\n占位正文。\n`;
  writeFileSync(join(dir, 'x.md'), md, 'utf8');
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({
    batch_id: 'fault-test',
    chat_id: 'chat-fault',
    from_userid: 'u-fault',
    received_at: '2026-11-02T00:00:00+08:00',
    files: [{ src: 'x.md', target: targetRel, kind: 'markdown' }],
  }, null, 2), 'utf8');
}

function runCli(args) {
  // 用仓库版而不是 %ProgramData% 的部署版：故障注入要验最新代码；
  // 部署版由 deploy.ps1 保证与仓库一致，拿它测会把「还没部署」误判成「功能坏了」
  const cli = join(import.meta.dirname, '..', 'src', 'service', 'cli.ts');
  try {
    const out = execFileSync(process.execPath, ['--no-warnings', cli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
}

function tick(extra = []) {
  const r = runCli(['loop', '--db', DB, '--once', '--json', ...extra]);
  try { return JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { return { ok: false, raw: r.out.slice(0, 200) }; }
}

// ───────────────────────────── 故障 1：webhook 失效 ─────────────────────────────
async function webhook() {
  const hookFile = join(SECRETS, 'hook-fault.txt');
  const chatId = 'chat-fault';
  const details = [];
  CURRENT_DETAILS = details;
  try {
    writeFileSync(hookFile, 'not-a-url', 'utf8');
    runCli(['bind', 'set', '--db', DB, '--chat-id', chatId, '--employee', '故障测试', '--userid', 'u-fault', '--webhook-file', 'hook-fault.txt']);
    const due = new Date(Date.now() - 60_000);
    const pad = (n) => String(n).padStart(2, '0');
    const local = `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())} ${pad(due.getHours())}:${pad(due.getMinutes())}`;
    const add = runCli(['task', 'add', '--db', DB, '--title', '故障注入-webhook', '--chat-id', chatId,
      '--requester', '管理员', '--requester-userid', 'u-admin', '--due-local', local, '--json']);
    const taskId = JSON.parse(add.out.slice(add.out.indexOf('{'))).task.id;
    details.push(`任务 #${taskId} 已建，webhook 文件内容为 not-a-url`);

    const r = tick();
    details.push(`tick: enqueued=${r.enqueued} failed=${r.failed}`);

    // dedupe_key 里是 reminder id，不是 task id —— 用 chat_id 查最新更稳
    const row = withDb((db) => db.prepare(
      "SELECT status, attempts, coalesce(last_error,'') e, dedupe_key FROM outbox WHERE chat_id = ? ORDER BY id DESC LIMIT 1"
    ).get(chatId));

    must(row, '没有产生 outbox 记录');
    details.push(`outbox: status=${row.status} attempts=${row.attempts} error=${row.e.slice(0, 50)}`);
    // 判定：错误被记录、消息没丢（pending 或 failed 都算"记下了"）
    const recorded = row.status === 'pending' || row.status === 'failed';
    const configErr = /不是 https URL|NO_WEBHOOK/i.test(row.e);
    must(recorded, '消息状态既不是 pending 也不是 failed，可能丢了');
    must(configErr, '错误信息没有指出是 webhook 配置问题');
    // 已知问题：配置错误仍走 5 次退避，不是立即判死
    if (row.status === 'pending') {
      details.push('⚠ 配置类错误被当成可重试（pending + 退避），要重试到判死——已记入待改进');
    }
    return { pass: true, details };
  } finally {
    try { runCli(['bind', 'unbind', '--db', DB, '--chat-id', chatId]); } catch { /* ignore */ }
    try { unlinkSync(hookFile); } catch { /* ignore */ }
    withDb((db) => {
      const t = db.prepare('SELECT id FROM tasks WHERE title = ?').get('故障注入-webhook');
      if (t) {
        db.prepare('DELETE FROM outbox WHERE dedupe_key LIKE ?').run(`reminder:${t.id}%`);
        db.prepare('DELETE FROM reminders WHERE task_id = ?').run(t.id);
        db.prepare('DELETE FROM task_events WHERE task_id = ?').run(t.id);
        db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
      }
      // dedupe_key 里是 reminder id 不是 task id，按 chat 清才干净
      db.prepare('DELETE FROM outbox WHERE chat_id = ?').run(chatId);
    });
  }
}

// ───────────────────────────── 故障 2：时钟跳变 ─────────────────────────────
async function clock() {
  const details = [];
  CURRENT_DETAILS = details;
  const chatId = 'chat-fault';
  try {
    writeFileSync(join(SECRETS, 'hook-fault.txt'), 'not-a-url', 'utf8');
    runCli(['bind', 'set', '--db', DB, '--chat-id', chatId, '--employee', '故障测试', '--userid', 'u-fault', '--webhook-file', 'hook-fault.txt']);
    const t = new Date(Date.now() + 24 * 3600_000);
    const pad = (n) => String(n).padStart(2, '0');
    const local = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} 09:00`;
    const add = runCli(['task', 'add', '--db', DB, '--title', '故障注入-clock', '--chat-id', chatId,
      '--requester', '管理员', '--requester-userid', 'u-admin', '--due-local', local, '--json']);
    const taskId = JSON.parse(add.out.slice(add.out.indexOf('{'))).task.id;
    const day = local.slice(0, 10);
    details.push(`任务 #${taskId}，due=${local}`);

    const keysAfter = (n) => n > 0 ? withDb((db) => db.prepare('SELECT dedupe_key FROM outbox ORDER BY id DESC LIMIT ?').all(n)) : [];
    const a = tick(['--now', `${day}T09:01:00+08:00`]);
    const aKeys = keysAfter(a.enqueued ?? 0).map((x) => x.dedupe_key);
    const b = tick();
    const bKeys = keysAfter(b.enqueued ?? 0).map((x) => x.dedupe_key);
    const c = tick(['--now', `${day}T09:01:00+08:00`]);
    details.push(`A 新入队键: ${aKeys.join(', ') || '(无)'}`);
    details.push(`B 新入队键: ${bKeys.join(', ') || '(无)'}`);
    details.push(`A 跳到 due 之后: enqueued=${a.enqueued}（期望 1）`);
    details.push(`B 回退到今天:   enqueued=${b.enqueued}（期望 0）`);
    details.push(`C 再跳回同刻:   enqueued=${c.enqueued}（期望 0）`);
    must(a.enqueued === 1, '跳到 due 之后没有入队');
    must(b.enqueued === 0, '时钟回退后重发了消息');
    must(c.enqueued === 0, '同一时刻重复入队');
    return { pass: true, details };
  } finally {
    try { runCli(['bind', 'unbind', '--db', DB, '--chat-id', chatId]); } catch { /* ignore */ }
    try { unlinkSync(join(SECRETS, 'hook-fault.txt')); } catch { /* ignore */ }
    withDb((db) => {
      const t = db.prepare('SELECT id FROM tasks WHERE title = ?').get('故障注入-clock');
      if (t) {
        db.prepare('DELETE FROM outbox WHERE dedupe_key LIKE ? OR dedupe_key LIKE ?').run(`reminder:${t.id}%`, `carry:${t.id}%`);
        db.prepare('DELETE FROM reminders WHERE task_id = ?').run(t.id);
        db.prepare('DELETE FROM task_events WHERE task_id = ?').run(t.id);
        db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
      }
      // dedupe_key 里是 reminder id 不是 task id，按 chat 清才干净
      db.prepare('DELETE FROM outbox WHERE chat_id = ?').run(chatId);
    });
  }
}

// ───────────────────────────── 故障 3：入库锁残留 ─────────────────────────────
async function lock() {
  const details = [];
  // 真实锁路径由 apply.ts 决定：vault 下有 .git 就用 .git/anc-ingest.lock，否则用 .anc-ingest.lock
  const lockFile = existsSync(join(VAULT, '.git')) ? join(VAULT, '.git', 'anc-ingest.lock') : join(VAULT, '.anc-ingest.lock');
  const tmp = mkdtempSync(join(tmpdir(), 'anc-fault-lock-'));
  const target = 'collab/_fault-lock-test.md';
  const targetAbs = join(VAULT, target);
  const { applyBatch } = await import('../src/ingest/apply.ts');
  try {
    makeBatch(tmp, target);

    // 3a 活锁：pid 是当前进程，必须拒绝
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), 'utf8');
    let aliveRejected = false;
    let aliveMsg = '';
    try { applyBatch(tmp, VAULT); } catch (e) { aliveRejected = true; aliveMsg = e.message; }
    details.push(`3a 活锁(pid=${process.pid}): ${aliveRejected ? '已拒绝 — ' + aliveMsg.slice(0, 60) : '★ 被放行（应当拒绝）'}`);
    must(aliveRejected, '活锁没有拦住入库');

    // 3b 死锁：pid 不存在，必须接管
    writeFileSync(lockFile, JSON.stringify({ pid: 999999, started_at: new Date().toISOString() }), 'utf8');
    let tookOver = false;
    let tookMsg = '';
    try { applyBatch(tmp, VAULT); tookOver = true; } catch (e) { tookMsg = e.message; }
    details.push(`3b 死锁(pid=999999): ${tookOver ? '已接管并完成入库' : '★ 被卡住 — ' + tookMsg.slice(0, 60)}`);
    must(tookOver, '残留锁没有自动接管，需要人工删锁');
    must(existsSync(targetAbs), '接管后没有写出目标文件');
    return { pass: true, details };
  } finally {
    try { unlinkSync(lockFile); } catch { /* ignore */ }
    try { rmSync(targetAbs, { force: true }); } catch { /* ignore */ }
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    // 批次可能被归档到 inbox，顺手清掉
    for (const d of ['done', 'failed']) {
      try { rmSync(join(INBOX, d, 'fault-test'), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

// ───────────────────────────── 故障 4：杀进程（需 --yes）─────────────────────────────
async function kill() {
  const details = [];
  CURRENT_DETAILS = details;
  if (!confirmed) return { pass: false, skip: '需要 --yes（会停掉服务进程）', details: [] };
  const before = runCli(['config', 'list', '--db', DB, '--json']);
  details.push(`杀之前 CLI 可用: ${before.code === 0 ? '是' : '否'}`);
  // 停 anc-http（长驻），模拟进程被杀；计划任务下一次触发应自愈
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'cli.ts.*serve' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { stdio: 'ignore' });
  } catch { /* ignore */ }
  const procs = execFileSync('powershell', ['-NoProfile', '-Command', "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'cli.ts.*serve' } | Measure-Object).Count"], { encoding: 'utf8' }).trim();
  details.push(`杀掉后 serve 进程数: ${procs}`);
  // 手动触发一次 anc-http 任务，验证能起来
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', "Start-ScheduledTask -TaskName anc-http"], { stdio: 'ignore' });
  } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 6000));
  let health = '';
  try {
    health = execFileSync('powershell', ['-NoProfile', '-Command', "try { (Invoke-RestMethod -Uri 'http://127.0.0.1:17891/__anc_health' -TimeoutSec 4 | ConvertTo-Json -Compress) } catch { 'DOWN' }"], { encoding: 'utf8' }).trim();
  } catch { health = 'DOWN'; }
  details.push(`重启后 health: ${health.slice(0, 80)}`);
  const pass = health.includes('"ok":true');
  must(pass, '杀掉后没有自愈（health 不通）');
  return { pass, details };
}

// ───────────────────────────── 故障 5：写入失败（需 --yes）─────────────────────────────
async function disk() {
  const details = [];
  CURRENT_DETAILS = details;
  if (!confirmed) return { pass: false, skip: '需要 --yes（会临时改目录 ACL）', details: [] };
  const dataDir = join(ROOT, 'data');
  const probe = join(dataDir, 'fault-write-probe.txt');
  // 用"拒绝 Everyone 写入"模拟磁盘满导致的写入失败（比真把盘写满安全）
  try {
    execFileSync('icacls', [dataDir, '/deny', `${process.env.USERNAME ?? 'Administrators'}:(W)`], { stdio: 'ignore' });
    // 先造一个到点任务：不然 tick 没有写操作，测不出"写不进去时会怎样"
    writeFileSync(join(SECRETS, 'hook-fault.txt'), 'not-a-url', 'utf8');
    runCli(['bind', 'set', '--db', DB, '--chat-id', 'chat-fault', '--employee', '故障测试', '--userid', 'u-fault', '--webhook-file', 'hook-fault.txt']);
    const due = new Date(Date.now() - 60_000);
    const pad = (n) => String(n).padStart(2, '0');
    const local = `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())} ${pad(due.getHours())}:${pad(due.getMinutes())}`;
    runCli(['task', 'add', '--db', DB, '--title', '故障注入-disk', '--chat-id', 'chat-fault',
      '--requester', '管理员', '--requester-userid', 'u-admin', '--due-local', local, '--json']);

    // deny 目录只挡「创建新文件」；SQLite 是就地更新已有的 db/wal，必须 deny 文件本身
    const dbFiles = [DB, DB + '-wal', DB + '-shm'].filter((f) => existsSync(f));
    for (const f of dbFiles) {
      execFileSync('icacls', [f, '/deny', `${process.env.USERNAME ?? 'Administrators'}:(W)`], { stdio: 'ignore' });
    }
    details.push('已对库文件设置拒绝写入: ' + dbFiles.map((f) => f.split('\\').pop()).join(', '));
    let writeFailed = false;
    try { writeFileSync(probe, 'x', 'utf8'); } catch { writeFailed = true; }
    details.push(`写入探测: ${writeFailed ? '被拒（符合预期）' : '★ 仍能写（ACL 没生效）'}`);
    must(writeFailed, 'ACL 没生效，无法模拟写入失败');

    // 有到点任务时 tick 必须写库：这里要看到"明确失败"，而不是假装成功
    const r = tick();
    details.push(`拒绝写入时 tick: ok=${r.ok} enqueued=${r.enqueued ?? '?'} ${r.error ? 'error=' + String(r.error).slice(0, 70) : ''}`);
    must(r.ok === false, '写不进去却报 ok=true —— 会把失败当成功');
    return { pass: true, details };
  } finally {
    for (const f of [DB, DB + '-wal', DB + '-shm', dataDir]) {
      try { execFileSync('icacls', [f, '/remove:d', `${process.env.USERNAME ?? 'Administrators'}`], { stdio: 'ignore' }); } catch { /* ignore */ }
    }
    try { unlinkSync(probe); } catch { /* ignore */ }
    try {
      const t = withDb((db) => db.prepare('SELECT id FROM tasks WHERE title = ?').get('故障注入-disk'));
      if (t) {
        withDb((db) => {
          db.prepare('DELETE FROM outbox WHERE chat_id = ?').run('chat-fault');
          db.prepare('DELETE FROM reminders WHERE task_id = ?').run(t.id);
          db.prepare('DELETE FROM task_events WHERE task_id = ?').run(t.id);
          db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
          db.prepare("DELETE FROM chat_bindings WHERE chat_id = 'chat-fault'").run();
        });
      }
      try { unlinkSync(join(SECRETS, 'hook-fault.txt')); } catch { /* ignore */ }
    } catch { /* ignore */ }
    details.push('已撤销 ACL，并确认可写: ' + (() => { try { writeFileSync(probe, 'x'); unlinkSync(probe); return '是'; } catch { return '否'; } })());
  }
}

const ALL = { webhook, clock, lock, kill, disk };
const SAFE = ['webhook', 'clock', 'lock'];

async function main() {
  const names = only ? [only] : (all ? Object.keys(ALL) : SAFE);
  for (const n of names) {
    if (!ALL[n]) { console.error(`未知故障: ${n}（可选: ${Object.keys(ALL).join(' / ')}）`); process.exit(2); }
  }
  log(`V3 故障注入 @ ${new Date().toISOString()}`);
  log(`库: ${DB}　vault: ${VAULT}`);
  const results = [];
  for (const n of names) {
    console.log(`\n[${n}]`);
    let r;
    try {
      r = await ALL[n]();
    } catch (e) {
      r = { pass: false, details: [...(e.faultDetails ?? []), String(e.message)] };
    }
    results.push({ name: n, ...r });
    for (const d of r.details ?? []) log(d);
    if (r.skip) log(`跳过：${r.skip}`);
    log(`结果：${r.pass ? 'PASS' : (r.skip ? 'SKIP' : 'FAIL')}`);
  }

  const fails = results.filter((r) => !r.pass && !r.skip);
  const skips = results.filter((r) => r.skip);
  const summary = `\n**汇总**：${results.length - fails.length - skips.length} PASS · ${fails.length} FAIL · ${skips.length} SKIP`;
  log(summary.trim());

  mkdirSync(dirname(logPath), { recursive: true });
  const md = [
    `# V3 故障注入报告 ${new Date().toISOString()}`,
    '',
    `命令：\`node scripts/fault-inject.mjs ${argv.join(' ')}\``,
    '',
    ...lines,
    '',
    fails.length ? `## 失败项\n\n${fails.map((f) => `- ${f.name}`).join('\n')}` : '## 失败项\n\n无',
  ].join('\n');
  writeFileSync(logPath, md, 'utf8');
  console.log(`\n报告: ${logPath}`);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error('ERROR ' + e.message); process.exit(2); });
