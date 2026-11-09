import type { DatabaseSync } from 'node:sqlite';
import { listManagerScopes, type Group, type Person } from './groups.ts';

export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

export interface TaskScope {
  requesterId?: string | null;
  assigneeId?: string | null;
  deptId?: string | null;
}

export interface AttentionScope {
  requiredConfirmerId?: string | null;
  deptId?: string | null;
}

export function isBoss(person: Person): boolean {
  return person.system_role === 'boss';
}

export function isManager(db: DatabaseSync, person: Person): boolean {
  return person.system_role === 'manager' || listManagerScopes(db, person.person_id).length > 0;
}

export function priorityFor(person: Person): Priority {
  if (person.system_role === 'boss') return 'P0';
  if (person.system_role === 'manager') return 'P1';
  return 'P2';
}

export function canManageDept(db: DatabaseSync, person: Person, deptId: string): boolean {
  if (person.system_role === 'boss') return true;
  if (person.system_role !== 'manager') return false;
  return listManagerScopes(db, person.person_id).includes(deptId);
}

/** 老板可派给任何人；管理者只能派给本部门；员工只能派给自己。 */
export function canAssignTo(db: DatabaseSync, actor: Person, target: Person): boolean {
  if (isBoss(actor)) return true;
  if (actor.person_id === target.person_id) return true;
  if (actor.system_role !== 'manager') return false;
  if (!target.dept_id) return false;
  return canManageDept(db, actor, target.dept_id);
}

/** 跨部门请求的审批人：老板，或目标人所在部门的管理者。 */
export function canApproveCrossDept(db: DatabaseSync, actor: Person, target: Person): boolean {
  if (isBoss(actor)) return true;
  if (actor.system_role !== 'manager') return false;
  if (!target.dept_id) return false;
  return canManageDept(db, actor, target.dept_id);
}

export function canViewTask(db: DatabaseSync, actor: Person, task: TaskScope): boolean {
  if (isBoss(actor)) return true;
  if (actor.person_id === task.requesterId || actor.person_id === task.assigneeId) return true;
  if (actor.system_role !== 'manager' || !task.deptId) return false;
  return canManageDept(db, actor, task.deptId);
}

/** 确认只认 required_confirmer 或老板；部门管理者可见/催办，但不代确认（D40）。 */
export function canConfirmAttention(actor: Person, attention: AttentionScope): boolean {
  if (isBoss(actor)) return true;
  return attention.requiredConfirmerId === actor.person_id;
}

export function canStopTask(db: DatabaseSync, actor: Person, task: TaskScope): boolean {
  if (isBoss(actor)) return true;
  if (actor.person_id === task.requesterId || actor.person_id === task.assigneeId) return true;
  if (actor.system_role !== 'manager' || !task.deptId) return false;
  return canManageDept(db, actor, task.deptId);
}

/** 群类型只影响“在哪说话”，不改变角色权限；保留给路由层使用。 */
export function isPrivateGroup(group: Group): boolean {
  return group.type === 'employee' || group.type === 'boss_dm';
}
