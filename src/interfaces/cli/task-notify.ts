import type { DatabaseSync } from 'node:sqlite';
import { enqueue } from '../../modules/delivery/index.ts';
import {
  listManagersForDept,
  resolvePerson,
  resolvePrivateChat,
} from '../../modules/identity/index.ts';
import type { Task } from '../../modules/tasks/index.ts';

export type TaskNotifyEvent = 'requested' | 'approved' | 'accepted' | 'rejected';

export interface NotifyResult {
  sent: number;
  skipped: string[];
}

/**
 * 任务请求的通知链：只负责“把该通知谁、发到哪”落成 outbox。
 * 通知失败不阻断任务状态变更；返回 skipped 让 CLI 如实报告。
 */
export function notifyTaskEvent(db: DatabaseSync, task: Task, event: TaskNotifyEvent): NotifyResult {
  const skipped: string[] = [];
  let sent = 0;

  const send = (personId: string | null, text: string, key: string): void => {
    if (!personId) { skipped.push('no-person'); return; }
    const person = resolvePerson(db, personId);
    if (!person || person.status !== 'active') { skipped.push(`person:${personId}`); return; }
    const chatId = resolvePrivateChat(db, person.person_id, 'employee');
    if (!chatId) { skipped.push(`no-employee-group:${personId}`); return; }
    try {
      const q = enqueue(db, {
        text,
        chatId,
        dedupeKey: key,
        mentions: person.userid ? [person.userid] : [],
      });
      if (q.inserted) sent += 1;
      else skipped.push(`duplicate:${personId}`);
    } catch (e) {
      skipped.push(`blocked:${personId}:${(e as Error).message.slice(0, 80)}`);
    }
  };

  const title = `#${task.id} ${task.title}`;
  if (event === 'requested') {
    if (task.status === 'pending_approval') {
      const dept = task.dept_id ?? '';
      const managers = dept ? listManagersForDept(db, dept) : [];
      if (!managers.length) skipped.push(`no-manager:${dept || 'unknown'}`);
      for (const m of managers) {
        send(m.person_id, `${title}\n${task.requester ?? '同事'} 请求 ${task.assignee ?? '同事'}（部门 ${dept}）接手，需要你审批：回复「@公司bot 批准 #${task.id}」或「@公司bot 拒绝 #${task.id} 原因」。`, `task-request:${task.id}:manager:${m.person_id}`);
      }
    } else if (task.status === 'pending_acceptance') {
      send(task.assignee_id, `${title}\n${task.requester ?? '同事'} 请你接手，回复「@公司bot 接受 #${task.id}」或「@公司bot 拒绝 #${task.id} 原因」。`, `task-request:${task.id}:assignee`);
    }
  } else if (event === 'approved') {
    send(task.assignee_id, `${title}\n${task.requester ?? '同事'} 的请求已批准，等你接受：回复「@公司bot 接受 #${task.id}」。`, `task-approved:${task.id}:assignee`);
  } else if (event === 'accepted') {
    send(task.requester_id, `${title}\n${task.assignee ?? '同事'} 已接受。`, `task-accepted:${task.id}:requester`);
  } else if (event === 'rejected') {
    const reason = task.reject_reason ?? '未说明';
    send(task.requester_id, `${title}\n请求已拒绝：${reason}`, `task-rejected:${task.id}:requester`);
  }

  return { sent, skipped };
}
