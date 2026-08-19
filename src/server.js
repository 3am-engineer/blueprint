/**
 * Web UI server — `blueprint serve [--port 8787]`.
 *
 * Endpoints:
 *   GET  /healthz            liveness probe (no auth)
 *   POST /api/validate       { credentials, region? }         -> { accountId, arn }
 *   POST /api/vpcs           { credentials, region }          -> { vpcs: [...] }
 *   POST /api/scan           { credentials, scope, ... }      -> { id, token, stats }
 *   POST /api/demo           {}                               -> { id, token, stats }
 *   GET  /view/:id?t=…       rendered portal (self-contained HTML)
 *   GET  /view/:id.svg?t=…   standalone SVG
 *
 * Credential handling: credentials arrive in the request body, are passed to
 * the AWS SDK for that request only, and are never persisted or logged.
 * Results (rendered HTML/SVG, no credentials) are kept in memory with a TTL.
 *
 * Exposure model: binding anywhere other than loopback requires ACCESS_CODE and
 * HTTPS, because every scan carries live AWS keys in the request body. See
 * SECURITY.md.
 */
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanAws, listVpcs, whoAmI } from './scan.js';
import { buildGraph } from './graph.js';
import { renderPortal } from './render.js';
import { loadIconIndex } from './icons.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULT_TTL_MS = 2 * 60 * 60 * 1000;   // 2h
const MAX_RESULTS = 200;

const MIN_CODE_LENGTH = 16;

/** Read a positive number from the environment, falling back to a default.
 *  Read per server instance rather than at import time so embedders and tests
 *  can configure a server without reloading the module. */
const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** AWS region names: two-letter area, one or more segments, trailing digit
 *  (us-east-1, ap-southeast-3, us-gov-west-1, eu-central-2). Checked before the
 *  value reaches the SDK, where a bad name becomes an opaque DNS failure. */
export const isRegionName = s => /^[a-z]{2}(-[a-z]+)+-\d$/.test(String(s || ''));

/** Loopback addresses, including IPv4-mapped IPv6 forms Node reports. */
const isLoopback = ip => !!ip && (
  ip === '::1' || ip === '127.0.0.1' ||
  ip.startsWith('127.') || ip.startsWith('::ffff:127.')
);

