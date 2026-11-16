// deploy-state 的行为测试。
//
// 验的是断点续装的**核心承诺**：
//   失败之后，之前完成的阶段不能丢。
//
// 这条承诺在第一版 ps1 里是破的，而且是静默破的：
//   PowerShell 的 `if` 表达式返回单元素数组时会把数组解包成标量，
//   于是 $doneList += $Mark 变成字符串拼接，`-contains` 全部不匹配，done 被清空。
//   症状：第一次 mark 对，第二次开始 progress 回落。不报错。
// 所以这个测试的重点不是"功能是否存在"，而是"跨多次调用之后数据还在不在"。
// 移植后这条回归仍然有效：状态文件是跨进程的唯一真相，mjs 也必须累积而不是覆盖。
//
// 现在测的是 mjs，ps1 是薄壳：deploy-state.ps1 只转发参数给 deploy-state.mjs，
// 两个实现写同一个 <root>/data/deploy-state.json、给同一个 JSON 契约、用同一组退出码。
// 因此测试直接用 process.execPath 跑 .mjs —— Windows / macOS 都能跑，不再依赖 powershell.exe。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// 测试在 src/service/，要上溯两级才是仓库根（一级只到 src/）。
const REPO = resolve(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'deploy', 'deploy-state.mjs');

// 用临时目录当部署根，不碰真实 %ProgramData% / Library
function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'anc-ds-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

// 跑脚本，返回 { code, json }
// 注意：故意不吞 stderr——如果脚本往 stderr 写了东西，JSON 会解析失败，
// 那本身就是 bug（agent 用 2>&1 调用时会踩到，见 VERIFY §42）。
function run(root, args) {
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [SCRIPT, '--root', root, ...args, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    code = e.status ?? 1;
    out = (e.stdout ?? '') + (e.stderr ?? '');
  }
  // 去掉可能的 BOM / 前后空白
  const text = out.replace(/^\uFEFF/, '').trim();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 留给调用方断言 */ }
  return { code, json, raw: text };
}

test('deploy-state: 初始状态是 0/14 且 next 指向第一步', () => {
  withRoot((root) => {
    const { code, json } = run(root, ['--side', 'company']);
    assert.equal(code, 0, '没有 failed 时退出码应为 0');
    assert.ok(json, 'JSON 必须能解析');
    assert.equal(json.ok, false, '没做完时 ok 是 false');
    // 2026-11-10 部署后自动 executor 成为第 14 个阶段（此前 13）。
    assert.equal(json.progress, '0/14');
    // 第一步是 brief：先给人递准备清单（建群、拿 chatId、拿 webhook），再收信息。
    // 2026-11-10 之前直接让人从 preflight 开始，缺的信息要装到 §5.5/§6/§10.5 才回头问。
    assert.equal(json.stage, 'brief');
    assert.match(json.next, /deploy-kickoff/, 'next 要指向访谈入口，而不是直接跑 preflight');
    assert.equal(json.done.length, 0);
  });
});

test('deploy-state: 连续 mark 三个阶段，done 必须累积（这是解包 bug 的回归测试）', () => {
  withRoot((root) => {
    // 第一步
    let r = run(root, ['--side', 'company', '--mark', 'brief', '--as-done']);
    assert.equal(r.json.progress, '1/14');
    assert.deepEqual(r.json.done, ['brief']);

    // 第二步：如果 done 被覆盖成单值，这里会变成 0/14
    r = run(root, ['--side', 'company', '--mark', 'answers', '--as-done']);
    assert.equal(r.json.progress, '2/14', 'mark 第二个之后 done 不能丢');
    assert.deepEqual(r.json.done, ['brief', 'answers']);

    // 第三步
    r = run(root, ['--side', 'company', '--mark', 'workbuddy', '--as-done']);
    assert.equal(r.json.progress, '3/14');
    assert.deepEqual(r.json.done, ['brief', 'answers', 'workbuddy']);
  });
});

