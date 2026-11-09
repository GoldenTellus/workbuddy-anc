#!/usr/bin/env node
'use strict';
// ANC WorkBuddy patch：在 wecomaibot-client 加载时给 emitMessage 套壳，
// 把 AIBot 回调里的 chatId / 发送人拼进消息正文，让群身份进入 agent 的上下文。
// 2026-11-10（GAP-079 / DEV-02）起再追加两个可选字段：`msg=<msgId>`、`quote=<引用文本>`。
// 引用文本来自原型方法 handleTextMessage/handleMixedMessage/handleMediaMessage 的 `e.body.quote`
// —— emitMessage 收到的 m 里没有 quote；客户端 resolveQuoteMedia 只处理 image/file/video，
// 文本引用（引用一条带 A12 的 bot 通知再回「可以」）不经过它，只能在原型层先抓。
//
// 约束（对应 FORK-DIRECTION §11）：
//   - 只在本进程内存生效，不改 app.asar / exe，不写厂商代码 diff；
//   - 目标文件 sha256 与 manifest 不符时 fail-closed：只记日志，不打补丁；
//   - ANC_WB_PATCH=0 / off / false 时整体关闭；
//   - 无 manifest 或任何异常都静默跳过，不影响 WorkBuddy 启动；
//   - quote 捕获/清洗任何一步失败都只是不加 quote 字段，不改变原有入站。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── 入站前缀装饰的纯函数（唯一真相）────────────────────────────────
// PATCH_BODY 用 .toString() 把同一份实现嵌进目标模块（包在 IIFE 里，避免与压缩后的厂商变量重名）；
// 测试用 `ANC_WB_PURE_PROBE=1` require 本文件直接拿这三个函数，不复制第二份逻辑。
// 规则：quote 单行化（去 \r\n、折叠空白）、去 [ ]（防止伪造/破坏 [anc:...] 前缀边界）、
// 超过 300 字截断加 …；msgId 只允许安全字符（WorkBuddy 实测是 32 位 hex），其余一律不注入。
function ancOneLine(text, maxLen) {
  var s = String(text == null ? '' : text);
  s = s.replace(/[\r\n]+/g, ' ');
  s = s.replace(/\[/g, '').replace(/\]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  var max = (typeof maxLen === 'number' && maxLen > 0) ? Math.floor(maxLen) : 300;
  if (s.length > max) s = s.slice(0, max) + '…';
  return s;
}

function ancSafeMsgId(v) {
  var s = String(v == null ? '' : v).trim();
  return /^[A-Za-z0-9._:-]{1,64}$/.test(s) ? s : '';
}

// 只用于「排障字段」：quote 的类型名 / 键名列表（真实群引用形状未实测，拿不到文本时靠它定位）。
function ancSafeToken(v, maxLen) {
  var s = String(v == null ? '' : v).trim();
  s = s.replace(/[^A-Za-z0-9_,.:$-]/g, '');
  var max = (typeof maxLen === 'number' && maxLen > 0) ? Math.floor(maxLen) : 120;
  return s.length > max ? s.slice(0, max) : s;
}

// 文本引用的字段形状未在客户端里被读取（GAP-079 原文：形状未实测），按已知回调形态防御性取：
// quote.text.content（最常见）/ quote.content / quote.msg.text.content / quote.msg.content / quote 字符串。
// 任何一层是 getter 抛错都吞掉返回空串：捕获失败不能让入站消息消失。
function ancQuoteTextFromBody(body) {
  try {
    if (!body) return '';
    var q = body.quote;
    if (!q) return '';
    if (typeof q === 'string') return q;
    var v = '';
    if (q.text && typeof q.text === 'object') v = q.text.content;
    else if (typeof q.text === 'string') v = q.text;
    if (!v && typeof q.content === 'string') v = q.content;
    if (!v && q.msg) {
      var mt = q.msg.text;
      v = (mt && typeof mt === 'object') ? mt.content : mt;
      if (!v && typeof q.msg.content === 'string') v = q.msg.content;
    }
    return typeof v === 'string' ? v : '';
  } catch (e) {
    return '';
  }
}

/**
 * 进程守卫（2026-11-02 加，起因见 VERIFY §16）：
 * 本文件会被 NODE_OPTIONS=--require 加载，一旦设成系统/服务级，**每个** Node 进程都会跑它。
 * 而下面有一段"劫持 https.request 拦自动升级"的逻辑——在 Electron 主进程里劫持 https，
 * 会破坏 Electron 自身的初始化：实测主进程加载后立即 exit 0（env 方式下的现象）。
 *
 * 所以主进程（Electron 的 browser 进程）直接什么都不做；
 * 只有子进程（renderer / utility / daemon 等）才继续。
 * --inspect-brk + inject 那条路传不到子进程，env 方式能传到，加上这道守卫后 env 才安全。
 */
const __ancIsMainProc = (function () {
  try {
    const isElectron = !!(process.versions && process.versions.electron);
    return isElectron && String(process.type || '') === 'browser';
  } catch (e) {
    return false;
  }
})();
if (__ancIsMainProc) {
  // 只有显式创建 wb-wake.flag 时才监听；没有 flag 时模块自身 no-op。
  try { require('./wake-bridge.cjs'); } catch (e) { /* 不阻断 WorkBuddy 启动 */ }
  module.exports = {};
  return;
}

const MANIFEST = path.join(__dirname, 'manifest.json');

let mf = null;
try {
  mf = JSON.parse(fs.readFileSync(MANIFEST, 'utf8').replace(/^\uFEFF/, ''));
} catch (_) {
  mf = null;
}
if (!mf) {
  // 没有 manifest 就什么都不做
  module.exports = {};
  return;
}

function expand(p) {
  return String(p || '').replace(/%([^%]+)%/g, function (_, k) { return process.env[k] || ''; });
}

const LOG = expand(mf.log || '%USERPROFILE%\\anc\\workbuddy-patch.log');
const STATE = expand(mf.state || '%ProgramData%\anc\data\patch-state.json');
// 出站文本记录（默认关）：存在 log-out.flag 时，把真正要发出去的最终文本追加到 patch-out.log。
// 用途：验收"另一个工作区读不到 Claw 的 CODEBUDDY.md"这类只能在 UI 里跑的事，事后可机读。
const __ancPath = require('path');
const OUT_FLAG = __ancPath.join(__ancPath.dirname(STATE), 'log-out.flag');
const OUT_LOG = __ancPath.join(__ancPath.dirname(STATE), 'patch-out.log');
// 入站记录（2026-11-05 加）：AIBot 收到一条消息就记一行。
// 为什么需要：出站日志（patch-out.log）只在 bot **回话**时才有，
// 而「消息到底进没进来」和「进来了但没回」是两件事，靠出站日志分不开。
// 排障场景：新群 @ 了 bot 但没反应——是这个群没收到，还是收到了但没回？
const IN_LOG = __ancPath.join(__ancPath.dirname(STATE), 'patch-in.log');
// 方法清单 + 命中记录（2026-11-05 加）：定位「出站到底走哪个方法」。
// 为什么需要：patch-out.log 只记 sendReply，sendStreamChunk 没 hook。
// 结果「bot 收到消息但不回」时分不清是「走流式没记」还是「模型真没输出」。
// 这个探针把原型方法名列一遍，并把每次调用记下来 —— 用文件证据代替猜。
const HOOKS_LOG = __ancPath.join(__ancPath.dirname(STATE), 'patch-hooks.log');
const __ancHitCount = Object.create(null);
global.__ancHookList = function (names) {
  try {
    const line = new Date().toISOString() + ' LIST [' + names.join(', ') + ']' + '\n';
    fs.appendFileSync(HOOKS_LOG, line, 'utf8');
  } catch (e) {}
};
global.__ancHookHit = function (name) {
  try {
    if (!/send|reply|stream|message|emit|post|deliver/i.test(name)) return;
    __ancHitCount[name] = (__ancHitCount[name] || 0) + 1;
    const line = new Date().toISOString() + ' HIT ' + name + ' #' + __ancHitCount[name] + '\n';
    fs.appendFileSync(HOOKS_LOG, line, 'utf8');
  } catch (e) {}
};

global.__ancLogIn = function (chatId, user, content, extra) {
  try {
    // 计数只用于 /emit/status 的观测：入站消息经过补丁包装 = bot 侧确实收到了它。
    // 注意它含真实群消息，不能当"注入已被处理"的精确计数（见 status 的 note）。
    if (global.__ancEmitState) {
      global.__ancEmitState.observed += 1;
      global.__ancEmitState.lastObservedAt = Date.now();
    }
    const s = String(content == null ? '' : content);
    const t = s.length > 300 ? s.slice(0, 300) + '...' : s;
    // GAP-079：把 msg=/quote= 也记进 patch-in.log，用于机械验证「引用消息到底带没带进来」。
    // 真实引用要人在群里点引用；这里先保证「带进来就能看到」，不替代真实群验收。
    let tail = '';
    try {
      const ex = extra || {};
      const mid = ancSafeMsgId(ex.msgId);
      const q = ancOneLine(ex.quote, 300);
      const qt = ancSafeToken(ex.quoteType, 32);
      const qk = ancSafeToken(ex.quoteKeys, 120);
      if (mid) tail += ' msg=' + mid;
      if (q) tail += ' quote=' + q;
      // 真实群引用形状未实测（GAP-079）：拿不到文本时至少留下类型/键名，免得上生产再猜。
      if (qt) tail += ' quote-type=' + qt;
      if (qk) tail += ' quote-keys=' + qk;
    } catch (e) { /* 记录失败不影响计数与日志主体 */ }
    const line = new Date().toISOString() + ' chat=' + String(chatId || '').slice(0, 64) +
      ' from=' + String(user || '').slice(0, 64) + tail + ' len=' + s.length +
      ' text=' + t.replace(/\r?\n/g, '\\n') + '\n';
    fs.appendFileSync(IN_LOG, line, 'utf8');
  } catch (e) {}
};

global.__ancLogOut = function (chatId, text) {
  try {
    if (!fs.existsSync(OUT_FLAG)) return;
    const s = String(text == null ? '' : text);
    // 出站记录只留前 MAX_OUT_TEXT 字。2026-11-04 从 400 提到 2000：
    // 400 字不够 eval 断言用（长回答的后半截看不到，判断「结尾有没有 X」必然错）。
    // 超了明确标记，别让读的人以为那就是全文。
    const MAX_OUT_TEXT = 2000;
    const cut = s.length > MAX_OUT_TEXT;
    const body = s.slice(0, MAX_OUT_TEXT).replace(/\r?\n/g, '\\n') +
      (cut ? ' …[截断，原文 ' + s.length + ' 字]' : '');
    // chat 记完整值（原来是 slice(0,12)，2026-11-05 改）。
    // 为什么：12 位只够「日志里区分不同群」，不够 `cli bind --chat-id` —— 那要 32 位完整值。
    // 结果是「想从日志抓 chatId 去绑定」这条路被自己堵死，只能靠别的手段反查。
    // 安全性不降：这个文件在 %ProgramData%\anc\data\，本来就不进 git，
    // 而且同一行里已经有完整回复文本（比 chatId 敏感得多）。切片 0,64 只是防异常长度。
    const line = new Date().toISOString() + ' chat=' + String(chatId || '').slice(0, 64) +
      ' len=' + s.length + ' text=' + body + '\n';
    fs.appendFileSync(OUT_LOG, line, 'utf8');
  } catch (e) {}
};
// 启动器每次启动会写 patch-run.json（runId + startedAt）。把 runId 带进 state，
// 让 wait-patch-state.ps1 能区分「本次启动写的」和「上一次残留的 applied=true」。
// 旧启动器没有这个文件时不写 runId，等待脚本仍用时间窗兜底（兼容）。
const RUN_FILE = path.join(path.dirname(STATE), 'patch-run.json');
function currentRunId() {
  try { return JSON.parse(fs.readFileSync(RUN_FILE, 'utf8').replace(/^\uFEFF/, '')).runId || null; }
  catch (_) { return null; }
}
function writeState(extra) {
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    const base = { pid: process.pid, version: mf.workbuddyVersion, at: new Date().toISOString() };
    const runId = currentRunId();
    if (runId) base.runId = runId;
    fs.writeFileSync(STATE, JSON.stringify(Object.assign(base, extra || {})));
  } catch (_) { /* ignore */ }
}
function log(line) {
  try {
    fs.appendFileSync(LOG, new Date().toISOString() + ' [pid ' + process.pid + '] ' + line + '\r\n');
  } catch (_) { /* ignore */ }
}

