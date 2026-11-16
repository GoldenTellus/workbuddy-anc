#!/usr/bin/env node
// 部署引擎（跨平台）：把仓库里的运行件复制到部署根。
//
// 真相源：scripts/deploy/deploy.ps1 的 $Map / $BinScripts / $ToolScripts / $NotDeployed。
// 本文件读它的结构化镜像 scripts/deploy/deploy-manifest.json；两份漂移由
// scripts/checks/check-platform-parity.mjs 拦，不靠人记。
//
// 为什么有这一份：
//   deploy.ps1 是 PowerShell 5.1 + Windows 路径（%ProgramData%、schtasks、ACL），macOS 上跑不了。
//   但「哪些文件、落到哪、怎么对拍、怎么回滚」跟平台无关 —— 这部分在两边必须是同一套语义，
//   所以抽成零依赖 Node ESM：Windows（Node 22）和 macOS 共用，ps1 仍是 Windows 的正式入口。
//
// 平台过滤（2026-11-16 加，双平台）：
//   清单里两种位置都可以写 `"Platforms": ["darwin"]`：
//     - 映射项（map[]）：整条映射只在列出的平台部署；
//     - 白名单项（Only / binScripts / toolScripts）：{ "Path": "...", "Platforms": ["darwin"] } 只在那几个平台部署。
//   缺省（不写 Platforms）= 两边都部署。过滤依据是 --platform，缺省 = process.platform。
//   Windows 侧不需要这套字段：deploy.ps1 的清单里根本不放 darwin-only 项，所以它的行为不变。
//
// 用法：
//   node scripts/deploy/deploy.mjs --root /tmp/anc-t              # dry-run（默认，只看计划）
//   node scripts/deploy/deploy.mjs --root /tmp/anc-t --apply      # 落盘：备份 → 复制 → sha256 对拍
//   node scripts/deploy/deploy.mjs --root /tmp/anc-t --rollback   # 按当前清单还原最近一次备份
//   node scripts/deploy/deploy.mjs --json ...                     # stdout 只输出一个 JSON 对象
//   node scripts/deploy/deploy.mjs --platform win32               # 在 mac 上预演 Windows 会铺什么
//
//   选项：--repo <含 .git 的目录>（默认从本文件向上找）/ --root <部署根>（默认按 --side 取标准位置）
//         --side company|employee（默认 company）/ --platform win32|darwin|linux（默认 process.platform）
//         --manifest <清单路径>（默认同目录 deploy-manifest.json）
//
// 退出码（与 deploy.ps1 逐位一致）：
//   0 成功（含 dry-run 与回滚）
//   1 落盘后校验失败且已回滚（或回滚动作失败）
//   2 用法或环境错误（清单/源目录/脚本缺失、公司侧根不存在、src 有未覆盖文件）
//   3 复制失败且已回滚
//
// 与 deploy.ps1 的**有意差异**（都写在这里，避免后人以为漏了）：
//   1. bin\ 里「不在运行清单的脚本」只报告不移动：ps1 会移到 backup\migrate-<stamp>\bin\，
//      移动是破坏性动作；Node 侧先在计划里列出来（staleBin），要不要搬由人决定。
//   2. 回滚清理「本次新建的目录」时只删空目录：ps1 用 Remove-Item -Recurse，目录里一旦
//      有别的进程写进东西就会被一起删掉。
//   3. 显式 --root 不存在时自动建（ps1 对 company 侧一律拒绝）：显式路径就是调用者的意图；
//      用默认根时仍沿用 ps1 的保护（company 侧不存在 = 装错机器，直接报错）。
//   4. 同一秒内重复 --apply 时备份目录追加 -2/-3…：ps1 会撞进同一个 deploy-<stamp>，
//      第二次部署的「回滚」会还原到第二次之前，而不是第一次之前。
//   5. 复制时保留源文件的权限位（macOS 上 .sh 启动器要可执行才能被 launchd 直接 exec）；
//      Windows 上 chmod 无意义，跳过。
//
// 测试缝：环境变量 ANC_DEPLOY_FAULT=copy|verify 在复制/校验阶段注入一次失败，
// 专门给 scripts/platform/deploy.test.mjs 验「失败整体回滚」。生产路径不设这个变量等于不存在。

