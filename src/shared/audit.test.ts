import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAudit, auditPath, commandName } from '../core/index.ts';

test('审计：追加 JSONL，多行可逐行解析', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-audit-'));
  try {
    appendAudit(dir, { at: '2026-11-02T09:00:00.000Z', cmd: 'task add', ok: true, code: null, targets: [] });
    appendAudit(dir, { at: '2026-11-02T09:01:00.000Z', cmd: 'ingest apply', ok: false, code: 'BAD_META', targets: [] });
    const lines = readFileSync(auditPath(dir), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]) as { cmd: string; ok: boolean };
    const second = JSON.parse(lines[1]) as { code: string };
    assert.equal(first.cmd, 'task add');
    assert.equal(first.ok, true);
    assert.equal(second.code, 'BAD_META');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('审计：目录不存在时自动建；不可写时不抛错（观测手段不挡主流程）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anc-audit2-'));
  try {
    const nested = join(dir, 'a', 'b');
    appendAudit(nested, { at: 'x', cmd: 'c', ok: true, code: null, targets: [] });
    assert.ok(readFileSync(auditPath(nested), 'utf8').includes('"cmd":"c"'));
    // 传一个不可能写的路径，函数必须静默（观测手段不挡主流程）。
    // 2026-11-16 修：原来用 'Z:\\definitely\\not\\writable'，那是 Windows 语义；
    // 在 macOS 上它只是「当前目录下叫 Z:\definitely\not\writable 的相对路径」，
    // 会被顺利创建 —— 测试变绿、仓库里多一坨垃圾。改成两边都成立的空目录夹具：
    // 父级是一个**文件**，mkdir 必然 ENOTDIR。
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, '');
    appendAudit(join(blocker, 'audit.log'), { at: 'x', cmd: 'c', ok: true, code: null, targets: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('审计：命令名只取前两个非参数词', () => {
  assert.equal(commandName(['task', 'add', '--title', 'x']), 'task add');
  assert.equal(commandName(['ingest', 'apply', '--batch', 'b']), 'ingest apply');
  assert.equal(commandName(['--json']), '(none)');
});
