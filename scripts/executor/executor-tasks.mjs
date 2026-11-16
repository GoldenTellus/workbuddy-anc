#!/usr/bin/env node
// executor 三个计划任务动作的 Node 版：wake / new-host / host-tick。
//
// 为什么移植：
//   这三个脚本是「主干2 host 自动化」的全部执行面，原先是 Windows 专用 PS：
//   写死 C:\Program Files\nodejs\node.exe、写死 %ProgramData%\anc、依赖 Invoke-RestMethod。
//   换到 macOS 后计划任务由 launchd 拉起（scripts/platform/anc-platform.mjs 的 type:node 动作），
//   必须有一个只依赖 node: 内置模块的入口。因此三份 ps1 的行为合并到这里，用子命令区分。
//
// 与 ps1 的关系（行为源，逐条保留）：
//   scripts/executor/wake-if-queued.ps1  → wake
//     · 先跑 executor expire + executor attention sweep --apply（预算/提醒不依赖 wake bridge）
//     · 没有 token 文件就静默退出；45 秒节流（计划任务每分钟一次，避免重叠刷消息）
//     · 有 queued Ticket 才唤醒；取第一个 active host
//     · conversation_id 是 UUID 才定向 /wake，否则有 workspace 走 /new 兜底，再否则 /wake 当前会话
//     · 调 127.0.0.1:18187 的 wake bridge（X-Anc-Token + JSON，定向 20s / 兜底 20s / 当前 5s 超时）
//     · 成功后写 executor-wake-last.txt；失败只记日志、退出 0
//   scripts/executor/new-host.ps1        → new-host
//     · 每天 03:00 **唯一**允许新建 host 会话的路径；UUID 与会话 id 预生成
//     · 当天已有 active host（business_date >= today）就不建
//     · workspace 必须是绝对路径（显示名会被 WorkBuddy 解析到自动生成工作区，03:00 会悄悄建错 host）
//     · cut-at = 明天 03:00；bridge 返回 ok=false 只记日志；失败退出 0
//   scripts/executor/host-tick.ps1        → host-tick
//     · 兜底：新对话没出现时只标 cut_deferred，旧 host 继续接单
//     · CLI 输出原样追加到 executor-host-tick.log，**退出码透传**（与前两个不同）
//
// 与 ps1 的差异（仅平台适配，不改判断）：
//   · node 用 process.execPath（不再探测 C:\Program Files\nodejs\node.exe）
//   · 日志/状态文件路径由 --root 推导（Windows 默认 %ProgramData%\anc，macOS 走平台层的
//     /Library/Application Support/anc），不再是字面量
//   · workspace 绝对路径判断增加 POSIX 形态（/...）；Windows 的盘符判断不变
//   · wake 提示词里的「任务目录根」默认仍是 D:\anc（与 ps1 逐字一致），macOS 用 --task-root 覆盖
//
// 用法：
//   node scripts/executor/executor-tasks.mjs wake      [--root DIR] [--task-root D:\anc]
//   node scripts/executor/executor-tasks.mjs new-host  [--root DIR] [--now ISO]
//   node scripts/executor/executor-tasks.mjs host-tick [--root DIR]
//
// 退出码：wake / new-host 恒 0（失败只记日志）；host-tick 透传 CLI 退出码；用法错误 2

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sideRoot } from '../platform/anc-platform.mjs';

const WAKE_BRIDGE = 'http://127.0.0.1:18187';
const THROTTLE_SECONDS = 45;
// 真实 WorkBuddy conversation id 是 UUID；旧的 conv-* 是占位 id，不能定向（ps1 注释，照抄）。
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

class UsageError extends Error {}

/** PS `(Get-Date).ToString('o')` 形态，和 deploy-state.mjs 同一个格式。 */
export function psDate(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `.${p(d.getMilliseconds(), 3)}0000${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

/** ps1 的 `$Now.ToString('yyyy-MM-dd')`：本地日期，不是 UTC。 */
export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function ancPaths(root) {
  return {
    root,
    db: join(root, 'data', 'anc.db'),
    token: join(root, 'data', 'wb-wake-token'),
    workspace: join(root, 'data', 'wb-wake-workspace.txt'),
    last: join(root, 'data', 'executor-wake-last.txt'),
    wakeLog: join(root, 'data', 'executor-wake.log'),
    newHostLog: join(root, 'data', 'executor-new-host.log'),
    hostTickLog: join(root, 'data', 'executor-host-tick.log'),
    cli: join(root, 'service', 'cli.ts'),
  };
}

/** ps1 的 Log：写不进去就算了（计划任务里日志目录可能还没建）。 */
export function logTo(file, message, now = new Date()) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${psDate(now)} ${message}\n`, 'utf8');
  } catch { /* 静默：ps1 也是 try/catch 吞掉 */ }
}

function readTrim(file) {
  return readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
}