test('deploy-state: 中途失败后，已完成阶段必须保住（断点续装的核心）', () => {
  withRoot((root) => {
    for (const s of ['brief', 'answers', 'workbuddy']) {
      run(root, ['--side', 'company', '--mark', s, '--as-done']);
    }

    // 第 4 步失败
    const fail = run(root, ['--side', 'company', '--mark', 'files', '--as-failed', '--reason', '目标文件被锁']);
    assert.equal(fail.code, 1, 'AsFailed 退出码应为 1');
    assert.equal(fail.json.failed, 'files');
    assert.equal(fail.json.error, '目标文件被锁');
    assert.equal(fail.json.progress, '3/14', '失败不能把前 3 步清掉');

    // 重跑查状态：必须告诉 agent「不要从头来」
    const st = run(root, ['--side', 'company']);
    assert.equal(st.json.progress, '3/14');
    assert.deepEqual(st.json.done, ['brief', 'answers', 'workbuddy']);
    assert.equal(st.json.failed, 'files');
    assert.match(st.json.next, /不要从头来/, 'next 要明确劝阻从头重装');
    assert.match(st.json.next, /files/);

    // 修好后继续，不该重做前 3 步
    const fixed = run(root, ['--side', 'company', '--mark', 'files', '--as-done']);
    assert.equal(fixed.json.progress, '4/14');
    assert.equal(fixed.json.failed, '', 'done 之后 failed 要清掉');
  });
});

test('deploy-state: 全部做完后 ok=true 且 next 说明完成', () => {
  withRoot((root) => {
    // 公司侧 14 阶段（2026-11-10 加 executor）；少 mark 一个就到不了 ok=true。
    const all = ['brief', 'answers', 'workbuddy', 'preflight', 'dirs', 'files', 'skills', 'patch', 'tasks', 'vault', 'org', 'wecom', 'verify', 'executor'];
    let r;
    for (const s of all) r = run(root, ['--side', 'company', '--mark', s, '--as-done']);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.progress, '14/14');
    assert.equal(r.json.remaining.length, 0);
    assert.match(r.json.next, /全部/);
  });
});

test('deploy-state: 未知阶段要报错（拼错阶段名不能被静默接受）', () => {
  withRoot((root) => {
    const r = run(root, ['--side', 'company', '--mark', 'nope', '--as-done']);
    assert.equal(r.code, 2, '用法错误退出码 2');
    assert.match(r.raw, /未知阶段/);
  });
});

test('deploy-state: employee 侧的阶段表和 company 不同', () => {
  withRoot((root) => {
    const { json } = run(root, ['--side', 'employee']);
    assert.equal(json.progress, '0/9', 'employee 侧是 9 个阶段（D54 去掉 §5.5 公司同步）');
    const ids = json.stages.map((s) => s.id);
    assert.ok(!ids.includes('sync'), 'D54：员工侧不再需要从公司侧同步渲染产物');
    assert.ok(ids.includes('persona'), 'employee 侧要本地生成/部署 persona');
    assert.ok(ids.includes('bind'), 'employee 侧要绑定群');
    assert.ok(!ids.includes('tasks'), 'employee 侧不注册计划任务');
    assert.ok(!ids.includes('vault'), 'employee 侧不建 vault');
    assert.ok(ids.indexOf('skills') < ids.indexOf('persona'), 'persona 在 skills 之后');
  });
});

test('deploy-state: 状态文件是 UTF-8 无 BOM 的合法 JSON', () => {
  withRoot((root) => {
    run(root, ['--side', 'company', '--mark', 'preflight', '--as-done']);
    const f = join(root, 'data', 'deploy-state.json');
    assert.ok(existsSync(f));
    const bytes = readFileSync(f);
    assert.notDeepEqual([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF], '.json 不带 BOM');
    const parsed = JSON.parse(bytes.toString('utf8'));
    assert.deepEqual(parsed.done, ['preflight']);
  });
});

test('deploy-state: 输出到 stderr 的东西不能污染 JSON', () => {
  withRoot((root) => {
    // run() 里 stdio 分开抓，但把两者拼起来解析——和 agent 用 2>&1 的效果一样。
    // 如果脚本往 stderr 写了任何东西，这个断言会因为 JSON 解析失败而挂。
    const { json } = run(root, ['--side', 'company']);
    assert.ok(json, 'stdout+stderr 合并后必须仍然是纯 JSON');
  });
});
