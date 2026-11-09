import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// 2026-11-05 加（RELEASE-CHECKLIST A5 / VERIFY §67.3）。
//
// 这个文件只有一个目的：让 service CLI 和它的执行体真的被 Node 加载一次。
// 覆盖率审计发现 7 个文件 1555 行（src 非测试 .ts 的 35.7%）从未被加载：
//   service/{cli,patch-drafts,eval,issues,submissions,dayend}.ts + ingest/cli.ts
// 原因不是代码写得差，是**没有任何测试 spawn 过 service CLI** —— 现有唯一的
// CLI 冒烟测试只 spawn src/render/cli.ts。这 1555 行是 L 阶段迭代闭环的执行体，
// 一直只靠 scripts/e2e-loop.ps1 端到端验，改一行就可能坏而没人知道。
//
// 所以这里刻意「不测业务」：只跑只读子命令（无命令 / --help / 未知命令 / 各 * list），
// 断言只有两条 —— 退出码对不对、输出里有没有那个关键字。
// 业务措辞、字段名、排序、条数一变就红的断言，一律不写进来。

interface RunResult { code: number; stdout: string; stderr: string }
interface Sandbox { dir: string; db: string; env: Record<string, string | undefined> }

// 2026-11-05 加：库位置要双保险，这里不是洁癖而是硬需求。
// service/cli.ts:90 是 `openDb(dbPath)`，位置在「命令组是否为空」的校验**之前**——
// 也就是说连 `service --help` 都会 openDb，而 openDb（db.ts:191）会 mkdir + 建表。
// 不带 --db 的任何一次调用都是拿 %ProgramData%\anc\data\anc.db 当靶子。
//
// 隔离三层：
//   1. --db <临时目录>/anc.db —— cli.ts:46 的 args.db 优先于 DEFAULT_DB；
//   2. env.ProgramData = 临时目录 —— 默认库、审计日志、secrets 的根都跟着挪，
//      ingest/cli.ts:47 的 dataDir 硬编码走 ProgramData，只能靠这个改；
//   3. 删掉外来 ANC_DB / ANC_ALLOW_LOCAL_INGEST —— 免得跑测试的人自己的环境变量
//      把子进程带去别的库，或把 ingest 的 D24 护栏拆掉。
function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'anc-svc-cli-'));
  const env: Record<string, string | undefined> = { ...process.env, ProgramData: dir };
  delete env.ANC_DB;
  delete env.ANC_ALLOW_LOCAL_INGEST;
  // 钉死身份：ingest CLI 的护栏按 USERNAME 判「是不是服务身份」，
  // 不能让一台真跑在 SYSTEM 下的机器把这个测试判成“不需要拦”。
  env.USERNAME = 'anc-cli-smoke';
  return { dir, db: join(dir, 'anc.db'), env };
}

function runCli(cli: string, args: string[], sb: Sandbox): Promise<RunResult> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      ['--no-warnings', cli, ...args],
      { encoding: 'utf8', env: sb.env, cwd: sb.dir, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const raw = (err as { code?: unknown } | null)?.code;
        // execFile 的 code 既可能是退出码（number），也可能是 'ENOENT' 之类的错误串
        const code = err ? (typeof raw === 'number' ? raw : 1) : 0;
        done({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      }
    );
  });
}

