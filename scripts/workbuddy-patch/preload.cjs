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
const STATE = expand(mf.state || '%ProgramData%\\anc\\data\\patch-state.json');
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

const PATCH_BODY = [
  ';var __ancIdentityPatch = true;',
  ';try {',
  '  var __ancCls = (module.exports && (module.exports.t || module.exports.WecomAiBotClient)) || null;',
  '  if (__ancCls && __ancCls.prototype && typeof __ancCls.prototype.emitMessage === "function" && !__ancCls.prototype.__ancPatched) {',
  '    var __ancOrig = __ancCls.prototype.emitMessage;',
  '    __ancCls.prototype.emitMessage = function (m) {',
  '      try {',
  '        if (m && m.chatId && typeof m.content === "string" && m.content.indexOf("' + PREFIX + '") !== 0) {',
  '          m.content = "' + PREFIX + '" + m.chatId + " from=" + (m.user || "") + "] " + m.content;',
  '        }',
  '        try { if (global.__ancCanaryWrite) global.__ancCanaryWrite({ at: new Date().toISOString(), chatId: !!(m && m.chatId), user: !!(m && m.user), contentStr: !!(m && typeof m.content === "string") }); } catch (e) {}',
  '      } catch (e) {}',
  '      return __ancOrig.call(this, m);',
  '    };',
  '    __ancCls.prototype.__ancPatched = true;',
  '    try { process.__ancIdentityApplied = true; } catch (e) {}',
  '  }',
  '} catch (e) {}',
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
          writeState({ mode: 'hash' });
          log('PATCHED target=' + filename);
        }
      } else if (strict === '1' || strict === 'true') {
        log('STRICT-SKIP hash-mismatch target=' + filename + ' got=' + digest + ' expected=' + EXPECTED);
        alertOps('补丁未生效（严格模式）：wecomaibot-client.js 与登记版本不符，请按 docs/WORKBUDDY-PATCH.md 重放');
      } else if (anchorMode) {
        if (content.indexOf('__ancIdentityPatch') === -1) {
          content += '\n' + PATCH_BODY;
          applied += 1;
          writeState({ mode: 'anchor' });
          log('ANCHOR-PATCH version-unverified target=' + filename + ' got=' + digest);
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
