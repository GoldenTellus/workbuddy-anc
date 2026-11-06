import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getConfig } from '../../core/index.ts';
import { searchAndSummarize, summarizeMarkdown } from '../../modules/knowledge/index.ts';
import type { CliContext } from './context.ts';

// 本地摘要（D19/C13）：读本机文件、按规则抽要点。两种用法：
//   summary --path <file>            单篇
//   summary --find <关键词> [--root]  在 vault 里定位（标题命中优先），每条给路径 + 摘要
// 全程不调模型、不发网络请求。
function collectMarkdown(root: string, limit = 3000): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (out.length >= limit || depth > 6) return;
    let entries: import('node:fs').Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.name === '.git' || e.name === '_originals' || e.name === 'node_modules') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
      try {
        if (statSync(p).size > 512 * 1024) continue;
        out.push({ path: p, text: readFileSync(p, 'utf8') });
      } catch { /* 读不了就跳过：定位是尽力而为 */ }
    }
  };
  walk(root, 0);
  return out;
}

export default function summary(ctx: CliContext): void {
  const { db, args, out, fail, numArg, audit } = ctx;
  const maxLines = numArg(args['max-lines'], 8, 1, 50);
  const maxCharsPerLine = numArg(args['max-chars'], 160, 20, 500);
  const find = typeof args.find === 'string' ? args.find : '';
  if (find) {
    const roots: string[] = [];
    if (typeof args.root === 'string') roots.push(resolve(args.root));
    else {
      for (const key of ['vault_shared', 'vault_internal']) {
        const v = getConfig(db, key);
        if (v) roots.push(v);
      }
    }
    if (!roots.length) fail('没有可检索的 vault：用 --root 指定，或先 config set vault_shared/vault_internal');
    const docs: { path: string; text: string }[] = [];
    for (const r of roots) docs.push(...collectMarkdown(r));
    audit.targets.push(...roots);
    const hits = searchAndSummarize(docs, find, { maxLines, maxCharsPerLine, maxDocs: numArg(args['max-docs'], 5, 1, 20) });
    out({ ok: true, keyword: find, roots, scanned: docs.length, hits });
  } else {
    const p = typeof args.path === 'string' ? args.path : '';
    if (!p) fail('缺少 --path <markdown 文件> 或 --find <关键词>');
    const abs = resolve(p);
    if (!existsSync(abs)) fail('文件不存在: ' + abs);
    if (!statSync(abs).isFile()) fail('不是文件: ' + abs);
    audit.targets.push(abs);
    const s = summarizeMarkdown(readFileSync(abs, 'utf8'), { maxLines, maxCharsPerLine });
    out({ ok: true, path: abs, ...s });
  }
}