// 出站观测（O1）：只记数字，不记内容。
// 原文可能带业务正文，落盘等于把它搬到另一个地方——这违反 D19 的意图。
// 存在的意义：回答"出站过滤到底有没有被调用过、有没有东西被丢"。
const STAT_LOG = __ancPath.join(__ancPath.dirname(STATE), 'narration-filter.log');global.__ancStat = function (kind, inLines, outLines, dropped) {
  try {
    fs.appendFileSync(STAT_LOG, JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      kind: String(kind || ''),
      in: Number(inLines) || 0,
      out: Number(outLines) || 0,
      dropped: Number(dropped) || 0,
    }) + '\r\n');
  } catch (_) { /* ignore */ }
};

// ── 测试入口（默认关闭）────────────────────────────────────────────
// 为什么需要它：验证 persona / 技能 / 出站行为，都得"让 bot 收到一条消息"。
// 真人手动 @ 一次要人等，而且每轮实验都要重来。
// 这里开一个只认 127.0.0.1 的本地口，POST 一条消息就直接送进 emitMessage——
// 不碰 UI、不抢焦点、不用 inspector，等于"模拟有人 @ 了 bot"。
//
// 开关：%ProgramData%\anc\data\test-emit.flag 存在才开。默认不存在 = 不开口。
// 前提：__ancLastClient 要有值，也就是 bot 至少收到过一条真实消息（拿实例引用）。
const TEST_FLAG = __ancPath.join(__ancPath.dirname(STATE), 'test-emit.flag');
// #9 审计修复：/emit 默认只有 loopback + flag 两道门，本机任意进程都能伪造群消息。
// 同目录放 emit-token.txt 即启用 X-Anc-Token 校验；不放则维持旧行为（向后兼容）。
const EMIT_TOKEN_FILE = __ancPath.join(__ancPath.dirname(STATE), 'emit-token.txt');
// 端口可用 ANC_EMIT_PORT 覆盖：隔离验证时避开在跑部署占用的 17999，
// 否则复现请求会打到真实 bot 并真的登记任务（2026-11-05 实测踩到）。
const EMIT_PORT = (function () {
  const n = parseInt(String(process.env.ANC_EMIT_PORT || ''), 10);
  return n > 0 && n < 65536 ? n : 17999;
})();
// 排队状态（VERIFY §40 / §85.3）：80ms 内注两条，emitMessage 都接受，
// 但只有第一条被处理，后一条延迟 7–9 分钟。accepted 只代表「已投递」。
const EMIT_QUEUE_WINDOW_MS = 60000;
const __ancEmitState = {
  accepted: 0, observed: 0, seq: 0,
  lastAcceptedAt: 0, lastObservedAt: 0,
  queueWindowMs: EMIT_QUEUE_WINDOW_MS,
};
global.__ancEmitState = __ancEmitState;

