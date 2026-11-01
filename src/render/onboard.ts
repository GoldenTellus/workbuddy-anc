import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';
import { backupUnique } from './render.ts';

export interface OnboardOptions {
  packageDir: string;
  homeDir: string;
  cardsDir?: string;
  vaultShared?: string;
  adopt?: boolean;
}

export interface OnboardResult {
  persona: string;
  backedUp: string[];
  cards: string[];
  record: string;
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

// 毫秒时间戳 + 不覆盖：同一秒内两次 --adopt 不会让第二次备份盖掉员工原来的 persona
function backupFile(file: string): string {
  return backupUnique(file, file);
}

/** 把渲染好的个人接入包装到员工机（模拟 home 目录，便于测试）。 */
export function installPackage(opts: OnboardOptions): OnboardResult {
  const personaSrc = join(opts.packageDir, 'CODEBUDDY.md');
  if (!existsSync(personaSrc)) throw new Error('接入包缺少 CODEBUDDY.md: ' + opts.packageDir);

  const clawDir = join(opts.homeDir, 'WorkBuddy', 'Claw');
  const personaDst = join(clawDir, 'CODEBUDDY.md');
  if (existsSync(personaDst) && !opts.adopt) {
    throw new Error('目标已有 CODEBUDDY.md，确认覆盖请加 --adopt（会先备份）: ' + personaDst);
  }

  const backedUp: string[] = [];
  mkdirSync(clawDir, { recursive: true });
  if (existsSync(personaDst)) backedUp.push(backupFile(personaDst));
  copyFileSync(personaSrc, personaDst);

  const cards: string[] = [];
  const cardHashes: Record<string, string> = {};
  if (opts.cardsDir && existsSync(opts.cardsDir)) {
    for (const name of readdirSync(opts.cardsDir)) {
      const src = join(opts.cardsDir, name, 'SKILL.md');
      if (!existsSync(src)) continue;
      let content = readFileSync(src, 'utf8');
      if (opts.vaultShared) content = content.split('{{vault_shared}}').join(opts.vaultShared);
      const dst = join(opts.homeDir, '.workbuddy', 'skills', name, 'SKILL.md');
      mkdirSync(join(opts.homeDir, '.workbuddy', 'skills', name), { recursive: true });
      if (existsSync(dst)) backedUp.push(backupFile(dst));
      writeFileSync(dst, content, 'utf8');
      cards.push(dst);
      cardHashes[name] = sha(content);
    }
  }

  const record = join(clawDir, '.anc-install.json');
  writeFileSync(record, JSON.stringify({
    installed_at: new Date().toISOString(),
    persona_sha256: sha(readFileSync(personaDst, 'utf8')),
    cards: cardHashes,
  }, null, 2) + '\n', 'utf8');

  return { persona: personaDst, backedUp, cards, record };
}

/** 对拍安装记录：返回被改过/缺失的文件。 */
export function verifyInstall(homeDir: string): { ok: boolean; changed: string[] } {
  const clawDir = join(homeDir, 'WorkBuddy', 'Claw');
  const recordPath = join(clawDir, '.anc-install.json');
  if (!existsSync(recordPath)) throw new Error('没有安装记录: ' + recordPath);
  const rec = JSON.parse(readFileSync(recordPath, 'utf8')) as { persona_sha256: string; cards: Record<string, string> };
  const changed: string[] = [];

  const persona = join(clawDir, 'CODEBUDDY.md');
  if (!existsSync(persona) || sha(readFileSync(persona, 'utf8')) !== rec.persona_sha256) changed.push(persona);

  for (const [name, want] of Object.entries(rec.cards || {})) {
    const f = join(homeDir, '.workbuddy', 'skills', name, 'SKILL.md');
    if (!existsSync(f) || sha(readFileSync(f, 'utf8')) !== want) changed.push(f);
  }
  return { ok: changed.length === 0, changed };
}