/**
 * 跑本地小服务 CLI。ps1 的调用形态是 `node --no-warnings <root>\service\cli.ts ...`。
 * 注意：cli.ts 是 TypeScript，Node 22.6–22.17 需要 --experimental-strip-types（22.18+ 默认）；
 * 计划任务的环境里沿用 NODE_OPTIONS，和 ps1 一致，由部署侧负责。
 */
export function runCli(p, args) {
  const r = spawnSync(process.execPath, ['--no-warnings', p.cli, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: r.status ?? 1, text: (r.stdout ?? '') + (r.stderr ?? ''), json: tryJson(r.stdout ?? '') };
}

function tryJson(text) {
  try {
    const v = JSON.parse(String(text).replace(/^\uFEFF/, '').trim());
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

async function postBridge(path, token, body, timeoutMs) {
  const res = await fetch(WAKE_BRIDGE + path, {
    method: 'POST',
    headers: { 'X-Anc-Token': token, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error('bridge HTTP ' + res.status);
  return await res.json();
}

/**
 * wake：每分钟检查 executor 队列；只有 queued Ticket 时才唤醒已有 active host。
 * 失败只记日志、退出 0（ps1 的注释：由下一次 tick 或人来消息兜底）。
 */
export async function wake({ root, taskRoot = 'D:\\anc', now = new Date() } = {}) {
  const p = ancPaths(root);
  try {
    if (!existsSync(p.db)) return 0;
    // 预算/过期扫描独立于 wake bridge：没有 flag/token 也要跑
    runCli(p, ['executor', 'expire', '--db', p.db, '--json']);
    // Attention 2h/8h/24h 提醒与升级：同样不依赖 wake bridge
    runCli(p, ['executor', 'attention', 'sweep', '--apply', '--db', p.db, '--json']);

    if (!existsSync(p.token)) return 0;

    // 45 秒节流：计划任务每分钟一次，避免重叠运行刷消息
    if (existsSync(p.last)) {
      const last = Date.parse(readTrim(p.last));
      if (Number.isFinite(last) && (now.getTime() - last) / 1000 < THROTTLE_SECONDS) return 0;
    }

    const queued = runCli(p, ['executor', 'ticket', 'list', '--state', 'queued', '--db', p.db, '--json']);
    if (!queued.json) throw new Error('ticket list 输出不是 JSON');
    const count = Array.isArray(queued.json.tickets) ? queued.json.tickets.length : 0;
    if (count <= 0) return 0;

    const hs = runCli(p, ['executor', 'host', 'status', '--db', p.db, '--json']);
    if (!hs.json) throw new Error('host status 输出不是 JSON');
    const hosts = Array.isArray(hs.json.hosts) ? hs.json.hosts : [];
    const activeHost = hosts.find((h) => h && h.status === 'active');
    if (!activeHost) return 0;

    const token = readTrim(p.token);
    const workspace = existsSync(p.workspace) ? readTrim(p.workspace) : '';
    const convId = activeHost.conversation_id === null || activeHost.conversation_id === undefined
      ? ''
      : String(activeHost.conversation_id);
    const prompt =
      `[anc-executor] 队列有 ${count} 个 Ticket；active host=${activeHost.host_id}。` +
      `请只做一个 tick：executor claim --host-id ${activeHost.host_id} --limit 1；` +
      `不要 host bootstrap；按 anc-executor 技能用 Agent tool 起 subagent；` +
      `任务目录根是 ${taskRoot}；没有空槽就停止；不要回复用户。`;

    if (UUID_RE.test(convId)) {
      const r = await postBridge('/wake', token, { prompt, conversationId: convId }, 20000);
      logTo(p.wakeLog, `wake-directed host=${activeHost.host_id} conv=${convId} queued=${count} ok=${r.ok} via=${r.via}`, now);
    } else if (workspace) {
      // 旧部署兜底：host 没有真实会话 id，只能 /new（D46 已登记的偏差，不再作为常态）
      const r = await postBridge('/new', token, { prompt, workspace }, 20000);
      logTo(
        p.wakeLog,
        `wake-fallback-new host=${activeHost.host_id} conv=${convId} queued=${count} ok=${r.ok} newconv=${r.conversationId}`,
        now,
      );
    } else {
      const r = await postBridge('/wake', token, { prompt }, 5000);
      logTo(p.wakeLog, `wake-current host=${activeHost.host_id} queued=${count} ok=${r.ok} via=${r.via}`, now);
    }
    writeFileSync(p.last, psDate(now) + '\n', 'utf8');
  } catch (e) {
    // bridge 未启用/窗口不在，静默；由下一次 tick 或人来消息兜底
    logTo(p.wakeLog, 'failed: ' + (e && e.message ? e.message : String(e)), now);
    return 0;
  }
  return 0;
}

/**
 * new-host：03:00 自动创建新 host 对话（**唯一**允许新建 host 会话的路径）。
 * 预生成 UUID，随 bootstrap prompt 传给新会话里的 bot，DB 里的 conversation_id 就是真实会话 id。
 */
export async function newHost({ root, now = new Date() } = {}) {
  const p = ancPaths(root);
  try {
    if (!existsSync(p.db) || !existsSync(p.token) || !existsSync(p.workspace)) return 0;

    const hs = runCli(p, ['executor', 'host', 'status', '--db', p.db, '--json']);
    if (!hs.json) throw new Error('host status 输出不是 JSON');
    const hosts = Array.isArray(hs.json.hosts) ? hs.json.hosts : [];
    const today = localDate(now);
    const already = hosts.filter(
      (h) => h && h.status === 'active' && typeof h.business_date === 'string' && h.business_date >= today,
    ).length;
    if (already > 0) return 0;

    const workspace = readTrim(p.workspace);
    if (!workspace) return 0;
    // wake bridge 2.0 把该值当 host 会话 cwd 传给 conversations.create（D46）。
    // 只接受绝对路径：显示名会被 WorkBuddy 解析到自动生成工作区（或建会话失败），03:00 就会悄悄建错 host。
    // Windows 盘符形态与 ps1 一致；POSIX 形态是 macOS 移植新增。
    if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(workspace)) {
      logTo(p.newHostLog, `invalid workspace (need absolute path, e.g. D:\\workbuddy-anc): ${workspace}`, now);
      return 0;
    }

    const cutAt = psDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 3, 0, 0, 0));
    // 预生成真实会话 id：new-host 只负责"日期边界的新会话"，不负责每个 Ticket
    const conv = randomUUID();
    const title = 'anc-host-' + today;
    const prompt =
      '[anc-executor] 新 host bootstrap。请先执行：' +
      `node ${p.cli} --db ${p.db} --json executor host bootstrap --conversation-id ${conv} ` +
      `--date ${today} --cut-at "${cutAt}"；然后执行一个 executor tick；不要回复用户。`;

    const token = readTrim(p.token);
    const r = await postBridge('/new', token, { prompt, workspace, conversationId: conv, title }, 30000);
    if (!r.ok) {
      logTo(p.newHostLog, `failed: bridge ok=false error=${r.error}`, now);
      return 0;
    }
    logTo(
      p.newHostLog,
      `created workspace=${workspace} conv=${r.conversationId} requested=${conv} title=${title} date=${today} via=${r.via}`,
      now,
    );
  } catch (e) {
    logTo(p.newHostLog, 'failed: ' + (e && e.message ? e.message : String(e)), now);
    return 0;
  }
  return 0;
}

/**
 * host-tick：03:00 兜底；WorkBuddy 新对话没出现时不硬切 host，只标 cut_deferred。
 * 与另外两个不同：CLI 输出原样进日志，**退出码透传**（ps1 的 exit $LASTEXITCODE）。
 */
export function hostTick({ root } = {}) {
  const p = ancPaths(root);
  const r = spawnSync(process.execPath, ['--no-warnings', p.cli, 'executor', 'host', 'tick', '--db', p.db, '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  try {
    mkdirSync(dirname(p.hostTickLog), { recursive: true });
    appendFileSync(p.hostTickLog, out, 'utf8');
  } catch { /* 日志写不进去不改退出码（ps1 的 Out-File 失败会让整条管道报错，这里更宽容） */ }
  return r.status ?? 1;
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === '-h' || raw === '--help') { flags.help = true; continue; }
    if (raw.startsWith('-')) {
      const key = raw.replace(/^-+/, '');
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) { flags[key] = next; i++; }
      else { flags[key] = true; }
    } else {
      positional.push(raw);
    }
  }
  return { cmd: positional[0], flags };
}

export async function main(argv) {
  const { cmd, flags } = parseArgs(argv);
  if (flags.help) {
    process.stdout.write(
      '用法: node executor-tasks.mjs <wake|new-host|host-tick> [--root DIR] [--task-root PATH] [--now ISO]\n',
    );
    return 0;
  }
  const root = flags.root ? String(flags.root) : sideRoot('company');
  if (cmd === 'wake') return wake({ root, taskRoot: flags['task-root'] ? String(flags['task-root']) : undefined });
  if (cmd === 'new-host') {
    const now = flags.now ? new Date(String(flags.now)) : new Date();
    if (Number.isNaN(now.getTime())) throw new UsageError('--now 不是合法时间: ' + flags.now);
    return newHost({ root, now });
  }
  if (cmd === 'host-tick') return hostTick({ root });
  throw new UsageError('未知子命令: ' + (cmd ?? '(空)') + '（wake / new-host / host-tick）');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write('ERROR ' + e.message + '\n');
      process.exit(2);
    }
    throw e;
  }
}