// probe 是测试模式（只读导出纯函数），不开测试用网络口。
if (fs.existsSync(TEST_FLAG) && process.env.ANC_WB_PURE_PROBE !== '1') {
  try {
    const __http = require('http');
    const __srv = __http.createServer((req, res) => {
      const reply = (code, obj) => {
        try { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); } catch (_) {}
      };
      if (req.method === 'GET' && (req.url === '/emit/status' || req.url === '/status')) {
        return reply(200, {
          ok: true,
          accepted: __ancEmitState.accepted,
          observed: __ancEmitState.observed,
          lastAcceptedAt: __ancEmitState.lastAcceptedAt,
          lastObservedAt: __ancEmitState.lastObservedAt,
          note: 'accepted=已投递到 emitMessage；observed=经过补丁包装的入站消息数（含真实群消息）。两者都不是「处理完成」的证据。'
        });
      }
      if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });
      const __emitToken = (() => {
        try { return fs.readFileSync(EMIT_TOKEN_FILE, 'utf8').trim(); } catch (_) { return ''; }
      })();
      if (__emitToken) {
        const __a = Buffer.from(String(req.headers['x-anc-token'] || ''));
        const __b = Buffer.from(__emitToken);
        if (__a.length !== __b.length || !crypto.timingSafeEqual(__a, __b)) {
          return reply(401, { ok: false, error: 'X-Anc-Token 不匹配（emit-token.txt 已启用鉴权）' });
        }
      }
      // 显式按 UTF-8 解码并当场拒掉坏字节。PS 5.1 的 Invoke-RestMethod 传字符串
      // body 时可能按 GBK 编码，Node 解出来是替换字符；以前会静默注入，
      // patch-in.log 留一行读不懂的乱码（VERIFY §25 / §85.2）。
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 1048576) { req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          if (body.indexOf('\uFFFD') !== -1) {
            log('test-emit REJECT bad-utf8 prefix=' + body.slice(0, 120));
            return reply(400, { ok: false, error: '请求体不是有效 UTF-8（含替换字符）；发送端要显式发 UTF-8 字节，PS 5.1 用 -Body ([Text.Encoding]::UTF8.GetBytes($json))' });
          }
          const p = JSON.parse(body || '{}');
          if (!p.chatId) return reply(400, { ok: false, error: '缺少 chatId' });
          if (!p.content) return reply(400, { ok: false, error: '缺少 content' });
          // 另一种坏法：发送端把 UTF-8 字节按 GBK 读成字符串后再发（§85.2 的
          // 「鐧昏浠讳换鍔…」）。这类产物几乎全是 U+9000 以上的高位 CJK，
          // 正常中文常用字在 U+4E00–U+8FFF；连续 3 个以上即可判为 mojibake。
          const highCjk = (String(p.content).match(/[\u9000-\u9FFF]/g) || []).length;
          if (highCjk >= 3) {
            log('test-emit REJECT mojibake prefix=' + String(p.content).slice(0, 120));
            return reply(400, { ok: false, error: 'content 疑似 GBK mojibake（UTF-8 曾被按 GBK 解码）；源文本用 Get-Content -Encoding UTF8 读，并用 UTF-8 字节发送' });
          }
          if (!global.__ancLastClient) return reply(409, { ok: false, error: '还没有实例引用：先让 bot 收到一条真实消息' });
          // 模仿真实入站消息的形状：chatId / user / content 是必需的，
          // 但 dispatchId 还要 msgId 才不是 undefined——所以把调用方给的字段全部透传。
          const msg = Object.assign({}, p, {
            chatId: String(p.chatId),
            user: String(p.user || ''),
            content: String(p.content),
          });
          const now = Date.now();
          const gapMs = __ancEmitState.lastAcceptedAt ? now - __ancEmitState.lastAcceptedAt : Infinity;
          const seq = ++__ancEmitState.seq;
          const queued = gapMs < EMIT_QUEUE_WINDOW_MS;
          // GAP-079 机械验证入口：payload 可带 `quoteText`（和可选 `msgId`），模拟
          // 「用户引用一条带 A12 的通知，只回一句 可以」——真实引用要人在群里操作，这里只证明
          // 「引用文本能进前缀」。message id 没给时造一个安全值，避免 quote 因无 id 匹配不上。
          const hasQuote = typeof p.quoteText === 'string' && p.quoteText.length > 0;
          if (hasQuote) {
            try {
              if (msg.msgId == null || msg.msgId === '') msg.msgId = 'emit-' + seq + '-' + now;
              global.__ancLastClient.__ancQuoteRec = {
                at: now,
                id: String(msg.msgId),
                quote: p.quoteText,
              };
            } catch (_) { /* 模拟失败就按普通消息注入 */ }
          }
          global.__ancLastClient.emitMessage(msg);
          __ancEmitState.accepted += 1;
          __ancEmitState.lastAcceptedAt = now;
          log('test-emit seq=' + seq + ' queued=' + queued + ' chat=' + msg.chatId.slice(0, 12) + ' user=' + msg.user.slice(0, 8) + ' len=' + msg.content.length + (hasQuote ? ' quote=1' : ''));
          reply(200, {
            ok: true,
            accepted: true,
            seq: seq,
            queued: queued,
            gapMs: Number.isFinite(gapMs) ? gapMs : null,
            chatId: msg.chatId,
            msgId: msg.msgId == null ? null : String(msg.msgId),
            quote: hasQuote,
            len: msg.content.length,
            note: queued
              ? '已排队：距上一条注入仅 ' + gapMs + ' ms。bot 内部串行处理，后一条可能延迟数分钟（VERIFY §40/§85.3）；本次只代表已投递，不代表已处理。一次只注一条，等回复后再注。'
              : '已投递到 emitMessage；是否处理完要看回复，不能用这个返回值判定成功。'
          });
        } catch (e) {
          reply(500, { ok: false, error: e && e.message ? e.message : String(e) });
        }
      });
    });
    __srv.on('error', (e) => log('test-emit listen failed: ' + (e && e.message)));
    __srv.listen(EMIT_PORT, '127.0.0.1', () => log('test-emit listening on 127.0.0.1:' + EMIT_PORT));
  } catch (e) {
    log('test-emit disabled: ' + (e && e.message));
  }
}

