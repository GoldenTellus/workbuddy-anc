import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

export interface Member {
  id: string;
  name: string;
  role: string;
  userid?: string;
  chat_id?: string;
  webhook_file?: string;
  seat?: string;
  /** 停用（离职）：不再渲染 persona、不进 groups.json、产物要清掉 */
  disabled?: boolean;
  /** 所属部门（org/depts/<id>.md）。缺省表示不归任何部门，按"全部技能、全部 vault"处理 */
  dept?: string;
  /** 管理的部门 id（可多个）。非空即管理者；老板由 company.boss 指定 */
  manages?: string[];
  bot?: string;
}

/**
 * 部门。决定三件事：
 *   1. 员工能看到哪些 vault 目录（vault_paths）
 *   2. 装哪些技能（skills）——不是每个部门都要 anc-interview
 *   3. 进哪个群（将来"一部门一群"的依据；现在仍是一人一群，chat_id 在 member 上）
 *
 * 为什么需要它：上游形态是"全公司一套技能"，但实际每个部门用到的技能差很多。
 * 装全套会让个人 bot 的 persona 变长，也让模型分不清该用哪个。
 */
export interface Dept {
  id: string;
  name: string;
  /** 逗号分隔的相对路径，相对 vault 根。空表示无限制 */
  vault_paths: string;
  /** 逗号分隔的技能 id。空表示全部 */
  skills: string;
  note?: string;
}

export interface Org {
  company: Record<string, string>;
  roles: Map<string, Record<string, string>>;
  depts: Map<string, Dept>;
  members: Member[];
  /** 唯一老板的成员 id；老 org 可缺省，主干 1 启动校验时要求存在 */
  boss?: string;
}

/** 把 "a, b , c" 拆成 [a,b,c]；空串返回 [] */
export function splitList(v: string | undefined): string[] {
  if (!v) return [];
  return v.split(",").map((x) => x.trim()).filter(Boolean);
}

export function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  // 先剥 BOM：Windows 上手工编辑保存的文件常带 UTF-8 BOM，而 /^---/ 顶不住它——
  // 结果是"文件明明有 name，却报缺少字段: name"，错得毫无线索。
  // 2026-11-04 用 Z: 演练重建时踩到（PowerShell 5.1 的 Set-Content -Encoding UTF8 会加 BOM）。
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const m = clean.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: clean };
  const fm: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    // 说明文字混进 frontmatter 时不能静默跳过：技能/org 文件会被解析成缺字段，坏得无声无息
    if (!kv) throw new Error('frontmatter 行不合法（只接受 key: value 或 # 注释）: ' + t);
    fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { fm, body: m[2] };
}

/** id 会进输出路径（members/<id>/）：只许安全字符，../ 不能把产物写到 --out 外 */
const MEMBER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** 部门 id 会进 groups.json 和 persona 文本，规则同成员 id */
const DEPT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** 会原样进 persona 的文本字段：拒绝控制字符、反引号、HTML 注释，限制长度，免得夹带指令或破坏 markdown */
const PERSONA_TEXT_FIELDS = ['name', 'role', 'userid', 'chat_id'] as const;

/** 允许出现的 frontmatter 键。拼错一个键会被静默忽略（字段没生效但不报错），所以白名单要收死。 */
const KNOWN_KEYS: Record<string, string[]> = {
  company: ['name', 'company_bot_name', 'vault_shared', 'vault_internal', 'local_workdir', 'boss'],
  member: ['id', 'name', 'role', 'userid', 'chat_id', 'webhook_file', 'seat', 'bot', 'disabled', 'dept', 'manages'],
  role: ['id', 'name', 'duties'],
  dept: ['id', 'name', 'vault_paths', 'skills', 'note'],
};

