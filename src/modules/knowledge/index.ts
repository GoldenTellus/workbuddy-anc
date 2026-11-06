// knowledge 的公开入口。ingest/cli.ts 有顶层副作用，故意不在这里 re-export。
export * from './a2a.ts';
export * from './summarize.ts';
export * from './ingest/apply.ts';
export * from './ingest/validate.ts';
