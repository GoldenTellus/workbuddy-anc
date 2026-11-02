// 审计：所有会改状态的 CLI 调用都留一行 JSONL。
//
// 为什么要有它（2026-11-02 实测驱动）：
//   1. bot 有文件系统权限，技能里的「只准走 CLI」是纪律不是约束——它绕过 CLI 直接往
//      vault 复制文件，路径校验/原件去重/入库锁全都没跑；
//   2. 绕过无法在写入时拦住，但可以**事后发现**：vault 里出现新文件，而审计里没有对应的
//      ingest 记录，就是绕过的证据。
// 所以审计只记「谁调了哪个命令、动到哪些目标」，不记参数值（值里可能有凭据）。
//
// 写失败不影响主流程：审计是观测手段，不是关卡。
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface AuditEntry {
  at: string;
  cmd: string;
  ok: boolean;
  code: string | null;
  targets: string[];
}

export function auditPath(dataDir: string): string {
  return join(dataDir, 'audit.log');
}

export function appendAudit(dataDir: string, entry: AuditEntry): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(auditPath(dataDir), JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    /* 审计写不进去不能挡住入库或提醒 */
  }
}

/** 从 argv 里拼一个稳定的命令名：`task add` / `ingest apply` / `config set`。 */
export function commandName(argv: string[]): string {
  const words = argv.filter((a) => !a.startsWith('--')).slice(0, 2);
  return words.length ? words.join(' ') : '(none)';
}
