import type { GroupType, SystemRole } from './groups.ts';

export type DataLevel = 'company' | 'department' | 'personal' | 'internal' | 'unknown';
export type PrivacyTarget = 'current' | 'employee' | 'boss_dm' | 'deny';

export interface PrivacyDecision {
  allowed: boolean;
  target: PrivacyTarget;
  reason?: string;
}

/**
 * 只决定“在哪说”和“能不能说”，不负责取 chat_id。
 * 公司级/部门级可在任何群；个人级只回本人员工群或老板 1:1；
 * 内部/老板级只回 boss_dm；不确定默认走私密。
 */
export function routeData(input: {
  level: DataLevel;
  groupType: GroupType;
  actorRole: SystemRole;
  /** 问的是不是自己的数据；个人级必须显式给 true 才允许 */
  isSelf?: boolean;
}): PrivacyDecision {
  const { level, groupType, actorRole, isSelf = false } = input;

  if (level === 'company') return { allowed: true, target: 'current' };
  if (level === 'department') return { allowed: true, target: 'current' };

  if (level === 'personal') {
    if (groupType === 'employee' && isSelf) return { allowed: true, target: 'current' };
    if (actorRole === 'boss') return { allowed: true, target: 'boss_dm' };
    if (isSelf) return { allowed: true, target: 'employee' };
    return { allowed: false, target: 'deny', reason: '没有权限查看他人的个人数据' };
  }

  if (level === 'internal') {
    if (actorRole === 'boss') return { allowed: true, target: 'boss_dm' };
    return { allowed: false, target: 'deny', reason: '内部级数据只有老板可见' };
  }

  // unknown：默认私密，不冒险在公司/部门群回答
  if (actorRole === 'boss') return { allowed: true, target: 'boss_dm' };
  if (groupType === 'employee') return { allowed: true, target: 'current' };
  return { allowed: true, target: 'employee' };
}