import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SIDES, sideRoot } from '../platform/anc-platform.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MANIFEST = join(HERE, 'deploy-manifest.json');
const DEFAULT_SIDE = 'company';

/** 清单里允许出现的平台名（与 anc-platform.mjs 的 OS 一致，外加 linux 只做识别）。 */
export const PLATFORMS = Object.freeze(['win32', 'darwin', 'linux']);

// ── 错误：带「怎么修」，与 ps1 的 Fail($msg, $fix, $code) 同构 ──
export class DeployError extends Error {
  constructor(message, fix, code = 2) {
    super(message);
    this.name = 'DeployError';
    this.fix = fix;
    this.code = code;
  }
}

// ── 平台过滤 ──────────────────────────────────────────────
/** 规范化 Platforms：null/缺省 = 不限制；空数组视为写错（比"谁都不部署"好查）。 */
export function normalizePlatforms(value, where) {
  if (value == null) return null;
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0) throw new DeployError(where + ' 的 Platforms 不能是空数组', '不限制平台就把 Platforms 整个删掉', 2);
  for (const p of list) {
    if (!PLATFORMS.includes(p)) {
      throw new DeployError(where + ' 的 Platforms 值不认识: ' + p, '只允许 ' + PLATFORMS.join(' / '), 2);
    }
  }
  return [...new Set(list)];
}

/** 这个平台能不能部署（Platforms 为空/缺省 = 所有平台都行）。 */
export function platformAllows(platforms, platform) {
  return !platforms || platforms.includes(platform);
}

/** 白名单项：字符串（全平台）或 {"Path": ..., "Platforms": [...]}。统一成 {Path, Platforms|null}。 */
export function normalizeWhiteItem(item, where) {
  if (typeof item === 'string') return { Path: item, Platforms: null };
  if (item && typeof item === 'object' && typeof item.Path === 'string') {
    return { Path: item.Path, Platforms: normalizePlatforms(item.Platforms, where) };
  }
  throw new DeployError(where + ' 的条目既不是字符串也不是 {Path, Platforms}: ' + JSON.stringify(item),
    '写成 "a/b.ps1"（两平台）或 {"Path": "a/b.ps1", "Platforms": ["darwin"]}（仅 darwin）', 2);
}

function normalizeWhiteList(list, where) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new DeployError(where + ' 必须是数组', '白名单写成 ["a/b.ps1", …]', 2);
  return list.map((item, i) => normalizeWhiteItem(item, where + '[' + i + ']'));
}

// ── 清单 ──────────────────────────────────────────────────
/**
 * 读清单并规范化：白名单项统一成 {Path, Platforms}，映射项的 Platforms 校验一遍，
 * 缺键按「不限制/不递归/不扁平」补默认值。**不猜**未知键 ——
 * 清单是 ps1 的镜像，多出来的键说明有人手改过，直接报错比静默忽略好。
 */
export function loadManifest(path = DEFAULT_MANIFEST) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new DeployError('读不了部署清单: ' + path + '（' + e.message + '）', '确认 --manifest 指向 deploy-manifest.json，且文件是合法 JSON、不带 BOM', 2);
  }
  const map = Array.isArray(raw.map) ? raw.map : null;
  if (!map || map.length === 0) throw new DeployError('部署清单没有 map: ' + path, '清单必须包含 map 数组（镜像 deploy.ps1 的 $Map）', 2);
  const known = new Set(['Target', 'Source', 'Filter', 'Exclude', 'Recurse', 'Flatten', 'Only', 'Platforms']);
  for (const [i, m] of map.entries()) {
    for (const k of Object.keys(m)) {
      if (!known.has(k)) throw new DeployError('清单 map[' + i + '] 有未知键: ' + k, '只允许 Target/Source/Filter/Exclude/Recurse/Flatten/Only/Platforms', 2);
    }
    if (!m.Target || !m.Source || !Array.isArray(m.Filter)) {
      throw new DeployError('清单 map[' + i + '] 缺 Target/Source/Filter', '逐项照抄 deploy.ps1 的 $Map（Platforms 可选）', 2);
    }
  }
  return {
    map,
    binScripts: normalizeWhiteList(raw.binScripts, 'binScripts'),
    toolScripts: normalizeWhiteList(raw.toolScripts, 'toolScripts'),
    notDeployed: Array.isArray(raw.notDeployed) ? raw.notDeployed : [],
  };
}

