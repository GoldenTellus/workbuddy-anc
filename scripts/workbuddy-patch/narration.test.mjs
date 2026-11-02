import { readFileSync } from 'node:fs';
const src = readFileSync('scripts/workbuddy-patch/preload.cjs', 'utf8');
const m = src.match(/const NARRATION_RE = \/(.+?)\/;/s);
if (!m) { console.error('取不到正则'); process.exit(1); }
const NARRATION_RE = new RegExp(m[1]);
function filter(text) {
  if (typeof text !== 'string') return text;
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return text;
  const kept = lines.filter((l) => !NARRATION_RE.test(l.trim()));
  if (kept.length === 0) return lines[lines.length - 1];
  return kept.join('\n');
}
const cases = [
  ['单行不动', '已入库：collab/x.md（原件 x.txt，120 字）', '已入库：collab/x.md（原件 x.txt，120 字）'],
  ['多段过滤', '在入库，稍等。\n批次就绪。现在写整理文档。\n已入库：collab/x.md', '已入库：collab/x.md'],
  ['全过程话留最后一句', '我先看一下格式\n格式清楚了', '格式清楚了'],
  ['保留正常多段', '今天的任务：\n- 写周报\n- 交报销', '今天的任务：\n- 写周报\n- 交报销'],
  ['不误杀「我来说明」', '我来说明一下这个流程：\n第一步是入库', '我来说明一下这个流程：\n第一步是入库'],
  ['过滤「我来看看」', '我来看看文件\n已入库：a.md', '已入库：a.md'],
  ['不误杀任务标题「现在写周报」', '今天要做：\n现在写周报', '今天要做：\n现在写周报'],
  ['过滤「现在写整理文档」', '现在写整理文档\n已入库：a.md', '已入库：a.md'],
];
let pass = 0, fail = 0;
for (const [name, input, want] of cases) {
  const got = filter(input);
  if (got === want) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n    期望: ' + JSON.stringify(want) + '\n    实际: ' + JSON.stringify(got)); }
}
console.log(`  小计: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);