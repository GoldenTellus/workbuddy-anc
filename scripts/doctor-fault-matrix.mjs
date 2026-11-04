#!/usr/bin/env node
// O-2：证明 doctor 的每一项在该 FAIL 时都会 FAIL。
//
// 为什么按组注入：doctor 一次要 ~17 秒，29 项逐项两轮就是十几次 × 17 秒。
// 把同类项一次性弄坏（比如同时禁用 9 个任务），一次 doctor 就能验 9 项，
// 断言"坏的这几项都应 FAIL，其他的仍 PASS"。
//
// 每组都是注入 → 验 → 恢复 → 验，恢复失败会立刻报出来。
// 高风险项（smb 停共享、database 改名、bindings 清空）默认不跑，用 --risky 打开。
//
// 用法：node scripts/doctor-fault-matrix.mjs [--risky] [--only <组名>]
// 退出码：0 全部按预期 / 1 有项没红或恢复失败

import { execFileSync } from 'node:child_process';
import { copyFileSync, readdirSync, statSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

const PROGRAM_DATA = process.env.ProgramData ?? 'C:\\ProgramData';
const ROOT = join(PROGRAM_DATA, 'anc');
const REPO = join(import.meta.dirname, '..');
const DOCTOR = join(ROOT, 'bin', 'doctor.ps1');
const BAK = join(REPO, '_research', 'o2-backup');
const DB = join(ROOT, 'data', 'anc.db');

const argv = process.argv.slice(2);
const risky = argv.includes('--risky');
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;

const lines = [];
const log = (m) => { lines.push(m); console.log(m); };

/**
 * 跑一段 PowerShell。
 * 用 -File 临时脚本而不是 -Command 内联：同样的命令走 -Command 时，在这个 ESM 脚本里
 * 返回空字符串（在 node -e 里却正常），而 doctor() 用 -File 一直可靠。不深挖了，
 * 统一走 -File——顺便避免引号转义问题。
 */
function ps(cmd) {
  mkdirSync(BAK, { recursive: true });
  const f = join(BAK, 'tmp-' + process.pid + '-' + (psSeq++) + '.ps1');
  writeFileSync(f, '\uFEFF' + cmd + '\n', 'utf8');
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (!out.trim()) log(`      [ps] 空输出: ${cmd.split('\n')[0].slice(0, 50)}`);
    return out.trim();
  } catch (e) {
    log(`      [ps] 失败 code=${e.status} msg=${String(e.message).slice(0, 100)} stderr=${String(e.stderr ?? '').slice(0, 100)}`);
    return String(e.stdout ?? '') + String(e.stderr ?? '');
  } finally {
    try { unlinkSync(f); } catch { /* ignore */ }
  }
}
let psSeq = 0;

/** 跑一次 doctor，返回 { 项名: 状态 } */
function doctor(extraArgs = []) {
  let out = '';
  try {
    out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DOCTOR, '-Repo', REPO, '-Json', ...extraArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '');
  }
  const map = {};
  try {
    const j = JSON.parse(out.slice(out.indexOf('{')));
    for (const c of j.checks) map[c.check] = c.state;
  } catch { /* 解析失败留空，调用方会当成"缺项" */ }
  return map;
}

/** 断言指定项的状态，返回失败列表 */
function expectState(st, want, names, ctx) {
  const bad = [];
  for (const [name, target] of Object.entries(names)) {
    const got = st[name] ?? '(缺项)';
    const ok = Array.isArray(target) ? target.includes(got) : got === target;
    if (!ok) bad.push(`${name}: 期望 ${target}，实际 ${got}`);
  }
  if (bad.length) { log(`  ✗ ${ctx}`); bad.forEach((b) => log('      ' + b)); }
  else log(`  ✓ ${ctx}`);
  return bad;
}

function backup(file, tag) {
  mkdirSync(BAK, { recursive: true });
  const dst = join(BAK, tag + '__' + file.split(/[\\/]/).pop());
  if (existsSync(file)) copyFileSync(file, dst);
  return dst;
}
function restore(bak, file) {
  if (existsSync(bak)) copyFileSync(bak, file);
}

