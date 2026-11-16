// 部署引擎的测试：dry-run / apply / 对拍失败回滚 / 复制失败回滚 / --rollback / 平台过滤 / 清单一致性。
//
// 原则：
//   1. **只在 mkdtemp 出来的临时目录里跑**，不碰真实部署目录（%ProgramData%\anc、
//      /Library/Application Support/anc、%LOCALAPPDATA%\anc 都不该被这个测试碰到）。
//   2. **不写死文件总数**：清单会长，硬编码的 160/165/169 每加一个文件就要改一次测试。
//      与 ps1 的一致性交给跨层投影比对；这里只断言「与清单推导出的数一致」。
//   每个用例自带一份最小仓库（.git + src/core + scripts/...）和一份最小清单。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  buildPlan,
  loadManifest,
  matchGlob,
  platformAllows,
  stampNow,
  DEFAULT_MANIFEST,
} from '../deploy/deploy.mjs';
import {
  checkSrcParity,
  compareManifestToPs1,
  normalizeMapEntry,
  parsePs1Deploy,
  projectWhiteList,
} from '../checks/check-platform-parity.mjs';

const HERE = import.meta.dirname;
const DEPLOY = resolve(HERE, '..', 'deploy', 'deploy.mjs');
const REPO = resolve(HERE, '..', '..'); // 真实仓库（只读：只用来测清单与 ps1 是否一致）

const MANIFEST = {
  map: [
    { Target: 'core', Source: 'src/core', Filter: ['*.ts', '*.json'], Exclude: ['*.test.ts'] },
    { Target: 'light/templates', Source: 'light/templates', Filter: ['*.md'], Exclude: [], Recurse: true },
    {
      Target: 'bin',
      Source: 'scripts',
      Filter: ['*'],
      Exclude: [],
      Recurse: true,
      Flatten: true,
      Only: ['launch/a.cmd', 'executor/tick.ps1'],
    },
  ],
  binScripts: ['launch/a.cmd', 'executor/tick.ps1'],
  toolScripts: [],
  notDeployed: ['verify/x.ps1'],
};

const PLAN_RELS = [
  'bin/a.cmd',
  'bin/tick.ps1',
  'core/a.ts',
  'core/pkg.json',
  'light/templates/company-bot.md',
  'light/templates/vault/board.md',
];

const V1 = 'export const a = 1;\n';

function write(p, body) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body, 'utf8');
}

