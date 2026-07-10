/**
 * Web UI server — `blueprint serve [--port 8787]`.
 *
 * Endpoints:
 *   POST /api/validate  { credentials, region? }              -> { accountId, arn }
 *   POST /api/vpcs      { credentials, region }               -> { vpcs: [...] }
 *   POST /api/scan      { credentials, scope, ... }           -> { id, stats, accountId }
 *   POST /api/demo      {}                                    -> { id, stats }   (bundled sample, no AWS)
 *   GET  /view/:id      rendered portal (self-contained HTML)
 *   GET  /view/:id.svg  standalone SVG
 *
 * Credential handling: credentials arrive in the request body, are passed to
 * the AWS SDK for that request only, and are never persisted or logged.
 * Results (rendered HTML/SVG, no credentials) are kept in memory with a TTL.
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

const SCAN_LIMIT = 12;                       // scans per window per IP
const SCAN_WINDOW_MS = 15 * 60 * 1000;

/** @param {{port:number, host?:string, iconsDir:string, projectRoot:string, quiet?:boolean}} opts
 *  @returns {import('node:http').Server} */
export function startServer({ port, host, iconsDir, projectRoot, quiet }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(projectRoot, 'public')));
  app.get('/app', (_req, res) => res.sendFile(path.join(projectRoot, 'public', 'app.html')));

  // Optional shared access code (set ACCESS_CODE env) — lets you host this for
  // a limited audience without building full auth. The demo stays open.
  const accessCode = process.env.ACCESS_CODE || '';
  app.get('/api/config', (_req, res) => res.json({ requiresCode: !!accessCode }));
  const gated = (req, res, next) => {
    if (accessCode && req.get('x-access-code') !== accessCode) {
      return res.status(401).json({ error: 'Invalid or missing access code' });
    }
    next();
  };
  app.use(['/api/scan', '/api/vpcs', '/api/validate'], gated);

  // Naive per-IP rate limit on scans (each scan fans out many AWS calls).
  const hits = new Map();
  app.use('/api/scan', (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || 'unknown';
    const list = (hits.get(ip) || []).filter(t => now - t < SCAN_WINDOW_MS);
    if (list.length >= SCAN_LIMIT) {
      return res.status(429).json({ error: `Rate limit: max ${SCAN_LIMIT} scans per 15 minutes` });
    }
    list.push(now);
    hits.set(ip, list);
    next();
  });

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
    if (regions.length) args.region = regions;
    if (body.allRegions) args.allRegions = true;
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
    return { id, stats: graph.stats, accountId: scan.meta.accountId };
  }

  app.post('/api/validate', async (req, res) => {
    try {
      res.json(await whoAmI(toArgs(req.body || {})));
    } catch (e) {
      bad(res, e.status || 401, e.status ? e.message : `Credentials rejected: ${e.message}`);
    }
  });

  app.post('/api/vpcs', async (req, res) => {
    try {
      const args = toArgs(req.body || {});
      if (!args.region?.length) return bad(res, 400, 'A region is required to list VPCs');
      res.json({ vpcs: await listVpcs(args) });
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
        args.tag = String(body.tagKey).trim();
        if (body.tagValue) args.value = String(body.tagValue).trim();
      } else if (scope === 'vpc') {
        if (!body.vpcId) return bad(res, 400, 'vpcId is required for a VPC scan');
        if (!args.region?.length) return bad(res, 400, 'A region is required for a VPC scan');
        args.vpcId = String(body.vpcId).trim();
      } else if (scope === 'account') {
        args.accountScope = true;
      } else {
        return bad(res, 400, `Unknown scope "${scope}"`);
      }

      // Fail fast on bad credentials instead of returning an empty diagram
      // (the scanner itself is best-effort per region).
      try {
        await whoAmI(args);
      } catch (e) {
        return bad(res, 401, `Credentials rejected: ${e.message}`);
      }

      const scan = await scanAws(args);
      res.json(await renderScan(scan, { title: body.title, showAll: !!body.showAll, groupBy: body.groupBy }));
    } catch (e) {
      console.error('scan failed:', e.message);   // message only — never the payload
      bad(res, e.status || 500, e.status ? e.message : `Scan failed: ${e.message}`);
    }
  });

  // Offline demo using the bundled sample scan — lets people try the tool
  // without entering any credentials.
  app.post('/api/demo', async (_req, res) => {
    try {
      const sample = path.join(projectRoot, 'examples', 'sample-scan.json');
      const scan = JSON.parse(fs.readFileSync(sample, 'utf8'));
      res.json(await renderScan(scan));
    } catch (e) {
      bad(res, 500, e.message);
    }
  });

  app.get('/view/:id.svg', (req, res) => {
    const r = results.get(req.params.id);
    if (!r) return res.status(404).send('Expired or unknown diagram');
    res.type('image/svg+xml').send(r.svg);
  });
  app.get('/view/:id', (req, res) => {
    const r = results.get(req.params.id);
    if (!r) return res.status(404).send('Expired or unknown diagram — run the scan again.');
    res.type('html').send(r.html);
  });

  const bind = host || '127.0.0.1';
  const server = app.listen(port, bind, () => {
    if (quiet) return;
    console.error(`\n✔ blueprint_ web UI running:\n    http://${bind === '0.0.0.0' ? 'localhost' : bind}:${port}\n`);
    console.error('  Credentials are used per-request, in memory only.');
    if (bind === '127.0.0.1') {
      console.error('  Bind is localhost-only; use --host 0.0.0.0 behind a TLS proxy to expose it.');
    } else {
      console.error(`  Bound to ${bind} — serve it behind HTTPS, and set ACCESS_CODE to gate scans.`);
    }
  });
  return server;
}
