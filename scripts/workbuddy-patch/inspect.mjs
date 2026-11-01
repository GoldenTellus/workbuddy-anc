#!/usr/bin/env node
// 升级侦察：不加载 WorkBuddy，直接读 asar，报告版本、目标 hash、锚点是否还在。
// 用法：node scripts/workbuddy-patch/inspect.mjs [安装目录]
// 输出 JSON：{ version, target, sha256, size, anchors:{emitMessage, class, bootstrapStart, bootstrapEarly}, manifest:{...} }

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, 'manifest.json');
const installDir = process.argv[2] || process.env.LOCALAPPDATA + '\\Programs\\WorkBuddy';
const asar = join(installDir, 'resources', 'app.asar');
const exe = join(installDir, 'WorkBuddy.exe');

if (!existsSync(asar)) {
  console.log(JSON.stringify({ ok: false, error: '找不到 app.asar: ' + asar }));
  process.exit(2);
}

const mf = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
const buf = readFileSync(asar);
const headerSize = buf.readUInt32LE(4);
const jsonLen = buf.readUInt32LE(12);
const base = 8 + headerSize;
const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'));

const files = new Map();
(function walk(node, prefix) {
  for (const [name, v] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (v.files) walk(v, p);
    else files.set(p, v);
  }
})(header, '');

function readMember(path) {
  const m = files.get(path);
  if (!m) return null;
  return buf.subarray(base + Number(m.offset), base + Number(m.offset) + Number(m.size));
}

const targetBuf = readMember(mf.target);
const content = targetBuf ? targetBuf.toString('utf8') : '';
const sha = targetBuf ? createHash('sha256').update(targetBuf).digest('hex') : null;

const boot = readMember(mf.bootstrapTarget || '');
const bootText = boot ? boot.toString('utf8') : '';

const anchors = {
  emitMessage: (content.match(/emitMessage/g) || []).length,
  class: (content.match(/WecomAiBotClient/g) || []).length,
  // 每条替换单独计：[0] 启动时强制自动升级，[1] 早期强制升级检查
  bootstrapStart: mf.bootstrapReplacements && mf.bootstrapReplacements[0] ? Number(bootText.includes(mf.bootstrapReplacements[0][0])) : 0,
  bootstrapEarly: mf.bootstrapReplacements && mf.bootstrapReplacements[1] ? Number(bootText.includes(mf.bootstrapReplacements[1][0])) : 0,
  bootstrapTotal: mf.bootstrapReplacements ? mf.bootstrapReplacements.length : 0,
};

const version = existsSync(exe) ? (await import('node:child_process')).execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${exe.replace(/'/g, "''")}').VersionInfo.FileVersion`], { encoding: 'utf8' }).trim() : null;

const report = {
  ok: true,
  version,
  target: mf.target,
  sha256: sha,
  size: targetBuf ? targetBuf.length : null,
  manifest: { version: mf.workbuddyVersion, sha256: mf.sha256, size: mf.size },
  hashMatches: sha === mf.sha256,
  anchors,
  anchorsOk: anchors.emitMessage > 0 && anchors.class > 0,
  // 每条登记的替换都要能命中，只命中一条说明另一个升级入口已变，升级仍可能被触发
  bootstrapOk: anchors.bootstrapTotal > 0 && anchors.bootstrapStart + anchors.bootstrapEarly === Math.min(anchors.bootstrapTotal, 2),
  advice: [],
};
if (!report.hashMatches) report.advice.push('hash 与 manifest 不符：可先按锚点模式启动；回归通过后更新 manifest 的 sha256/size/version');
if (!report.anchorsOk) report.advice.push('关键锚点缺失：emitMessage / WecomAiBotClient 可能改名，需要重找注入点并改 preload 的补丁体');
if (!report.bootstrapOk) report.advice.push('main-bootstrap 升级检查锚点不在：需要重新定位并更新 bootstrapReplacements');

console.log(JSON.stringify(report, null, 2));
