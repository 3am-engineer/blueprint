/**
 * Route-table classification and outbound (NAT / IGW egress) edges.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRouteTables, addOutboundEdges, splitInternetNodes } from '../src/routes.js';
import { buildGraph } from '../src/graph.js';
import { loadIconIndex } from '../src/icons.js';
import { renderPortal } from '../src/render.js';

const icons = loadIconIndex(null);

function scanBase() {
  return {
    meta: { accountId: '1', regions: ['us-east-1'] },
    resources: [],
    edges: [],
    vpcs: { 'vpc-1': { id: 'vpc-1', name: 'app', cidr: '10.0.0.0/16' } },
    subnets: {
      'subnet-pub': { id: 'subnet-pub', vpcId: 'vpc-1', az: 'us-east-1a', cidr: '10.0.0.0/24', public: false, name: 'pub' },
      'subnet-prv': { id: 'subnet-prv', vpcId: 'vpc-1', az: 'us-east-1a', cidr: '10.0.10.0/24', public: false, name: 'prv' },
    },
  };
}

test('a 0.0.0.0/0 route to an IGW marks the subnet public', () => {
  const scan = scanBase();
  applyRouteTables(scan, [{
    VpcId: 'vpc-1',
    Associations: [{ SubnetId: 'subnet-pub' }],
    Routes: [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-1', State: 'active' }],
  }]);
  assert.equal(scan.subnets['subnet-pub'].public, true);
  assert.equal(scan.subnets['subnet-pub'].egress, 'igw');
  assert.equal(scan.subnets['subnet-pub'].igwId, 'igw-1');
  assert.equal(scan.subnets['subnet-prv'].public, false);
});

test('a 0.0.0.0/0 route to a NAT marks the subnet private and records the NAT', () => {
  const scan = scanBase();
  applyRouteTables(scan, [{
    VpcId: 'vpc-1',
    Associations: [{ SubnetId: 'subnet-prv' }],
    Routes: [{ DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-1', State: 'active' }],
  }]);
  assert.equal(scan.subnets['subnet-prv'].public, false);
  assert.equal(scan.subnets['subnet-prv'].egress, 'nat');
  assert.equal(scan.subnets['subnet-prv'].natGatewayId, 'nat-1');
});

test('the main route table applies to subnets without their own association', () => {
  const scan = scanBase();
  applyRouteTables(scan, [{
    VpcId: 'vpc-1',
    Associations: [{ Main: true }],
    Routes: [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-9', State: 'active' }],
  }]);
  assert.equal(scan.subnets['subnet-pub'].public, true);
  assert.equal(scan.subnets['subnet-prv'].public, true);
});

test('a subnet association wins over the main table', () => {
  const scan = scanBase();
  applyRouteTables(scan, [
    {
      VpcId: 'vpc-1',
      Associations: [{ Main: true }],
      Routes: [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-9', State: 'active' }],
    },
    {
      VpcId: 'vpc-1',
      Associations: [{ SubnetId: 'subnet-prv' }],
      Routes: [{ DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-1', State: 'active' }],
    },
  ]);
  assert.equal(scan.subnets['subnet-pub'].public, true);
  assert.equal(scan.subnets['subnet-prv'].public, false);
  assert.equal(scan.subnets['subnet-prv'].natGatewayId, 'nat-1');
});

test('addOutboundEdges draws NAT → Internet and private compute → NAT', () => {
  const scan = scanBase();
  scan.subnets['subnet-pub'].public = true;
  scan.subnets['subnet-pub'].egress = 'igw';
  scan.subnets['subnet-prv'].egress = 'nat';
  scan.subnets['subnet-prv'].natGatewayId = 'nat-1';
  const nat = {
    arn: 'arn:aws:ec2:us-east-1:1:natgateway/nat-1',
    service: 'ec2', type: 'natgateway', id: 'nat-1', region: 'us-east-1',
    name: 'nat', subnetId: 'subnet-pub', vpcId: 'vpc-1', tags: {}, extra: {},
  };
  const inst = {
    arn: 'arn:aws:ec2:us-east-1:1:instance/i-app',
    service: 'ec2', type: 'instance', id: 'i-app', region: 'us-east-1',
    name: 'app', subnetId: 'subnet-prv', vpcId: 'vpc-1', tags: {}, extra: {},
  };
  const alb = {
    arn: 'arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/alb/1',
    service: 'elasticloadbalancing', type: 'loadbalancer', id: 'app/alb/1',
    region: 'us-east-1', name: 'alb', subnetId: 'subnet-pub', vpcId: 'vpc-1', tags: {}, extra: {},
  };
  scan.resources.push(nat, inst, alb);

  addOutboundEdges(scan);

  assert.ok(scan.resources.some(r => r.arn === 'internet-egress'), 'egress Internet is a separate node');
  assert.ok(!scan.resources.some(r => r.arn === 'internet'), 'inbound Internet is not created for egress');
  assert.ok(scan.edges.some(e => e.from === nat.arn && e.to === 'internet-egress' && e.kind === 'internet-out'));
  assert.ok(scan.edges.some(e => e.from === inst.arn && e.to === nat.arn && e.kind === 'nat-egress'));
  assert.ok(!scan.edges.some(e => e.from === alb.arn && e.kind === 'internet-out'),
    'load balancers do not get a duplicate egress line');
});

test('NAT lands in a public subnet container once routes classify it', () => {
  const scan = scanBase();
  scan.subnets['subnet-pub'].public = true;
  const nat = {
    arn: 'arn:aws:ec2:us-east-1:1:natgateway/nat-1',
    service: 'ec2', type: 'natgateway', id: 'nat-1', region: 'us-east-1',
    name: 'egress-nat', subnetId: 'subnet-pub', vpcId: 'vpc-1', tags: {}, extra: {},
  };
  scan.resources.push(nat);
  const graph = buildGraph(scan, icons, {});
  const node = graph.nodes.find(n => n.id === nat.arn);
  assert.ok(node, 'NAT is visible');
  assert.equal(node.parent, 'subnet:subnet-pub');
  const box = graph.containers.find(c => c.id === 'subnet:subnet-pub');
  assert.equal(box.kind, 'subnet-public');
});

test('outbound edges survive into the graph and the portal has a toggle', async () => {
  const scan = scanBase();
  scan.subnets['subnet-pub'].public = true;
  scan.subnets['subnet-pub'].egress = 'igw';
  const nat = {
    arn: 'arn:aws:ec2:us-east-1:1:natgateway/nat-1',
    service: 'ec2', type: 'natgateway', id: 'nat-1', region: 'us-east-1',
    name: 'nat', subnetId: 'subnet-pub', vpcId: 'vpc-1', tags: {}, extra: {},
  };
  scan.resources.push(nat, {
    arn: 'internet-egress', service: 'internet', type: 'egress', id: 'internet-egress',
    region: 'us-east-1', name: 'Internet', tags: {}, extra: {}, pseudo: true,
  });
  scan.edges.push({ from: nat.arn, to: 'internet-egress', label: 'egress', kind: 'internet-out' });

  const graph = buildGraph(scan, icons, {});
  assert.ok(graph.edges.some(e => e.kind === 'internet-out'), 'egress is not collapsed to a badge');
  const { html } = await renderPortal(graph, scan, {});
  assert.match(html, /id="egressToggle"/);
  assert.match(html, /Internet egress/);
});

test('splitInternetNodes rewrites old egress edges off the inbound node', () => {
  const scan = scanBase();
  scan.resources.push({
    arn: 'internet', service: 'internet', type: '', id: 'internet',
    region: 'us-east-1', name: 'Internet', tags: {}, extra: {}, pseudo: true,
  });
  scan.edges.push({ from: 'arn:aws:ec2:us-east-1:1:natgateway/nat-1', to: 'internet', label: 'egress', kind: 'internet-out' });
  splitInternetNodes(scan);
  assert.equal(scan.edges[0].to, 'internet-egress');
  assert.ok(scan.resources.some(r => r.arn === 'internet-egress'));
  assert.ok(scan.resources.some(r => r.arn === 'internet'), 'inbound node is kept');
});

test('inbound and outbound Internet are separate nodes so layout can split them', () => {
  const scan = scanBase();
  const alb = {
    arn: 'arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/alb/1',
    service: 'elasticloadbalancing', type: 'loadbalancer', id: 'app/alb/1',
    region: 'us-east-1', name: 'alb', vpcId: 'vpc-1', tags: {}, extra: {},
  };
  const nat = {
    arn: 'arn:aws:ec2:us-east-1:1:natgateway/nat-1',
    service: 'ec2', type: 'natgateway', id: 'nat-1', region: 'us-east-1',
    name: 'nat', subnetId: 'subnet-pub', vpcId: 'vpc-1', tags: {}, extra: {},
  };
  scan.subnets['subnet-pub'].public = true;
  scan.resources.push(
    alb, nat,
    { arn: 'internet', service: 'internet', type: '', id: 'internet', region: 'us-east-1', name: 'Internet', tags: {}, extra: {}, pseudo: true },
    { arn: 'internet-egress', service: 'internet', type: 'egress', id: 'internet-egress', region: 'us-east-1', name: 'Internet', tags: {}, extra: {}, pseudo: true },
  );
  scan.edges.push(
    { from: 'internet', to: alb.arn, label: 'HTTPS', kind: 'internet' },
    { from: nat.arn, to: 'internet-egress', label: 'egress', kind: 'internet-out' },
  );
  const graph = buildGraph(scan, icons, {});
  const inn = graph.nodes.find(n => n.id === 'internet');
  const out = graph.nodes.find(n => n.id === 'internet-egress');
  assert.ok(inn && out, 'both Internet nodes are drawn');
  assert.equal(inn.sublabel, 'Inbound');
  assert.equal(out.sublabel, 'Outbound');
  assert.equal(inn.parent, null);
  assert.equal(out.parent, null);
  assert.ok(graph.edges.some(e => e.from === 'internet' && e.to === alb.arn));
  assert.ok(graph.edges.some(e => e.from === nat.arn && e.to === 'internet-egress'));
});

test('public compute skips a direct Internet hop when a NAT is in the VPC', () => {
  const scan = scanBase();
  scan.subnets['subnet-pub'].public = true;
  scan.subnets['subnet-pub'].egress = 'igw';
  const nat = {
    arn: 'arn:aws:ec2:us-east-1:1:natgateway/nat-1',
    service: 'ec2', type: 'natgateway', id: 'nat-1', region: 'us-east-1',
    name: 'nat', subnetId: 'subnet-pub', vpcId: 'vpc-1', tags: {}, extra: {},
  };
  const pub = {
    arn: 'arn:aws:ec2:us-east-1:1:instance/i-pub',
    service: 'ec2', type: 'instance', id: 'i-pub', region: 'us-east-1',
    name: 'bastion', subnetId: 'subnet-pub', vpcId: 'vpc-1', tags: {}, extra: {},
  };
  scan.resources.push(nat, pub);
  addOutboundEdges(scan);
  assert.ok(scan.edges.some(e => e.from === nat.arn && e.to === 'internet-egress' && e.kind === 'internet-out'));
  assert.ok(!scan.edges.some(e => e.from === pub.arn && e.kind === 'internet-out'),
    'NAT already owns the VPC outbound path');
});

test('NAT keeps its own Internet egress and is not bundled with public hosts', () => {
  const scan = scanBase();
  scan.subnets['subnet-pub'].public = true;
  const nat = {
    arn: 'arn:aws:ec2:us-east-1:1:natgateway/nat-1',
    service: 'ec2', type: 'natgateway', id: 'nat-1', region: 'us-east-1',
    name: 'nat', subnetId: 'subnet-pub', vpcId: 'vpc-1', tags: {}, extra: {},
  };
  const hosts = ['i-a', 'i-b', 'i-c', 'i-d'].map(id => ({
    arn: `arn:aws:ec2:us-east-1:1:instance/${id}`,
    service: 'ec2', type: 'instance', id, region: 'us-east-1',
    name: id, subnetId: 'subnet-pub', vpcId: 'vpc-1', tags: {}, extra: {},
  }));
  scan.resources.push(nat, ...hosts, {
    arn: 'internet-egress', service: 'internet', type: 'egress', id: 'internet-egress',
    region: 'us-east-1', name: 'Internet', tags: {}, extra: {}, pseudo: true,
  });
  scan.edges.push({ from: nat.arn, to: 'internet-egress', label: 'egress', kind: 'internet-out' });
  for (const h of hosts) {
    scan.edges.push({ from: h.arn, to: 'internet-egress', label: 'egress', kind: 'internet-out' });
  }
  const graph = buildGraph(scan, icons, {});
  const out = graph.edges.filter(e => e.kind === 'internet-out');
  assert.ok(out.some(e => e.from === nat.arn && e.to === 'internet-egress'),
    'NAT keeps an independent hop to Internet');
  assert.equal(out.filter(e => e.from === nat.arn).length, 1);
});

test('many public hosts share one subnet → Internet egress line', () => {
  const scan = scanBase();
  scan.subnets['subnet-pub'].public = true;
  const hosts = ['i-a', 'i-b', 'i-c', 'i-d'].map(id => ({
    arn: `arn:aws:ec2:us-east-1:1:instance/${id}`,
    service: 'ec2', type: 'instance', id, region: 'us-east-1',
    name: id, subnetId: 'subnet-pub', vpcId: 'vpc-1', tags: {}, extra: {},
  }));
  scan.resources.push(...hosts, {
    arn: 'internet-egress', service: 'internet', type: 'egress', id: 'internet-egress',
    region: 'us-east-1', name: 'Internet', tags: {}, extra: {}, pseudo: true,
  });
  for (const h of hosts) {
    scan.edges.push({ from: h.arn, to: 'internet-egress', label: 'egress', kind: 'internet-out' });
  }
  const graph = buildGraph(scan, icons, {});
  const out = graph.edges.filter(e => e.kind === 'internet-out');
  assert.equal(out.length, 1, 'four public instances collapse to one egress line');
  assert.equal(out[0].from, 'subnet:subnet-pub');
  assert.equal(out[0].to, 'internet-egress');
});

test('inbound Internet sits above the account and egress sits below', async () => {
  const scan = scanBase();
  scan.subnets['subnet-pub'].public = true;
  const alb = {
    arn: 'arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/alb/1',
    service: 'elasticloadbalancing', type: 'loadbalancer', id: 'app/alb/1',
    region: 'us-east-1', name: 'alb', vpcId: 'vpc-1', tags: {}, extra: {},
  };
  const nat = {
    arn: 'arn:aws:ec2:us-east-1:1:natgateway/nat-1',
    service: 'ec2', type: 'natgateway', id: 'nat-1', region: 'us-east-1',
    name: 'nat', subnetId: 'subnet-pub', vpcId: 'vpc-1', tags: {}, extra: {},
  };
  scan.resources.push(
    alb, nat,
    { arn: 'internet', service: 'internet', type: '', id: 'internet', region: 'us-east-1', name: 'Internet', tags: {}, extra: {}, pseudo: true },
    { arn: 'internet-egress', service: 'internet', type: 'egress', id: 'internet-egress', region: 'us-east-1', name: 'Internet', tags: {}, extra: {}, pseudo: true },
  );
  scan.edges.push(
    { from: 'internet', to: alb.arn, label: 'HTTPS', kind: 'internet' },
    { from: nat.arn, to: 'internet-egress', label: 'egress', kind: 'internet-out' },
  );
  const { diagramJson } = await renderPortal(buildGraph(scan, icons, {}), scan, {});
  const account = diagramJson.containers.find(c => c.kind === 'account');
  const inn = diagramJson.nodes.find(n => n.kind === 'internet');
  const out = diagramJson.nodes.find(n => n.kind === 'internet-egress');
  assert.ok(account && inn && out);
  assert.ok(inn.y + inn.h <= account.y, 'inbound Internet is above the account');
  assert.ok(out.y >= account.y + account.h, 'outbound Internet is below the account');
});