const toggle = String(process.env[mf.toggleEnv || 'ANC_WB_PATCH'] || '1').toLowerCase();
if (toggle === '0' || toggle === 'off' || toggle === 'false') {
  log('disabled by ' + (mf.toggleEnv || 'ANC_WB_PATCH'));
  module.exports = {};
  return;
}

const TARGET = String(mf.target || '').replace(/\\/g, '/');
const EXPECTED = mf.sha256;
const PREFIX = mf.prefix || '[anc:chat=';

const BOOT_TARGET = String(mf.bootstrapTarget || '').replace(/\\/g, '/');
const BOOT_REPL = Array.isArray(mf.bootstrapReplacements) ? mf.bootstrapReplacements : [];
const OPS_WEBHOOK = expand(mf.opsWebhookFile || '');
const CANARY = expand(mf.canary || '%ProgramData%\\anc\\data\\patch-canary.json');
// 在目标模块里 require('fs') 不可靠；由 preload 提供写入函数，补丁体只调用
global.__ancCanaryWrite = function (obj) {
  try {
    fs.mkdirSync(path.dirname(CANARY), { recursive: true });
    fs.writeFileSync(CANARY, JSON.stringify(obj));
  } catch (_) { /* ignore */ }
};
// 记录安装路径：计划任务以 LOCAL SERVICE 运行，看不到用户目录，靠这个文件定位
// NODE_OPTIONS 会被 node 子进程继承（agent 跑的 node cli.ts 等），只有 WorkBuddy.exe 自己才写
try {
  if (path.basename(process.execPath).toLowerCase() === 'workbuddy.exe') {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(STATE), 'workbuddy-path.txt'), process.execPath);
  }
} catch (_) { /* ignore */ }

