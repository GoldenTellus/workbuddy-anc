import { issues } from '../../modules/improvement/index.ts';
import type { CliContext } from './context.ts';

// 迭代闭环第二步（L2）：submission → 结构化 issue。分诊靠规则表，不用模型。
export default function issue(ctx: CliContext): void {
  const { db, args, cmd, out, fail } = ctx;
  if (cmd === 'draft') {
    const id = typeof args.submission === 'string' ? Number(args.submission) : NaN;
    if (!Number.isInteger(id) || id <= 0) fail('缺少 --submission <id>');
    try {
      const r = issues.draftFromSubmission(db, id);
      out({ ok: true, ...r });
    } catch (e) { fail((e as Error).message); }
  } else if (cmd === 'list') {
    out({ ok: true, issues: issues.list(db, {
      limit: typeof args.limit === 'string' ? Number(args.limit) : undefined,
      status: typeof args.status === 'string' ? args.status : undefined,
    }) });
  } else if (cmd === 'triage') {
    const id = typeof args.id === 'string' ? Number(args.id) : NaN;
    if (!Number.isInteger(id) || id <= 0) fail('缺少 --id');
    const skill = typeof args.skill === 'string' ? args.skill : null;
    const section = typeof args.section === 'string' ? args.section : null;
    const ok = issues.setTriage(db, id, skill, section);
    out({ ok, id, skill, section });
    if (!ok) process.exit(1);
  } else if (cmd === 'set-status') {
    // 改 issue 状态：open / drafted / closed / rejected
    const id = typeof args.id === 'string' ? Number(args.id) : NaN;
    if (!Number.isInteger(id) || id <= 0) fail('缺少 --id');
    const st = String(args.to ?? '');
    if (!['open', 'drafted', 'closed', 'rejected'].includes(st)) fail('--to 只能是 open / drafted / closed / rejected');
    const ok = issues.setStatus(db, id, st as never, typeof args.note === 'string' ? args.note : undefined);
    out({ ok, id, status: st });
    if (!ok) process.exit(1);
  } else if (cmd === 'close') {
    // 语义化的 set-status closed：人把 devbot 的分支合入之后调它。
    // 为什么要单独一个命令：`close --merged` 比 `set-status --to closed` 更不容易记错，
    // 而且可以要求必须给 --branch 留个痕（哪个分支解决的）。
    const id = typeof args.id === 'string' ? Number(args.id) : NaN;
    if (!Number.isInteger(id) || id <= 0) fail('缺少 --id');
    const branch = typeof args.branch === 'string' ? args.branch : '';
    const note = branch ? '合入分支: ' + branch : '人工关闭';
    const ok = issues.setStatus(db, id, 'closed', note);
    out({ ok, id, status: 'closed' }) ;
    if (!ok) process.exit(1);
  } else fail('未知 issue 子命令（draft/list/triage/set-status/close）');
}
