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

test('ingest 端点：未配 token 503、无 token 401、GET 405', async () => {
  const srv = await startServer({ port: 0, token: null, health: () => ({ ok: true, detail: 'x' }) });
  try {
    const r1 = await fetch(srv.url + '/__anc_ingest', { method: 'POST', body: '{"batch":"x"}' });
    assert.equal(r1.status, 503, '未配 token 时业务路由一律 503');
  } finally { await srv.close(); }

  const srv2 = await startServer({ port: 0, token: 'tk', health: () => ({ ok: true, detail: 'x' }) });
  try {
    const r2 = await fetch(srv2.url + '/__anc_ingest', { method: 'POST', body: '{"batch":"x"}' });
    assert.equal(r2.status, 401, '没带 token 应 401');
    const r3 = await fetch(srv2.url + '/__anc_ingest', { method: 'GET', headers: { authorization: 'Bearer tk' } });
    assert.equal(r3.status, 405, 'GET 应 405');
  } finally { await srv2.close(); }
});

test('ingest 端点：body 不对给 400，成功时把结果带回来', async () => {
  const seen: string[] = [];
  const srv = await startServer({
    port: 0,
    token: 'tk',
    health: () => ({ ok: true, detail: 'x' }),
    ingest: async (batch) => {
      seen.push(batch);
      if (!batch.includes('pending')) throw new Error('批次目录必须在 inbox/pending 下');
      return { added: ['collab/a.md'], modified: [], originals: ['_originals/a.txt'] };
    },
  });
  const auth = { authorization: 'Bearer tk' };
  try {
    // 坏 JSON
    const bad = await fetch(srv.url + '/__anc_ingest', { method: 'POST', headers: auth, body: '{oops' });
    assert.equal(bad.status, 400);

    // 缺 batch
    const none = await fetch(srv.url + '/__anc_ingest', { method: 'POST', headers: auth, body: '{}' });
    assert.equal(none.status, 400);

    // 实现里拒（越界路径）
    const refused = await fetch(srv.url + '/__anc_ingest', { method: 'POST', headers: auth, body: JSON.stringify({ batch: 'C:\\Windows' }) });
    assert.equal(refused.status, 400);
    const body = await refused.json() as { error: string };
    assert.match(body.error, /pending/, '失败原因要原样带回去');

    // 成功
    const ok = await fetch(srv.url + '/__anc_ingest', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ batch: 'C:\\ProgramData\\anc\\inbox\\pending\\batch-x' }),
    });
    assert.equal(ok.status, 200);
    const j = await ok.json() as { ok: boolean; added: string[]; originals: string[] };
    assert.equal(j.ok, true);
    assert.deepEqual(j.added, ['collab/a.md']);
    assert.deepEqual(j.originals, ['_originals/a.txt']);
    assert.equal(seen.length, 2, '实现应被调用两次（一次被拒、一次成功）');
  } finally { await srv.close(); }
});

test('ingest 端点：没配执行器时 503（防止只加了路由却没接实现）', async () => {
  const srv = await startServer({ port: 0, token: 'tk', health: () => ({ ok: true, detail: 'x' }) });
  try {
    const r = await fetch(srv.url + '/__anc_ingest', { method: 'POST', headers: { authorization: 'Bearer tk' }, body: '{"batch":"x"}' });
    assert.equal(r.status, 503);
    const j = await r.json() as { error: string };
    assert.equal(j.error, 'ingest-not-configured');
  } finally { await srv.close(); }
});

test('ingest 响应把 summaries 原样透传（P-2：摘要随入库一起回去）', async () => {
  const srv = await startServer({
    port: 0,
    token: 'tk',
    health: () => ({ ok: true, detail: 'x' }),
    ingest: async () => ({
      added: ['collab/a.md'],
      modified: [],
      originals: ['_originals/a.txt'],
      archived: 'C:\\inbox\\done\\b1',
      summaries: [{ path: 'collab/a.md', title: '标题', lines: ['要点一', '要点二'] }],
    }),
  });
  try {
    const r = await fetch(srv.url + '/__anc_ingest', {
      method: 'POST',
      headers: { authorization: 'Bearer tk' },
      body: JSON.stringify({ batch: 'C:\\ProgramData\\anc\\inbox\\pending\\b1' }),
    });
    assert.equal(r.status, 200);
    const j = await r.json() as { ok: boolean; summaries: Array<{ path: string; title: string; lines: string[] }> };
    assert.equal(j.ok, true);
    assert.equal(j.summaries.length, 1);
    assert.equal(j.summaries[0].path, 'collab/a.md');
    assert.deepEqual(j.summaries[0].lines, ['要点一', '要点二']);
  } finally { await srv.close(); }
});
