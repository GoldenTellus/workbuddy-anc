import { readFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrg, splitList } from './org.ts';
import { renderTemplate, fingerprint, checkLength, writeAtomic } from './render.ts';

// 模板位置在两种布局下不同：仓库是 src/modules/org → ../../../light/templates，
// 部署是 %ProgramData%\anc\modules\org → ../../light/templates。硬编码层级会在部署后 404。
function findTemplates(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    join(here, '..', '..', '..', 'light', 'templates'), // 仓库
    join(here, '..', '..', 'light', 'templates'),       // 部署（%ProgramData%\anc\light\templates）
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
  // depts/ 也要进指纹：改了部门文件（技能集、vault 路径）却不算输入变化的话，
  // manifest 的 input_sha256 不变，手改检测会把手动改过的产物当成「没动过」。
  for (const sub of ['roles', 'depts', 'members']) {
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
    const dept = m.dept ? org.depts.get(m.dept) : undefined;
    const dSkills = splitList(dept ? dept.skills : undefined);
    const dPaths = splitList(dept ? dept.vault_paths : undefined);
    const text = renderTemplate(memberTpl, {
      fingerprint: fpLine,
      member_name: m.name,
      member_id: m.id,
      company_bot_name: org.company.company_bot_name,
      vault_shared: org.company.vault_shared,
      local_workdir: org.company.local_workdir,
      owner_userid: m.userid,
      // 部门为空时给「没限制」的措辞，不留空行（模板里那一行会显得像漏了）
      member_dept: dept ? dept.name : "（未分部门，可用全部技能与全部 vault）",
      member_skills: dSkills.length ? dSkills.join("、") : "全部",
      member_vault_paths: dPaths.length ? dPaths.join("、") : "全部（按公司共享区的目录结构）",
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
    // 部门信息随 groups.json 一起下发：
    //   skills / vault_paths 是空数组表示「没限制」，不是「什么都不给」
    //   （老 org 没有 dept，走的就是这条路径）
    members: org.members.filter((m) => !m.disabled).map((m) => {
      const d = m.dept ? org.depts.get(m.dept) : undefined;
      return {
        id: m.id,
        name: m.name,
        chat_id: m.chat_id || null,
        userid: m.userid || null,
        webhook_file: m.webhook_file || null,
        dept: m.dept ?? null,
        dept_name: d ? d.name : null,
        skills: splitList(d ? d.skills : undefined),
        vault_paths: splitList(d ? d.vault_paths : undefined),
      };
    }),
  };
  mkdirSync(outDir, { recursive: true });
  // groups.json 是 bind import 的输入、manifest 是手改检测的基准：都走原子写，半截文件会让下一步误判
  writeAtomic(join(outDir, 'groups.json'), JSON.stringify(groups, null, 2) + '\n');
  writeAtomic(join(outDir, 'manifest.json'), JSON.stringify({ input_sha256: inputSha, generated_at: new Date().toISOString(), files: record }, null, 2) + '\n');

  return { inputSha, outputs, members: org.members.filter((m) => !m.disabled).length, warn: cLen.warn || warnings.length > 0, tampered, warnings, removed };
}