// ── 通配：PowerShell -like 语义（大小写不敏感；* 任意串、? 单字符、[abc]/[a-z] 字符类）──
export function matchGlob(name, pattern) {
  const p = String(pattern);
  let re = '';
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (inClass) {
      if (c === ']') { inClass = false; re += ']'; continue; }
      re += c === '!' ? '^' : c;
      continue;
    }
    if (c === '[') { inClass = true; re += '['; continue; }
    if (c === '*') { re += '.*'; continue; }
    if (c === '?') { re += '.'; continue; }
    re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i').test(name);
}

export function matchAny(patterns, name) {
  return (patterns ?? []).some((p) => matchGlob(name, p));
}

// ── 目录遍历 ──────────────────────────────────────────────
/** 列目录下的文件（绝对路径，按名字排序，与 Get-ChildItem 的可预期顺序对齐）。 */
export function walkFiles(dir, { recurse = false } = {}) {
  const out = [];
  const names = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of names) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (recurse) out.push(...walkFiles(p, { recurse: true }));
      continue;
    }
    // 符号链接按文件处理：copyFile 会跟随内容，与 Copy-Item 一致
    if (e.isFile() || e.isSymbolicLink()) out.push(p);
  }
  return out;
}

function toPosix(p) {
  return p.split(sep).join('/');
}

function toNative(root, relPosix) {
  return join(root, ...relPosix.split('/').filter(Boolean));
}

export function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

// ── 计划 ──────────────────────────────────────────────────
/**
 * 把清单展开成「源文件 → 落盘相对路径」的完整计划，并把 deploy.ps1 的三项自检一起做掉：
 *   - 清单里写了的脚本必须真实存在（改名忘了改清单 = 部署成功但少一个文件）；
 *   - src 下每个非测试 .ts 必须能落到某个映射里（否则线上 import 直接 ERR_MODULE_NOT_FOUND）；
 *   - scripts 下未归类的脚本要报出来（不会部署，但必须让人看见）。
 *
 * 平台过滤只影响「这次铺哪些文件」：别的平台的项进 skipped（dry-run 逐条打印原因），
 * 但**不影响** src 覆盖判定 —— 覆盖看的是「有没有部署目标」，不是「当前平台铺不铺」。
 *
 * @param {{repo: string, manifest: object, root?: string, platform?: string}} opts
 *   root 给了才填 dst（纯清单检查不需要）；platform 缺省 process.platform。
 * @returns {{files: Array<{target: string, rel: string, src: string, dst: string|null, dstRel: string, bytes: number, hash: string}>,
 *            groups: Array<{target: string, count: number, bytes: number}>, totalBytes: number,
 *            errors: string[], warnings: string[], uncovered: string[], missingDeclared: string[],
 *            unclassified: string[], skipped: Array<{target: string, rel: string, reason: string, path: string}>,
 *            platform: string}}
 */
