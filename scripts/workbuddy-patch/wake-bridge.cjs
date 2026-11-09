'use strict';

/*
 * ANC WorkBuddy opt-in wake bridge.
 *
 * WorkBuddy has no public "wake this conversation" API. This module runs in the
 * Electron main process (loaded by preload.cjs) and exposes a loopback-only
 * endpoint that inserts a short prompt into the *current* composer and sends it.
 *
 * It is deliberately narrow:
 *   - only if %ProgramData%\anc\data\wb-wake.flag exists
 *   - only POST /wake with X-Anc-Token
 *   - refuses if the composer is not empty (never overwrite a human draft)
 *   - never creates a new conversation, never evaluates arbitrary JS
 *
 * Opt-in only; without the flag it is a no-op.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

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
        return json(res, 200, { ok: true, pid: process.pid, port: PORT });
      }
      if (!equal(req.headers['x-anc-token'], token)) return json(res, 401, { ok: false, error: 'X-Anc-Token mismatch' });
      if (req.method !== 'POST' || req.url !== '/wake') return json(res, 404, { ok: false, error: 'not found' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const prompt = String(body.prompt || '').trim();
      if (!prompt) return json(res, 400, { ok: false, error: 'prompt required' });
      if (prompt.length > 4000) return json(res, 413, { ok: false, error: 'prompt too long' });
      const win = getWindow(BrowserWindow);
      if (!win) return json(res, 503, { ok: false, error: 'no live WorkBuddy window' });
      const wc = win.webContents;
      const focused = await wc.executeJavaScript(`(() => {
        const el = document.querySelector('[contenteditable="true"],[role="textbox"]');
        if (!el) return { ok: false, reason: 'composer-missing' };
        const text = (el.innerText || '').replace(/[\\uFEFF\\u200B]/g, '').trim();
        const empty = !text || !!el.querySelector('[data-slate-placeholder="true"]') || !!el.querySelector('[data-cb-empty-leaf="true"]');
        if (!empty) return { ok: false, reason: 'composer-not-empty' };
        el.focus();
        return { ok: true };
      })()`, true);
      if (!focused || !focused.ok) return json(res, 409, { ok: false, error: focused && focused.reason || 'composer-unavailable' });
      wc.insertText(prompt);
      await new Promise((r) => setTimeout(r, 400));
      const sent = await wc.executeJavaScript(`(() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => x.getAttribute('aria-label') === '发送');
        if (!b) return false;
        if (b.disabled) return false;
        b.click();
        return true;
      })()`, true);
      return json(res, sent ? 200 : 409, { ok: !!sent, error: sent ? null : 'send-button-unavailable' });
    } catch (e) {
      log('request failed: ' + (e && e.stack ? e.stack : e));
      return json(res, 500, { ok: false, error: e && e.message ? e.message : String(e) });
    }
  });
  server.on('error', (e) => log('server error: ' + (e && e.message ? e.message : e)));
  global.__ancWakeServer = server;
  server.listen(PORT, '127.0.0.1', () => log('listening 127.0.0.1:' + PORT));
}

try { start().catch((e) => log('start failed: ' + (e && e.stack ? e.stack : e))); } catch (e) { log('load failed: ' + (e && e.stack ? e.stack : e)); }

module.exports = {};