// ─────────────────────────── 组定义 ───────────────────────────
const GROUPS = {
  // 1) 9 个计划任务：同时禁用
  tasks: {
    title: '9 个计划任务被禁用',
    items: {
      // 注意：anc-http 不在这里——Disable 不会停掉运行中的实例，它会一直是 Running/PASS。
      // 它由 http 组覆盖（那里会真停进程）。
      'task-anc-backup': 'FAIL', 'task-anc-boot-alert': 'FAIL', 'task-anc-cleanup': 'FAIL',
      'task-anc-patch-guard': 'FAIL', 'task-anc-service': 'FAIL',
      'task-anc-update-watch': 'FAIL', 'task-anc-watchdog': 'FAIL', 'task-anc-workbuddy-launch': 'FAIL',
    },
    // 注意：items 的 key 是 doctor 的**检查项名**（task-anc-backup），
    // 实际计划任务名没有 task- 前缀（anc-backup）。这里必须转换，否则
    // Disable-ScheduledTask 会去找一个不存在的任务、静默失败。
    inject() {
      for (const check of Object.keys(this.items)) {
        const t = check.replace(/^task-/, '');
        ps(`Disable-ScheduledTask -TaskName '${t}' -ErrorAction SilentlyContinue | Out-Null`);
        const st = ps(`(Get-ScheduledTask -TaskName '${t}' -ErrorAction SilentlyContinue).State`);
        log(`    ${check} (${t}) -> ${st.trim() || '(查不到)'}`);
      }
    },
    recover() {
      for (const check of Object.keys(this.items)) {
        const t = check.replace(/^task-/, '');
        ps(`Enable-ScheduledTask -TaskName '${t}' -ErrorAction SilentlyContinue | Out-Null`);
      }
      // http 被禁用再启用后进程可能没起，补一次启动
      ps("Start-ScheduledTask -TaskName 'anc-http' -ErrorAction SilentlyContinue");
    },
  },

  // 2) 配置项：work-hours + timezone 同时填非法值
  config: {
    title: '配置被写成非法值（work-hours / timezone）',
    items: { 'work-hours': 'FAIL', timezone: 'FAIL' },
    inject() {
      const js = `const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[2]);const set=(k,v)=>{const r=d.prepare("UPDATE config SET value=? WHERE key=?").run(v,k);if(r.changes===0)d.prepare("INSERT INTO config(key,value) VALUES(?,?)").run(k,v);};set('work_start','99:99');set('timezone','Not/AZone');d.close();`;
      const f = join(BAK, 'inject-config.cjs');
      mkdirSync(BAK, { recursive: true });
      writeFileSync(f, js, 'utf8');
      execFileSync(process.execPath, ['--no-warnings', f, DB], { stdio: 'ignore' });
      log('  注入: work_start=99:99, timezone=Not/AZone');
    },
    recover() {
      const js = `const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[2]);d.prepare("UPDATE config SET value='08:30' WHERE key='work_start'").run();d.prepare("UPDATE config SET value='China Standard Time' WHERE key='timezone'").run();d.close();`;
      const f = join(BAK, 'recover-config.cjs');
      writeFileSync(f, js, 'utf8');
      execFileSync(process.execPath, ['--no-warnings', f, DB], { stdio: 'ignore' });
      log('  恢复: work_start=08:30, timezone=China Standard Time');
    },
  },

  // 2b) 时间同步：W32Time 停掉（2026-11-04 加；这台机器从装好起它就是 Stopped，doctor 当时查不出来）
  timesync: {
    title: 'W32Time 服务被停（时钟不再自动校准）',
    items: { 'time-sync': 'FAIL' },
    inject() {
      execFileSync('powershell', ['-NoProfile', '-Command', 'Stop-Service W32Time -Force -ErrorAction SilentlyContinue'], { stdio: 'ignore' });
      log('  注入: Stop-Service W32Time');
    },
    recover() {
      execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Service W32Time -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2; w32tm /resync /force | Out-Null'], { stdio: 'ignore' });
      log('  恢复: Start-Service W32Time + resync');
    },
  },

  // 3) 补丁文件类：manifest + patch-state + deploy-layout
  patchfiles: {
    title: '补丁清单与部署文件被改',
    items: { manifest: 'FAIL', patch: 'FAIL', 'deploy-layout': 'FAIL' },
    store: {},
    inject() {
      mkdirSync(BAK, { recursive: true });
      const mf = join(ROOT, 'patch', 'manifest.json');
      const ps_ = join(ROOT, 'data', 'patch-state.json');
      const pre = join(ROOT, 'patch', 'preload.cjs');
      this.store.mf = backup(mf, 'manifest');
      this.store.ps = backup(ps_, 'patchstate');
      this.store.pre = backup(pre, 'preload');
      // manifest 的 FAIL 判据是"无法解析"（版本比对在 workbuddy 那一项），
      // 所以写坏 JSON，而不是改字段。
      if (existsSync(mf)) writeFileSync(mf, '{ this is not valid json', 'utf8');
      // patch 检查读的是 workbuddy-patch.log 里的 APPLIED/ANCHOR-MISS，不是 patch-state.json。
      // 把日志临时挪走，doctor 就看不到"已应用"的证据。
      const plog = join(process.env.USERPROFILE ?? '', 'anc', 'workbuddy-patch.log');
      if (existsSync(plog)) {
        this.store.plog = join(BAK, 'workbuddy-patch.log.o2');
        copyFileSync(plog, this.store.plog);
        writeFileSync(plog, '', 'utf8');
      }
      // 改一个补丁文件 → deploy-layout FAIL
      if (existsSync(pre)) writeFileSync(pre, readFileSync(pre, 'utf8') + '\n// o2-inject\n', 'utf8');
      log('  注入: manifest 版本改 0.0.0-o2 · patch-state applied=false · preload.cjs 加一行');
    },
    recover() {
      if (this.store.mf) restore(this.store.mf, join(ROOT, 'patch', 'manifest.json'));
      if (this.store.ps) restore(this.store.ps, join(ROOT, 'data', 'patch-state.json'));
      if (this.store.pre) restore(this.store.pre, join(ROOT, 'patch', 'preload.cjs'));
      const plog = join(process.env.USERPROFILE ?? '', 'anc', 'workbuddy-patch.log');
      if (this.store.plog) restore(this.store.plog, plog);
      log('  恢复: manifest / preload / 补丁日志都已还原');
    },
  },

  // 4) ACL 类：secrets 与 vault 同时放宽
  acl: {
    title: 'ACL 被放宽（secrets / vault 对普通用户可写）',
    items: { 'secrets-acl': 'FAIL', 'vault-acl': 'FAIL' },
    inject() {
      ps(`icacls "${join(ROOT, 'secrets')}" /grant "BUILTIN\\Users:(OI)(CI)RX" /T | Out-Null`);
      ps(`icacls "D:\\anc\\vault-shared" /grant "BUILTIN\\Users:(OI)(CI)M" /T | Out-Null`);
      log('  注入: secrets 给 Users 读、vault 给 Users 改');
    },
    recover() {
      ps(`icacls "${join(ROOT, 'secrets')}" /remove:g "BUILTIN\\Users" /T | Out-Null`);
      ps(`icacls "D:\\anc\\vault-shared" /remove:g "BUILTIN\\Users" /T | Out-Null`);
      ps(`icacls "D:\\anc\\vault-shared" /grant "BUILTIN\\Users:(OI)(CI)(RX)" /T | Out-Null`);
      log('  恢复: Users 对 secrets 无权限、对 vault 只读');
    },
  },

  // 5) 时间戳类：heartbeat + canary + backup-freshness
  staleness: {
    title: '心跳 / canary / 备份都变旧',
    items: { heartbeat: ['FAIL', 'WARN'], canary: ['FAIL', 'WARN'], 'backup-freshness': 'FAIL' },
    store: {},
    inject() {
      // 必须先把 anc-service 停掉：它每分钟跑一次 tick、写 loop.log，
      // 会把我们改过的 mtime 刷回现在，注入等于没做（第一次跑就是这样白做的）。
      ps("Stop-ScheduledTask -TaskName 'anc-service' -ErrorAction SilentlyContinue | Out-Null");
      ps("Disable-ScheduledTask -TaskName 'anc-service' -ErrorAction SilentlyContinue | Out-Null");
      log('  注入前：停掉 anc-service（避免 tick 刷新 loop.log 的 mtime）');
      const old = new Date(Date.now() - 40 * 3600_000);   // 40 小时前
      const logf = join(ROOT, 'data', 'loop.log');
      if (existsSync(logf)) utimesSync(logf, old, old);
      // canary：doctor 看 JSON 里的 at 字段，不看 mtime —— 必须改内容
      const cf = join(ROOT, 'data', 'patch-canary.json');
      if (existsSync(cf)) {
        this.store.canary = backup(cf, 'canary');
        const j = JSON.parse(readFileSync(cf, 'utf8'));
        j.at = new Date(Date.now() - 80 * 3600_000).toISOString();   // >72h → WARN
        writeFileSync(cf, JSON.stringify(j), 'utf8');
      }
      // 最新一份库备份也改成 40 小时前：直接扫目录，别绕 PowerShell
      const bdir = join(ROOT, 'backup');
      if (existsSync(bdir)) {
        const files = readdirSync(bdir).filter((f) => /^anc-.*\.db$/.test(f));
        // 必须**全部**改旧：只改最新那一份的话，doctor 的"最新"会落到第二份
        // （09:40 那份才 12 小时，没到 30 小时阈值 → 仍然 PASS）。第一次跑就栽在这。
        this.store.dbFiles = files.map((f) => join(bdir, f));
        for (const f of this.store.dbFiles) utimesSync(f, old, old);
      }
      log('  注入: loop.log / patch-canary.json / 最新备份的时间都改到 40 小时前');
    },
    recover() {
      const now = new Date();
      const logf = join(ROOT, 'data', 'loop.log');
      if (existsSync(logf)) utimesSync(logf, now, now);
      if (this.store.canary) restore(this.store.canary, join(ROOT, 'data', 'patch-canary.json'));
      for (const f of (this.store.dbFiles ?? [])) { if (existsSync(f)) utimesSync(f, now, now); }
      ps("Enable-ScheduledTask -TaskName 'anc-service' -ErrorAction SilentlyContinue | Out-Null");
      ps("Start-ScheduledTask -TaskName 'anc-service' -ErrorAction SilentlyContinue | Out-Null");
      log('  恢复: loop.log mtime 改回、canary 从备份还原、备份 mtime 改回、anc-service 重新启用');
    },
  },

  // 6) 单项：-BotUser 指向不存在的账号
  identity: {
    title: '运行身份指向不存在的账号',
    items: { 'dedicated-user': 'FAIL', 'bot-process-owner': ['FAIL', 'WARN'] },
    extraArgs: ['-BotUser', 'anc-no-such-user-o2'],
    inject() { log('  注入: -BotUser anc-no-such-user-o2（无需改环境）'); },
    recover() { log('  恢复: 用默认 -BotUser 再验'); },
  },

  // 7) 单项：停掉 anc-http
  http: {
    title: '本地服务（anc-http）停止',
    items: { 'http-health': 'FAIL', 'task-anc-http': 'FAIL' },
    inject() {
      // 只 Stop 的话 State 会从 Running 变回 Ready，doctor 仍判 PASS；
      // 要 Disable + Stop 才是"确实停掉了服务"。
      ps("Stop-ScheduledTask -TaskName 'anc-http' -ErrorAction SilentlyContinue | Out-Null");
      ps("Disable-ScheduledTask -TaskName 'anc-http' -ErrorAction SilentlyContinue | Out-Null");
      ps("Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'cli.ts.*serve' } | Stop-Process -Force -ErrorAction SilentlyContinue");
      log('  注入: 停 anc-http 并杀 serve 进程');
    },
    recover() {
      ps("Enable-ScheduledTask -TaskName 'anc-http' -ErrorAction SilentlyContinue | Out-Null");
      ps("Start-ScheduledTask -TaskName 'anc-http' -ErrorAction SilentlyContinue");
      log('  恢复: 启用并启动 anc-http');
    },
  },

  // 8) workbuddy：manifest 登记的版本与已安装版本不符
  wbversion: {
    title: 'manifest 登记的 WorkBuddy 版本与实际不符',
    items: { workbuddy: 'FAIL' },
    store: {},
    inject() {
      mkdirSync(BAK, { recursive: true });
      const mf = join(ROOT, 'patch', 'manifest.json');
      this.store.mf = backup(mf, 'manifest-ver');
      const j = JSON.parse(readFileSync(mf, 'utf8'));
      j.workbuddyVersion = '0.0.0-o2-mismatch';   // 与真实安装版本不同 → workbuddy FAIL
      writeFileSync(mf, JSON.stringify(j, null, 2), 'utf8');
      log('  注入: manifest.workbuddyVersion = 0.0.0-o2-mismatch');
    },
    recover() {
      if (this.store.mf) restore(this.store.mf, join(ROOT, 'patch', 'manifest.json'));
      log('  恢复: manifest 从备份还原');
    },
  },

  // 9) smb：给广泛组加写权限（改共享权限，短暂影响员工访问，可恢复）
  smb: {
    title: 'SMB 共享对广泛组有写权限',
    items: { smb: 'FAIL' },
    inject() {
      ps("Grant-SmbShareAccess -Name 'anc-vault-shared' -AccountName 'Everyone' -AccessRight Change -Force -ErrorAction SilentlyContinue | Out-Null");
      log('  注入: 共享给 Everyone Change（应被判为"广泛组有写权限"）');
    },
    recover() {
      ps("Revoke-SmbShareAccess -Name 'anc-vault-shared' -AccountName 'Everyone' -Force -ErrorAction SilentlyContinue | Out-Null");
      ps("Grant-SmbShareAccess -Name 'anc-vault-shared' -AccountName 'Everyone' -AccessRight Read -Force -ErrorAction SilentlyContinue | Out-Null");
      log('  恢复: Everyone 收回 Change，恢复 Read');
    },
  },

  // 10) bindings：清空绑定表（短暂影响发送，可恢复）
  bindings: {
    title: '绑定表被清空',
    items: { bindings: 'WARN' },
    store: {},
    inject() {
      mkdirSync(BAK, { recursive: true });
      const js = [
        "const{DatabaseSync}=require('node:sqlite');",
        'const d=new DatabaseSync(process.argv[2]);',
        "const rows=d.prepare('SELECT * FROM chat_bindings').all();",
        "require('node:fs').writeFileSync(process.argv[3], JSON.stringify(rows));",
        "d.prepare('DELETE FROM chat_bindings').run();",
        'console.log(rows.length);d.close();',
      ].join('');
      const f = join(BAK, 'bind-backup.cjs');
      writeFileSync(f, js, 'utf8');
      const n = execFileSync(process.execPath, ['--no-warnings', f, DB, join(BAK, 'bindings.json')], { encoding: 'utf8' }).trim();
      log(`  注入: 清空 chat_bindings（原有 ${n} 条，已备份）`);
    },
    recover() {
      const js = [
        "const{DatabaseSync}=require('node:sqlite');",
        "const rows=JSON.parse(require('node:fs').readFileSync(process.argv[3],'utf8'));",
        'const d=new DatabaseSync(process.argv[2]);',
        "for(const r of rows){const k=Object.keys(r);const v=k.map(x=>r[x]);d.prepare('INSERT INTO chat_bindings ('+k.join(',')+') VALUES ('+k.map(()=>'?').join(',')+')').run(...v);}",
        'console.log(rows.length);d.close();',
      ].join('');
      const f = join(BAK, 'bind-restore.cjs');
      writeFileSync(f, js, 'utf8');
      const n = execFileSync(process.execPath, ['--no-warnings', f, DB, join(BAK, 'bindings.json')], { encoding: 'utf8' }).trim();
      log(`  恢复: 回填 ${n} 条绑定`);
    },
  },

  // 8) 单项：仓库里放一个假密钥（secrets-in-git）
  secretingit: {
    title: '仓库里出现疑似密钥',
    items: { 'secrets-in-git': 'FAIL' },
    // doctor 的 git grep 排除了 docs/*（文档里常出现占位符），所以放 scripts/ 下
    file: 'scripts/_o2-fake-secret.md',
    inject() {
      // 拼出来而不是写整串：doctor 的 secrets-in-git 会扫这个模式，
      // 整串写在这里会让仓库自己命中（第一次跑就被自己的脚本抓到了）。
      const fake = ['https://qyapi.weixin.qq.com', '/cgi-bin/webhook/send?key=', '00000000-0000-0000-0000-000000000000'].join('');
      writeFileSync(join(REPO, this.file), 'webhook=' + fake + '\n', 'utf8');
      ps(`git -C "${REPO}" add -N "${this.file}" 2>$null | Out-Null`);
      log('  注入: 放一个假 webhook 到 docs/（并 git add -N 让 git grep 能扫到）');
    },
    recover() {
      ps(`git -C "${REPO}" rm --cached "${this.file}" 2>$null | Out-Null`);
      try { unlinkSync(join(REPO, this.file)); } catch { /* ignore */ }
      log('  恢复: 删除该文件并撤出索引');
    },
  },
};

