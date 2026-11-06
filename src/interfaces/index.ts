// interfaces 的公开入口：service CLI 的 run + HTTP 的 startServer。
// 部署入口仍是 service/cli.ts；这里给内部代码一个稳定 import 点。
export { run } from './cli/index.ts';
export { startServer } from './http.ts';