/** 造一个最小但结构完整的仓库 + 部署根。临时目录随测试结束删除。 */
function fixture(t, manifest = MANIFEST) {
  const base = mkdtempSync(join(tmpdir(), 'anc-deploy-'));
  const repo = join(base, 'repo');
  const root = join(base, 'root');
  mkdirSync(join(repo, '.git'), { recursive: true });
  write(join(repo, 'src/core/a.ts'), V1);
  write(join(repo, 'src/core/pkg.json'), '{"name":"core"}\n');
  write(join(repo, 'src/core/a.test.ts'), '// 测试文件不该上生产\n');
  write(join(repo, 'light/templates/company-bot.md'), '# company\n');
  write(join(repo, 'light/templates/vault/board.md'), '# 看板\n');
  write(join(repo, 'scripts/launch/a.cmd'), '@echo off\r\n');
  write(join(repo, 'scripts/executor/tick.ps1'), '# tick\n');
  write(join(repo, 'scripts/verify/x.ps1'), '# 仓库自测，不部署\n');
  write(join(repo, 'scripts/dev/unlisted.ps1'), '# 开发用，未归类\n');
  const manifestPath = join(repo, 'deploy-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, repo, root, manifestPath };
}

// 平台过滤夹具：一条 darwin-only 映射 + 一个 darwin-only 白名单项（.sh 启动器）
const PLATFORM_MANIFEST = {
  map: [
    { Target: 'core', Source: 'src/core', Filter: ['*.ts'], Exclude: ['*.test.ts'] },
    { Target: 'platform', Source: 'scripts/platform', Filter: ['*.mjs'], Exclude: ['*.test.mjs'] },
    { Target: 'maconly', Source: 'src/maconly', Filter: ['*.ts'], Exclude: [], Platforms: ['darwin'] },
    {
      Target: 'bin',
      Source: 'scripts',
      Filter: ['*'],
      Exclude: [],
      Recurse: true,
      Flatten: true,
      Only: ['launch/a.cmd', { Path: 'platform/darwin/anc-launch.sh', Platforms: ['darwin'] }],
    },
  ],
  binScripts: ['launch/a.cmd', { Path: 'platform/darwin/anc-launch.sh', Platforms: ['darwin'] }],
  toolScripts: [],
  notDeployed: ['verify/x.ps1'],
};

function platformFixture(t, manifest = PLATFORM_MANIFEST) {
  const ctx = fixture(t, manifest);
  write(join(ctx.repo, 'scripts/platform/anc-platform.mjs'), 'export const OS = {};\n');
  write(join(ctx.repo, 'scripts/platform/platform.test.mjs'), '// 测试文件不部署\n');
  // darwin 启动器：源文件带可执行位，部署后必须保留（launchd 直接 exec）
  const sh = join(ctx.repo, 'scripts/platform/darwin/anc-launch.sh');
  write(sh, '#!/bin/sh\nexec node "$(dirname "$0")/anc-launch.mjs"\n');
  chmodSync(sh, 0o755);
  write(join(ctx.repo, 'src/maconly/x.ts'), 'export const x = 1;\n');
  return ctx;
}

function run(args, { env = {}, cwd } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [DEPLOY, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ANC_DEPLOY_FAULT: '', ...env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
}

function deploy(ctx, extra = [], opts = {}) {
  return run(['--repo', ctx.repo, '--root', ctx.root, '--manifest', ctx.manifestPath, ...extra], opts);
}

function deployedPath(ctx, rel) {
  return join(ctx.root, ...rel.split('/'));
}

const rels = (plan) => plan.files.map((f) => f.rel).sort();

// ── 通配与时间戳 ──────────────────────────────────────────
test('通配按 PowerShell -like 语义：大小写不敏感、* ? [a-z]', () => {
  assert.equal(matchGlob('A.TS', '*.ts'), true, '-like 不区分大小写');
  assert.equal(matchGlob('a.test.ts', '*.test.ts'), true);
  assert.equal(matchGlob('a.test.ts', '*.ts'), true);
  assert.equal(matchGlob('a.json', '*.ts'), false);
  assert.equal(matchGlob('x1.cmd', 'x?.cmd'), true);
  assert.equal(matchGlob('run-hidden.vbs', 'run-*.vbs'), true);
  assert.equal(matchGlob('b.ps1', '[a-c].ps1'), true);
});

test('备份时间戳与 ps1 的 yyyyMMdd-HHmmss 同格式', () => {
  assert.match(stampNow(new Date(2026, 10, 16, 9, 5, 7)), /^20261116-090507$/);
});

// ── 计划 ──────────────────────────────────────────────────
test('计划：保留源目录结构、bin 扁平、测试文件与清单外脚本不部署', (t) => {
  const ctx = fixture(t);
  const plan = buildPlan({ repo: ctx.repo, manifest: loadManifest(ctx.manifestPath), root: ctx.root });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(rels(plan), PLAN_RELS);

  // 结构必须保留（模块子目录不能拍平）；bin 必须拍平
  assert.equal(plan.files.find((f) => f.rel === 'bin/a.cmd').dst, join(ctx.root, 'bin', 'a.cmd'));
  assert.ok(plan.files.find((f) => f.rel === 'light/templates/vault/board.md'));
  assert.equal(plan.files.some((f) => /\.test\.ts$/.test(f.rel)), false);
  assert.ok(plan.files.every((f) => /^[0-9a-f]{64}$/.test(f.hash)), '每个文件都要预先算好 sha256');
  // 未归类脚本只提醒，不算失败（与 ps1 的 WARN 一致）
  assert.ok(plan.warnings.some((w) => w.includes('scripts/dev/unlisted.ps1')));
});

// ── dry-run（默认）────────────────────────────────────────
test('默认 dry-run：只打印计划，一个字节都不写', (t) => {
  const ctx = fixture(t);
  const r = deploy(ctx);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /DRY-RUN/);
  assert.match(r.stdout, /合计 6 个文件/);
  assert.equal(existsSync(ctx.root), false, 'dry-run 不许创建部署根');

  const j = deploy(ctx, ['--json']);
  assert.equal(j.status, 0);
  const out = JSON.parse(j.stdout); // --json 时 stdout 只有一个 JSON 对象
  assert.equal(out.mode, 'dry-run');
  assert.equal(out.total, PLAN_RELS.length);
  assert.equal(out.files.length, PLAN_RELS.length);
  assert.ok(Array.isArray(out.warnings) && out.warnings.length > 0);
  assert.equal(existsSync(ctx.root), false);
});

// ── apply ─────────────────────────────────────────────────
test('--apply：按清单建出文件树、逐文件校验、备份目录就位', (t) => {
  const ctx = fixture(t);
  const r = deploy(ctx, ['--apply']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /6 个文件已部署并逐一校验通过/);

  for (const rel of PLAN_RELS) assert.ok(existsSync(deployedPath(ctx, rel)), '缺文件: ' + rel);
  assert.equal(existsSync(join(ctx.root, 'bin', 'launch')), false, 'bin 必须扁平');
  assert.equal(existsSync(deployedPath(ctx, 'core/a.test.ts')), false, '测试文件不许上生产');
  assert.equal(readFileSync(deployedPath(ctx, 'core/a.ts'), 'utf8'), V1);

  const j = JSON.parse(deploy(ctx, ['--apply', '--json']).stdout);
  assert.equal(j.mode, 'apply');
  assert.equal(j.copied, PLAN_RELS.length);
  assert.equal(j.verified, PLAN_RELS.length);
  assert.match(j.backup, /deploy-\d{8}-\d{6}/);
  assert.ok(j.backup.startsWith(join(ctx.root, 'backup')), '备份必须在 <root>/backup/deploy-<stamp>/');
});

// ── 平台过滤 ──────────────────────────────────────────────
test('平台过滤：映射项与白名单项的 Platforms 各自生效，不匹配的进 skipped', (t) => {
  const ctx = platformFixture(t);
  const manifest = loadManifest(ctx.manifestPath);

  const win = buildPlan({ repo: ctx.repo, manifest, root: ctx.root, platform: 'win32' });
  const mac = buildPlan({ repo: ctx.repo, manifest, root: ctx.root, platform: 'darwin' });

  // Windows：darwin-only 的 .sh 与整条 maconly 映射都不铺，原因写清楚
  assert.deepEqual(win.skipped.map((s) => s.rel).sort(), ['bin/anc-launch.sh', 'maconly/x.ts']);
  assert.ok(win.skipped.every((s) => s.reason === 'platforms=darwin'), '跳过原因要带平台: ' + JSON.stringify(win.skipped));
  assert.deepEqual(rels(win), ['bin/a.cmd', 'core/a.ts', 'platform/anc-platform.mjs']);
  // src 覆盖判定不受平台影响：darwin-only 映射也算「有部署目标」
  assert.deepEqual(win.uncovered, []);
  assert.deepEqual(win.errors, []);

  // macOS：多出 .sh（拍平到 bin）与 darwin-only 映射（保留目录结构）
  assert.deepEqual(mac.skipped, []);
  assert.deepEqual(rels(mac), ['bin/a.cmd', 'bin/anc-launch.sh', 'core/a.ts', 'maconly/x.ts', 'platform/anc-platform.mjs']);

  // 平台层模块不能拍平：<root>/platform/anc-platform.mjs，否则 bin 里的 '../platform/...' 断链
  assert.equal(mac.files.find((f) => f.rel === 'platform/anc-platform.mjs').dst, join(ctx.root, 'platform', 'anc-platform.mjs'));
  // 启动器按文件名落 bin（Flatten）
  assert.equal(mac.files.find((f) => f.rel === 'bin/anc-launch.sh').dst, join(ctx.root, 'bin', 'anc-launch.sh'));
});

test('平台过滤：dry-run 逐条打印 skip 原因，--apply 只铺当前平台的项', (t) => {
  const ctx = platformFixture(t);
  const dry = deploy(ctx, ['--platform', 'win32']);
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /skip: platforms=darwin {2}bin\/anc-launch\.sh/);
  assert.match(dry.stdout, /skip: platforms=darwin {2}maconly\/x\.ts/);
  assert.equal(existsSync(ctx.root), false);

  const win = deploy(ctx, ['--platform', 'win32', '--apply']);
  assert.equal(win.status, 0, win.stderr);
  assert.ok(existsSync(deployedPath(ctx, 'platform/anc-platform.mjs')));
  assert.equal(existsSync(deployedPath(ctx, 'bin/anc-launch.sh')), false, 'Windows 不铺 .sh 启动器');
  assert.equal(existsSync(deployedPath(ctx, 'maconly/x.ts')), false);
});