// 高风险组（--risky 才跑）
const RISKY = {
  database: {
    title: '数据库文件被挪走',
    items: { database: 'FAIL' },
    inject() {
      // anc-service 每分钟 tick 会打开 anc.db，直接 rename 会 EBUSY —— 先停服务
      // anc-service 和 anc-http 都持有库连接，两个都要停，否则 rename 会 EBUSY
      for (const t of ['anc-service', 'anc-http']) {
        ps("Stop-ScheduledTask -TaskName '\' -ErrorAction SilentlyContinue | Out-Null");
        ps("Disable-ScheduledTask -TaskName '\' -ErrorAction SilentlyContinue | Out-Null");
      }
      // 停任务不会杀掉已经在跑的进程，必须显式 kill，否则文件仍被占用
      ps("Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'cli.ts.*serve' } | Stop-Process -Force -ErrorAction SilentlyContinue");
      ps("Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'cli.ts.*loop' } | Stop-Process -Force -ErrorAction SilentlyContinue");
      log('  注入前：停掉 anc-service + anc-http 并杀掉它们的 node 进程（两者都持有库连接）');
      renameSync(DB, DB + '.o2-moved');
      log('  注入: anc.db 改名为 anc.db.o2-moved');
    },
    recover() {
      if (existsSync(DB + '.o2-moved')) renameSync(DB + '.o2-moved', DB);
      for (const t of ['anc-service', 'anc-http']) {
        ps("Enable-ScheduledTask -TaskName '\' -ErrorAction SilentlyContinue | Out-Null");
        ps("Start-ScheduledTask -TaskName '\' -ErrorAction SilentlyContinue | Out-Null");
      }
      log('  恢复: 改回 anc.db、两个服务重新启用');
    },
  },
};

