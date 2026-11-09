'use strict';

/*
 * ANC WorkBuddy opt-in UI control bridge.
 *
 * Two generations of mechanism live here:
 *   2.x (2026-11-10, preferred): drive the renderer's own `window.wb` API —
 *       `wb.conversations.create({ conversationId, cwd, ... })` creates a task
 *       conversation with a caller-chosen id, and `conversation.sendPrompt([...])`
 *       sends a prompt into *any* conversation without switching the visible tab.
 *       This is what makes "one daily host conversation per day" possible:
 *       the wake job targets the host's stored conversation_id instead of
 *       creating a new host per Ticket.
 *   1.x (fallback): the old DOM path — click 新建任务 / workspace picker / insert
 *       text into the composer / click 发送. Kept for WorkBuddy upgrades where
 *       `window.wb` is not exposed (or changes shape); never used when the API path
 *       reports success.
 *
 * Safety rails (unchanged):
 *   - only if %ProgramData%\anc\data\wb-wake.flag exists
 *   - only loopback, only with X-Anc-Token
 *   - /new only creates one conversation; /wake only sends one prompt
 *   - never evaluates arbitrary caller JS
 *
 * Opt-in only; without the flag it is a no-op.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const BRIDGE_VERSION = '2.0';

const DATA_DIR = (function () {
  const v = String(process.env.ANC_DATA_DIR || '').trim();
  if (v) return v;
  return path.join(String(process.env.ProgramData || 'C:\\ProgramData').trim(), 'anc', 'data');
})();
const FLAG = path.join(DATA_DIR, 'wb-wake.flag');
const TOKEN_FILE = path.join(DATA_DIR, 'wb-wake-token');
const LOG = path.join(DATA_DIR, 'wb-wake.log');
const PORT = (function () {
  const n = parseInt(String(process.env.ANC_WB_WAKE_PORT || ''), 10);
  return n > 0 && n < 65536 ? n : 18187;
})();

function log(line) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG, new Date().toISOString() + ' [wake ' + process.pid + '] ' + line + '\r\n', 'utf8');
  } catch (_) { /* ignore */ }
}

function readToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch (_) { /* create below */ }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const t = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(TOKEN_FILE, t + '\n', { encoding: 'utf8', mode: 0o600 });
    return t;
  } catch (e) {
    log('token create failed: ' + (e && e.message ? e.message : e));
    return '';
  }
}

