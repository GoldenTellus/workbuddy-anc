#!/usr/bin/env node
// 平台一致性检查（转目录前/每次改平台层或清单后都要跑）：通过时零输出、退出码 0（与 check-public 同风格）。
//
// 两类漂移会静默出事，所以各有一条绊线：
//
//   1. src/core/paths.ts ↔ scripts/platform/anc-platform.mjs
//      运行时要算部署根，ops 层部署前也要算；两份实现必须逐字符一致。
//      Node 22.14 不能直接 import .ts，所以 src 侧用子进程
//      `node --experimental-strip-types -e "import(...)"` 取结果，与 ops 层逐项比对。
//      比对四组：win32/company、win32/employee、darwin/company、darwin/employee
//      的 sideRoot / defaultVaultRoot / ancPaths（键集合与每个值）。
//
//   2. scripts/deploy/deploy.ps1 ↔ scripts/deploy/deploy-manifest.json ↔ 真实文件系统
//      ps1 是 Windows 侧清单真相源；manifest 是它的镜像 + darwin-only 追加项。
//      这里直接正则解析 ps1 的 $Map/$BinScripts/$ToolScripts/$NotDeployed，
//      把 manifest **投影到 win32**（丢掉 Platforms 含 darwin 的项）后与 ps1 逐项比，
//      再让 deploy.mjs 的 buildPlan 分别铺一遍 win32 与 darwin：
//      源文件都在、src 下非测试 .ts 全覆盖、清单里的脚本都存在、两个平台计划都非空、
//      darwin 计划必须是 win32 计划的超集（只有 darwin 多出来，不许反过来少）。
//
// 退出码：0 通过（无输出）/ 1 有漂移（逐条列出，含差集）。

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ancPaths as ancAncPaths,
  defaultVaultRoot as ancDefaultVaultRoot,
  sideRoot as ancSideRoot,
} from '../platform/anc-platform.mjs';
import {
  buildPlan,
  loadManifest,
  normalizePlatforms,
  normalizeWhiteItem,
  platformAllows,
} from '../deploy/deploy.mjs';

const toPosix = (s) => String(s).replace(/\\/g, '/');

/** ps1 是 Windows 的真相源：manifest 投影到这个平台后与它逐项比。 */
const PS1_PLATFORM = 'win32';

// ── 1. ps1 清单解析 ────────────────────────────────────────
/**
 * 解析 deploy.ps1 里的四份清单。只认 ps1 里**实际存在**的写法：
 *   $X = @( 'a/b', 'c/d' )                   → 字符串数组
 *   $Map = @( @{ Target = '...'; ... }, ... ) → 哈希表数组
 * 不追求通用 PowerShell 解析器：清单格式变了这里会直接报错，比猜错好。
 */
export function parsePs1Deploy(text) {
  const src = String(text).replace(/\r\n?/g, '\n');
  const stripComments = (s) => s.replace(/#.*$/gm, '');

  function stringsBlock(name) {
    const re = new RegExp('\\$' + name + '\\s*=\\s*@\\(([\\s\\S]*?)\\n\\)', 'm');
    const m = src.match(re);
    if (!m) throw new Error('deploy.ps1 里找不到 $' + name + ' = @( ... )');
    return [...stripComments(m[1]).matchAll(/'([^']*)'/g)].map((x) => toPosix(x[1]));
  }

  const binScripts = stringsBlock('BinScripts');
  const toolScripts = stringsBlock('ToolScripts');
  const notDeployed = stringsBlock('NotDeployed');

  const mapMatch = src.match(/\$Map\s*=\s*@\(([\s\S]*?)\n\)\n/);
  if (!mapMatch) throw new Error('deploy.ps1 里找不到 $Map = @( ... ) 块');

  const value = (raw) => {
    const v = String(raw).trim();
    if (v === '$true') return true;
    if (v === '$false') return false;
    if (v === '$BinScripts') return binScripts;
    if (v === '$ToolScripts') return toolScripts;
    if (v.startsWith('@(')) {
      const inner = v.slice(2, v.lastIndexOf(')'));
      return [...inner.matchAll(/'([^']*)'/g)].map((x) => toPosix(x[1]));
    }
    const str = v.match(/^'([^']*)'$/);
    if (str) return toPosix(str[1]);
    throw new Error('deploy.ps1 清单里有解析不了的值: ' + raw);
  };

  const map = [...mapMatch[1].matchAll(/@\{([\s\S]*?)\}/g)].map((g, i) => {
    const entry = {};
    for (const part of stripComments(g[1]).split(';')) {
      const p = part.trim();
      if (!p) continue;
      const kv = p.match(/^([A-Za-z]+)\s*=\s*([\s\S]+)$/);
      if (!kv) throw new Error('deploy.ps1 $Map[' + i + '] 有解析不了的键值: ' + p);
      entry[kv[1]] = value(kv[2]);
    }
    return entry;
  });

  return { map, binScripts, toolScripts, notDeployed };
}

