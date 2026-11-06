#!/usr/bin/env node
// 模块边界检查器：读 module-map.json，扫 src 的 import，报跨模块边与违规。
//
// 用法：
//   node scripts/checks/check-modules.mjs              只报告（0 退出码，除非配置本身有错）
//   node scripts/checks/check-modules.mjs --strict     有违规/未归属/缺文档就退出 1
//   node scripts/checks/check-modules.mjs --strict-deep  连"深导入"也当失败（P7 用）
//   node scripts/checks/check-modules.mjs --json       机器可读
//
// 它只做三件事，不做代码风格检查：
//   1. 每个 src 文件必须归属一个模块（module-map.json 的 paths）
//   2. 跨模块 import 必须落在 dependsOn 里（反向依赖/环 = 违规）
//   3. 目标模块有 index.ts 后，跨模块只能 import 那个入口（深导入 = 警告）

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const strict = process.argv.includes('--strict');
const strictDeep = process.argv.includes('--strict-deep');
const asJson = process.argv.includes('--json');

const norm = (p) => p.split(sep).join('/');
const rel = (p) => norm(relative(ROOT, p));

let map;
try {
  map = JSON.parse(readFileSync(join(ROOT, 'module-map.json'), 'utf8'));
} catch (e) {
  console.error('ERROR 读不到 module-map.json: ' + e.message);
  process.exit(2);
}

const modules = (map.modules || []).map((m) => ({ ...m, paths: (m.paths || []).map(norm) }));
const byId = new Map(modules.map((m) => [m.id, m]));

function moduleOf(file) {
  const f = rel(file);
  for (const m of modules) {
    for (const p of m.paths) {
      if (f === p) return m;
      const prefix = p.endsWith('/') ? p : p + '/';
      if (f.startsWith(prefix)) return m;
    }
  }
  return null;
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

function walkAll(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkAll(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function countOther(paths, id) {
  let n = 0;
  for (const p of paths) {
    const abs = join(ROOT, p);
    if (!existsSync(abs)) continue;
    const list = statSync(abs).isFile() ? [abs] : walkAll(abs);
    for (const f of list) {
      if (rel(f).startsWith('src/')) continue;
      if (moduleOf(f)?.id === id) n++;
    }
  }
  return n;
}

const files = walk(join(ROOT, 'src'));
const edges = new Map();
const unknownFiles = [];
const deepImports = [];
const IMPORT_RE = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

for (const file of files) {
  const owner = moduleOf(file);
  if (!owner) { unknownFiles.push(rel(file)); continue; }
  const text = readFileSync(file, 'utf8');
  let match;
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(text))) {
    const spec = match[1];
    if (!spec.startsWith('.')) continue;
    let target = resolve(dirname(file), spec);
    if (!existsSync(target)) {
      for (const cand of [target + '.ts', join(target, 'index.ts')]) {
        if (existsSync(cand)) { target = cand; break; }
      }
    }
    if (!existsSync(target) || !target.endsWith('.ts')) continue;
    const to = moduleOf(target);
    if (!to || to.id === owner.id) continue;
    const key = owner.id + '->' + to.id;
    if (!edges.has(key)) edges.set(key, new Set());
    edges.get(key).add(rel(file) + ' -> ' + rel(target));
    if (to.entry && existsSync(join(ROOT, to.entry)) && resolve(ROOT, to.entry) !== target) {
      deepImports.push({ from: rel(file), to: rel(target), module: to.id });
    }
  }
}

const violations = [];
for (const [key, list] of edges) {
  const [from, to] = key.split('->');
  const owner = byId.get(from);
  if (!owner) continue;
  if (!owner.dependsOn.includes(to)) {
    violations.push({ kind: 'edge', edge: key, count: list.size, samples: [...list].slice(0, 3) });
  }
}

const missingDocs = modules.filter((m) => !existsSync(join(ROOT, m.doc))).map((m) => m.id + ': ' + m.doc);
const missingEntries = modules
  .filter((m) => m.status === 'planned' && m.entry && !existsSync(join(ROOT, m.entry)))
  .map((m) => m.id + ': ' + m.entry);

const duplicatePaths = [];
const seen = new Map();
for (const m of modules) {
  for (const p of m.paths) {
    if (seen.has(p) && seen.get(p) !== m.id) duplicatePaths.push(p + ': ' + seen.get(p) + ' / ' + m.id);
    seen.set(p, m.id);
  }
}

const cycles = [];
{
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      const i = stack.indexOf(id);
      cycles.push(stack.slice(i).concat(id).join(' -> '));
      return;
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of (byId.get(id)?.dependsOn || [])) visit(dep);
    stack.pop();
    state.set(id, 'done');
  };
  for (const m of modules) visit(m.id);
}

