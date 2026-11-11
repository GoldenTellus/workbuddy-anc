#!/usr/bin/env node
// 文档检查：
// 1) Markdown 相对链接存在（http/https/mailto/# 跳过，docs/archive 跳过）；
// 2) docs/doc-map.json 里登记的文件存在、类型 banner 匹配；
// 3) 现行根文档能从 INDEX.md 链到；upstreams 能从 UPSTREAM.md 链到；
// 4) doc-map.json 的 modules.contracts 登记的模块契约（现 13 份）有必需章节。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

function findRoot(start) {
  let d = start;
  while (d) {
    if (existsSync(join(d, '.git'))) return d;
    const p = dirname(d);
    if (p === d) return start;
    d = p;
  }
  return start;
}

const ROOT = findRoot(import.meta.dirname);
const failures = [];
const add = (msg) => failures.push(msg);
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');

// ── 1. 链接 ──────────────────────────────────────────────
const files = [];
for (const name of ['README.md', 'AGENTS.md', 'CLAUDE.md', 'BOOTSTRAP.md']) {
  const p = join(ROOT, name);
  if (existsSync(p)) files.push(p);
}
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'archive') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.md$/i.test(e.name)) files.push(p);
  }
}
walk(join(ROOT, 'docs'));

for (const f of files) {
  const text = readFileSync(f, 'utf8')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '');
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    let link = m[1];
    if (/^(https?:|mailto:|#|<)/i.test(link)) continue;
    link = link.replace(/#.*$/, '');
    if (!link) continue;
    let p;
    try { p = resolve(dirname(f), decodeURI(link)); } catch {
      add(rel(f) + ' -> ' + m[1] + '（URL 解码失败）');
      continue;
    }
    if (!existsSync(p)) add(rel(f) + ' -> ' + m[1]);
  }
}

// ── 2. doc-map ───────────────────────────────────────────
const mapPath = join(ROOT, 'docs/doc-map.json');
if (!existsSync(mapPath)) {
  add('docs/doc-map.json 不存在');
} else {
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  const docs = Array.isArray(map.docs) ? map.docs : [];
  const mapped = new Set();
  for (const d of docs) {
    mapped.add(d.path);
    const p = join(ROOT, d.path);
    if (!existsSync(p)) { add('doc-map 路径不存在: ' + d.path); continue; }
    const lines = readFileSync(p, 'utf8').split(/\r?\n/).slice(0, 8);
    const banner = lines.find((l) => l.startsWith('> 类型：'));
    if (!banner) add(d.path + ' 缺少 `> 类型：` banner');
    else if (!banner.slice('> 类型：'.length).startsWith(d.type)) {
      add(d.path + ' 类型不匹配：map=' + d.type + '，banner=' + banner.slice(0, 40));
    }
  }

  // 现行根文档必须登记（docs/ 下 + 根目录的部署入口）
  for (const name of readdirSync(join(ROOT, 'docs'))) {
    if (!name.endsWith('.md')) continue;
    const p = 'docs/' + name;
    if (!mapped.has(p)) add('doc-map 未登记根文档: ' + p);
  }
  for (const name of ['BOOTSTRAP.md']) {
    if (existsSync(join(ROOT, name)) && !mapped.has(name)) add('doc-map 未登记根文档: ' + name);
  }
  // upstreams 必须登记；干净 clone 里这个目录可能不存在（历史遗留目录/未 tracked），不能因此挂掉
  const upstreamsDir = join(ROOT, 'docs/upstreams');
  if (existsSync(upstreamsDir)) {
    for (const name of readdirSync(upstreamsDir)) {
      if (!name.endsWith('.md')) continue;
      const p = 'docs/upstreams/' + name;
      if (!mapped.has(p)) add('doc-map 未登记来源: ' + p);
    }
  }

  // INDEX 链接到每份现行文档（根目录文档用 ../ 前缀）
  const indexText = existsSync(join(ROOT, 'docs/INDEX.md')) ? readFileSync(join(ROOT, 'docs/INDEX.md'), 'utf8') : '';
  for (const d of docs) {
    if (d.path === 'docs/INDEX.md') continue;
    if (d.path.startsWith('docs/upstreams/')) continue;
    const link = d.path.startsWith('docs/')
      ? '(./' + d.path.slice('docs/'.length) + ')'
      : '(../' + d.path + ')';
    if (!indexText.includes(link)) add('INDEX.md 未链接: ' + d.path);
  }

  // UPSTREAM.md 链接到每份来源
  const upstreamText = existsSync(join(ROOT, 'docs/UPSTREAM.md')) ? readFileSync(join(ROOT, 'docs/UPSTREAM.md'), 'utf8') : '';
  for (const d of docs) {
    if (!d.path.startsWith('docs/upstreams/')) continue;
    const base = d.path.slice('docs/'.length);
    if (!upstreamText.includes('(./' + base + ')')) add('UPSTREAM.md 未链接: ' + d.path);
  }

  // 模块契约
  const modules = map.modules || {};
  if (!modules.index || !existsSync(join(ROOT, modules.index))) add('doc-map.modules.index 缺失');
  const required = ['职责', '拥有', '公开契约', '不变量', '失败模式', '依赖', '测试', '变更记录'];
  for (const id of modules.contracts || []) {
    const p = join(ROOT, 'docs/modules/' + id + '.md');
    if (!existsSync(p)) { add('模块契约缺失: ' + id); continue; }
    const t = readFileSync(p, 'utf8');
    for (const h of required) if (!t.includes('## ' + h)) add(id + '.md 缺少章节: ## ' + h);
  }
}

if (failures.length) {
  console.error('FAIL  文档检查 ' + failures.length + ' 条：');
  for (const f of failures) console.error('  ! ' + f);
  process.exit(1);
}
console.log('OK 文档检查通过（' + files.length + ' 份 Markdown，doc-map 类型/入口/模块章节均通过；排除 docs/archive）');