test('平台过滤：mac 落 .sh 启动器并保留可执行位', (t) => {
  const ctx = platformFixture(t);
  const mac = deploy(ctx, ['--platform', 'darwin', '--apply']);
  assert.equal(mac.status, 0, mac.stderr);
  const sh = deployedPath(ctx, 'bin/anc-launch.sh');
  assert.ok(existsSync(sh));
  // launchd 会直接 exec 这个路径：丢了 +x 就是「任务注册成功但从不触发」
  assert.ok((statSync(sh).mode & 0o111) !== 0, '<root>/bin/*.sh 必须可执行');
  assert.ok(existsSync(deployedPath(ctx, 'maconly/x.ts')));
});

test('平台参数/清单写错时给可照做的报错（退出码 2）', (t) => {
  const ctx = platformFixture(t);
  const bad = deploy(ctx, ['--platform', 'solaris']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /platform 只认 win32 \/ darwin \/ linux/);

  const broken = structuredClone(PLATFORM_MANIFEST);
  broken.binScripts[1].Platforms = ['ios'];
  broken.map.find((m) => m.Target === 'bin').Only[1].Platforms = ['ios'];
  writeFileSync(ctx.manifestPath, JSON.stringify(broken, null, 2), 'utf8');
  const r = deploy(ctx, ['--platform', 'darwin', '--apply']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Platforms 值不认识: ios/);
  assert.equal(existsSync(ctx.root), false);
});