function alertOps(text) {
  if (!OPS_WEBHOOK) return;
  try {
    const url = fs.readFileSync(OPS_WEBHOOK, 'utf8').trim();
    if (!url) return;
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ msgtype: 'text', text: { content: '[anc] ' + text } }),
      signal: AbortSignal.timeout(10_000),
    }).catch(function () {});
    log('ALERT sent: ' + text);
  } catch (e) {
    log('ALERT failed: ' + (e && e.message));
  }
}

// 补丁体真正包装上 emitMessage 之后才算生效：由补丁体回调，而不是拼接时就记「已生效」
let pendingMode = null;
global.__ancMarkApplied = function () {
  writeState({ mode: pendingMode || 'unknown', applied: true });
  log('APPLIED mode=' + (pendingMode || 'unknown'));
};
global.__ancMarkMiss = function () {
  writeState({ mode: pendingMode || 'unknown', applied: false, miss: true });
  log('ANCHOR-MISS emitMessage class not found mode=' + (pendingMode || 'unknown'));
  alertOps('补丁已注入但没找到 emitMessage（导出名可能变了），群身份未生效，需人工按 anc-wb-patch 处理');
};

// 用户正文里的 [anc: 一律中和，防止自己写前缀冒充群或发送人；真前缀每次都由补丁加
// T21 实测：多步工具链会把过程话发进群（单工具 0 段，入库 7/15/6 段），
// persona 禁止词表无效。只能在出站侧过滤：按行丢掉"正在做什么"的自述。
// 这份正则是唯一真相，PATCH_BODY 里拼它的 source，不另写一份。
// 只收"明确在描述动作"的短语。裸的"我来"/"现在写"会误杀正常句子
// （实测「我来说明一下这个流程」被吃掉），必须带动作限定。
const NARRATION_RE = /^(?:在入库，稍等|稍等[。.．]?$|我先[^，。！？]{0,10}(?:看|查|找|确认|列|验)|让我[^，。！？]{0,8}(?:看|查|找)|我来[^，。！？]{0,8}(?:看|查|找|确认|列|验)|我找一下|我查一下|我看一下|看了一下|查一下|格式清楚了|批次就绪|已就绪|现在写(?:整理|文档|meta)|执行入库|文件就绪|原件已就位|已加载|服务正常|工具名|重新列出|回退到|已就位|入库执行)/;

// 把上面三个纯函数原样嵌进 PATCH_BODY：包一层 IIFE 只暴露 __ancPure，避免和压缩后的
// 厂商模块作用域变量重名；用 toString() 保证「测试验证的那份」就是「补丁里跑的那份」。
const PATCH_PURE_SRC = ';var __ancPure = (function () {\n' +
  ancOneLine.toString() + '\n' +
  ancSafeMsgId.toString() + '\n' +
  ancSafeToken.toString() + '\n' +
  ancQuoteTextFromBody.toString() + '\n' +
  '  return { oneLine: ancOneLine, safeMsgId: ancSafeMsgId, safeToken: ancSafeToken, quoteTextFromBody: ancQuoteTextFromBody };\n' +
  '})();';

