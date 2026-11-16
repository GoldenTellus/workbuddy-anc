#!/usr/bin/env node
// 部署进度状态（Node 版）—— 让 agent 装到一半失败后能"接着做"，不用从头来。
//
// 为什么移植：
//   这份脚本的调用方是 agent 与 install-company，**每次记账都要跑**。原先只有 PowerShell 实现，
//   在 macOS / CI / 非 Windows 主机上根本起不来（ValidateSet、Join-Path、UTF-8 输出全依赖 PS）。
//   与 scripts/platform/anc-platform.mjs 一起，把「部署记账」变成两平台同一份行为。
//
// 与 ps1 的关系：
//   scripts/deploy/deploy-state.ps1 现在是**薄壳**，按原参数（-Side/-Root/-Mark/...）转调本文件；
//   行为源仍是 ps1（248 行逐字对齐），本文件只是等价实现：
//     - 同一个状态文件 <root>/data/deploy-state.json（UTF-8 无 BOM，临时文件 + rename）
//     - 同一份 Build-View 契约：ok/side/stage/done/failed/error/at/progress/remaining/next/stages
//     - company 14 阶段、employee 9 阶段的 id / 顺序 / title 照抄 ps1
//     - 同一组退出码：0 正常 / 1 有 failed 未处理 / 2 用法错误
//     - next 文案原样保留（含 deploy-kickoff、**不要从头来** 等字样）
//
// 设计原则（ps1 文件头，照抄不解释）：
//   1. 状态文件是唯一真相 —— agent 不看日志猜进度，只读这个 JSON
//   2. 每步显式 mark —— 不去推断"应该算做完了"，由执行者说
//   3. failed 要带 reason —— 重跑时 agent 要知道上次卡在哪、为什么
//   4. 不用锁 —— 两个人同时装一台机器本身就是错的
//
// 用法：
//   node scripts/deploy/deploy-state.mjs --side company --json
//   node scripts/deploy/deploy-state.mjs --side company --mark dirs --as-done --json
//   node scripts/deploy/deploy-state.mjs --side company --mark patch --as-failed --reason "ANCHOR-MISS" --json
//   node scripts/deploy/deploy-state.mjs --side company --reset --apply
//
// 退出码：0 正常（含"全部完成"）/ 1 有 failed 未处理 / 2 用法错误

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sideRoot } from '../platform/anc-platform.mjs';

const SIDES = Object.freeze(['company', 'employee']);

// ── 阶段定义（和 docs/DEPLOY-*.md 的章节一一对应）──────────
// 公司侧顺序与手册一致：装空 WorkBuddy 是「第 0 步」（人做），preflight 在它之后。
// 2026-11-10 修：原来 preflight 排第一，agent 按 state 的 next 推进会先跑前置检查、
// 再回头发现手册要求先装 WorkBuddy，两边对不上。
export const STAGES = Object.freeze({
  company: Object.freeze([
    { id: 'brief', title: '递准备清单给人（§0，deploy-kickoff -Phase prepare）' },
    { id: 'answers', title: '收齐并校验信息（§1，deploy-kickoff -Phase check）' },
    { id: 'workbuddy', title: 'WorkBuddy 已装（§2，第 0 步，人做）' },
    { id: 'preflight', title: '前置检查（§3）' },
    { id: 'dirs', title: '建目录结构（§4）' },
    { id: 'files', title: '部署运行件（§5，deploy.ps1）' },
    { id: 'skills', title: '部署技能（§6，deploy-skills.ps1）' },
    { id: 'patch', title: '打补丁（§7，patch-guard / selfheal）' },
    { id: 'tasks', title: '注册 14 个计划任务（§8）' },
    { id: 'vault', title: '建 vault 两区（§9）' },
    { id: 'org', title: '写 org 数据 + 渲染 persona（§10）' },
    { id: 'wecom', title: '配企微（§11，corpid / 群机器人 webhook）' },
    { id: 'verify', title: '自证（§12，deploy-verify.ps1）' },
    { id: 'executor', title: '主干2 host：加入工作区 + TEST 冒烟（§8.5，部署后自动）' },
  ]),
  employee: Object.freeze([
    { id: 'brief', title: '递准备清单给人（§0，deploy-kickoff -Phase prepare）' },
    { id: 'answers', title: '收齐并校验信息（§1，deploy-kickoff -Phase check）' },
    { id: 'preflight', title: '前置检查（§2）' },
    { id: 'workbuddy', title: 'WorkBuddy 已装并登录（§3）' },
    { id: 'files', title: '部署运行件（§4，deploy.ps1）' },
    { id: 'skills', title: '部署技能（§5）' },
    // 2026-11-12 D54：员工侧不再从公司侧同步渲染产物；
    // persona 由 employee-bootstrap.ps1 本地生成，直接记到 persona 阶段。
    { id: 'persona', title: '本地生成个人 persona（§5.5/§6）' },
    { id: 'bind', title: '绑定本人的群（§7）' },
    { id: 'verify', title: '自证（§8）' },
  ]),
});

