/**
 * Injection regression tests.
 *
 * Resource names, tags and ARNs are attacker-influencable: anyone who can tag
 * an AWS resource decides what text lands in the rendered portal. These tests
 * push hostile strings through the real pipeline and assert they come out inert.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../src/graph.js';
import { renderPortal } from '../src/render.js';
import { loadIconIndex } from '../src/icons.js';

const icons = loadIconIndex(null);

/** Strings that break out of HTML text, attributes, JSON and SVG if unescaped. */
const HOSTILE = [
  '<script>window.__pwned=1</script>',
  '"><script>window.__pwned=1</script>',
  "'><img src=x onerror=window.__pwned=1>",
  '</script><script>window.__pwned=1</script>',
  '</title></head><body onload=window.__pwned=1>',
  '"onmouseover="window.__pwned=1',
  '</text><script>window.__pwned=1</script>',
  // Bare "</script>" would appear legitimately throughout the document, so the
  // marker makes an unescaped copy identifiable.
  '</script>__pwned_marker',
  '${window.__pwned=1}',
  'javascript:window.__pwned=1',
];

function scanWith(name) {
  return {
    meta: {
      accountId: '123456789012', regions: ['us-east-1'], generatedAt: '2026-01-01T00:00:00Z',
      tagKey: name, tagValue: name, scope: 'tag',
    },
    resources: [
      {
        arn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-0abc',
        service: 'ec2', type: 'instance', id: 'i-0abc', region: 'us-east-1',
        account: '123456789012', name, vpcId: 'vpc-1', subnetId: 'subnet-1',
        tags: { Name: name, [name]: name }, extra: { privateIp: '10.0.0.1', instanceType: name },
      },
      {
        arn: 'arn:aws:rds:us-east-1:123456789012:db:main',
        service: 'rds', type: 'db', id: 'main', region: 'us-east-1',
        account: '123456789012', name: 'db-' + name, vpcId: 'vpc-1', subnetId: 'subnet-1',
        tags: {}, extra: { engine: name },
      },
    ],
    vpcs: { 'vpc-1': { id: 'vpc-1', name, cidr: '10.0.0.0/16', region: 'us-east-1' } },
    subnets: { 'subnet-1': { id: 'subnet-1', name, vpcId: 'vpc-1', cidr: '10.0.1.0/24', public: true } },
    edges: [{
      from: 'arn:aws:ec2:us-east-1:123456789012:instance/i-0abc',
      to: 'arn:aws:rds:us-east-1:123456789012:db:main',
      label: name, kind: 'sg-flow',
    }],
  };
}

/** Pull out the `application/json` data islands, which legitimately contain the
 *  payload as inert data, so the remaining markup can be checked on its own. */
const JSON_BLOCK = /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;

for (const payload of HOSTILE) {
  test(`portal neutralises ${JSON.stringify(payload).slice(0, 46)}`, async () => {
    const scan = scanWith(payload);
    const { html, svg } = await renderPortal(buildGraph(scan, icons, {}), scan, {});

    // Data islands: the payload lives here as JSON, so the requirement is that
    // it cannot terminate the script element or corrupt the document.
    const blocks = [...html.matchAll(JSON_BLOCK)].map(m => m[1]);
    assert.ok(blocks.length >= 1, 'portal embeds its data as JSON');
    for (const body of blocks) {
      assert.ok(!/<\/script/i.test(body), 'JSON payload breaks out of its script tag');
      assert.doesNotThrow(() => JSON.parse(body), 'embedded JSON stays parseable');
    }

    const markup = html.replace(JSON_BLOCK, '<script type="application/json"></script>');
    for (const [label, doc] of [['html', markup], ['svg', svg]]) {
      // A payload that can open a tag must never survive verbatim: seeing the
      // raw string back means a sink forgot to escape it.
      if (/[<>]/.test(payload)) {
        assert.ok(!doc.includes(payload), `${label}: payload appears unescaped`);
      }
      // Nothing from a resource name may end up inside executable script.
      for (const body of [...doc.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1])) {
        assert.ok(!body.includes('__pwned'),
          `${label}: payload reached an executable <script> body`);
      }
      // Markup shapes the generator would never produce itself. (It does emit
      // <img> for legend icons and <image> inside SVG, so those alone are fine.)
      assert.ok(!/<img\b[^>]*\bonerror\b/i.test(doc),
        `${label}: an <img onerror> was injected`);
      assert.ok(!/<(body|iframe|object|embed|form|svg)\b[^>]*\son\w+\s*=/i.test(doc),
        `${label}: an element with an event handler was injected`);
    }
  });
}

