// launchd 调度器与 darwin 启动器的测试。
//
// 重点不是"函数跑通"，而是四个装错了很难发现的地方：
//   1. **dry-run 真的不落盘** —— 默认动作是预演，一旦预演就写 plist，部署者会对 /Library 失去信任；
//   2. **幂等** —— 内容相同不重写、已加载不重复 bootstrap（重复 bootstrap 会在日志里刷 already loaded，
//      人就会开始忽略日志）；
//   3. **bootstrap 失败要回退 load -w** —— 新系统上 bootstrap 对"刚覆盖的 plist"经常报 5: I/O error；
//   4. **plist 里绝不能有凭据** —— plist 全局可读，token/webhook 混进去等于泄密。
//
// 全部用注入的 launchctl runner，**不真跑 launchctl**、不写 /Library（临时目录 + 显式 --launchd-dir）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { OS } from './anc-platform.mjs';
import {
  apply, status, uninstall,
  buildPlan, plistEnv, assertSafeEnv, listPlistFiles, domainOf, domainForDir,
  formatStatus, formatApply, formatUninstall, windowsForward,
  EXIT,
} from '../deploy/scheduler.mjs';

const HERE = import.meta.dirname;
const REPO = resolve(HERE, '..', '..');
const WB = { found: true, exec: '/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy' };

