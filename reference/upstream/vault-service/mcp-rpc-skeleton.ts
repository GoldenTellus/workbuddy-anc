/**
 * 摘录自上游 light/vault-service/src/index.ts（HA7CH/ai-native-company@90e4fb2，MIT），只作参考，不参与构建。
 *
 * 为什么留：若以后让公司 bot 经「自定义 MCP」调本地小服务（REUSE-MAP 第 88、148 行），
 * 这段零依赖的 MCP JSON-RPC 骨架（initialize / ping / tools/list / tools/call）可以直接改写：
 * Cloudflare Worker 的 fetch 换成 node:http 或 stdio，工具实现换成本地小服务的 CLI 能力。
 * MCP 的工具描述每轮都会带上，比只在第一轮注入的 CODEBUDDY.md 更稳。
 *
 * 不会用的部分（Worker / R2 / wrangler 部署、vault_* 五个工具实现）已随整个 vault-service 删除，
 * 需要时从 git 取：git show 90e4fb2:light/vault-service/src/index.ts
 */

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"];
const SERVER_INFO = { name: "anc-vault", version: "0.1.0" };

const INSTRUCTIONS = `这是本公司的共享 vault(唯一真相源)。使用纪律:
1. 回答公司事实前,先 vault_read("CLAUDE.md") 拿路由表,按表定位文件;拿不准先 vault_list 该目录。
2. 诚实条款:vault 里查不到的,就明确说「尚未入库」,绝不凭训练记忆补。
3. 写入前先读 CONTRIBUTING.md 的入库规范;每次写入给 author 和 reason,系统自动留历史版本。
4. 易变事实(名单/日程/口径)只在 canonical 文件单点维护,引用不复述。`;


// TOOLS：工具定义数组（name / description / inputSchema），按本地小服务能力重写
declare const TOOLS: unknown[];
declare type Env = unknown;

// ---------- MCP JSON-RPC(无状态 streamable HTTP)----------

type RpcMessage = { jsonrpc: "2.0"; id?: number | string | null; method?: string; params?: any };

function rpcResult(id: number | string | null | undefined, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function rpcError(id: number | string | null | undefined, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleRpc(msg: RpcMessage, env: Env): Promise<object | null> {
  if (msg === null || typeof msg !== "object" || Array.isArray(msg))
    return rpcError(null, -32600, "invalid request"); // body 为 null / 非对象也必须回 JSON-RPC 错误,不能 500
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  try {
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: TOOLS });
      case "tools/call": {
        const name = params?.name as string;
        const args = params?.arguments ?? {};
        const impl: Record<string, (e: Env, a: any) => Promise<string>> = {
          vault_list: toolList,
          vault_read: toolRead,
          vault_search: toolSearch,
          vault_write: toolWrite,
          vault_history: toolHistory,
        };
        if (!impl[name]) return rpcError(id, -32602, `未知工具:${name}`);
        try {
          const text = await impl[name](env, args);
          return rpcResult(id, { content: [{ type: "text", text }], isError: false });
        } catch (e: any) {
          return rpcResult(id, { content: [{ type: "text", text: `错误:${e?.message ?? e}` }], isError: true });
        }
      }
      default:
        if (isNotification) return null; // notifications/initialized 等:无响应体
        return rpcError(id, -32601, `不支持的方法:${method}`);
    }
  } catch (e: any) {
    return isNotification ? null : rpcError(id, -32603, `内部错误:${e?.message ?? e}`);
  }
}