/**
 * 统一形状：缺省 Recurse/Flatten = false，Only 缺省 = null，路径正斜杠；
 * Only 项统一成 {Path, Platforms}（ps1 里只有字符串 = 全平台）。
 */
export function normalizeMapEntry(m) {
  const only = m.Only == null
    ? null
    : (Array.isArray(m.Only) ? m.Only : [m.Only]).map((item, i) => normalizeWhiteItem(item, 'Only[' + i + ']'));
  return {
    Target: toPosix(m.Target ?? ''),
    Source: toPosix(m.Source ?? ''),
    Filter: (m.Filter ?? []).map(toPosix),
    Exclude: (m.Exclude ?? []).map(toPosix),
    Recurse: m.Recurse === true,
    Flatten: m.Flatten === true,
    Only: only,
    Platforms: normalizePlatforms(m.Platforms, 'Platforms'),
  };
}

function setDiff(a, b) {
  const bs = new Set(b);
  return a.filter((x) => !bs.has(x));
}

/** 白名单投影到某平台：只留该平台能部署的路径（Platforms 缺省 = 全平台）。 */
export function projectWhiteList(list, platform) {
  return list.filter((i) => platformAllows(i.Platforms, platform)).map((i) => i.Path);
}

// ── 2. manifest ↔ ps1（投影到 Windows 再比）───────────────
/** @returns {string[]} 漂移清单（空 = 一致） */
export function compareManifestToPs1(manifest, ps1) {
  const out = [];
  const ps1Map = ps1.map.map(normalizeMapEntry);
  const ourMapAll = (manifest.map ?? []).map(normalizeMapEntry);
  // darwin-only 的映射 ps1 里本来就没有（ps1 只铺 Windows 能跑的东西），不算漂移
  const ourMap = ourMapAll.filter((m) => platformAllows(m.Platforms, PS1_PLATFORM));

  if (ps1Map.length !== ourMap.length) {
    out.push('$Map 条数不一致: ps1=' + ps1Map.length + '，manifest(win32 投影)=' + ourMap.length);
  }
  const n = Math.max(ps1Map.length, ourMap.length);
  for (let i = 0; i < n; i++) {
    const a = ps1Map[i];
    const b = ourMap[i];
    if (!a || !b) {
      out.push('$Map[' + i + '] 只在' + (a ? ' ps1' : ' manifest(win32 投影)') + '里存在: ' + JSON.stringify(a ?? b));
      continue;
    }
    for (const key of ['Target', 'Source', 'Filter', 'Exclude', 'Recurse', 'Flatten']) {
      const av = JSON.stringify(a[key]);
      const bv = JSON.stringify(b[key]);
      if (av !== bv) out.push('$Map[' + i + '].' + key + ' 漂了: ps1=' + av + '，manifest=' + bv);
    }
    const aOnly = JSON.stringify(a.Only == null ? null : a.Only.map((i2) => i2.Path));
    const bOnly = JSON.stringify(b.Only == null ? null : projectWhiteList(b.Only, PS1_PLATFORM));
    if (aOnly !== bOnly) out.push('$Map[' + i + '].Only(win32) 漂了: ps1=' + aOnly + '，manifest=' + bOnly);
  }

  for (const [name, ps1List, ours] of [
    ['$BinScripts', ps1.binScripts, manifest.binScripts ?? []],
    ['$ToolScripts', ps1.toolScripts, manifest.toolScripts ?? []],
    ['$NotDeployed', ps1.notDeployed, (manifest.notDeployed ?? []).map((p) => ({ Path: toPosix(p), Platforms: null }))],
  ]) {
    const paths = ours.map((i) => i.Path);
    const dup = paths.filter((x, i) => paths.indexOf(x) !== i);
    if (dup.length) out.push(name + ' 在 manifest 里重复: ' + [...new Set(dup)].join(', '));
    const ps1Dup = ps1List.filter((x, i) => ps1List.indexOf(x) !== i);
    if (ps1Dup.length) out.push(name + ' 在 ps1 里重复: ' + [...new Set(ps1Dup)].join(', '));

    // 投影到 Windows 才与 ps1 可比：darwin-only 项 ps1 侧不该有
    const win = projectWhiteList(ours, PS1_PLATFORM);
    const onlyPs1 = setDiff(ps1List, win);
    const onlyManifest = setDiff(win, ps1List);
    if (onlyPs1.length) out.push(name + ' 只在 ps1 里: ' + onlyPs1.join(', '));
    if (onlyManifest.length) out.push(name + ' 只在 manifest(win32 投影) 里: ' + onlyManifest.join(', '));
    if (!onlyPs1.length && !onlyManifest.length && JSON.stringify(ps1List) !== JSON.stringify(win)) {
      out.push(name + ' 集合一致但顺序不同（清单是镜像，顺序也要一致）: ps1=' + JSON.stringify(ps1List) + '，manifest(win32)=' + JSON.stringify(win));
    }
  }

  // 路径写法：清单一律正斜杠（Windows 侧 ps1 用反斜杠，两边靠归一化对齐）
  for (const [i, m] of ourMapAll.entries()) {
    for (const [k, v] of Object.entries(m)) {
      const vals = Array.isArray(v) ? v.flatMap((x) => (x && typeof x === 'object' ? [x.Path] : [x])) : [v];
      for (const x of vals) {
        if (typeof x === 'string' && x.includes('\\')) out.push('manifest map[' + i + '].' + k + ' 用了反斜杠: ' + x + '（清单必须正斜杠）');
      }
    }
  }

  // bin/tools 的 Only 必须与顶层白名单逐项相同（含 Platforms、顺序）——否则 deploy.mjs 与 ps1 会铺不同的文件
  const byTarget = new Map(ourMapAll.map((m) => [m.Target, m]));
  for (const [target, expected] of [['bin', manifest.binScripts ?? []], ['tools', manifest.toolScripts ?? []]]) {
    const m = byTarget.get(target);
    if (!m) { out.push('manifest 缺 ' + target + ' 映射'); continue; }
    if (JSON.stringify(m.Only) !== JSON.stringify(expected)) {
      out.push(target + ' 映射的 Only 与 ' + (target === 'bin' ? 'binScripts' : 'toolScripts') + ' 不一致（必须逐项相同、顺序相同，含 Platforms）');
    }
    if (m.Flatten !== true) out.push(target + ' 映射必须 Flatten=true（任务与 .cmd 按 <root>/' + target + '/<文件名> 引用）');
    // 白名单项必须落在 scripts/ 下（Only 是相对 scripts/ 的路径）
    for (const item of expected) {
      if (item.Path.startsWith('/') || item.Path.includes('../')) out.push(target + ' 白名单项必须是 scripts/ 下的相对路径: ' + item.Path);
    }
  }

  return out;
}

