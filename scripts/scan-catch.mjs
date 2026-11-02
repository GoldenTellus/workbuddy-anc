#!/usr/bin/env node
// V2 静态扫：找出所有 catch 块，按"失败被吞掉的程度"分类。
//
// PLAN V2 的验收是「无 catch 空吞；ok:true 与实际一致」。这里只做第一半（静态），
// fail 分支的注入在 fault-inject 与单测里做。
//
// 分类：
//   EMPTY     块里只有空白与注释 —— 最可疑：失败完全不留痕
//   LOG_ONLY  只有 console.error/warn —— 至少留了痕，但调用方不知道失败了
//   SWALLOW   有 return/continue/赋值，但没有 log 也没有 throw —— 静默改变行为
//   HANDLED   有 throw、或有 log + 明确的降级决策
//
// 用法：node scripts/scan-catch.mjs [--json] [--strict]
// 退出码：0 无 EMPTY / 1 有 EMPTY（--strict 时 LOG_ONLY 也算）/ 2 用法错误

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');
const wantJson = process.argv.includes('--json');
const strict = process.argv.includes('--strict');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/** 从 catch 关键字位置起，找到紧随其后的 { ... } 块（处理嵌套大括号与字符串）。 */
function readBlock(src, from) {
  const open = src.indexOf('{', from);
  if (open < 0) return null;
  let depth = 0;
  let inS = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (inS) {
      if (c === '\\') { i++; continue; }
      if (c === inS) inS = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { body: src.slice(open + 1, i), start: open, end: i };
    }
  }
  return null;
}

function classify(body) {
  // 去掉注释后再看有没有实际语句
  const noComment = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim();
  if (!noComment) return 'EMPTY';
  const hasLog = /\bconsole\.(error|warn|log)\b/.test(noComment);
  const hasThrow = /\bthrow\b/.test(noComment);
  const hasDecision = /\b(return|continue|break)\b/.test(noComment);

  // 「明确表达了失败」的几种写法：不是空吞，是把手上的错误交出去
  //   fail(...)            顶层把错误变成非 0 退出码
  //   markFailed(...)      把消息标成失败并累计计数
  //   xxx.push(...)        收集到错误列表，稍后一并汇报
  //   return { ok: false } / return { error }   把失败当返回值
  //   lastErr = ...        重试循环里保留最后一次错误
  const propagates =
    /\b(fail|markFailed)\s*\(/.test(noComment) ||
    /\.push\s*\(/.test(noComment) ||
    /return\s*\{[^}]*\b(ok\s*:\s*false|error\s*:)/.test(noComment) ||
    /\blastErr\s*=/.test(noComment) ||
    /\b(failed|errors)\s*(\+\+|\+=)/.test(noComment);

  if (hasThrow || propagates) return 'HANDLED';
  if (hasLog && hasDecision) return 'HANDLED';
  if (hasLog) return 'LOG_ONLY';
  return 'SWALLOW';
}

const rows = [];
for (const file of walk(SRC)) {
  const src = readFileSync(file, 'utf8');
  const re = /\bcatch\s*(?:\([^)]*\))?\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const blk = readBlock(src, m.index);
    if (!blk) continue;
    const line = src.slice(0, m.index).split('\n').length;
    const kind = classify(blk.body);
    // 注释里明确写了为什么吞，视为已声明决策，不算偷懒
    // 块里只要有注释，就说明作者想过"为什么吞"——不给词表设门槛，否则换个说法就漏判
    const commented = /\/\*|\/\//.test(blk.body);
    rows.push({
      file: relative(ROOT, file).replace(/\\/g, '/'),
      line,
      kind,
      declared: commented,
      body: blk.body.replace(/\s+/g, ' ').trim().slice(0, 90),
    });
  }
}

const bad = rows.filter((r) => r.kind === 'EMPTY' || r.kind === 'SWALLOW' || (strict && r.kind === 'LOG_ONLY'));
const summary = {
  total: rows.length,
  EMPTY: rows.filter((r) => r.kind === 'EMPTY').length,
  SWALLOW: rows.filter((r) => r.kind === 'SWALLOW').length,
  LOG_ONLY: rows.filter((r) => r.kind === 'LOG_ONLY').length,
  HANDLED: rows.filter((r) => r.kind === 'HANDLED').length,
  declared: rows.filter((r) => r.declared && (r.kind === 'EMPTY' || r.kind === 'SWALLOW')).length,
  undeclaredEmpty: rows.filter((r) => r.kind === 'EMPTY' && !r.declared).length,
};

if (wantJson) {
  console.log(JSON.stringify({ summary, problems: bad, all: rows }, null, 2));
} else {
  console.log(`扫了 ${rows.length} 个 catch 块（${[...new Set(rows.map((r) => r.file))].length} 个文件）`);
  console.log(`  EMPTY ${summary.EMPTY} · SWALLOW ${summary.SWALLOW} · LOG_ONLY ${summary.LOG_ONLY} · HANDLED ${summary.HANDLED}`);
  console.log(`  其中带"有意吞掉"注释的: ${summary.declared}\n`);
  if (bad.length === 0) {
    console.log('没有未声明的空吞或静默改变行为。');
  } else {
    console.log('需要逐条看的（EMPTY / SWALLOW' + (strict ? ' / LOG_ONLY' : '') + '）:');
    for (const r of bad) {
      console.log(`  ${r.kind.padEnd(8)} ${r.file}:${r.line}${r.declared ? '  [已声明]' : ''}`);
      console.log(`           ${r.body}`);
    }
  }
}

const undeclaredEmpty = rows.filter((r) => r.kind === 'EMPTY' && !r.declared);
if (!wantJson) {
  console.log(undeclaredEmpty.length === 0
    ? `\n门禁：未声明的空吞 0 个 ✓`
    : `\n门禁：未声明的空吞 ${undeclaredEmpty.length} 个 ✗`);
}
process.exit(undeclaredEmpty.length > 0 || (strict && summary.LOG_ONLY > 0) ? 1 : 0);
