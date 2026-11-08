import { readFileSync } from 'node:fs';
import * as bindings from '../../modules/identity/index.ts';
import type { CliContext } from './context.ts';
import { syncOrgIdentity, backfillFromBindings, verifyOrgIdentity } from './identity-sync.ts';

export default function bind(ctx: CliContext): void {
  const { db, args, cmd, out, fail } = ctx;
  if (cmd === 'set') {
    const r = bindings.bind(
      db,
      String(args['chat-id'] ?? ''),
      String(args.employee ?? ''),
      typeof args.note === 'string' ? args.note : undefined,
      typeof args.userid === 'string' ? args.userid : undefined,
      typeof args['webhook-file'] === 'string' ? args['webhook-file'] : undefined
    );
    out({ ok: true, action: r.action, binding: r.binding });
  } else if (cmd === 'resolve') {
    const b = bindings.resolve(db, String(args['chat-id'] ?? ''));
    out(b ? { ok: true, found: true, binding: b } : { ok: false, found: false });
    if (!b) process.exit(1);
  } else if (cmd === 'actor') {
    const chatId = String(args['chat-id'] ?? '');
    const userid = String(args['userid'] ?? '');
    if (!chatId || !userid) fail('缺少 --chat-id / --userid');
    const a = bindings.resolveActor(db, chatId, userid);
    if (!a.group || !a.person) {
      out({ ok: false, found: false, group: a.group, person: a.person });
      process.exit(1);
    }
    out({
      ok: true,
      found: true,
      group: a.group,
      person: a.person,
      manager_scopes: a.person.system_role === 'manager' ? bindings.listManagerScopes(db, a.person.person_id) : [],
    });
  } else if (cmd === 'unbind') {
    out({ ok: true, removed: bindings.unbind(db, String(args['chat-id'] ?? '')) });
  } else if (cmd === 'list') {
    out({ ok: true, bindings: bindings.listBindings(db) });
  } else if (cmd === 'import') {
    const from = typeof args.from === 'string' ? args.from : '';
    if (!from) fail('缺少 --from <groups.json>');
    const groups = JSON.parse(readFileSync(from, 'utf8')) as bindings.GroupsFile;
    out({ ok: true, ...bindings.importGroups(db, groups) });
  } else if (cmd === 'sync-org') {
    const org = typeof args.org === 'string' ? args.org : '';
    if (!org) fail('缺少 --org <org 目录>');
    out(syncOrgIdentity(db, org));
  } else if (cmd === 'verify-org') {
    const org = typeof args.org === 'string' ? args.org : '';
    if (!org) fail('缺少 --org <org 目录>');
    const r = verifyOrgIdentity(db, org);
    out(r);
    if (!r.ok) process.exit(1);
  } else if (cmd === 'backfill') {
    out(backfillFromBindings(db));
  } else if (cmd === 'group-set') {
    const chatId = String(args['chat-id'] ?? '');
    const type = String(args.type ?? '');
    if (!chatId || !type) fail('缺少 --chat-id / --type');
    const g = bindings.upsertGroup(db, {
      chatId,
      type: type as bindings.GroupType,
      employeeId: typeof args['employee-id'] === 'string' ? args['employee-id'] : undefined,
      deptId: typeof args['dept-id'] === 'string' ? args['dept-id'] : undefined,
      name: typeof args.name === 'string' ? args.name : undefined,
      webhookFile: typeof args['webhook-file'] === 'string' ? args['webhook-file'] : undefined,
      status: args.status === 'disabled' ? 'disabled' : 'active',
    });
    out({ ok: true, group: g });
  } else if (cmd === 'group-list') {
    const type = typeof args.type === 'string' ? args.type as bindings.GroupType : undefined;
    out({ ok: true, groups: bindings.listGroups(db, type) });
  } else if (cmd === 'person-list') {
    out({ ok: true, people: bindings.listPeople(db) });
  } else fail('未知 bind 子命令');
}
