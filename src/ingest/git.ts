import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// vault 内容来自 bot 整理的批次，不可信：关掉 hooks 与 fsmonitor，git 不执行仓库里的任何程序
const SAFE = ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), '-c', 'core.fsmonitor=false'];

/**
 * 在 vault 仓库里提交当前改动。
 * - 作者固定为 anc-ingest（不把 userid 写进提交历史）；
 * - 提交信息经 -F 文件传入，参数用数组，不经 shell；
 * - 没有改动时返回 null。
 */
export function commitVault(vaultDir: string, message: string, paths?: string[]): string | null {
  if (!existsSync(join(vaultDir, '.git'))) throw new Error('不是 git 仓库: ' + vaultDir);
  // 给了 paths 就只提交本批的文件：别的批次还在等复核、或有人手改过的内容不能被顺带提交。
  // 不给 paths 时沿用旧行为（整库提交，排除备份/临时文件）。
  const scope = paths && paths.length ? paths.map((p) => ':(literal)' + p) : ['.', ':(exclude)*.bak-*', ':(exclude).tmp-*'];
  execFileSync('git', [...SAFE, 'add', '-A', '--', ...scope], { cwd: vaultDir });
  // 用暂存区判断：只剩被排除的未跟踪文件时 status 非空，但其实没有可提交的内容
  try {
    execFileSync('git', [...SAFE, 'diff', '--cached', '--quiet', '--', ...scope], { cwd: vaultDir });
    return null;
  } catch { /* 退出码 1 = 有暂存改动，继续提交 */ }

  const msgFile = join(vaultDir, '.git', 'ANC_COMMIT_MSG');
  writeFileSync(msgFile, message, 'utf8');
  try {
    execFileSync('git', [
      ...SAFE,
      '-c', 'user.name=anc-ingest',
      '-c', 'user.email=anc-ingest@localhost',
      'commit', '-q', '-F', msgFile,
      // 只提交这些路径：暂存区里别人 add 过的东西不被带进来
      ...(paths && paths.length ? ['--', ...scope] : []),
    ], { cwd: vaultDir });
  } finally {
    try { unlinkSync(msgFile); } catch { /* ignore */ }
  }
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: vaultDir, encoding: 'utf8' }).trim();
}
