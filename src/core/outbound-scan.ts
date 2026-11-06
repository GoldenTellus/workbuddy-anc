// 出站凭据扫描（FORK §5.5 / §8）：发送前做确定性扫描，命中即替换后重扫；扫描器异常则不发。
// 只做「能不能发」的判断，不负责加密或脱敏存储。

export interface ScanResult {
  clean: boolean;
  text: string;
  hits: string[];
}

const RULES: Array<{ name: string; re: RegExp }> = [
  { name: 'wecom-webhook', re: /https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[A-Za-z0-9-]+/g },
  { name: 'app-secret', re: /\b(app_secret|corpsecret)\b\s*[:=]\s*["']?[A-Za-z0-9_-]{6,}/gi },
  { name: 'api-key', re: /\b(api[_-]?key|access[_-]?key)\b\s*[:=]\s*["']?[A-Za-z0-9_-]{6,}/gi },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]{10,}/gi },
  { name: 'cookie', re: /\b(cookie|set-cookie)\s*[:=]\s*[^\s]{8,}/gi },
  { name: 'private-key', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'conn-string', re: /\b(?:mongodb|mysql|postgres|redis|amqp):\/\/[^\s:@]+:[^\s@]+@/gi },
  { name: 'openai-style', re: /\bsk-[A-Za-z0-9]{16,}\b/g },
  { name: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'feishu-token', re: /\b(?:cli|ou)_[a-z0-9]{12,}\b/g },
];

export function scanOutbound(input: string): ScanResult {
  let text = String(input ?? '');
  const hits: string[] = [];
  for (const rule of RULES) {
    if (rule.re.test(text)) {
      hits.push(rule.name);
      text = text.replace(rule.re, '[REDACTED]');
    }
    rule.re.lastIndex = 0;
  }
  // 重扫：替换后仍有命中，说明规则互相覆盖或替换失败，直接判不安全
  for (const rule of RULES) {
    if (rule.re.test(text)) {
      hits.push(rule.name + ':residual');
    }
    rule.re.lastIndex = 0;
  }
  return { clean: hits.length === 0, text, hits };
}

export function assertSafeOutbound(input: string): string {
  const r = scanOutbound(input);
  if (!r.clean) {
    const err = new Error('出站内容命中凭据规则: ' + Array.from(new Set(r.hits)).join(','));
    (err as Error & { code?: string }).code = 'OUTBOUND_SECRET_BLOCKED';
    throw err;
  }
  return r.text;
}