const stats = modules.map((m) => {
  const own = files.filter((f) => moduleOf(f)?.id === m.id);
  const deps = [...edges.keys()]
    .filter((k) => k.startsWith(m.id + '->'))
    .map((k) => k.split('->')[1])
    .sort();
  return {
    id: m.id,
    name: m.name,
    status: m.status,
    files: own.length,
    lines: own.reduce((n, f) => n + readFileSync(f, 'utf8').split('\n').length, 0),
    other: countOther(m.paths, m.id),
    deps,
  };
});

const result = {
  baseline: map.baseline,
  modules: stats,
  edges: [...edges.entries()].map(([key, set]) => ({ edge: key, count: set.size })),
  violations,
  unknownFiles,
  deepImports,
  missingDocs,
  missingEntries,
  duplicatePaths,
  cycles,
};

const blocking = violations.length + unknownFiles.length + missingDocs.length + duplicatePaths.length + cycles.length;

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('模块边界报告  baseline=' + map.baseline + '  src=' + files.length + ' files');
  console.log('');
  console.log('模块'.padEnd(14) + '状态'.padEnd(8) + 'ts'.padEnd(5) + '行数'.padEnd(7) + '其它'.padEnd(6) + '依赖');
  for (const s of stats) {
    const st = s.status === 'planned' ? '规划' : s.status === 'current' ? '现行' : (s.status || '-');
    console.log(
      s.id.padEnd(14) +
      st.padEnd(8) +
      String(s.files).padEnd(5) +
      String(s.lines).padEnd(7) +
      String(s.other).padEnd(6) +
      (s.deps.length ? s.deps.join(', ') : '-')
    );
  }
  console.log('（ts = src 下参与依赖分析的文件；其它 = 非 src 文件，只计数不分析）');
  console.log('');
  console.log('跨模块边：' + edges.size + ' 条');
  for (const [key, set] of edges) console.log('  ' + key + '  (' + set.size + ')');
  console.log('');
  const bad = blocking + (strictDeep ? deepImports.length : 0);
  console.log('违规：' + violations.length + '  未归属：' + unknownFiles.length +
    '  缺文档：' + missingDocs.length + '  重复路径：' + duplicatePaths.length + '  环：' + cycles.length);
  if (violations.length) {
    console.log('');
    console.log('违规明细：');
    for (const v of violations) console.log('  x ' + v.edge + '  ' + v.samples.join(' | '));
  }
  if (unknownFiles.length) {
    console.log('');
    console.log('未归属文件：');
    for (const f of unknownFiles) console.log('  ? ' + f);
  }
  if (missingDocs.length) {
    console.log('');
    console.log('缺文档：');
    for (const d of missingDocs) console.log('  ? ' + d);
  }
  if (duplicatePaths.length) {
    console.log('');
    console.log('重复路径：');
    for (const d of duplicatePaths) console.log('  x ' + d);
  }
  if (cycles.length) {
    console.log('');
    console.log('依赖环：');
    for (const c of cycles) console.log('  x ' + c);
  }
  if (deepImports.length) {
    console.log('');
    console.log('深导入（目标模块已有入口后应改为 index.ts）：' + deepImports.length);
    for (const d of deepImports.slice(0, 10)) console.log('  ! ' + d.from + ' -> ' + d.to);
  }
  if (missingEntries.length) {
    console.log('');
    console.log('规划中的入口（P1–P4 落地后创建）：' + missingEntries.length);
    for (const e of missingEntries) console.log('  · ' + e);
  }
  console.log('');
  const deepNote = deepImports.length ? '（深导入 ' + deepImports.length + ' 条待迁移；P7 用 --strict-deep 阻断）' : '';
  console.log(bad === 0 ? 'OK 边界干净' + deepNote : ((strict || strictDeep) ? 'FAIL 有 ' + bad + ' 项需要处理' : 'WARN 有 ' + bad + ' 项（未加 --strict，不阻断）'));
}

if ((strict || strictDeep) && (blocking > 0 || (strictDeep && deepImports.length > 0))) {
  process.exit(1);
}
