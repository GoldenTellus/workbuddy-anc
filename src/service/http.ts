// 本地小服务的 HTTP 面：只监听 loopback，token 常量时间比较，未配 token 时 fail-closed。
//
// 边界（FORK §5.5 / PLAN C1）：
//   - 只监听 127.0.0.1：不对外、不走防火墙例外，员工机器也够不着；
//   - 未配置 token → 业务路由一律 503：宁可服务不可用，也不要"忘了配就等于没保护"；
//   - `/__anc_health` 不需要 token：watchdog 用它判存活，返回里只有 ok/detail/时间，没有业务数据；
//   - token 比较用 timingSafeEqual，长度不同直接 false（长度本身不算秘密）。
import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export interface HealthInfo {
  ok: boolean;
  detail: string;
}

export interface IngestOutcome {
  added: string[];
  modified: string[];
  originals: string[];
}

export interface ServerOptions {
  host?: string;
  port?: number;
  token: string | null;
  health: () => HealthInfo;
  status?: () => Record<string, unknown>;
  /**
   * 入库执行器（D24 方案 B）：bot 调 `POST /__anc_ingest`，由**服务身份**去写 vault。
   * 这样 vault 可以对 bot 用户收紧成只读，bot 只能写 inbox。
   * 路径校验放在实现里（它才知道 inbox 在哪），这里只保证方法、token 与 body 形状。
   */
  ingest?: (batchDir: string) => Promise<IngestOutcome>;
}

export interface StartedServer {
  url: string;
  port: number;
  host: string;
  close: () => Promise<void>;
}

function sameToken(got: string, want: string): boolean {
  const a = Buffer.from(got, 'utf8');
  const b = Buffer.from(want, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 读请求体：上限 64 KB（一个批次描述用不了这么多），超了直接断开。 */
function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('body-too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function presentedToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) {
    const v = auth.replace(/^Bearer\s+/i, '').trim();
    if (v) return v;
  }
  const x = req.headers['x-anc-token'];
  if (typeof x === 'string' && x.trim()) return x.trim();
  return null;
}

export async function startServer(opts: ServerOptions): Promise<StartedServer> {
  const host = opts.host ?? '127.0.0.1';
  const wantPort = opts.port ?? 17891;

  const server = createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(JSON.stringify(body));
    };

    let path = '/';
    try {
      path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch { send(400, { ok: false, error: 'bad-url' }); return; }

    // 存活探测：不带 token、只读，也不暴露业务数据
    if (path === '/__anc_health') {
      if (req.method !== 'GET') { send(405, { ok: false, error: 'method-not-allowed' }); return; }
      const h = opts.health();
      send(h.ok ? 200 : 503, { ok: h.ok, detail: h.detail, ts: new Date().toISOString() });
      return;
    }

    if (!opts.token) { send(503, { ok: false, error: 'token-not-configured' }); return; }

    const got = presentedToken(req);
    if (!got) { send(401, { ok: false, error: 'unauthorized' }); return; }
    if (!sameToken(got, opts.token)) { send(403, { ok: false, error: 'forbidden' }); return; }

    if (path === '/__anc_status') {
      if (req.method !== 'GET') { send(405, { ok: false, error: 'method-not-allowed' }); return; }
      send(200, { ok: true, ...(opts.status ? opts.status() : {}) });
      return;
    }

    if (path === '/__anc_ingest') {
      if (req.method !== 'POST') { send(405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!opts.ingest) { send(503, { ok: false, error: 'ingest-not-configured' }); return; }
      void (async () => {
        try {
          const raw = await readBody(req);
          let body: { batch?: unknown };
          try { body = JSON.parse(raw || '{}') as { batch?: unknown }; } catch { send(400, { ok: false, error: 'bad-json' }); return; }
          const batch = typeof body.batch === 'string' ? body.batch.trim() : '';
          if (!batch) { send(400, { ok: false, error: 'missing-batch' }); return; }
          const r = await opts.ingest!(batch);
          send(200, { ok: true, ...r });
        } catch (e) {
          // 入库失败要把原因原样带回去：bot 会把它转告给用户，不能只说"失败了"
          send(400, { ok: false, error: String((e as Error).message).slice(0, 500) });
        }
      })();
      return;
    }

    if (req.method !== 'GET') { send(405, { ok: false, error: 'method-not-allowed' }); return; }
    send(404, { ok: false, error: 'not-found' });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (e: Error): void => { server.off('listening', onListening); reject(e); };
    const onListening = (): void => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(wantPort, host);
  });

  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : wantPort;

  return {
    host,
    port,
    url: 'http://' + host + ':' + port,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}