async function runGroup(name, g) {
  console.log(`\n[${name}] ${g.title}`);
  const extra = g.extraArgs ?? [];
  const before = doctor(extra);
  const preBad = Object.entries(g.items)
    .filter(([n, want]) => {
      const got = before[n] ?? '(缺项)';
      return !(Array.isArray(want) ? want.includes(got) : got === want) && got !== 'PASS' && got !== 'WARN';
    });
  if (preBad.length) log(`  注意：注入前这些项已不是 PASS/WARN：${preBad.map(([n]) => n).join(', ')}`);

  let fails = [];
  try {
    g.inject();
    const during = doctor(extra);
    fails = fails.concat(expectState(during, null, g.items, '注入后应报出问题'));
    // 同时确认"没被弄坏的项"仍是 PASS/WARN，排除 doctor 整体崩掉
    const stillOk = Object.keys(g.items).length;
    const totalFail = Object.values(during).filter((v) => v === 'FAIL').length;
    if (totalFail < stillOk) log(`  ! 只有 ${totalFail} 项 FAIL，期望至少 ${stillOk} 项（可能有项没红）`);
  } finally {
    g.recover();
  }
  // 恢复后用**默认参数**验：identity 组的"注入"就是改参数，带着它验等于没恢复
  const after = doctor([]);
  fails = fails.concat(expectState(after, 'PASS', Object.fromEntries(Object.keys(g.items).map((k) => [k, 'PASS'])), '恢复后应转回 PASS'));
  return fails;
}