async function inSandbox(fn: (sb: Sandbox) => Promise<void>): Promise<void> {
  const sb = makeSandbox();
  try {
    await fn(sb);
  } finally {
    // WAL 的 -shm/-wal 可能刚被释放，Windows 上偶尔还要等一下句柄
    rmSync(sb.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

const serviceCli = join(import.meta.dirname, 'cli.ts');
const ingestCli = join(import.meta.dirname, '..', 'ingest', 'cli.ts');

test('service CLI 冒烟：无命令 / --help / 未知命令组都以 2 退出并打印用法', async () => {
  await inSandbox(async (sb) => {
    const cases: Array<[string, string[], RegExp]> = [
      ['无命令', [], /缺少命令组/],
      // --help 没有专门的实现，走的是同一条「缺少命令组」分支。
      // 断言它而不是断言"有帮助文本"，是为了跟真实行为对齐 —— 行为变了这里才会红。
      ['--help', ['--help'], /缺少命令组/],
      ['未知命令组', ['nope'], /未知命令组/],
    ];
    for (const [name, args, expect] of cases) {
      const r = await runCli(serviceCli, [...args, '--db', sb.db], sb);
      assert.equal(r.code, 2, name + ' 应以 2 退出');
      assert.match(r.stderr, expect, name + ' 应打印用法，实际 stderr=' + r.stderr);
      // import 断了（漏引入/路径改名）会走 ReferenceError 或 MODULE_NOT_FOUND，
      // 那是这个测试最该抓到的东西：2026-11-02 就因此炸过（render 侧）。
      assert.doesNotMatch(r.stderr, /is not defined|Cannot find module/, name + ' 不能是 import 断链');
    }
    // 库与审计都落在沙箱里 —— 证明 --db 与 ProgramData 两个开关都真的生效了
    assert.ok(existsSync(sb.db), '应该在临时目录里建库（证明没碰生产库）');
    assert.ok(existsSync(join(sb.dir, 'audit.log')), '审计应写在临时目录（cli.ts:50 用 dirname(dbPath)）');
  });
});

test('service CLI 冒烟：只读子命令全部以 0 退出并回 {"ok": true}', async () => {
  await inSandbox(async (sb) => {
    const repo = resolve(join(import.meta.dirname, '..', '..'));
    // 一份子命令清单，覆盖 service/cli.ts 里所有能在空库上跑的分支。
    // 只列只读：bind/task/outbox/a2a/config 的 list，加上 L 阶段四个执行体的 list
    // （submission / issue / patch / dayend / eval）。写库的子命令一律不列。
    const cases: Array<[string, string[]]> = [
      ['bind list', ['bind', 'list']],
      ['bind group-list', ['bind', 'group-list']],
      ['bind person-list', ['bind', 'person-list']],
      ['task list', ['task', 'list']],
      ['outbox list', ['outbox', 'list']],
      ['a2a list', ['a2a', 'list', '--survey', 'smoke']],
      ['config list', ['config', 'list']],
      ['submission list', ['submission', 'list']],
      ['issue list', ['issue', 'list']],
      ['patch list', ['patch', 'list']],
      ['dayend list', ['dayend', 'list']],
      ['dayend all-off', ['dayend', 'all-off']],
      // eval list 会去仓库里读用例文件（只读）；--repo 锚在仓库根，
      // 免得 cwd 一变就找不到用例。找不到也只是空数组，断言不受影响。
      ['eval list', ['eval', 'list', '--repo', repo]],
      ['eval history', ['eval', 'history']],
    ];
    for (const [name, args] of cases) {
      const r = await runCli(serviceCli, [...args, '--json', '--db', sb.db], sb);
      assert.equal(r.code, 0, name + ' 应以 0 退出，实际 stderr=' + r.stderr);
      // 只认 ok 字段：列表内容（条数、字段、顺序）留给业务测试，这里不管
      assert.match(r.stdout, /"ok": true/, name + ' 应回 {"ok": true}，实际 stdout=' + r.stdout);
    }
  });
});

test('ingest CLI 冒烟：未知命令与非服务身份的 apply 都在写 vault 之前拦下', async () => {
  await inSandbox(async (sb) => {
    const noCmd = await runCli(ingestCli, [], sb);
    assert.equal(noCmd.code, 2, 'ingest 无命令应以 2 退出');
    assert.match(noCmd.stderr, /未知命令/, 'ingest 无命令应说未知命令');

    // D24 护栏（ingest/cli.ts:27）：非服务身份直接 apply 在入口就 exit 2，
    // 根本走不到 applyBatch。测这条等于测「护栏还在」，而且全程零副作用 ——
    // 正是这个文件要的那种只读路径。
    const guard = await runCli(
      ingestCli,
      ['apply', '--batch', join(sb.dir, 'no-batch'), '--shared', join(sb.dir, 'no-vault')],
      sb
    );
    assert.equal(guard.code, 2, '非服务身份 apply 应以 2 退出');
    assert.match(guard.stderr, /HTTP 端点/, '护栏应指路到服务的 HTTP 端点');
  });
});

test('service CLI 冒烟：用法列全 17 组、布尔 flag 不被后续 token 吞掉、limit 有界', async () => {
  await inSandbox(async (sb) => {
    const usage = await runCli(serviceCli, ['--db', sb.db], sb);
    for (const g of ['summary', 'bind', 'task', 'executor', 'reminder', 'outbox', 'a2a', 'config', 'backup',
                     'project', 'loop', 'serve', 'submission', 'issue', 'patch', 'dayend', 'eval']) {
      assert.match(usage.stderr, new RegExp('\\b' + g + '\\b'), '用法里不该漏掉命令组 ' + g);
    }

    const repo = resolve(join(import.meta.dirname, '..', '..'));
    // --apply 后面故意跟一个普通 token：没登记成布尔 flag 时会被当成它的值，
    // `args.apply === true` 静默变假，prune-closed 就退化成只预览（空库不写任何文件）。
    const p = await runCli(serviceCli, ['patch', 'prune-closed', '--apply', 'extra', '--repo', repo, '--json', '--db', sb.db], sb);
    assert.equal(p.code, 0, 'prune-closed 应成功，实际 stderr=' + p.stderr);
    assert.match(p.stdout, /"applied": true/, '--apply 必须真的生效');

    for (const bad of ['-1', 'abc', '999999999']) {
      const h = await runCli(serviceCli, ['eval', 'history', '--limit', bad, '--json', '--db', sb.db], sb);
      assert.equal(h.code, 0, '--limit ' + bad + ' 不该让 CLI 崩');
      assert.match(h.stdout, /"ok": true/);
    }
  });
});