function assertKnownKeys(file: string, kind: 'company' | 'member' | 'role' | 'dept', fm: Record<string, string>): void {
  const allowed = KNOWN_KEYS[kind];
  const unknown = Object.keys(fm).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new Error(file + ' 有不认识的字段: ' + unknown.join(', ') + '（允许: ' + allowed.join(', ') + '）');
  }
}
function assertMemberFields(file: string, id: string, fm: Record<string, string>): void {
  if (!MEMBER_ID.test(id)) throw new Error(`成员 id 不合规（小写字母数字 _ -，≤64）: ${id}（${file}）`);
  for (const k of PERSONA_TEXT_FIELDS) {
    const v = fm[k];
    if (v === undefined) continue;
    if (v.length > 100) throw new Error(`成员字段 ${k} 过长（${file}）`);
    if (/[\u0000-\u001f`]|<!--|-->/.test(v)) throw new Error(`成员字段 ${k} 含控制字符、反引号或 HTML 注释（${file}）`);
  }
  if (fm.webhook_file !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.txt$/.test(fm.webhook_file)) {
    throw new Error(`成员 webhook_file 只能是 secrets 目录下的文件名（${file}）: ${fm.webhook_file}`);
  }
}

function readDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md'));
}

export function loadOrg(dir: string): Org {
  const companyPath = join(dir, 'company.md');
  if (!existsSync(companyPath)) throw new Error('缺少 org/company.md: ' + companyPath);
  const company = parseFrontmatter(readFileSync(companyPath, 'utf8')).fm;
  assertKnownKeys('company.md', 'company', company);

  const roles = new Map<string, Record<string, string>>();
  for (const f of readDir(join(dir, 'roles'))) {
    const { fm } = parseFrontmatter(readFileSync(join(dir, 'roles', f), 'utf8'));
    const id = fm.id || basename(f, '.md');
    assertKnownKeys('roles/' + f, 'role', fm);
    roles.set(id, { ...fm, id });
  }

  // 部门：可选目录。没有 org/depts/ 时 depts 为空 Map（向后兼容，老 org 照样能渲染）
  const depts = new Map<string, Dept>();
  for (const f of readDir(join(dir, 'depts'))) {
    const { fm } = parseFrontmatter(readFileSync(join(dir, 'depts', f), 'utf8'));
    const id = fm.id || basename(f, '.md');
    assertKnownKeys('depts/' + f, 'dept', fm);
    if (!DEPT_ID.test(id)) throw new Error('部门 id 不合规（小写字母数字 _ -，≤64）: ' + id + '（depts/' + f + '）');
    if (!fm.name) throw new Error('部门缺少 name: depts/' + f);
    depts.set(id, {
      id,
      name: fm.name,
      vault_paths: fm.vault_paths || '',
      skills: fm.skills || '',
      note: fm.note,
    });
  }

  const members: Member[] = [];
  for (const f of readDir(join(dir, 'members'))) {
    const { fm } = parseFrontmatter(readFileSync(join(dir, 'members', f), 'utf8'));
    const id = fm.id || basename(f, '.md');
    if (!fm.name) throw new Error('成员缺少 name: ' + f);
    assertKnownKeys('members/' + f, 'member', fm);
    assertMemberFields(f, id, fm);
    members.push({
      id,
      name: fm.name,
      role: fm.role || '',
      userid: fm.userid,
      chat_id: fm.chat_id,
      webhook_file: fm.webhook_file,
      seat: fm.seat,
      bot: fm.bot,
      // 只认字符串 "true"：写成 yes/1 之类不生效，避免"以为停用了其实没有"
      disabled: fm.disabled === 'true',
      dept: fm.dept,
      manages: splitList(fm.manages),
    });
  }

  members.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const seen = new Set<string>();
  for (const m of members) {
    if (seen.has(m.id)) throw new Error('成员 id 重复: ' + m.id);
    seen.add(m.id);
    // 引用了不存在的角色 → persona 里的 role 字段会落空，行为与预期不符且不报错
    // 引用了不存在的部门 → 技能集和 vault 范围都会落空，行为与预期不符且不报错
    if (m.dept && !depts.has(m.dept)) {
      throw new Error('成员 ' + m.id + ' 引用了不存在的部门: ' + m.dept + '（depts/ 下有: ' + ([...depts.keys()].join(', ') || '空') + '）');
    }
    if (m.role && !roles.has(m.role)) {
      throw new Error('成员 ' + m.id + ' 引用了不存在的角色: ' + m.role + '（roles/ 下有: ' + [...roles.keys()].join(', ') + '）');
    }
    for (const d of m.manages ?? []) {
      if (!depts.has(d)) {
        throw new Error('成员 ' + m.id + ' 的 manages 引用了不存在的部门: ' + d + '（depts/ 下有: ' + ([...depts.keys()].join(', ') || '空') + '）');
      }
    }
    if (new Set(m.manages ?? []).size !== (m.manages ?? []).length) {
      throw new Error('成员 ' + m.id + ' 的 manages 有重复部门');
    }
  }

  const boss = company.boss;
  if (boss !== undefined) {
    if (!MEMBER_ID.test(boss)) throw new Error('company.boss 不是合法成员 id: ' + boss);
    const b = members.find((m) => m.id === boss);
    if (!b) throw new Error('company.boss 引用了不存在的成员: ' + boss);
    if (b.disabled) throw new Error('company.boss 不能是停用成员: ' + boss);
  }

  return { company, roles, depts, members, boss };
}
