import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMarkdown, searchAndSummarize } from './summarize.ts';

const doc = `---
title: 对账流程
owner: someone
---

# 对账流程

我们每周要对一次账，通常要花一天。

## 步骤

- 导出银行流水
- 与系统订单逐笔比对
- 差异超过 0.5% 时找财务确认

\`\`\`bash
node cli.ts loop --once
\`\`\`

## 耗时

去年平均每月 4 次，每次 6 小时。
`;

test('摘要：取标题、列表与带数字的句子，跳过代码块', () => {
  const s = summarizeMarkdown(doc);
  assert.equal(s.title, '对账流程');
  assert.ok(s.lines.includes('导出银行流水'));
  assert.ok(s.lines.some((l) => l.includes('差异超过 0.5%')));
  assert.ok(s.lines.some((l) => l.includes('每次 6 小时')));
  assert.ok(!s.lines.some((l) => l.includes('node cli.ts')), '代码块不应出现在摘要里');
});

test('摘要：frontmatter 不参与', () => {
  const s = summarizeMarkdown(doc);
  assert.ok(!s.lines.some((l) => l.includes('owner:')));
  assert.notEqual(s.title, 'title: 对账流程');
});

test('摘要：maxLines 生效且保持原文顺序', () => {
  const s = summarizeMarkdown(doc, { maxLines: 2 });
  assert.equal(s.lines.length, 2);
  const a = doc.indexOf(s.lines[0]);
  const b = doc.indexOf(s.lines[1]);
  assert.ok(a < b, '输出顺序应与原文一致');
});

test('摘要：长行截断到指定宽度', () => {
  const long = '# 标题\n\n- ' + '很长的内容'.repeat(80);
  const s = summarizeMarkdown(long, { maxCharsPerLine: 40 });
  assert.equal(s.title, '标题');
  assert.ok(s.lines[0].length <= 40);
  assert.ok(s.lines[0].endsWith('…'));
});

test('摘要：空文档与纯代码块不崩', () => {
  assert.deepEqual(summarizeMarkdown(''), { title: '', lines: [], scanned: 0 });
  const onlyCode = '```\nfoo\n```';
  assert.deepEqual(summarizeMarkdown(onlyCode), { title: '', lines: [], scanned: 0 });
});

test('摘要：重复行只留一次，且结果稳定', () => {
  const dup = '# 标题\n\n- 同一行\n- 同一行\n- 另一行';
  const a = summarizeMarkdown(dup);
  const b = summarizeMarkdown(dup);
  assert.deepEqual(a, b);
  assert.equal(a.lines.filter((l) => l === '同一行').length, 1);
});

test('检索：关键词命中正文与标题，标题优先，结果稳定', () => {
  const docs = [
    { path: 'b.md', text: '# 无关标题\n\n正文提到对账流程一次。' },
    { path: 'a.md', text: '# 对账流程\n\n每周一次。' },
    { path: 'c.md', text: '# 别的\n\n完全无关。' },
  ];
  const hits = searchAndSummarize(docs, '对账');
  assert.equal(hits.length, 2);
  assert.equal(hits[0].path, 'a.md', '标题命中的排前面');
  assert.deepEqual(searchAndSummarize(docs, '对账'), hits, '同样输入结果稳定');
  assert.deepEqual(searchAndSummarize(docs, '  '), []);
});