export function buildPlan({ repo, manifest, root = null, platform = process.platform }) {
  const errors = [];
  const warnings = [];
  const missingDeclared = [];
  const skipped = [];

  // 清单里声明过的脚本，不分平台都得真实存在（少一个 = 线上少一个文件）
  for (const [kind, list] of [['bin', manifest.binScripts], ['tools', manifest.toolScripts]]) {
    for (const item of list) {
      if (!existsSync(toNative(join(repo, 'scripts'), item.Path))) missingDeclared.push(kind + '/' + item.Path);
    }
  }
  if (missingDeclared.length) {
    errors.push('部署清单里有不存在的脚本: ' + missingDeclared.join(', ')
      + '（改名后同步改 deploy.ps1 与 deploy-manifest.json；故意不部署的放进 $NotDeployed）');
  }

  const files = [];
  const byRel = new Map();
  const covered = new Set(); // 所有平台合起来有部署目标的源文件（判 src 覆盖用）

  for (const m of manifest.map) {
    const srcDir = toNative(repo, m.Source);
    if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
      errors.push('源目录不存在: ' + m.Source + '（确认 --repo 指向仓库根）');
      continue;
    }
    const entryPlatforms = normalizePlatforms(m.Platforms, 'map[' + m.Target + '].Platforms');
    const only = Array.isArray(m.Only) ? normalizeWhiteList(m.Only, m.Target + '.Only') : null;
    const onlyByPath = only ? new Map(only.map((i) => [i.Path, i.Platforms])) : null;

    for (const abs of walkFiles(srcDir, { recurse: m.Recurse === true })) {
      const relPath = toPosix(relative(srcDir, abs));
      const name = basename(abs);
      let itemPlatforms = null;
      if (onlyByPath) {
        // 显式清单：清单外的文件不部署（清单用 / 分隔，两个平台同一套写法）
        if (!onlyByPath.has(relPath)) continue;
        itemPlatforms = onlyByPath.get(relPath);
      }
      if (!matchAny(m.Filter, name)) continue;
      if (matchAny(m.Exclude, name)) continue;

      // 落盘相对路径：bin/tools 扁平（只留文件名），其余保留源目录下的结构。
      // 保留结构是硬要求：模块子目录被拍平会让相对 import 断链。
      const dstRel = m.Flatten === true ? name : relPath;
      const rel = m.Target + '/' + dstRel;
      covered.add(abs);

      // 平台不符：记下原因（dry-run 要逐条打印 skip: platforms=darwin），但不进本次计划
      const blockedBy = !platformAllows(entryPlatforms, platform)
        ? entryPlatforms
        : !platformAllows(itemPlatforms, platform)
          ? itemPlatforms
          : null;
      if (blockedBy) {
        skipped.push({ target: m.Target, rel, reason: 'platforms=' + blockedBy.join(','), path: toPosix(relative(repo, abs)) });
        continue;
      }

      if (byRel.has(rel)) {
        errors.push('落盘路径冲突: ' + rel + '（' + byRel.get(rel) + ' 与 ' + toPosix(relative(repo, abs)) + '）');
        continue;
      }
      byRel.set(rel, toPosix(relative(repo, abs)));
      files.push({
        target: m.Target,
        rel,
        src: abs,
        dst: root ? toNative(root, rel) : null,
        dstRel,
        bytes: statSync(abs).size,
        hash: sha256File(abs),
      });
    }
  }

  // src 覆盖检查（比 ps1 更严：ps1 只查「是否在某个源目录下」，这里查「是否真的进了计划」）
  const srcRoot = join(repo, 'src');
  const uncovered = [];
  if (existsSync(srcRoot)) {
    for (const abs of walkFiles(srcRoot, { recurse: true })) {
      if (!/\.ts$/i.test(abs) || /\.test\.ts$/i.test(abs)) continue;
      if (!covered.has(abs)) uncovered.push(toPosix(relative(repo, abs)));
    }
    if (uncovered.length) {
      errors.push('这些源文件没有部署目标: ' + uncovered.join(', ')
        + '（在 deploy.ps1 的 $Map 里加一条并同步清单，否则线上 import 失败）');
    }
  }

  // 未归类提醒：scripts 下既不在 bin 也不在 tools 的脚本不会部署（只提醒，不失败）
  const declaredAll = new Set([...manifest.binScripts, ...manifest.toolScripts].map((i) => i.Path));
  const notDeployed = new Set(manifest.notDeployed);
  const scriptsRoot = join(repo, 'scripts');
  const unclassified = [];
  if (existsSync(scriptsRoot)) {
    for (const abs of walkFiles(scriptsRoot, { recurse: true })) {
      if (!/\.(ps1|cmd|vbs|sh)$/i.test(abs)) continue;
      const rel = toPosix(relative(scriptsRoot, abs));
      if (rel.startsWith('workbuddy-patch/')) continue; // 走单独的 patch 映射
      if (notDeployed.has(rel)) continue;
      if (!declaredAll.has(rel)) unclassified.push('scripts/' + rel);
    }
    if (unclassified.length) {
      warnings.push('这些脚本没有归到 bin 或 tools，不会部署: ' + unclassified.join(', ')
        + '（要部署就加进 $BinScripts/$ToolScripts 并同步清单）');
    }
  }

  const groups = [];
  for (const f of files) {
    const g = groups.find((x) => x.target === f.target);
    if (g) { g.count++; g.bytes += f.bytes; } else groups.push({ target: f.target, count: 1, bytes: f.bytes });
  }
  const totalBytes = files.reduce((n, f) => n + f.bytes, 0);
  return { files, groups, totalBytes, errors, warnings, uncovered, missingDeclared, unclassified, skipped, platform };
}

