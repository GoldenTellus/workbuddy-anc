#!/usr/bin/env node
// anc-bind —— 群与员工的绑定表（本地 SQLite，作为本地小服务的第一张表）
//
// 用途：公司 bot 收到的消息开头带 [anc:chat=<chatid> from=<userid>]，
//       agent 与本地小服务用 chatid 反查「这个群属于谁」。
//
// 用法：
//   node scripts/anc-bind/bind.mjs bind   --chat-id <id> --employee <name> [--note <text>] [--db <path>]
//   node scripts/anc-bind/bind.mjs unbind --chat-id <id> [--db <path>]
//   node scripts/anc-bind/bind.mjs resolve --chat-id <id> [--db <path>] [--json]
//   node scripts/anc-bind/bind.mjs list [--db <path>] [--json]
//
// 约定：chat_id 与 employee 都必填；不打印任何密钥；库里只有绑定关系。

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const DEFAULT_DB = join(HOME, 'anc', 'anc.db');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
      else { out[key] = true; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function fail(msg, code = 2) {
  console.error('ERROR ' + msg);
  console.error('FIX   看 docs/CHAT-BINDINGS.md 的用法');
  process.exit(code);
}

function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS chat_bindings (
      chat_id    TEXT PRIMARY KEY,
      employee   TEXT NOT NULL,
      note       TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function now() {
  return new Date().toISOString();
}

function clean(v, field) {
  if (typeof v !== 'string' || !v.trim()) fail(`缺少 ${field}`);
  const s = v.trim();
  if (s.length > 200) fail(`${field} 过长`);
  if (/[\u0000-\u001f]/.test(s)) fail(`${field} 含控制字符`);
  return s;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const dbPath = typeof args.db === 'string' ? args.db : DEFAULT_DB;
const asJson = args.json === true;

if (!cmd) fail('缺少子命令（bind / unbind / resolve / list）');

let db;
try {
  db = openDb(dbPath);
} catch (e) {
  fail('打不开数据库: ' + e.message);
}

function print(obj) {
  if (asJson) console.log(JSON.stringify(obj, null, 2));
  else console.log(obj);
}

if (cmd === 'bind') {
  const chatId = clean(args['chat-id'], '--chat-id');
  const employee = clean(args.employee, '--employee');
  const note = typeof args.note === 'string' ? args.note.trim() : null;
  const t = now();
  const exists = db.prepare('SELECT chat_id FROM chat_bindings WHERE chat_id = ?').get(chatId);
  if (exists) {
    db.prepare('UPDATE chat_bindings SET employee = ?, note = ?, updated_at = ? WHERE chat_id = ?')
      .run(employee, note, t, chatId);
    print({ ok: true, action: 'updated', chat_id: chatId, employee });
  } else {
    db.prepare('INSERT INTO chat_bindings (chat_id, employee, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(chatId, employee, note, t, t);
    print({ ok: true, action: 'created', chat_id: chatId, employee });
  }
} else if (cmd === 'unbind') {
  const chatId = clean(args['chat-id'], '--chat-id');
  const r = db.prepare('DELETE FROM chat_bindings WHERE chat_id = ?').run(chatId);
  print({ ok: true, removed: Number(r.changes || 0), chat_id: chatId });
} else if (cmd === 'resolve') {
  const chatId = clean(args['chat-id'], '--chat-id');
  const row = db.prepare('SELECT chat_id, employee, note, created_at, updated_at FROM chat_bindings WHERE chat_id = ?').get(chatId);
  if (!row) { print({ ok: false, found: false, chat_id: chatId }); process.exit(1); }
  print({ ok: true, found: true, ...row });
} else if (cmd === 'list') {
  const rows = db.prepare('SELECT chat_id, employee, note, created_at, updated_at FROM chat_bindings ORDER BY employee').all();
  if (asJson) print({ ok: true, count: rows.length, bindings: rows });
  else {
    if (!rows.length) console.log('(空)');
    for (const r of rows) console.log(`${r.employee}\t${r.chat_id}${r.note ? '\t' + r.note : ''}`);
  }
} else {
  fail('未知子命令: ' + cmd);
}

db.close();