function equal(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function json(res, code, obj) {
  try {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  } catch (_) { /* ignore */ }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function getWindow(BrowserWindow) {
  try {
    return BrowserWindow.getAllWindows().find((w) => w && !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed()) || null;
  } catch (_) { return null; }
}

/** Caller-supplied strings are re-serialized as JSON literals; never concatenated raw. */
function cleanId(v) {
  const s = String(v || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/.test(s) ? s : '';
}
function cleanTitle(v) {
  return String(v || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
}
function cleanWorkspace(v) {
  return String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 240);
}

/** Renderer snippet: create a task conversation with a stable id and send the first prompt. */
function wbNewTaskScript(prompt, workspace, conversationId, title) {
  return `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wb = window.wb;
  if (!wb || !wb.conversations || typeof wb.conversations.create !== 'function') return { ok: false, reason: 'wb-api-missing' };
  const conversationId = ${JSON.stringify(conversationId)};
  const createInput = {
    conversationId,
    transport: 'local',
    conversationOrigin: 'local',
    welcomeMode: 'coding',
    mode: 'craft',
    isPlayground: false,
  };
  const workspace = ${JSON.stringify(workspace)};
  const title = ${JSON.stringify(title)};
  const prompt = ${JSON.stringify(prompt)};
  if (workspace) createInput.cwd = workspace;
  if (title) createInput.title = title;
  try { await wb.conversations.create(createInput); }
  catch (e) { return { ok: false, reason: 'create-failed', error: String((e && e.message) || e), conversationId }; }
  let conv = null;
  for (let i = 0; i < 40 && !conv; i++) {
    try { conv = await wb.conversations.get(conversationId); } catch (e) { /* not ready yet */ }
    if (!conv) await sleep(150);
  }
  if (!conv) return { ok: false, reason: 'create-not-found', conversationId };
  try { await conv.sendPrompt([{ type: 'text', text: prompt }], {}); }
  catch (e) { return { ok: false, reason: 'send-failed', error: String((e && e.message) || e), conversationId }; }
  return { ok: true, conversationId, title: title || null, via: 'wb' };
})()`;
}

/** Renderer snippet: send a prompt into an existing conversation by id (no tab switching). */
function wbWakeConversationScript(prompt, conversationId) {
  return `(async () => {
  const wb = window.wb;
  if (!wb || !wb.conversations || typeof wb.conversations.get !== 'function') return { ok: false, reason: 'wb-api-missing' };
  const conversationId = ${JSON.stringify(conversationId)};
  const prompt = ${JSON.stringify(prompt)};
  let conv = null;
  try { conv = await wb.conversations.get(conversationId); } catch (e) { /* missing */ }
  if (!conv) return { ok: false, reason: 'conversation-not-found', conversationId };
  try { await conv.sendPrompt([{ type: 'text', text: prompt }], {}); }
  catch (e) { return { ok: false, reason: 'send-failed', error: String((e && e.message) || e), conversationId }; }
  return { ok: true, conversationId, via: 'wb' };
})()`;
}

/** Renderer snippet: send into whatever conversation is current (legacy /wake semantics). */
function wbWakeCurrentScript(prompt) {
  return `(async () => {
  const wb = window.wb;
  if (!wb || !wb.conversations || !wb.conversations.current || typeof wb.conversations.current.sendPrompt !== 'function') return { ok: false, reason: 'wb-api-missing' };
  const prompt = ${JSON.stringify(prompt)};
  try { await wb.conversations.current.sendPrompt([{ type: 'text', text: prompt }], {}); }
  catch (e) { return { ok: false, reason: 'send-failed', error: String((e && e.message) || e) }; }
  return { ok: true, conversationId: wb.conversations.currentId || null, via: 'wb' };
})()`;
}

function wbCurrentIdScript() {
  return `(() => { try { const wb = window.wb; return { ok: true, conversationId: (wb && wb.conversations && wb.conversations.currentId) || null }; } catch (e) { return { ok: false, reason: 'wb-api-missing' }; } })()`;
}

/** v1 DOM path: click 新建任务 → pick workspace → type → send. */
async function domNewTask(wc, prompt, workspace) {
  const opened = await wc.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const textOf = (el) => (el.innerText || '').replace(/\\s+/g, ' ').trim();
    const find = (needle) => Array.from(document.querySelectorAll('button,[role="tab"],[role="button"]')).find((el) => textOf(el) === needle) || null;
    const tab = find('新建任务');
    if (!tab) return { ok: false, reason: 'new-task-button-missing' };
    tab.click();
    await sleep(900);
    if (${JSON.stringify(workspace)}) {
      let opt = Array.from(document.querySelectorAll('li.wb-dropdown__item, [role="menuitem"], [role="option"]'))
        .find((el) => textOf(el) === ${JSON.stringify(workspace)});
      if (!opt) {
        const ws = document.querySelector('.cr-workspace-picker');
        if (!ws) return { ok: false, reason: 'workspace-button-missing' };
        ws.click();
        await sleep(700);
        opt = Array.from(document.querySelectorAll('li.wb-dropdown__item, [role="menuitem"], [role="option"]'))
          .find((el) => textOf(el) === ${JSON.stringify(workspace)});
      }
      if (!opt) return { ok: false, reason: 'workspace-option-missing' };
      opt.click();
      await sleep(600);
    }
    const el = document.querySelector('[contenteditable="true"],[role="textbox"]');
    if (!el) return { ok: false, reason: 'composer-missing' };
    el.focus();
    return { ok: true };
  })()`, true);
  if (!opened || !opened.ok) return { ok: false, reason: (opened && opened.reason) || 'new-task-failed', via: 'dom' };
  wc.insertText(prompt);
  await new Promise((r) => setTimeout(r, 400));
  const sent = await wc.executeJavaScript(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.getAttribute('aria-label') === '发送');
    if (!b || b.disabled) return false;
    b.click();
    return true;
  })()`, true);
  return sent ? { ok: true, via: 'dom' } : { ok: false, reason: 'send-button-unavailable', via: 'dom' };
}

