import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 在 vault 仓库里提交当前改动。
 * - 作者固定为 anc-ingest（不把 userid 写进提交历史）；
 * - 提交信息经 -F 文件传入，参数用数组，不经 shell；
 * - 没有改动时返回 null。
 */
export function commitVault(vaultDir: string, message: string): string | null {
  if (!existsSync(join(vaultDir, '.git'))) throw new Error('不是 git 仓库: ' + vaultDir);
  execFileSync('git', ['add', '-A'], { cwd: vaultDir });
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: vaultDir, encoding: 'utf8' });
  if (!status.trim()) return null;

  const msgFile = join(vaultDir, '.git', 'ANC_COMMIT_MSG');
  writeFileSync(msgFile, message, 'utf8');
  try {
    execFileSync('git', [
      '-c', 'user.name=anc-ingest',
      '-c', 'user.email=anc-ingest@localhost',
      'commit', '-q', '-F', msgFile,
    ], { cwd: vaultDir });
  } finally {
    try { unlinkSync(msgFile); } catch { /* ignore */ }
  }
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: vaultDir, encoding: 'utf8' }).trim();
}
