// eval runner（PLAN 阶段 L6）。
//
// 一条用例 = 一句输入 + 一组断言。跑法：通过 test-emit 把输入送进去，
// 等 bot 的回答出现在 patch-out.log，然后按断言判 pass/fail。
//
// **为什么用 patch-out.log 而不是别的**：
//   - 它是出站记录，`text=` 后面就是 bot 真正发出去的内容
//   - 它有稳定格式（`<ISO> chat=<id> len=<n> text=<正文>`），好解析
//   - 它只记数字和正文，不含内部推理过程
//
// 局限（必须知道）：
//   - **只能看到最终回复**，看不到它中间调了什么工具。所以"它是不是调了技能"这类断言做不到
//   - **流式回复会一行一条**，多行的用例要按"注入后到安静下来"的窗口取全部行
//   - 出站过滤在企微不生效（VERIFY §17），所以断言里别指望"旁白被过滤掉了"
//   - **只记前 400 字符**（preload 的 `s.slice(0, 400)`）。长回答的后半截 eval 看不到，
//     所以断言别依赖"结尾"

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export interface Expect {
  /** 全部要出现的正则（任一不满足即 fail） */
  mustMatch?: string[];
  /** 任一出现即 fail 的正则 */
  notMatch?: string[];
  /** 回答最多几行（流式逐条发时按行数算） */
  maxLines?: number;
  /** 回答至少几行 */
  minLines?: number;
}

export interface EvalCase {
  id: string;
  skill?: string;
  input: string;
  expect: Expect;
  note?: string;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface RunResult {
  caseId: string;
  skill: string | null;
  verdict: 'pass' | 'fail' | 'error';
  checks: CheckResult[];
  answer: string;
  answerLen: number;
}

// ── test-emit ────────────────────────────────────────────
export interface EmitOptions {
  chatId: string;
  user: string;
  port?: number;
}

function emitOnce(opts: EmitOptions, content: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = {
      chatId: opts.chatId,
      user: opts.user,
      msgId: Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join(''),
      content,
    };
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port: opts.port ?? 17999,
        path: '/emit',
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length },
        agent: false,
        timeout: 15000,
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('emit timeout')));
    req.write(body);
    req.end();
  });
}

/** 等 test-emit 端口就绪（重启后要 8–30 秒才拿到实例引用）。 */
export async function waitReady(opts: EmitOptions, timeoutMs = 120000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await emitOnce(opts, 'eval-probe');
      if (r.status === 200) return true;
    } catch { /* 还没起 */ }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

// ── patch-out.log 解析 ───────────────────────────────────
export interface OutLine {
  at: string;
  chatId: string;
  len: number;
  text: string;
  raw: string;
}

/** 读 patch-out.log 的全部行。文件不存在返回空数组。 */
export function readOutLog(path: string): OutLine[] {
  if (!existsSync(path)) return [];
  const out: OutLine[] = [];
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^(\S+)\s+chat=(\S+)\s+len=(\d+)\s+text=([\s\S]*)$/);
    if (!m) continue;
    // preload 写日志时把换行转义成了字面 \\n（保持"一行一条记录"），
    // 这里还原，否则按行数判断的断言会全部失效（2026-11-04 踩到）。
    out.push({ at: m[1], chatId: m[2], len: Number(m[3]), text: m[4].replace(/\\n/g, '\n'), raw });
  }
  return out;
}

