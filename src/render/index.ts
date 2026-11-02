import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, copyFileSync, unlinkSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrg } from './org.ts';
import { renderTemplate, fingerprint, checkLength, writeAtomic } from './render.ts';

// 模板位置在两种布局下不同：仓库是 src/render → ../../light/templates，
// 部署是 %ProgramData%\anc\render → ../light/templates。硬编码层级会在部署后 404。
function findTemplates(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    join(here, '..', '..', 'light', 'templates'), // 仓库
    join(here, '..', 'light', 'templates'),       // 部署（%ProgramData%\anc\light\templates）
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'company-bot.md'))) return c;
  }
  return candidates[0];
}
const DEFAULT_TEMPLATES = findTemplates();

export interface RenderResult {
  inputSha: string;
  outputs: Array<{ file: string; bytes: number; sha: string }>;
  members: number;
  warn: boolean;
  /** 已存在产物里指纹与本次输入不一致的文件（被手改过） */
  tampered: string[];
  /** 不阻断但要人看的事：成员缺 userid 被跳过、persona 接近上限、manifest 损坏 */
  warnings: string[];
  /** 本次被清掉产物的停用成员 id */
  removed: string[];
}

interface Manifest { input_sha256: string; files: Record<string, string> }

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 读上次的 manifest；坏了要说出来——否则手改检测就此静默关闭。 */
function readManifest(outDir: string): { manifest: Manifest | null; error: string | null } {
  const p = join(outDir, 'manifest.json');
  if (!existsSync(p)) return { manifest: null, error: null };
  try {
    const m = JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, '')) as Manifest;
    if (!m || typeof m.input_sha256 !== 'string' || !m.files) throw new Error('缺少 input_sha256/files');
    return { manifest: m, error: null };
  } catch (e) {
    return { manifest: null, error: 'manifest.json 无法解析，本次无法检查手改（' + (e as Error).message + '）；渲染后会重写' };
  }
}

