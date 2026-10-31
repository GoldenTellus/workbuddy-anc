// inject.cjs —— 连上 WorkBuddy 主进程的 inspector，在 app 代码执行前设置 NODE_OPTIONS、放行，然后关闭 inspector。
// 供 launch-patched.ps1 调用；需要 Node（WorkBuddy 自带或系统安装均可）。
// 用法: node inject.cjs --port 9229 --preload "<preload.cjs 绝对路径>"

const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const PORT = Number(arg('--port', '9229'));
const PRELOAD = arg('--preload', '');
const LOG = process.env.ANC_PATCH_LOG || path.join(process.env.USERPROFILE || '.', 'anc', 'workbuddy-patch.log');

function log(line) {
  try { fs.appendFileSync(LOG, new Date().toISOString() + ' [inject] ' + line + '\r\n'); } catch (_) {}
  console.log(line);
}

if (!PRELOAD || !fs.existsSync(PRELOAD)) {
  log('ERROR preload not found: ' + PRELOAD);
  process.exit(2);
}
// NODE_OPTIONS 不做引号解析：路径里只要有空白就会把模块名切坏，直接拒绝。
if (/\s/.test(PRELOAD)) {
  log('ERROR preload path contains whitespace: ' + PRELOAD);
  process.exit(2);
}

const esc = PRELOAD.replace(/\\/g, '\\\\');
const expr =
  "(function(){try{process.env.NODE_OPTIONS='--require " + esc + "';" +
  "globalThis.__ancCloseInspector=function(){try{process.mainModule.require('inspector').close();return 'closed';}catch(e){return 'close-err '+e.message;}};" +
  "return 'OK:'+process.pid;}catch(e){return 'ERR '+e.message;}})()";

async function main() {
  const deadline = Date.now() + 30000;
  let list = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      list = await r.json();
      if (Array.isArray(list) && list.length) break;
    } catch (_) { /* retry */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!list || !list.length) { log('ERROR inspector not reachable on ' + PORT); process.exit(3); }

  const ws = new WebSocket(list[0].webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m)));
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('timeout ' + method)); } }, 10000);
  });

  let frame = null; let onPause; const paused = new Promise((r) => { onPause = r; });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Debugger.paused') { frame = m.params.callFrames && m.params.callFrames[0]; onPause(); }
  });

  ws.addEventListener('open', async () => {
    try {
      await send('Runtime.enable', {});
      await send('Debugger.enable', {});
      await send('Runtime.runIfWaitingForDebugger', {});
      const got = await Promise.race([paused.then(() => 'pause'), new Promise((r) => setTimeout(() => r('nopause'), 8000))]);
      let v;
      if (got === 'pause' && frame) {
        const r = await send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression: expr, returnByValue: true });
        v = r.result && r.result.result;
        await send('Debugger.resume', {});
      } else {
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, includeCommandLineAPI: true });
        v = r.result && r.result.result;
      }
      log('env set: ' + JSON.stringify(v && (v.value !== undefined ? v.value : v.description)));
      // 放行后关闭 inspector，避免长期暴露调试端口
      try {
        const r2 = await send('Runtime.evaluate', { expression: 'globalThis.__ancCloseInspector && globalThis.__ancCloseInspector()', returnByValue: true });
        const v2 = r2.result && r2.result.result;
        log('inspector: ' + JSON.stringify(v2 && (v2.value !== undefined ? v2.value : v2.description)));
      } catch (e) {
        log('inspector close skipped: ' + e.message);
      }
    } catch (e) {
      log('ERROR inject failed: ' + e.message);
    }
    setTimeout(() => { try { ws.close(); } catch (_) {} process.exit(0); }, 500);
  });
  ws.addEventListener('error', () => { log('ERROR ws error'); process.exit(4); });
  setTimeout(() => { log('ERROR timeout'); process.exit(5); }, 45000);
}

main();
