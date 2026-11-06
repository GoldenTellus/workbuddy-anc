# interfaces — 服务接口

> 类型：模块契约

> 状态：现行（P2 已把 16 组命令与 HTTP 面都迁入 interfaces）
> 代码：`src/interfaces/cli/*`、`src/interfaces/http.ts`、`src/interfaces/index.ts`
> 入口：`src/interfaces/index.ts`；**稳定调用入口仍是 `src/service/cli.ts`（薄壳）**

## 职责

对外契约层：16 组 CLI 命令、3 条 HTTP 路由、审计包装、统一 `ERROR` / `FIX` 格式与退出码。**只做参数解析、调用、输出**；业务在能力模块。

## 拥有

| 数据/文件 | 说明 |
|---|---|
| service CLI 命令面 | 组名、子命令、参数、`--json` 输出形状 |
| HTTP 路由 | `/__anc_health`、`/__anc_status`、`/__anc_ingest` |
| 退出码 | 0 成功 / 1 运行失败 / 2 用法错误 |
| 审计包装 | 每次 CLI 调用写一行；`fail()` 直接退出时用退出码补记 |

## 公开契约

**16 个命令组**（help 必须全部列出，`cli.smoke.test.ts` 有断言）：

```
summary  bind  task  reminder  outbox  a2a  submission  issue
patch    dayend  eval  backup  config  project  serve  loop
```

- 所有命令支持 `--db <path>` 与 `--json`
- 失败固定两行：`ERROR <原因>` + `FIX <出路>`
- `bind resolve` 查不到 → 退出 1（不是 2）

**HTTP**：

| 路由 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/__anc_health` | GET | 无 | 只返回 `ok/detail/ts`，watchdog 用 |
| `/__anc_status` | GET | Bearer / `X-Anc-Token` | open 任务数、pending outbox |
| `/__anc_ingest` | POST | 同上 | 只接受 `inbox/pending` 下的批次；服务身份写 vault |

## 不变量

- **入口路径不变**：`%ProgramData%\anc\service\cli.ts` 是技能与 persona 的契约；它只是薄壳（转发到 `src/interfaces/cli/index.ts`），薄壳超过 ~30 行就是有人把业务写回来了。
- 未配置 token → 业务路由**一律 503**；错 token → 403；无 token → 401。
- 只监听 **127.0.0.1**；body 上限 64 KB。
- `/__anc_ingest` 的批次目录必须在 `inbox/pending` 下（否则等于以服务身份写任意路径）。
- `--json` 输出形状是契约；改字段 = 破坏性变更，要同步技能与文档。
- `serve` / `loop` 是长驻命令，不写审计成功行（退出时才写）。

## 失败模式

| 错误码 | 含义 | 出路 |
|---|---|---|
| `EXIT_2` | 参数/用法错误 | 看 `ERROR` 行；`FIX` 指向文档 |
| `token-not-configured` | 没配 service-token | 写 `secrets\service-token.txt` 后重启 `anc-http` |
| `missing-batch` / `bad-json` | 入库请求体不对 | 按 `docs/INGEST.md` 重投 |
| `body-too-large` | 超过 64 KB | 批次描述不该这么大；查是否传了文件内容 |

## 依赖

- 允许：core、identity、tasks、delivery、knowledge、improvement、runtime
- 禁止：org / workbuddy / ops（它们有各自入口）
- 说明：本模块是**组合根**，允许 import 所有能力模块；能力模块不许反向 import 它。

## 测试

`npm run test:service` 里的 `cli.smoke`（16 组、help、退出码）与 `http.test`（token/路由）；`deploy-verify` 在真机上再验一遍。

## 改动指南

- 加命令组：新建 `src/interfaces/cli/<group>.ts` + `registry.ts` 的 `order`/`handlers` + `cli.smoke` 的 16 组断言 + `docs/LOCAL-SERVICE.md` + 对应技能。
- 改输出字段：先查 `light/skills/*` 有没有解析它；有就同步改。
- 改 HTTP：同步 `docs/LOCAL-SERVICE.md`、`scripts/selfheal/watchdog.ps1`、`scripts/deploy/deploy-verify.ps1`。

## 变更记录

| 日期 | 改了什么 | 为什么 |
|---|---|---|
| 2026-11-06 | 建档 | 模块化立项 |
| 2026-11-06 | P2 拆分 CLI 与 HTTP；P4 依赖改为 modules 入口 | 模块化 |
