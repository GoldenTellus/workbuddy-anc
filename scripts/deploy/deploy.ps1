# 部署：把仓库里的运行件复制到 %ProgramData%\anc\
# 原则（OPS.md「补丁的唯一来源」）：线上只从部署目录跑，不从 git 工作副本跑。
# 默认 dry-run；加 -Apply 才落盘。落盘前备份、落盘后逐文件对拍 hash，失败回滚。
# 退出码：0 成功（含 dry-run）/ 1 落盘后校验失败且已回滚 / 2 用法或环境错误 / 3 复制失败且已回滚
[CmdletBinding()]
param(
    [string]$Repo = '',

    # 哪一侧：决定部署根。和 preflight / deploy-state / deploy-verify 保持一致。
    #   company  → %ProgramData%\anc（要注册任务、写 ProgramData，需管理员）
    #   employee → %LOCALAPPDATA%\anc（个人电脑上不该有 ProgramData 级别的写入）
    # 2026-11-05 加：原来只有 -Root，agent 读文档时得自己拼路径，容易错。
    [ValidateSet('company', 'employee')]
    [string]$Side = 'company',

    [string]$Root = '',
    [switch]$Apply,
    # 2026-11-09 加：恢复最近一次 deploy-<时间戳> 备份。
    #   文档早先就写了 `deploy.ps1 -Rollback`，但脚本里从来没实现过（GAP-068）。
    #   语义：按当前仓库的部署清单逐文件还原；备份里没有的文件视为本次新增 → 删除。
    [switch]$Rollback
)

$ErrorActionPreference = 'Stop'
# P5：脚本按域分组后不再写死盘符；从脚本位置向上找 .git，找不到就让下面的检查报错。
if (-not $Repo) {
    $c = $PSScriptRoot
    while ($c -and -not (Test-Path (Join-Path $c '.git'))) {
        $p = Split-Path -Parent $c
        if ($p -eq $c) { break }
        $c = $p
    }
    $Repo = $c
}
if (-not $Root) {
    $Root = if ($Side -eq 'company') { Join-Path $env:ProgramData 'anc' } else { Join-Path $env:LOCALAPPDATA 'anc' }
}

function Fail([string]$msg, [string]$fix, [int]$code) {
    Write-Host "ERROR $msg"
    Write-Host "FIX   $fix"
    exit $code
}

if (-not (Test-Path (Join-Path $Repo '.git'))) { Fail "不是仓库根: $Repo" '用 -Repo 指向仓库根（含 .git 的目录）' 2 }
if (-not (Test-Path $Root)) {
    if ($Side -eq 'company') {
        # 公司侧故意不自动建：目录的 ACL、vault 盘、secrets 都要先按 DEPLOY-COMPANY §4 立好，
        # 自动建出一个空目录只会让后面的 set-acl 对着不存在的结构跑。
        Fail "部署根不存在: $Root" '先按 docs/DEPLOY-COMPANY.md §4 建 %ProgramData%\anc 及各子目录' 2
    }
    # 员工侧自动建：目标是用户自己的 %LOCALAPPDATA%\anc，权限不需要预置。
    # 2026-11-10 修：手册从头到尾没有"建 %LOCALAPPDATA%\anc"这一步，而这里原来一律 Fail，
    # 新员工机第一次装必然卡在 files 阶段（FIX 还指向已经不存在的 AGENT-DEPLOY-EMPLOYEE §4）。
    if (-not $Apply) {
        "注意：部署根还不存在，-Apply 时会创建: $Root"
    } else {
        New-Item -ItemType Directory -Path $Root -Force | Out-Null
        "已创建部署根: $Root"
    }
}