/** 临时工作区：root / plist 目录 / 日志目录都在里面，跑完删掉。 */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'anc-sched-'));
  return {
    dir,
    root: join(dir, 'root'),
    plists: join(dir, 'LaunchDaemons'),
    userPlists: join(dir, 'LaunchAgents'),
    logs: join(dir, 'Logs'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** 假 launchctl：维护"已加载"集合，记录每次调用；fail 可让 bootstrap/load 失败。 */
function makeRunner(init = {}) {
  const loaded = new Set(init.loaded ?? []);
  const log = [];
  const run = (program, args) => {
    log.push([program, ...args].join(' '));
    if (program !== 'launchctl') return { code: 0, stdout: '', stderr: '' };
    const sub = args[0];
    if (sub === 'print') {
      const label = String(args[1] ?? '').split('/').pop();
      return loaded.has(label)
        ? { code: 0, stdout: 'loaded', stderr: '' }
        : { code: 113, stdout: '', stderr: 'Could not find service' };
    }
    if (sub === 'bootstrap') {
      if (init.failBootstrap) return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
      loaded.add(String(args[2] ?? '').split('/').pop().replace(/\.plist$/, ''));
      return { code: 0, stdout: '', stderr: '' };
    }
    if (sub === 'load') {
      if (init.failLoad) return { code: 1, stdout: '', stderr: 'Load failed: 5: Input/output error' };
      loaded.add(String(args[2] ?? '').split('/').pop().replace(/\.plist$/, ''));
      return { code: 0, stdout: '', stderr: '' };
    }
    if (sub === 'bootout') {
      loaded.delete(String(args[1] ?? '').split('/').pop());
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  run.log = log;
  run.loaded = loaded;
  return run;
}

function baseOpts(ws, extra = {}) {
  return {
    os: OS.MAC,
    side: 'company',
    root: join(ws.dir, 'root'),
    plistDir: ws.plists,
    logDir: ws.logs,
    workbuddy: WB,
    uid: 501,
    nodeExe: '/usr/local/bin/node',
    nodeVersion: 'v22.14.0',
    run: makeRunner(),
    ...extra,
  };
}

const readPlists = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.plist')) : []);

// ── 计划与环境 ────────────────────────────────────────────────────────────

test('计划：公司侧 mac 展开成 10 个 plist，文件名就是 launchd 标签', () => {
  const ws = workspace();
  try {
    const plan = buildPlan(baseOpts(ws));
    assert.equal(plan.side, 'company');
    assert.equal(plan.tasks.length, 10, '10 个可移植任务（14 − patch-guard/elevate/update-watch/devbot）');
    for (const t of plan.tasks) {
      assert.equal(t.file, join(ws.plists, t.label + '.plist'));
      assert.ok(t.label.startsWith('local.anc.'), '标签必须是反 DNS: ' + t.label);
      assert.match(t.content, /<key>Label<\/key>\s*<string>local\.anc\./);
      assert.ok(t.content.trimEnd().endsWith('</plist>'));
    }
    // 公司侧没有提权通道（root daemon 本身就是 root）
    assert.ok(!plan.tasks.some((t) => t.name === 'anc-elevate'));
    assert.ok(plan.unsupported.length === 4);
    assert.ok(plan.unsupported.every((u) => u.reason && u.reason.length > 10), '不注册的任务必须写原因');
  } finally {
    ws.cleanup();
  }
});

test('环境变量：只有 ANC_SIDE / ANC_ROOT / PATH，需要时才有 NODE_OPTIONS，且不许带密钥', () => {
  const ws = workspace();
  try {
    const plan = buildPlan(baseOpts(ws));
    const svc = plan.tasks.find((t) => t.name === 'anc-service');
    assert.deepEqual(Object.keys(svc.env).sort(), ['ANC_ROOT', 'ANC_SIDE', 'NODE_OPTIONS', 'PATH']);
    assert.equal(svc.env.ANC_SIDE, 'company');
    assert.equal(svc.env.ANC_ROOT, join(ws.dir, 'root'));
    assert.equal(svc.env.NODE_OPTIONS, '--experimental-strip-types', 'Node 22 跑 .ts CLI 要这个开关');
    assert.equal(svc.env.PATH.split(':')[0], '/usr/local/bin', 'PATH 第一项必须是 node 所在目录');

    // sh 任务不塞无关开关
    const cleanup = plan.tasks.find((t) => t.name === 'anc-cleanup');
    assert.equal(cleanup.env.NODE_OPTIONS, undefined);

    // Node 23+ 默认支持类型剥离，不该再加 flag
    const modern = plistEnv({ name: 'anc-service' }, {
      side: 'company', root: '/x', nodeExe: '/usr/local/bin/node', nodeVersion: 'v23.1.0',
      command: { program: '/usr/local/bin/node', args: ['/x/service/cli.ts'] },
    });
    assert.equal(modern.NODE_OPTIONS, undefined);

    // 护栏：白名单外、像密钥、带 URL 的一律拒绝
    assert.throws(() => assertSafeEnv({ ANC_TOKEN: 'x' }), /越界|密钥/);
    assert.throws(() => assertSafeEnv({ PATH: 'https://qyapi.weixin.qq.com/x' }), /webhook|URL/);

    // 落盘的 plist 全文也不许出现凭据
    for (const t of plan.tasks) {
      assert.ok(!/(token|secret|webhook|qyapi|corpsecret)/i.test(t.content), 'plist 里不能有凭据: ' + t.name);
    }
  } finally {
    ws.cleanup();
  }
});

// ── dry-run / apply / 幂等 ────────────────────────────────────────────────

test('status：列出应注册/已注册/缺，退出码 0，不落盘', () => {
  const ws = workspace();
  try {
    const res = status(baseOpts(ws));
    assert.equal(res.ok, true);
    assert.equal(res.planned.length, 10);
    assert.equal(res.missing.length, 10);
    assert.deepEqual(res.present, []);
    assert.equal(existsSync(ws.plists), false, 'status 不许创建 plist 目录');
    const text = formatStatus(res);
    assert.match(text, /launchd 调度/);
    assert.match(text, /\[缺\]/);
    assert.match(text, /本平台不注册的任务/);
  } finally {
    ws.cleanup();
  }
});

test('apply 默认 dry-run：只打印将写什么，一个文件都不写', () => {
  const ws = workspace();
  try {
    const res = apply(baseOpts(ws)); // 没传 apply
    assert.equal(res.dryRun, true);
    assert.deepEqual(res.written, []);
    assert.equal(readPlists(ws.plists).length, 0);
    assert.equal(existsSync(ws.plists), false);
    const planned = res.actions.filter((a) => a.state === 'would-write');
    assert.equal(planned.length, 10);

    // --apply + --dry-run 也是预演（dry-run 赢）
    const res2 = apply(baseOpts(ws, { apply: true, dryRun: true }));
    assert.equal(res2.dryRun, true);
    assert.equal(readPlists(ws.plists).length, 0);

    const text = formatApply(res);
    assert.match(text, /预演/);
    assert.match(text, /NEXT.*--apply/);
  } finally {
    ws.cleanup();
  }
});

test('apply --apply：写 10 个 plist 并 bootstrap，属主范围外的文件不碰', () => {
  const ws = workspace();
  try {
    const run = makeRunner();
    const res = apply(baseOpts(ws, { apply: true, run }));
    assert.equal(res.ok, true, JSON.stringify(res.failed));
    assert.equal(res.written.length, 10);
    assert.equal(readPlists(ws.plists).length, 10);
    assert.equal(existsSync(ws.logs), true, '日志目录要建出来（plist 的 StandardOutPath 指着它）');

    // 每个标签 bootstrap 一次，域是 system（公司侧）
    // 域按 plist 目录算：临时目录 → gui/<uid>；只有 /Library/LaunchDaemons 才是 system
    const bootstraps = run.log.filter((l) => l.includes('bootstrap gui/501 '));
    assert.equal(bootstraps.length, 10);
    assert.ok(bootstraps.every((l) => l.endsWith('.plist')));
    assert.equal(domainOf('company', 501), 'system');
    assert.equal(domainOf('employee', 501), 'gui/501');
    assert.equal(domainForDir('/Library/LaunchDaemons', 'company', 501), 'system');
    assert.equal(domainForDir(ws.plists, 'company', 501), 'gui/501', '覆盖目录时域按目录算，不按 side');

    const svc = readFileSync(join(ws.plists, 'local.anc.anc-service.plist'), 'utf8');
    assert.match(svc, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
    // 心跳契约：anc-service 的 stdout 必须是 <root>/data/loop.log（health/watchdog 按它判活），
    // 其余任务仍写 <logDir>/<task>.log。2026-11-16 真机验收发现缺这一条时 /__anc_health 恒 ok:false。
    assert.match(svc, new RegExp('<string>' + join(ws.dir, 'root').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/data/loop\\.log</string>'));
    const httpPlist = readFileSync(join(ws.plists, 'local.anc.anc-http.plist'), 'utf8');
    assert.match(httpPlist, new RegExp(ws.logs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/anc-http\\.log'));
  } finally {
    ws.cleanup();
  }
});

test('幂等：第二次 apply 不重写、重复 bootstrap 也不再发', () => {
  const ws = workspace();
  try {
    const run = makeRunner();
    const first = apply(baseOpts(ws, { apply: true, run }));
    assert.equal(first.ok, true);
    const before = readPlists(ws.plists).map((f) => ({ f, m: statSync(join(ws.plists, f)).mtimeMs }));
    const bootstrapsAfterFirst = run.log.filter((l) => l.includes('launchctl bootstrap')).length;
    assert.equal(bootstrapsAfterFirst, 10);

    const second = apply(baseOpts(ws, { apply: true, run }));
    assert.equal(second.ok, true);
    assert.deepEqual(second.written, [], '内容相同不许重写');
    assert.equal(second.unchanged.length, 10);
    assert.equal(run.log.filter((l) => l.includes('launchctl bootstrap')).length, bootstrapsAfterFirst, '已加载不许重复 bootstrap');
    assert.equal(second.actions.filter((a) => a.state === 'unchanged+loaded').length, 10);

    const after = readPlists(ws.plists).map((f) => ({ f, m: statSync(join(ws.plists, f)).mtimeMs }));
    assert.deepEqual(after, before, 'mtime 不变 = 真的没重写');
  } finally {
    ws.cleanup();
  }
});

test('内容漂移：已加载的旧 job 先 bootout 再 bootstrap，新内容生效', () => {
  const ws = workspace();
  try {
    const run = makeRunner();
    apply(baseOpts(ws, { apply: true, run }));
    const file = join(ws.plists, 'local.anc.anc-watchdog.plist');
    writeFileSync(file, readFileSync(file, 'utf8').replace('watchdog', 'watchdog-hand-edited'), 'utf8');
    run.log.length = 0;

    const res = apply(baseOpts(ws, { apply: true, run }));
    assert.equal(res.ok, true);
    assert.deepEqual(res.written, ['anc-watchdog']);
    const seq = run.log.filter((l) => /bootout|bootstrap/.test(l) && l.includes('anc-watchdog'));
    assert.ok(seq[0].includes('bootout'), '先卸旧 job: ' + seq.join(' | '));
    assert.ok(seq.some((l) => l.includes('bootstrap')), '再装新内容');
    assert.match(readFileSync(file, 'utf8'), /<string>local\.anc\.anc-watchdog<\/string>/, '内容被重写回正确版本');
  } finally {
    ws.cleanup();
  }
});

test('bootstrap 失败回退 launchctl load -w；两条都失败才算失败', () => {
  const ws = workspace();
  try {
    // bootstrap 报 5: I/O error，load -w 成功
    const fallback = makeRunner({ failBootstrap: true });
    const r1 = apply(baseOpts(ws, { apply: true, run: fallback }));
    assert.equal(r1.ok, true, '必须回退成功');
    assert.ok(fallback.log.some((l) => l.startsWith('launchctl load -w ') && l.endsWith('anc-service.plist')));
    assert.ok(r1.actions.some((a) => a.detail.includes('load')), '报告里要说明走的是回退路径');

    // 两条路都断：如实报失败，不要把失败写成成功
    const ws2 = workspace();
    try {
      const dead = makeRunner({ failBootstrap: true, failLoad: true });
      const r2 = apply(baseOpts(ws2, { apply: true, run: dead }));
      assert.equal(r2.ok, false);
      assert.equal(r2.failed.length, 10);
      assert.match(formatApply(r2), /FAIL/);
    } finally {
      ws2.cleanup();
    }
  } finally {
    ws.cleanup();
  }
});

// ── 卸载 ──────────────────────────────────────────────────────────────────

test('uninstall：bootout 后删 plist，连带清掉计划外的 local.anc.* 残留', () => {
  const ws = workspace();
  try {
    const run = makeRunner();
    apply(baseOpts(ws, { apply: true, run }));
    // 旧版本残留：不在当前计划里，仍属于本项目命名空间
    writeFileSync(join(ws.plists, 'local.anc.ghost.plist'), '<plist/>', 'utf8');
    // 别人的 daemon：绝不能碰
    writeFileSync(join(ws.plists, 'com.example.other.plist'), '<plist/>', 'utf8');

    const dry = uninstall(baseOpts(ws, { run }));
    assert.equal(dry.dryRun, true);
    assert.equal(readPlists(ws.plists).length, 12, 'dry-run 不删（10 计划 + 1 残留 + 1 别人的）');
    assert.match(formatUninstall(dry), /将删/);

    run.log.length = 0;
    const res = uninstall(baseOpts(ws, { apply: true, run }));
    assert.equal(res.ok, true);
    assert.equal(res.removed.length, 11);
    assert.deepEqual(readPlists(ws.plists), ['com.example.other.plist'], '只认领 local.anc.*');
    assert.equal(run.log.filter((l) => l.startsWith('launchctl bootout ')).length, 11, '先卸再删');
  } finally {
    ws.cleanup();
  }
});

// ── 平台分支 ──────────────────────────────────────────────────────────────

test('Windows：只打印转调命令，--apply 才 spawn register-tasks.ps1', () => {
  const ws = workspace();
  try {
    const run = makeRunner();
    const res = windowsForward({ os: OS.WIN, mode: 'apply', side: 'company', root: 'C:\\ProgramData\\anc', repo: REPO, run });
    assert.equal(res.ran, false, '默认不许真跑');
    assert.equal(run.log.length, 0);
    assert.match(res.cmdline, /register-tasks\.ps1/);
    assert.ok(!res.cmdline.includes('-Apply'));
    assert.match(res.note, /ps1/);
    assert.match(formatApply(res), /Windows 侧仍由 ps1 负责/);

    const res2 = windowsForward({ os: OS.WIN, mode: 'apply', side: 'company', root: 'C:\\ProgramData\\anc', repo: REPO, apply: true, run });
    assert.equal(res2.ran, true);
    assert.equal(run.log.length, 1);
    assert.match(run.log[0], /^powershell .*register-tasks\.ps1 .*-Apply$/);
  } finally {
    ws.cleanup();
  }
});

test('linux：明确报不支持，不假装有调度器', () => {
  const ws = workspace();
  try {
    const res = status({ os: 'linux', side: 'company', root: join(ws.dir, 'root'), run: makeRunner() });
    assert.equal(res.ok, false);
    assert.equal(res.unsupported, true);
    assert.match(res.error, /launchd/);
    assert.equal(existsSync(join(ws.dir, 'root')), false);
  } finally {
    ws.cleanup();
  }
});

test('公司侧非 root 写系统目录：返回 needsRoot + sudo 提示，不写盘', () => {
  const res = apply({ os: OS.MAC, side: 'company', apply: true, uid: 501, run: makeRunner(), workbuddy: WB });
  assert.equal(res.ok, false);
  assert.equal(res.needsRoot, true);
  assert.match(res.fix, /sudo/);
  assert.equal(res.dir, '/Library/LaunchDaemons');
});

// ── darwin 启动器薄壳 ─────────────────────────────────────────────────────

test('darwin 启动器：/bin/sh + set -eu + 可执行 + 语法正确 + root 参数化', () => {
  const dir = join(REPO, 'scripts', 'platform', 'darwin');
  const want = ['anc-launch.sh', 'cleanup-media.sh', 'watchdog.sh', 'boot-alert.sh'];
  for (const name of want) {
    const p = join(dir, name);
    assert.ok(existsSync(p), '缺启动器: ' + name);
    const text = readFileSync(p, 'utf8');
    assert.ok(text.startsWith('#!/bin/sh\n'), name + ' 必须是 POSIX sh（launchd 不保证 bash）');
    assert.match(text, /\nset -eu\n/, name + ' 要 set -eu');
    assert.match(text, /\/Library\/Application Support\/anc/, name + ' 默认 root 要写清楚');
    assert.match(text, /ANC_ROOT/, name + ' 要能被 ANC_ROOT 覆盖');
    assert.ok(!/curl.*\$\{?URL\}?.*token/i.test(text));
    // 语法检查：不真跑，只让 sh 解析
    const r = spawnSync('/bin/sh', ['-n', p], { encoding: 'utf8' });
    assert.equal(r.status, 0, name + ' 语法错: ' + r.stderr);
    // 可执行位（部署后 launchd 直接 exec 它）
    assert.ok((statSync(p).mode & 0o111) !== 0, name + ' 要有可执行位');
  }

  // 2026-11-16 真机验收后改：启动器不再自己拼 NODE_OPTIONS / 主程序路径。
  // 实测本机 WorkBuddy 5.9.3 包内可执行文件叫 `Electron`（不是 WorkBuddy），写死路径必然找不到；
  // 且 Electron 打包应用会丢弃 NODE_OPTIONS（--require 这条路在 .ps1 的实测结论里也是无效的）。
  // 现在启动器只做三件事：找 node、传 <root>、把活交给 patch/launch-patched.mjs（--inspect-brk + inject.cjs）。
  const launch = readFileSync(join(dir, 'anc-launch.sh'), 'utf8');
  assert.match(launch, /launch-patched\.mjs/, '补丁启动逻辑在 Node 启动器里');
  assert.match(launch, /ANC_WB_PATCH=1/);
  assert.ok(!/Contents\/MacOS\/WorkBuddy/.test(launch), '禁止写死主程序名：实测是 Contents/MacOS/Electron');
  assert.ok(!/NODE_OPTIONS="--require/.test(launch), 'NODE_OPTIONS 预载被 Electron 丢弃，不再作为主路径');

  const cleanup = readFileSync(join(dir, 'cleanup-media.sh'), 'utf8');
  assert.match(cleanup, /cleanup-media\.mjs/, '逻辑在 mjs，shell 只转调');
  assert.ok(!/rm -rf|find .* -delete/.test(cleanup), 'shell 层不许自己删文件');

  const watchdog = readFileSync(join(dir, 'watchdog.sh'), 'utf8');
  assert.match(watchdog, /watchdog\.mjs/);

  const boot = readFileSync(join(dir, 'boot-alert.sh'), 'utf8');
  assert.match(boot, /pgrep -f/);
  assert.match(boot, /secrets\/ops-webhook\.txt/, '告警地址走文件，不进 plist/env');
});

test('--system：GUI 任务落用户域（LaunchAgent），其余进 daemon 域', () => {
  // 为什么必须分开：公司侧装 LaunchDaemon 时，root daemon 拉起 WorkBuddy 会被系统拒绝，
  // 补丁的 --inspect-brk 也连不到登录会话的调试端口。2026-11-16 系统级装机确认了这条。
  const ws = workspace();
  try {
    const run = makeRunner();
    const res = apply(baseOpts(ws, { apply: true, run, system: true, userPlistDir: ws.userPlists }));
    assert.equal(res.ok, true, JSON.stringify(res.failed));

    const daemonPlists = readPlists(ws.plists).sort();
    const agentPlists = readPlists(ws.userPlists).sort();
    assert.equal(daemonPlists.length, 9, '9 个服务进 /Library/LaunchDaemons');
    assert.deepEqual(agentPlists, ['local.anc.anc-workbuddy-launch.plist'], 'GUI 任务只此一个进用户域');
    assert.ok(!daemonPlists.includes('local.anc.anc-workbuddy-launch.plist'));

    // 落点要分对：daemon 目录 vs 用户目录（真实环境里前者的域是 system，测试用临时目录 → gui/501；
    // 域按目录算的规则见 domainForDir 的单测，这里只钉"文件去了哪、按哪个文件 bootstrap"）
    assert.ok(run.log.some((l) => l.includes('bootstrap ') && l.includes('LaunchDaemons/local.anc.anc-service.plist')));
    assert.ok(run.log.some((l) => l.includes('bootstrap gui/501 ') && l.includes('LaunchAgents/local.anc.anc-workbuddy-launch.plist')));

    // status 要把两边都算进来，否则 verify 会误报「缺 anc-workbuddy-launch」
    const st = status(baseOpts(ws, { run, system: true, userPlistDir: ws.userPlists }));
    assert.deepEqual(st.missing, []);
    assert.equal(st.dir, ws.plists);
    assert.equal(st.userDir, ws.userPlists);
  } finally {
    ws.cleanup();
  }
});

// ── CLI 冒烟 ──────────────────────────────────────────────────────────────

test('CLI 冒烟：status --json 只输出 JSON 且不落盘；apply 不给 --apply 也是预演', async () => {
  const ws = workspace();
  try {
    const script = join(REPO, 'scripts', 'deploy', 'scheduler.mjs');
    const out = execFileSync(process.execPath, [
      script, 'status', '--os', 'darwin', '--side', 'company',
      '--root', join(ws.dir, 'root'), '--launchd-dir', ws.plists, '--log-dir', ws.logs, '--json',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const json = JSON.parse(out);
    assert.equal(json.os, 'darwin');
    // 计划数取决于本机是否装了 WorkBuddy（requiresWorkbuddy 的任务会被过滤），
    // 所以断言要跟着环境算，不能写死 5：这台机器装了 WorkBuddy 时是 10 个。
    const { taskPlan, probeWorkbuddy } = await import('../platform/anc-platform.mjs');
    const expected = taskPlan({ os: 'darwin', side: 'company', workbuddy: probeWorkbuddy({ os: 'darwin' }) }).length;
    assert.equal(json.planned.length, expected, '计划数必须与 taskPlan 一致（有/无 WorkBuddy 差 5 个）');
    assert.equal(existsSync(ws.plists), false);

    const out2 = execFileSync(process.execPath, [
      script, 'apply', '--os', 'darwin', '--side', 'company',
      '--root', join(ws.dir, 'root'), '--launchd-dir', ws.plists, '--log-dir', ws.logs, '--json',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const dry = JSON.parse(out2);
    assert.equal(dry.dryRun, true);
    assert.equal(existsSync(ws.plists), false, 'CLI 预演也不许写盘');
  } finally {
    ws.cleanup();
  }
});

// ── 统一入口 anc.mjs ──────────────────────────────────────────────────────
// 这一层的价值是"一条命令装完且不装错"：预演绝不落盘、记账走外部命令行、
// 公司侧缺 sudo 时明说、Windows 只转调 ps1。
//
// 部署引擎（deploy.mjs / deploy-state.mjs）是别的任务的产出，这里按 CLI 契约用**假引擎**验证：
// 断言的是"我有没有按契约调用、有没有对退出码做对处理"，不是别人的复制逻辑。
// 另有一条用例专门钉"引擎不存在时给清晰 ERROR，而不是崩在堆栈上"。

/** 临时目录里的完整上下文（root / vault / launchd / log 全部覆盖，不碰系统目录）。 */
function ancOpts(ws, extra = {}) {
  return {
    os: OS.MAC,
    side: 'company',
    repo: REPO,
    root: join(ws.dir, 'root'),
    vault: join(ws.dir, 'vault'),
    launchdDir: ws.plists,
    logDir: ws.logs,
    uid: 501,
    ...extra,
  };
}

/**
 * 假部署引擎：实现两件契约里用得到的事 ——
 *   deploy.mjs        --apply 时铺出 service/cli.ts（让 verify 有东西可查），并记录收到的 argv
 *   deploy-state.mjs  --mark <id> --as-done 累积到 <root>/data/deploy-state.json，done 退出 0 / failed 退出 1
 */
function fakeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'anc-engine-'));
  const dep = join(dir, 'scripts', 'deploy');
  mkdirSync(dep, { recursive: true });
  // 真实仓库里 scripts/platform/darwin 与 scripts/deploy 并存；假仓库也要有，否则 mac 薄壳拷不到 <root>/bin
  cpSync(join(REPO, 'scripts', 'platform', 'darwin'), join(dir, 'scripts', 'platform', 'darwin'), { recursive: true });
  const calls = join(dir, 'deploy-calls.log');
  const stateCalls = join(dir, 'state-calls.log');

  writeFileSync(join(dep, 'deploy.mjs'), `
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, argv.join(' ') + '\\n');
const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const root = get('--root');
const apply = argv.includes('--apply');
if (apply) {
  mkdirSync(join(root, 'service'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'service', 'cli.ts'), '// fake engine cli\\n');
}
process.stdout.write(JSON.stringify(apply
  ? { ok: true, mode: 'apply', total: 3, copied: 3, verified: 3 }
  : { ok: true, mode: 'dry-run', total: 3, totalBytes: 42, groups: [{ target: 'core', count: 3, bytes: 42 }], files: [{ target: 'core/x' }] }) + '\\n');
`);

  writeFileSync(join(dep, 'deploy-state.mjs'), `
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(stateCalls)}, argv.join(' ') + '\\n');
const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const root = get('--root');
const mark = get('--mark');
const asDone = argv.includes('--as-done');
const file = join(root, 'data', 'deploy-state.json');
mkdirSync(dirname(file), { recursive: true });
const st = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { done: [], failed: '' };
if (mark && asDone && !st.done.includes(mark)) st.done.push(mark);
writeFileSync(file, JSON.stringify({ side: get('--side'), done: st.done, failed: '', progress: st.done.length + '/14' }, null, 2));
process.stdout.write(JSON.stringify({ ok: true, done: st.done, failed: '', progress: st.done.length + '/14' }) + '\\n');
process.exit(asDone ? 0 : 1);
`);

  return { dir, calls, stateCalls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('anc doctor：输出人读体检（平台/node/部署根/launchd/WorkBuddy/引擎），且不落盘', async () => {
  const { doctor, formatDoctor } = await import('../deploy/anc.mjs');
  const ws = workspace();
  try {
    const res = doctor(ancOpts(ws));
    assert.equal(typeof res.ok, 'boolean');
    const names = res.checks.map((c) => c.name);
    for (const need of ['平台', 'node', '部署根', 'vault', 'WorkBuddy', 'launchd', '权限', '部署引擎', '启动器脚本']) {
      assert.ok(names.includes(need), '体检缺项: ' + need);
    }
    for (const c of res.checks) {
      assert.ok(['ok', 'warn', 'fail'].includes(c.state), '非法状态: ' + c.state);
      assert.ok(c.detail && c.detail.length > 0, '体检项必须有 detail: ' + c.name);
    }
    const text = formatDoctor(res);
    assert.match(text, /=== anc doctor/);
    assert.match(text, /部署根/);
    assert.match(text, /NEXT.*plan/);
    assert.equal(existsSync(join(ws.dir, 'root')), false, 'doctor 不许创建部署根');
    assert.equal(existsSync(ws.plists), false, 'doctor 不许创建 plist 目录');
  } finally {
    ws.cleanup();
  }
});

test('anc plan：四步都列出来，且一个文件都不写', async () => {
  const { plan, formatPlan } = await import('../deploy/anc.mjs');
  const ws = workspace();
  const engine = fakeEngine();
  try {
    const res = plan(ancOpts(ws, { repo: engine.dir }));
    assert.deepEqual(res.sections.map((s) => s.step), ['dirs', 'files', 'scheduler', 'verify']);
    assert.equal(res.sections[0].items.length, 22, 'root + vault + 15 + 5');
    const files = res.sections[1];
    assert.equal(files.ok, true, 'files 预演应成功: ' + (files.error ?? ''));
    assert.equal(files.parsed.mode, 'dry-run', '预演不许调 --apply');
    assert.equal(files.parsed.total, 3);
    assert.match(formatPlan(res), /NEXT.*--apply/);

    // 预演给引擎的 argv 不能带 --apply
    const engineCalls = readFileSync(engine.calls, 'utf8').trim();
    assert.ok(engineCalls.length > 0, '应该调用过部署引擎');
    assert.ok(!engineCalls.includes('--apply'), '预演不许带 --apply: ' + engineCalls);

    assert.equal(existsSync(join(ws.dir, 'root')), false, 'plan 不许创建部署根');
    assert.equal(existsSync(join(ws.dir, 'vault')), false, 'plan 不许创建 vault');
    assert.equal(existsSync(ws.plists), false, 'plan 不许创建 plist 目录');
  } finally {
    engine.cleanup();
    ws.cleanup();
  }
});

test('anc install：预演不落盘；--apply 走 dirs→files→scheduler→verify 并逐步记账', async () => {
  const { install } = await import('../deploy/anc.mjs');
  const ws = workspace();
  const engine = fakeEngine();
  try {
    const dry = install(ancOpts(ws, { repo: engine.dir }));
    assert.equal(dry.ok, true, JSON.stringify(dry.error));
    assert.equal(dry.apply, false);
    assert.deepEqual(dry.steps.map((s) => s.state), ['dry', 'dry', 'dry', 'dry', 'dry'], 'dirs/files/perms/scheduler/verify 五步预演');
    assert.equal(existsSync(join(ws.dir, 'root')), false, '预演不许落盘');
    assert.equal(existsSync(engine.stateCalls), false, '预演不许记账');

    const run = makeRunner();
    const res = install(ancOpts(ws, { repo: engine.dir, apply: true, run }));
    const verifyFails = (res.steps.find((s) => s.stage === 'verify')?.res?.checks ?? []).filter((c) => c.state === 'fail');
    assert.equal(res.ok, true, JSON.stringify({ err: res.error, steps: res.steps.map((s) => [s.stage, s.state, s.detail]), verifyFails }));
    assert.deepEqual(res.steps.map((s) => [s.stage, s.state]), [
      // perms 只在 root + --system 时真跑；非 root 演练时按 skip 记账（mac 的系统级属主收尾）
      ['dirs', 'ok'], ['files', 'ok'], ['perms', 'skip'], ['scheduler', 'ok'], ['verify', 'ok'],
    ]);

    // 目录 / 引擎产物 / mac 薄壳
    for (const d of ['data', 'service', 'bin', 'patch', 'secrets', 'skills']) {
      assert.ok(existsSync(join(ws.dir, 'root', d)), '缺目录: ' + d);
    }
    for (const d of ['vault-shared', 'vault-internal', 'build']) {
      assert.ok(existsSync(join(ws.dir, 'vault', d)), '缺 vault 目录: ' + d);
    }
    assert.ok(existsSync(join(ws.dir, 'root', 'service', 'cli.ts')), 'files 阶段要调引擎 --apply');
    assert.ok(existsSync(join(ws.dir, 'root', 'bin', 'anc-launch.sh')), 'mac 启动器要进 <root>/bin');
    assert.ok((statSync(join(ws.dir, 'root', 'bin', 'anc-launch.sh')).mode & 0o111) !== 0, '薄壳要可执行');
    assert.ok(readPlists(ws.plists).length > 0, 'scheduler 阶段没写 plist');
    assert.ok(run.log.some((l) => l.includes('bootstrap')), 'scheduler 阶段要 bootstrap');

    // 引擎收到的 argv 与契约一致
    const engineCalls = readFileSync(engine.calls, 'utf8');
    assert.match(engineCalls, /--root/);
    assert.match(engineCalls, /--side company/);
    assert.match(engineCalls, /--apply/);

    // 记账：公司侧 dirs/files/tasks/verify 都要 done（scheduler → tasks 是映射）
    const marked = readFileSync(engine.stateCalls, 'utf8');
    for (const id of ['dirs', 'files', 'tasks', 'verify']) {
      assert.match(marked, new RegExp('--mark ' + id + ' --as-done'), '缺记账: ' + id);
    }
    const state = JSON.parse(readFileSync(join(ws.dir, 'root', 'data', 'deploy-state.json'), 'utf8'));
    assert.deepEqual(state.done.sort(), ['dirs', 'files', 'tasks', 'verify']);

    // 幂等：重跑仍然 ok，plist 不重复 bootstrap
    const bootstraps = run.log.filter((l) => l.includes('launchctl bootstrap')).length;
    const again = install(ancOpts(ws, { repo: engine.dir, apply: true, run }));
    assert.equal(again.ok, true, JSON.stringify(again.error));
    assert.equal(run.log.filter((l) => l.includes('launchctl bootstrap')).length, bootstraps, '第二次不许重复 bootstrap');
  } finally {
    engine.cleanup();
    ws.cleanup();
  }
});

test('anc install：公司侧非 root 且落在系统目录时给 sudo 提示，而不是默默失败', async () => {
  const { install, formatInstall } = await import('../deploy/anc.mjs');
  const ws = workspace();
  const engine = fakeEngine();
  try {
    const res = install({
      os: OS.MAC, side: 'company', repo: engine.dir,
      root: join(ws.dir, 'root'), vault: join(ws.dir, 'vault'),
      uid: 501, apply: true,
    });
    assert.equal(res.ok, false);
    assert.equal(res.needsRoot, true);
    assert.match(res.fix, /sudo/);
    assert.match(formatInstall(res), /ERROR[\s\S]*sudo/);
    assert.equal(existsSync(join(ws.dir, 'root')), false, '被拦下时不许留半截目录');
    assert.equal(existsSync(engine.calls), false, '被拦下时不许调引擎');
  } finally {
    engine.cleanup();
    ws.cleanup();
  }
});

test('anc install：--from 续跑跳过已完成阶段，未知阶段给用法错误', async () => {
  const { install } = await import('../deploy/anc.mjs');
  const ws = workspace();
  const engine = fakeEngine();
  try {
    // 先完整装一遍（--from 的语义是"从哪继续"，不是在空目录上只跑后半段）
    const full = install(ancOpts(ws, { repo: engine.dir, apply: true, run: makeRunner() }));
    assert.equal(full.ok, true, JSON.stringify(full.error));

    const res = install(ancOpts(ws, { repo: engine.dir, apply: true, from: 'scheduler', run: makeRunner() }));
    assert.equal(res.ok, true, JSON.stringify(res.error));
    const states = Object.fromEntries(res.steps.map((s) => [s.stage, s.state]));
    assert.equal(states.dirs, 'skip');
    assert.equal(states.files, 'skip');
    assert.equal(states.scheduler, 'ok');
    assert.equal(states.verify, 'ok');
    // 跳过 files = 没再次调引擎
    const engineCallsBefore = readFileSync(engine.calls, 'utf8').trim().split('\n').length;
    install(ancOpts(ws, { repo: engine.dir, apply: true, from: 'scheduler', run: makeRunner() }));
    assert.equal(readFileSync(engine.calls, 'utf8').trim().split('\n').length, engineCallsBefore, '按 --from 跳过 files 时不许再调引擎');

    // tasks（deploy-state 的阶段名）也认，映射回 scheduler
    const aliased = install(ancOpts(ws, { repo: engine.dir, apply: true, from: 'tasks', run: makeRunner() }));
    assert.equal(aliased.ok, true);
    assert.equal(aliased.steps.find((s) => s.stage === 'scheduler').state, 'ok');

    const bad = install(ancOpts(ws, { repo: engine.dir, apply: true, from: 'nope' }));
    assert.equal(bad.ok, false);
    assert.equal(bad.usage, true);
    assert.match(bad.fix, /dirs, files, perms, scheduler, verify/);
  } finally {
    engine.cleanup();
    ws.cleanup();
  }
});

test('anc 引擎缺失：给"先完成部署引擎"的 ERROR，不崩在堆栈上', async () => {
  const { plan, install } = await import('../deploy/anc.mjs');
  const ws = workspace();
  const emptyRepo = mkdtempSync(join(tmpdir(), 'anc-norepo-'));
  try {
    const p = plan(ancOpts(ws, { repo: emptyRepo }));
    const files = p.sections.find((s) => s.step === 'files');
    assert.equal(files.missing, true);
    assert.match(files.error, /先完成部署引擎/);
    assert.equal(p.ok, false, 'plan 要如实报"引擎没到位"，不能假装成功');
    assert.equal(existsSync(join(ws.dir, 'root')), false, '失败路径也不许落盘');

    const res = install(ancOpts(ws, { repo: emptyRepo, apply: true, run: makeRunner() }));
    assert.equal(res.ok, false);
    assert.equal(res.failedStage, 'files');
    assert.match(res.error, /先完成部署引擎/);
    assert.match(res.fix, /--from files/);
    // 引擎不存在时记账也跳过，不能因此把安装结果判成成功
    const fileStep = res.steps.find((s) => s.stage === 'files');
    assert.equal(fileStep.mark.skipped, true);
  } finally {
    rmSync(emptyRepo, { recursive: true, force: true });
    ws.cleanup();
  }
});

test('anc verify / Windows 分支：自检报 ok，Windows 只打印 install-company.ps1', async () => {
  const { install, collectVerify, formatInstall } = await import('../deploy/anc.mjs');
  const ws = workspace();
  const engine = fakeEngine();
  try {
    install(ancOpts(ws, { repo: engine.dir, apply: true, run: makeRunner() }));
    const v = collectVerify({
      ...ancOpts(ws, { repo: engine.dir }),
      plistDir: ws.plists,
      logDir: ws.logs,
      apply: false,
    });
    assert.equal(v.ok, true, '装完后自检应通过: ' + JSON.stringify(v.checks.filter((c) => c.state === 'fail')));
    assert.ok(v.checks.some((c) => c.name === 'plist 齐全' && c.state === 'ok'));
    assert.ok(v.checks.some((c) => c.name === 'deploy-state'));

    const win = install({ os: OS.WIN, side: 'company', repo: REPO, root: 'C:\\ProgramData\\anc', vault: 'D:\\anc', apply: true });
    assert.equal(win.ok, true);
    assert.match(win.forwarded, /install-company\.ps1/);
    assert.match(win.forwarded, /-Apply/);
    assert.match(win.note, /ps1/);
    assert.match(formatInstall(win), /转调/);
    assert.equal(existsSync(join(process.cwd(), 'C:\\ProgramData\\anc')), false, 'Windows 分支不许在本机落盘');
  } finally {
    engine.cleanup();
    ws.cleanup();
  }
});

test('anc install 员工侧：没有 dirs/tasks 阶段的记账就跳过，不硬塞相邻阶段', async () => {
  const { install } = await import('../deploy/anc.mjs');
  const ws = workspace();
  const engine = fakeEngine();
  try {
    const res = install(ancOpts(ws, {
      repo: engine.dir, side: 'employee', apply: true, run: makeRunner(),
      // 员工侧 vault 默认是 ~/anc；这里必须指到临时目录，绝不碰家目录
      vault: join(ws.dir, 'vault'),
    }));
    assert.equal(res.ok, true, JSON.stringify(res.error));
    const marks = Object.fromEntries(res.steps.map((s) => [s.stage, s.mark]));
    assert.equal(marks.dirs.skipped, true, '员工侧没有 dirs 阶段，不能硬记账');
    assert.match(marks.dirs.why, /没有对应阶段/);
    assert.equal(marks.files.skipped, false);
    assert.equal(marks.scheduler.skipped, true, '员工侧没有 tasks 阶段');
    assert.equal(marks.verify.skipped, false);
    const state = JSON.parse(readFileSync(join(ws.dir, 'root', 'data', 'deploy-state.json'), 'utf8'));
    assert.deepEqual(state.done.sort(), ['files', 'verify'], '只记真实存在的阶段');
  } finally {
    engine.cleanup();
    ws.cleanup();
  }
});
