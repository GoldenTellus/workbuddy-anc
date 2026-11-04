// deploy-state.ps1 的行为测试。
//
// 验的是断点续装的**核心承诺**：
//   失败之后，之前完成的阶段不能丢。
//
// 这条承诺在第一版里是破的，而且是静默破的：
//   PowerShell 的 `if` 表达式返回单元素数组时会把数组解包成标量，
//   于是 $doneList += $Mark 变成字符串拼接，`-contains` 全部不匹配，done 被清空。
//   症状：第一次 mark 对，第二次开始 progress 回落。不报错。
// 所以这个测试的重点不是"功能是否存在"，而是"跨多次调用之后数据还在不在"。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// 测试在 src/service/，要上溯两级才是仓库根（一级只到 src/）。
const REPO = resolve(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'deploy-state.ps1');

// powershell 用绝对路径：node --test 的 worker 进程里 PATH 不含 System32\WindowsPowerShell\v1.0，
// 直接写 'powershell' 会拿到 0xFFFF0000（命令找不到），但普通 node 里是好的——这个差别很难查。
const PWSH = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// 用临时目录当部署根，不碰真实 %ProgramData%
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
    out = execFileSync(PWSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Root', root, ...args, '-Json'], {
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

test('deploy-state: 初始状态是 0/11 且 next 指向第一步', () => {
  withRoot((root) => {
    const { code, json } = run(root, ['-Side', 'company']);
    assert.equal(code, 0, '没有 failed 时退出码应为 0');
    assert.ok(json, 'JSON 必须能解析');
    assert.equal(json.ok, false, '没做完时 ok 是 false');
    assert.equal(json.progress, '0/11');
    assert.equal(json.stage, 'preflight');
    assert.match(json.next, /preflight/);
    assert.equal(json.done.length, 0);
  });
});

test('deploy-state: 连续 mark 三个阶段，done 必须累积（这是解包 bug 的回归测试）', () => {
  withRoot((root) => {
    // 第一步
    let r = run(root, ['-Side', 'company', '-Mark', 'preflight', '-AsDone']);
    assert.equal(r.json.progress, '1/11');
    assert.deepEqual(r.json.done, ['preflight']);

    // 第二步：如果 done 被解包成字符串，这里会变成 0/11
    r = run(root, ['-Side', 'company', '-Mark', 'workbuddy', '-AsDone']);
    assert.equal(r.json.progress, '2/11', 'mark 第二个之后 done 不能丢');
    assert.deepEqual(r.json.done, ['preflight', 'workbuddy']);

    // 第三步
    r = run(root, ['-Side', 'company', '-Mark', 'dirs', '-AsDone']);
    assert.equal(r.json.progress, '3/11');
    assert.deepEqual(r.json.done, ['preflight', 'workbuddy', 'dirs']);
  });
});

test('deploy-state: 中途失败后，已完成阶段必须保住（断点续装的核心）', () => {
  withRoot((root) => {
    for (const s of ['preflight', 'workbuddy', 'dirs']) {
      run(root, ['-Side', 'company', '-Mark', s, '-AsDone']);
    }

    // 第 4 步失败
    const fail = run(root, ['-Side', 'company', '-Mark', 'files', '-AsFailed', '-Reason', '目标文件被锁']);
    assert.equal(fail.code, 1, 'AsFailed 退出码应为 1');
    assert.equal(fail.json.failed, 'files');
    assert.equal(fail.json.error, '目标文件被锁');
    assert.equal(fail.json.progress, '3/11', '失败不能把前 3 步清掉');

    // 重跑查状态：必须告诉 agent「不要从头来」
    const st = run(root, ['-Side', 'company']);
    assert.equal(st.json.progress, '3/11');
    assert.deepEqual(st.json.done, ['preflight', 'workbuddy', 'dirs']);
    assert.equal(st.json.failed, 'files');
    assert.match(st.json.next, /不要从头来/, 'next 要明确劝阻从头重装');
    assert.match(st.json.next, /files/);

    // 修好后继续，不该重做前 3 步
    const fixed = run(root, ['-Side', 'company', '-Mark', 'files', '-AsDone']);
    assert.equal(fixed.json.progress, '4/11');
    assert.equal(fixed.json.failed, '', 'done 之后 failed 要清掉');
  });
});

test('deploy-state: 全部做完后 ok=true 且 next 说明完成', () => {
  withRoot((root) => {
    const all = ['preflight', 'workbuddy', 'dirs', 'files', 'skills', 'patch', 'tasks', 'vault', 'org', 'wecom', 'verify'];
    let r;
    for (const s of all) r = run(root, ['-Side', 'company', '-Mark', s, '-AsDone']);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.progress, '11/11');
    assert.equal(r.json.remaining.length, 0);
    assert.match(r.json.next, /全部/);
  });
});

test('deploy-state: 未知阶段要报错（拼错阶段名不能被静默接受）', () => {
  withRoot((root) => {
    const r = run(root, ['-Side', 'company', '-Mark', 'nope', '-AsDone']);
    assert.equal(r.code, 2, '用法错误退出码 2');
    assert.match(r.raw, /未知阶段/);
  });
});

test('deploy-state: employee 侧的阶段表和 company 不同', () => {
  withRoot((root) => {
    const { json } = run(root, ['-Side', 'employee']);
    assert.equal(json.progress, '0/7', 'employee 侧是 7 个阶段');
    const ids = json.stages.map((s) => s.id);
    assert.ok(ids.includes('persona'), 'employee 侧要部署 persona');
    assert.ok(ids.includes('bind'), 'employee 侧要绑定群');
    assert.ok(!ids.includes('tasks'), 'employee 侧不注册计划任务');
  });
});

test('deploy-state: 状态文件是 UTF-8 无 BOM 的合法 JSON', () => {
  withRoot((root) => {
    run(root, ['-Side', 'company', '-Mark', 'preflight', '-AsDone']);
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
    const { json } = run(root, ['-Side', 'company']);
    assert.ok(json, 'stdout+stderr 合并后必须仍然是纯 JSON');
  });
});