/** bin/ 里不在运行清单里的脚本（只读报告；ps1 会搬走，这里不搬）。 */
export function findStaleBin(root, manifest, platform = process.platform) {
  const binDir = join(root, 'bin');
  if (!existsSync(binDir)) return [];
  const wanted = new Set(manifest.binScripts
    .filter((i) => platformAllows(i.Platforms, platform))
    .map((i) => basename(i.Path)));
  return walkFiles(binDir)
    .filter((abs) => /\.(ps1|cmd|vbs|sh)$/i.test(abs))
    .filter((abs) => !wanted.has(basename(abs)))
    .map((abs) => basename(abs))
    .sort();
}

// ── 时间戳 / 目录 / 复制 ──────────────────────────────────
/** 与 ps1 的 Get-Date -Format 'yyyyMMdd-HHmmss' 一致（本地时间）。 */
export function stampNow(d = new Date()) {
  const n = (v, w = 2) => String(v).padStart(w, '0');
  return n(d.getFullYear(), 4) + n(d.getMonth() + 1) + n(d.getDate()) + '-' + n(d.getHours()) + n(d.getMinutes()) + n(d.getSeconds());
}

function ensureDirRecorded(dir, created) {
  if (existsSync(dir)) return;
  ensureDirRecorded(dirname(dir), created);
  mkdirSync(dir);
  created.push(dir);
}

/**
 * 复制并保留权限位。macOS 上是硬需求：`<root>/bin/anc-launch.sh` 会被 launchd 直接 exec，
 * 丢了 +x 的表现是「任务注册成功但从不触发」。Windows 上 chmod 无意义，跳过。
 */
function copyWithMode(src, dst) {
  copyFileSync(src, dst);
  if (process.platform === 'win32') return;
  chmodSync(dst, statSync(src).mode & 0o777);
}

// ── 回滚（Restore-Deploy 的等价物）────────────────────────
/**
 * 把 items 里每个目标恢复到备份；备份里没有的目标 = 本次新增 → 删除。
 * 只动计划里的文件，绝不递归删目录（data/backup/secrets 不能碰）。
 * @returns {string[]} 失败项（空数组 = 回滚完整）
 */
export function restore(items, backupRoot, createdDirs = []) {
  const failed = [];
  for (const p of items) {
    const b = join(backupRoot, ...p.rel.split('/'));
    try {
      if (existsSync(b)) {
        ensureDirRecorded(dirname(p.dst), []);
        copyWithMode(b, p.dst);
      } else if (existsSync(p.dst)) {
        unlinkSync(p.dst);
      }
    } catch (e) {
      failed.push(p.dst + '：' + e.message);
    }
  }
  // 本次新建的目录：只删空目录，深的先删
  for (const d of [...createdDirs].reverse()) {
    try {
      if (existsSync(d)) rmdirSync(d);
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTEMPTY') failed.push(d + '：' + e.message);
    }
  }
  return failed;
}

