#!/bin/bash
# 转公开检查:repo 转 public 前必跑。零输出且退出码 0 = 通过。
# 扫描范围:*.md *.json *.ts *.mjs *.cjs *.ps1(本脚本是 .sh,天然无自命中问题)。
# 注意:这是绊线(tripwire)不是证明——正则只能抓已知形态,转公开前仍需人工过一遍 diff。
set -u
fail=0

# 1) 本地资料目录绝不入库
if [ -n "$(git ls-files _research/)" ]; then
  echo "FAIL: _research/ 下有文件被 git 跟踪"
  fail=1
fi

# 2) 部署可定位信息与真实 ID(文档示例请用 ou_*** / cli_*** 占位)
hits=$(git grep -rnIiE 'climaxmac|tailscale|tail7d673e|100\.(106|83)\.|climaxracing|ou_[a-z0-9]|oc_[a-z0-9]|cli_[a-z0-9]' -- '*.md' '*.json' '*.ts' '*.mjs' '*.cjs' '*.ps1' || true)
if [ -n "$hits" ]; then
  echo "$hits"
  fail=1
fi

# 3) secret 明文赋值(= 或 :,可带引号;${ENV} 引用形态与裸字段名引用放行)
hits=$(git grep -rnIiE "(app_secret|api_key|_token|password)[[:space:]]*[:=][[:space:]]*[\"'\`]?[^\$\"'\`[:space:]]" -- '*.md' '*.json' '*.ts' '*.mjs' '*.cjs' '*.ps1' \
  | grep -viE "(app_secret|api_key|_token|password)[[:space:]]*[:=][[:space:]]*[\"'\`]?(\$\{|\*\*\*|null|true|false|\{|\[|<|TBC|\.\.\.)" || true)
if [ -n "$hits" ]; then
  echo "$hits"
  fail=1
fi

# 4) 所有 .ps1 必须带 UTF-8 BOM：PowerShell 5.1 无 BOM 时按 ANSI 读，中文会解析失败
while IFS= read -r f; do
  head=$(head -c 3 "$f" | od -An -tx1 | tr -d ' \n')
  if [ "$head" != "efbbbf" ]; then
    echo "FAIL: $f 缺少 UTF-8 BOM（PS 5.1 会按 ANSI 读，中文脚本会崩）"
    fail=1
  fi
done < <(git ls-files '*.ps1')

exit $fail