// ── 失败回滚 ──────────────────────────────────────────────
test('hash 对拍失败：整体回滚到部署前内容，退出码 1', (t) => {
  const ctx = fixture(t);
  assert.equal(deploy(ctx, ['--apply']).status, 0);
  assert.equal(readFileSync(deployedPath(ctx, 'core/a.ts'), 'utf8'), V1);

  // 源改成 v2 并让校验阶段失败：回滚必须回到 v1（部署前的内容），不是 v2
  writeFileSync(join(ctx.repo, 'src/core/a.ts'), 'export const a = 2;\n', 'utf8');
  const r = deploy(ctx, ['--apply', '--json'], { env: { ANC_DEPLOY_FAULT: 'verify' } });
  assert.equal(r.status, 1, '对拍失败 = 1（与 ps1 一致）');
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.code, 1);
  assert.equal(out.rolledBack, true);
  assert.match(out.error, /校验失败/);
  assert.equal(readFileSync(deployedPath(ctx, 'core/a.ts'), 'utf8'), V1, '回滚要回到部署前内容');
});

test('复制失败：已写入的文件全部回滚，退出码 3', (t) => {
  const ctx = fixture(t);
  const r = deploy(ctx, ['--apply'], { env: { ANC_DEPLOY_FAULT: 'copy' } });
  assert.equal(r.status, 3, '复制失败 = 3（与 ps1 一致）');
  assert.match(r.stdout, /复制失败/);
  assert.match(r.stdout, /已回滚 2 个已写入文件/);
  assert.equal(existsSync(deployedPath(ctx, 'core/a.ts')), false, '回滚后不该留下半套文件');
  assert.equal(existsSync(deployedPath(ctx, 'bin/a.cmd')), false);
});