// ── 3. manifest ↔ 真实文件系统（复用部署引擎的计划逻辑，两个平台各跑一遍）──
export function checkManifestAgainstRepo(manifest, repo, platforms = [PS1_PLATFORM, 'darwin']) {
  const failures = [];
  const plans = new Map();
  for (const platform of platforms) {
    let plan;
    try {
      plan = buildPlan({ repo, manifest, platform });
    } catch (e) {
      failures.push('[' + platform + '] buildPlan 失败: ' + e.message);
      continue;
    }
    plans.set(platform, plan);
    for (const err of plan.errors) failures.push('[' + platform + '] ' + err);
    if (plan.files.length === 0) failures.push('[' + platform + '] 部署计划为空（清单与仓库不匹配）');
  }

  // 平台差异只能单向：darwin 计划 ⊇ win32 计划（只许多，不许少）
  const win = plans.get(PS1_PLATFORM);
  const mac = plans.get('darwin');
  if (win && mac) {
    const macRels = new Set(mac.files.map((f) => f.rel));
    const lostOnMac = win.files.map((f) => f.rel).filter((r) => !macRels.has(r));
    if (lostOnMac.length) failures.push('这些文件 Windows 会铺、macOS 不铺（Platforms 写反了？）: ' + lostOnMac.join(', '));
    const winRels = new Set(win.files.map((f) => f.rel));
    const onlyMac = mac.files.map((f) => f.rel).filter((r) => !winRels.has(r));
    if (onlyMac.length === 0) failures.push('macOS 计划没有比 Windows 多任何文件（darwin-only 项丢了？）');
  }

  // 每个映射的源目录都必须存在且是目录
  for (const m of manifest.map ?? []) {
    const dir = join(repo, ...toPosix(m.Source).split('/'));
    if (!existsSync(dir)) failures.push('源目录不存在: ' + m.Source);
  }
  // 清单里的脚本必须真实存在（不分平台：声明了就得有，否则另一个平台会少文件）
  for (const rel of manifest.binScripts ?? []) {
    if (!existsSync(join(repo, 'scripts', ...rel.Path.split('/')))) failures.push('bin 清单里的脚本不存在: scripts/' + rel.Path);
  }
  for (const rel of manifest.toolScripts ?? []) {
    if (!existsSync(join(repo, 'scripts', ...rel.Path.split('/')))) failures.push('tools 清单里的脚本不存在: scripts/' + rel.Path);
  }
  // $NotDeployed 里的脚本：故意不部署，但文件应该还在（删了就该从清单里去掉）
  for (const rel of manifest.notDeployed ?? []) {
    if (!existsSync(join(repo, 'scripts', ...toPosix(rel).split('/')))) failures.push('$NotDeployed 里的脚本不存在: scripts/' + rel + '（删了就从清单里去掉）');
  }
  // 未归类提醒不进失败项：开发期常有临时脚本（ps1 也是 WARN 不是 Fail）
  return [...new Set(failures)];
}

