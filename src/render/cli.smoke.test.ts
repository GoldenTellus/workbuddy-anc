import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// CLI 层一直没有测试：2026-11-02 就因为 import 锚点没匹配，deploy 分支用了未引入的
// deployOrg，只有在真机上跑才炸。这里做最小冒烟——不测业务，只测"命令接线没断"。

function run(args: string[]): { code: number; out: string } {
  const cli = join(import.meta.dirname, 'cli.ts');
  try {
    const out = execFileSync(process.execPath, ['--no-warnings', cli, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: String(err.stdout ?? '') + String(err.stderr ?? '') };
  }
}

test('CLI 冒烟：deploy / rollback 缺参数时给 USAGE，不是 ReferenceError', () => {
  for (const cmd of ['deploy', 'rollback']) {
    const r = run([cmd]);
    assert.equal(r.code, 2, cmd + ' 应以 2 退出');
    assert.match(r.out, /USAGE|缺少/, cmd + ' 应提示用法而不是崩');
    assert.doesNotMatch(r.out, /is not defined/, cmd + ' 不能是 ReferenceError（import 漏了）');
  }
});

test('CLI 冒烟：未知命令列出全部子命令', () => {
  const r = run(['nope']);
  assert.equal(r.code, 2);
  assert.match(r.out, /render \/ deploy \/ rollback \/ onboard \/ verify/);
});
