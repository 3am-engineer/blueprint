/**
 * HTTP-level tests for the web UI. These exercise the hardening that has no
 * other safety net: exposure refusal, access gating, signed diagram links,
 * headers and input validation.
 *
 * Nothing here touches AWS. Endpoints that need credentials are checked for
 * their reject paths only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, checkExposure, isRegionName } from '../src/server.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = 'test-access-code-long-enough';

/** Servers started per suite, torn down in `after`. */
const started = [];

/** Start a server on an ephemeral port and wait until it is actually listening. */
function launch(env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  let server;
  try {
    server = startServer({
      port: 0, host: '127.0.0.1', iconsDir: null, projectRoot, quiet: true,
    });
    started.push(server);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return new Promise((resolve, reject) => {
    if (server.listening) return resolve(server);
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

const urlFor = server => `http://127.0.0.1:${server.address().port}`;

let open, gatedServer;
before(async () => {
  // Raise the limits so the suite's own traffic does not trip them; the limiter
  // itself is exercised deliberately further down.
  const roomy = { SCAN_RATE_LIMIT: '500', API_RATE_LIMIT: '5000' };
  open = await launch({ ...roomy, ACCESS_CODE: undefined, VIEW_SECRET: 'fixed-secret-for-tests' });
  gatedServer = await launch({ ...roomy, ACCESS_CODE: CODE, VIEW_SECRET: 'fixed-secret-for-tests' });
});
after(() => { for (const s of started) s.close(); });

/* ---------------------------------------------------------- exposure ------ */

test('refuses to bind a public address without an access code', () => {
  const problems = checkExposure({ bind: '0.0.0.0', accessCode: '', allowInsecure: false });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /ACCESS_CODE/);
});

test('rejects a short access code on a public bind', () => {
  const problems = checkExposure({ bind: '0.0.0.0', accessCode: 'invite', allowInsecure: false });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /at least 16/);
});

test('loopback binds need no access code', () => {
  for (const bind of ['127.0.0.1', '::1']) {
    assert.deepEqual(checkExposure({ bind, accessCode: '', allowInsecure: false }), []);
  }
});

test('a long access code makes a public bind acceptable', () => {
  assert.deepEqual(
    checkExposure({ bind: '0.0.0.0', accessCode: CODE, allowInsecure: false }), [],
  );
});

test('the insecure override is honoured but only when explicit', () => {
  assert.deepEqual(
    checkExposure({ bind: '0.0.0.0', accessCode: '', allowInsecure: true }), [],
  );
});

test('startServer throws rather than listening when exposure is unsafe', () => {
  const saved = process.env.ACCESS_CODE;
  delete process.env.ACCESS_CODE;
  try {
    assert.throws(
      () => startServer({ port: 0, host: '0.0.0.0', iconsDir: null, projectRoot, quiet: true }),
      /unsafe server configuration/,
    );
  } finally {
    if (saved === undefined) delete process.env.ACCESS_CODE; else process.env.ACCESS_CODE = saved;
  }
});

/* ------------------------------------------------------------ gating ------ */

test('every credential endpoint rejects a missing access code', async () => {
  for (const ep of ['/api/scan', '/api/vpcs', '/api/validate', '/api/demo']) {
    const r = await fetch(urlFor(gatedServer) + ep, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(r.status, 401, `${ep} should be gated`);
  }
});

test('the demo is gated too — it runs a full layout', async () => {
  const r = await fetch(urlFor(gatedServer) + '/api/demo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-code': 'wrong-but-long-enough' },
    body: '{}',
  });
  assert.equal(r.status, 401);
});

test('a correct access code gets through the gate', async () => {
  const r = await fetch(urlFor(gatedServer) + '/api/demo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-code': CODE },
    body: '{}',
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.id && body.token, 'returns a diagram id and its signature');
});

test('/api/config advertises whether a code is needed', async () => {
  assert.equal((await (await fetch(urlFor(open) + '/api/config')).json()).requiresCode, false);
  assert.equal((await (await fetch(urlFor(gatedServer) + '/api/config')).json()).requiresCode, true);
});

/* ------------------------------------------------- signed view links ------ */