const PATCH_BODY = [
  ';var __ancIdentityPatch = true;',
  PATCH_PURE_SRC,
  ';function __ancFilterNarration(text) {',
  '  if (typeof text !== "string") return text;',
  '  var lines = text.split(/\\r?\\n/);',
  '  // 单行不动：正常的一句话回复不该被误杀',
  '  if (lines.length < 2) return text;',
  '  var re = /' + NARRATION_RE.source + '/;',
  '  var kept = [];',
  '  for (var i = 0; i < lines.length; i++) { if (!re.test(lines[i].trim())) kept.push(lines[i]); }',
  '  // 全被过滤掉时至少留最后一句：否则用户会以为 bot 没反应',
  '  if (kept.length === 0) return lines[lines.length - 1];',
  '  return kept.join("\\n");',
  '}',
  ';try {',
  '  var __ancCls = (module.exports && (module.exports.t || module.exports.WecomAiBotClient)) || null;',
  '  if (__ancCls && __ancCls.prototype && typeof __ancCls.prototype.emitMessage === "function" && !__ancCls.prototype.__ancPatched) {',
  '    var __ancOrig = __ancCls.prototype.emitMessage;',
  '    __ancCls.prototype.emitMessage = function (m) {',
  '      try { global.__ancLastClient = this; } catch (e) {}',
  '      try {',
  '        if (m && typeof m.content === "string" && !m.__ancTagged) {',
  '          m.content = m.content.replace(/\\[\\s*anc\\s*[:\\uFF1A]/gi, "[anc-quoted:");',
  '          if (m.chatId) {',
  '            try {',
  '              // GAP-079：msgId 与引用文本只追加、不删旧字段（chat/from 仍是主路径）。',
  '              // 两个字段都可缺省；拿不到安全值就不加，绝不让装饰失败影响原有入站。',
  '              var __ancMid = __ancPure.safeMsgId(m.msgId);',
  '              var __ancQ = "";',
  '              var __ancQType = "";',
  '              var __ancQKeys = "";',
  '              try {',
  '                var __ancRec = this.__ancQuoteRec;',
  '                if (__ancRec && __ancRec.id && m.msgId != null && String(m.msgId) === String(__ancRec.id)) {',
  '                  __ancQ = __ancPure.oneLine(__ancRec.quote, 300);',
  '                  __ancQType = __ancPure.safeToken(__ancRec.qtype, 32);',
  '                  if (!__ancQ) __ancQKeys = __ancPure.safeToken(__ancRec.qkeys, 120);',
  '                }',
  '              } catch (e) {}',
  '              var __ancExtra = "";',
  '              if (__ancMid) __ancExtra += " msg=" + __ancMid;',
  '              if (__ancQ) __ancExtra += " quote=" + __ancQ;',
  '              if (global.__ancLogIn) { try { global.__ancLogIn(m.chatId, m.user, m.content, { msgId: __ancMid, quote: __ancQ, quoteType: __ancQType, quoteKeys: __ancQKeys }); } catch (e) {} }',
  '              m.content = "' + PREFIX + '" + m.chatId + " from=" + (m.user || "") + __ancExtra + "] " + m.content;',
  '            } catch (e) {}',
  '          }',
  '          try { Object.defineProperty(m, "__ancTagged", { value: true, enumerable: false }); } catch (e) {}',
  '        }',
  '        try { if (global.__ancCanaryWrite) global.__ancCanaryWrite({ at: new Date().toISOString(), chatId: !!(m && m.chatId), user: !!(m && m.user), contentStr: !!(m && typeof m.content === "string") }); } catch (e) {}',
  '      } catch (e) {}',
  '      return __ancOrig.call(this, m);',
  '    };',
  '    __ancCls.prototype.__ancPatched = true;',
  '    // 抓实例：emitMessage 只在"收到消息"时被调用，重启后要等一条真人消息才拿得到引用。',
  '    // connect / onMessage / sendStreamChunk 这几个名字覆盖不全（实测重启后仍拿不到），',
  '    // 所以直接包装原型上所有方法：bot 只要调用任何一个，实例就落进 __ancLastClient。',
  '    try {',
  '      var __ancFns = Object.getOwnPropertyNames(__ancCls.prototype).filter(function (n) { return n !== "constructor" && n.indexOf("__anc") !== 0 && typeof __ancCls.prototype[n] === "function"; });',
  '      try { if (global.__ancHookList) global.__ancHookList(__ancFns); } catch (e) {}',
  '      Object.getOwnPropertyNames(__ancCls.prototype).forEach(function (__m) {',
  '        if (__m === "constructor" || __m.indexOf("__anc") === 0) return;',
  '        var __d = Object.getOwnPropertyDescriptor(__ancCls.prototype, __m);',
  '        if (!__d || typeof __d.value !== "function" || !__d.configurable) return;',
  '        var __origM = __d.value;',
  '        __d.value = function () {',
  '          try { global.__ancLastClient = this; } catch (e) {}',
  '          try { if (global.__ancHookHit) global.__ancHookHit(__m); } catch (e) {}',
  '          return __origM.apply(this, arguments);',
  '        };',
  '        try { Object.defineProperty(__ancCls.prototype, __m, __d); } catch (e) {}',
  '      });',
  '    } catch (e) {}',
  '    // 引用文本捕获（GAP-079 / DEV-02）：emitMessage 的 m 里没有 quote，原始帧在 e.body.quote。',
  '    // 客户端 resolveQuoteMedia 只处理 image/file/video——引用一条文本通知（带 A12）时它返回空，',
  '    // quote 根本不进 emitMessage，所以在原型层先抓：按 msg_id 记到实例上，emitMessage 再按 id 取。',
  '    // 放在通用包装之后，包住的是「抓实例」那层，不影响原有方法链；任何异常一律吞掉。',
  '    try {',
  '      var __ancCaptureQuote = function (__ancName) {',
  '        try {',
  '          var __ancH = __ancCls.prototype[__ancName];',
  '          if (typeof __ancH !== "function" || __ancH.__ancQuoteWrapped) return;',
  '          var __ancWrapped = function (e) {',
  '            try {',
  '              var __ancBody = e && e.body;',
  '              if (__ancBody) {',
  '                var __ancBid = __ancBody.msg_id || __ancBody.msgid || "";',
  '                var __ancQObj = __ancBody.quote;',
  '                var __ancQType = "";',
  '                var __ancQKeys = "";',
  '                var __ancQText = __ancPure.quoteTextFromBody(__ancBody);',
  '                try {',
  '                  if (__ancQObj && typeof __ancQObj === "object") {',
  '                    __ancQType = __ancPure.safeToken(__ancQObj.msgtype || __ancQObj.type || "", 32);',
  '                    // 文本取不到时留键名：真实群引用形状未实测，部署后靠 patch-in.log 的 quote-keys 定位。',
  '                    if (!__ancQText) __ancQKeys = __ancPure.safeToken(Object.keys(__ancQObj).slice(0, 12).join(","), 120);',
  '                  }',
  '                } catch (e3) {}',
  '                this.__ancQuoteRec = { at: Date.now(), id: __ancBid ? String(__ancBid) : "", quote: __ancQText, qtype: __ancQType, qkeys: __ancQKeys };',
  '              }',
  '            } catch (e1) {}',
  '            return __ancH.apply(this, arguments);',
  '          };',
  '          __ancWrapped.__ancQuoteWrapped = true;',
  '          __ancCls.prototype[__ancName] = __ancWrapped;',
  '        } catch (e2) {}',
  '      };',
  '      __ancCaptureQuote("handleTextMessage");',
  '      __ancCaptureQuote("handleMixedMessage");',
  '      __ancCaptureQuote("handleMediaMessage");',
  '    } catch (e) {}',
  '    // 出站过滤：单点在这里，因为最终回复走 sendReply（内部按字节分块逐条 sendMessage）。',
  '    // sendStreamChunk 不动——流式块可能只有几个字，判断不了整句，硬过滤会误杀。',
  '    if (typeof __ancCls.prototype.sendReply === "function" && !__ancCls.prototype.__ancReplyPatched) {',
  '      var __ancOrigReply = __ancCls.prototype.sendReply;',
  '      __ancCls.prototype.sendReply = function (chatId, text) {',
  '        var filtered = text;',
  '        try { filtered = __ancFilterNarration(text); } catch (e) { filtered = text; }',
  '        try { if (global.__ancStat) { var __li = String(text == null ? "" : text).split(/\\r?\\n/).length; var __lo = String(filtered == null ? "" : filtered).split(/\\r?\\n/).length; global.__ancStat("reply", __li, __lo, __li - __lo); } } catch (e) {}',
  '        try { if (typeof filtered === "string" && filtered.trim() === "") { global.__ancNarrationSkipped = (global.__ancNarrationSkipped || 0) + 1; return Promise.resolve(true); } } catch (e) {}',
  '        try { if (global.__ancLogOut) global.__ancLogOut(chatId, filtered); } catch (e) {}',
  '        return __ancOrigReply.call(this, chatId, filtered);',
  '      };',
  '      __ancCls.prototype.__ancReplyPatched = true;',
  '      try { process.__ancReplyFilterApplied = true; } catch (e) {}',
  '    }',
  '    try { process.__ancIdentityApplied = true; } catch (e) {}',
  '    try { if (global.__ancMarkApplied) global.__ancMarkApplied(); } catch (e) {}',
  '  } else if (!(__ancCls && __ancCls.prototype && __ancCls.prototype.__ancPatched)) {',
  '    try { if (global.__ancMarkMiss) global.__ancMarkMiss(); } catch (e) {}',
  '  }',
  '} catch (e) { try { if (global.__ancMarkMiss) global.__ancMarkMiss(); } catch (e2) {} }',
  ''
].join('\n');

