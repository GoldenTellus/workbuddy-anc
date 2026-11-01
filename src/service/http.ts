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

export interface ServerOptions {
  host?: string;
  port?: number;
  token: string | null;
  health: () => HealthInfo;
  status?: () => Record<string, unknown>;
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

    if (req.method !== 'GET') { send(405, { ok: false, error: 'method-not-allowed' }); return; }

    let path = '/';
    try {
      path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch { send(400, { ok: false, error: 'bad-url' }); return; }

    // 存活探测：不带 token，也不暴露业务数据
    if (path === '/__anc_health') {
      const h = opts.health();
      send(h.ok ? 200 : 503, { ok: h.ok, detail: h.detail, ts: new Date().toISOString() });
      return;
    }

    if (!opts.token) { send(503, { ok: false, error: 'token-not-configured' }); return; }

    const got = presentedToken(req);
    if (!got) { send(401, { ok: false, error: 'unauthorized' }); return; }
    if (!sameToken(got, opts.token)) { send(403, { ok: false, error: 'forbidden' }); return; }

    if (path === '/__anc_status') {
      send(200, { ok: true, ...(opts.status ? opts.status() : {}) });
      return;
    }
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
