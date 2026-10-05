// Dev helper: run JavaScript inside the app's WebView on a USB-connected phone.
//
//   adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof com.annan.asttube)
//   node dev/cdp.mjs "location.hash" "await wait(3000)" "document.title"
//
// Each argument is evaluated in order (await is allowed; wait(ms) is predefined).
// Console errors and uncaught exceptions seen meanwhile are printed at the end.

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:8765'));
if (!page) { console.error('AST Tube page not found. Is the app open and the port forwarded?'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
let id = 0;
const pending = new Map();
const problems = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === 'Runtime.exceptionThrown') problems.push(`exception: ${msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text}`);
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) problems.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') problems.push(`log: ${msg.params.entry.text} ${msg.params.entry.url || ''}`);
};
const send = (method, params = {}) => new Promise((ok) => { const i = ++id; pending.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Runtime.enable');
await send('Log.enable');
for (const expr of process.argv.slice(2)) {
  const r = await send('Runtime.evaluate', {
    // Statements (start with await/const/let/go(...;) run as a function body; anything else is an expression.
    expression: `(async () => { const wait = (ms) => new Promise((r) => setTimeout(r, ms)); ${/^(await |const |let |go\(|if |for )/.test(expr) ? expr : `return (${expr});`} })()`,
    awaitPromise: true, returnByValue: true,
  });
  const res = r.result;
  if (res?.exceptionDetails) console.log(`> ${expr}\n  !! ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
  else console.log(`> ${expr}\n  ${JSON.stringify(res?.result?.value)}`);
}
if (problems.length) console.log('\nProblems:\n  ' + problems.join('\n  '));
ws.close();
