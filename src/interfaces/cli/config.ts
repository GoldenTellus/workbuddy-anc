import * as coreConfig from '../../core/index.ts';
import type { CliContext } from './context.ts';

export default function configGroup(ctx: CliContext): void {
  const { db, args, cmd, out, fail } = ctx;
  if (cmd === 'list') {
    const problems = coreConfig.configProblems(db);
    out({ ok: problems.length === 0, config: coreConfig.listConfig(db), problems });
  } else if (cmd === 'get') {
    const key = String(args.key ?? '');
    const v = coreConfig.getConfig(db, key);
    out({ ok: v !== null, key, value: v });
    if (v === null) process.exit(1);
  } else if (cmd === 'set') {
    const key = String(args.key ?? '');
    if (!key) fail('缺少 --key');
    coreConfig.validateConfig(key, String(args.value ?? ''));
    const nextStart = key === 'work_start' ? String(args.value) : coreConfig.getConfig(db, 'work_start');
    const nextEnd = key === 'work_end' ? String(args.value) : coreConfig.getConfig(db, 'work_end');
    if (nextStart && nextEnd && nextStart.trim() === nextEnd.trim()) fail('work_start 与 work_end 不能相同');
    coreConfig.setConfig(db, key, String(args.value ?? '').trim());
    out({ ok: true, key, value: coreConfig.getConfig(db, key) });
  } else fail('未知 config 子命令');
}