// ── CLI ───────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { apply: false, rollback: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--rollback') out.rollback = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--repo' || a === '--root' || a === '--side' || a === '--manifest' || a === '--platform') {
      const v = argv[i + 1];
      // 空串也拒：--root '' 会被 resolve 成当前目录，等于把运行时件铺进仓库
      if (v === undefined || v === '' || v.startsWith('--')) throw new DeployError(a + ' 需要一个值', '例如 ' + a + ' <path>', 2);
      out[a.slice(2)] = v;
      i++;
    } else throw new DeployError('未知参数: ' + a, '支持 --repo --root --side --platform --apply --rollback --json --manifest --help', 2);
  }
  if (out.apply && out.rollback) throw new DeployError('--apply 与 --rollback 不能同时用', '先回滚，再单独跑一次 --apply', 2);
  return out;
}

function findRepo(start) {
  let d = start;
  while (d) {
    if (existsSync(join(d, '.git'))) return d;
    const p = dirname(d);
    if (p === d) break;
    d = p;
  }
  return start;
}

const USAGE = [
  '用法: node scripts/deploy/deploy.mjs [--repo <仓库根>] [--side company|employee] [--platform win32|darwin]',
  '                                      [--root <部署根>] [--apply | --rollback] [--json] [--manifest <清单>]',
  '',
  '默认 dry-run，只打印计划（含按平台跳过的项）；--apply 落盘前备份到 <root>/backup/deploy-<stamp>/，',
  '落盘后逐文件 sha256 对拍，任何一步失败整体回滚；--rollback 按当前清单还原最近一次备份。',
  '--platform 缺省 = 当前系统；清单里 Platforms 不匹配的项只打 skip，不落盘。',
  '退出码: 0 成功 / 1 对拍失败且已回滚 / 2 用法或环境错误 / 3 复制失败且已回滚',
].join('\n');

function groupLines(plan) {
  return plan.groups.map((g) => g.target.padEnd(9) + ' ' + String(g.count).padStart(3) + ' 个文件  ' + String(g.bytes).padStart(9) + ' B');
}

