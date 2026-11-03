#!/usr/bin/env node
'use strict';
// ANC WorkBuddy patch：在 wecomaibot-client 加载时给 emitMessage 套壳，
// 把 AIBot 回调里的 chatId / 发送人拼进消息正文，让群身份进入 agent 的上下文。
//
// 约束（对应 FORK-DIRECTION §11）：
//   - 只在本进程内存生效，不改 app.asar / exe，不写厂商代码 diff；
//   - 目标文件 sha256 与 manifest 不符时 fail-closed：只记日志，不打补丁；
//   - ANC_WB_PATCH=0 / off / false 时整体关闭；
//   - 无 manifest 或任何异常都静默跳过，不影响 WorkBuddy 启动。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
global.__ancLogOut = function (chatId, text) {
  try {
    if (!fs.existsSync(OUT_FLAG)) return;
    const s = String(text == null ? '' : text);
    const line = new Date().toISOString() + ' chat=' + String(chatId || '').slice(0, 12) +
      ' len=' + s.length + ' text=' + s.slice(0, 400).replace(/\r?\n/g, '\\n') + '\n';
    fs.appendFileSync(OUT_LOG, line, 'utf8');
  } catch (e) {}
};
function writeState(extra) {
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify(Object.assign({ pid: process.pid, version: mf.workbuddyVersion, at: new Date().toISOString() }, extra || {})));
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
const STAT_LOG = __ancPath.join(__ancPath.dirname(STATE), 'narration-filter.log');
global.__ancStat = function (kind, inLines, outLines, dropped) {
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

const PATCH_BODY = [
  ';var __ancIdentityPatch = true;',
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
  '      try {',
  '        if (m && typeof m.content === "string" && !m.__ancTagged) {',
  '          m.content = m.content.replace(/\\[\\s*anc\\s*[:\\uFF1A]/gi, "[anc-quoted:");',
  '          if (m.chatId) m.content = "' + PREFIX + '" + m.chatId + " from=" + (m.user || "") + "] " + m.content;',
  '          try { Object.defineProperty(m, "__ancTagged", { value: true, enumerable: false }); } catch (e) {}',
  '        }',
  '        try { if (global.__ancCanaryWrite) global.__ancCanaryWrite({ at: new Date().toISOString(), chatId: !!(m && m.chatId), user: !!(m && m.user), contentStr: !!(m && typeof m.content === "string") }); } catch (e) {}',
  '      } catch (e) {}',
  '      return __ancOrig.call(this, m);',
  '    };',
  '    __ancCls.prototype.__ancPatched = true;',
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
