import type { DatabaseSync } from 'node:sqlite';
import { loadOrg } from '../../modules/org/index.ts';
import {
  bind as bindLegacy,
  listBindings,
  listManagerScopes,
  resolveGroup,
  resolvePerson,
  resolvePersonByUserid,
  setManagerScopes,
  upsertGroup,
  upsertPerson,
} from '../../modules/identity/index.ts';

export interface OrgSyncResult {
  ok: true;
  people: number;
  employeeGroups: number;
  departmentGroups: number;
  companyGroups: number;
  bossDmGroups: number;
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
  let departmentGroups = 0;
  let companyGroups = 0;
  let bossDmGroups = 0;
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
      mentionUserid: m.mention_userid,
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

  for (const dept of org.depts.values()) {
    if (!dept.chat_id) continue;
    upsertGroup(db, {
      chatId: dept.chat_id,
      type: 'department',
      deptId: dept.id,
      name: dept.name,
      webhookFile: dept.webhook_file,
    });
    departmentGroups++;
    if (!dept.webhook_file) warnings.push(`部门 ${dept.id} 有群但没 webhook_file：能收不能发`);
  }

  const companyChat = org.company.company_group_chat_id;
  if (companyChat) {
    upsertGroup(db, {
      chatId: companyChat,
      type: 'company',
      name: '公司大群',
      webhookFile: org.company.company_group_webhook_file,
    });
    companyGroups++;
    if (!org.company.company_group_webhook_file) warnings.push('公司大群有 chat_id 但没 webhook_file：能收不能发');
  }

  const bossChat = org.company.boss_dm_chat_id;
  if (bossChat) {
    upsertGroup(db, {
      chatId: bossChat,
      type: 'boss_dm',
      name: '老板1:1',
      webhookFile: org.company.boss_dm_webhook_file,
    });
    bossDmGroups++;
    if (!org.company.boss_dm_webhook_file) warnings.push('boss_dm 有 chat_id 但没 webhook_file：能收不能发');
  }

  return { ok: true, people, employeeGroups, departmentGroups, companyGroups, bossDmGroups, managers, legacyBindings, warnings };
}

export interface BackfillResult {
  ok: true;
  matchedPeople: number;
  groupsCreated: number;
  skipped: number;
  warnings: string[];
}

export interface OrgVerifyResult {
  ok: boolean;
  checked: number;
  problems: string[];
}

/**
 * 本地一致性校验：org 真相 vs people/groups/manager_scopes。
 * 不做企微 API 对账；只保证“渲染出来的 org”和“库里投影”没有漂移。
 */
export function verifyOrgIdentity(db: DatabaseSync, orgDir: string): OrgVerifyResult {
  const org = loadOrg(orgDir);
  const problems: string[] = [];
  let checked = 0;

  for (const m of org.members) {
    if (m.disabled) continue;
    checked++;
    const p = resolvePerson(db, m.id);
    if (!p) { problems.push(`缺 person: ${m.id}`); continue; }
    const role = org.boss === m.id ? 'boss' : (m.manages?.length ? 'manager' : 'employee');
    if (p.system_role !== role) problems.push(`${m.id} 角色不一致: org=${role} db=${p.system_role}`);
    if ((p.userid ?? null) !== (m.userid ?? null)) problems.push(`${m.id} userid 不一致: org=${m.userid ?? 'null'} db=${p.userid ?? 'null'}`);
    // mention_userid 是 webhook 真 @ 的唯一来源，漂移了不会报错、只会悄悄回到不 @，所以要显式对账
    if ((p.mention_userid ?? null) !== (m.mention_userid ?? null)) problems.push(`${m.id} mention_userid 不一致: org=${m.mention_userid ?? 'null'} db=${p.mention_userid ?? 'null'}`);
    if ((p.dept_id ?? null) !== (m.dept ?? null)) problems.push(`${m.id} 部门不一致: org=${m.dept ?? 'null'} db=${p.dept_id ?? 'null'}`);
    const scopes = [...listManagerScopes(db, m.id)].sort();
    const want = [...(m.manages ?? [])].sort();
    if (scopes.join(',') !== want.join(',')) problems.push(`${m.id} manager_scopes 不一致: org=[${want}] db=[${scopes}]`);

    if (m.chat_id) {
      const g = resolveGroup(db, m.chat_id);
      if (!g) problems.push(`缺员工群: ${m.chat_id} (${m.id})`);
      else if (g.type !== 'employee' || g.employee_id !== m.id) {
        problems.push(`员工群不一致: ${m.chat_id} org=${m.id} db=${g.type}/${g.employee_id ?? 'null'}`);
      }
    }
  }

  for (const d of org.depts.values()) {
    if (!d.chat_id) continue;
    checked++;
    const g = resolveGroup(db, d.chat_id);
    if (!g) problems.push(`缺部门群: ${d.chat_id} (${d.id})`);
    else if (g.type !== 'department' || g.dept_id !== d.id) {
      problems.push(`部门群不一致: ${d.chat_id} org=${d.id} db=${g.type}/${g.dept_id ?? 'null'}`);
    }
  }

  const companyChat = org.company.company_group_chat_id;
  if (companyChat) {
    checked++;
    const g = resolveGroup(db, companyChat);
    if (!g || g.type !== 'company') problems.push(`公司大群不一致: ${companyChat}`);
  }
  const bossChat = org.company.boss_dm_chat_id;
  if (bossChat) {
    checked++;
    const g = resolveGroup(db, bossChat);
    if (!g || g.type !== 'boss_dm') problems.push(`boss_dm 不一致: ${bossChat}`);
  }

  return { ok: problems.length === 0, checked, problems };
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
