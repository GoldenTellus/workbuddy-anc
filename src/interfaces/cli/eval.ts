import { dirname, join } from 'node:path';
import { evalRunner as evalMod } from '../../modules/improvement/index.ts';
import type { CliContext } from './context.ts';

// 迭代闭环第六步（L6）：驱动 WorkBuddy 回放用例，判 pass/fail。
// 走 test-emit 注入 + 读 patch-out.log 取回答（见 OPS.md「程序化测试入口」）。
export default async function evalGroup(ctx: CliContext): Promise<void> {
  const { db, args, cmd, out, fail, numArg, dbPath } = ctx;
  if (cmd === 'run') {
    const caseId = typeof args.case === 'string' ? args.case : '';
    if (!caseId) fail('缺少 --case <用例 id>');
    const chatId = typeof args['chat-id'] === 'string' ? args['chat-id'] : '';
    if (!chatId) fail('缺少 --chat-id（用 chat_bindings 里的完整 chatId）');
    const repo = typeof args.repo === 'string' ? args.repo : process.cwd();
    const cases = evalMod.loadCases(repo);
    const c = cases.find((x) => x.id === caseId);
    if (!c) fail('没有这个用例: ' + caseId);
    const outLog = join(dirname(dbPath), 'patch-out.log');
    const emitOpts = {
      chatId,
      user: typeof args['user-id'] === 'string' ? args['user-id'] : 'eval',
      port: typeof args.port === 'string' ? Number(args.port) : undefined,
    };
    if (args['wait-ready'] === true) {
      const ok = await evalMod.waitReady(emitOpts);
      if (!ok) fail('test-emit 没就绪（重启后要 8–30 秒；检查 test-emit.flag）');
    }
    const r = await evalMod.runCase(c, {
      ...emitOpts,
      outLog,
      timeoutMs: typeof args.timeout === 'string' ? Number(args.timeout) * 1000 : undefined,
    });
    const id = evalMod.record(db, r, 'cli eval run');
    out({ ok: r.verdict === 'pass', runId: id, ...r });
    if (r.verdict !== 'pass') process.exit(1);
  } else if (cmd === 'list') {
    // 列用例（不跑）
    const repo = typeof args.repo === 'string' ? args.repo : process.cwd();
    const cases = evalMod.loadCases(repo, typeof args.skill === 'string' ? args.skill : undefined);
    out({ ok: true, cases });
  } else if (cmd === 'history') {
    // 和其它列表一致：非法值退回默认，正数夹到 1..200（LIMIT -1 = 不限制，会拉全表；NaN 会直接绑定）
    const limit = numArg(args.limit, 20, 1, 200);
    const rows = db.prepare('SELECT id, case_id, skill, verdict, answer_len, note, created_at FROM eval_runs ORDER BY id DESC LIMIT ?').all(limit);
    out({ ok: true, runs: rows });
  } else fail('未知 eval 子命令（run/list/history）');
}