/** v1 DOM path: insert into the current composer and send (refuses to touch a human draft). */
async function domWakeCurrent(wc, prompt) {
  const focused = await wc.executeJavaScript(`(() => {
    const el = document.querySelector('[contenteditable="true"],[role="textbox"]');
    if (!el) return { ok: false, reason: 'composer-missing' };
    const text = (el.innerText || '').replace(/[\\uFEFF\\u200B]/g, '').trim();
    const empty = !text || !!el.querySelector('[data-slate-placeholder="true"]') || !!el.querySelector('[data-cb-empty-leaf="true"]');
    if (!empty) return { ok: false, reason: 'composer-not-empty' };
    el.focus();
    return { ok: true };
  })()`, true);
  if (!focused || !focused.ok) return { ok: false, reason: (focused && focused.reason) || 'composer-unavailable', via: 'dom' };
  wc.insertText(prompt);
  await new Promise((r) => setTimeout(r, 400));
  const sent = await wc.executeJavaScript(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.getAttribute('aria-label') === '发送');
    if (!b) return false;
    if (b.disabled) return false;
    b.click();
    return true;
  })()`, true);
  return sent ? { ok: true, via: 'dom' } : { ok: false, reason: 'send-button-unavailable', via: 'dom' };
}

async function handleNew(win, body) {
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return { code: 400, obj: { ok: false, error: 'prompt required' } };
  if (prompt.length > 4000) return { code: 413, obj: { ok: false, error: 'prompt too long' } };
  const workspace = cleanWorkspace(body.workspace);
  const title = cleanTitle(body.title);
  const requestedId = cleanId(body.conversationId);
  const conversationId = requestedId || crypto.randomUUID();
  const wc = win.webContents;

  let wb = null;
  try { wb = await wc.executeJavaScript(wbNewTaskScript(prompt, workspace, conversationId, title), true); }
  catch (e) { wb = { ok: false, reason: 'execute-failed', error: String((e && e.message) || e) }; }
  if (wb && wb.ok) {
    log('new ok via=wb conversation=' + wb.conversationId + ' workspace=' + (workspace || '(default)') + ' len=' + prompt.length);
    return { code: 200, obj: { ok: true, conversationId: wb.conversationId, title: wb.title, via: 'wb' } };
  }
  if (wb && wb.reason && wb.reason !== 'wb-api-missing') {
    log('new FAILED via=wb reason=' + wb.reason + ' conversation=' + conversationId);
    return { code: 409, obj: { ok: false, error: wb.reason, conversationId, via: 'wb', detail: wb.error || null } };
  }

  // Fallback: WorkBuddy build without window.wb — old DOM flow.
  log('new fallback via=dom reason=' + ((wb && wb.reason) || 'unknown'));
  const dom = await domNewTask(wc, prompt, workspace);
  if (!dom.ok) { log('new FAILED via=dom reason=' + dom.reason); return { code: 409, obj: { ok: false, error: dom.reason, via: 'dom' } }; }
  let realId = null;
  try { const cur = await wc.executeJavaScript(wbCurrentIdScript(), true); if (cur && cur.ok) realId = cur.conversationId || null; } catch (_) { /* ignore */ }
  return { code: 200, obj: { ok: true, conversationId: realId, via: 'dom' } };
}

async function handleWake(win, body) {
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return { code: 400, obj: { ok: false, error: 'prompt required' } };
  if (prompt.length > 4000) return { code: 413, obj: { ok: false, error: 'prompt too long' } };
  const conversationId = cleanId(body.conversationId);
  const wc = win.webContents;

  if (conversationId) {
    let r = null;
    try { r = await wc.executeJavaScript(wbWakeConversationScript(prompt, conversationId), true); }
    catch (e) { r = { ok: false, reason: 'execute-failed', error: String((e && e.message) || e) }; }
    if (r && r.ok) {
      log('wake ok via=wb conversation=' + conversationId + ' len=' + prompt.length);
      return { code: 200, obj: { ok: true, conversationId, via: 'wb' } };
    }
    log('wake FAILED via=wb conversation=' + conversationId + ' reason=' + ((r && r.reason) || 'unknown'));
    return { code: 409, obj: { ok: false, error: (r && r.reason) || 'wake-failed', conversationId, via: 'wb', detail: (r && r.error) || null } };
  }

  // Legacy: no target id — old /wake behaviour (current composer) then wb current fallback.
  let dom = null;
  try { dom = await domWakeCurrent(wc, prompt); }
  catch (e) { dom = { ok: false, reason: 'execute-failed', error: String((e && e.message) || e) }; }
  if (dom && dom.ok) { log('wake ok via=dom current len=' + prompt.length); return { code: 200, obj: { ok: true, via: 'dom' } }; }
  let cur = null;
  try { cur = await wc.executeJavaScript(wbWakeCurrentScript(prompt), true); }
  catch (e) { cur = { ok: false, reason: 'execute-failed', error: String((e && e.message) || e) }; }
  if (cur && cur.ok) { log('wake ok via=wb-current conversation=' + (cur.conversationId || '?') + ' len=' + prompt.length); return { code: 200, obj: { ok: true, conversationId: cur.conversationId || null, via: 'wb-current' } }; }
  log('wake FAILED dom=' + ((dom && dom.reason) || '?') + ' wb=' + ((cur && cur.reason) || '?'));
  return { code: 409, obj: { ok: false, error: (cur && cur.reason) || (dom && dom.reason) || 'wake-failed' } };
}

async function start() {
  if (!fs.existsSync(FLAG)) return;
  const token = readToken();
  if (!token) return;
  const electron = require('electron');
  const { app, BrowserWindow } = electron;
  if (!app || !BrowserWindow) return;
  await app.whenReady();
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return json(res, 200, { ok: true, pid: process.pid, port: PORT, bridge: BRIDGE_VERSION });
      }
      if (!equal(req.headers['x-anc-token'], token)) return json(res, 401, { ok: false, error: 'X-Anc-Token mismatch' });
      if (req.method === 'POST' && (req.url === '/new' || req.url === '/wake')) {
        const body = JSON.parse((await readBody(req)) || '{}');
        const win = getWindow(BrowserWindow);
        if (!win) return json(res, 503, { ok: false, error: 'no live WorkBuddy window' });
        const result = req.url === '/new' ? await handleNew(win, body) : await handleWake(win, body);
        return json(res, result.code, result.obj);
      }
      return json(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      log('request failed: ' + (e && e.stack ? e.stack : e));
      return json(res, 500, { ok: false, error: e && e.message ? e.message : String(e) });
    }
  });
  server.on('error', (e) => log('server error: ' + (e && e.message ? e.message : e)));
  global.__ancWakeServer = server;
  server.listen(PORT, '127.0.0.1', () => log('listening 127.0.0.1:' + PORT + ' bridge=' + BRIDGE_VERSION));
}

try { start().catch((e) => log('start failed: ' + (e && e.stack ? e.stack : e))); } catch (e) { log('load failed: ' + (e && e.stack ? e.stack : e)); }

module.exports = {};
