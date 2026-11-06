import { readFileSync } from 'node:fs';
import * as a2a from '../../modules/knowledge/index.ts';
import type { CliContext } from './context.ts';

export default function a2aGroup(ctx: CliContext): void {
  const { db, args, cmd, out, fail } = ctx;
  if (cmd === 'create') {
    if (!args.survey) fail('缺少 --survey');
    if (!args['rule-version']) fail('缺少 --rule-version');
    const expected = typeof args.expected === 'string' ? args.expected.split(',').map((s) => s.trim()).filter(Boolean) : [];
    out({ ok: true, ...a2a.createSurvey(db, {
      surveyId: String(args.survey),
      ruleVersion: String(args['rule-version']),
      ruleFile: typeof args['rule-file'] === 'string' ? args['rule-file'] : undefined,
      expected,
      questionCount: typeof args.questions === 'string' && /^\d+$/.test(args.questions) ? Number(args.questions) : 0,
    }) });
  } else if (cmd === 'submit') {
    const text = typeof args.text === 'string'
      ? args.text
      : (typeof args['text-file'] === 'string' ? readFileSync(args['text-file'], 'utf8') : '');
    const internal = typeof args.internal === 'string' ? args.internal : '';
    if (!text) fail('缺少 --text 或 --text-file');
    if (!internal) fail('缺少 --internal <内部区目录>');
    // 越区防护：内部区必须是独立的 git 目录，且不能是共享区（传 --shared 时比对）
    try { a2a.assertInternalDir(internal, typeof args.shared === 'string' ? args.shared : undefined); }
    catch (e) { fail((e as Error).message); }
    const env = a2a.parseEnvelope(text);
    out({ ok: true, ...a2a.submit(db, env, internal, typeof args['from-userid'] === 'string' ? args['from-userid'] : undefined) });
  } else if (cmd === 'status') {
    const s = a2a.surveyStatus(db, String(args.survey ?? ''));
    if (!s) fail('没有这次调查: ' + String(args.survey ?? ''));
    out({ ok: true, ...s });
  } else if (cmd === 'list') {
    out({ ok: true, submissions: a2a.listSubmissions(db, String(args.survey ?? '')) });
  } else fail('未知 a2a 子命令（create/submit/status/list）');
}