export function renderOrg(orgDir: string, outDir: string, templateDir = DEFAULT_TEMPLATES): RenderResult {
  const org = loadOrg(orgDir);
  const required = ['name', 'company_bot_name', 'vault_shared', 'vault_internal', 'local_workdir'];
  for (const k of required) {
    if (!org.company[k]) throw new Error('org/company.md 缺少字段: ' + k);
  }

  const inputs: Array<{ path: string; content: string }> = [
    { path: 'company.md', content: readFileSync(join(orgDir, 'company.md'), 'utf8') },
  ];
  for (const sub of ['roles', 'members']) {
    const d = join(orgDir, sub);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith('.md'))) {
      inputs.push({ path: sub + '/' + f, content: readFileSync(join(d, f), 'utf8') });
    }
  }
  const inputSha = fingerprint(inputs);
  const fpLine = `<!-- anc:input-sha256:${inputSha} -->`;

  const companyTpl = readFileSync(join(templateDir, 'company-bot.md'), 'utf8');
  const memberTpl = readFileSync(join(templateDir, 'member-bot.md'), 'utf8');

  const outputs: RenderResult['outputs'] = [];
  const tampered: string[] = [];
  const warnings: string[] = [];
  const mf = readManifest(outDir);
  if (mf.error) warnings.push(mf.error);
  const manifest = mf.manifest;
  const record: Record<string, string> = {};
  // path.relative：--out 带结尾分隔符时 slice 会多切一个字符，manifest 的 key 对不上，手改检测被静默跳过
  const outRoot = resolve(outDir);
  const rel = (f: string) => relative(outRoot, resolve(f)).replace(/\\/g, '/');

  // 输入没变但文件内容变了 → 手改
  const track = (file: string, content: string): string => {
    if (manifest && manifest.input_sha256 === inputSha) {
      const want = manifest.files[rel(file)];
      if (want && existsSync(file)) {
        const cur = sha256(readFileSync(file, 'utf8'));
        if (cur !== want) tampered.push(file);
      }
    }
    const sha = writeAtomic(file, content);
    record[rel(file)] = sha;
    return sha;
  };

  const companyText = renderTemplate(companyTpl, {
    fingerprint: fpLine,
    company_name: org.company.name,
    vault_shared: org.company.vault_shared,
    vault_internal: org.company.vault_internal,
  });
  const cLen = checkLength(companyText);
  if (!cLen.ok) {
    const detail = (cLen.sections || []).map((s) => `${s.title}=${s.bytes}`).join(', ');
    throw new Error(`公司 bot persona 超过 7500 字节（当前 ${cLen.bytes}）: ${detail}`);
  }
  const cFile = join(outDir, 'company-bot', 'CODEBUDDY.md');
  outputs.push({ file: cFile, bytes: cLen.bytes, sha: track(cFile, companyText) });

  const removed: string[] = [];
  for (const m of org.members) {
    // 离职（disabled）：不出 persona、不进 groups.json，并把旧产物删掉
    if (m.disabled) {
      const dir = join(outDir, 'members', m.id);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        removed.push(m.id);
        warnings.push('成员 ' + m.id + ' 已停用，删除其 persona 产物');
      }
      continue;
    }
    // 没有 userid 就不出个人 persona：否则模板里是字面量 <userid>，个人 bot 认不出主人、只能靠模型猜
    if (!m.userid) {
      warnings.push(`成员 ${m.id} 没有 userid，跳过个人 persona（补上 members/${m.id}.md 的 userid 后重新渲染）`);
      continue;
    }
    const text = renderTemplate(memberTpl, {
      fingerprint: fpLine,
      member_name: m.name,
      member_id: m.id,
      company_bot_name: org.company.company_bot_name,
      vault_shared: org.company.vault_shared,
      local_workdir: org.company.local_workdir,
      owner_userid: m.userid,
    });
    const len = checkLength(text);
    if (!len.ok) throw new Error(`成员 ${m.id} 的 persona 超过 7500 字节（当前 ${len.bytes}）`);
    if (len.warn) warnings.push(`成员 ${m.id} 的 persona ${len.bytes} 字节，超过 6500 的提醒线`);
    const f = join(outDir, 'members', m.id, 'CODEBUDDY.md');
    outputs.push({ file: f, bytes: len.bytes, sha: track(f, text) });
  }

  const groups = {
    generated_at: new Date().toISOString(),
    input_sha256: inputSha,
    members: org.members.filter((m) => !m.disabled).map((m) => ({ id: m.id, name: m.name, chat_id: m.chat_id || null, userid: m.userid || null, webhook_file: m.webhook_file || null })),
  };
  mkdirSync(outDir, { recursive: true });
  // groups.json 是 bind import 的输入、manifest 是手改检测的基准：都走原子写，半截文件会让下一步误判
  writeAtomic(join(outDir, 'groups.json'), JSON.stringify(groups, null, 2) + '\n');
  writeAtomic(join(outDir, 'manifest.json'), JSON.stringify({ input_sha256: inputSha, generated_at: new Date().toISOString(), files: record }, null, 2) + '\n');

  return { inputSha, outputs, members: org.members.filter((m) => !m.disabled).length, warn: cLen.warn || warnings.length > 0, tampered, warnings, removed };
}

// ───────────────────────────── C9：整组部署与回滚 ─────────────────────────────
//
// writeAtomic 只保证「单个文件」原子；渲染是一组文件（company-bot/、members/*/、
// groups.json、manifest.json），中途失败会留下"一半新一半旧"，这比整批失败更难查。
// 所以部署要包一层事务：先快照 → 渲染 → 读回对拍 → 任一失败整体还原。

interface Snapshot {
  files: Map<string, Buffer>;
  dirs: string[];
}

function isTransient(name: string): boolean {
  return name.startsWith('.tmp-') || name.includes('.bak-') || name === '.anc-backup';
}

