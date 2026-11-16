// 补丁启动器（launch-patched.mjs）与侦察工具（inspect.mjs）的单元测试。
//
// 这些用例不启动 WorkBuddy、不碰 /Applications：全部在 mkdtemp 里用夹具跑。
// 真机验收另记在 docs/STATUS.md §3.5（2026-11-16 macOS：applied=true）。
//
// 重点覆盖四类"错了也看不出来"的地方：
//   1. mac 包内主程序名不是 WorkBuddy（实测是 Electron）——写死就会一直"找不到 WorkBuddy"；
//   2. 锚点侦察：目标文件在 / 锚点缺失 要能区分（缺锚点还照打补丁 = 静默失效）；
//   3. patch-state 判定：陈旧 runId / 陈旧时间 / applied=false 都不能算成功；
//   4. 参数错误与 preload 路径含空白要早失败，而不是带着坏配置去起进程。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  APP_ENV_DENY, buildLaunchArgs, evaluateState, inspectAnchors, openAsar, parseArgs, resolveTarget, sanitizedEnv,
  statePaths, waitForState,
} from '../workbuddy-patch/launch-patched.mjs';

function buildAsar(files) {
  const entries = {};
  const payloads = [];
  let offset = 0;
  for (const [p, content] of Object.entries(files)) {
    const parts = p.split('/');
    let node = entries;
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] = node[parts[i]] || { files: {} };
      node = node[parts[i]].files;
    }
    node[parts[parts.length - 1]] = { offset: String(offset), size: content.length };
    payloads.push(content);
    offset += content.length;
  }
  const header = JSON.stringify({ files: entries });
  const jsonLen = Buffer.byteLength(header);
  const headerSize = 8 + jsonLen;
  const base = 8 + headerSize;
  const head = Buffer.alloc(base);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(headerSize, 4);
  head.writeUInt32LE(0, 8);
  head.writeUInt32LE(jsonLen, 12);
  head.write(header, 16, 'utf8');
  return Buffer.concat([head, ...payloads]);
}