// 测试入口（只读、无副作用）：`ANC_WB_PURE_PROBE=1` 时提前返回，供 narration.test.mjs 校验
// 纯函数与 PATCH_BODY（用伪造的 WecomAiBotClient 跑一遍注入）。默认不开启，不影响真实补丁路径。
if (process.env.ANC_WB_PURE_PROBE === '1') {
  // 只读测试：摘掉会写生产状态/日志的钩子。不摘的话，测试里伪造客户端跑 PATCH_BODY 会
  // 把 patch-state.json / patch-canary.json / patch-hooks.log 写成测试进程的东西（2026-11-10 踩过）。
  // __ancLogIn 保留：格式验证要它；测试自己接管（覆盖成内存数组或重定向到临时文件）。
  try {
    delete global.__ancMarkApplied;
    delete global.__ancMarkMiss;
    delete global.__ancCanaryWrite;
    delete global.__ancHookList;
    delete global.__ancHookHit;
  } catch (e) { /* ignore */ }
  module.exports = {
    ancOneLine: ancOneLine,
    ancSafeMsgId: ancSafeMsgId,
    ancSafeToken: ancSafeToken,
    ancQuoteTextFromBody: ancQuoteTextFromBody,
    patchBody: PATCH_BODY,
    prefix: PREFIX,
  };
  return;
}

