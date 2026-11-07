import type { DatabaseSync } from 'node:sqlite';
import { loadOrg } from '../../modules/org/index.ts';
import {
  bind as bindLegacy,
  listBindings,
  resolveGroup,
  resolvePersonByUserid,
  setManagerScopes,
  upsertGroup,
  upsertPerson,
} from '../../modules/identity/index.ts';

export interface OrgSyncResult {
  ok: true;
  people: number;
  employeeGroups: number;
  managers: number;
  legacyBindings: number;
  warnings: string[];
}

/**
 * 把 org 的成员/老板/管理者范围同步到运行时表。
 * - 只同步员工群（member.chat_id）；company/department/boss_dm 用 `bind group-set` 配。
 * - 同时写 chat_bindings，保证旧技能/CLI 还能用。
 * - 不做删除：org 里移除的人不会自动清库，避免误删历史任务/群。
 */
export function syncOrgIdentity(db: DatabaseSync, orgDir: string): OrgSyncResult {
  const org = loadOrg(orgDir);
  const warnings: string[] = [];
  const seenChats = new Map<string, string>();
  let people = 0;
  let employeeGroups = 0;
  let managers = 0;
  let legacyBindings = 0;

  if (!org.boss) warnings.push('company.boss 未配置：本次不会产生 boss 角色');

  for (const m of org.members) {
    const isBoss = org.boss === m.id;
    const manages = m.disabled ? [] : (m.manages ?? []);
    const role = isBoss ? 'boss' : manages.length > 0 ? 'manager' : 'employee';
    upsertPerson(db, {
      personId: m.id,
      name: m.name,
      userid: m.userid,
      systemRole: role,
      deptId: m.dept,
      status: m.disabled ? 'disabled' : 'active',
    });
    people++;

    // 全量替换：org 删掉 manages 后，旧范围必须消失
    setManagerScopes(db, m.id, manages);
    if (manages.length > 0) managers++;

    if (m.disabled) continue;
    if (!m.userid) warnings.push(`成员 ${m.id} 没有 userid：无法按发送人识别`);
    if (!m.chat_id) {
      warnings.push(`成员 ${m.id} 没有 chat_id：没有员工群可同步`);
      continue;
    }
    const prev = seenChats.get(m.chat_id);
    if (prev) {
      warnings.push(`chat_id 重复：${m.chat_id} 同时属于 ${prev} 和 ${m.id}，后者覆盖`);
    }
    seenChats.set(m.chat_id, m.id);

    upsertGroup(db, {
      chatId: m.chat_id,
      type: 'employee',
      employeeId: m.id,
      name: `${m.name}的员工群`,
    });
    employeeGroups++;

    // 兼容层：旧技能仍用 chat_bindings 解析群 → 员工
    bindLegacy(db, m.chat_id, m.name, 'synced from org', m.userid, m.webhook_file);
    legacyBindings++;
  }

  return { ok: true, people, employeeGroups, managers, legacyBindings, warnings };
}

export interface BackfillResult {
  ok: true;
  matchedPeople: number;
  groupsCreated: number;
  skipped: number;
  warnings: string[];
}

/**
 * 旧库回填：把 chat_bindings 补成 groups(type=employee)。
 * 只按 userid 匹配 people；匹配不到就不猜人，留给 sync-org / 人工处理。
 * 已存在的群不覆盖（可能是 company/department/boss_dm 手工配置）。
 */
export function backfillFromBindings(db: DatabaseSync): BackfillResult {
  const warnings: string[] = [];
  let matchedPeople = 0;
  let groupsCreated = 0;
  let skipped = 0;
  for (const b of listBindings(db)) {
    if (!b.userid) { warnings.push(`绑定 ${b.chat_id} 没有 userid，跳过`); skipped++; continue; }
    const p = resolvePersonByUserid(db, b.userid);
    if (!p) { warnings.push(`绑定 ${b.chat_id} 的 userid ${b.userid} 在 people 里找不到，跳过`); skipped++; continue; }
    matchedPeople++;
    const existing = resolveGroup(db, b.chat_id);
    if (existing) {
      if (existing.type !== 'employee') warnings.push(`绑定 ${b.chat_id} 已是 ${existing.type} 群，不覆盖`);
      skipped++;
      continue;
    }
    upsertGroup(db, { chatId: b.chat_id, type: 'employee', employeeId: p.person_id, name: b.employee });
    groupsCreated++;
  }
  return { ok: true, matchedPeople, groupsCreated, skipped, warnings };
}