/** 阶段 id 表（Mark 的合法值、Build-View 的 remaining 都按它排序）。 */
export function stageIds(side) {
  return STAGES[side].map((s) => s.id);
}

/**
 * PS `(Get-Date).ToString('o')` 的等价格式：`2026-11-16T18:20:00.1234567+08:00`。
 * 为什么不用 toISOString()：状态文件 at 字段被 ps1 的 Get-Content/Parse 和 agent 直接读，
 * 保持同一种"本地时间 + 偏移 + 7 位小数"形态，两个实现写出来的文件才长得一样。
 */
export function psDate(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const frac = p(d.getMilliseconds(), 3) + '0000';
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `.${frac}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

const asText = (v) => (v === null || v === undefined ? '' : String(v));

/** 默认部署根：Windows 沿用 ProgramData/LOCALAPPDATA；macOS 走平台层的 Application Support。 */
export function defaultRoot(side, opts = {}) {
  return sideRoot(side, opts);
}

export function statePath(root) {
  return join(root, 'data', 'deploy-state.json');
}

/** 读状态文件。不存在或损坏一律返回 null（ps1 的 Read-State：损坏不炸，当没开始）。 */
export function readState(file) {
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
    const st = JSON.parse(raw);
    return st && typeof st === 'object' ? st : null;
  } catch {
    return null;
  }
}

/** 写状态文件：UTF-8 无 BOM，先写 .tmp 再 rename（半截文件不会被下一次读当成真相）。 */
export function writeStateFile(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, file);
}

function normalizeDone(st) {
  // ps1：`$doneList = @($st.done)`。单值也会被包成数组，这里照做。
  if (!st || st.done === null || st.done === undefined) return [];
  return Array.isArray(st.done) ? [...st.done] : [st.done];
}

/**
 * 统一的输出构造（三个动作共用同一个契约）。
 * 字段顺序与 ps1 的 [pscustomobject] 字面量一致，agent 侧按字段名读，顺序只影响 diff 可读性。
 */
export function buildView(side, state) {
  const stages = STAGES[side];
  const ids = stageIds(side);
  const doneList = normalizeDone(state);
  const failedId = state ? asText(state.failed) : '';
  const errText = state ? asText(state.error) : '';

  const remaining = stages.filter((s) => !doneList.includes(s.id));
  const nextId = remaining.length ? remaining[0].id : '';
  const nextTitle = remaining.length ? remaining[0].title : '';

  let nextAction;
  if (!state) {
    // 第一步是 brief 不是 preflight：先给人递准备清单，再收信息（GAP-095）。
    nextAction =
      '还没开始。先跑 deploy-kickoff.ps1 -Phase prepare -Side ' +
      side +
      '，把准备清单递给安装人；信息收齐（-Phase check 返回 ok）再往下装。';
  } else if (failedId) {
    nextAction =
      '上次卡在 ' + failedId + '（' + errText + '）。修好之后重跑那一步，再 -Mark ' +
      failedId + ' -AsDone。**不要从头来**。';
  } else if (remaining.length === 0) {
    nextAction = '全部阶段已完成。';
  } else {
    nextAction = '下一步：' + nextId + '（' + nextTitle + '）';
  }

  return {
    ok: !failedId && remaining.length === 0,
    side,
    stage: nextId,
    done: doneList,
    failed: failedId,
    error: errText,
    at: state ? asText(state.at) : '',
    progress: `${doneList.length}/${ids.length}`,
    remaining: remaining.map((s) => s.id),
    next: nextAction,
    stages: stages.map((s) => ({
      id: s.id,
      title: s.title,
      state: doneList.includes(s.id) ? 'done' : failedId === s.id ? 'failed' : 'pending',
    })),
  };
}

/** 人读视图（ps1 的 Show-View，格式逐字对齐：`  [ ] id        title`）。 */
export function formatView(view) {
  const lines = [];
  lines.push(`=== deploy-state (${view.side}) ===`);
  lines.push(`进度 ${view.progress}`);
  lines.push('');
  for (const s of view.stages) {
    const mark = s.state === 'done' ? '[x]' : s.state === 'failed' ? '[!]' : '[ ]';
    lines.push(`  ${mark} ${String(s.id).padEnd(10)} ${s.title}`);
  }
  if (view.failed) {
    lines.push('');
    lines.push(`FAILED  ${view.failed}  ${view.error}`);
  }
  lines.push('');
  lines.push(`NEXT  ${view.next}`);
  return lines.join('\n');
}

class UsageError extends Error {}

function parseArgs(argv) {
  const out = { _: [] };
  const withValue = new Set(['side', 'root', 'mark', 'reason']);
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === '-h' || raw === '--help') { out.help = true; continue; }
    if (!raw.startsWith('-')) { out._.push(raw); continue; }
    const key = raw.replace(/^-+/, '');
    if (withValue.has(key)) {
      const v = argv[i + 1];
      if (v === undefined) throw new UsageError('--' + key + ' 需要一个值');
      out[key] = v;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const knownFlags = new Set([
  'side', 'root', 'mark', 'reason', 'status', 'next', 'reset', 'apply', 'json', 'help',
  'as-done', 'as-failed',
]);

/** 命令行入口：返回进程退出码（0/1/2），不直接 process.exit，方便测试与复用。 */
export function main(argv) {
  const args = parseArgs(argv);
  for (const k of Object.keys(args)) {
    if (k === '_' || knownFlags.has(k)) continue;
    throw new UsageError('未知参数: --' + k);
  }
  if (args.help) {
    process.stdout.write(
      '用法: node deploy-state.mjs [--side company|employee] [--root DIR] [--mark ID --as-done|--as-failed [--reason TEXT]]\n' +
        '                            [--status] [--next] [--reset --apply] [--json]\n',
    );
    return 0;
  }

  const side = args.side ?? 'company';
  if (!SIDES.includes(side)) throw new UsageError('side 必须是 company 或 employee，收到: ' + side);

  const root = args.root ? String(args.root) : defaultRoot(side);
  const file = statePath(root);
  const ids = stageIds(side);

  // ── Reset ───────────────────────────────────────────────
  if (args.reset) {
    if (!args.apply) {
      process.stdout.write('dry-run：加 -Apply 才真删\n');
      return 0;
    }
    if (existsSync(file)) {
      rmSync(file, { force: true });
      process.stdout.write(`已清空 ${file}\n`);
    } else {
      process.stdout.write(`本来就没有 ${file}\n`);
    }
    return 0;
  }

  // ── Mark ────────────────────────────────────────────────
  if (args.mark) {
    const mark = String(args.mark);
    const asDone = args['as-done'] === true;
    const asFailed = args['as-failed'] === true;
    if (!asDone && !asFailed) throw new UsageError('-Mark 要配 -AsDone 或 -AsFailed');
    if (!ids.includes(mark)) {
      throw new UsageError(`未知阶段: ${mark}（可选: ${ids.join(', ')}）`);
    }

    const st = readState(file);
    // ps1 的第一版在这里踩过"单元素数组解包"，表现是第一次 mark 对、之后每次把 done 清空。
    // Node 没有这个坑，但回归测试（deploy-state.test.ts 第 2 条）仍钉住"跨调用累积"。
    const doneList = normalizeDone(st);

    let newFailed = '';
    let newErr = '';
    if (asDone) {
      if (!doneList.includes(mark)) doneList.push(mark);
    } else {
      newFailed = mark;
      newErr = asText(args.reason);
    }

    const doneSorted = ids.filter((id) => doneList.includes(id));
    const remaining = ids.filter((id) => !doneSorted.includes(id));
    const newStage = newFailed || remaining[0] || '';

    const newState = {
      side,
      stage: newStage,
      done: doneSorted,
      failed: newFailed,
      at: psDate(),
      error: newErr,
    };
    writeStateFile(file, newState);

    const view = buildView(side, newState);
    if (!args.json) {
      process.stdout.write(`MARKED  ${mark} → ${asDone ? 'done' : 'FAILED: ' + asText(args.reason)}\n`);
    }
    return emit(view, args.json, asFailed ? 1 : 0);
  }

  // ── Status / Next ───────────────────────────────────────
  // ps1 里 -Status / -Next 只是可读标记，动作相同：读状态、打视图、按 failed 定退出码。
  const view = buildView(side, readState(file));
  return emit(view, args.json, view.failed ? 1 : 0);
}

function emit(view, json, code) {
  if (json) process.stdout.write(JSON.stringify(view, null, 2) + '\n');
  else process.stdout.write(formatView(view) + '\n');
  return code;
}

// 直接执行时才进入 CLI；被 import（测试、其他脚本）时不退出进程。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    if (e instanceof UsageError) {
      // 用法错误给人话，不甩堆栈：这条路径会被 agent 直接读。
      process.stderr.write('ERROR ' + e.message + '\n');
      process.exit(2);
    }
    throw e;
  }
}
