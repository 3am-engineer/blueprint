/**
 * AMI → OS detection and icon resolution tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectOs, osLabel, resolveOsIcon } from '../src/os-icons.js';
import { loadIconIndex } from '../src/icons.js';
import { buildGraph } from '../src/graph.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('detectOs matches AMI name patterns', () => {
  assert.equal(detectOs({ amiName: 'amzn2-ami-hvm-2.0.20240101-x86_64-gp2' }), 'amazon-linux');
  assert.equal(detectOs({ amiName: 'ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server' }), 'ubuntu');
  assert.equal(detectOs({ amiName: 'Windows_Server-2022-English-Full-Base' }), 'windows');
  assert.equal(detectOs({ platform: 'windows' }), 'windows');
  assert.equal(detectOs({ platformDetails: 'Red Hat Enterprise Linux' }), 'rhel');
  assert.equal(detectOs({ amiName: 'debian-12-amd64-20240101' }), 'debian');
});

test('detectOs uses ami-map.json for known IDs', () => {
  assert.equal(detectOs({ imageId: 'ami-0c55b159cbfafe1f0' }), 'amazon-linux');
});

test('resolveOsIcon returns data URI for known OS', () => {
  const icon = resolveOsIcon('ubuntu');
  assert.ok(icon);
  assert.equal(icon.matched, true);
  assert.match(icon.dataUri, /^data:image\/svg\+xml;base64,/);
});

test('osLabel returns friendly names', () => {
  assert.equal(osLabel('amazon-linux'), 'Amazon Linux');
  assert.equal(osLabel('ubuntu'), 'Ubuntu');
});

test('buildGraph uses OS icons for EC2 instances', () => {
  const scan = JSON.parse(fs.readFileSync(path.join(root, 'examples', 'sample-scan.json'), 'utf8'));
  const icons = loadIconIndex(null);
  const graph = buildGraph(scan, icons, {});

  const web1 = graph.nodes.find(n => n.label === 'web-1');
  const app1 = graph.nodes.find(n => n.label === 'app-1');
  const app2 = graph.nodes.find(n => n.label === 'app-2');

  assert.equal(web1.sublabel, 'EC2 · Ubuntu');
  assert.equal(app1.sublabel, 'EC2 · Amazon Linux');
  assert.equal(app2.sublabel, 'EC2 · Windows');
  assert.equal(web1.icon, app1.icon, 'EC2 base icon stays the same');
  assert.ok(web1.osIcon && app1.osIcon && app2.osIcon, 'OS badge icons present');
  assert.notEqual(web1.osIcon, app1.osIcon, 'different OSes get different badge icons');
});
