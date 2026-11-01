import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './http.ts';

const HEALTH = () => ({ ok: true, detail: 'tick 1 分钟前' });

test('HTTP：health 不需要 token；未配 token 时业务路由 503', async () => {
  const s = await startServer({ port: 0, token: null, health: HEALTH, status: () => ({ open: 1 }) });
  try {
    const h = await fetch(s.url + '/__anc_health');
    assert.equal(h.status, 200);
    const hb = (await h.json()) as { ok: boolean; detail: string };
    assert.equal(hb.ok, true);
    assert.match(hb.detail, /tick/);

    const st = await fetch(s.url + '/__anc_status');
    assert.equal(st.status, 503);
    const sb = (await st.json()) as { error: string };
    assert.equal(sb.error, 'token-not-configured');
  } finally {
    await s.close();
  }
});

test('HTTP：缺 token 401、错 token 403、对 token 200', async () => {
  const token = 'a'.repeat(64);
  const s = await startServer({ port: 0, token, health: HEALTH, status: () => ({ open: 2 }) });
  try {
    assert.equal((await fetch(s.url + '/__anc_status')).status, 401);
    assert.equal((await fetch(s.url + '/__anc_status', { headers: { authorization: 'Bearer ' + 'b'.repeat(64) } })).status, 403);
    assert.equal((await fetch(s.url + '/__anc_status', { headers: { authorization: 'Bearer ' + token } })).status, 200);
    // 也接受 X-ANC-Token
    const r = await fetch(s.url + '/__anc_status', { headers: { 'x-anc-token': token } });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { ok: boolean; open: number };
    assert.equal(body.open, 2);
  } finally {
    await s.close();
  }
});

test('HTTP：只监听 127.0.0.1，且非 GET / 未知路径有明确响应', async () => {
  const s = await startServer({ port: 0, token: 'x'.repeat(64), health: HEALTH });
  try {
    assert.equal(s.host, '127.0.0.1');
    assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(s.url + '/nope', { headers: { authorization: 'Bearer ' + 'x'.repeat(64) } })).status, 404);
    const post = await fetch(s.url + '/__anc_health', { method: 'POST' });
    assert.equal(post.status, 405);
  } finally {
    await s.close();
  }
});

test('HTTP：health 不 ok 时返回 503（watchdog 靠这个判死）', async () => {
  const s = await startServer({ port: 0, token: null, health: () => ({ ok: false, detail: 'tick 42 分钟前' }) });
  try {
    const r = await fetch(s.url + '/__anc_health');
    assert.equal(r.status, 503);
    const b = (await r.json()) as { ok: boolean };
    assert.equal(b.ok, false);
  } finally {
    await s.close();
  }
});