# scripts\ 下的脚本按**用途**分两处落盘（2026-11-10 改）：
#
#   bin\    运行时 —— 14 个计划任务的动作、.cmd/.vbs 启动器、技能会直接调的脚本。
#           生产机上「正在被使用」的就这些。
#   tools\  装机与维护 —— 部署、重装、账号、演练、回归。装完就闲置，需要时人工跑。
#
# 为什么改成**显式清单**而不是原来的「递归收 scripts\ 下所有 ps1」：
#   那个白名单是目录级的，往 scripts\ 里丢一个开发/调试脚本（比如 e2e-loop.ps1、
#   rebuild-drill.ps1）会自动上生产，装的人根本不知道自己机器上多了什么。
#   改成清单后，新增运行件必须显式归类；漏了会在部署末尾列出来。
$BinScripts = @(
    # 启动器与任务包装
    'launch/anc-guard.cmd', 'launch/anc-http.cmd', 'launch/anc-launch.cmd',
    'launch/anc-loop.cmd',
    'launch/run-hidden.vbs',
    # 计划任务动作
    'executor/host-tick.ps1', 'executor/new-host.ps1', 'executor/wake-if-queued.ps1',
    'backup/backup-anc.ps1', 'backup/cleanup-media.ps1',
    'selfheal/anc-selfheal.ps1', 'selfheal/boot-alert.ps1', 'selfheal/watchdog.ps1',
    'workbuddy/check-workbuddy-update.ps1', 'workbuddy/patch-guard.ps1',
    'devbot/devbot.ps1', 'devbot/devbot-scheduler.ps1',
    'doctor/doctor.ps1',
    # 技能会直接调的
    'accounts/bind-member-identity.ps1',
    # 提权执行器（SYSTEM 任务动作）+ 投递请求（bot 调）
    'elevate/elevate-runner.ps1', 'elevate/request-elevate.ps1'
)
$ToolScripts = @(
    # 部署与自证
    'deploy/deploy.ps1', 'deploy/deploy-kickoff.ps1',
    'deploy/setup-executor.ps1', 'deploy/deploy-persona.ps1',
    'deploy/deploy-skills.ps1', 'deploy/deploy-state.ps1', 'deploy/deploy-verify.ps1',
    'deploy/preflight.ps1', 'deploy/register-tasks.ps1', 'deploy/set-acl.ps1',
    # 一句话升级（anc-update 技能调它）
    'deploy/upgrade.ps1',
    # 从 answers 生成 org 目录
    'deploy/org-write.ps1',
    # 一键初始化：目录 / vault 两区 / webhook 文件
    'deploy/setup-dirs.ps1', 'deploy/vault-init.ps1', 'deploy/wecom-setup.ps1',
    # 公司侧一条命令装完（编排）
    'deploy/install-company.ps1',
    # 零起点引导：装 Node/Git、刷 PATH（agent 部署第一步）
    'deploy/bootstrap.ps1',
    # 账号与组织（入职/离职时用）
    'accounts/provision-vault-accounts.ps1', 'accounts/verify-vault-accounts.ps1',
    'accounts/offboard-member.ps1', 'accounts/setup-anc-bot.ps1',
    # 重建与演练
    'rebuild/prepare-wipe.ps1', 'rebuild/rebuild-drill.ps1', 'rebuild/rebuild-z.ps1',
    # 升级回归与端到端
    'workbuddy/verify-upgrade.ps1', 'devbot/e2e-loop.ps1'
)

# 有意不部署的脚本。显式写出来，免得它们每次部署都跳「未归类」警告，
# 也免得后人以为漏了。加新条目要写字由。
$NotDeployed = @(
    'verify/t3-webhook.ps1'   # 仓库自测：单独验 webhook 签名，生产不需要
)