test('diagram links require a valid signature', async () => {
  const made = await (await fetch(urlFor(open) + '/api/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })).json();

  const base = urlFor(open) + '/view/' + made.id;
  assert.equal((await fetch(base)).status, 404, 'bare id is not enough');
  assert.equal((await fetch(base + '?t=')).status, 404, 'empty token rejected');
  assert.equal((await fetch(base + '?t=forged')).status, 404, 'forged token rejected');
  assert.equal((await fetch(base + '?t=' + made.token)).status, 200, 'signed link works');
  assert.equal((await fetch(base + '.svg?t=' + made.token)).status, 200, 'signed SVG works');
  assert.equal((await fetch(base + '.svg')).status, 404, 'unsigned SVG rejected');
});

test('a signature from one diagram does not open another', async () => {
  const post = () => fetch(urlFor(open) + '/api/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }).then(r => r.json());
  const [a, b] = [await post(), await post()];
  assert.notEqual(a.id, b.id);
  const r = await fetch(`${urlFor(open)}/view/${a.id}?t=${b.token}`);
  assert.equal(r.status, 404);
});

test('an unknown id is refused without disclosing whether it ever existed', async () => {
  const r = await fetch(urlFor(open) + '/view/00000000-0000-4000-8000-000000000000?t=x');
  assert.equal(r.status, 404);
  assert.match(await r.text(), /Expired, unknown, or unauthorized/);
});

/* ----------------------------------------------------------- headers ------ */

test('the credential page sets a nonce CSP with no unsafe-inline', async () => {
  const r = await fetch(urlFor(open) + '/app');
  assert.equal(r.status, 200);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src [^;]*'nonce-/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'no unsafe-inline for scripts');
  assert.match(csp, /frame-ancestors 'none'/, 'not embeddable — blocks clickjacking');
  assert.match(csp, /default-src 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');

  const html = await r.text();
  const nonce = csp.match(/'nonce-([^']+)'/)[1];
  assert.ok(html.includes(`<script nonce="${nonce}">`), 'inline script carries the nonce');
  assert.ok(html.includes(`<style nonce="${nonce}">`), 'inline style carries the nonce');
});

test('each page load gets a fresh nonce', async () => {
  const csp = async () => (await fetch(urlFor(open) + '/app'))
    .headers.get('content-security-policy').match(/'nonce-([^']+)'/)[1];
  assert.notEqual(await csp(), await csp());
});

test('the rendered portal is locked down against exfiltration', async () => {
  const made = await (await fetch(urlFor(open) + '/api/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })).json();
  const r = await fetch(`${urlFor(open)}/view/${made.id}?t=${made.token}`);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /connect-src 'none'/, 'injected script cannot call home');
  assert.match(csp, /img-src data:/, 'no beacon via remote images');
  assert.ok(!/img-src[^;]*https?:/.test(csp));
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
});

test('the served pages carry no inline style attributes', async () => {
  // A nonce authorises a <style> element but can never authorise a style="…"
  // attribute, so one slipping back in would be silently blocked by CSP and
  // subtly break the layout. Keep rules in the nonce'd <style> block.
  for (const page of ['/', '/app']) {
    const html = await (await fetch(urlFor(open) + page)).text();
    const offenders = (html.match(/<[^>!]*\sstyle\s*=\s*"[^"]*"[^>]*>/g) || [])
      .map(t => t.slice(0, 80));
    assert.deepEqual(offenders, [], `${page} has inline style attributes`);
  }
});

test('the iframe holding the portal is sandboxed without same-origin', async () => {
  const html = await (await fetch(urlFor(open) + '/app')).text();
  const tag = html.match(/<iframe id="frame"[\s\S]*?>/)[0];
  assert.match(tag, /sandbox="[^"]*allow-scripts/);
  assert.ok(!/allow-same-origin/.test(tag), 'portal must not reach the credential fields');
});

/* -------------------------------------------------------- validation ------ */

const postScan = (server, body) => fetch(urlFor(server) + '/api/scan', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('credentials are required before anything else happens', async () => {
  const r = await postScan(open, { scope: 'account' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /accessKeyId/);
});

const creds = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' };

test('a non-region string is rejected before it reaches the SDK', async () => {
  // "all" used to slip through and surface as a DNS failure for
  // tagging.all.amazonaws.com.
  for (const region of ['all', 'us_east_1', '../etc', 'us-east']) {
    const r = await postScan(open, { credentials: creds, scope: 'account', regions: [region] });
    assert.equal(r.status, 400, `${region} should be rejected`);
    assert.match((await r.json()).error, /not a valid region/);
  }
});

test('the region validator accepts real names and rejects the rest', () => {
  for (const ok of ['us-east-1', 'ap-southeast-3', 'eu-central-2', 'us-gov-west-1',
    'ca-central-1', 'ap-northeast-1', 'il-central-1']) {
    assert.ok(isRegionName(ok), `${ok} should be accepted`);
  }
  for (const bad of ['all', 'us_east_1', '../etc', 'us-east', 'US-EAST-1', '',
    null, undefined, 'us-east-1;rm -rf /', 'tagging.all.amazonaws.com']) {
    assert.ok(!isRegionName(bad), `${bad} should be rejected`);
  }
});

test('a malformed assume-role ARN is rejected', async () => {
  const r = await postScan(open, {
    credentials: creds, scope: 'account', regions: ['us-east-1'],
    roleArn: 'not-a-role',
  });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /roleArn/);
});

test('a malformed VPC id is rejected', async () => {
  const r = await postScan(open, {
    credentials: creds, scope: 'vpc', regions: ['us-east-1'], vpcId: 'not-a-vpc',
  });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Malformed VPC id/);
});

test('an unknown scope is rejected', async () => {
  const r = await postScan(open, { credentials: creds, scope: 'everything' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Unknown scope/);
});

test('a tag scan without a tag key is rejected', async () => {
  const r = await postScan(open, { credentials: creds, scope: 'tag' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /tagKey is required/);
});

test('oversized JSON bodies are refused with a JSON error, not a stack trace', async () => {
  const r = await fetch(urlFor(open) + '/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credentials: creds, scope: 'tag', tagKey: 'x'.repeat(2 * 1024 * 1024) }),
  });
  assert.equal(r.status, 413);
  assert.match(r.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await r.json(), { error: 'Request body too large' });
});

test('malformed JSON is refused without leaking parser internals', async () => {
  const r = await fetch(urlFor(open) + '/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'Malformed request body' });
});

/* -------------------------------------------------------- rate limits ----- */

test('the scan budget is charged for real work, not for rejected bodies', async () => {
  const tight = await launch({
    ACCESS_CODE: undefined, SCAN_RATE_LIMIT: '2', API_RATE_LIMIT: '5000',
  });

  // Malformed requests are refused on validation and must not consume the
  // (deliberately expensive) scan allowance.
  for (let i = 0; i < 5; i++) {
    const r = await postScan(tight, { credentials: creds, scope: 'nonsense' });
    assert.equal(r.status, 400, 'still a validation error, not a 429');
  }

  const demo = () => fetch(urlFor(tight) + '/api/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal((await demo()).status, 200);
  assert.equal((await demo()).status, 200);
  const third = await demo();
  assert.equal(third.status, 429, 'third render exceeds the budget of 2');
  assert.match((await third.json()).error, /max 2 scans/);
});

test('repeated wrong access codes are throttled', async () => {
  const tight = await launch({
    ACCESS_CODE: CODE, AUTH_FAIL_LIMIT: '3', API_RATE_LIMIT: '5000',
  });
  const guess = () => fetch(urlFor(tight) + '/api/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-code': 'wrong' },
    body: '{}',
  });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await guess()).status);
  assert.deepEqual(codes.slice(0, 3), [401, 401, 401]);
  assert.deepEqual(codes.slice(3), [429, 429], 'brute force is cut off');

  // The correct code still works — throttling keys off failures only.
  const ok = await fetch(urlFor(tight) + '/api/demo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-code': CODE },
    body: '{}',
  });
  assert.equal(ok.status, 200);
});

/* ------------------------------------------------------------- misc ------- */

test('healthz answers without authentication', async () => {
  const r = await fetch(urlFor(gatedServer) + '/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('the server does not advertise Express', async () => {
  const r = await fetch(urlFor(open) + '/healthz');
  assert.equal(r.headers.get('x-powered-by'), null);
});
