// CLI 的公共上下文：参数解析、输出、失败、数字参数。
// 只做"接口层"的事，不含业务判断；业务在各 group 文件里。
import type { DatabaseSync } from 'node:sqlite';

export type Args = Record<string, string | true> & { _: string[] };

// 开关型 flag 必须登记：否则后面跟一个不带 -- 的 token 时会被当成「这个 flag 的值」，
// `args.apply === true` / `args['wait-ready'] === true` 静默变假（--apply 退化成只预览）。
export const BOOL_FLAGS = new Set(['json', 'once', 'check', 'rebuild', 'apply', 'wait-ready', 'requires-approval', 'require-ack']);

export function parse(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (BOOL_FLAGS.has(k)) { out[k] = true; continue; }
      const n = argv[i + 1];
      if (n !== undefined && !n.startsWith('--')) { out[k] = n; i++; } else { out[k] = true; }
    } else out._.push(a);
  }
  return out;
}

export interface AuditState {
  at: string;
  cmd: string;
  ok: boolean;
  code: string | null;
  targets: string[];
}

export interface CliContext {
  db: DatabaseSync;
  args: Args;
  json: boolean;
  /** 子命令（args._[1]），没有就是 undefined */
  cmd: string | undefined;
  dbPath: string;
  dataDir: string;
  audit: AuditState;
  out(obj: unknown): void;
  fail(msg: string, code?: number): never;
  num(name: string): number;
  numArg(v: unknown, def: number, min?: number, max?: number): number;
}

export type Handler = (ctx: CliContext) => void | Promise<void>;
