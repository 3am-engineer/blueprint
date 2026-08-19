/**
 * Scan-diff tests: added / removed / changed resources and edges, the
 * text report, and the merged scan used to highlight the portal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffScans, formatDiff, mergeScanForDiff, resourceKey, edgeKey,
} from '../src/diff.js';

function res(id, extra = {}) {
  return {
    arn: `arn:aws:ec2:us-east-1:123456789012:instance/${id}`,
    service: 'ec2', type: 'instance', id, region: 'us-east-1',
    name: id, state: 'running', tags: { Project: 'acme' }, extra: {},
    ...extra,
  };
}

function scanOf(resources, edges = [], extra = {}) {
  return {
    meta: { accountId: '123456789012', regions: ['us-east-1'], generatedAt: '2026-01-01T00:00:00Z', ...extra.meta },
    resources, edges, vpcs: extra.vpcs || {}, subnets: extra.subnets || {},
  };
}

test('identical scans produce an empty diff', () => {
  const a = scanOf([res('i-web')]);
  const d = diffScans(a, a);
  assert.equal(d.added.length, 0);
  assert.equal(d.removed.length, 0);
  assert.equal(d.changed.length, 0);
  assert.equal(d.edges.added.length, 0);
  assert.equal(d.edges.removed.length, 0);
  assert.equal(d.summary.added, 0);
});

test('empty or missing scans do not throw', () => {
  const d = diffScans(null, { resources: [] });
  assert.equal(d.added.length, 0);
  assert.equal(d.removed.length, 0);
  const d2 = diffScans({ resources: [res('i-a')] }, {});
  assert.equal(d2.removed.length, 1);
});

test('a resource only in the new scan is added', () => {
  const old = scanOf([res('i-web')]);
  const neu = scanOf([res('i-web'), res('i-new')]);
  const d = diffScans(old, neu);
  assert.deepEqual(d.added.map(r => r.id), ['i-new']);
  assert.equal(d.removed.length, 0);
});

test('a resource only in the old scan is removed', () => {
  const old = scanOf([res('i-web'), res('i-gone')]);
  const neu = scanOf([res('i-web')]);
  const d = diffScans(old, neu);
  assert.deepEqual(d.removed.map(r => r.id), ['i-gone']);
});

test('state, name, placement, tags and extra count as changes', () => {
  const old = scanOf([res('i-web', {
    extra: { instanceType: 't3.medium' },
    tags: { Project: 'acme', Env: 'staging' },
  })]);
  const neu = scanOf([res('i-web', {
    state: 'stopped',
    name: 'web-renamed',
    subnetId: 'subnet-b',
    extra: { instanceType: 't3.large' },
    tags: { Project: 'acme', Env: 'prod' },
  })]);
  const d = diffScans(old, neu);
  assert.equal(d.changed.length, 1);
  const fields = Object.fromEntries(d.changed[0].fields.map(f => [f.path, f]));
  assert.equal(fields.state.from, 'running');
  assert.equal(fields.state.to, 'stopped');
  assert.equal(fields.name.to, 'web-renamed');
  assert.equal(fields.subnetId.to, 'subnet-b');
  assert.equal(fields['extra.instanceType'].from, 't3.medium');
  assert.equal(fields['extra.instanceType'].to, 't3.large');
  assert.equal(fields['tags.Env'].from, 'staging');
  assert.equal(fields['tags.Env'].to, 'prod');
});

test('key order and missing-vs-empty extra do not count as a change', () => {
  const old = scanOf([res('i-web', { extra: { b: 1, a: 2 }, tags: { Z: '1', A: '2' } })]);
  const neu = scanOf([res('i-web', { extra: { a: 2, b: 1 }, tags: { A: '2', Z: '1' } })]);
  assert.equal(diffScans(old, neu).changed.length, 0);
});

test('new publicPolicy or internet-facing scheme is flagged as exposure', () => {
  const old = scanOf([
    res('i-web', { extra: { scheme: 'internal' } }),
    { arn: 'arn:aws:s3:::logs', service: 's3', type: '', id: 'logs', region: 'us-east-1', name: 'logs', tags: {}, extra: {} },
  ]);
  const neu = scanOf([
    res('i-web', { extra: { scheme: 'internet-facing' } }),
    { arn: 'arn:aws:s3:::logs', service: 's3', type: '', id: 'logs', region: 'us-east-1', name: 'logs', tags: {}, extra: { publicPolicy: 's3:GetObject' } },
  ]);
  const d = diffScans(old, neu);
  assert.equal(d.changed.length, 2);
  assert.ok(d.changed.every(c => c.exposure));
  assert.equal(d.summary.exposure, 2);
});

test('resources without an ARN are keyed by region and id', () => {
  const a = { service: 'ec2', type: 'natgateway', id: 'nat-1', region: 'eu-west-1', name: 'nat', tags: {}, extra: {} };
  const b = { ...a, name: 'nat-renamed' };
  assert.equal(resourceKey(a), 'eu-west-1::nat-1');
  const d = diffScans(scanOf([a]), scanOf([b]));
  assert.equal(d.changed.length, 1);
  assert.equal(d.added.length, 0);
});

test('edges are added and removed by from/to/kind', () => {
  const web = res('i-web');
  const app = res('i-app');
  const oldE = { from: web.arn, to: app.arn, kind: 'sg-flow', label: 'HTTP :8080' };
  const newE = { from: web.arn, to: app.arn, kind: 'iam', label: 'reads' };
  const d = diffScans(scanOf([web, app], [oldE]), scanOf([web, app], [newE]));
  assert.equal(d.edges.removed.length, 1);
  assert.equal(d.edges.added.length, 1);
  assert.equal(d.edges.added[0].kind, 'iam');
  assert.equal(edgeKey(oldE), `${web.arn}|${app.arn}|sg-flow`);
});

test('a new internet edge on a resource is exposure', () => {
  const alb = {
    arn: 'arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/alb/1',
    service: 'elasticloadbalancing', type: 'loadbalancer', id: 'app/alb/1',
    region: 'us-east-1', name: 'alb', tags: {}, extra: {},
  };
  const edge = { from: 'internet', to: alb.arn, kind: 'internet', label: 'HTTPS' };
  const d = diffScans(scanOf([alb], []), scanOf([alb], [edge]));
  assert.equal(d.edges.added.length, 1);
  assert.equal(d.summary.exposure, 1);
  assert.ok(d.edges.added[0].exposure);
});

test('formatDiff prints a readable report with exposure called out', () => {
  const old = scanOf([res('i-gone'), res('i-web', { extra: { instanceType: 't3.small' } })]);
  const neu = scanOf([
    res('i-web', { extra: { instanceType: 't3.large', scheme: 'internet-facing' } }),
    res('i-new'),
  ]);
  const text = formatDiff(diffScans(old, neu), { color: false });
  assert.match(text, /\+ 1 added/);
  assert.match(text, /− 1 removed|− 1 removed/);
  assert.match(text, /~ 1 changed/);
  assert.match(text, /i-new/);
  assert.match(text, /i-gone/);
  assert.match(text, /instanceType/);
  assert.match(text, /exposure/i);
});

test('pipeline throws when --diff points at a missing file', async () => {
  const { runPipeline } = await import('../src/pipeline.js');
  await assert.rejects(
    () => runPipeline({ fromJson: 'examples/sample-scan.json', diff: '/no/such/scan.json', out: '/tmp/blueprint-missing-diff' }, { log() {} }),
    /not found/,
  );
});

test('pipeline writes diff.json and highlights added nodes in the portal', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { runPipeline } = await import('../src/pipeline.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-diff-'));
  const oldPath = path.join(dir, 'old.json');
  const newPath = path.join(dir, 'new.json');
  const out = path.join(dir, 'out');
  const stay = res('i-web');
  const gone = res('i-gone');
  const added = res('i-new');
  fs.writeFileSync(oldPath, JSON.stringify(scanOf([stay, gone])));
  fs.writeFileSync(newPath, JSON.stringify(scanOf([stay, added])));

  const result = await runPipeline({ fromJson: newPath, diff: oldPath, out }, { log() {} });
  assert.ok(result.diff);
  assert.deepEqual(result.diff.added.map(r => r.id), ['i-new']);
  assert.deepEqual(result.diff.removed.map(r => r.id), ['i-gone']);
  assert.ok(fs.existsSync(path.join(out, 'diff.json')));
  const html = fs.readFileSync(result.htmlPath, 'utf8');
  assert.match(html, /data-diff="added"/);
  assert.match(html, /data-diff="removed"/);
  assert.match(html, /id="changes"/);
  assert.match(html, /Added \(1\)/);
});

test('mergeScanForDiff keeps live resources and ghosts the removed ones', () => {
  const gone = res('i-gone');
  const stay = res('i-web');
  const added = res('i-new');
  const old = scanOf([gone, stay], [
    { from: stay.arn, to: gone.arn, kind: 'sg-flow', label: 'HTTP' },
  ], { vpcs: { 'vpc-01': { id: 'vpc-01', name: 'acme' } } });
  const neu = scanOf([stay, added], [], { vpcs: {} });
  const d = diffScans(old, neu);
  const merged = mergeScanForDiff(neu, old, d);
  const byId = Object.fromEntries(merged.resources.map(r => [r.id, r]));
  assert.equal(byId['i-new'].diffStatus, 'added');
  assert.equal(byId['i-gone'].diffStatus, 'removed');
  assert.equal(byId['i-web'].diffStatus, undefined);
  assert.ok(merged.vpcs['vpc-01'], 'old VPC metadata is kept so ghosts place');
  assert.ok(merged.edges.some(e => e.diffStatus === 'removed'));
  assert.equal(merged.diff.summary.added, 1);
});