# 目标子目录 ← 源。
#
# 落盘路径规则（2026-11-10 改）：
#   - 默认**保留源目录下的相对结构**。给模块加子目录（如 modules/executor/claim/）
#     不会把文件平铺掉、导致相对 import 断链。历史上只按文件名平铺，因为没有子目录所以没暴露。
#   - bin / tools 例外：`Flatten = $true`。任务和 .cmd 都按 `<Root>\bin\<文件名>` 引用
#     （见 OPS 任务表），一旦保留 launch\ 这层，14 个计划任务全部指空。
$Map = @(
    @{ Target = 'core';    Source = 'src\core';    Filter = @('*.ts', '*.json'); Exclude = @('*.test.ts') },
    @{ Target = 'interfaces'; Source = 'src\interfaces'; Filter = @('*.ts', '*.json'); Exclude = @('*.test.ts') },
    @{ Target = 'interfaces\cli'; Source = 'src\interfaces\cli'; Filter = @('*.ts', '*.json'); Exclude = @('*.test.ts') },
    @{ Target = 'modules\runtime'; Source = 'src\modules\runtime'; Filter = @('*.ts', '*.json'); Exclude = @('*.test.ts') },
    @{ Target = 'modules\identity'; Source = 'src\modules\identity'; Filter = @('*.ts', '*.json'); Exclude = @('*.test.ts') },
    @{ Target = 'modules\tasks'; Source = 'src\modules\tasks'; Filter = @('*.ts', '*.json'); Exclude = @('*.test.ts') },
    @{ Target = 'modules\executor'; Source = 'src\modules\executor'; Filter = @('*.ts', '*.json'); Exclude = @('*.test.ts') },
    @{ Target = 'modules\delivery'; Source = 'src\modules\delivery'; Filter = @('*.ts', '*.json'); Exclude = @('*.test.ts') },
    @{ Target = 'modules\improvement'; Source = 'src\modules\improvement'; Filter = @('*.ts', '*.json'); Exclude = @('*.test.ts') },
    @{ Target = 'modules\knowledge'; Source = 'src\modules\knowledge'; Filter = @('*.ts', '*.json'); Exclude = @('*.test.ts') },
    @{ Target = 'modules\knowledge\ingest'; Source = 'src\modules\knowledge\ingest'; Filter = @('*.ts', '*.json'); Exclude = @('*.test.ts') },
    @{ Target = 'modules\org'; Source = 'src\modules\org'; Filter = @('*.ts', '*.json'); Exclude = @('*.test.ts') },
    @{ Target = 'service'; Source = 'src\service'; Filter = @('*.ts', '*.json'); Exclude = @('*.test.ts') },
    @{ Target = 'ingest';  Source = 'src\ingest';  Filter = @('*.ts', '*.json'); Exclude = @('*.test.ts') },
    @{ Target = 'render';  Source = 'src\render';  Filter = @('*.ts', '*.json'); Exclude = @('*.test.ts') },
    # 渲染模板：两层都要（company-bot.md / member-bot.md 在根，vault/ 下还有 5 份协作模板）。
    # 2026-11-10 修：原来只收顶层 *.md，light\templates\vault\ 下的「任务看板/决策记录/交接/问题模型」
    # 一份都没铺 —— 仓库里有、线上没有，建 vault 时也就没模板可铺。
    @{ Target = 'light\templates'; Source = 'light\templates'; Filter = @('*.md'); Exclude = @(); Recurse = $true },
    @{ Target = 'shared';  Source = 'src\shared';  Filter = @('*.ts', '*.json'); Exclude = @('*.test.ts') },
    # bin / tools 必须扁平：14 个计划任务和 .cmd 都写死 <Root>\bin\<文件名>。
    # Only = 显式清单；清单外的脚本不会部署（workbuddy-patch 走下面的 patch 映射，
    # verify/t3-webhook.ps1 是仓库自测脚本，本就不该上生产）。
    @{ Target = 'bin';     Source = 'scripts';     Filter = @('*'); Exclude = @(); Recurse = $true; Flatten = $true; Only = $BinScripts },
    @{ Target = 'tools';   Source = 'scripts';     Filter = @('*'); Exclude = @(); Recurse = $true; Flatten = $true; Only = $ToolScripts },
    # patch 目录不做测试文件过滤会把 *.test.mjs 一起送上生产。
    @{ Target = 'patch';   Source = 'scripts\workbuddy-patch'; Filter = @('*'); Exclude = @('*.test.mjs', '*.test.cjs') }
)

