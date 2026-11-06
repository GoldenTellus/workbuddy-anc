#!/usr/bin/env node
// 兼容薄壳：CLI 实现已拆到 src/interfaces/cli/。
// 保留这个路径是因为技能、persona、计划任务都按 service/cli.ts 调用；
// 部署布局里 service/cli.ts -> ../interfaces/cli/index.ts 必须一直可用。
import { run } from '../interfaces/cli/index.ts';

await run(process.argv.slice(2));