/** 一次运行的结果收集器：文本模式逐行打印，--json 模式只在最后吐一个对象。 */
function makeReporter(json) {
  const result = { ok: true };
  return {
    result,
    say(line = '') { if (!json) process.stdout.write(line + '\n'); },
    set(k, v) { result[k] = v; },
    finish(obj) {
      Object.assign(result, obj);
      if (json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return result.ok ? 0 : result.code;
    },
  };
}

export function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const rep = makeReporter(args.json);
  const side = args.side ?? DEFAULT_SIDE;
  if (!SIDES.includes(side)) throw new DeployError('side 必须是 company 或 employee，收到: ' + side, '--side company 或 --side employee', 2);
  const platform = args.platform ?? process.platform;
  if (!PLATFORMS.includes(platform)) throw new DeployError('platform 只认 ' + PLATFORMS.join(' / ') + '，收到: ' + platform, '例如 --platform darwin', 2);

  // --repo 可以指向仓库里任意子目录：向上找到 .git 才算根（与 ps1 的 -Repo 语义一致）
  const repo = findRepo(args.repo ? resolve(process.cwd(), args.repo) : HERE);
  if (!existsSync(join(repo, '.git'))) {
    throw new DeployError('不是仓库根: ' + repo, '用 --repo 指向仓库根（含 .git 的目录）', 2);
  }
  const manifest = loadManifest(args.manifest ? resolve(process.cwd(), args.manifest) : DEFAULT_MANIFEST);
  const explicitRoot = typeof args.root === 'string';
  const root = explicitRoot ? resolve(process.cwd(), args.root) : sideRoot(side);
  const plan = buildPlan({ repo, manifest, root, platform });
  if (plan.errors.length) throw new DeployError(plan.errors.join('; '), '清单、源目录或清单里的脚本修好后重跑', 2);
  if (plan.files.length === 0) throw new DeployError('没有可部署的文件', '检查 --repo 与源目录', 2);

  const notes = [];
  const staleBin = findStaleBin(root, manifest, platform);

  // 部署根：company 侧默认位置不存在 = 装错机器（与 ps1 一致，不自动建空壳）；
  // 显式 --root / 员工侧则按需创建。
  if (!existsSync(root)) {
    if (!explicitRoot && side === 'company') {
      throw new DeployError('部署根不存在: ' + root,
        '先按 docs/DEPLOY-COMPANY.md §4 建公司侧部署根（目录、ACL、vault 盘）；员工侧用 --side employee，或显式传 --root', 2);
    }
    if (args.apply) {
      mkdirSync(root, { recursive: true });
      notes.push('已创建部署根: ' + root);
    } else {
      notes.push('注意：部署根还不存在，--apply 时会创建: ' + root);
    }
  }

  rep.set('side', side);
  rep.set('platform', platform);
  rep.set('repo', repo);
  rep.set('root', root);
  rep.set('total', plan.files.length);
  rep.set('totalBytes', plan.totalBytes);
  rep.set('groups', plan.groups);
  rep.set('skipped', plan.skipped);
  rep.set('warnings', [...plan.warnings]);
  rep.set('notes', notes);

  // ── 回滚 ────────────────────────────────────────────────
  if (args.rollback) {
    const bakParent = join(root, 'backup');
    const baks = existsSync(bakParent)
      ? readdirSync(bakParent, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^deploy-/.test(e.name))
        .map((e) => e.name)
        .sort()
        .reverse()
      : [];
    if (baks.length === 0) {
      // 首次部署没有旧文件可备份：回滚 = 按当前清单删除本次铺下去的文件，回到「没装」状态。
      rep.say('没有部署备份（首次部署）：按当前清单删除已部署文件，回到部署前');
      let removed = 0;
      const failed = [];
      for (const p of plan.files) {
        if (!existsSync(p.dst)) continue;
        try { unlinkSync(p.dst); removed++; } catch (e) { failed.push(p.dst + '：' + e.message); }
      }
      if (failed.length) {
        throw new DeployError('首次部署回滚失败 ' + failed.length + ' 项: ' + failed.join('; '), '逐项手工删除上面列出的文件', 1);
      }
      rep.say('OK：首次部署回滚完成，删除 ' + removed + ' 个文件（data/backup/secrets 未动）');
      return rep.finish({ mode: 'rollback', firstDeploy: true, backup: null, restored: 0, removed });
    }
    const backup = join(bakParent, baks[0]);
    rep.say('回滚源: ' + backup);
    let restored = 0;
    let removed = 0;
    const failed = [];
    for (const p of plan.files) {
      const b = join(backup, ...p.rel.split('/'));
      try {
        if (existsSync(b)) {
          ensureDirRecorded(dirname(p.dst), []);
          copyWithMode(b, p.dst);
          restored++;
        } else if (existsSync(p.dst)) {
          unlinkSync(p.dst);
          removed++;
        }
      } catch (e) {
        failed.push(p.dst + '：' + e.message);
      }
    }
    if (failed.length) {
      throw new DeployError('回滚失败 ' + failed.length + ' 项: ' + failed.join('; '), '备份目录未删除；可手工按上面路径恢复', 1);
    }
    rep.say('OK：已回滚到 ' + backup + '（恢复 ' + restored + ' 个，删除新增 ' + removed + ' 个）');
    rep.say('提示：回滚后 WorkBuddy/任务可能仍在跑旧进程，按 OPS 重启任务或补丁启动器；确认后可再 --apply。');
    return rep.finish({ mode: 'rollback', firstDeploy: false, backup, restored, removed });
  }

  // ── 计划摘要（dry-run 与 apply 都先打印）────────────────
  for (const line of groupLines(plan)) rep.say(line);
  rep.say('合计 ' + plan.files.length + ' 个文件，目标根 ' + root + '（platform=' + platform + '）');
  rep.say();
  for (const n of notes) rep.say(n);
  for (const s of plan.skipped) rep.say('skip: ' + s.reason + '  ' + s.rel + '（' + s.path + '）');
  if (plan.skipped.length) rep.say();
  for (const w of plan.warnings) rep.say('WARN ' + w);
  if (staleBin.length) {
    rep.say('注意：bin/ 里有 ' + staleBin.length + ' 个不在运行清单里的脚本（' + staleBin.join(', ') + '）');
    rep.say('     部署引擎不会搬动它们；确认后手工清理（ps1 的 -Apply 会移到 backup/migrate-<stamp>/bin/）');
    rep.say();
  }

  if (!args.apply) {
    rep.say('DRY-RUN：以上是计划，加 --apply 才落盘。');
    return rep.finish({ mode: 'dry-run', backup: null, staleBin, files: plan.files.map((f) => ({ target: f.target, rel: f.rel, src: toPosix(relative(repo, f.src)), dst: toPosix(relative(root, f.dst)), hash: f.hash, bytes: f.bytes })) });
  }

  // ── 落盘 ────────────────────────────────────────────────
  const stamp = stampNow();
  let backup = join(root, 'backup', 'deploy-' + stamp);
  if (existsSync(backup)) {
    let n = 2;
    while (existsSync(backup + '-' + n)) n++;
    backup = backup + '-' + n;
  }
  mkdirSync(backup, { recursive: true });

  const createdDirs = [];
  const copied = [];
  const fault = process.env.ANC_DEPLOY_FAULT ?? '';
  const failCopyAt = fault === 'copy' ? Math.min(2, plan.files.length) : 0;

  try {
    for (const p of plan.files) {
      ensureDirRecorded(dirname(p.dst), createdDirs);
      if (existsSync(p.dst)) {
        const bak = join(backup, ...p.rel.split('/'));
        ensureDirRecorded(dirname(bak), []);
        copyWithMode(p.dst, bak);
      }
      copyWithMode(p.src, p.dst);
      copied.push(p);
      if (failCopyAt && copied.length === failCopyAt) throw new Error('注入的复制失败（ANC_DEPLOY_FAULT=copy）');
    }
  } catch (e) {
    const failed = restore(copied, backup, createdDirs);
    if (failed.length) {
      throw new DeployError('复制失败: ' + e.message,
        '回滚不完整（' + failed.length + ' 项失败）：' + failed.join('; ') + '；需手工从 ' + backup + ' 恢复', 3);
    }
    rep.say('ERROR 复制失败: ' + e.message);
    rep.say('FIX   已回滚 ' + copied.length + ' 个已写入文件；备份在 ' + backup);
    return rep.finish({ ok: false, code: 3, mode: 'apply', error: e.message, rolledBack: true, backup, copied: copied.length });
  }

  if (fault === 'verify' && plan.files.length) {
    writeFileSync(plan.files[0].dst, Buffer.concat([readFileSync(plan.files[0].dst), Buffer.from('fault\n')]));
  }

  // 逐文件对拍
  const bad = [];
  for (const p of plan.files) {
    if (!existsSync(p.dst)) { bad.push(p.dst + '（缺失）'); continue; }
    if (sha256File(p.dst) !== p.hash) bad.push(p.dst + '（hash 不一致）');
  }
  if (bad.length) {
    const failed = restore(plan.files, backup, createdDirs);
    if (failed.length) {
      throw new DeployError('落盘后校验失败: ' + bad.join('; '),
        '回滚不完整（' + failed.length + ' 项失败）：' + failed.join('; ') + '；需手工从 ' + backup + ' 恢复', 1);
    }
    rep.say('ERROR 落盘后校验失败: ' + bad.join('; '));
    rep.say('FIX   已回滚；备份在 ' + backup);
    return rep.finish({ ok: false, code: 1, mode: 'apply', error: '落盘后校验失败', bad, rolledBack: true, backup });
  }

  rep.say('OK：' + plan.files.length + ' 个文件已部署并逐一校验通过。备份: ' + backup);
  return rep.finish({ mode: 'apply', backup, copied: copied.length, verified: plan.files.length, staleBin });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const json = process.argv.slice(2).includes('--json');
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    if (e instanceof DeployError) {
      if (json) {
        process.stdout.write(JSON.stringify({ ok: false, code: e.code, error: e.message, fix: e.fix }) + '\n');
      } else {
        process.stderr.write('ERROR ' + e.message + '\n');
        process.stderr.write('FIX   ' + e.fix + '\n');
      }
      process.exitCode = e.code;
    } else {
      process.stderr.write('ERROR 未预期的失败: ' + (e && e.stack ? e.stack : e) + '\n');
      process.exitCode = 2;
    }
  }
}
