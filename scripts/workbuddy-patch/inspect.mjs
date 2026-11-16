#!/usr/bin/env node
// 升级侦察：不加载 WorkBuddy，直接读 asar，报告版本、目标 hash、锚点是否还在。
//
// 用法：node scripts/workbuddy-patch/inspect.mjs [安装目录 | WorkBuddy.app] [--json]
// 输出：{ ok, os, version, target, sha256, size, anchors:{emitMessage,class,bootstrapStart,bootstrapEarly}, manifest }
//
// 2026-11-16：改成跨平台。原来把安装目录写死成 `%LOCALAPPDATA%\Programs\WorkBuddy` 且要求
// `resources\app.asar`，在 macOS 上直接报「找不到 app.asar」——侦察工具自己先挡住了侦察。
// 现在安装位置交给平台层探测（/Applications/WorkBuddy.app ↔ %LOCALAPPDATA%\Programs\WorkBuddy），
// asar 解析与锚点判定复用 launch-patched.mjs 的同一份实现，避免两个工具各判一套。

import { existsSync } from 'node:fs';
import { inspectAnchors, loadManifest, openAsar, readVersion, resolveTarget } from './launch-patched.mjs';

const args = process.argv.slice(2).filter((a) => a !== '--json');
const explicit = args[0];
const asJson = process.argv.includes('--json');

let target;
try {
  target = resolveTarget({ installDir: explicit });
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
  process.exit(2);
}

if (!existsSync(target.appAsar)) {
  process.stdout.write(JSON.stringify({ ok: false, error: '找不到 app.asar: ' + target.appAsar }) + '\n');
  process.exit(2);
}

const manifest = loadManifest();
const anchors = inspectAnchors(target.appAsar, manifest);
const asar = openAsar(target.appAsar);
const report = {
  ok: anchors.found,
  os: target.os,
  installDir: target.installDir,
  exec: target.exec,
  version: readVersion(target),
  target: anchors.target,
  sha256: anchors.sha256,
  size: anchors.size,
  anchors: anchors.anchors,
  manifest: {
    workbuddyVersion: manifest.workbuddyVersion,
    electron: manifest.electron,
    sha256: manifest.sha256,
    size: manifest.size,
    target: manifest.target,
    bootstrapTarget: manifest.bootstrapTarget,
  },
  asarEntries: asar.files.size,
  hashMatches: anchors.sha256 === manifest.sha256,
};

if (asJson) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  const w = (k, v) => process.stdout.write(k.padEnd(18) + v + '\n');
  w('平台', report.os);
  w('安装位置', report.installDir);
  w('主程序', report.exec);
  w('WorkBuddy', (report.version || '未读到') + '（manifest 登记 ' + report.manifest.workbuddyVersion + '）');
  w('目标文件', report.target + (report.ok ? '' : '（不存在）'));
  w('hash', report.sha256 ? report.sha256.slice(0, 16) + '… ' + (report.hashMatches ? '与 manifest 一致' : '与 manifest 不同（升级后需重测）') : '—');
  w('大小', report.size + ' B（manifest ' + report.manifest.size + '）');
  w('锚点', Object.entries(report.anchors).map(([k, v]) => k + '=' + (v ? '✓' : '✗')).join('  '));
  if (!report.hashMatches && report.ok) process.stdout.write('\n注意：hash 与登记版本不同 → 打补丁前先回归；bootstrap 锚点若缺失，升级拦截补丁打不上。\n');
}

process.exit(report.ok ? 0 : 1);
