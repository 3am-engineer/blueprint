/**
 * Graph-model tests: what is hidden by default, how leftover types are
 * labelled, and which inferred edges survive into the diagram.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, friendlyLabel, HIDDEN_TYPES } from '../src/graph.js';
import { loadIconIndex } from '../src/icons.js';

const icons = loadIconIndex(null);

function res(service, type, id, extra = {}) {
  return {
    arn: `arn:aws:${service}:us-east-1:123456789012:${type || 'x'}/${id}`,
    service, type, id, region: 'us-east-1', account: '123456789012',
    name: id, tags: {}, extra: {}, ...extra,
  };
}

function scanOf(resources, edges = []) {
  return {
    meta: { accountId: '123456789012', regions: ['us-east-1'] },
    resources, edges, vpcs: {}, subnets: {},
  };
}

test('eks pods, listener rules and CloudFormation stacks are hidden by default', () => {
  for (const key of [
    'eks:pod',
    'elasticloadbalancing:listener-rule',
    'cloudformation:stack',
    'ecs:task',
    'ecs:task-definition',
  ]) {
    assert.ok(HIDDEN_TYPES.has(key), `${key} should be in HIDDEN_TYPES`);
  }

  const scan = scanOf([
    res('eks', 'pod', 'nginx-7d8f'),
    res('elasticloadbalancing', 'listener-rule', 'rule-1'),
    res('cloudformation', 'stack', 'app-stack'),
    res('ecs', 'task', 'task-1'),
    res('ec2', 'instance', 'i-keep'),
    res('eks', 'cluster', 'prod'),
  ]);
  const hidden = buildGraph(scan, icons, {});
  const kinds = hidden.nodes.map(n => `${n.service}:${n.type}`);
  assert.ok(kinds.includes('ec2:instance'));
  assert.ok(kinds.includes('eks:cluster'));
  assert.ok(!kinds.includes('eks:pod'));
  assert.ok(!kinds.includes('elasticloadbalancing:listener-rule'));
  assert.ok(!kinds.includes('cloudformation:stack'));
  assert.ok(!kinds.includes('ecs:task'));
  assert.ok(hidden.stats.hidden >= 4);

  const shown = buildGraph(scan, icons, { showAll: true });
  assert.ok(shown.nodes.some(n => n.type === 'pod'), '--show-all brings pods back');
});

test('friendlyLabel title-cases unknown types instead of shouting', () => {
  assert.equal(friendlyLabel('elasticloadbalancing', 'listener-rule'), 'Listener Rule');
  assert.equal(friendlyLabel('cloudformation', 'stack'), 'CloudFormation Stack');
  assert.equal(friendlyLabel('eks', 'pod'), 'EKS Pod');
  assert.equal(friendlyLabel('eks', 'nodegroup'), 'EKS Node Group');
  assert.equal(friendlyLabel('acm', 'certificate'), 'ACM Certificate');
  assert.equal(friendlyLabel('apigateway', 'apis'), 'HTTP API');
  assert.equal(friendlyLabel('rds', 'cluster'), 'Aurora Cluster');
  assert.match(friendlyLabel('some-new-svc', 'weird_type'), /Some New Svc Weird Type/);
  assert.doesNotMatch(friendlyLabel('elasticloadbalancing', 'listener-rule'), /ELASTICLOADBALANCING/);
});

test('a more specific edge drops the parallel sg-flow between the same pair', () => {
  const lb = res('elasticloadbalancing', 'loadbalancer', 'app/alb/1');
  const inst = res('ec2', 'instance', 'i-web');
  const scan = scanOf([lb, inst], [
    { from: lb.arn, to: inst.arn, label: 'forwards', kind: 'lb-target' },
    { from: lb.arn, to: inst.arn, label: 'HTTP :80', kind: 'sg-flow' },
    { from: lb.arn, to: inst.arn, label: 'HTTPS :443', kind: 'sg-flow' },
  ]);
  const graph = buildGraph(scan, icons, {});
  const kinds = graph.edges.map(e => e.kind);
  assert.ok(kinds.includes('lb-target'));
  assert.ok(!kinds.includes('sg-flow'), 'sg-flow is redundant once lb-target exists');
});

test('sg-flow is kept when it is the only relationship', () => {
  const a = res('ec2', 'instance', 'i-a');
  const b = res('rds', 'db', 'main');
  const scan = scanOf([a, b], [
    { from: a.arn, to: b.arn, label: 'MySQL :3306', kind: 'sg-flow' },
  ]);
  const graph = buildGraph(scan, icons, {});
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].kind, 'sg-flow');
});
