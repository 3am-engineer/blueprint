/**
 * Untagged discovery + enrich passes for services the tagging API alone
 * leaves as isolated boxes (EventBridge, API Gateway, Step Functions,
 * DynamoDB, Route 53, classic ELB, Aurora).
 *
 * Each function is best-effort: a missing IAM action must not abort the scan.
 */
import {
  EventBridgeClient, ListEventBusesCommand, ListRulesCommand, ListTargetsByRuleCommand,
} from '@aws-sdk/client-eventbridge';
import {
  ApiGatewayV2Client, GetApisCommand, GetIntegrationsCommand,
} from '@aws-sdk/client-apigatewayv2';
import {
  APIGatewayClient, GetRestApisCommand, GetResourcesCommand, GetIntegrationCommand,
} from '@aws-sdk/client-api-gateway';
import { SFNClient, ListStateMachinesCommand, DescribeStateMachineCommand } from '@aws-sdk/client-sfn';
import { DynamoDBClient, ListTablesCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import {
  ElasticLoadBalancingClient, DescribeLoadBalancersCommand as DescribeClassicLbsCommand,
} from '@aws-sdk/client-elastic-load-balancing';
import { Route53Client, ListResourceRecordSetsCommand } from '@aws-sdk/client-route-53';
import { RDSClient, DescribeDBClustersCommand, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import {
  EC2Client, DescribeInstancesCommand, DescribeNatGatewaysCommand,
} from '@aws-sdk/client-ec2';
import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
import { EKSClient, ListClustersCommand } from '@aws-sdk/client-eks';
import { drain, chunk } from './aws-paging.js';
import { extractArns, parseArn } from './aws-ids.js';

function retrying(client, withRetry) {
  const orig = client.send.bind(client);
  client.send = (command, options) => withRetry(() => orig(command, options));
  return client;
}

function rec(arn, region, extra = {}) {
  const a = parseArn(arn);
  return {
    arn, service: extra.service || a.service, type: extra.type || a.type, id: extra.id || a.id,
    region: a.region || region, account: a.account, partition: a.partition,
    name: extra.name || a.id, tags: extra.tags || {}, extra: extra.extra || {},
  };
}

/**
 * When the user did not pass a tag filter, list the common architecture
 * services directly so untagged ALBs, functions and databases still appear.
 */
export async function discoverUntagged(region, scan, { client, upsert, withRetry }) {
  const wrap = c => retrying(c, withRetry);

  try {
    const ec2 = wrap(client.ec2());
    const reservations = await drain(
      NextToken => ec2.send(new DescribeInstancesCommand({ NextToken })),
      p => p.Reservations,
      { nextKey: 'NextToken' },
    );
    for (const res of reservations) for (const inst of res.Instances || []) {
      if (!inst.InstanceId) continue;
      const arn = `arn:${scan.meta.partition || 'aws'}:ec2:${region}:${scan.meta.accountId}:instance/${inst.InstanceId}`;
      upsert(rec(arn, region, { type: 'instance', id: inst.InstanceId, name: inst.InstanceId }));
    }
  } catch (e) { console.error(`    ! untagged EC2: ${e.message}`); }

  try {
    const elb = wrap(client.elbv2());
    const lbs = await drain(
      Marker => elb.send(new DescribeLoadBalancersCommand({ Marker })),
      p => p.LoadBalancers,
    );
    for (const lb of lbs) if (lb.LoadBalancerArn) upsert(rec(lb.LoadBalancerArn, region, { name: lb.LoadBalancerName }));
  } catch (e) { console.error(`    ! untagged ELBv2: ${e.message}`); }

  try {
    const classic = wrap(client.elb());
    const lbs = await drain(
      Marker => classic.send(new DescribeClassicLbsCommand({ Marker })),
      p => p.LoadBalancerDescriptions,
    );
    const part = scan.meta.partition || 'aws';
    const acct = scan.meta.accountId || '';
    for (const lb of lbs) {
      const arn = `arn:${part}:elasticloadbalancing:${region}:${acct}:loadbalancer/${lb.LoadBalancerName}`;
      upsert(rec(arn, region, { type: 'loadbalancer', id: lb.LoadBalancerName, name: lb.LoadBalancerName }));
    }
  } catch (e) { console.error(`    ! untagged classic ELB: ${e.message}`); }

  try {
    const lambda = wrap(client.lambda());
    const fns = await drain(
      Marker => lambda.send(new ListFunctionsCommand({ Marker })),
      p => p.Functions,
      { nextKey: 'NextMarker' },
    );
    for (const fn of fns) if (fn.FunctionArn) upsert(rec(fn.FunctionArn, region, { name: fn.FunctionName }));
  } catch (e) { console.error(`    ! untagged Lambda: ${e.message}`); }

  try {
    const rds = wrap(client.rds());
    const instances = await drain(
      Marker => rds.send(new DescribeDBInstancesCommand({ Marker })),
      p => p.DBInstances,
    );
    for (const db of instances) {
      if (db.DBInstanceArn) upsert(rec(db.DBInstanceArn, region, {
        type: 'db', id: db.DBInstanceIdentifier, name: db.DBInstanceIdentifier,
      }));
    }
    const clusters = await drain(
      Marker => rds.send(new DescribeDBClustersCommand({ Marker })),
      p => p.DBClusters,
    );
    for (const c of clusters) if (c.DBClusterArn) {
      upsert(rec(c.DBClusterArn, region, { type: 'cluster', id: c.DBClusterIdentifier, name: c.DBClusterIdentifier }));
    }
  } catch (e) { console.error(`    ! untagged Aurora: ${e.message}`); }

  try {
    const eks = wrap(client.eks());
    const names = await drain(
      nextToken => eks.send(new ListClustersCommand({ nextToken })),
      p => p.clusters,
      { nextKey: 'nextToken' },
    );
    const part = scan.meta.partition || 'aws';
    const acct = scan.meta.accountId || '';
    for (const name of names) {
      const arn = `arn:${part}:eks:${region}:${acct}:cluster/${name}`;
      upsert(rec(arn, region, { type: 'cluster', id: name, name }));
    }
  } catch (e) { console.error(`    ! untagged EKS: ${e.message}`); }

  try {
    const ddb = wrap(client.ddb());
    const tables = await drain(
      ExclusiveStartTableName => ddb.send(new ListTablesCommand({ ExclusiveStartTableName })),
      p => p.TableNames,
      { nextKey: 'LastEvaluatedTableName' },
    );
    const part = scan.meta.partition || 'aws';
    const acct = scan.meta.accountId || '';
    for (const name of tables) {
      const arn = `arn:${part}:dynamodb:${region}:${acct}:table/${name}`;
      upsert(rec(arn, region, { type: 'table', id: name, name }));
    }
  } catch (e) { console.error(`    ! untagged DynamoDB: ${e.message}`); }

  try {
    const nat = wrap(client.ec2());
    const nats = await drain(
      NextToken => nat.send(new DescribeNatGatewaysCommand({ NextToken })),
      p => p.NatGateways,
      { nextKey: 'NextToken' },
    );
    const part = scan.meta.partition || 'aws';
    const acct = scan.meta.accountId || '';
    for (const n of nats) {
      if (n.State === 'deleted') continue;
      const arn = `arn:${part}:ec2:${region}:${acct}:natgateway/${n.NatGatewayId}`;
      upsert(rec(arn, region, { type: 'natgateway', id: n.NatGatewayId, name: n.NatGatewayId }));
    }
  } catch (e) { /* NAT list is optional */ }

}

export async function enrichAurora(ctx) {
  const { region, scan, rds, addEdge, attachSG, findById } = ctx;
  const clusters = scan.resources.filter(r => r.region === region && r.service === 'rds' && r.type === 'cluster');
  if (!clusters.length) return;
  try {
    const listed = await drain(
      Marker => rds.send(new DescribeDBClustersCommand({ Marker })),
      p => p.DBClusters,
    );
    for (const c of listed) {
      const node = clusters.find(n => n.arn === c.DBClusterArn || n.id === c.DBClusterIdentifier);
      if (!node) continue;
      node.extra.engine = c.Engine;
      attachSG(node, (c.VpcSecurityGroups || []).map(g => g.VpcSecurityGroupId));
      for (const m of c.DBClusterMembers || []) {
        const inst = findById(m.DBInstanceIdentifier) ||
          scan.resources.find(r => r.service === 'rds' && r.id === m.DBInstanceIdentifier);
        if (inst) addEdge(node.arn, inst.arn, 'member', 'asg-member');
      }
    }
  } catch (e) { console.error(`    ! Aurora enrich: ${e.message}`); }
}

export async function enrichClassicElb(ctx) {
  const { region, scan, classicElb, addEdge, attachSG, findById, ensureExternalInstance, byId } = ctx;
  const lbs = scan.resources.filter(r =>
    r.region === region && r.service === 'elasticloadbalancing' && r.type === 'loadbalancer' &&
    !String(r.id).startsWith('app/') && !String(r.id).startsWith('net/'));
  if (!lbs.length) return;
  try {
    for (const batch of chunk(lbs.map(l => l.id.split('/').pop()), 20)) {
      const listed = await drain(
        Marker => classicElb.send(new DescribeClassicLbsCommand({ LoadBalancerNames: batch, Marker })),
        p => p.LoadBalancerDescriptions,
      );
      for (const lb of listed) {
        const node = lbs.find(l => l.id === lb.LoadBalancerName || l.id.endsWith('/' + lb.LoadBalancerName));
        if (!node) continue;
        node.vpcId = lb.VPCId;
        node.extra.scheme = lb.Scheme;
        node.extra.dns = lb.DNSName;
        node.extra.lbType = 'classic';
        attachSG(node, lb.SecurityGroups);
        for (const inst of lb.Instances || []) {
          const target = findById(inst.InstanceId) || ensureExternalInstance(scan, byId, inst.InstanceId, region);
          if (target) addEdge(node.arn, target.arn, 'forwards', 'lb-target');
        }
      }
    }
  } catch (e) { console.error(`    ! classic ELB enrich: ${e.message}`); }
}

export async function enrichEventBridge(ctx) {
  const { region, scan, eb, addEdge, upsert } = ctx;
  const known = new Set(scan.resources.filter(r => r.service === 'events').map(r => r.arn));
  try {
    const buses = await drain(
      NextToken => eb.send(new ListEventBusesCommand({ NextToken })),
      p => p.EventBuses,
      { nextKey: 'NextToken' },
    );
    for (const bus of buses) {
      const rules = await drain(
        NextToken => eb.send(new ListRulesCommand({ EventBusName: bus.Name, NextToken })),
        p => p.Rules,
        { nextKey: 'NextToken' },
      );
      for (const rule of rules) {
        if (!rule.Arn) continue;
        if (!known.has(rule.Arn) && !ctx.discovering) continue;
        if (!known.has(rule.Arn) && (rule.ManagedBy || /^(aws\.|GuardDuty|SecurityHub)/i.test(rule.Name || ''))) continue;
        if (!known.has(rule.Arn)) {
          upsert(rec(rule.Arn, region, { type: 'rule', id: rule.Name, name: rule.Name }));
          known.add(rule.Arn);
        }
        const targets = await drain(
          NextToken => eb.send(new ListTargetsByRuleCommand({
            Rule: rule.Name, EventBusName: bus.Name, NextToken,
          })),
          p => p.Targets,
          { nextKey: 'NextToken' },
        );
        for (const t of targets) {
          if (t.Arn && ctx.byArn.has(t.Arn)) addEdge(rule.Arn, t.Arn, 'triggers', 'event');
        }
      }
    }
  } catch (e) { console.error(`    ! EventBridge enrich: ${e.message}`); }
}

export async function enrichApiGateway(ctx) {
  const { region, scan, apigw, apigwRest, addEdge, upsert, discovering } = ctx;
  try {
    const http = await drain(
      NextToken => apigw.send(new GetApisCommand({ NextToken })),
      p => p.Items,
      { nextKey: 'NextToken' },
    );
    for (const api of http) {
      const arn = `arn:${scan.meta.partition || 'aws'}:apigateway:${region}::/apis/${api.ApiId}`;
      const known = ctx.byArn.has(arn) || scan.resources.some(r => r.id === api.ApiId || r.id === `apis/${api.ApiId}`);
      if (!known && !discovering) continue;
      if (!ctx.byArn.has(arn)) upsert(rec(arn, region, { service: 'apigateway', type: 'apis', id: api.ApiId, name: api.Name || api.ApiId }));
      const integrations = await drain(
        NextToken => apigw.send(new GetIntegrationsCommand({ ApiId: api.ApiId, NextToken })),
        p => p.Items,
        { nextKey: 'NextToken' },
      );
      for (const integ of integrations) {
        const uri = integ.IntegrationUri || '';
        const m = uri.match(/arn:[a-z0-9-]+:lambda:[^/]+\d+:function:[A-Za-z0-9-_]+/);
        const target = (m && ctx.byArn.get(m[0])) || ctx.byArn.get(uri);
        if (target) addEdge(arn, target.arn, integ.IntegrationMethod || 'invokes', 'event');
      }
    }
  } catch (e) { console.error(`    ! API Gateway HTTP enrich: ${e.message}`); }

  try {
    const rest = await drain(
      position => apigwRest.send(new GetRestApisCommand({ position })),
      p => p.items,
      { nextKey: 'position' },
    );
    for (const api of rest) {
      const arn = `arn:${scan.meta.partition || 'aws'}:apigateway:${region}::/restapis/${api.id}`;
      const known = ctx.byArn.has(arn) || scan.resources.some(r => r.id === api.id || r.id === `restapis/${api.id}`);
      if (!known && !discovering) continue;
      if (!ctx.byArn.has(arn)) upsert(rec(arn, region, { service: 'apigateway', type: 'restapis', id: api.id, name: api.name || api.id }));
      const resources = await drain(
        position => apigwRest.send(new GetResourcesCommand({ restApiId: api.id, position, embed: ['methods'] })),
        p => p.items,
        { nextKey: 'position' },
      );
      for (const res of resources) {
        for (const method of Object.keys(res.resourceMethods || {})) {
          try {
            const integ = await apigwRest.send(new GetIntegrationCommand({
              restApiId: api.id, resourceId: res.id, httpMethod: method,
            }));
            const uri = integ.uri || '';
            const m = uri.match(/arn:[a-z0-9-]+:lambda:[^:]+:\d+:function:[A-Za-z0-9-_]+/);
            const target = m && ctx.byArn.get(m[0]);
            if (target) addEdge(arn, target.arn, method, 'event');
          } catch { /* no integration */ }
        }
      }
    }
  } catch (e) { console.error(`    ! API Gateway REST enrich: ${e.message}`); }
}

export async function enrichStepFunctions(ctx) {
  const { region, scan, sfn, addEdge, upsert, discovering } = ctx;
  try {
    if (discovering) {
      const machines = await drain(
        nextToken => sfn.send(new ListStateMachinesCommand({ nextToken })),
        p => p.stateMachines,
        { nextKey: 'nextToken' },
      );
      for (const sm of machines) {
        if (sm.stateMachineArn) upsert(rec(sm.stateMachineArn, region, { type: 'stateMachine', id: sm.name, name: sm.name }));
      }
    }
    const known = scan.resources.filter(r => r.region === region && r.service === 'states');
    for (const sm of known) {
      try {
        const d = await sfn.send(new DescribeStateMachineCommand({ stateMachineArn: sm.arn }));
        for (const arn of extractArns(d.definition)) {
          if (ctx.byArn.has(arn) && arn !== sm.arn) addEdge(sm.arn, arn, 'runs', 'event');
        }
      } catch { /* skip */ }
    }
  } catch (e) { console.error(`    ! Step Functions enrich: ${e.message}`); }
}

export async function enrichDynamo(ctx) {
  const { region, scan, ddb } = ctx;
  const tables = scan.resources.filter(r => r.region === region && r.service === 'dynamodb');
  if (!tables.length) return;
  for (const t of tables) {
    try {
      const d = await ddb.send(new DescribeTableCommand({ TableName: t.id.split('/').pop() }));
      t.extra.stream = d.Table?.LatestStreamArn || undefined;
      t.extra.status = d.Table?.TableStatus;
    } catch { /* skip */ }
  }
}

export async function enrichRoute53(ctx) {
  const { scan, r53, addEdge } = ctx;
  const zones = scan.resources.filter(r => r.service === 'route53');
  if (!zones.length) return;
  const dnsIndex = new Map();
  for (const r of scan.resources) {
    if (r.extra?.dns) dnsIndex.set(String(r.extra.dns).toLowerCase().replace(/\.$/, ''), r);
    if (r.extra?.domain) dnsIndex.set(String(r.extra.domain).toLowerCase().replace(/\.$/, ''), r);
  }
  for (const z of zones) {
    const zoneId = String(z.id).split('/').pop();
    try {
      let StartRecordName, StartRecordType;
      do {
        const page = await r53.send(new ListResourceRecordSetsCommand({
          HostedZoneId: zoneId, StartRecordName, StartRecordType,
        }));
        for (const rr of page.ResourceRecordSets || []) {
          const dns = rr.AliasTarget?.DNSName?.toLowerCase().replace(/\.$/, '');
          if (!dns) continue;
          const target = dnsIndex.get(dns) ||
            [...dnsIndex.entries()].find(([k]) => dns.endsWith(k) || k.endsWith(dns))?.[1];
          if (target) addEdge(z.arn, target.arn, rr.Name, 'origin');
        }
        if (page.IsTruncated) {
          StartRecordName = page.NextRecordName;
          StartRecordType = page.NextRecordType;
        } else {
          StartRecordName = undefined;
        }
      } while (StartRecordName);
    } catch (e) { console.error(`    ! Route 53 ${zoneId}: ${e.message}`); }
  }
}

export function clientFactories(opts, wrap) {
  return {
    ec2: () => wrap(new EC2Client(opts)),
    elbv2: () => wrap(new ElasticLoadBalancingV2Client(opts)),
    elb: () => wrap(new ElasticLoadBalancingClient(opts)),
    lambda: () => wrap(new LambdaClient(opts)),
    rds: () => wrap(new RDSClient(opts)),
    eks: () => wrap(new EKSClient(opts)),
    ddb: () => wrap(new DynamoDBClient(opts)),
  };
}
