#!/usr/bin/env node
// 渲染器 CLI：org 数据 → 公司 bot persona、每人接入包、groups.json
// 用法：node src/render/cli.ts render --org <org目录> --out <输出目录> [--json]

import { renderOrg } from './index.ts';

const argv = process.argv.slice(2);
const arg = (name: string, def = ''): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const json = argv.includes('--json');
const cmd = argv[0];
const orgDir = arg('--org');
const outDir = arg('--out');

function fail(msg: string, code: string, exit = 1): never {
  if (json) console.log(JSON.stringify({ ok: false, code, error: msg }));
  else { console.error('ERROR ' + msg); console.error('FIX   看 docs/RENDERER.md'); }
  process.exit(exit);
}

if (cmd !== 'render') fail('未知命令（只支持 render）', 'USAGE', 2);
if (!orgDir) fail('缺少 --org', 'USAGE', 2);
if (!outDir) fail('缺少 --out', 'USAGE', 2);

try {
  const r = renderOrg(orgDir, outDir);
  if (json) console.log(JSON.stringify({ ok: true, input_sha256: r.inputSha, outputs: r.outputs, groups: r.members }));
  else {
    console.log('input_sha256: ' + r.inputSha);
    for (const o of r.outputs) console.log(`  ${String(o.bytes).padStart(5)} B  ${o.file}`);
    console.log(`  groups.json  ${r.members} member(s)`);
    if (r.warn) console.log('WARN 公司 bot persona 超过 6500 字节，接近上限');
  }
} catch (e) {
  fail((e as Error).message, 'RENDER_ERROR');
}