test('坏清单/覆盖缺口：退出码 2，且报错带「怎么修」', (t) => {
  const ctx = fixture(t);

  // 清单声明了不存在的脚本
  const brokenScripts = [...MANIFEST.binScripts, 'launch/missing.cmd'];
  writeFileSync(ctx.manifestPath, JSON.stringify({
    ...MANIFEST,
    binScripts: brokenScripts,
    map: MANIFEST.map.map((m) => (m.Target === 'bin' ? { ...m, Only: brokenScripts } : m)),
  }), 'utf8');
  let r = deploy(ctx, ['--apply']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /不存在的脚本: bin\/launch\/missing\.cmd/);
  assert.match(r.stderr, /FIX/);

  // src 下去了一个没人管的 .ts（历史上 deploy 成功但线上 import 崩）
  writeFileSync(ctx.manifestPath, JSON.stringify(MANIFEST), 'utf8');
  write(join(ctx.repo, 'src/extra/thing.ts'), 'export const x = 1;\n');
  r = deploy(ctx, ['--apply']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /没有部署目标: src\/extra\/thing\.ts/);
  assert.equal(existsSync(ctx.root), false, '环境错误不该落盘');
});

// ── 回滚 ──────────────────────────────────────────────────
test('--rollback：备份里有的还原、备份里没有的删掉', (t) => {
  const ctx = fixture(t);
  write(join(ctx.root, 'core/a.ts'), 'OLD\n'); // 部署前就存在的线上文件
  assert.equal(deploy(ctx, ['--apply']).status, 0);
  assert.notEqual(readFileSync(deployedPath(ctx, 'core/a.ts'), 'utf8'), 'OLD\n');

  writeFileSync(deployedPath(ctx, 'core/a.ts'), 'MANUAL\n', 'utf8'); // 有人手改了线上
  const r = deploy(ctx, ['--rollback', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.mode, 'rollback');
  assert.equal(out.restored, 1);
  assert.equal(out.removed, PLAN_RELS.length - 1);
  assert.equal(readFileSync(deployedPath(ctx, 'core/a.ts'), 'utf8'), 'OLD\n', '部署前的线上内容要回来');
  assert.equal(existsSync(deployedPath(ctx, 'bin/a.cmd')), false, '本次新增的文件要删掉');
});

test('--rollback：首次部署没有备份 → 按当前清单删干净（回到没装）', (t) => {
  const ctx = fixture(t);
  assert.equal(deploy(ctx, ['--apply']).status, 0);
  rmSync(join(ctx.root, 'backup'), { recursive: true, force: true });
  const r = deploy(ctx, ['--rollback']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /首次部署/);
  assert.match(r.stdout, new RegExp('删除 ' + PLAN_RELS.length + ' 个文件'));
  assert.equal(existsSync(deployedPath(ctx, 'core/a.ts')), false);
  assert.equal(existsSync(deployedPath(ctx, 'bin/tick.ps1')), false);
});

// ── 真实仓库：清单与 ps1 逐项一致 ─────────────────────────
test('真实仓库：manifest 投影到 Windows 后与 deploy.ps1 逐项一致', () => {
  const ps1 = parsePs1Deploy(readFileSync(join(REPO, 'scripts/deploy/deploy.ps1'), 'utf8'));
  const manifest = loadManifest(DEFAULT_MANIFEST);

  assert.deepEqual(compareManifestToPs1(manifest, ps1), []);

  // 白名单：Windows 投影必须逐项等于 ps1（顺序也一致）；darwin-only 项 ps1 里没有
  assert.deepEqual(projectWhiteList(manifest.binScripts, 'win32'), ps1.binScripts);
  assert.deepEqual(projectWhiteList(manifest.toolScripts, 'win32'), ps1.toolScripts);
  assert.deepEqual(manifest.notDeployed, ps1.notDeployed);
  assert.deepEqual(ps1.notDeployed, ['verify/t3-webhook.ps1']);

  // 映射：Windows 投影逐条等于 ps1
  const winMap = manifest.map.map(normalizeMapEntry).filter((m) => platformAllows(m.Platforms, 'win32'));
  assert.equal(winMap.length, ps1.map.length);
  assert.deepEqual(winMap.map((m) => m.Target), ps1.map.map((m) => String(m.Target).replace(/\\/g, '/')));

  // 清单里每个路径都必须是正斜杠（Windows/macOS 同一套写法）
  for (const m of manifest.map) {
    for (const v of [m.Target, m.Source, ...(m.Filter ?? []), ...(m.Exclude ?? [])]) {
      assert.equal(String(v).includes('\\'), false, '清单路径必须正斜杠: ' + v);
    }
    for (const item of m.Only ?? []) assert.equal(String(item.Path).includes('\\'), false);
  }
  for (const item of [...manifest.binScripts, ...manifest.toolScripts]) {
    assert.equal(item.Path.includes('\\'), false, '白名单路径必须正斜杠: ' + item.Path);
  }
});

test('真实仓库：两个平台的计划与清单推导值一致，darwin 只多不少', () => {
  const manifest = loadManifest(DEFAULT_MANIFEST);
  const win = buildPlan({ repo: REPO, manifest, platform: 'win32' });
  const mac = buildPlan({ repo: REPO, manifest, platform: 'darwin' });

  for (const plan of [win, mac]) {
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(plan.missingDeclared, []);
    assert.deepEqual(plan.uncovered, []);
    assert.ok(plan.files.length > 100, '计划文件数应该上百（实测：' + plan.files.length + '）');
  }

  // 每个 target 的文件数 = 该平台白名单/源目录推导出来的数（不写死总数）
  const counted = (plan, target) => plan.files.filter((f) => f.target === target).length;
  assert.equal(counted(win, 'bin'), projectWhiteList(manifest.binScripts, 'win32').length);
  assert.equal(counted(mac, 'bin'), projectWhiteList(manifest.binScripts, 'darwin').length);
  assert.equal(counted(win, 'tools'), projectWhiteList(manifest.toolScripts, 'win32').length);
  assert.equal(counted(mac, 'tools'), projectWhiteList(manifest.toolScripts, 'darwin').length);

  // darwin 多出来的正好是 darwin-only 项，且全都是落 bin 的启动器
  const darwinOnly = manifest.binScripts.filter((i) => !platformAllows(i.Platforms, 'win32'));
  assert.ok(darwinOnly.length > 0, 'mac 侧启动器应该在清单里');
  assert.equal(mac.files.length - win.files.length, darwinOnly.length);
  assert.deepEqual(mac.skipped, []);
  assert.deepEqual(win.skipped.map((s) => s.rel).sort(), darwinOnly.map((i) => 'bin/' + i.Path.split('/').pop()).sort());

  // 平台层模块两边都在、都不拍平（<root>/platform/anc-platform.mjs 是 .mjs 的 import 目标）
  for (const plan of [win, mac]) {
    assert.ok(plan.files.some((f) => f.rel === 'platform/anc-platform.mjs'));
  }
  // 模块子目录必须保留结构（拍平会让相对 import 断链）
  assert.ok(win.files.some((f) => f.rel === 'modules/knowledge/ingest/apply.ts'));
});

// ── 跨层对拍能抓到漂移 ────────────────────────────────────
test('src 侧路径漂了必须报出来（负向用例）', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'anc-parity-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, '.git'), { recursive: true });
  write(join(base, 'src/core/paths.ts'), [
    "import { join } from 'node:path';",
    'export function sideRoot(side: string, opts: any = {}): string { return join("/wrong", side); }',
    'export function defaultVaultRoot(side: string, opts: any = {}): string { return "/wrong/vault"; }',
    'export function ancPaths(root: string) { return { root, data: join(root, "data") }; }',
    '',
  ].join('\n'));
  const failures = checkSrcParity(base);
  assert.ok(failures.some((f) => /sideRoot 漂了/.test(f)), '要报 sideRoot 漂移：' + failures.join(' | '));
  assert.ok(failures.some((f) => /defaultVaultRoot 漂了/.test(f)));
  assert.ok(failures.some((f) => /ancPaths 只在 ops 里/.test(f)));
});

test('src 侧文件不存在时给出人能照着修的报错', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'anc-parity-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, '.git'), { recursive: true });
  const failures = checkSrcParity(base);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /src\/core\/paths\.ts 不存在/);
});
