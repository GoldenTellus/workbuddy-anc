// service CLI 的编排层：解析参数 → 开库 → 审计 → 分发到 group → 统一错误格式。
// 入口薄壳是 src/service/cli.ts；技能/persona/计划任务只认那个路径。
import { dirname } from 'node:path';
import { openDb, DEFAULT_DB, appendAudit, commandName } from '../../core/index.ts';
import { parse, type AuditState, type CliContext } from './context.ts';
import { handlers, order } from './registry.ts';

export async function run(argv: string[]): Promise<void> {
  const args = parse(argv);
  const dbPath = typeof args.db === 'string' ? args.db : DEFAULT_DB;
  const dataDir = dirname(dbPath);

  // 审计：每个会改状态的调用留一行（观测手段，写失败不挡主流程）。
  // 必须在 openDb 之前注册：库打不开时也要留痕。
  const audit: AuditState = {
    at: new Date().toISOString(),
    cmd: 'service ' + commandName(argv),
    ok: true,
    code: null,
    targets: [],
  };
  process.on('exit', (code) => {
    // fail() 直接 process.exit，不走 catch：用退出码补上 code，别让审计把失败记成"ok"
    audit.ok = code === 0 && !audit.code;
    audit.code = audit.code ?? (code === 0 ? null : 'EXIT_' + code);
    appendAudit(dataDir, audit);
  });

  const json = args.json === true;
  const [group, cmd] = args._;

  function out(obj: unknown): void {
    if (json) console.log(JSON.stringify(obj, null, 2));
    else if (typeof obj === 'string') console.log(obj);
    else console.log(JSON.stringify(obj));
  }

  function fail(msg: string, code = 2): never {
    console.error('ERROR ' + msg);
    console.error('FIX   看 docs/LOCAL-SERVICE.md');
    process.exit(code);
  }

  function num(name: string): number {
    const v = args[name];
    if (typeof v !== 'string' || !/^\d+$/.test(v)) fail(`缺少或非法的 --${name}`);
    return Number(v);
  }

  function numArg(v: unknown, def: number, min = 1, max = 1000): number {
    if (typeof v !== 'string' || !/^\d+$/.test(v)) return def;
    return Math.min(max, Math.max(min, Number(v)));
  }

  // openDb 单独接：库被独占时它抛的错不走下面的 catch，直接冒成 Node 裸堆栈，
  // 运维和 agent 都读不出「是文件被占用了」。
  let db: ReturnType<typeof openDb>;
  try {
    db = openDb(dbPath);
  } catch (e) {
    fail((e as Error).message, 1);
  }

  if (!group) fail('缺少命令组（' + order.join(' / ') + '）');

  const handler = handlers[group];
  if (!handler) fail('未知命令组: ' + group);

  const ctx: CliContext = { db, args, json, cmd, dbPath, dataDir, audit, out, fail, num, numArg };

  try {
    await handler(ctx);
  } catch (e) {
    const err = e as Error & { code?: string };
    audit.code = err.code ?? 'ERROR';
    console.error('ERROR ' + err.message);
    if (err.code === 'OUTBOUND_SECRET_BLOCKED') console.error('FIX   出站内容含凭据，先删掉再入队/发送（FORK §5.5）');
    else console.error('FIX   看 docs/LOCAL-SERVICE.md');
    process.exit(1);
  } finally {
    try { db.close(); } catch { /* 已在别处退出 */ }
  }
}
