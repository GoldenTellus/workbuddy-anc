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
  bot?: string;
}

export interface Org {
  company: Record<string, string>;
  roles: Map<string, Record<string, string>>;
  members: Member[];
}

export function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
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
/** 会原样进 persona 的文本字段：拒绝控制字符、反引号、HTML 注释，限制长度，免得夹带指令或破坏 markdown */
const PERSONA_TEXT_FIELDS = ['name', 'role', 'userid', 'chat_id'] as const;

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

  const roles = new Map<string, Record<string, string>>();
  for (const f of readDir(join(dir, 'roles'))) {
    const { fm } = parseFrontmatter(readFileSync(join(dir, 'roles', f), 'utf8'));
    const id = fm.id || basename(f, '.md');
    roles.set(id, { ...fm, id });
  }

  const members: Member[] = [];
  for (const f of readDir(join(dir, 'members'))) {
    const { fm } = parseFrontmatter(readFileSync(join(dir, 'members', f), 'utf8'));
    const id = fm.id || basename(f, '.md');
    if (!fm.name) throw new Error('成员缺少 name: ' + f);
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
    });
  }

  members.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const seen = new Set<string>();
  for (const m of members) {
    if (seen.has(m.id)) throw new Error('成员 id 重复: ' + m.id);
    seen.add(m.id);
  }
  return { company, roles, members };
}
