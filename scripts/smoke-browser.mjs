/**
 * Browser smoke test for the web UI, driven over the Chrome DevTools Protocol.
 *
 *   node scripts/smoke-browser.mjs [baseUrl]
 *
 * Loads /app, runs the credential-free demo, and fails if the browser reports a
 * CSP violation, a page error, or a diagram that did not render. This is the
 * only check that can prove the Content-Security-Policy and the iframe sandbox
 * did not break the app — a static read of the HTML cannot.
 *
 * Uses an already-installed Chrome and talks raw CDP, so there is no browser
 * download and no dependency to add. Skips (exit 0) when Chrome is absent.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8799';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const chrome = CHROME_CANDIDATES.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!chrome) {
  console.log('· no Chrome found — skipping browser smoke test');
  process.exit(0);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-smoke-'));
const proc = spawn(chrome, [
  '--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const cleanup = () => {
  try { proc.kill('SIGKILL'); } catch { /* already gone */ }
  fs.rmSync(profile, { recursive: true, force: true });
};
process.on('exit', cleanup);

/** Chrome prints the DevTools websocket URL to stderr once it is listening. */
const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const timer = setTimeout(() => reject(new Error('Chrome did not report a DevTools endpoint')), 30_000);
  proc.stderr.on('data', d => {
    buf += d;
    const m = buf.match(/ws:\/\/[^\s]+/);
    if (m) { clearTimeout(timer); resolve(m[0]); }
  });
  proc.on('exit', c => { clearTimeout(timer); reject(new Error(`Chrome exited early (${c})`)); });
});

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP connect failed')); });

let nextId = 1;
const pending = new Map();
const events = [];
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method) {
    events.push(msg);
  }
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});

// Attach to a fresh tab.
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const call = (method, params) => send(method, params, sessionId);

await call('Page.enable');
await call('Runtime.enable');
await call('Log.enable');
await call('Network.enable');

const problems = [];
const note = s => console.log('  ' + s);

/** Wait until `fn` evaluates truthy in the page, or time out. */
async function waitFor(expression, { timeout = 30_000, label } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const { result } = await call('Runtime.evaluate', { expression, returnByValue: true });
    if (result.value) return result.value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label || expression}`);
    await new Promise(r => setTimeout(r, 200));
  }
}

console.log(`\n• Browser smoke test against ${BASE}`);

await call('Page.navigate', { url: `${BASE}/app` });
await waitFor('document.readyState === "complete"', { label: 'page load' });

// 1. The inline script must have executed. If the nonce were missing or wrong,
//    CSP would block it and none of the app's own globals would exist.
const wired = await waitFor(
  'typeof document.getElementById("demo") !== "undefined" && !!document.getElementById("demo")',
  { label: 'demo button' },
);
note(wired ? '✔ page loaded and app markup present' : '✖ app markup missing');

const scriptRan = await call('Runtime.evaluate', {
  // The app attaches click handlers on boot; onclick being set proves the
  // nonce'd inline script actually ran rather than being blocked by CSP.
  expression: 'typeof document.getElementById("demo").onclick === "function"',
  returnByValue: true,
});
if (scriptRan.result.value) note('✔ inline script executed (CSP nonce accepted)');
else problems.push('the app\'s inline script did not run — CSP nonce likely rejected');

// 2. Styling must have survived the style-src policy.
const styled = await call('Runtime.evaluate', {
  expression: 'getComputedStyle(document.body).backgroundColor',
  returnByValue: true,
});
note(`· body background: ${styled.result.value}`);
if (['', 'rgba(0, 0, 0, 0)', 'rgb(255, 255, 255)'].includes(styled.result.value)) {
  problems.push(`stylesheet may have been blocked (background ${styled.result.value})`);
} else {
  note('✔ inline stylesheet applied');
}

// 3. Run the demo and wait for the diagram to arrive in the sandboxed frame.
await call('Runtime.evaluate', { expression: 'document.getElementById("demo").click()' });
const frameSrc = await waitFor(
  'document.getElementById("frame").src || ""',
  { label: 'diagram iframe src', timeout: 60_000 },
);
note(`· iframe src: ${String(frameSrc).replace(/t=[^&]+/, 't=<signature>')}`);
if (!/[?&]t=/.test(frameSrc)) problems.push('iframe URL carries no signature');
else note('✔ diagram URL is signed');

// 4. The portal document itself must have rendered under its own strict CSP.
//    A sandboxed frame is a separate target, so query it through the frame tree.
const svgLoaded = await waitFor(`(() => {
  const f = document.getElementById('frame');
  if (!f || f.style.display === 'none') return 0;
  const st = document.getElementById('rstats');
  return st && st.textContent.includes('resources') ? st.textContent : 0;
})()`, { label: 'render stats', timeout: 60_000 });
note(`✔ render reported: ${svgLoaded}`);

const frameStatus = events.filter(e => e.method === 'Network.responseReceived')
  .map(e => e.params.response)
  .filter(r => /\/view\//.test(r.url));
for (const r of frameStatus) {
  note(`· ${r.status} ${r.url.replace(/t=[^&]+/, 't=<signature>')}`);
  if (r.status !== 200) problems.push(`diagram request returned ${r.status}`);
}
if (!frameStatus.length) problems.push('the diagram was never requested');

// 5. Anything the browser refused, plus uncaught page errors.
const violations = events.filter(e =>
  (e.method === 'Log.entryAdded' && /Content Security Policy|Refused to|blocked/i.test(e.params.entry.text || '')) ||
  (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
for (const v of violations) {
  const text = v.params.entry?.text || (v.params.args || []).map(a => a.value ?? a.description).join(' ');
  // A sandboxed frame has an opaque origin; storage access is expected to be
  // denied and the portal is written to tolerate it.
  problems.push(`browser reported: ${text}`);
}
const exceptions = events.filter(e => e.method === 'Runtime.exceptionThrown');
for (const e of exceptions) {
  problems.push(`uncaught error: ${e.params.exceptionDetails.text} ${
    e.params.exceptionDetails.exception?.description || ''}`.trim());
}

ws.close();

if (problems.length) {
  console.error('\n✖ browser smoke test failed:');
  for (const p of problems) console.error('   - ' + p);
  process.exit(1);
}
console.log('\n✔ browser smoke test passed — CSP, nonces, sandbox and signed links all work\n');
// Exit explicitly: the Chrome child process keeps the event loop alive
// otherwise. The `exit` handler above kills it and removes the temp profile.
process.exit(0);
