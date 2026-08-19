/**
 * Icon-free render smoke test.
 *
 * CI never has the AWS icon set installed (it's downloaded separately and
 * gitignored), so the whole scan → graph → render path must work with
 * loadIconIndex(null): every resource falls back to the generic tile and
 * containers simply render without a group icon.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadIconIndex } from '../src/icons.js';
import { buildGraph } from '../src/graph.js';
import { renderPortal, nodeLines, fitSublabel, deconflictLabels } from '../src/render.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sampleScan = () =>
  JSON.parse(fs.readFileSync(path.join(root, 'examples', 'sample-scan.json'), 'utf8'));

test('loadIconIndex(null) yields generic fallbacks without throwing', () => {
  const icons = loadIconIndex(null);
  assert.deepEqual(icons.counts, { service: 0, resource: 0, group: 0 });

  const r = icons.resolve('ec2', 'instance');
  assert.equal(r.matched, false);
  assert.match(r.dataUri, /^data:image\/svg\+xml;base64,/);

  const g = icons.group('vpc');
  assert.equal(g.dataUri, null);
});

test('loadIconIndex tolerates a missing directory path', () => {
  const icons = loadIconIndex(path.join(root, 'no-such-icons-dir'));
  assert.deepEqual(icons.counts, { service: 0, resource: 0, group: 0 });
  assert.equal(icons.resolve('s3', 'bucket').matched, false);
});

test('sample scan renders end-to-end without an icon set', async () => {
  const scan = sampleScan();
  const icons = loadIconIndex(null);

  const graph = buildGraph(scan, icons, {});
  assert.ok(graph.stats.resources > 0, 'graph should contain visible resources');
  assert.ok(graph.stats.edges > 0, 'graph should contain inferred edges');

  const { html, svg, diagramJson, exports } = await renderPortal(graph, scan, { title: 'ci-smoke' });

  assert.ok(html.includes('<!DOCTYPE html>') || html.includes('<html'), 'portal HTML rendered');
  assert.ok(html.includes('ci-smoke'), 'portal uses the given title');
  assert.match(svg, /<svg[\s>]/, 'standalone SVG rendered');
  assert.ok(svg.includes('data:image/svg+xml;base64,'), 'generic fallback icons embedded');

  assert.ok(diagramJson, 'diagram geometry produced');
  for (const key of ['drawio', 'mermaid', 'excalidraw']) {
    assert.ok(typeof exports[key] === 'string' && exports[key].length > 0, `${key} export produced`);
  }
});

test('SVG embeds each unique icon once and references it with <use>', async () => {
  const scan = sampleScan();
  const { svg } = await renderPortal(buildGraph(scan, loadIconIndex(null), {}), scan, {});
  const dataUris = svg.match(/data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+/g) || [];
  const unique = new Set(dataUris);
  assert.ok(unique.size >= 1, 'at least one icon is embedded');
  assert.match(svg, /<symbol id="ico-/, 'icons live in <symbol> defs');
  assert.match(svg, /<use href="#ico-/, 'nodes reference icons via <use>');
  assert.equal(dataUris.length, unique.size, 'no duplicated data URIs');
  assert.match(svg, /tabindex="0"/, 'nodes are keyboard-focusable');
});

test('group-by=type renders without an icon set', async () => {
  const scan = sampleScan();
  const graph = buildGraph(scan, loadIconIndex(null), { groupBy: 'type' });
  const { svg } = await renderPortal(graph, scan, {});
  assert.match(svg, /<svg[\s>]/);
});

test('connectors carry an animated flow overlay and inbound/outbound selection', async () => {
  const scan = sampleScan();
  const { html, svg } = await renderPortal(buildGraph(scan, loadIconIndex(null), {}), scan, {});

  assert.match(svg, /class="flow"/, 'each connector has a flow stroke');
  assert.match(svg, /@keyframes bp-flow/, 'standalone SVG can animate without the portal');
  assert.match(html, /id="flowToggle"/, 'portal has a flow toggle');
  assert.match(html, /prefers-reduced-motion/, 'animation respects reduced motion');
  assert.match(html, /classList\.(?:toggle|add)\('out'/, 'selecting a node marks outbound edges');
  assert.match(html, /classList\.(?:toggle|add)\('in'/, 'selecting a node marks inbound edges');
  assert.match(html, /Inbound to selected/);
  assert.match(html, /Outbound from selected/);
  assert.match(html, /--flow:#111418/, 'light mode uses black flow beads');
  assert.match(html, /--flow:#ffffff/, 'dark mode uses white flow beads');
});

test('nodeLines wraps long names and ellipsizes the last line', () => {
  assert.deepEqual(nodeLines('alb'), ['alb']);
  const lines = nodeLines('st-bigwinboard-plugin-api-serverlessdeploymentbucket');
  assert.ok(lines.length <= 3);
  assert.ok(lines.every(l => l.length <= 16), 'no line overflows the card');
  assert.match(lines.at(-1), /…$/, 'leftover text is ellipsized');
  assert.equal(fitSublabel('API Gateway'), 'API Gateway');
  assert.equal(fitSublabel('restapis/yrxueapgk0/stages/bigwinboard').endsWith('…'), true);
});

test('deconflictLabels separates stacked HTTP/HTTPS chips', () => {
  const edges = [
    { label: { x: 100, y: 40, w: 90, h: 14, text: '80 - HTTP/S' } },
    { label: { x: 108, y: 42, w: 88, h: 14, text: '443 - HTTPS' } },
  ];
  deconflictLabels(edges);
  assert.ok(Math.abs(edges[0].label.y - edges[1].label.y) >= 20, 'labels no longer share a row');
});

test('two inbound connectors do not stack their labels', async () => {
  const scan = {
    meta: { accountId: '1', regions: ['us-east-1'] },
    resources: [
      {
        arn: 'arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/fe/1',
        service: 'elasticloadbalancing', type: 'loadbalancer', id: 'app/fe/1',
        region: 'us-east-1', name: 'FE-LB', vpcId: 'vpc-1', tags: {}, extra: {},
      },
      {
        arn: 'arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/be/1',
        service: 'elasticloadbalancing', type: 'loadbalancer', id: 'app/be/1',
        region: 'us-east-1', name: 'BE-LB', vpcId: 'vpc-1', tags: {}, extra: {},
      },
      {
        arn: 'internet', service: 'internet', type: '', id: 'internet',
        region: 'us-east-1', name: 'Internet', tags: {}, extra: {}, pseudo: true,
      },
    ],
    edges: [
      { from: 'internet', to: 'arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/fe/1', label: '80 - HTTP/S', kind: 'internet' },
      { from: 'internet', to: 'arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/be/1', label: '443 - HTTPS', kind: 'internet' },
    ],
    vpcs: { 'vpc-1': { id: 'vpc-1', name: 'app', cidr: '10.0.0.0/16' } },
    subnets: {},
  };
  const { diagramJson } = await renderPortal(buildGraph(scan, loadIconIndex(null), {}), scan, {});
  const labs = diagramJson.edges.filter(e => e.label && /HTTP/.test(e.label.text)).map(e => e.label);
  assert.equal(labs.length, 2);
  const [a, b] = labs;
  const overlapX = Math.abs((a.x + a.w / 2) - (b.x + b.w / 2)) < (a.w + b.w) / 2;
  const overlapY = Math.abs(a.y - b.y) < Math.max(a.h, b.h);
  assert.ok(!(overlapX && overlapY), 'inbound port labels must not overlap');
});
