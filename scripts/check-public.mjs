#!/usr/bin/env node
// 转公开检查（repo 转 public 前必跑）：零输出且 exit 0 = 通过。
//
// 唯一实现：原 scripts/check-public.sh 已删除。两个原因：
//   1) core.autocrlf=true 时工作区是 CRLF，bash 直接语法错误（"set: -: invalid option"）；
//   2) git grep 用 POSIX ERE，`[\s]` 会被当成字符类（反斜杠或 s），和 JS 正则不是一套语法。
// 所以这里不调 git grep：用 git ls-files 拿清单，逐文件用 JS 正则扫，跨平台只有一套语义。
//
// 这是绊线不是证明：正则只能抓已知形态，转公开前仍需人工过一遍全量 diff。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

let fail = 0;
function bad(line) { console.log(line); fail = 1; }

const EXT = /\.(md|json|ts|mjs|cjs|ps1)$/i;
const SKIP = /\.test\.(ts|mjs)$/i;

function tracked() {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split(/\r?\n/)
    .filter(Boolean);
}

// 1) 本地资料目录绝不入库
const all = tracked();
if (all.some((f) => f.startsWith('_research/'))) bad('FAIL  _research/ 下有文件被 git 跟踪');

const files = all.filter((f) => EXT.test(f) && !SKIP.test(f) && f !== 'scripts/check-public.mjs');
// 排除自身：规则字符串本身就在这个文件里，不排除会自命中。代价是本文件里的密钥只能靠人工 diff 发现。

// 2) 部署指纹与真实 ID（文档示例用 <userid> / *** / 占位）
const FP = new RegExp([
  'climaxmac', 'tailscale', 'tail7d673e', '100\\.(106|83)\\.', 'climaxracing',
  'ou_[a-z0-9]', 'oc_[a-z0-9]', 'cli_[a-z0-9]',
  'qyapi\\.weixin\\.qq\\.com/cgi-bin/webhook/send\\?key=[A-Za-z0-9-]{8,}',
  'corpsecret\\s*=\\s*[A-Za-z0-9]{8,}',
  'ww[0-9a-f]{16}',
].join('|'), 'i');

// 3) secret 明文赋值（放行 ${ENV} / *** / null / true / false / { / [ / < / TBC / ...）
const SEC = /(app_secret|api_key|_token|password)\s*[:=]\s*["'`]?[^\s"'`$]/i;
const ALLOW = /(app_secret|api_key|_token|password)\s*[:=]\s*["'`]?(\$\{|\*\*\*|null|true|false|\{|\[|<|TBC|\.\.\.)/i;

for (const f of files) {
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // 只报位置，不回显命中内容：输出可能被贴进群里
    if (FP.test(l)) bad('FAIL  fingerprint  ' + f + ':' + (i + 1));
    if (SEC.test(l) && !ALLOW.test(l)) bad('FAIL  secret-assign  ' + f + ':' + (i + 1));
  }
}

// 4) .ps1 必须带 UTF-8 BOM（PS 5.1 无 BOM 时按 ANSI 读，中文会解析失败）
for (const f of all.filter((x) => /\.ps1$/i.test(x))) {
  const b = readFileSync(f);
  if (!(b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF)) {
    bad('FAIL  ps1-bom  ' + f + '（缺少 UTF-8 BOM）');
  }
}

// 5) .json 不得带 BOM（JSON.parse 遇到 BOM 直接报错）
for (const f of all.filter((x) => /\.json$/i.test(x))) {
  const b = readFileSync(f);
  if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) {
    bad('FAIL  json-bom  ' + f + '（不应带 BOM）');
  }
}

process.exit(fail ? 1 : 0);