function walk(root: string, onDir: (dir: string) => void): void {
  if (!existsSync(root)) return;
  onDir(root);
  for (const name of readdirSync(root)) {
    if (isTransient(name)) continue;
    const p = join(root, name);
    try { if (statSync(p).isDirectory()) walk(p, onDir); } catch { /* ignore */ }
  }
}

function snapshotOutDir(outDir: string): Snapshot {
  const root = resolve(outDir);
  const files = new Map<string, Buffer>();
  const dirs: string[] = [];
  walk(root, (dir) => {
    dirs.push(dir);
    for (const name of readdirSync(dir)) {
      if (isTransient(name)) continue;
      const p = join(dir, name);
      try { if (statSync(p).isFile()) files.set(relative(root, p), readFileSync(p)); } catch { /* ignore */ }
    }
  });
  return { files, dirs };
}

function restoreOutDir(outDir: string, snap: Snapshot): void {
  const root = resolve(outDir);
  // 先写回快照里的内容（目录按快照补）
  for (const d of snap.dirs) mkdirSync(d, { recursive: true });
  for (const [rel, buf] of snap.files) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, buf);
  }
  // 再删掉快照之后新增的文件（渲染产物只可能落在这两类路径下）
  const now = snapshotOutDir(outDir);
  for (const rel of now.files.keys()) {
    if (!snap.files.has(rel)) {
      try { unlinkSync(join(root, rel)); } catch { /* ignore */ }
    }
  }
}

export interface DeployResult extends RenderResult {
  verified: number;
}

/**
 * 事务式部署：快照 → 渲染 → 逐产物读回对拍 → 失败整体还原。
 * 对拍不只是相信 writeAtomic 的写回校验：还要确认落盘内容与本次返回值一致，
 * 防止"rename 成功但内容不是这一版"这类磁盘级意外。
 */
export function deployOrg(orgDir: string, outDir: string, templateDir?: string): DeployResult {
  const snap = snapshotOutDir(outDir);
  try {
    const r = templateDir ? renderOrg(orgDir, outDir, templateDir) : renderOrg(orgDir, outDir);
    let verified = 0;
    for (const o of r.outputs) {
      const cur = createHash('sha256').update(readFileSync(o.file)).digest('hex');
      if (cur !== o.sha) throw new Error('产物对拍失败: ' + o.file + '（期望 ' + o.sha.slice(0, 12) + '，实际 ' + cur.slice(0, 12) + '）');
      verified += 1;
    }
    // groups.json / manifest.json 不在 outputs 里，单独核一次可解析
    JSON.parse(readFileSync(join(outDir, 'groups.json'), 'utf8'));
    JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'));
    return { ...r, verified };
  } catch (e) {
    restoreOutDir(outDir, snap);
    throw new Error('渲染失败，已回滚到部署前状态：' + (e as Error).message);
  }
}

/** 把每个文件最新的 `.名字.bak-<时间戳>` 还原回去；没有备份的文件跳过。 */
export function rollbackOutDir(outDir: string, opts: { dryRun?: boolean } = {}): { restored: Array<{ file: string; from: string }>; skipped: string[] } {
  const root = resolve(outDir);
  const picks = new Map<string, { bak: string; stamp: string }>();
  walk(root, (dir) => {
    for (const name of readdirSync(dir)) {
      const m = name.match(/^\.(.+)\.bak-(\d{17}(?:-\d+)?)$/);
      if (!m) continue;
      const target = join(dir, m[1]);
      const prev = picks.get(target);
      if (!prev || m[2] > prev.stamp) picks.set(target, { bak: join(dir, name), stamp: m[2] });
    }
  });
  const restored: Array<{ file: string; from: string }> = [];
  const skipped: string[] = [];
  for (const [target, pick] of picks) {
    if (opts.dryRun) { restored.push({ file: target, from: pick.bak }); continue; }
    try {
      copyFileSync(pick.bak, target);
      restored.push({ file: target, from: pick.bak });
    } catch (e) {
      skipped.push(target + ': ' + (e as Error).message);
    }
  }
  return { restored, skipped };
}