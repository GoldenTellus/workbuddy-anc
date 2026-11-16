// 移植层的契约测试：deploy-state / cleanup-media / watchdog。
//
// 为什么这些断言值得单独存在：
//   1. deploy-state 的 JSON 契约是 agent 的"唯一真相"，字段名/阶段表/退出码漂一个，
//      断点续装就会静默失效（历史上 ps1 踩过数组解包，症状是第一次 mark 对、之后清空）。
//   2. cleanup 以 SYSTEM/root 删用户目录里的文件，符号链接必须跳过——踩一次就是删系统目录。
//   3. watchdog 的判定必须能在测试里**注入 clock/probe**：真实机器上没法让 WorkBuddy 进程消失、
//      也没法让心跳停在 11 分钟前。判定逻辑抽成纯函数后，这些故障场景才可重复。
//
// 跑法：node --test scripts/platform/ports.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { STAGES, buildView, stageIds } from '../deploy/deploy-state.mjs';
import { collectTargets, runCleanup } from '../backup/cleanup-media.mjs';
import { evaluateChecks, shouldSuppress } from '../selfheal/watchdog.mjs';
import { prune, stamp } from '../backup/backup-anc.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const DEPLOY_STATE = join(REPO, 'scripts', 'deploy', 'deploy-state.mjs');
const EXECUTOR = join(REPO, 'scripts', 'executor', 'executor-tasks.mjs');

function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), tag + '-'));
}

function runNode(script, args, opts = {}) {
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
  } catch (e) {
    code = e.status ?? 1;
    out = (e.stdout ?? '') + (e.stderr ?? '');
  }
  return { code, text: out.replace(/^\uFEFF/, '').trim() };
}

// ── deploy-state 契约 ─────────────────────────────────────

test('deploy-state: Build-View 字段顺序与 ps1 的 pscustomobject 一致', () => {
  const view = buildView('company', null);
  assert.deepEqual(Object.keys(view), [
    'ok', 'side', 'stage', 'done', 'failed', 'error', 'at', 'progress', 'remaining', 'next', 'stages',
  ]);
  assert.equal(view.ok, false);
  assert.equal(view.side, 'company');
  assert.equal(view.stage, 'brief');
  assert.deepEqual(view.done, []);
  assert.equal(view.failed, '');
  assert.equal(view.error, '');
  assert.equal(view.at, '');
  assert.equal(view.progress, '0/14');
  assert.equal(view.remaining.length, 14);
  assert.match(view.next, /deploy-kickoff/, 'next 必须指向访谈入口');
  assert.equal(view.stages.length, 14);
  assert.deepEqual(view.stages[0], {
    id: 'brief',
    title: '递准备清单给人（§0，deploy-kickoff -Phase prepare）',
    state: 'pending',
  });
});

test('deploy-state: 阶段表 id / 顺序照抄 ps1（company 14、employee 9）', () => {
  assert.deepEqual(stageIds('company'), [
    'brief', 'answers', 'workbuddy', 'preflight', 'dirs', 'files', 'skills',
    'patch', 'tasks', 'vault', 'org', 'wecom', 'verify', 'executor',
  ]);
  assert.deepEqual(stageIds('employee'), [
    'brief', 'answers', 'preflight', 'workbuddy', 'files', 'skills', 'persona', 'bind', 'verify',
  ]);
  // 只有这两处标题在两侧不同：preflight 的章节号、workbuddy 的要求（登录）。
  const c = Object.fromEntries(STAGES.company.map((s) => [s.id, s.title]));
  const e = Object.fromEntries(STAGES.employee.map((s) => [s.id, s.title]));
  assert.equal(c.preflight, '前置检查（§3）');
  assert.equal(e.preflight, '前置检查（§2）');
  assert.equal(c.workbuddy, 'WorkBuddy 已装（§2，第 0 步，人做）');
  assert.equal(e.workbuddy, 'WorkBuddy 已装并登录（§3）');
  assert.equal(c.executor, '主干2 host：加入工作区 + TEST 冒烟（§8.5，部署后自动）');
});

