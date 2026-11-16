// 平台底座路径的测试。
//
// 跨层对拍（本文件 vs scripts/platform/anc-platform.mjs）不在这里做：
// src 不能依赖 scripts（R「ops 只通过 CLI/文件契约调用」）。对拍由
// scripts/checks/check-platform-parity.mjs 在 npm run check 时跑。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ancPaths, defaultDbPath, defaultVaultRoot, sideFromEnv, sideRoot } from './paths.ts';

const HOME = '/Users/example';

test('Windows：公司侧 = %ProgramData%\\anc，员工侧 = %LOCALAPPDATA%\\anc', () => {
  const env = { ProgramData: 'C:\\ProgramData', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
  assert.equal(sideRoot('company', { os: 'win32', env, homedir: 'C:\\Users\\u' }), join('C:\\ProgramData', 'anc'));
  assert.equal(sideRoot('employee', { os: 'win32', env, homedir: 'C:\\Users\\u' }), join('C:\\Users\\u\\AppData\\Local', 'anc'));
});

test('macOS：不再回落到 C:\\ProgramData，也不会在仓库里造目录', () => {
  const root = sideRoot('company', { os: 'darwin', env: {}, homedir: HOME });
  assert.equal(root, '/Library/Application Support/anc');
  assert.equal(sideRoot('employee', { os: 'darwin', env: {}, homedir: HOME }), join(HOME, 'Library', 'Application Support', 'anc'));
  assert.ok(!/ProgramData/i.test(root), 'macOS 根路径不能带 ProgramData');
});

test('ANC_DB 优先于默认库路径；没有时落在 <root>/data/anc.db', () => {
  assert.equal(defaultDbPath({ os: 'darwin', env: { ANC_DB: '/tmp/x.db' }, homedir: HOME }), '/tmp/x.db');
  const dflt = defaultDbPath({ os: 'darwin', env: {}, homedir: HOME });
  assert.equal(dflt, join('/Library/Application Support/anc', 'data', 'anc.db'));
  // 空串等于没设：不能拼出 <root>/data/ 这种目录
  assert.ok(defaultDbPath({ os: 'darwin', env: { ANC_DB: '   ' }, homedir: HOME }).endsWith('anc.db'));
});

test('side 解析：ANC_SIDE 只认 employee，其余按 company', () => {
  assert.equal(sideFromEnv({ ANC_SIDE: 'employee' }), 'employee');
  assert.equal(sideFromEnv({ ANC_SIDE: 'EMPLOYEE ' }), 'employee');
  assert.equal(sideFromEnv({ ANC_SIDE: 'company' }), 'company');
  assert.equal(sideFromEnv({}), 'company');
  assert.equal(sideFromEnv({ ANC_SIDE: 'boss' }), 'company');
});

test('目录表：15 个部署目录与 5 个 vault 目录都在 ancPaths 里', () => {
  const p = ancPaths('/tmp/anc');
  for (const d of [
    'accounts', 'backup', 'bin', 'data', 'evals', 'inbox', 'ingest',
    'light', 'patch', 'render', 'secrets', 'service', 'shared', 'skills', 'stage',
  ]) {
    assert.equal(p[d], join('/tmp/anc', d), 'ancPaths 缺目录: ' + d);
  }
});
