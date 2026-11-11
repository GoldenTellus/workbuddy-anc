import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { getConfig } from '../../core/index.ts';
import { startServer } from '../http.ts';
import { summarizeMarkdown } from '../../modules/knowledge/index.ts';
import type { CliContext } from './context.ts';

// 长驻 HTTP 面：只监听 127.0.0.1。token 从 secrets 读，未配置时业务路由全 503（fail-closed）
export default async function serve(ctx: CliContext): Promise<void> {
  const { db, args, numArg, dbPath } = ctx;
  const secretsDir = join(process.env.ProgramData ?? 'C:\\ProgramData', 'anc', 'secrets');
  const tokenFile = typeof args['token-file'] === 'string' ? args['token-file'] : join(secretsDir, 'service-token.txt');
  let token: string | null = null;
  if (existsSync(tokenFile)) {
    const raw = readFileSync(tokenFile, 'utf8').trim();
    token = raw || null;
  }
  if (!token) console.error('WARN  未配置 token（' + tokenFile + '）：业务路由会全部 503，只有 /__anc_health 可用');
  const logPath = join(dirname(dbPath), 'loop.log');

  const s = await startServer({
    port: numArg(args.port, 17891, 1024, 65535),
    token,
    // D24 方案 B：入库由服务身份执行，bot 只把批次写进 inbox。
    // vault 对 bot 收紧成只读之后，这条路径是**唯一**能写 vault 的入口。
    ingest: async (batchDir: string) => {
      const inboxRoot = join(process.env.ProgramData ?? 'C:\\ProgramData', 'anc', 'inbox');
      const pending = resolve(inboxRoot, 'pending');
      const target = resolve(batchDir);
      // 只认 inbox/pending 下的目录：否则这个端点等于"以服务身份写任意路径"
      if (!target.startsWith(pending + sep)) {
        throw new Error('批次目录必须在 ' + pending + ' 下，收到: ' + target);
      }
      const vaultShared = getConfig(db, 'vault_shared');
      if (!vaultShared) throw new Error('未配置 vault_shared（config set vault_shared <绝对路径>）');
      const { applyBatch, archiveBatch } = await import('../../modules/knowledge/ingest/apply.ts');
      const r = applyBatch(target, vaultShared);
      // 文件已经写进 vault 了，归档只是"把批次挪到 done"。
      // 归档失败（服务身份对 inbox 没有删权限，2026-11-02 实测）不该让调用方以为整批失败。
      let archived: string | null = null;
      try { archived = archiveBatch(target, inboxRoot); } catch (e) {
        console.error('WARN  批次已入库但归档失败: ' + (e as Error).message + '（手工把 ' + target + ' 挪到 inbox\\done 即可）');
      }
      // P-2：入库成功就把摘要一起带回去——摘要由本地规则生成（不调模型、不出网），
      // bot 拿到响应即可报给用户，不必再发一次请求。
      const summaries: Array<{ path: string; title: string; lines: string[] }> = [];
      for (const rel of r.added) {
        try {
          const sum = summarizeMarkdown(readFileSync(join(vaultShared, rel), 'utf8'));
          summaries.push({ path: rel, title: sum.title, lines: sum.lines });
        } catch (e) {
          console.error('WARN  摘要生成失败（不影响入库）: ' + rel + ' — ' + (e as Error).message);
        }
      }
      return { added: r.added, modified: r.modified, originals: r.originals, archived, summaries };
    },
    health: () => {
      let ageMin: number | null = null;
      try { ageMin = Math.round((Date.now() - statSync(logPath).mtimeMs) / 60000); } catch { ageMin = null; }
      return { ok: ageMin !== null && ageMin <= 10, detail: ageMin === null ? '没有 loop.log' : 'tick ' + ageMin + ' 分钟前' };
    },
    status: () => ({
      open_tasks: (db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE status='open'").get() as { c: number }).c,
      pending_outbox: (db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE status='pending'").get() as { c: number }).c,
    }),
  });
  console.log(JSON.stringify({ ok: true, url: s.url, token_configured: Boolean(token) }));
  const stop = (): void => {
    void s.close().then(() => { try { db.close(); } catch { /* ignore */ } process.exit(0); });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // 长驻：靠信号退出，finally 不会执行
  await new Promise<void>(() => { /* keep alive */ });
}