/** Compare secrets without leaking length or position through timing. */
function secretsMatch(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** True when the request reached us over TLS, directly or via a trusted proxy. */
function isSecureRequest(req) {
  if (req.secure) return true;
  const proto = req.get('x-forwarded-proto');
  return !!proto && proto.split(',')[0].trim().toLowerCase() === 'https';
}

/**
 * Reject a public deployment that cannot protect credentials in transit.
 * Returns a list of fatal problems; empty means safe to start.
 */
export function checkExposure({ bind, accessCode, allowInsecure }) {
  const problems = [];
  if (isLoopback(bind) || allowInsecure) return problems;
  if (!accessCode) {
    problems.push(
      'Refusing to bind ' + bind + ' without ACCESS_CODE.\n' +
      '    Every scan posts live AWS credentials to this server, so an open\n' +
      '    listener is a credential-harvesting endpoint. Set ACCESS_CODE to a\n' +
      '    long random string, or set BLUEPRINT_ALLOW_INSECURE=1 if this port is\n' +
      '    genuinely unreachable from untrusted networks.',
    );
  } else if (accessCode.length < MIN_CODE_LENGTH) {
    problems.push(
      `ACCESS_CODE is ${accessCode.length} characters; use at least ${MIN_CODE_LENGTH}.\n` +
      '    Short codes are guessable. Try: openssl rand -base64 24',
    );
  }
  return problems;
}

/** @param {{port:number, host?:string, iconsDir:string, projectRoot:string, quiet?:boolean}} opts
 *  @returns {import('node:http').Server} */
export function startServer({ port, host, iconsDir, projectRoot, quiet }) {
  const bind = host || '127.0.0.1';
  const accessCode = process.env.ACCESS_CODE || '';
  const allowInsecure = process.env.BLUEPRINT_ALLOW_INSECURE === '1';
  const localOnly = isLoopback(bind);

  const SCAN_LIMIT = num('SCAN_RATE_LIMIT', 12);        // scans per window per IP
  const API_LIMIT = num('API_RATE_LIMIT', 120);         // any API call per window per IP
  const AUTH_FAIL_LIMIT = num('AUTH_FAIL_LIMIT', 10);   // wrong codes per window per IP
  const WINDOW_MS = num('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000);
  const SCAN_TIMEOUT_MS = num('SCAN_TIMEOUT_MS', 5 * 60 * 1000);

  const problems = checkExposure({ bind, accessCode, allowInsecure });
  if (problems.length) {
    for (const p of problems) console.error(`\n✖ ${p}\n`);
    throw Object.assign(new Error('unsafe server configuration'), { exitCode: 2 });
  }

  const app = express();
  app.disable('x-powered-by');

  // Rate limiting and the HTTPS check both key off the client IP, so Express
  // must be told how far to trust X-Forwarded-For. Default: trust nothing,
  // which is correct for a direct listener and fails closed behind a proxy.
  if (process.env.TRUST_PROXY) {
    const v = process.env.TRUST_PROXY;
    app.set('trust proxy', /^\d+$/.test(v) ? Number(v) : v);
  }

  /** Signing key for /view links. Set VIEW_SECRET to keep links valid across
   *  restarts or to run more than one instance behind a load balancer. */
  const viewSecret = process.env.VIEW_SECRET ||
    crypto.randomBytes(32).toString('hex');
  const signView = id => crypto.createHmac('sha256', viewSecret)
    .update(id).digest('base64url');
  const viewTokenOk = (id, token) =>
    typeof token === 'string' && token.length > 0 && secretsMatch(token, signView(id));

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'X-Frame-Options': 'SAMEORIGIN',
    });
    if (!localOnly) {
      res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  // Credentials must never cross an untrusted network in the clear. Loopback is
  // exempt (nothing to intercept) and so is an explicit operator override.
  app.use('/api', (req, res, next) => {
    if (allowInsecure || isSecureRequest(req) || isLoopback(req.ip)) return next();
    res.status(403).json({
      error: 'This server is reachable over plain HTTP. Refusing to accept AWS ' +
        'credentials that would travel unencrypted — put it behind HTTPS.',
    });
  });

  app.use(express.json({ limit: '1mb' }));

  /**
   * Serve one of our own HTML pages under a nonce-based CSP, so the page that
   * handles AWS keys needs neither 'unsafe-inline' nor 'unsafe-eval'.
   *
   * This requires both pages to keep every rule in their single inline <style>
   * block: a nonce authorises <style> elements but can never authorise a
   * `style="…"` attribute, so adding one back would be silently blocked. The
   * utility classes in public/*.html exist for that reason, and
   * scripts/smoke-browser.mjs fails the build if a violation reappears.
   */
  const pageCache = new Map();
  const sendPage = (file, res) => {
    let body = pageCache.get(file);
    if (body === undefined) {
      body = fs.readFileSync(path.join(projectRoot, 'public', file), 'utf8');
      pageCache.set(file, body);
    }
    const nonce = crypto.randomBytes(16).toString('base64');
    res.set('Content-Security-Policy', [
      "default-src 'none'",
      `script-src 'self' 'nonce-${nonce}'`,
      // Google Fonts ships the face declarations as an external stylesheet.
      `style-src 'self' 'nonce-${nonce}' https://fonts.googleapis.com`,
      'font-src https://fonts.gstatic.com data:',
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '));
    res.type('html').send(body.replace(/<(script|style)>/g, `<$1 nonce="${nonce}">`));
  };

  app.get(['/', '/index.html'], (_req, res) => sendPage('index.html', res));
  app.get(['/app', '/app.html'], (_req, res) => sendPage('app.html', res));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use(express.static(path.join(projectRoot, 'public'), { index: false }));

  app.get('/api/config', (_req, res) => res.json({ requiresCode: !!accessCode }));

  // Per-IP fixed-window counters. Deliberately in-process: one instance, one
  // operator. A multi-instance deployment should rate limit at the proxy.
  const buckets = new Map();
  setInterval(() => {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [key, times] of buckets) {
      const live = times.filter(t => t > cutoff);
      if (live.length) buckets.set(key, live); else buckets.delete(key);
    }
  }, WINDOW_MS).unref();

  const takeToken = (key, limit) => {
    const now = Date.now();
    const times = (buckets.get(key) || []).filter(t => now - t < WINDOW_MS);
    if (times.length >= limit) return false;
    times.push(now);
    buckets.set(key, times);
    return true;
  };
  const limit = (name, max, message) => (req, res, next) => {
    if (takeToken(`${name}:${req.ip || 'unknown'}`, max)) return next();
    res.status(429).json({ error: message });
  };

  // Every credential-touching endpoint is gated, including the demo, which runs
  // a full layout and is therefore worth CPU-exhausting.
  const gated = (req, res, next) => {
    if (!accessCode) return next();
    if (secretsMatch(req.get('x-access-code') || '', accessCode)) return next();
    if (!takeToken(`auth:${req.ip || 'unknown'}`, AUTH_FAIL_LIMIT)) {
      return res.status(429).json({ error: 'Too many failed access codes' });
    }
    res.status(401).json({ error: 'Invalid or missing access code' });
  };

  app.use('/api', limit('api', API_LIMIT, `Rate limit: max ${API_LIMIT} requests per 15 minutes`));
  app.use(['/api/scan', '/api/vpcs', '/api/validate', '/api/demo'], gated);

  /**
   * Charge the strict scan budget. Called only once a request is about to do
   * real work, so a flood of malformed bodies cannot exhaust the allowance for
   * legitimate scans — those are held back by the coarse /api limit instead.
   * @returns {boolean} false when the caller should stop (response already sent)
   */
  const chargeScan = (req, res) => {
    if (takeToken(`scan:${req.ip || 'unknown'}`, SCAN_LIMIT)) return true;
    res.status(429).json({ error: `Rate limit: max ${SCAN_LIMIT} scans per 15 minutes` });
    return false;
  };

  if (!quiet) console.error('• Indexing AWS architecture icons');
  const icons = loadIconIndex(iconsDir);

  /** id -> { html, svg, ts } — rendered output only, never credentials. */
  const results = new Map();
  setInterval(() => {
    const cutoff = Date.now() - RESULT_TTL_MS;
    for (const [id, r] of results) if (r.ts < cutoff) results.delete(id);
  }, 10 * 60 * 1000).unref();

  const bad = (res, code, message) => res.status(code).json({ error: message });

  /** Normalize + validate the credential/scope payload into scan args. */
  function toArgs(body) {
    const c = body.credentials || {};
    if (!c.accessKeyId || !c.secretAccessKey) {
      throw Object.assign(new Error('accessKeyId and secretAccessKey are required'), { status: 400 });
    }
    const args = {
      credentials: {
        accessKeyId: String(c.accessKeyId).trim(),
        secretAccessKey: String(c.secretAccessKey).trim(),
        sessionToken: c.sessionToken ? String(c.sessionToken).trim() : undefined,
      },
    };
    const regions = (Array.isArray(body.regions) ? body.regions : String(body.regions || '').split(','))
      .map(s => String(s).trim()).filter(Boolean);
    const bogus = regions.find(r => !isRegionName(r));
    if (bogus) {
      throw Object.assign(new Error(`"${bogus}" is not a valid region name`), { status: 400 });
    }
    if (regions.length) args.region = regions;
    if (body.allRegions) args.allRegions = true;
    if (body.roleArn) {
      const role = String(body.roleArn).trim();
      if (!/^arn:aws(-[a-z]+)*:iam::\d{12}:role\//.test(role)) {
        throw Object.assign(new Error('roleArn must be an IAM role ARN'), { status: 400 });
      }
      args.roleArn = role;
      if (body.externalId) args.externalId = String(body.externalId).trim().slice(0, 256);
    }
    return args;
  }

  function storeResult(html, svg) {
    if (results.size >= MAX_RESULTS) {
      const oldest = [...results.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) results.delete(oldest[0]);
    }
    const id = crypto.randomUUID();
    results.set(id, { html, svg, ts: Date.now() });
    return id;
  }

  async function renderScan(scan, opts = {}) {
    const graph = buildGraph(scan, icons, {
      showAll: !!opts.showAll,
      groupBy: opts.groupBy === 'type' ? 'type' : 'network',
    });
    const { html, svg } = await renderPortal(graph, scan, { title: opts.title });
    const id = storeResult(html, svg);
    return {
      id, token: signView(id), stats: graph.stats, accountId: scan.meta.accountId,
      meta: {
        regions: scan.meta.regions || [],
        tagKey: scan.meta.tagKey || null,
        tagValue: scan.meta.tagValue || null,
        scope: scan.meta.scope || null,
      },
    };
  }

  /** Bound a slow scan so one request cannot hold a worker indefinitely. */
  function withDeadline(promise, ms, label) {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error(`${label} exceeded ${Math.round(ms / 1000)}s`), { status: 504 })),
        ms,
      );
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
  }

  app.post('/api/validate', async (req, res) => {
    try {
      res.json(await withDeadline(whoAmI(toArgs(req.body || {})), 30_000, 'Credential check'));
    } catch (e) {
      bad(res, e.status || 401, e.status ? e.message : 'Credentials rejected');
    }
  });

  app.post('/api/vpcs', async (req, res) => {
    try {
      const args = toArgs(req.body || {});
      if (!args.region?.length) return bad(res, 400, 'A region is required to list VPCs');
      res.json({ vpcs: await withDeadline(listVpcs(args), 60_000, 'VPC listing') });
    } catch (e) {
      bad(res, e.status || 500, e.message);
    }
  });

  app.post('/api/scan', async (req, res) => {
    try {
      const body = req.body || {};
      const args = toArgs(body);
      const scope = body.scope || 'tag';
      if (scope === 'tag') {
        if (!body.tagKey) return bad(res, 400, 'tagKey is required for a tag scan');
        args.tag = String(body.tagKey).trim().slice(0, 128);
        if (body.tagValue) args.value = String(body.tagValue).trim().slice(0, 256);
      } else if (scope === 'vpc') {
        if (!body.vpcId) return bad(res, 400, 'vpcId is required for a VPC scan');
        if (!args.region?.length) return bad(res, 400, 'A region is required for a VPC scan');
        const vpcId = String(body.vpcId).trim();
        if (!/^vpc-[0-9a-f]{8,17}$/.test(vpcId)) return bad(res, 400, 'Malformed VPC id');
        args.vpcId = vpcId;
      } else if (scope === 'account') {
        args.accountScope = true;
      } else {
        return bad(res, 400, `Unknown scope "${scope}"`);
      }

      if (!chargeScan(req, res)) return;

      // Fail fast on bad credentials instead of returning an empty diagram
      // (the scanner itself is best-effort per region).
      try {
        await withDeadline(whoAmI(args), 30_000, 'Credential check');
      } catch (e) {
        return bad(res, e.status === 504 ? 504 : 401, e.status === 504 ? e.message : 'Credentials rejected');
      }

      const scan = await withDeadline(scanAws(args), SCAN_TIMEOUT_MS, 'Scan');
      res.json(await renderScan(scan, {
        title: body.title, showAll: !!body.showAll, groupBy: body.groupBy,
      }));
    } catch (e) {
      // Log genuine failures only; a rejected request body is not an incident.
      // Message only, never the payload — it holds credentials.
      if (!e.status || e.status >= 500) console.error('scan failed:', e.message);
      bad(res, e.status || 500, e.status ? e.message : 'Scan failed');
    }
  });

  // Offline demo using the bundled sample scan — lets people try the tool
  // without entering any credentials.
  app.post('/api/demo', async (req, res) => {
    if (!chargeScan(req, res)) return;
    try {
      const sample = path.join(projectRoot, 'examples', 'sample-scan.json');
      const scan = JSON.parse(fs.readFileSync(sample, 'utf8'));
      res.json(await renderScan(scan));
    } catch (e) {
      console.error('demo failed:', e.message);
      bad(res, 500, 'Could not render the bundled demo');
    }
  });

  // Rendered diagrams carry ARNs, tags and exposure flags, so the id alone is
  // not enough — a link is only valid with its HMAC.
  const lookupView = (req, res) => {
    const r = results.get(req.params.id);
    if (!r || !viewTokenOk(req.params.id, req.query.t)) {
      res.status(404).type('text/plain').send('Expired, unknown, or unauthorized diagram.');
      return null;
    }
    return r;
  };
  const portalCsp = [
    "default-src 'none'",
    // The portal is one self-contained file with inline script and style, and
    // is also written to disk by the CLI, so a nonce is not available here.
    // Pinning every other directive keeps an injected payload from phoning home.
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data:',
    "connect-src 'none'",
    'font-src data:',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ');

  app.get('/view/:id.svg', (req, res) => {
    const r = lookupView(req, res);
    if (!r) return;
    res.set('Content-Security-Policy', portalCsp);
    res.set('Cache-Control', 'private, no-store');
    res.type('image/svg+xml').send(r.svg);
  });
  app.get('/view/:id', (req, res) => {
    const r = lookupView(req, res);
    if (!r) return;
    res.set('Content-Security-Policy', portalCsp);
    res.set('Cache-Control', 'private, no-store');
    res.type('html').send(r.html);
  });

  // Terminal error handler. Without this, a bad JSON body prints a stack trace
  // and returns Express's HTML error page to an API client.
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('unhandled request error:', err.message);
    if (res.headersSent) return;
    const message = status === 413 ? 'Request body too large'
      : status === 400 ? 'Malformed request body'
      : 'Server error';
    res.status(status).json({ error: message });
  });

  const server = app.listen(port, bind, () => {
    if (quiet) return;
    console.error(`\n✔ 3am_blueprint web UI running:\n    http://${bind === '0.0.0.0' ? 'localhost' : bind}:${port}\n`);
    console.error('  Credentials are used per-request, in memory only.');
    if (localOnly) {
      console.error('  Bind is localhost-only. To expose it: put it behind a TLS proxy,');
      console.error('  set ACCESS_CODE, and pass --host 0.0.0.0.');
    } else {
      console.error(`  Bound to ${bind} with an access code set.`);
      if (allowInsecure) {
        console.error('  ! BLUEPRINT_ALLOW_INSECURE=1 — credential POSTs over plain HTTP are allowed.');
      }
      if (!process.env.TRUST_PROXY) {
        console.error('  ! Behind a reverse proxy? Set TRUST_PROXY (e.g. TRUST_PROXY=1) so');
        console.error('    rate limits and the HTTPS check see real client IPs.');
      }
      if (!process.env.VIEW_SECRET) {
        console.error('  Note: diagram links are signed with an ephemeral key and stop');
        console.error('  working after a restart. Set VIEW_SECRET to keep them valid.');
      }
    }
  });

  // Slowloris and stalled-upload protection.
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 10_000;

  let closing = false;
  const shutdown = signal => {
    if (closing) return;
    closing = true;
    if (!quiet) console.error(`\n${signal} received — finishing in-flight requests…`);
    server.close(() => process.exit(0));
    // Do not let a hung connection block the exit indefinitely.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  return server;
}