function macBundle(root) {
  const bundle = join(root, 'WorkBuddy.app');
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(join(bundle, 'Contents', 'Resources'), { recursive: true });
  // 真实机器上就是这个名字（CFBundleExecutable=Electron）
  writeFileSync(join(bundle, 'Contents', 'MacOS', 'Electron'), '');
  writeFileSync(join(bundle, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Electron</string>
<key>CFBundleShortVersionString</key><string>5.9.3</string>
</dict></plist>
`);
  writeFileSync(join(bundle, 'Contents', 'Resources', 'app.asar'), buildAsar({ 'main/wecomaibot-client.js': Buffer.from('class WecomAiBotClient { emitMessage(){} }') }));
  return bundle;
}

test('resolveTarget：mac 包内主程序是 Electron 也能定位（不写死 WorkBuddy）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-patch-'));
  try {
    const bundle = macBundle(dir);
    const t = resolveTarget({ os: 'darwin', installDir: bundle });
    assert.equal(t.exec, join(bundle, 'Contents', 'MacOS', 'Electron'));
    assert.equal(t.appAsar, join(bundle, 'Contents', 'Resources', 'app.asar'));
    assert.equal(t.infoPlist, join(bundle, 'Contents', 'Info.plist'));
    assert.deepEqual(buildLaunchArgs(9229), ['--inspect-brk=9229']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inspectAnchors：目标在/锚点缺失要能分辨，hash 与内容一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-asar-'));
  try {
    const body = 'class WecomAiBotClient { emitMessage(){} }';
    const asarPath = join(dir, 'app.asar');
    writeFileSync(asarPath, buildAsar({ 'main/wecomaibot-client.js': Buffer.from(body), 'package.json': Buffer.from('{"version":"5.9.3"}') }));

    const asar = openAsar(asarPath);
    assert.equal(asar.read('main/wecomaibot-client.js').toString(), body);
    assert.equal(asar.read('nope.js'), null);

    const mf = { target: 'main/wecomaibot-client.js', sha256: 'x', size: body.length };
    const r = inspectAnchors(asarPath, mf);
    assert.equal(r.found, true);
    assert.equal(r.anchors.emitMessage, true);
    assert.equal(r.anchors.classWecom, true);
    assert.equal(r.anchors.bootstrapStart, false, '没有升级锚点时必须报 false，而不是猜');
    assert.equal(r.sha256, createHash('sha256').update(body).digest('hex'));

    const missing = inspectAnchors(asarPath, { target: 'main/gone.js', sha256: '', size: 0 });
    assert.deepEqual([missing.found, missing.sha256], [false, null]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evaluateState：runId / 时间窗 / applied / pid 四条判据（陈旧状态不能算成功）', () => {
  const now = new Date();
  const base = { applied: true, mode: 'hash', pid: process.pid, runId: 'r1', at: now.toISOString() };

  assert.equal(evaluateState(base, { runId: 'r1', startedAtMs: now.getTime() }).ok, true);
  assert.match(evaluateState({ ...base, applied: false, miss: true }, { runId: 'r1', startedAtMs: now.getTime() }).reason, /ANCHOR-MISS/);
  assert.match(evaluateState({ ...base, runId: 'old' }, { runId: 'r1', startedAtMs: now.getTime() }).reason, /上一次启动/);
  assert.match(
    evaluateState({ ...base, at: new Date(now.getTime() - 3600_000).toISOString() }, { runId: 'r1', startedAtMs: now.getTime() }).reason,
    /陈旧/,
  );
  assert.match(evaluateState({ ...base, pid: 999999 }, { runId: 'r1', startedAtMs: now.getTime() }).reason, /已退出/);
  // 旧 preload 不写 runId：只要时间在窗口内就认
  assert.equal(evaluateState({ ...base, runId: undefined }, { runId: 'r1', startedAtMs: now.getTime() }).ok, true);
  assert.match(evaluateState(null, { runId: 'r1', startedAtMs: now.getTime() }).reason, /一直没出现/);
});

test('waitForState：状态晚到也能认出本次启动；超时给可判结论', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-wait-'));
  try {
    const paths = statePaths({ os: 'darwin', stateDir: dir });
    const started = Date.now();
    const runId = 'run-abc';
    setTimeout(() => {
      writeFileSync(paths.state, JSON.stringify({ applied: true, mode: 'hash', pid: process.pid, runId, at: new Date().toISOString() }));
    }, 60);
    const ok = await waitForState(paths, runId, started, 5, { pollMs: 20 });
    assert.equal(ok.ok, true, ok.reason);

    const timeout = await waitForState(statePaths({ os: 'darwin', stateDir: join(dir, 'nope') }), 'x', Date.now(), 1, { pollMs: 50 });
    assert.equal(timeout.ok, false);
    assert.match(timeout.reason, /一直没出现/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('带空格的部署根可用（/Library/Application Support/anc 就是这种）', () => {
  // 早期实现见空格即拒绝，导致系统级安装永远打不上补丁；NODE_OPTIONS 用引号即可
  const dir = mkdtempSync(join(tmpdir(), 'anc space-'));
  try {
    const bundle = macBundle(dir);
    const t = resolveTarget({ os: 'darwin', installDir: bundle });
    assert.ok(t.installDir.includes(' '), '夹具必须真的带空格');
    assert.equal(t.exec, join(bundle, 'Contents', 'MacOS', 'Electron'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('参数：未知参数 / 端口越界 / 缺值都要早失败（2 号退出码语义）', () => {
  assert.deepEqual(parseArgs(['--port', '9229']).port, 9229);
  assert.equal(parseArgs(['--no-patch']).noPatch, true);
  assert.throws(() => parseArgs(['--port', '80']), /1024/);
  assert.throws(() => parseArgs(['--port']), /缺少值/);
  assert.throws(() => parseArgs(['--wat']), /未知参数/);
  assert.throws(() => parseArgs(['--wait-timeout-sec', '1']), />= 5/);
});

test('启动环境：必须清掉 ELECTRON_RUN_AS_NODE / NODE_OPTIONS（否则应用被当纯 Node 拉起，秒退）', () => {
  // 真机事故（2026-11-16）：agent 宿主自带 ELECTRON_RUN_AS_NODE=1，
  // WorkBuddy 主进程按 Node 解析参数后立即退出，看起来像"补丁把应用弄崩了"。
  const env = sanitizedEnv({ ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', NODE_OPTIONS: '--require x', PATH: '/usr/bin' });
  for (const k of APP_ENV_DENY) assert.equal(k in env, false, '没清掉 ' + k);
  assert.equal(env.PATH, '/usr/bin', '其他环境变量要保留');

  // 对照路径（ANC_WB_METHOD=env）允许**清完之后**显式塞回 NODE_OPTIONS —— 那是唯一例外
  const withNode = sanitizedEnv({ ELECTRON_RUN_AS_NODE: '1' });
  withNode.NODE_OPTIONS = '--require /p.cjs';
  assert.equal(withNode.NODE_OPTIONS, '--require /p.cjs');
  assert.equal('ELECTRON_RUN_AS_NODE' in withNode, false);
});

test('statePaths：mac 默认根是 /Library/Application Support/anc，Windows 仍是 %ProgramData%', () => {
  const mac = statePaths({ os: 'darwin', side: 'company' });
  assert.equal(mac.state, '/Library/Application Support/anc/data/patch-state.json');
  const win = statePaths({ os: 'win32', side: 'company' });
  assert.match(win.state.replace(/\\/g, '/'), /ProgramData\/anc\/data\/patch-state\.json$/);
  const emp = statePaths({ os: 'darwin', side: 'employee' });
  assert.match(emp.state, /Library\/Application Support\/anc\/data\/patch-state\.json$/);
});
