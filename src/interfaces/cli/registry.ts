// 命令组注册表：新增一组命令 = 加一个文件 + 这里加一行 + cli.smoke 的 16 组断言。
// order 是 help 的顺序（保持与原 if/else 链一致），handlers 是分发目标。
import type { Handler } from './context.ts';
import summary from './summary.ts';
import bind from './bind.ts';
import task from './task.ts';
import executorGroup from './executor.ts';
import reminder from './reminder.ts';
import outbox from './outbox.ts';
import a2a from './a2a.ts';
import config from './config.ts';
import backup from './backup.ts';
import project from './project.ts';
import loop from './loop.ts';
import serve from './serve.ts';
import submission from './submission.ts';
import issue from './issue.ts';
import patch from './patch.ts';
import dayend from './dayend.ts';
import evalGroup from './eval.ts';

export const order = [
  'summary', 'bind', 'task', 'executor', 'reminder', 'outbox', 'a2a', 'config', 'backup',
  'project', 'loop', 'serve', 'submission', 'issue', 'patch', 'dayend', 'eval',
];

export const handlers: Record<string, Handler> = {
  summary,
  bind,
  task,
  executor: executorGroup,
  reminder,
  outbox,
  a2a,
  config,
  backup,
  project,
  loop,
  serve,
  submission,
  issue,
  patch,
  dayend,
  eval: evalGroup,
};