test('diff change list escapes hostile resource names', async () => {
  const { diffScans, mergeScanForDiff } = await import('../src/diff.js');
  const payload = '<script>window.__pwned=1</script>';
  const old = scanWith('safe');
  const neu = scanWith(payload);
  neu.resources.push({
    arn: 'arn:aws:s3:::evil', service: 's3', type: '', id: 'evil',
    region: 'us-east-1', name: payload, tags: { Name: payload }, extra: {},
  });
  const merged = mergeScanForDiff(neu, old, diffScans(old, neu));
  const { html } = await renderPortal(buildGraph(merged, icons, {}), merged, {});
  const markup = html.replace(JSON_BLOCK, '<script type="application/json"></script>');
  assert.ok(!markup.includes(payload), 'changes panel leaves the payload unescaped');
  assert.ok(markup.includes('id="changes"'), 'changes panel is present');
});

test('a hostile name is still readable in the output', async () => {
  // Escaping must not silently drop the text — an operator needs to see the
  // suspicious tag in order to act on it.
  const scan = scanWith('<script>alert(1)</script>');
  const { html } = await renderPortal(buildGraph(scan, icons, {}), scan, {});
  assert.ok(
    html.includes('&lt;script&gt;') || html.includes('\\u003cscript\\u003e'),
    'the payload appears in escaped form somewhere in the document',
  );
});

test('mermaid export cannot inject diagram syntax or directives', async () => {
  // A downloaded .mmd is opened in GitHub or Mermaid Live, so the file itself
  // has to be safe — not just its rendering inside our portal.
  const scan = scanWith('a"b[c]d{e}f|g\n%%{init:{"themeCSS":":root{}"}}%%\nX-->Y');
  const { exports } = await renderPortal(buildGraph(scan, icons, {}), scan, {});
  const mmd = exports.mermaid;

  const generated = mmd.split('\n');
  // Only the generator's own header may be a directive line.
  const directives = generated.filter(l => l.trim().startsWith('%%'));
  assert.equal(directives.length, 1, 'exactly one directive: our header comment');
  assert.match(directives[0], /generated by/);
  assert.ok(!mmd.includes('%%{'), 'no init directive smuggled in');
  assert.ok(!/^\s*X-->Y\s*$/m.test(mmd), 'no injected edge statement');

  for (const label of mmd.match(/\["[^"]*"\]/g) || []) {
    const inner = label.slice(2, -2);
    for (const ch of ['[', ']', '{', '}', '|', '%']) {
      assert.ok(!inner.includes(ch), `label still contains a structural ${ch}`);
    }
  }
});

test('draw.io export escapes names into XML attributes', async () => {
  const scan = scanWith('"/><mxCell id="evil"/><!--');
  const { exports } = await renderPortal(buildGraph(scan, icons, {}), scan, {});
  const xml = exports.drawio;
  assert.ok(!xml.includes('<mxCell id="evil"'), 'injected cell reached the document');
  assert.ok(!xml.includes('<!--'), 'injected comment reached the document');
  assert.ok(/&quot;|&#34;/.test(xml), 'quotes are entity-encoded');
});

test('excalidraw export keeps hostile names as inert JSON strings', async () => {
  const scan = scanWith('</script><script>alert(1)</script>');
  const { exports } = await renderPortal(buildGraph(scan, icons, {}), scan, {});
  const parsed = JSON.parse(exports.excalidraw);
  assert.ok(Array.isArray(parsed.elements), 'valid excalidraw document');
});