test('deploy-state: 失败视图带 reason 且 next 劝阻从头来；退出码 1', () => {
  const view = buildView('company', {
    side: 'company',
    stage: 'files',
    done: ['brief', 'answers'],
    failed: 'files',
    at: '2026-11-16T12:00:00.0000000+08:00',
    error: '目标文件被锁',
  });
  assert.equal(view.ok, false);
  assert.equal(view.progress, '2/14');
  // stage 仍是「下一个未完成阶段」（ps1：remaining[0]）；failed 不改变它，重跑哪一步由人决定。
  assert.equal(view.stage, 'workbuddy');
  assert.match(view.next, /上次卡在 files（目标文件被锁）/);
  assert.match(view.next, /不要从头来/);
  assert.equal(view.stages.find((s) => s.id === 'files').state, 'failed');
});

test('deploy-state CLI: 状态文件无 BOM、字段顺序固定、at 可解析', () => {
  const root = tempDir('anc-ports-ds');
  try {
    const r = runNode(DEPLOY_STATE, ['--root', root, '--side', 'company', '--mark', 'brief', '--as-done', '--json']);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.text);
    assert.equal(parsed.progress, '1/14');

    const file = join(root, 'data', 'deploy-state.json');
    assert.ok(existsSync(file));
    const bytes = readFileSync(file);
    assert.notDeepEqual([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF], '.json 不带 BOM');
    const state = JSON.parse(bytes.toString('utf8'));
    assert.deepEqual(Object.keys(state), ['side', 'stage', 'done', 'failed', 'at', 'error']);
    assert.deepEqual(state.done, ['brief']);
    assert.ok(Number.isFinite(Date.parse(state.at)), 'at 必须是可解析的 ISO/PS 时间: ' + state.at);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deploy-state CLI: 未知阶段退出 2、employee 0/9、失败退出 1', () => {
  const root = tempDir('anc-ports-ds2');
  try {
    const bad = runNode(DEPLOY_STATE, ['--root', root, '--mark', 'nope', '--as-done', '--json']);
    assert.equal(bad.code, 2);
    assert.match(bad.text, /未知阶段/);

    const emp = JSON.parse(runNode(DEPLOY_STATE, ['--root', root, '--side', 'employee', '--json']).text);
    assert.equal(emp.progress, '0/9');

    const fail = runNode(DEPLOY_STATE, ['--root', root, '--mark', 'patch', '--as-failed', '--reason', 'ANCHOR-MISS', '--json']);
    assert.equal(fail.code, 1);
    assert.equal(JSON.parse(fail.text).failed, 'patch');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── cleanup-media ─────────────────────────────────────────

test('cleanup: 旧文件删、新文件留、符号链接整枝跳过', () => {
  const base = tempDir('anc-ports-clean');
  try {
    const media = join(base, 'workbuddy-wecom-media');
    const sub = join(media, 'deeper');
    const outside = join(base, 'outside');
    mkdirSync(sub, { recursive: true });
    mkdirSync(outside, { recursive: true });

    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const oldFile = join(media, 'old.bin');
    const nestedOld = join(sub, 'nested.bin');
    const newFile = join(media, 'fresh.bin');
    const victim = join(outside, 'keep.bin');
    for (const f of [oldFile, nestedOld, victim]) {
      writeFileSync(f, 'x'.repeat(1024));
      utimesSync(f, old, old);
    }
    writeFileSync(newFile, 'new');

    // 用户目录可写：建一个指向外部的链接，清理必须不跟随
    symlinkSync(outside, join(media, 'link'));

    const lines = [];
    const summary = runCleanup({
      targets: [media],
      days: 7,
      now: new Date(),
      logger: (line) => lines.push(line),
    });

    assert.equal(summary.removed, 2, '只删两枚旧文件');
    assert.ok(!existsSync(oldFile), '旧文件应被删');
    assert.ok(!existsSync(nestedOld), '子目录旧文件应被删');
    assert.ok(existsSync(newFile), '新文件不能删');
    assert.ok(existsSync(victim), '符号链接指向的文件一个都不能碰');
    assert.ok(lines.some((l) => /WARN skip reparse point: .*link/.test(l)), '要记录跳过符号链接');
    assert.ok(lines.some((l) => /clean: removed 2 file\(s\)/.test(l)));
    assert.ok(lines.some((l) => /done: 2 file\(s\)/.test(l)));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('cleanup: 没有可扫目录时只记 skip；默认扫描目录按平台推导', () => {
  const base = tempDir('anc-ports-targets');
  try {
    const lines = [];
    runCleanup({ targets: [], logger: (line) => lines.push(line) });
    assert.ok(lines.some((l) => /skip: no media dir found/.test(l)));

    const fakeTmp = join(base, 'tmp');
    const expected = join(fakeTmp, 'workbuddy-wecom-media');
    mkdirSync(expected, { recursive: true });
    const got = collectTargets({ platform: 'linux', tmpdir: fakeTmp, homedir: join(base, 'home'), env: {} });
    assert.deepEqual(got, [expected], 'POSIX 默认扫 os.tmpdir 下的同名目录');

    const win = collectTargets({
      platform: 'win32',
      usersRoot: join(base, 'Users'),
      env: { TEMP: fakeTmp },
      homedir: join(base, 'home'),
    });
    assert.deepEqual(win, [expected], 'Windows 上 TEMP 兜底仍生效（没有 C:\\Users 匹配时）');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── watchdog ──────────────────────────────────────────────

function fakeProbe(over = {}) {
  const files = over.files ?? {};
  const mtimes = over.mtimes ?? {};
  return {
    exists: (f) => Object.prototype.hasOwnProperty.call(files, f),
    mtimeMs: (f) => (f in mtimes ? mtimes[f] : null),
    readText: (f) => files[f],
    outboxPending: () => {
      if (over.pendingError) throw over.pendingError;
      return over.pending ?? 0;
    },
    processRunning: () => over.running ?? true,
    httpHealth: async () => {
      if (over.healthError) throw over.healthError;
      return over.health ?? { ok: true };
    },
    httpRequired: () => over.httpRequired ?? false,
  };
}

const WD_PATHS = { log: 'LOOP', patchGuard: 'GUARD', canary: 'CANARY' };

test('watchdog: 心跳缺失/过慢、积压、进程缺失都各报一条', async () => {
  const now = new Date('2026-11-16T12:00:00.000Z');

  const a = await evaluateChecks({ now, paths: WD_PATHS, probe: fakeProbe({ pending: 3 }) });
  assert.deepEqual(a.problems, ['没有 loop.log：服务从未跑过']);

  const b = await evaluateChecks({
    now,
    paths: WD_PATHS,
    probe: fakeProbe({
      files: { LOOP: 'heartbeat' },
      mtimes: { LOOP: now.getTime() - 11 * 60000 },
      pending: 50,
    }),
  });
  assert.ok(b.problems.some((p) => p === '本地小服务心跳停了 11 分钟（anc-service？）'));
  assert.ok(b.problems.some((p) => p === 'outbox 积压 50 条'));

  const c = await evaluateChecks({
    now,
    paths: WD_PATHS,
    probe: fakeProbe({ files: { LOOP: 'x' }, mtimes: { LOOP: now.getTime() }, running: false }),
  });
  assert.ok(c.problems.some((p) => p === 'WorkBuddy 没在跑（公司 bot 离线）'));

  const d = await evaluateChecks({
    now,
    paths: WD_PATHS,
    probe: fakeProbe({ pendingError: new Error('cli 不在') }),
  });
  assert.ok(d.problems.some((p) => p === '查 outbox 失败'));
});

test('watchdog: patch-guard 宽限与 canary 判定（可注入 clock）', async () => {
  const now = new Date('2026-11-16T12:00:00.000Z');
  const guard = JSON.stringify({ lastStartAt: new Date(now.getTime() - 2 * 60000).toISOString() });

  const grace = await evaluateChecks({
    now,
    paths: WD_PATHS,
    probe: fakeProbe({ files: { LOOP: 'x', GUARD: guard }, mtimes: { LOOP: now.getTime() }, running: false }),
  });
  assert.ok(!grace.problems.some((p) => p.includes('WorkBuddy 没在跑')), '重启 5 分钟内不报');

  const stale = await evaluateChecks({
    now,
    paths: WD_PATHS,
    probe: fakeProbe({
      files: { LOOP: 'x', GUARD: JSON.stringify({ lastStartAt: new Date(now.getTime() - 9 * 60000).toISOString() }) },
      mtimes: { LOOP: now.getTime() },
      running: false,
    }),
  });
  assert.ok(stale.problems.some((p) => p.includes('WorkBuddy 没在跑')));

  const canary = await evaluateChecks({
    now,
    paths: WD_PATHS,
    probe: fakeProbe({
      files: {
        LOOP: 'x',
        CANARY: JSON.stringify({ at: new Date(now.getTime() - 3600000).toISOString(), chatId: '' }),
      },
      mtimes: { LOOP: now.getTime() },
    }),
  });
  assert.ok(canary.problems.some((p) => p.includes('取不到 chatId')));
});

test('watchdog: HTTP 面只在注册了 anc-http 时要求，且区分没监听/不健康', async () => {
  const now = new Date('2026-11-16T12:00:00.000Z');
  const base = { files: { LOOP: 'x' }, mtimes: { LOOP: now.getTime() } };

  const off = await evaluateChecks({ now, paths: WD_PATHS, probe: fakeProbe({ ...base, httpRequired: true, healthError: new Error('ECONNREFUSED') }) });
  assert.ok(off.problems.some((p) => p === 'HTTP 面没在监听（anc-http？）'));

  const bad = await evaluateChecks({
    now,
    paths: WD_PATHS,
    probe: fakeProbe({ ...base, httpRequired: true, health: { ok: false, detail: 'db locked' } }),
  });
  assert.ok(bad.problems.some((p) => p === 'HTTP 面在但心跳不健康：db locked'));

  const skipped = await evaluateChecks({ now, paths: WD_PATHS, probe: fakeProbe({ ...base, httpRequired: false }) });
  assert.deepEqual(skipped.problems, []);
});

test('watchdog: 同一组问题在冷却期内不重复告警', () => {
  const now = new Date('2026-11-16T12:00:00.000Z');
  const key = 'a|b';
  assert.equal(shouldSuppress({ key, at: new Date(now.getTime() - 10 * 60000).toISOString() }, key, now, 30), true);
  assert.equal(shouldSuppress({ key, at: new Date(now.getTime() - 31 * 60000).toISOString() }, key, now, 30), false);
  assert.equal(shouldSuppress({ key: 'other', at: now.toISOString() }, key, now, 30), false);
  assert.equal(shouldSuppress(null, key, now, 30), false);
});

// ── executor-tasks ────────────────────────────────────────

test('executor-tasks: 没有部署根时 wake 静默退出 0；未知子命令退出 2', () => {
  const root = tempDir('anc-ports-exec');
  try {
    const wake = runNode(EXECUTOR, ['wake', '--root', root]);
    assert.equal(wake.code, 0, 'bridge/DB 不在时静默（ps1 的 exit 0）');
    assert.equal(wake.text, '', '不往 stdout 写东西');

    const bad = runNode(EXECUTOR, ['bogus', '--root', root]);
    assert.equal(bad.code, 2);
    assert.match(bad.text, /未知子命令/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 备份（backup-anc.mjs）──────────────────────────────────────────────────
// 为什么单独测它：CLI 的 `backup --to` 收文件路径且目标已存在会报错，
// 计划任务必须是「每次新文件名 + 保留策略」。文件名算错 = 第二次备份必失败（真机踩过）。

test('备份文件名：可排序且不含文件系统敏感字符', () => {
  const s = stamp(new Date(2026, 10, 16, 9, 5, 7));
  assert.equal(s, '20261116-090507');
  assert.match(s, /^\d{8}-\d{6}$/);
});

test('备份保留策略：只清理本前缀文件，按 mtime 留最新 keep 份', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-bk-'));
  try {
    const mk = (name, ageMs) => {
      const p = join(dir, name);
      writeFileSync(p, 'x');
      const t = (Date.now() - ageMs) / 1000;
      utimesSync(p, t, t);
    };
    mk('anc-20260101-000001.db', 30000);
    mk('anc-20260101-000002.db', 20000);
    mk('anc-20260101-000003.db', 10000);
    mk('keep-me.txt', 0);            // 不是本前缀：不许动
    mkdirSync(join(dir, 'deploy-20260101'), { recursive: true });  // 目录：不在扫描范围

    const removed = prune(dir, 2);
    assert.deepEqual(removed.sort(), ['anc-20260101-000001.db']);
    assert.deepEqual(readdirSync(dir).sort(), ['anc-20260101-000002.db', 'anc-20260101-000003.db', 'deploy-20260101', 'keep-me.txt']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