// ── 断言 ─────────────────────────────────────────────────
export function judge(answer: string, expect: Expect): CheckResult[] {
  const checks: CheckResult[] = [];
  const lines = answer.split(/\r?\n/).filter((l) => l.trim() !== '');

  if (!answer.trim()) {
    checks.push({ name: '有回答', ok: false, detail: 'patch-out.log 里没有新内容——bot 可能没回，或回复走了别的路径' });
    return checks;
  }
  checks.push({ name: '有回答', ok: true, detail: answer.length + ' 字' });

  for (const p of expect.mustMatch ?? []) {
    let re: RegExp;
    try { re = new RegExp(p); } catch { checks.push({ name: 'mustMatch /' + p + '/', ok: false, detail: '正则写错了' }); continue; }
    const ok = re.test(answer);
    checks.push({ name: '必须出现 /' + p + '/', ok, detail: ok ? undefined : '没匹配到' });
  }

  for (const p of expect.notMatch ?? []) {
    let re: RegExp;
    try { re = new RegExp(p); } catch { checks.push({ name: 'notMatch /' + p + '/', ok: false, detail: '正则写错了' }); continue; }
    const m = answer.match(re);
    checks.push({ name: '不能出现 /' + p + '/', ok: !m, detail: m ? '出现了: ' + m[0] : undefined });
  }

  if (expect.maxLines !== undefined) {
    const ok = lines.length <= expect.maxLines;
    checks.push({ name: '最多 ' + expect.maxLines + ' 行', ok, detail: '实际 ' + lines.length + ' 行' });
  }
  if (expect.minLines !== undefined) {
    const ok = lines.length >= expect.minLines;
    checks.push({ name: '至少 ' + expect.minLines + ' 行', ok, detail: '实际 ' + lines.length + ' 行' });
  }

  return checks;
}

// ── 跑一条用例 ───────────────────────────────────────────
export interface RunOptions extends EmitOptions {
  outLog: string;
  /** 等回答的超时，默认 180 秒（bot 处理实测要 1–3 分钟） */
  timeoutMs?: number;
  /** 判断"回答结束"的静默窗口，默认 15 秒 */
  quietMs?: number;
}

export async function runCase(c: EvalCase, opts: RunOptions): Promise<RunResult> {
  const before = readOutLog(opts.outLog).length;

  const r = await emitOnce(opts, c.input);
  if (r.status !== 200) {
    return {
      caseId: c.id,
      skill: c.skill ?? null,
      verdict: 'error',
      checks: [{ name: '注入', ok: false, detail: 'HTTP ' + r.status + ' ' + r.body.slice(0, 120) }],
      answer: '',
      answerLen: 0,
    };
  }

  const deadline = Date.now() + (opts.timeoutMs ?? 180000);
  const quiet = opts.quietMs ?? 15000;
  let lastCount = before;
  let lastChange = Date.now();
  let lines: OutLine[] = [];

  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 3000));
    const all = readOutLog(opts.outLog);
    if (all.length > lastCount) {
      lastCount = all.length;
      lastChange = Date.now();
    }
    if (lastCount > before && Date.now() - lastChange >= quiet) {
      lines = all.slice(before);
      break;
    }
  }
  if (!lines.length) lines = readOutLog(opts.outLog).slice(before);

  const answer = lines.map((l) => l.text).join('\n');
  const checks = judge(answer, c.expect);
  const verdict: RunResult['verdict'] = checks.every((x) => x.ok) ? 'pass' : 'fail';

  return { caseId: c.id, skill: c.skill ?? null, verdict, checks, answer, answerLen: answer.length };
}

// ── 用例文件 ─────────────────────────────────────────────
export interface CaseFile {
  cases: EvalCase[];
}

export function loadCases(repo: string, skill?: string): EvalCase[] {
  const dir = join(repo, 'light', 'evals');
  if (!existsSync(dir)) return [];
  const out: EvalCase[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as CaseFile;
    for (const c of raw.cases ?? []) {
      if (skill && c.skill !== skill) continue;
      out.push(c);
    }
  }
  return out;
}

// ── 落库 ─────────────────────────────────────────────────
export function record(db: DatabaseSync, r: RunResult, note?: string): number {
  const h = createHash('sha256').update(r.answer, 'utf8').digest('hex');
  const res = db
    .prepare(
      `INSERT INTO eval_runs (case_id, skill, verdict, checks, answer_hash, answer_len, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(r.caseId, r.skill, r.verdict, JSON.stringify(r.checks), h, r.answerLen, note ?? null, new Date().toISOString());
  return Number(res.lastInsertRowid);
}
