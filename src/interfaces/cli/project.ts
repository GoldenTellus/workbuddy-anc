import { getConfig } from '../../core/index.ts';
import { checkProjection, rebuildProjection, writeProjection } from '../../modules/runtime/index.ts';
import type { CliContext } from './context.ts';

// 任务投影：库 → 内部区 collab/tasks.md。--check 只校验，--rebuild 删了重建
export default function project(ctx: CliContext): void {
  const { db, args, out, fail } = ctx;
  const internal = typeof args.internal === 'string' ? args.internal : (getConfig(db, 'vault_internal') ?? '');
  if (!internal) fail('缺少 --internal <内部区目录>（也可先 config set vault_internal <绝对路径>）');
  if (args.check === true) {
    const c = checkProjection(db, internal);
    out({ ok: c.ok, path: c.path, reason: c.reason });
    if (!c.ok) process.exit(1);
  } else if (args.rebuild === true) {
    const c = rebuildProjection(db, internal);
    out({ ok: c.ok, path: c.path, reason: c.reason });
    if (!c.ok) process.exit(1);
  } else {
    out({ ok: true, ...writeProjection(db, internal) });
  }
}