# 覆盖检查：src 下每个非测试 .ts 都必须能落到某个映射里。
# 2026-11-02 踩过：加了 src/audit.ts 但映射没跟上，部署后 cli 直接 ERR_MODULE_NOT_FOUND，doctor 全瞎。
$srcRoot = Join-Path $Repo 'src'
if (Test-Path $srcRoot) {
    $sources = @($Map | ForEach-Object { (Join-Path $Repo $_.Source).TrimEnd('\') })
    $uncovered = @()
    foreach ($f in @(Get-ChildItem $srcRoot -Recurse -File -Filter '*.ts' | Where-Object { $_.Name -notmatch '\.test\.ts$' })) {
        $ok = $false
        foreach ($s2 in $sources) { if ($f.FullName.StartsWith($s2 + '\')) { $ok = $true; break } }
        if (-not $ok) { $uncovered += $f.FullName.Substring($Repo.Length + 1) }
    }
    if ($uncovered.Count -gt 0) {
        Fail ('这些源文件没有部署目标: ' + ($uncovered -join ', ')) '在 deploy.ps1 的 $Map 里给它加一条，否则线上会 import 失败' 2
    }
}
$plan = @()

# 清单自检：清单里写了的文件必须真的存在。
# 改了脚本名却忘了改清单，结果是「部署成功、但少一个文件」——比部署直接失败难查得多。
$scriptsRoot = Join-Path $Repo 'scripts'
$missingDeclared = @()
foreach ($x in $BinScripts) {
    if (-not (Test-Path (Join-Path $scriptsRoot $x.Replace('/', '\')))) { $missingDeclared += ('bin/' + $x) }
}
foreach ($x in $ToolScripts) {
    if (-not (Test-Path (Join-Path $scriptsRoot $x.Replace('/', '\')))) { $missingDeclared += ('tools/' + $x) }
}
if ($missingDeclared.Count -gt 0) {
    Fail ('部署清单里有不存在的脚本: ' + ($missingDeclared -join ', ')) '改名后同步更新 deploy.ps1 的 $BinScripts / $ToolScripts（故意不部署也要从清单里删掉）' 2
}

# 未归类提醒：scripts 下还有脚本既不在 bin 也不在 tools —— 它们不会部署。
# 不 Fail 是因为开发期常有临时脚本；但必须让执行者看见，否则「以为部署了」比没部署更糟。
$declaredAll = @($BinScripts) + @($ToolScripts)
$unclassified = @()
foreach ($f in @(Get-ChildItem -LiteralPath $scriptsRoot -Recurse -File |
        Where-Object { $_.Extension -in @('.ps1', '.cmd', '.vbs') })) {
    $rel = $f.FullName.Substring($scriptsRoot.Length).TrimStart('\').Replace('\', '/')
    if ($rel -like 'workbuddy-patch/*') { continue }   # 走单独的 patch 映射
    if ($NotDeployed -contains $rel) { continue }      # 有意不部署
    if ($declaredAll -notcontains $rel) { $unclassified += $rel }
}
if ($unclassified.Count -gt 0) {
    'WARN 这些脚本没有归到 bin 或 tools，**不会部署**：'
    $unclassified | Sort-Object | ForEach-Object { '       scripts\' + $_.Replace('/', '\') }
    '     要部署就加进 deploy.ps1 的 $BinScripts（运行时）或 $ToolScripts（装机维护）。'
    ''
}

foreach ($m in $Map) {
    $srcDir = Join-Path $Repo $m.Source
    if (-not (Test-Path $srcDir)) { Fail "源目录不存在: $srcDir" '确认 -Repo 指向仓库根' 2 }
    $files = if ($m.Recurse) { @(Get-ChildItem -LiteralPath $srcDir -Recurse -File) } else { @(Get-ChildItem -LiteralPath $srcDir -File) }
    foreach ($f in $files) {
        $relPath = $f.FullName.Substring($srcDir.Length).TrimStart('\')
        # 显式清单：清单外的文件不部署（清单用 / 分隔，跨平台也好对）
        if ($m.Only) {
            if ($m.Only -notcontains $relPath.Replace('\', '/')) { continue }
        }
        if ($m.SkipDirs) {
            $skipDir = $false
            foreach ($d in $m.SkipDirs) { if ($relPath -like ($d + '\*')) { $skipDir = $true; break } }
            if ($skipDir) { continue }
        }
        $n = $f.Name
        $hit = $false
        foreach ($p in $m.Filter) { if ($n -like $p) { $hit = $true; break } }
        if (-not $hit) { continue }
        $skip = $false
        foreach ($p in $m.Exclude) { if ($n -like $p) { $skip = $true; break } }
        if ($skip) { continue }
        # 落盘相对路径：bin 扁平（只留文件名），其余保留源目录下的结构。
        $dstRel = if ($m.Flatten) { $n } else { $relPath }
        $rel = Join-Path $m.Target $dstRel
        $plan += [pscustomobject]@{
            Target = $m.Target
            Rel    = $rel
            Src    = $f.FullName
            Dst    = Join-Path $Root $rel
            Hash   = (Get-FileHash $f.FullName -Algorithm SHA256).Hash
            Bytes  = $f.Length
        }
    }
}
if ($plan.Count -eq 0) { Fail '没有可部署的文件' '检查 -Repo 与源目录' 2 }

# 计划摘要（两种模式都先打印）
$grouped = $plan | Group-Object Target
foreach ($g in $grouped) {
    '{0,-9} {1,3} 个文件  {2,9:N0} B' -f $g.Name, $g.Count, (($g.Group | Measure-Object Bytes -Sum).Sum)
}
'合计 {0} 个文件，目标根 {1}' -f $plan.Count, $Root
''

# ── 清单收敛：bin\ 里不该留着清单外的脚本 ─────────────────────
# 老机器是从「目录级递归」迁移来的，bin\ 里还躺着 deploy*/rebuild*/e2e-loop 这些工具脚本。
# 部署只写不删，不处理的话 bin\ 会一直脏着，正好和「只放运行时」相反。
# 处理方式：不直接删，移到 backup\migrate-<时间戳>\bin\，确认无误后由人清理。
$binDir = Join-Path $Root 'bin'
$staleBin = @()
if (Test-Path $binDir) {
    $wantBin = @($BinScripts | ForEach-Object { Split-Path $_ -Leaf })
    $staleBin = @(Get-ChildItem -LiteralPath $binDir -File |
        Where-Object { $_.Extension -in @('.ps1', '.cmd', '.vbs') -and $wantBin -notcontains $_.Name })
}
if ($staleBin.Count -gt 0) {
    '注意：bin\ 里有 {0} 个不在运行清单里的脚本（{1}）：' -f $staleBin.Count, $(if ($Apply) { '-Apply 后移到 backup\migrate-<时间戳>\bin\' } else { '-Apply 会把它们移走' })
    $staleBin | Sort-Object Name | ForEach-Object { '       ' + $_.Name }
    ''
}

# ── 回滚：恢复最近一次 deploy-<时间戳> 备份 ───────────────────
# 判据：备份目录里有的文件 → 原样复制回去；备份里没有的 → 本次部署新增，删掉。
# 删除前只针对 $plan 里的目标文件，不递归删目录，避免误伤 data/backup/secrets 等运行数据。
if ($Rollback) {
    $bakParent = Join-Path $Root 'backup'
    $baks = @(Get-ChildItem -LiteralPath $bakParent -Directory -Filter 'deploy-*' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending)
    if ($baks.Count -eq 0) {
        # 首次部署没有旧文件可备份：回滚 = 按当前部署清单删除本次铺下去的文件，回到“没装”状态。
        '没有部署备份（首次部署）：按当前清单删除已部署文件，回到部署前'
        $removedFirst = 0
        $firstFail = @()
        foreach ($p in $plan) {
            if (-not (Test-Path -LiteralPath $p.Dst)) { continue }
            try { Remove-Item -LiteralPath $p.Dst -Force -ErrorAction Stop; $removedFirst++ }
            catch { $firstFail += ($p.Dst + '：' + $_.Exception.Message) }
        }
        if ($firstFail.Count -gt 0) {
            Fail ('首次部署回滚失败 ' + $firstFail.Count + ' 项: ' + ($firstFail -join '; ')) '逐项手工删除上面列出的文件' 1
        }
        'OK：首次部署回滚完成，删除 {0} 个文件（data/backup/secrets 未动）' -f $removedFirst
        exit 0
    }
    $srcBak = $baks[0].FullName
    '回滚源: {0}' -f $srcBak
    $restored = 0
    $removed = 0
    $rbFail = @()
    foreach ($p in $plan) {
        # 备份按「相对 Root 的路径」存，保留结构；按文件名存会让不同子目录的同名文件互相覆盖
        $b = Join-Path $srcBak $p.Rel
        try {
            if (Test-Path -LiteralPath $b) {
                Copy-Item -LiteralPath $b -Destination $p.Dst -Force -ErrorAction Stop
                $restored++
            } elseif (Test-Path -LiteralPath $p.Dst) {
                Remove-Item -LiteralPath $p.Dst -Force -ErrorAction Stop
                $removed++
            }
        } catch { $rbFail += ($p.Dst + '：' + $_.Exception.Message) }
    }
    if ($rbFail.Count -gt 0) {
        Fail ('回滚失败 ' + $rbFail.Count + ' 项: ' + ($rbFail -join '; ')) '备份目录未删除；可手工按上面路径恢复' 1
    }
    'OK：已回滚到 {0}（恢复 {1} 个，删除新增 {2} 个）' -f $srcBak, $restored, $removed
    '提示：回滚后 WorkBuddy/任务可能仍在跑旧进程，按 OPS 重启任务或补丁启动器；确认后可再 deploy.ps1 -Apply。'
    exit 0
}

if (-not $Apply) {
    'DRY-RUN：以上是计划，加 -Apply 才落盘。'
    exit 0
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bakRoot = Join-Path (Join-Path $Root 'backup') ('deploy-' + $stamp)
# 首次部署没有旧文件可备份，仍把目录建出来：最终提示“备份: <路径>”必须指到真实路径，
# 否则员工侧会看到一条指向不存在目录的误导信息（2026-11-11 员工机实测）。
if ($Apply) { New-Item -ItemType Directory -Force -Path $bakRoot | Out-Null }
$createdDirs = @()
$copied = @()

function Copy-WithRetry([string]$Src, [string]$Dst, [int]$Tries = 3) {
    for ($i = 1; $i -le $Tries; $i++) {

        try {
            Copy-Item -LiteralPath $Src -Destination $Dst -Force -ErrorAction Stop
            return
        } catch {
            if ($i -eq $Tries) { throw }
            Start-Sleep -Milliseconds 250
        }
    }
}

# 回滚：把 $Items 里每个目标恢复到备份、删掉没有备份的新文件，并清掉本次新建的目录。
# 2026-11-06 修：原来只有「落盘后 hash 校验失败」会回滚，复制中途抛错直接 exit 3，
# 前半套新文件已经盖在旧文件上，错误文案却说「已写入的文件会回滚」——是假的。
function Restore-Deploy([object[]]$Items, [string]$BackupRoot) {
    # 2026-11-06 二修：回滚是最后一道安全底线，原来每步都 -ErrorAction SilentlyContinue
    # 且不查 $? —— 文件被占用 / ACL 拒绝 / 盘满时静默跳过，脚本照样打印「已回滚」。
    $failed = @()
    foreach ($p in $Items) {
        $b = Join-Path $BackupRoot $p.Rel
        try {
            if (Test-Path -LiteralPath $b) {
                Copy-Item -LiteralPath $b -Destination $p.Dst -Force -ErrorAction Stop
            } elseif (Test-Path -LiteralPath $p.Dst) {
                Remove-Item -LiteralPath $p.Dst -Force -ErrorAction Stop
            }
        } catch { $failed += ($p.Dst + '：' + $_.Exception.Message) }
    }
    foreach ($d in $createdDirs) {
        try { Remove-Item -LiteralPath $d -Force -Recurse -ErrorAction Stop }
        catch { $failed += ($d + '：' + $_.Exception.Message) }
    }
    return ,$failed
}

# 权限：secrets 与 data 的 ACL 不随文件复制走，单独设（2026-11-05，VERIFY §65/§66/§70）。
# 必须在 Copy-WithRetry 定义**之外** —— 2026-11-05 曾误插进那个 for 循环里，
# 结果每次重试都调一次 set-acl，73 个文件 × 3 次重试 = 219 次 × 7 秒，deploy 变成 25 分钟。
# 员工侧没有 LOCAL SERVICE 任务，set-acl.ps1 自己会整段跳过。
$setAclPs1 = Join-Path $PSScriptRoot 'set-acl.ps1'
if (Test-Path $setAclPs1) {
    $aclArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $setAclPs1, '-Root', $Root, '-Side', $Side)
    if ($Apply) { $aclArgs += '-Apply' }
    # 必须跳过自检 —— 三层嵌套（deploy → set-acl → doctor）会卡死（VERIFY §70）。
    $aclArgs += '-SkipVerify'
    & powershell @aclArgs
    if ($LASTEXITCODE -ne 0 -and $Apply) {
        Fail ('设 ACL 失败（exit ' + $LASTEXITCODE + '）') '看上面 set-acl.ps1 的 ERR 行；可能需要管理员权限' 2
    }
} else {
    '注意：没找到 scripts\deploy\set-acl.ps1 —— secrets / data 的 ACL 要人工设（见 REBUILD §2.5）'
}

try {
    foreach ($p in $plan) {
        $dstDir = Split-Path $p.Dst -Parent
        if (-not (Test-Path $dstDir)) {
            New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
            $createdDirs += $dstDir
        }
        if (Test-Path $p.Dst) {
            $bak = Join-Path $bakRoot $p.Rel
            $bakDir = Split-Path $bak -Parent
            if (-not (Test-Path $bakDir)) { New-Item -ItemType Directory -Path $bakDir -Force | Out-Null }
            Copy-Item -LiteralPath $p.Dst -Destination $bak -Force
        }
        Copy-WithRetry $p.Src $p.Dst
        $copied += $p
    }
} catch {
    # 只回滚真正复制过的 $copied：没处理到的目标若走「无备份就删除」，会误删原文件
    $rb = @(Restore-Deploy $copied $bakRoot)
    if ($rb.Count -gt 0) {
        Fail ('复制失败: ' + $_.Exception.Message) ('回滚不完整（' + $rb.Count + ' 项失败）：' + ($rb -join '; ') + '；需手工从 ' + $bakRoot + ' 恢复') 3
    }
    Fail ('复制失败: ' + $_.Exception.Message) ('已回滚 ' + $copied.Count + ' 个已写入文件；备份在 ' + $bakRoot) 3
}

# 逐文件对拍
$bad = @()
foreach ($p in $plan) {
    if (-not (Test-Path $p.Dst)) { $bad += ($p.Dst + '（缺失）'); continue }
    if ((Get-FileHash $p.Dst -Algorithm SHA256).Hash -ne $p.Hash) { $bad += ($p.Dst + '（hash 不一致）') }
}

if ($bad.Count -gt 0) {
    $rb = @(Restore-Deploy $plan $bakRoot)
    if ($rb.Count -gt 0) {
        Fail ('落盘后校验失败: ' + ($bad -join '; ')) ('回滚不完整（' + $rb.Count + ' 项失败）：' + ($rb -join '; ') + '；需手工从 ' + $bakRoot + ' 恢复') 1
    }
    Fail ('落盘后校验失败: ' + ($bad -join '; ')) ('已回滚；备份在 ' + $bakRoot) 1
}

'OK：{0} 个文件已部署并逐一校验通过。备份: {1}' -f $plan.Count, $bakRoot

if ($staleBin.Count -gt 0) {
    $migDir = Join-Path (Join-Path $Root 'backup') ('migrate-' + $stamp + '\bin')
    New-Item -ItemType Directory -Path $migDir -Force | Out-Null
    $moved = 0
    foreach ($f in $staleBin) {
        try { Move-Item -LiteralPath $f.FullName -Destination (Join-Path $migDir $f.Name) -Force -ErrorAction Stop; $moved++ }
        catch { Write-Host ('WARN 移不动 ' + $f.Name + '：' + $_.Exception.Message) }
    }
    '已把 {0} 个清单外脚本从 bin\ 移到 {1}' -f $moved, $migDir
    '（没删，确认任务是 Ready 之后自行清理这个 migrate 目录）'
}
'提示：跑一次 bin\doctor.ps1（部署目录里的那份），deploy-layout 应转 PASS。'
exit 0
