// 本地摘要：把 vault 里的一篇 markdown 压成几行要点，全程在本机完成。
//
// 为什么放在这里（D19 / C13）：资料不上云——正文不能作为对话内容发给模型。
// bot 需要"讲讲这份文档"时，只准跑这个函数/命令，把结果读出来再回话；
// 摘要由确定性规则生成，不调模型，也不产生任何网络请求。
//
// 规则（全部可测、无随机）：
//   1. 去掉 BOM 与 frontmatter；
//   2. 标题取第一个 `# `，没有就取第一行非空文本；
//   3. 代码块整体跳过（代码压成一句话没有意义，还容易截断）；
//   4. 行分三档：标题 3 分、列表项 2 分、含数字/百分号/冒号的句子 1 分；
//   5. 按分数取前 N 行，但输出保持原文顺序；同分按出现先后；
//   6. 每行截到固定宽度，重复行只留一次。

export interface SummaryOptions {
  /** 最多保留几行要点（默认 8）。 */
  maxLines?: number;
  /** 每行最多多少字符（默认 160）。 */
  maxCharsPerLine?: number;
}

export interface Summary {
  title: string;
  lines: string[];
  /** 实际参与打分的行数，便于判断是不是"文档太短/太长"。 */
  scanned: number;
}

const DEFAULT_MAX_LINES = 8;
const DEFAULT_MAX_CHARS = 160;

function stripFrontmatter(text: string): string {
  const body = text.replace(/^\uFEFF/, '');
  const m = body.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? body.slice(m[0].length) : body;
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/** 打分只看行的形状，不看语义，避免"看起来重要"的误判。 */
function scoreLine(line: string): number {
  if (/^#{2,6}\s+\S/.test(line)) return 3;
  if (/^(?:[-*+]|\d+[.)])\s+\S/.test(line)) return 2;
  if (/[0-9%]|：|:/.test(line)) return 1;
  return 0;
}

function isFence(line: string): boolean {
  return /^\s*(?:```|~~~)/.test(line);
}

export function summarizeMarkdown(raw: string, opts: SummaryOptions = {}): Summary {
  const maxLines = Math.max(1, Math.min(50, Math.trunc(opts.maxLines ?? DEFAULT_MAX_LINES)));
  const maxChars = Math.max(20, Math.min(500, Math.trunc(opts.maxCharsPerLine ?? DEFAULT_MAX_CHARS)));

  const body = stripFrontmatter(String(raw ?? ''));
  const all = body.split(/\r?\n/);
  const visible: string[] = [];
  let inFence = false;
  for (const line of all) {
    if (isFence(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (line.trim() === '') continue;
    visible.push(line.trimEnd());
  }

  let title = '';
  const titleIdx = visible.findIndex((l) => /^#\s+\S/.test(l));
  if (titleIdx >= 0) title = clip(visible[titleIdx].replace(/^#\s+/, ''), maxChars);
  else if (visible.length) title = clip(visible[0].replace(/^[>#*\-\s]+/, ''), maxChars);

  const scored = visible
    .map((line, i) => ({ line, i, score: scoreLine(line) }))
    .filter((x) => x.score > 0);

  const picked = scored
    .slice()
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, maxLines)
    .sort((a, b) => a.i - b.i);

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const p of picked) {
    const text = clip(p.line.replace(/^#{2,6}\s+/, '').replace(/^(?:[-*+]|\d+[.)])\s+/, ''), maxChars);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    lines.push(text);
  }

  return { title, lines, scanned: visible.length };
}
