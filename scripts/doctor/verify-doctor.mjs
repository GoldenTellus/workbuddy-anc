#!/usr/bin/env node
// V4：证明 doctor 真的会在该 FAIL 的时候 FAIL。
//
// -SelfTest 用 fixture 验了 6 条（见 doctor.ps1 里的 Selftest 段），但它验的是"函数逻辑"。
// 这里做的是**真实环境抽查**：真去放宽 ACL、真去停任务、真去改补丁文件，看 doctor 是否
// 报出对应那一项 FAIL；恢复后是否转回 PASS。抽查的 FAIL 必须与注入的项一致，
// 否则说明"报了但报错了地方"，比不报更糟。
//
// 用法：node scripts/doctor/verify-doctor.mjs [--only acl|task|patch]
// 退出码：0 三项全过 / 1 有失败 / 2 用法或环境问题

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';

const PROGRAM_DATA = process.env.ProgramData ?? 'C:\\ProgramData';
const ROOT = join(PROGRAM_DATA, 'anc');
const SECRETS = join(ROOT, 'secrets');
const PATCH = join(ROOT, 'patch');
const REPO = join(import.meta.dirname, '..');
const DOCTOR = join(ROOT, 'bin', 'doctor.ps1');
const BACKUP = join(REPO, '_research', 'v4-backup');

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;

const lines = [];
const log = (m) => { lines.push(`- ${m}`); console.log('  ' + m); };

function ps(command) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    // icacls / Disable-ScheduledTask 也可能非 0：把输出带回来，由调用方判断
    return String(e.stdout ?? '') + String(e.stderr ?? '');
  }
}

/** 跑一次正式体检，返回 { 检查项名: 'PASS'|'WARN'|'FAIL' } */
function doctorState() {
  let out = '';
  try {
    out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DOCTOR, '-Repo', REPO], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // 有 FAIL 时 doctor 以非 0 退出——这不是错误，我们要的正是它的报告
    out = String(e.stdout ?? '') + String(e.stderr ?? '');
  }
  const map = {};
  for (const raw of out.split(/\r?\n/)) {
    const m = raw.trim().match(/^(PASS|WARN|FAIL)\s+(\S+)/);
    if (m) map[m[2]] = m[1];
  }
  return map;
}

function assertState(name, want, when) {
  const st = doctorState();
  const got = st[name] ?? '(缺这一项)';
  const ok = got === want;
  log(`${name} ${when}：期望 ${want}，实际 ${got} ${ok ? '✓' : '✗'}`);
  if (!ok) {
    // 把当时所有 FAIL 打出来，便于判断"报错地方不对"
    const fails = Object.entries(st).filter(([, v]) => v === 'FAIL').map(([k]) => k);
    log(`　当时的 FAIL 列表：${fails.join(', ') || '(无)'}`);
    throw new Error(`${name} 没有按期望变化`);
  }
}

// ── 抽查 1：放宽 secrets 的 ACL ──
function aclFault() {
  const before = join(BACKUP, 'secrets-acl.txt');
  mkdirSync(BACKUP, { recursive: true });
  writeFileSync(before, ps(`icacls "${SECRETS}"`), 'utf8');
  try {
    assertState('secrets-acl', 'PASS', '注入前');
    ps(`icacls "${SECRETS}" /grant "BUILTIN\\Users:(OI)(CI)RX" /T`);
    log('已给 secrets 加上 BUILTIN\\Users:(OI)(CI)RX');
    assertState('secrets-acl', 'FAIL', '放宽后');
  } finally {
    ps(`icacls "${SECRETS}" /remove:g "BUILTIN\\Users" /T`);
    log('已撤销 Users 授权');
  }
  assertState('secrets-acl', 'PASS', '恢复后');
}

