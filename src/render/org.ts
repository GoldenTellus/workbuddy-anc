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
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { fm, body: m[2] };
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
    members.push({
      id,
      name: fm.name,
      role: fm.role || '',
      userid: fm.userid,
      chat_id: fm.chat_id,
      webhook_file: fm.webhook_file,
      seat: fm.seat,
      bot: fm.bot,
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
