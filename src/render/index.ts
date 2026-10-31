import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrg } from './org.ts';
import { renderTemplate, fingerprint, checkLength, writeAtomic } from './render.ts';

const DEFAULT_TEMPLATES = fileURLToPath(new URL('../../light/templates/', import.meta.url));

export interface RenderResult {
  inputSha: string;
  outputs: Array<{ file: string; bytes: number; sha: string }>;
  members: number;
  warn: boolean;
  /** 已存在产物里指纹与本次输入不一致的文件（被手改过） */
  tampered: string[];
}

interface Manifest { input_sha256: string; files: Record<string, string> }

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function readManifest(outDir: string): Manifest | null {
  const p = join(outDir, 'manifest.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Manifest;
  } catch {
    return null;
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
  const manifest = readManifest(outDir);
  const record: Record<string, string> = {};
  const rel = (f: string) => f.slice(outDir.length + 1).replace(/\\/g, '/');

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

  for (const m of org.members) {
    const text = renderTemplate(memberTpl, {
      fingerprint: fpLine,
      member_name: m.name,
      member_id: m.id,
      company_bot_name: org.company.company_bot_name,
      vault_shared: org.company.vault_shared,
      local_workdir: org.company.local_workdir,
      owner_userid: m.userid || '<userid>',
    });
    const len = checkLength(text);
    if (!len.ok) throw new Error(`成员 ${m.id} 的 persona 超过 7500 字节（当前 ${len.bytes}）`);
    const f = join(outDir, 'members', m.id, 'CODEBUDDY.md');
    outputs.push({ file: f, bytes: len.bytes, sha: track(f, text) });
  }

  const groups = {
    generated_at: new Date().toISOString(),
    input_sha256: inputSha,
    members: org.members.map((m) => ({ id: m.id, name: m.name, chat_id: m.chat_id || null, userid: m.userid || null, webhook_file: m.webhook_file || null })),
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'groups.json'), JSON.stringify(groups, null, 2) + '\n', 'utf8');
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ input_sha256: inputSha, generated_at: new Date().toISOString(), files: record }, null, 2) + '\n', 'utf8');

  return { inputSha, outputs, members: org.members.length, warn: cLen.warn, tampered };
}