// ── 抽查 2：停掉一个计划任务 ──
function taskFault() {
  const name = 'anc-watchdog';
  try {
    assertState(`task-${name}`, 'PASS', '注入前');
    ps(`Disable-ScheduledTask -TaskName ${name} | Out-Null`);
    log(`已禁用计划任务 ${name}`);
    // 禁用的任务，doctor 的 task-* 检查应报 FAIL（状态不是 Ready）
    const st = doctorState();
    const got = st[`task-${name}`] ?? '(缺这一项)';
    log(`task-${name} 禁用后：期望 FAIL，实际 ${got} ${got === 'FAIL' ? '✓' : '✗'}`);
    if (got !== 'FAIL') throw new Error(`禁用的任务没有让 task-${name} 报 FAIL`);
  } finally {
    ps(`Enable-ScheduledTask -TaskName ${name} | Out-Null`);
    log(`已重新启用 ${name}`);
  }
  assertState(`task-${name}`, 'PASS', '恢复后');
}

// ── 抽查 3：改一个补丁文件（doctor 会与仓库逐字节比）──
function patchFault() {
  const file = join(PATCH, 'preload.cjs');
  const bak = join(BACKUP, 'preload.cjs');
  mkdirSync(BACKUP, { recursive: true });
  if (!existsSync(file)) throw new Error('找不到 ' + file);
  copyFileSync(file, bak);
  const original = readFileSync(file, 'utf8');
  try {
    assertState('deploy-layout', 'PASS', '注入前');
    writeFileSync(file, original + '\n// v4 抽查注入\n', 'utf8');
    log('已改动 patch/preload.cjs（尾部加一行注释）');
    assertState('deploy-layout', 'FAIL', '改文件后');
  } finally {
    copyFileSync(bak, file);
    log('已从备份恢复 preload.cjs');
  }
  assertState('deploy-layout', 'PASS', '恢复后');
  try { unlinkSync(bak); } catch { /* ignore */ }
}

const FAULTS = { acl: ['secrets-acl 放宽', aclFault], task: ['计划任务停用', taskFault], patch: ['补丁文件被改', patchFault] };

function main() {
  if (!existsSync(DOCTOR)) { console.error('找不到 ' + DOCTOR); process.exit(2); }
  const names = only ? [only] : Object.keys(FAULTS);
  for (const n of names) if (!FAULTS[n]) { console.error(`未知抽查: ${n}`); process.exit(2); }

  console.log(`V4 doctor 实机抽查 @ ${new Date().toISOString()}`);
  log(`doctor: ${DOCTOR}`);
  const base = doctorState();
  const baseFails = Object.entries(base).filter(([, v]) => v === 'FAIL').map(([k]) => k);
  log(`基线 FAIL：${baseFails.join(', ') || '(无)'}`);
  // 基线里已 FAIL 的项不参与抽查（不然"注入前后都是 FAIL"看不出变化）
  for (const n of names) {
    const [label] = FAULTS[n];
    const key = n === 'acl' ? 'secrets-acl' : n === 'task' ? 'task-anc-watchdog' : 'deploy-layout';
    if (base[key] === 'FAIL') { log(`跳过 ${label}：该项基线就是 FAIL，无法观察变化`); continue; }
    console.log(`\n[${label}]`);
    try {
      FAULTS[n][1]();
      log(`结果：PASS`);
    } catch (e) {
      log(`结果：FAIL — ${e.message}`);
      try { FAULTS[n][1].name; } catch { /* ignore */ }
    }
  }
  const failed = lines.filter((l) => l.includes('结果：FAIL')).length;
  log(`\n汇总：${names.length - failed} PASS · ${failed} FAIL`);

  mkdirSync(dirname(join(REPO, '_research', 'v4-doctor.md')), { recursive: true });
  writeFileSync(join(REPO, '_research', 'v4-doctor.md'), `# V4 doctor 抽查 ${new Date().toISOString()}\n\n${lines.join('\n')}\n`, 'utf8');
  process.exit(failed ? 1 : 0);
}

main();
