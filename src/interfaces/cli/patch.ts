import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { patchDrafts } from '../../modules/improvement/index.ts';
import type { CliContext } from './context.ts';

// 迭代闭环第三步（L3，模板版）：issue → 定位段落 → 插入已知问题 → 输出 diff。
// 只读仓库不改文件：diff 给人看，合不合由人定。
export default function patch(ctx: CliContext): void {
  const { db, args, cmd, out, fail } = ctx;
  if (cmd === 'draft') {
    const id = typeof args.issue === 'string' ? Number(args.issue) : NaN;
    if (!Number.isInteger(id) || id <= 0) fail('缺少 --issue <id>');
    try {
      const r = patchDrafts.draftFromIssue(db, id, {
        repo: typeof args.repo === 'string' ? args.repo : undefined,
      });
      out({ ok: true, insertedLines: r.insertedLines, draft: r.draft });
    } catch (e) { fail((e as Error).message); }
  } else if (cmd === 'list') {
    out({ ok: true, drafts: patchDrafts.list(db, {
      limit: typeof args.limit === 'string' ? Number(args.limit) : undefined,
      issueId: typeof args.issue === 'string' ? Number(args.issue) : undefined,
    }) });
  } else if (cmd === 'show') {
    const id = typeof args.id === 'string' ? Number(args.id) : NaN;
    if (!Number.isInteger(id) || id <= 0) fail('缺少 --id');
    const d = db.prepare('SELECT * FROM patch_drafts WHERE id = ?').get(id);
    if (!d) fail("没有这份 draft: #" + id);
    out({ ok: true, draft: d });
  } else if (cmd === 'prune-closed') {
    // 批量：清掉所有 closed issue 留在技能文件里的「已知问题」块。默认只统计。
    const r = patchDrafts.pruneClosed(db, {
      repo: typeof args.repo === 'string' ? args.repo : undefined,
      apply: args.apply === true,
    });
    out({ ok: true, ...r, applied: args.apply === true ? true : false });
  } else if (cmd === 'prune') {
    // 删掉某条 issue 插进技能文件的「已知问题」块。默认只预览，--apply 才真删。
    const id = typeof args.issue === 'string' ? Number(args.issue) : NaN;
    if (!Number.isInteger(id) || id <= 0) fail('缺少 --issue <id>');
    try {
      const r = patchDrafts.prune(db, {
        issueId: id,
        repo: typeof args.repo === 'string' ? args.repo : undefined,
        apply: args.apply === true,
      });
      if (!r.removed) {
        out({ ok: false, ...r, preview: undefined });
        fail(r.reason || '没能删除');
      }
      if (args.apply !== true && typeof r.preview === 'string' && r.preview.length) {
        // 预览模式：把删后的全文写到临时文件，方便人 diff
        const tmp = join(process.env.TEMP || '.', 'anc-prune-' + id + '.md');
        writeFileSync(tmp, r.preview, 'utf8');
        out({ ok: true, ...r, preview: undefined, previewFile: tmp, note: '预览已写到 ' + tmp + '；确认后加 --apply 才真删' });
      } else {
        out({ ok: true, ...r, preview: undefined });
      }
    } catch (e) { fail((e as Error).message); }
  } else fail('未知 patch 子命令（draft/list/show/prune/prune-closed）');
}