// ── 4. src/core/paths.ts ↔ anc-platform.mjs ───────────────
const PARITY_GROUPS = Object.freeze([
  { os: 'win32', side: 'company', env: { ProgramData: 'C:\\ProgramData', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, homedir: 'C:\\Users\\u' },
  { os: 'win32', side: 'employee', env: { ProgramData: 'C:\\ProgramData', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, homedir: 'C:\\Users\\u' },
  { os: 'darwin', side: 'company', env: {}, homedir: '/Users/example' },
  { os: 'darwin', side: 'employee', env: {}, homedir: '/Users/example' },
]);

/** 子进程里跑 src 侧：Node 22.14 不能直接 import .ts，必须走 --experimental-strip-types。 */
function srcSideFacts(pathsTs) {
  const url = pathToFileURL(pathsTs).href;
  const code = [
    'const groups = ' + JSON.stringify(PARITY_GROUPS) + ';',
    'import(' + JSON.stringify(url) + ').then((m) => {',
    '  const out = groups.map((g) => {',
    '    const root = m.sideRoot(g.side, g);',
    '    return { os: g.os, side: g.side, root, vault: m.defaultVaultRoot(g.side, g), paths: m.ancPaths(root) };',
    '  });',
    '  process.stdout.write(JSON.stringify(out));',
    '}).catch((e) => {',
    '  process.stderr.write(String((e && e.stack) || e));',
    '  process.exit(1);',
    '});',
  ].join('\n');
  const out = execFileSync(process.execPath, ['--no-warnings', '--experimental-strip-types', '-e', code], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

/** @returns {string[]} 漂移清单（空 = 四组逐项一致） */
export function checkSrcParity(repo) {
  const pathsTs = join(repo, 'src', 'core', 'paths.ts');
  if (!existsSync(pathsTs)) return ['src/core/paths.ts 不存在（运行时的路径来源没了）'];

  let facts;
  try {
    facts = srcSideFacts(pathsTs);
  } catch (e) {
    const err = String(e.stderr || e.message || e).trim().slice(0, 800);
    return ['取 src 侧路径失败（子进程 --experimental-strip-types 出错）: ' + err];
  }

  const out = [];
  for (const g of PARITY_GROUPS) {
    const label = g.os + '/' + g.side;
    const srcFact = facts.find((f) => f.os === g.os && f.side === g.side);
    if (!srcFact) { out.push(label + ': src 侧没返回这一组'); continue; }

    const ancRoot = ancSideRoot(g.side, g);
    const ancVault = ancDefaultVaultRoot(g.side, g);
    if (srcFact.root !== ancRoot) out.push(label + '.sideRoot 漂了: src=' + srcFact.root + '，ops=' + ancRoot);
    if (srcFact.vault !== ancVault) out.push(label + '.defaultVaultRoot 漂了: src=' + srcFact.vault + '，ops=' + ancVault);

    const ancP = ancAncPaths(ancRoot);
    const srcKeys = Object.keys(srcFact.paths ?? {}).sort();
    const ancKeys = Object.keys(ancP).sort();
    const onlySrc = setDiff(srcKeys, ancKeys);
    const onlyAnc = setDiff(ancKeys, srcKeys);
    if (onlySrc.length) out.push(label + '.ancPaths 只在 src 里: ' + onlySrc.join(', '));
    if (onlyAnc.length) out.push(label + '.ancPaths 只在 ops 里: ' + onlyAnc.join(', '));
    for (const k of ancKeys) {
      if (!(k in (srcFact.paths ?? {}))) continue;
      if (srcFact.paths[k] !== ancP[k]) out.push(label + '.ancPaths.' + k + ' 漂了: src=' + srcFact.paths[k] + '，ops=' + ancP[k]);
    }
  }
  return out;
}

// ── main ──────────────────────────────────────────────────
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

export function run(root) {
  const failures = [];

  const ps1Path = join(root, 'scripts', 'deploy', 'deploy.ps1');
  const manifestPath = join(root, 'scripts', 'deploy', 'deploy-manifest.json');
  if (!existsSync(ps1Path)) failures.push('scripts/deploy/deploy.ps1 不存在（清单真相源没了）');
  if (!existsSync(manifestPath)) failures.push('scripts/deploy/deploy-manifest.json 不存在');

  if (!failures.length) {
    let ps1;
    let manifest;
    try {
      ps1 = parsePs1Deploy(readFileSync(ps1Path, 'utf8'));
    } catch (e) {
      failures.push('解析 deploy.ps1 失败: ' + e.message);
    }
    try {
      manifest = loadManifest(manifestPath);
    } catch (e) {
      failures.push('读 deploy-manifest.json 失败: ' + e.message);
    }
    if (ps1 && manifest) {
      failures.push(...compareManifestToPs1(manifest, ps1));
      failures.push(...checkManifestAgainstRepo(manifest, root));
    }
  }

  failures.push(...checkSrcParity(root));
  return failures;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const root = findRoot(import.meta.dirname);
  const failures = run(root);
  if (failures.length) {
    // 只报位置与差集，不回显文件内容
    console.log('FAIL 平台一致性检查 ' + failures.length + ' 条：');
    for (const f of failures) console.log('  ! ' + f);
    process.exitCode = 1;
  }
  // 通过时零输出
}