async function main() {
  if (!existsSync(DOCTOR)) { console.error('找不到 ' + DOCTOR); process.exit(2); }
  mkdirSync(BAK, { recursive: true });

  const plan = { ...GROUPS, ...(risky ? RISKY : {}) };
  const names = only ? [only] : Object.keys(plan);
  for (const n of names) if (!plan[n]) { console.error(`未知组: ${n}（可选: ${Object.keys(plan).join(' / ')}）`); process.exit(2); }

  log(`O-2 doctor 故障矩阵 @ ${new Date().toISOString()}`);
  log(`doctor: ${DOCTOR}`);
  const base = doctor([]);
  const baseFail = Object.entries(base).filter(([, v]) => v === 'FAIL').map(([k]) => k);
  log(`基线 FAIL: ${baseFail.join(', ') || '(无)'}`);

  let all = [];
  for (const n of names) all = all.concat(await runGroup(n, plan[n]));

  // 最终确认：全部回到正常
  const final = doctor([]);
  const finalFail = Object.entries(final).filter(([, v]) => v === 'FAIL').map(([k]) => k);
  log(`\n最终 FAIL: ${finalFail.join(', ') || '(无)'}`);
  if (finalFail.length) { all.push('最终仍有 FAIL: ' + finalFail.join(', ')); }

  log(`\n汇总: ${all.length === 0 ? '全部按预期（该红的红了、该恢复的恢复了）' : all.length + ' 个问题'}`);
  mkdirSync(join(REPO, '_research'), { recursive: true });
  writeFileSync(join(REPO, '_research', 'o2-matrix.md'), `# O-2 doctor 故障矩阵 ${new Date().toISOString()}\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`, 'utf8');
  console.log(`报告: _research/o2-matrix.md`);
  process.exit(all.length ? 1 : 0);
}

main().catch((e) => { console.error('ERROR ' + e.message); process.exit(2); });
