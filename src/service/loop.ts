// 兼容薄壳：tick/run 在 src/modules/runtime/，sendPending 在 src/modules/delivery/。
// 现有 import（interfaces/cli 的 outbox/loop、service.test）仍走这里；P4 后删除。
export * from '../modules/runtime/index.ts';
export { sendPending } from '../modules/delivery/index.ts';
