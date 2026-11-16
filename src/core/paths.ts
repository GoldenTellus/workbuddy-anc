// 平台底座：部署根与标准路径（运行时侧的唯一来源）。
//
// 为什么单独一份：这类代码以前是散在 8 个文件里的
//   join(process.env.ProgramData ?? 'C:\\ProgramData', 'anc', ...)
// 在 Windows 上刚好对，换到 macOS 就变成「在仓库里建一个叫 C:\ProgramData 的目录」——
// 不报错，但所有状态都落在工作副本里，部署/备份/权限全错位。
//
// 规则与 scripts/platform/anc-platform.mjs **逐条一致**（ops 层部署前就要算根路径，
// 不能依赖 src 已铺好）。两份实现由 scripts/platform/platform.test.mjs 的跨层对拍钉住：
// 改这里必须同步改那边，否则测试红。
//
// 方言（与 Windows 侧文档一致，不改名）：
//   company  → Windows %ProgramData%\anc              macOS /Library/Application Support/anc
//   employee → Windows %LOCALAPPDATA%\anc             macOS ~/Library/Application Support/anc

import { homedir } from 'node:os';
import { join } from 'node:path';

export type Side = 'company' | 'employee';
export type Os = 'win32' | 'darwin' | 'linux';

export interface PathOpts {
  os?: string;
  env?: Record<string, string | undefined>;
  homedir?: string;
}

/** 部署根（anc 根目录）。side 缺省由 ANC_SIDE 决定，再缺省按公司侧（常驻主机是主形态）。 */
export function sideRoot(side: Side = sideFromEnv(), opts: PathOpts = {}): string {
  const os = opts.os ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.homedir ?? homedir();

  if (os === 'win32') {
    // ProgramData / LOCALAPPDATA 被精简镜像设成空串时要兜住，所以用 || 而不是 ??。
    if (side === 'company') return join(env.ProgramData || 'C:\\ProgramData', 'anc');
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'anc');
  }
  if (os === 'darwin') {
    if (side === 'company') return '/Library/Application Support/anc';
    return join(home, 'Library', 'Application Support', 'anc');
  }
  return join(home, '.local', 'share', 'anc');
}

/** 从环境变量解析 side：只认 company / employee，其余按 company（与脚本默认值一致）。 */
export function sideFromEnv(env: Record<string, string | undefined> = process.env): Side {
  const v = String(env.ANC_SIDE ?? '').trim().toLowerCase();
  return v === 'employee' ? 'employee' : 'company';
}

/** vault 默认位置：Windows 公司侧按历史习惯在 D: 盘；macOS 用 /Users/Shared（多用户公共区）。 */
export function defaultVaultRoot(side: Side = sideFromEnv(), opts: PathOpts = {}): string {
  const os = opts.os ?? process.platform;
  const home = opts.homedir ?? homedir();
  if (side === 'employee') return join(home, 'anc');
  if (os === 'win32') return 'D:\\anc';
  return '/Users/Shared/anc';
}

export interface AncPaths {
  root: string;
  data: string;
  secrets: string;
  bin: string;
  tools: string;
  service: string;
  interfaces: string;
  core: string;
  modules: string;
  shared: string;
  patch: string;
  inbox: string;
  render: string;
  light: string;
  backup: string;
  ingest: string;
  accounts: string;
  evals: string;
  stage: string;
  skills: string;
}

/** 部署根下的标准子目录（名字与 scripts/platform/anc-platform.mjs 的 ancPaths 一致）。 */
export function ancPaths(root: string): AncPaths {
  const p = (name: string) => join(root, name);
  return {
    root,
    data: p('data'),
    secrets: p('secrets'),
    bin: p('bin'),
    tools: p('tools'),
    service: p('service'),
    interfaces: p('interfaces'),
    core: p('core'),
    modules: p('modules'),
    shared: p('shared'),
    patch: p('patch'),
    inbox: p('inbox'),
    render: p('render'),
    light: p('light'),
    backup: p('backup'),
    ingest: p('ingest'),
    accounts: p('accounts'),
    evals: p('evals'),
    stage: p('stage'),
    skills: p('skills'),
  };
}

/**
 * 数据库路径。ANC_DB 优先（测试与故障注入用），否则 <root>/data/anc.db。
 * 注意：这是**函数**而不是常量 —— 每次调用重新读环境，
 * 免得测试改 process.env 之后还拿到导入时算好的旧值（原来的 DEFAULT_DB 就有这个问题）。
 */
export function defaultDbPath(opts: PathOpts & { side?: Side } = {}): string {
  const explicit = (opts.env ?? process.env).ANC_DB;
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  return join(ancPaths(sideRoot(opts.side ?? sideFromEnv(), opts)).data, 'anc.db');
}
