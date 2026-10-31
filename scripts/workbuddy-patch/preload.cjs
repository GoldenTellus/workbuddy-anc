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
  mf = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
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
  '      } catch (e) {}',
  '      return __ancOrig.call(this, m);',
  '    };',
  '    __ancCls.prototype.__ancPatched = true;',
  '  }',
  '} catch (e) {}',
  ''
].join('\n');

const Module = require('module');
const origCompile = Module.prototype._compile;
let applied = 0;

Module.prototype._compile = function (content, filename) {
  try {
    const norm = typeof filename === 'string' ? filename.replace(/\\/g, '/') : '';
    if (norm && typeof content === 'string' && norm.indexOf(TARGET) !== -1) {
      const digest = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
      if (digest !== EXPECTED) {
        log('SKIP hash-mismatch target=' + filename + ' got=' + digest + ' expected=' + EXPECTED);
      } else if (content.indexOf('__ancIdentityPatch') === -1) {
        content += '\n' + PATCH_BODY;
        applied += 1;
        log('PATCHED target=' + filename);
      }
    }
  } catch (e) {
    log('patch error: ' + (e && e.message));
  }
  return origCompile.call(this, content, filename);
};

log('preload active version=' + mf.workbuddyVersion);
process.on('exit', function () {
  if (applied) log('exit patched=' + applied);
});

module.exports = { applied: function () { return applied; } };
