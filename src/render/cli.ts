#!/usr/bin/env node
// 渲染器 / 接入器 CLI
//   render  --org <org目录> --out <输出目录> [--json]
//   onboard --package <接入包目录> --home <家目录> [--cards <名片目录>] [--vault-shared <路径>] [--adopt] [--json]
//   verify  --home <家目录> [--json]

import { fileURLToPath } from 'node:url';
import { renderOrg } from './index.ts';
import { installPackage, verifyInstall } from './onboard.ts';

const argv = process.argv.slice(2);
const arg = (name: string, def = ''): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const json = argv.includes('--json');
const cmd = argv[0];

function fail(msg: string, code: string, exit = 1): never {
  if (json) console.log(JSON.stringify({ ok: false, code, error: msg }));
  else { console.error('ERROR ' + msg); console.error('FIX   看 docs/RENDERER.md'); }
  process.exit(exit);
}

const DEFAULT_CARDS = fileURLToPath(new URL('../../light/skill-cards/', import.meta.url));

try {
  if (cmd === 'render') {
    const orgDir = arg('--org');
    const outDir = arg('--out');
    if (!orgDir) fail('缺少 --org', 'USAGE', 2);
    if (!outDir) fail('缺少 --out', 'USAGE', 2);
    const r = renderOrg(orgDir, outDir);
    if (json) console.log(JSON.stringify({ ok: true, input_sha256: r.inputSha, outputs: r.outputs, groups: r.members, tampered: r.tampered, warnings: r.warnings }));
    else {
      console.log('input_sha256: ' + r.inputSha);
      for (const o of r.outputs) console.log(`  ${String(o.bytes).padStart(5)} B  ${o.file}`);
      console.log(`  groups.json  ${r.members} member(s)`);
      if (r.warn) console.log('WARN 公司 bot persona 超过 6500 字节，接近上限');
      for (const w of r.warnings) console.log('WARN ' + w);
      for (const t of r.tampered) console.log('WARN 产物被手改过（指纹不一致，已重渲染并备份原文件）: ' + t);
    }
    if (r.tampered.length) process.exit(1);
  } else if (cmd === 'onboard') {
    const packageDir = arg('--package');
    const homeDir = arg('--home');
    if (!packageDir) fail('缺少 --package', 'USAGE', 2);
    if (!homeDir) fail('缺少 --home', 'USAGE', 2);
    const r = installPackage({
      packageDir,
      homeDir,
      cardsDir: arg('--cards', DEFAULT_CARDS),
      vaultShared: arg('--vault-shared') || undefined,
      adopt: argv.includes('--adopt'),
    });
    if (json) console.log(JSON.stringify({ ok: true, ...r }));
    else {
      console.log('persona: ' + r.persona);
      for (const c of r.cards) console.log('card   : ' + c);
      for (const b of r.backedUp) console.log('backup : ' + b);
      console.log('record : ' + r.record);
    }
  } else if (cmd === 'verify') {
    const homeDir = arg('--home');
    if (!homeDir) fail('缺少 --home', 'USAGE', 2);
    const v = verifyInstall(homeDir);
    if (json) console.log(JSON.stringify({ ok: v.ok, changed: v.changed }));
    else if (v.ok) console.log('verify: OK');
    else { console.log('verify: 被改过或缺失'); for (const c of v.changed) console.log('  ' + c); }
    if (!v.ok) process.exit(1);
  } else {
    fail('未知命令（render / onboard / verify）', 'USAGE', 2);
  }
} catch (e) {
  fail((e as Error).message, 'ERROR');
}