const Module = require('module');
const origCompile = Module.prototype._compile;
let applied = 0;

// 拦掉自动升级检查（main-bootstrap 由 Electron 自己的加载器执行，钩不到 _compile；
// 改从网络层拦 /v2/update）。可用 ANC_WB_BLOCK_UPDATE=0 关闭。
try {
  if (String(process.env.ANC_WB_BLOCK_UPDATE || '1').toLowerCase() !== '0') {
    const https = require('https');
    const EE = require('events');
    const patchFn = (orig) => function (...args) {
      let target = '';
      try {
        const a0 = args[0];
        target = typeof a0 === 'string' ? a0 : (a0 && (a0.href || a0.path)) || '';
      } catch (_) { /* ignore */ }
      if (String(target).includes('/v2/update')) {
        log('update-blocked url=' + String(target).split('?')[0]);
        const req = new EE.EventEmitter();
        req.setTimeout = () => req;
        req.write = () => true;
        req.end = () => {};
        req.abort = () => {};
        req.destroy = () => {};
        process.nextTick(() => req.emit('error', new Error('anc: update check blocked')));
        return req;
      }
      return orig.apply(this, args);
    };
    https.request = patchFn(https.request);
    https.get = patchFn(https.get);
    log('update-hook installed');
  }
} catch (e) {
  log('update-hook error: ' + (e && e.message));
}

Module.prototype._compile = function (content, filename) {
  try {
    const norm = typeof filename === 'string' ? filename.replace(/\\/g, '/') : '';
    if (norm.indexOf('/main/') !== -1 && norm.indexOf('node_modules') === -1 && process.env.ANC_WB_DIAG === '1') {
      log('compile-seen ' + norm);
    }
    if (norm && typeof content === 'string' && norm.indexOf(TARGET) !== -1) {
      const digest = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
      const strict = String(process.env.ANC_WB_STRICT || '').toLowerCase();
      const anchorMode = String(process.env.ANC_WB_ANCHOR || '1').toLowerCase() !== '0';
      if (digest === EXPECTED) {
        if (content.indexOf('__ancIdentityPatch') === -1) {
          content += '\n' + PATCH_BODY;
          applied += 1;
          pendingMode = 'hash';
          log('INJECTED mode=hash target=' + filename);
        }
      } else if (strict === '1' || strict === 'true') {
        log('STRICT-SKIP hash-mismatch target=' + filename + ' got=' + digest + ' expected=' + EXPECTED);
        alertOps('补丁未生效（严格模式）：wecomaibot-client.js 与登记版本不符，请按 docs/WORKBUDDY-PATCH.md 重放');
      } else if (anchorMode) {
        if (content.indexOf('__ancIdentityPatch') === -1) {
          content += '\n' + PATCH_BODY;
          applied += 1;
          pendingMode = 'anchor';
          log('INJECTED mode=anchor version-unverified target=' + filename + ' got=' + digest);
          alertOps('WorkBuddy 版本变化，已按结构锚点打补丁（未登记版本）；请在测试群回归后更新 manifest');
        }
      } else {
        log('SKIP hash-mismatch target=' + filename + ' got=' + digest + ' expected=' + EXPECTED);
        alertOps('补丁未生效：wecomaibot-client.js 与登记版本不符（可能是 WorkBuddy 升级），请按 docs/WORKBUDDY-PATCH.md 重放');
      }
    }
    if (norm && BOOT_TARGET && BOOT_REPL.length && norm.indexOf(BOOT_TARGET) !== -1 && typeof content === 'string') {
      const updToggle = String(process.env.ANC_WB_PATCH_UPDATE || '1').toLowerCase();
      if (updToggle === '0' || updToggle === 'off' || updToggle === 'false') {
        log('update-patch disabled by env');
      } else {
        let hits = 0;
        for (const pair of BOOT_REPL) {
          const from = String(pair[0] || '');
          const to = String(pair[1] || '');
          if (from && content.indexOf(from) !== -1) {
            content = content.split(from).join(to);
            hits += 1;
          }
        }
        if (hits) log('update-patch applied n=' + hits);
        else {
          log('update-patch SKIP no-match');
          alertOps('自动升级补丁未命中：main-bootstrap.js 与登记版本不符，升级检查可能仍会运行');
        }
      }
    }
  } catch (e) {
    log('patch error: ' + (e && e.message));
  }
  return origCompile.call(this, content, filename);
};

log('preload active version=' + mf.workbuddyVersion);
process.on('exit', function () {
  if (applied) log('exit patched=' + applied + ' identityApplied=' + (!!process.__ancIdentityApplied));
});

module.exports = { applied: function () { return applied; } };
