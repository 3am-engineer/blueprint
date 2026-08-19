/**
 * AWS scanning + enrichment.
 *
 * 1. Uses the Resource Groups Tagging API to find every ARN carrying the tag
 *    (optionally filtered by value) across the requested regions.
 * 2. Enriches the common architecture services (EC2/VPC/subnet, ELBv2, RDS,
 *    Lambda, Auto Scaling) so we can place resources into VPC/subnet containers
 *    and infer labeled relationships (edges).
 *
 * Everything is best-effort and wrapped so one failing service/region never
 * aborts the whole scan.
 */
import { fromIni } from '@aws-sdk/credential-providers';
import {
  ResourceGroupsTaggingAPIClient, GetResourcesCommand,
} from '@aws-sdk/client-resource-groups-tagging-api';
import {
  EC2Client, DescribeInstancesCommand, DescribeImagesCommand, DescribeVpcsCommand,
  DescribeSubnetsCommand, DescribeRegionsCommand, DescribeNatGatewaysCommand,
  DescribeInternetGatewaysCommand, DescribeSecurityGroupsCommand,
  DescribeRouteTablesCommand,
} from '@aws-sdk/client-ec2';
import { detectOs } from './os-icons.js';
import {
  ElastiCacheClient, DescribeCacheClustersCommand, DescribeCacheSubnetGroupsCommand,
} from '@aws-sdk/client-elasticache';
import {
  EFSClient, DescribeMountTargetsCommand, DescribeMountTargetSecurityGroupsCommand,
} from '@aws-sdk/client-efs';
import {
  ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand, DescribeTargetHealthCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { LambdaClient, GetFunctionConfigurationCommand, ListEventSourceMappingsCommand } from '@aws-sdk/client-lambda';
import { ECSClient, DescribeServicesCommand } from '@aws-sdk/client-ecs';
import { EKSClient, DescribeClusterCommand } from '@aws-sdk/client-eks';
import { SNSClient, ListSubscriptionsByTopicCommand, GetTopicAttributesCommand } from '@aws-sdk/client-sns';
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { GetPolicyCommand as GetLambdaPolicyCommand } from '@aws-sdk/client-lambda';
import { CloudFrontClient, GetDistributionCommand } from '@aws-sdk/client-cloudfront';
import { ACMClient, DescribeCertificateCommand } from '@aws-sdk/client-acm';
import {
  IAMClient, GetInstanceProfileCommand, ListRolePoliciesCommand, GetRolePolicyCommand,
  ListAttachedRolePoliciesCommand, GetPolicyCommand as GetIamPolicyCommand, GetPolicyVersionCommand,
} from '@aws-sdk/client-iam';
import { S3Client, GetBucketNotificationConfigurationCommand, GetBucketPolicyCommand } from '@aws-sdk/client-s3';
import { AutoScalingClient, DescribeAutoScalingGroupsCommand } from '@aws-sdk/client-auto-scaling';
import { STSClient, GetCallerIdentityCommand, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { drain, chunk, mapLimit, dedupeEdges, withRetry } from './aws-paging.js';
import { applyRouteTables, addOutboundEdges } from './routes.js';
import {
  parseArn, sqsQueueUrl, s3BucketArn, partitionOf, idKey, isInternetCidr,
} from './aws-ids.js';
import {
  discoverUntagged, enrichAurora, enrichClassicElb, enrichEventBridge,
  enrichApiGateway, enrichStepFunctions, enrichDynamo, enrichRoute53, clientFactories,
} from './discover.js';
import {
  EventBridgeClient,
} from '@aws-sdk/client-eventbridge';
import { ApiGatewayV2Client } from '@aws-sdk/client-apigatewayv2';
import { APIGatewayClient } from '@aws-sdk/client-api-gateway';
import { SFNClient } from '@aws-sdk/client-sfn';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ElasticLoadBalancingClient } from '@aws-sdk/client-elastic-load-balancing';
import { Route53Client } from '@aws-sdk/client-route-53';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Wrap an SDK client so every `.send()` backs off on throttling. */
function retrying(client) {
  const orig = client.send.bind(client);
  client.send = (command, options) => withRetry(() => orig(command, options));
  return client;
}

/**
 * Build an SDK credentials option from either inline (temporary) credentials
 * or a shared-config profile name. Inline credentials are used as-is and are
 * never written anywhere.
 * @param {string | {accessKeyId:string,secretAccessKey:string,sessionToken?:string,profile?:string} | undefined} auth
 */
function creds(auth) {
  if (auth && typeof auth === 'object' && auth.accessKeyId) {
    return {
      credentials: {
        accessKeyId: auth.accessKeyId,
        secretAccessKey: auth.secretAccessKey,
        sessionToken: auth.sessionToken || undefined,
      },
    };
  }
  const profile = typeof auth === 'string' ? auth : auth?.profile;
  return profile ? { credentials: fromIni({ profile }) } : {};
}

/** Preferred auth source from parsed args: inline credentials, else profile. */
const authOf = args => args.credentials || args.profile;

/** Read the configured region for a profile from the shared AWS config/creds files. */
function readProfileRegion(profile) {
  const files = [
    process.env.AWS_CONFIG_FILE || path.join(os.homedir(), '.aws', 'config'),
    process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(os.homedir(), '.aws', 'credentials'),
  ];
  const wanted = profile || 'default';
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let current = null;
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      const sec = line.match(/^\[(.+?)\]$/);
      if (sec) {
        // config uses "[profile name]"; credentials uses "[name]"; default is "[default]".
        current = sec[1].replace(/^profile\s+/, '');
        continue;
      }
      if (current === wanted) {
        const m = line.match(/^region\s*=\s*(\S+)/);
        if (m) return m[1];
      }
    }
  }
  return null;
}

export { parseArn } from './aws-ids.js';

/**
 * Resolve a target-group member to a scanned resource.
 * `Target.Id` is an instance id, a private IP (IP-mode / pod targets), or an
 * ARN (Lambda, another load balancer).
 */
export function resolveLbTarget(tid, { byId, byArn, byIp, region }) {
  if (!tid) return null;
  return (region && byId.get(idKey(region, tid))) ||
    byId.get(tid) || byArn.get(tid) || byIp.get(tid) || null;
}

function nameFromTags(tags) {
  const t = (tags || []).find(x => (x.Key || x.key) === 'Name');
  return t ? (t.Value || t.value) : undefined;
}

/** Regions scanned at once. Kept modest so an all-regions sweep does not
 *  trip AWS request throttling, which would cost more than it saves. */
const REGION_CONCURRENCY = 6;

async function resolveRegions(args) {
  // --all-regions wins over an explicit --region list (web UI may send both).
  if (args.allRegions) {
    try {
      const probe = args.region?.[0] || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
      const ec2 = retrying(new EC2Client({ region: probe, ...creds(authOf(args)) }));
      const r = await ec2.send(new DescribeRegionsCommand({ AllRegions: false }));
      return r.Regions.map(x => x.RegionName).sort();
    } catch (e) {
      console.error('  ! could not list regions, falling back to us-east-1:', e.message);
    }
  }
  if (args.region?.length) return args.region;
  const envRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  const profileRegion = readProfileRegion(args.profile);
  const region = envRegion || profileRegion || 'us-east-1';
  console.error(`  (no --region given; using ${region}` +
    `${profileRegion && region === profileRegion ? ` from profile "${args.profile || 'default'}"` : ''}` +
    `. Use --all-regions to sweep every region.)`);
  return [region];
}

async function assumeRoleIfRequested(args) {
  if (!args.roleArn) return args;
  const region = args.region?.[0] || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  const sts = retrying(new STSClient({ region, ...creds(authOf(args)) }));
  const r = await sts.send(new AssumeRoleCommand({
    RoleArn: args.roleArn,
    RoleSessionName: 'blueprint-scan',
    ExternalId: args.externalId || undefined,
    DurationSeconds: 3600,
  }));
  const c = r.Credentials;
  console.error(`  • assumed ${args.roleArn}`);
  return {
    ...args,
    credentials: {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
    },
  };
}

export async function scanAws(input) {
  const args = await assumeRoleIfRequested(input);
  const regions = await resolveRegions(args);
  const tagKey = args.tag;
  const tagValue = args.value;

  const scan = {
    meta: {
      tagKey, tagValue, profile: args.profile || null, regions,
      accountId: null, generatedAt: new Date().toISOString(),
    },
    resources: [],
    vpcs: {},
    subnets: {},
    edges: [],
  };

  try {
    const sts = retrying(new STSClient({ region: regions[0], ...creds(authOf(args)) }));
    const who = await sts.send(new GetCallerIdentityCommand({}));
    scan.meta.accountId = who.Account;
    if (who.Arn) scan.meta.partition = partitionOf(who.Arn);
  } catch (e) { /* non-fatal */ }

  // Discovery runs across all regions before any enrichment, for two reasons:
  // enrichment can then resolve edges whose target lives in a region scanned
  // later (previously those were dropped depending on region order), and the
  // tagging-API calls parallelise cleanly since each returns an independent list.
  const discovered = await mapLimit(regions, REGION_CONCURRENCY, async region => {
    try {
      return { region, items: await getTaggedResources(region, tagKey, tagValue, authOf(args)) };
    } catch (e) {
      console.error(`  ! region ${region} discovery failed: ${e.message}`);
      return { region, items: [] };
    }
  });

  const seen = new Set();
  for (const { region, items } of discovered) {
    console.error(`  - region ${region}: ${items.length} tagged`);
    for (const item of items) {
      if (seen.has(item.arn)) continue;
      seen.add(item.arn);
      const a = parseArn(item.arn);
      if (!scan.meta.partition && a.partition) scan.meta.partition = a.partition;
      scan.resources.push({
        arn: item.arn, service: a.service, type: a.type, id: a.id,
        region: a.region || region, account: a.account, partition: a.partition,
        name: nameFromTags(item.tags) || a.id,
        tags: Object.fromEntries((item.tags || []).map(t => [t.Key, t.Value])),
        extra: {},
      });
    }
  }

  // Account / VPC scope: the tagging API cannot see untagged resources, so
  // also list the common architecture services directly.
  if (!tagKey) {
    console.error('  • listing untagged resources in common services');
    await mapLimit(regions, REGION_CONCURRENCY, async region => {
      try {
        const opts = { region, ...creds(authOf(args)) };
        const before = scan.resources.length;
        await discoverUntagged(region, scan, {
          withRetry,
          upsert: r => {
            if (!r?.arn || seen.has(r.arn)) return;
            seen.add(r.arn);
            scan.resources.push(r);
          },
          client: clientFactories(opts, retrying),
        });
        const added = scan.resources.length - before;
        if (added) console.error(`  - region ${region}: +${added} untagged`);
      } catch (e) {
        console.error(`  ! untagged discover ${region}: ${e.message}`);
      }
    });
  }

  // Only regions that actually turned something up need the (expensive)
  // enrichment fan-out — an all-regions sweep is mostly empty regions.
  const populated = [...new Set(scan.resources.map(r => r.region))]
    .filter(r => regions.includes(r));
  await mapLimit(populated, REGION_CONCURRENCY, async region => {
    try {
      await enrichRegion(region, scan, authOf(args));
    } catch (e) {
      console.error(`  ! region ${region} enrich failed: ${e.message}`);
    }
  });
  // Concurrent enrichment can race the per-region "already have this edge"
  // checks, so collapse duplicates once at the end.
  scan.edges = dedupeEdges(scan.edges);

  // VPC scope: keep only resources that live in the chosen VPC.
  if (args.vpcId) {
    const vid = args.vpcId;
    const keep = new Set();
    for (const r of scan.resources) {
      const sn = r.subnetId && scan.subnets[r.subnetId];
      if (((sn && sn.vpcId) || r.vpcId) === vid) keep.add(r.arn);
    }
    const inet = id => id === 'internet' || id === 'internet-egress';
    scan.edges = scan.edges.filter(e =>
      (keep.has(e.from) || inet(e.from)) && (keep.has(e.to) || inet(e.to)));
    if (scan.edges.some(e => e.from === 'internet' || e.to === 'internet')) keep.add('internet');
    if (scan.edges.some(e => e.from === 'internet-egress' || e.to === 'internet-egress')) keep.add('internet-egress');
    scan.resources = scan.resources.filter(r => keep.has(r.arn));
    scan.vpcs = Object.fromEntries(Object.entries(scan.vpcs).filter(([k]) => k === vid));
    scan.meta.vpcId = vid;
  }
  scan.meta.scope = args.tag ? 'tag' : (args.vpcId ? 'vpc' : 'account');

  return scan;
}

/** List VPCs visible to the given credentials (for the web UI's VPC picker). */
export async function listVpcs(input) {
  const args = await assumeRoleIfRequested(input);
  const regions = await resolveRegions(args);
  const perRegion = await mapLimit(regions, REGION_CONCURRENCY, async region => {
    try {
      const ec2 = retrying(new EC2Client({ region, ...creds(authOf(args)) }));
      const vpcs = await drain(
        NextToken => ec2.send(new DescribeVpcsCommand({ NextToken })),
        p => p.Vpcs,
        { nextKey: 'NextToken' },
      );
      return vpcs.map(v => ({
        id: v.VpcId, region, cidr: v.CidrBlock,
        name: nameFromTags(v.Tags) || v.VpcId, isDefault: !!v.IsDefault,
      }));
    } catch (e) {
      console.error(`  ! DescribeVpcs ${region}: ${e.message}`);
      return [];
    }
  });
  return perRegion.flat();
}

/** Validate credentials and return the caller's account/ARN. Throws on failure. */
export async function whoAmI(input) {
  const args = await assumeRoleIfRequested(input);
  const region = args.region?.[0] || 'us-east-1';
  const sts = retrying(new STSClient({ region, ...creds(authOf(args)) }));
  const r = await sts.send(new GetCallerIdentityCommand({}));
  return { accountId: r.Account, arn: r.Arn };
}

async function getTaggedResources(region, tagKey, tagValue, auth) {
  const client = retrying(new ResourceGroupsTaggingAPIClient({ region, ...creds(auth) }));
  const out = [];
  let PaginationToken;
  do {
    const cmd = new GetResourcesCommand({
      // No tag key -> return every tagged resource in the region (account/VPC
      // scope). The tagging API only sees resources that carry at least one tag.
      ...(tagKey ? { TagFilters: [{ Key: tagKey, ...(tagValue ? { Values: [tagValue] } : {}) }] } : {}),
      ResourcesPerPage: 100,
      PaginationToken: PaginationToken || undefined,
    });
    let resp;
    try {
      resp = await client.send(cmd);
    } catch (e) {
      console.error(`    ! tagging API error in ${region}: ${e.message}`);
      break;
    }
    for (const m of resp.ResourceTagMappingList || []) {
      out.push({ arn: m.ResourceARN, tags: m.Tags });
    }
    PaginationToken = resp.PaginationToken;
  } while (PaginationToken);
  return out;
}

/** Well-known port -> protocol label, used for security-group flow edges. */
const PORTS = {
  // classic services
  20: 'FTP', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS',
  69: 'TFTP', 88: 'Kerberos', 110: 'POP3', 111: 'rpcbind', 123: 'NTP',
  135: 'MS-RPC', 137: 'NetBIOS', 138: 'NetBIOS', 139: 'NetBIOS',
  143: 'IMAP', 161: 'SNMP', 162: 'SNMP-trap', 179: 'BGP', 389: 'LDAP',
  443: 'HTTPS', 445: 'SMB', 465: 'SMTPS', 500: 'IPsec-IKE', 513: 'rlogin',
  514: 'syslog', 515: 'LPD', 554: 'RTSP', 587: 'SMTP', 631: 'IPP',
  636: 'LDAPS', 853: 'DNS-TLS', 873: 'rsync', 989: 'FTPS', 990: 'FTPS',
  993: 'IMAPS', 995: 'POP3S', 1080: 'SOCKS', 1194: 'OpenVPN', 1723: 'PPTP',
  1812: 'RADIUS', 1813: 'RADIUS', 2222: 'SSH-alt', 3389: 'RDP',
  5060: 'SIP', 5061: 'SIP-TLS', 5900: 'VNC', 5901: 'VNC',
  5985: 'WinRM', 5986: 'WinRM-S', 6514: 'syslog-TLS', 6667: 'IRC', 9418: 'git',
  // databases & caches
  1433: 'MSSQL', 1434: 'MSSQL-browser', 1521: 'Oracle', 2483: 'Oracle',
  2484: 'Oracle-TLS', 3306: 'MySQL', 5432: 'PostgreSQL', 5439: 'Redshift',
  5984: 'CouchDB', 6379: 'Redis', 7473: 'Neo4j', 7474: 'Neo4j', 7687: 'Neo4j-Bolt',
  8086: 'InfluxDB', 8123: 'ClickHouse', 9042: 'Cassandra', 9160: 'Cassandra',
  11211: 'Memcached', 27017: 'MongoDB', 27018: 'MongoDB', 27019: 'MongoDB',
  28015: 'RethinkDB', 33060: 'MySQL-X',
  // messaging & streaming
  1883: 'MQTT', 4222: 'NATS', 5222: 'XMPP', 5269: 'XMPP', 5671: 'AMQPS',
  5672: 'AMQP', 8883: 'MQTT-TLS', 9092: 'Kafka', 15672: 'RabbitMQ-mgmt',
  61613: 'STOMP', 61616: 'ActiveMQ',
  // storage & filesystems
  2049: 'NFS', 3260: 'iSCSI', 9000: 'MinIO/HTTP',
  // container / orchestration / infra
  2181: 'ZooKeeper', 2375: 'Docker', 2376: 'Docker-TLS', 2379: 'etcd',
  2380: 'etcd-peer', 3128: 'Squid', 4369: 'EPMD', 4789: 'VXLAN',
  6443: 'K8s-API', 8200: 'Vault', 8300: 'Consul', 8301: 'Consul',
  8302: 'Consul', 8500: 'Consul-HTTP', 10250: 'kubelet', 10256: 'kube-proxy',
  // observability
  3100: 'Loki', 4317: 'OTLP-gRPC', 4318: 'OTLP-HTTP', 5044: 'Beats',
  5601: 'Kibana', 6831: 'Jaeger', 8125: 'StatsD', 9090: 'Prometheus',
  9093: 'Alertmanager', 9100: 'node-exporter', 9200: 'OpenSearch',
  9300: 'OpenSearch-node', 9411: 'Zipkin', 12201: 'GELF', 14268: 'Jaeger',
  24224: 'Fluentd',
  // common app/http ports
  3000: 'HTTP', 4000: 'HTTP', 5000: 'HTTP', 8000: 'HTTP', 8080: 'HTTP',
  8081: 'HTTP', 8443: 'HTTPS', 8888: 'HTTP', 9443: 'HTTPS',
};
function portLabel(from, to, proto) {
  if (proto === '-1' || proto === -1) return 'all traffic';
  if (from == null) return String(proto || '').toUpperCase();
  if (from === to) return PORTS[from] ? `${PORTS[from]} :${from}` : `:${from}`;
  return `:${from}-${to}`;
}

/* --- IPv4 / CIDR helpers, for security-group rules expressed as CIDR ranges --- */
function ipToInt(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some(n => Number.isNaN(n))) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function parseCidr(cidr) {
  const [ip, bitsStr] = String(cidr).split('/');
  const base = ipToInt(ip);
  if (base == null) return null;
  const bits = bitsStr == null ? 32 : parseInt(bitsStr, 10);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { net: (base & mask) >>> 0, mask, bits };
}
function ipInCidr(ip, cidr) {
  const a = ipToInt(ip), c = parseCidr(cidr);
  if (a == null || !c) return false;
  return ((a & c.mask) >>> 0) === c.net;
}
/** True if the two CIDR ranges overlap at all. */
function cidrsOverlap(a, b) {
  const x = parseCidr(a), y = parseCidr(b);
  if (!x || !y) return false;
  const mask = x.bits < y.bits ? x.mask : y.mask;
  return ((x.net & mask) >>> 0) === ((y.net & mask) >>> 0);
}

/** Enrich one region: EC2/VPC/subnet, NAT/IGW, ELBv2, RDS, ElastiCache, EFS,
 *  Lambda, Auto Scaling — plus security-group-based traffic-flow edges. */
async function enrichRegion(region, scan, auth) {
  const inRegion = scan.resources.filter(r => r.region === region);
  const byId = new Map();
  for (const r of scan.resources) {
    byId.set(idKey(r.region, r.id), r);
    if (/^(i-|nat-|igw-)/.test(r.id)) byId.set(r.id, r);
  }
  const findById = id => byId.get(idKey(region, id)) || byId.get(id);
  const byArn = new Map(scan.resources.map(r => [r.arn, r]));
  const opts = { region, ...creds(auth) };
  const ec2 = retrying(new EC2Client(opts));
  const upsert = r => {
    if (!r?.arn) return;
    if (byArn.has(r.arn)) return byArn.get(r.arn);
    scan.resources.push(r);
    byArn.set(r.arn, r);
    byId.set(idKey(r.region, r.id), r);
    if (/^(i-|nat-|igw-)/.test(r.id)) byId.set(r.id, r);
    return r;
  };

  // Track which security groups each resource belongs to, so we can turn
  // SG-to-SG ingress rules into resource-to-resource edges later.
  const sgToResources = new Map();   // sgId -> Set<arn>
  const attachSG = (res, sgs) => {
    const clean = (sgs || []).filter(Boolean);
    if (!clean.length) return;
    res.extra.securityGroups = [...new Set([...(res.extra.securityGroups || []), ...clean])];
    for (const g of clean) {
      if (!sgToResources.has(g)) sgToResources.set(g, new Set());
      sgToResources.get(g).add(res.arn);
    }
  };
  const seenEdge = new Set(scan.edges.map(e => `${e.from}|${e.to}|${e.label}`));
  const addEdge = (from, to, label, kind) => {
    if (from === to) return;
    const k = `${from}|${to}|${label}`;
    if (seenEdge.has(k)) return;
    seenEdge.add(k);
    scan.edges.push({ from, to, label, kind });
  };

  // Resource-policy analysis shared by the S3/SQS/SNS/Lambda passes.
  const oaiMap = new Map();   // CloudFront OAI id -> distribution ARN
  const applyPolicy = (doc, resource) => {
    const { edges: found, publicPolicy } = extractPolicyEdges(
      doc, resource.arn,
      arn => byArn.has(arn),
      pattern => {
        const re = arnGlob(pattern);
        return scan.resources.filter(r => re.test(r.arn)).map(r => r.arn);
      },
      id => oaiMap.get(id),
    );
    for (const e of found) {
      // avoid a second parallel edge when e.g. an SNS subscription already
      // produced a connector between the same pair
      if (scan.edges.some(x => x.from === e.from && x.to === e.to)) continue;
      addEdge(e.from, e.to, e.label, e.kind);
    }
    if (publicPolicy) resource.extra.publicPolicy = publicPolicy;
  };

  // ---- EC2 instances + their VPC/subnet ----
  const instanceIds = inRegion.filter(r => r.service === 'ec2' && r.type === 'instance').map(r => r.id);
  const vpcIds = new Set(), subnetIds = new Set();
  if (instanceIds.length) {
    try {
      for (const batch of chunk(instanceIds, 100)) {
        const reservations = await drain(
          NextToken => ec2.send(new DescribeInstancesCommand({ InstanceIds: batch, NextToken })),
          p => p.Reservations,
          { nextKey: 'NextToken' },
        );
        for (const res of reservations) for (const inst of res.Instances || []) {
          const node = findById(inst.InstanceId);
          if (!node) continue;
          node.vpcId = inst.VpcId; node.subnetId = inst.SubnetId; node.az = inst.Placement?.AvailabilityZone;
          node.state = inst.State?.Name;
          node.extra.privateIp = inst.PrivateIpAddress;
          const v6 = (inst.NetworkInterfaces || []).flatMap(n =>
            (n.Ipv6Addresses || []).map(a => a.Ipv6Address)).filter(Boolean);
          if (inst.Ipv6Address) v6.push(inst.Ipv6Address);
          if (v6.length) node.extra.ipv6Addresses = [...new Set(v6)];
          node.extra.instanceType = inst.InstanceType;
          node.extra.instanceProfileArn = inst.IamInstanceProfile?.Arn;
          node.extra.imageId = inst.ImageId;
          node.extra.platform = inst.Platform;
          node.extra.platformDetails = inst.PlatformDetails;
          attachSG(node, (inst.SecurityGroups || []).map(s => s.GroupId));
          if (inst.VpcId) vpcIds.add(inst.VpcId);
          if (inst.SubnetId) subnetIds.add(inst.SubnetId);
        }
      }
    } catch (e) { console.error(`    ! EC2 describe error: ${e.message}`); }
  }

  // ---- AMI metadata for OS detection ----
  const imageIds = [...new Set(
    inRegion.filter(r => r.service === 'ec2' && r.type === 'instance' && r.extra?.imageId)
      .map(r => r.extra.imageId),
  )];
  const amiMeta = new Map();
  if (imageIds.length) {
    try {
      for (const batch of chunk(imageIds, 100)) {
        const images = await drain(
          NextToken => ec2.send(new DescribeImagesCommand({ ImageIds: batch, NextToken })),
          p => p.Images,
          { nextKey: 'NextToken' },
        );
        for (const img of images) {
          amiMeta.set(img.ImageId, {
            name: img.Name,
            description: img.Description,
            platform: img.Platform,
            platformDetails: img.PlatformDetails,
          });
        }
      }
    } catch (e) { console.error(`    ! AMI describe error: ${e.message}`); }
  }
  for (const r of inRegion) {
    if (r.service !== 'ec2' || r.type !== 'instance' || !r.extra?.imageId) continue;
    const ami = amiMeta.get(r.extra.imageId);
    if (ami) {
      r.extra.amiName = ami.name;
      r.extra.amiDescription = ami.description;
      if (!r.extra.platform) r.extra.platform = ami.platform;
      if (!r.extra.platformDetails) r.extra.platformDetails = ami.platformDetails;
    }
    r.extra.os = detectOs({
      imageId: r.extra.imageId,
      platform: r.extra.platform,
      platformDetails: r.extra.platformDetails,
      amiName: r.extra.amiName,
      amiDescription: r.extra.amiDescription,
    });
  }

  // Also pull VPC/subnet ids for any tagged vpc/subnet resources.
  for (const r of inRegion) {
    if (r.service === 'ec2' && r.type === 'vpc') vpcIds.add(r.id);
    if (r.service === 'ec2' && r.type === 'subnet') { subnetIds.add(r.id); }
  }

  if (vpcIds.size) {
    try {
      const r = await ec2.send(new DescribeVpcsCommand({ VpcIds: [...vpcIds] }));
      for (const v of r.Vpcs || []) {
        scan.vpcs[v.VpcId] = {
          id: v.VpcId, region, cidr: v.CidrBlock,
          name: nameFromTags(v.Tags) || v.VpcId,
        };
      }
    } catch (e) { console.error(`    ! VPC describe error: ${e.message}`); }
  }
  if (subnetIds.size) {
    try {
      const r = await ec2.send(new DescribeSubnetsCommand({ SubnetIds: [...subnetIds] }));
      for (const s of r.Subnets || []) {
        scan.subnets[s.SubnetId] = {
          id: s.SubnetId, vpcId: s.VpcId, az: s.AvailabilityZone, cidr: s.CidrBlock,
          public: !!s.MapPublicIpOnLaunch,
          name: nameFromTags(s.Tags) || s.SubnetId,
        };
        if (s.VpcId && !scan.vpcs[s.VpcId]) {
          scan.vpcs[s.VpcId] = { id: s.VpcId, region, cidr: '', name: s.VpcId };
        }
      }
    } catch (e) { console.error(`    ! Subnet describe error: ${e.message}`); }
  }

  // ---- NAT gateways -> place in their subnet/VPC ----
  const natIds = inRegion.filter(r => r.service === 'ec2' && r.type === 'natgateway').map(r => r.id);
  if (natIds.length) {
    try {
      const r = await ec2.send(new DescribeNatGatewaysCommand({ NatGatewayIds: natIds }));
      for (const nat of r.NatGateways || []) {
        const node = findById(nat.NatGatewayId);
        if (!node) continue;
        node.vpcId = nat.VpcId; node.subnetId = nat.SubnetId;
      }
    } catch (e) { console.error(`    ! NAT describe error: ${e.message}`); }
  }

  // ---- Internet gateways -> place in their VPC ----
  const igwIds = inRegion.filter(r => r.service === 'ec2' && r.type === 'internet-gateway').map(r => r.id);
  if (igwIds.length) {
    try {
      const r = await ec2.send(new DescribeInternetGatewaysCommand({ InternetGatewayIds: igwIds }));
      for (const igw of r.InternetGateways || []) {
        const node = findById(igw.InternetGatewayId);
        if (node) node.vpcId = igw.Attachments?.[0]?.VpcId;
      }
    } catch (e) { console.error(`    ! IGW describe error: ${e.message}`); }
  }

  // ---- ELBv2 load balancers -> targets ----
  const tgToLb = new Map();   // target-group ARN -> LB ARN (used by the ECS pass)
  // IP-mode / pod-backed target groups report an address, not an instance id.
  const byIp = new Map();
  for (const r of scan.resources) {
    if (r.extra?.privateIp) byIp.set(r.extra.privateIp, r);
    for (const ip of r.extra?.ipv6Addresses || []) byIp.set(ip, r);
  }
  // LBs whose targets were only IPs we could not place — linked to an EKS
  // cluster in the same VPC after that cluster's VPC is known.
  const pendingIpLbs = [];
  const lbArns = inRegion.filter(r => r.service === 'elasticloadbalancing' && r.type === 'loadbalancer').map(r => r.arn);
  if (lbArns.length) {
    try {
      const elb = retrying(new ElasticLoadBalancingV2Client(opts));
      // DescribeLoadBalancers accepts at most 20 ARNs per request and rejects
      // the whole call if you exceed it.
      const loadBalancers = [];
      for (const batch of chunk(lbArns, 20)) {
        loadBalancers.push(...await drain(
          Marker => elb.send(new DescribeLoadBalancersCommand({ LoadBalancerArns: batch, Marker })),
          p => p.LoadBalancers,
        ));
      }
      for (const lb of loadBalancers) {
        const node = byArn.get(lb.LoadBalancerArn);
        if (node) {
          node.vpcId = lb.VpcId; node.extra.scheme = lb.Scheme; node.extra.dns = lb.DNSName; node.extra.lbType = lb.Type;
          attachSG(node, lb.SecurityGroups);
        }
        const targetGroups = await drain(
          Marker => elb.send(new DescribeTargetGroupsCommand({ LoadBalancerArn: lb.LoadBalancerArn, Marker })),
          p => p.TargetGroups,
        );
        let ipMiss = 0;
        for (const tg of targetGroups) {
          tgToLb.set(tg.TargetGroupArn, lb.LoadBalancerArn);
          const health = await elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: tg.TargetGroupArn }));
          for (const th of health.TargetHealthDescriptions || []) {
            const tid = th.Target?.Id;
            if (!tid) continue;
            let target = resolveLbTarget(tid, { byId, byArn, byIp, region });
            if (!target && /^i-/.test(tid)) target = ensureExternalInstance(scan, byId, tid, region);
            if (target) addEdge(lb.LoadBalancerArn, target.arn, tg.Protocol || 'forwards', 'lb-target');
            else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tid)) ipMiss++;
          }
        }
        if (ipMiss && (node?.vpcId || lb.VpcId)) {
          pendingIpLbs.push({ lbArn: lb.LoadBalancerArn, vpcId: node?.vpcId || lb.VpcId });
        }
      }
    } catch (e) { console.error(`    ! ELBv2 enrich error: ${e.message}`); }
  }

  // ---- RDS instances ----
  const dbHasRds = inRegion.some(r => r.service === 'rds');
  if (dbHasRds) {
    try {
      const rds = retrying(new RDSClient(opts));
      const instances = await drain(
        Marker => rds.send(new DescribeDBInstancesCommand({ Marker })),
        p => p.DBInstances,
      );
      for (const db of instances) {
        const node = scan.resources.find(n => n.service === 'rds' && (n.id === db.DBInstanceIdentifier || n.arn === db.DBInstanceArn));
        if (!node) continue;
        node.vpcId = db.DBSubnetGroup?.VpcId;
        node.extra.engine = db.Engine;
        node.extra.endpoint = db.Endpoint?.Address;
        node.extra.multiAz = db.MultiAZ;
        const sn = db.DBSubnetGroup?.Subnets?.[0]?.SubnetIdentifier;
        if (sn) node.subnetId = sn;
        attachSG(node, (db.VpcSecurityGroups || []).map(g => g.VpcSecurityGroupId));
      }
    } catch (e) { console.error(`    ! RDS enrich error: ${e.message}`); }
  }

  // ---- ElastiCache clusters -> VPC/subnet + SGs ----
  const cacheNodes = inRegion.filter(r => r.service === 'elasticache' && r.type === 'cluster');
  if (cacheNodes.length) {
    try {
      const ecc = retrying(new ElastiCacheClient(opts));
      const clusters = await drain(
        Marker => ecc.send(new DescribeCacheClustersCommand({ ShowCacheNodeInfo: false, Marker })),
        p => p.CacheClusters,
      );
      const subnetGroupCache = new Map();
      for (const cc of clusters) {
        const node = cacheNodes.find(n => n.id === cc.CacheClusterId || cc.ARN === n.arn);
        if (!node) continue;
        node.extra.engine = cc.Engine;
        attachSG(node, (cc.SecurityGroups || []).map(g => g.SecurityGroupId));
        const sgName = cc.CacheSubnetGroupName;
        if (sgName) {
          if (!subnetGroupCache.has(sgName)) {
            try {
              const sg = await ecc.send(new DescribeCacheSubnetGroupsCommand({ CacheSubnetGroupName: sgName }));
              subnetGroupCache.set(sgName, sg.CacheSubnetGroups?.[0]);
            } catch { subnetGroupCache.set(sgName, null); }
          }
          const grp = subnetGroupCache.get(sgName);
          if (grp) { node.vpcId = grp.VpcId; node.subnetId = grp.Subnets?.[0]?.SubnetIdentifier; }
        }
      }
    } catch (e) { console.error(`    ! ElastiCache enrich error: ${e.message}`); }
  }

  // ---- EFS file systems -> VPC/subnet (via mount targets) + SGs ----
  const efsNodes = inRegion.filter(r => r.service === 'elasticfilesystem' && r.type === 'file-system');
  if (efsNodes.length) {
    try {
      const efs = retrying(new EFSClient(opts));
      for (const node of efsNodes) {
        try {
          const mt = await efs.send(new DescribeMountTargetsCommand({ FileSystemId: node.id }));
          const first = mt.MountTargets?.[0];
          if (first) {
            node.vpcId = first.VpcId; node.subnetId = first.SubnetId;
            try {
              const sgs = await efs.send(new DescribeMountTargetSecurityGroupsCommand({ MountTargetId: first.MountTargetId }));
              attachSG(node, sgs.SecurityGroups);
            } catch { /* ignore */ }
          }
        } catch { /* skip individual */ }
      }
    } catch (e) { console.error(`    ! EFS enrich error: ${e.message}`); }
  }

  // ---- Lambda VPC config + SGs ----
  const fns = inRegion.filter(r => r.service === 'lambda' && r.type === 'function');
  if (fns.length) {
    try {
      const lambda = retrying(new LambdaClient(opts));
      for (const fn of fns) {
        try {
          const c = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: fn.id }));
          if (c.VpcConfig?.VpcId) { fn.vpcId = c.VpcConfig.VpcId; fn.subnetId = c.VpcConfig.SubnetIds?.[0]; }
          fn.extra.runtime = c.Runtime; fn.extra.memory = c.MemorySize;
          fn.extra.roleArn = c.Role;
          attachSG(fn, c.VpcConfig?.SecurityGroupIds);
        } catch { /* skip individual */ }
      }
    } catch (e) { console.error(`    ! Lambda enrich error: ${e.message}`); }
  }

  // ---- Auto Scaling groups -> instances ----
  const asgs = inRegion.filter(r => r.service === 'autoscaling' && /autoScalingGroup/i.test(r.type));
  if (asgs.length) {
    try {
      const as = retrying(new AutoScalingClient(opts));
      const names = asgs.map(r => r.name || r.id.split('/').pop());
      const groups = [];
      for (const batch of chunk(names, 50)) {
        groups.push(...await drain(
          NextToken => as.send(new DescribeAutoScalingGroupsCommand({
            AutoScalingGroupNames: batch, NextToken,
          })),
          p => p.AutoScalingGroups,
          { nextKey: 'NextToken' },
        ));
      }
      for (const g of groups) {
        const node = asgs.find(x => (x.name || x.id).includes(g.AutoScalingGroupName));
        if (!node) continue;
        for (const inst of g.Instances || []) {
          const target = findById(inst.InstanceId) || ensureExternalInstance(scan, byId, inst.InstanceId, region);
          addEdge(node.arn, target.arn, 'scales', 'asg-member');
        }
      }
    } catch (e) { console.error(`    ! AutoScaling enrich error: ${e.message}`); }
  }

  // ---- ECS services -> VPC/subnet + SGs + LB edges ----
  const ecsServices = inRegion.filter(r => r.service === 'ecs' && r.type === 'service');
  if (ecsServices.length) {
    try {
      const ecs = retrying(new ECSClient(opts));
      const byCluster = new Map();   // cluster name -> [service resources]
      for (const svc of ecsServices) {
        // arn:aws:ecs:region:acct:service/<cluster>/<service>
        const parts = svc.id.split('/');
        const cluster = parts.length > 1 ? parts[0] : 'default';
        if (!byCluster.has(cluster)) byCluster.set(cluster, []);
        byCluster.get(cluster).push(svc);
      }
      for (const [cluster, svcs] of byCluster) {
        for (let i = 0; i < svcs.length; i += 10) {
          const chunk = svcs.slice(i, i + 10);
          const r = await ecs.send(new DescribeServicesCommand({
            cluster, services: chunk.map(s => s.arn),
          }));
          for (const s of r.services || []) {
            const node = byArn.get(s.serviceArn);
            if (!node) continue;
            node.extra.launchType = s.launchType;
            node.extra.desiredCount = s.desiredCount;
            const cfg = s.networkConfiguration?.awsvpcConfiguration;
            if (cfg) {
              node.subnetId = cfg.subnets?.[0];
              for (const sn of cfg.subnets || []) subnetIds.add(sn);
              attachSG(node, cfg.securityGroups);
            }
            for (const lb of s.loadBalancers || []) {
              const lbArn = tgToLb.get(lb.targetGroupArn);
              if (lbArn) addEdge(lbArn, s.serviceArn, 'forwards', 'lb-target');
            }
            const part = node.partition || scan.meta.partition || 'aws';
            const clusterArn = `arn:${part}:ecs:${region}:${scan.meta.accountId || s.serviceArn.split(':')[4]}:cluster/${cluster}`;
            if (byArn.has(clusterArn)) addEdge(clusterArn, s.serviceArn, 'runs', 'asg-member');
          }
        }
      }
    } catch (e) { console.error(`    ! ECS enrich error: ${e.message}`); }
  }

  // ---- EKS clusters -> VPC/subnet + SGs ----
  const eksClusters = inRegion.filter(r => r.service === 'eks' && r.type === 'cluster');
  if (eksClusters.length) {
    try {
      const eks = retrying(new EKSClient(opts));
      for (const c of eksClusters) {
        try {
          const r = await eks.send(new DescribeClusterCommand({ name: c.id.split('/').pop() }));
          const cfg = r.cluster?.resourcesVpcConfig;
          if (cfg) {
            c.vpcId = cfg.vpcId;
            c.subnetId = cfg.subnetIds?.[0];
            for (const sn of cfg.subnetIds || []) subnetIds.add(sn);
            attachSG(c, [...(cfg.securityGroupIds || []), cfg.clusterSecurityGroupId]);
          }
          c.extra.version = r.cluster?.version;
        } catch { /* skip individual */ }
      }
    } catch (e) { console.error(`    ! EKS enrich error: ${e.message}`); }
  }
  // IP-mode target groups on EKS never name an instance. Once the cluster
  // has a VPC, draw one LB → cluster edge so the hop is not silently dropped.
  for (const pending of pendingIpLbs) {
    const cluster = eksClusters.find(c => c.vpcId && c.vpcId === pending.vpcId);
    if (cluster) addEdge(pending.lbArn, cluster.arn, 'forwards (pods)', 'lb-target');
  }

  // ---- Lambda event-source mappings + resource policy -> function edges ----
  if (fns.length) {
    try {
      const lambda = retrying(new LambdaClient(opts));
      for (const fn of fns) {
        try {
          const mappings = await drain(
            Marker => lambda.send(new ListEventSourceMappingsCommand({ FunctionName: fn.id, Marker })),
            p => p.EventSourceMappings,
            { nextKey: 'NextMarker' },
          );
          for (const m of mappings) {
            const src = m.EventSourceArn && byArn.get(m.EventSourceArn);
            if (src) addEdge(src.arn, fn.arn, 'triggers', 'event');
          }
        } catch { /* skip individual */ }
        // resource policy: who may invoke (S3, SNS, EventBridge, API Gateway…)
        try {
          const p = await lambda.send(new GetLambdaPolicyCommand({ FunctionName: fn.id }));
          if (p.Policy) applyPolicy(JSON.parse(p.Policy), fn);
        } catch { /* no policy */ }
      }
    } catch (e) { console.error(`    ! Lambda event-source error: ${e.message}`); }
  }

  // ---- SQS queue policies: who may send here (SNS, S3, EventBridge, …) ----
  const queues = inRegion.filter(r => r.service === 'sqs');
  if (queues.length) {
    try {
      const sqs = retrying(new SQSClient(opts));
      for (const q of queues) {
        try {
          const QueueUrl = sqsQueueUrl(
            q.partition || scan.meta.partition || 'aws',
            region, q.account || scan.meta.accountId, q.id,
          );
          const r = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['Policy'] }));
          if (r.Attributes?.Policy) applyPolicy(JSON.parse(r.Attributes.Policy), q);
        } catch { /* skip individual */ }
      }
    } catch (e) { console.error(`    ! SQS policy error: ${e.message}`); }
  }

  // ---- SNS subscriptions: topic -> SQS queue / Lambda function ----
  const topics = inRegion.filter(r => r.service === 'sns');
  if (topics.length) {
    try {
      const sns = retrying(new SNSClient(opts));
      for (const t of topics) {
        try {
          let NextToken;
          do {
            const r = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: t.arn, NextToken }));
            for (const sub of r.Subscriptions || []) {
              const target = sub.Endpoint && byArn.get(sub.Endpoint);
              if (target) addEdge(t.arn, target.arn, 'notifies', 'event');
            }
            NextToken = r.NextToken;
          } while (NextToken);
        } catch { /* skip individual */ }
        // topic policy: who may publish here (S3 events, EventBridge, …)
        try {
          const attrs = await sns.send(new GetTopicAttributesCommand({ TopicArn: t.arn }));
          if (attrs.Attributes?.Policy) applyPolicy(JSON.parse(attrs.Attributes.Policy), t);
        } catch { /* skip individual */ }
      }
    } catch (e) { console.error(`    ! SNS enrich error: ${e.message}`); }
  }

  // ---- CloudFront distributions -> origins (S3 / ALB / custom), by behavior ----
  const cfDists = inRegion.filter(r => r.service === 'cloudfront' && r.type === 'distribution');
  if (cfDists.length) {
    try {
      const cf = retrying(new CloudFrontClient({ region: 'us-east-1', ...creds(auth) }));   // CloudFront is global
      for (const dist of cfDists) {
        try {
          const r = await cf.send(new GetDistributionCommand({ Id: dist.id }));
          const cfg = r.Distribution?.DistributionConfig;
          if (!cfg) continue;
          dist.extra.domain = r.Distribution.DomainName;
          dist.extra.aliases = cfg.Aliases?.Items || [];
          dist.extra.enabled = cfg.Enabled;

          // origin id -> path patterns that route to it (cache behaviors)
          const patterns = new Map();
          const addPat = (originId, pat) => {
            if (!patterns.has(originId)) patterns.set(originId, []);
            patterns.get(originId).push(pat);
          };
          if (cfg.DefaultCacheBehavior) addPat(cfg.DefaultCacheBehavior.TargetOriginId, 'default (*)');
          for (const b of cfg.CacheBehaviors?.Items || []) addPat(b.TargetOriginId, b.PathPattern);

          for (const o of cfg.Origins?.Items || []) {
            // record legacy OAI ids so bucket policies can be attributed
            const oai = o.S3OriginConfig?.OriginAccessIdentity;
            if (oai) oaiMap.set(String(oai).split('/').pop(), dist.arn);
            const label = (patterns.get(o.Id) || ['origin']).slice(0, 3).join(' · ');
            const dom = String(o.DomainName || '');
            const s3Match = dom.match(/^([a-z0-9.-]+)\.s3[.-]/i)
              || dom.match(/^([a-z0-9.-]+)\.s3\.amazonaws\.com(\.cn)?$/i);
            if (s3Match) {
              const bucketArn = s3BucketArn(dist.partition || scan.meta.partition || 'aws', s3Match[1]);
              if (byArn.has(bucketArn)) {
                addEdge(dist.arn, bucketArn, label, 'origin');
                continue;
              }
            }
            // custom origins: match against scanned load balancer DNS names
            const lb = scan.resources.find(x => x.extra?.dns && dom.toLowerCase() === x.extra.dns.toLowerCase());
            if (lb) addEdge(dist.arn, lb.arn, label, 'origin');
          }
          // A distribution is internet-facing by definition.
          addEdge('internet', dist.arn, 'HTTPS', 'internet');
          markInternetUsed(scan, byArn, region);
        } catch (e) { console.error(`    ! CloudFront ${dist.id}: ${e.message}`); }
      }
    } catch (e) { console.error(`    ! CloudFront enrich error: ${e.message}`); }
  }

  // ---- S3 buckets: event notifications + bucket-policy analysis ----
  const buckets = inRegion.filter(r => r.service === 's3' && !r.type);
  if (buckets.length) {
    try {
      const s3 = retrying(new S3Client({ region, followRegionRedirects: true, ...creds(auth) }));
      for (const b of buckets) {
        // notifications -> Lambda / SQS / SNS event edges
        try {
          const n = await s3.send(new GetBucketNotificationConfigurationCommand({ Bucket: b.id }));
          const evLabel = evs => [...new Set((evs || []).map(e =>
            String(e).replace(/^s3:/, '').replace(/:\*$/, '')))].slice(0, 2).join(' · ') || 'event';
          for (const c of n.LambdaFunctionConfigurations || []) {
            if (byArn.has(c.LambdaFunctionArn)) addEdge(b.arn, c.LambdaFunctionArn, evLabel(c.Events), 'event');
          }
          for (const c of n.QueueConfigurations || []) {
            if (byArn.has(c.QueueArn)) addEdge(b.arn, c.QueueArn, evLabel(c.Events), 'event');
          }
          for (const c of n.TopicConfigurations || []) {
            if (byArn.has(c.TopicArn)) addEdge(b.arn, c.TopicArn, evLabel(c.Events), 'event');
          }
        } catch { /* no notification config or no permission */ }

        // bucket policy -> connectors (CloudFront OAC/OAI, log delivery,
        // cross-service grants via aws:SourceArn) + public-bucket detection
        try {
          const p = await s3.send(new GetBucketPolicyCommand({ Bucket: b.id }));
          applyPolicy(JSON.parse(p.Policy || '{}'), b);
        } catch { /* no policy or no permission */ }
      }
    } catch (e) { console.error(`    ! S3 enrich error: ${e.message}`); }
  }

  // ---- ACM certificates -> whatever uses them (ALBs, CloudFront, …) ----
  const certs = inRegion.filter(r => r.service === 'acm' && r.type === 'certificate');
  if (certs.length) {
    try {
      const acm = retrying(new ACMClient(opts));
      for (const c of certs) {
        try {
          const r = await acm.send(new DescribeCertificateCommand({ CertificateArn: c.arn }));
          c.extra.domain = r.Certificate?.DomainName;
          c.extra.status = r.Certificate?.Status;
          if (r.Certificate?.DomainName) c.name = r.Certificate.DomainName;
          for (const user of r.Certificate?.InUseBy || []) {
            if (byArn.has(user)) addEdge(c.arn, user, 'TLS', 'tls');
          }
        } catch { /* skip individual */ }
      }
    } catch (e) { console.error(`    ! ACM enrich error: ${e.message}`); }
  }

  // ---- IAM role policies -> data-access edges (EC2/Lambda -> S3, DynamoDB…) ----
  // Resolves each consumer's role, reads inline + customer-managed policies,
  // and matches granted Resource ARNs against scanned resources. AWS-managed
  // policies are skipped (their "Resource: *" grants would connect everything).
  const roleConsumers = new Map();      // role name -> Set<consumer arn>
  const profileConsumers = new Map();   // instance-profile name -> Set<consumer arn>
  for (const res of inRegion) {
    if (res.extra?.instanceProfileArn) {
      const p = res.extra.instanceProfileArn.split('/').pop();
      if (!profileConsumers.has(p)) profileConsumers.set(p, new Set());
      profileConsumers.get(p).add(res.arn);
    }
    if (res.extra?.roleArn) {
      const rn = res.extra.roleArn.split('/').pop();
      if (!roleConsumers.has(rn)) roleConsumers.set(rn, new Set());
      roleConsumers.get(rn).add(res.arn);
    }
  }
  if (profileConsumers.size || roleConsumers.size) {
    try {
      const iam = retrying(new IAMClient({ region: 'us-east-1', ...creds(auth) }));   // IAM is global
      for (const [pname, consumers] of profileConsumers) {
        try {
          const r = await iam.send(new GetInstanceProfileCommand({ InstanceProfileName: pname }));
          for (const role of r.InstanceProfile?.Roles || []) {
            if (!roleConsumers.has(role.RoleName)) roleConsumers.set(role.RoleName, new Set());
            for (const c of consumers) roleConsumers.get(role.RoleName).add(c);
          }
        } catch { /* skip individual */ }
      }

      const isKnown = arn => byArn.has(arn);
      const matchKnown = pattern => {
        const re = arnGlob(pattern);
        return scan.resources.filter(r => re.test(r.arn)).map(r => r.arn);
      };
      const managedCache = new Map();
      for (const [roleName, consumers] of roleConsumers) {
        const docs = [];
        try {
          const inlineNames = await drain(
            Marker => iam.send(new ListRolePoliciesCommand({ RoleName: roleName, Marker })),
            p => p.PolicyNames,
          );
          for (const pn of inlineNames) {
            try {
              const rp = await iam.send(new GetRolePolicyCommand({ RoleName: roleName, PolicyName: pn }));
              docs.push(JSON.parse(decodeURIComponent(rp.PolicyDocument)));
            } catch { /* skip individual */ }
          }
        } catch { /* skip role */ }
        try {
          const attached = await drain(
            Marker => iam.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName, Marker })),
            p => p.AttachedPolicies,
          );
          for (const ap of attached) {
            if (/:aws:policy\//.test(ap.PolicyArn)) continue;    // AWS-managed
            if (!managedCache.has(ap.PolicyArn)) {
              try {
                const gp = await iam.send(new GetIamPolicyCommand({ PolicyArn: ap.PolicyArn }));
                const pv = await iam.send(new GetPolicyVersionCommand({
                  PolicyArn: ap.PolicyArn, VersionId: gp.Policy.DefaultVersionId,
                }));
                managedCache.set(ap.PolicyArn, JSON.parse(decodeURIComponent(pv.PolicyVersion.Document)));
              } catch { managedCache.set(ap.PolicyArn, null); }
            }
            if (managedCache.get(ap.PolicyArn)) docs.push(managedCache.get(ap.PolicyArn));
          }
        } catch { /* skip role */ }

        for (const doc of docs) {
          for (const grant of extractIamGrants(doc, isKnown, matchKnown)) {
            for (const consumer of consumers) {
              if (consumer === grant.target) continue;
              if (scan.edges.some(x => x.from === consumer && x.to === grant.target)) continue;
              addEdge(consumer, grant.target, grant.label, 'iam');
            }
          }
        }
      }
    } catch (e) { console.error(`    ! IAM role analysis error: ${e.message}`); }
  }

  // ---- Late pass: place referenced-but-untagged instances (from ELB targets
  // or ASG members) into their VPC/subnet so they don't dangle in the region ----
  const orphans = scan.resources.filter(r =>
    r.region === region && r.service === 'ec2' && r.type === 'instance' && r.untagged && !r.vpcId);
  if (orphans.length) {
    try {
      const reservations = [];
      for (const batch of chunk(orphans.map(o => o.id), 100)) {
        reservations.push(...await drain(
          NextToken => ec2.send(new DescribeInstancesCommand({ InstanceIds: batch, NextToken })),
          p => p.Reservations,
          { nextKey: 'NextToken' },
        ));
      }
      for (const res of reservations) for (const inst of res.Instances || []) {
        const node = findById(inst.InstanceId);
        if (!node) continue;
        node.vpcId = inst.VpcId; node.subnetId = inst.SubnetId; node.az = inst.Placement?.AvailabilityZone;
        node.name = nameFromTags(inst.Tags) || node.name;
        node.extra.privateIp = inst.PrivateIpAddress;
        attachSG(node, (inst.SecurityGroups || []).map(s => s.GroupId));
        if (inst.SubnetId && !scan.subnets[inst.SubnetId]) subnetIds.add(inst.SubnetId);
      }
    } catch (e) { console.error(`    ! referenced-instance describe error: ${e.message}`); }
  }

  // ---- Fetch any subnets discovered late (ECS/EKS/referenced instances) ----
  const missing = [...subnetIds].filter(id => !scan.subnets[id]);
  if (missing.length) {
    try {
      const sr = await ec2.send(new DescribeSubnetsCommand({ SubnetIds: missing }));
      for (const s of sr.Subnets || []) {
        scan.subnets[s.SubnetId] = {
          id: s.SubnetId, vpcId: s.VpcId, az: s.AvailabilityZone, cidr: s.CidrBlock,
          public: !!s.MapPublicIpOnLaunch, name: nameFromTags(s.Tags) || s.SubnetId,
        };
        if (s.VpcId && !scan.vpcs[s.VpcId]) scan.vpcs[s.VpcId] = { id: s.VpcId, region, cidr: '', name: s.VpcId };
      }
    } catch (e) { console.error(`    ! late subnet describe error: ${e.message}`); }
  }

  // Public vs private is a route-table fact (0.0.0.0/0 → IGW vs NAT), not
  // MapPublicIpOnLaunch. That is why a NAT was landing in a "private" box.
  const vpcIdsForRoutes = [...new Set([
    ...Object.keys(scan.vpcs || {}),
    ...Object.values(scan.subnets || {}).map(s => s.vpcId).filter(Boolean),
  ])];
  if (vpcIdsForRoutes.length) {
    try {
      const tables = [];
      for (const vpcId of vpcIdsForRoutes) {
        tables.push(...await drain(
          NextToken => ec2.send(new DescribeRouteTablesCommand({
            Filters: [{ Name: 'vpc-id', Values: [vpcId] }],
            NextToken,
          })),
          p => p.RouteTables,
          { nextKey: 'NextToken' },
        ));
      }
      applyRouteTables(scan, tables);
    } catch (e) { console.error(`    ! Route table error: ${e.message}`); }
  }
  addOutboundEdges(scan);

  const discovering = !scan.meta.tagKey;
  const extra = {
    region, scan, addEdge, attachSG, findById, upsert, byArn, byId,
    ensureExternalInstance, discovering,
    rds: retrying(new RDSClient(opts)),
    classicElb: retrying(new ElasticLoadBalancingClient(opts)),
    eb: retrying(new EventBridgeClient(opts)),
    apigw: retrying(new ApiGatewayV2Client(opts)),
    apigwRest: retrying(new APIGatewayClient(opts)),
    sfn: retrying(new SFNClient(opts)),
    ddb: retrying(new DynamoDBClient(opts)),
    r53: retrying(new Route53Client({ region: 'us-east-1', ...creds(auth) })),
  };
  await enrichAurora(extra);
  await enrichClassicElb(extra);
  await enrichEventBridge(extra);
  await enrichApiGateway(extra);
  await enrichStepFunctions(extra);
  await enrichDynamo(extra);
  if (region === scan.meta.regions?.[0] || region === 'us-east-1') {
    await enrichRoute53(extra);
  }

  // ---- Security-group ingress rules -> resource-to-resource flow edges ----
  // A target resource's SG ingress rule can allow traffic either from another
  // security group (UserIdGroupPairs) OR from a CIDR range (IpRanges). We infer
  // an edge for both cases:
  //   • SG reference  -> connect resources in the source SG to the target
  //   • CIDR range    -> connect resources whose private IP / subnet falls in
  //                      the range to the target (this is what most accounts use)
  //   • 0.0.0.0/0     -> connect a synthetic "Internet" node to the target
  if (sgToResources.size) {
    try {
      const sgIds = [...sgToResources.keys()];
      const groups = [];
      for (const batch of chunk(sgIds, 200)) {
        groups.push(...await drain(
          NextToken => ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: batch, NextToken })),
          p => p.SecurityGroups,
          { nextKey: 'NextToken' },
        ));
      }

      // Index resources by IP (instances) and by subnet CIDR. CIDR-derived
      // sources from services that never initiate connections (EFS, RDS,
      // ElastiCache, LBs, …) are almost always an over-broad allow rule —
      // keep them, but as the distinct "sg-wide" kind (amber, dashed) so the
      // rule can be spotted and tightened. Real initiators stay "sg-flow",
      // and explicit SG-to-SG references are honored for any service.
      const canInitiate = res =>
        (res.service === 'ec2' && res.type === 'instance') ||
        ['lambda', 'ecs', 'eks'].includes(res.service);
      const ipResources = [];      // { arn, ip, active }
      const cidrResources = [];    // { arn, cidr, active }
      for (const res of scan.resources) {
        const active = canInitiate(res);
        if (res.extra?.privateIp) ipResources.push({ arn: res.arn, ip: res.extra.privateIp, active });
        const sn = res.subnetId && scan.subnets[res.subnetId];
        if (sn?.cidr) cidrResources.push({ arn: res.arn, cidr: sn.cidr, active });
      }
      const vpcCidrs = new Set(Object.values(scan.vpcs).map(v => v.cidr).filter(Boolean));

      let internetUsed = false;
      for (const g of groups) {
        const targets = sgToResources.get(g.GroupId);            // destination resources
        if (!targets) continue;
        for (const perm of g.IpPermissions || []) {
          const label = portLabel(perm.FromPort, perm.ToPort, perm.IpProtocol);

          // (a) security-group references
          for (const pair of perm.UserIdGroupPairs || []) {
            if (pair.GroupId === g.GroupId) continue;            // self-ref = intra-tier mesh
            const sources = sgToResources.get(pair.GroupId);
            if (!sources) continue;
            for (const from of sources) for (const to of targets) addEdge(from, to, label, 'sg-flow');
          }

          for (const range of perm.Ipv6Ranges || []) {
            if (isInternetCidr(range.CidrIpv6)) {
              for (const to of targets) { addEdge('internet', to, label, 'internet'); internetUsed = true; }
            }
          }

          // (b) CIDR ranges
          for (const range of perm.IpRanges || []) {
            const cidr = range.CidrIp;
            if (!cidr) continue;
            if (isInternetCidr(cidr)) {
              for (const to of targets) { addEdge('internet', to, label, 'internet'); internetUsed = true; }
              continue;
            }
            const sources = new Map();   // arn -> is an active initiator
            for (const ipr of ipResources) if (ipInCidr(ipr.ip, cidr)) sources.set(ipr.arn, ipr.active);
            for (const cr of cidrResources) if (cidrsOverlap(cr.cidr, cidr)) {
              sources.set(cr.arn, sources.get(cr.arn) || cr.active);
            }
            for (const [from, active] of sources) for (const to of targets) {
              addEdge(from, to, label, active ? 'sg-flow' : 'sg-wide');
            }
          }
        }
      }

      if (internetUsed && !byArn.has('internet')) {
        scan.resources.push({
          arn: 'internet', service: 'internet', type: '', id: 'internet',
          region, name: 'Internet', tags: {}, extra: {}, pseudo: true,
        });
      }
    } catch (e) { console.error(`    ! Security-group edge error: ${e.message}`); }
  }
}

/* ------------- resource-policy analysis (S3/SQS/SNS/Lambda) ------------- */

/** Short human label for a policy statement's actions. */
function actionLabel(action) {
  const acts = [].concat(action || []).map(String);
  const has = re => acts.some(a => re.test(a));
  const parts = [];
  if (has(/GetObject/i)) parts.push('read');
  if (has(/PutObject/i)) parts.push('writes');
  if (has(/InvokeFunction/i)) parts.push('invokes');
  if (has(/SendMessage/i)) parts.push('sends');
  if (has(/Publish/i)) parts.push('publishes');
  return parts.join('/') || 'grants';
}

/** ArnLike-style glob ("arn:aws:sns:*:123:top-*") -> RegExp. */
function arnGlob(pattern) {
  return new RegExp('^' + String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
}

/**
 * Extract connector edges from a resource policy (bucket policy, queue policy,
 * topic policy, or Lambda resource policy).
 *
 * Pure and exported for unit testing.
 *
 * @param {object} doc         parsed policy document
 * @param {string} targetArn   ARN of the resource the policy is attached to
 * @param {(arn: string) => boolean} isKnown   is this ARN a scanned resource?
 * @param {(pattern: string) => string[]} matchKnown  scanned ARNs matching a glob
 * @param {(oaiId: string) => string|undefined} [oaiToDist]  CloudFront OAI id -> distribution ARN
 * @returns {{edges: {from: string, to: string, label: string, kind: string}[], publicPolicy: string|null}}
 */
export function extractPolicyEdges(doc, targetArn, isKnown, matchKnown, oaiToDist) {
  const edges = [];
  let publicPolicy = null;

  for (const st of [].concat(doc?.Statement || [])) {
    if (st.Effect !== 'Allow') continue;
    const principal = st.Principal || {};
    const services = [].concat(principal.Service || []);
    const awsPrincipals = [].concat(principal.AWS || []);

    // Sources named in aws:SourceArn conditions (exact or glob), any operator.
    const sourceArns = new Set();
    for (const op of Object.values(st.Condition || {})) {
      for (const [key, val] of Object.entries(op || {})) {
        if (!/sourcearn$/i.test(key)) continue;
        for (const v of [].concat(val)) {
          if (v.includes('*') || v.includes('?')) {
            for (const m of matchKnown(String(v))) sourceArns.add(m);
          } else if (isKnown(v)) {
            sourceArns.add(v);
          }
        }
      }
    }

    // Label/kind by the granting service principal.
    const svcMeta = () => {
      if (services.some(s => /^cloudfront\./.test(s))) return { label: 'OAC read', kind: 'origin' };
      if (services.some(s => /^logging\.s3\.|^logdelivery\.|^delivery\.logs\./.test(s))) return { label: 'access logs', kind: '' };
      if (services.some(s => /^cloudtrail\./.test(s))) return { label: 'trail logs', kind: '' };
      if (services.some(s => /^events\./.test(s))) return { label: 'triggers', kind: 'event' };
      if (services.some(s => /^sns\./.test(s))) return { label: 'notifies', kind: 'event' };
      if (services.some(s => /^s3\./.test(s))) return { label: actionLabel(st.Action), kind: 'event' };
      if (services.some(s => /^apigateway\./.test(s))) return { label: 'invokes', kind: 'event' };
      return { label: actionLabel(st.Action), kind: 'event' };
    };

    if (sourceArns.size) {
      const { label, kind } = svcMeta();
      for (const src of sourceArns) {
        if (src !== targetArn) edges.push({ from: src, to: targetArn, label, kind });
      }
    }

    // Legacy CloudFront OAI principals ("... user/CloudFront Origin Access Identity EXXXX").
    if (oaiToDist) {
      for (const p of awsPrincipals) {
        const m = String(p).match(/Origin Access Identity ([A-Z0-9]+)/i);
        const dist = m && oaiToDist(m[1]);
        if (dist && isKnown(dist)) edges.push({ from: dist, to: targetArn, label: 'OAI read', kind: 'origin' });
      }
    }

    // Public grant: Principal "*" with no conditions at all.
    const isPublic = principal === '*' || st.Principal === '*' ||
      awsPrincipals.includes('*');
    if (isPublic && !st.Condition) {
      publicPolicy = [].concat(st.Action || []).join(', ') || 'public';
    }
  }

  return { edges, publicPolicy };
}

/** Short verb for an IAM statement's actions ("reads", "writes", …). */
function iamVerb(action) {
  const acts = [].concat(action || []).map(String);
  if (acts.includes('*')) return 'full access';
  const has = re => acts.some(a => re.test(a));
  if (has(/^\w[-\w]*:\*$/)) return 'read/write';          // e.g. "s3:*"
  if (has(/:SendMessage/i)) return 'sends';
  if (has(/:Publish$/i)) return 'publishes';
  if (has(/:Invoke/i)) return 'invokes';
  const reads = has(/:(Get|List|Describe|Receive|BatchGet|Query|Scan|Select)/i);
  const writes = has(/:(Put|Delete|Create|Update|Write|BatchWrite|Upload|Restore)/i);
  if (reads && writes) return 'read/write';
  if (writes) return 'writes';
  if (reads) return 'reads';
  return 'access';
}

/**
 * Extract data-access grants from an IAM identity policy: which SCANNED
 * resources does this policy allow acting on? `Resource: "*"` statements are
 * skipped on purpose — they would connect everything to everything.
 *
 * Pure and exported for unit testing.
 *
 * @param {object} doc  parsed IAM policy document
 * @param {(arn: string) => boolean} isKnown
 * @param {(pattern: string) => string[]} matchKnown
 * @returns {{target: string, label: string}[]}  deduplicated per target
 */
export function extractIamGrants(doc, isKnown, matchKnown) {
  const byTarget = new Map();   // target arn -> Set<verb>
  for (const st of [].concat(doc?.Statement || [])) {
    if (st.Effect !== 'Allow') continue;
    const verb = iamVerb(st.Action);
    for (const raw of [].concat(st.Resource || [])) {
      const res = String(raw);
      if (res === '*') continue;
      // "arn:aws:s3:::bucket/*" grants on objects — attribute it to the bucket.
      const candidates = new Set([res, res.replace(/\/[^:]*$/, ''), res.replace(/\/\*$/, '')]);
      const targets = new Set();
      for (const cand of candidates) {
        if (cand.includes('*') || cand.includes('?')) {
          for (const m of matchKnown(cand)) targets.add(m);
        } else if (isKnown(cand)) {
          targets.add(cand);
        }
      }
      for (const t of targets) {
        if (!byTarget.has(t)) byTarget.set(t, new Set());
        byTarget.get(t).add(verb);
      }
    }
  }
  return [...byTarget.entries()].map(([target, verbs]) => ({
    target,
    label: verbs.has('full access') ? 'full access'
      : (verbs.has('read/write') || (verbs.has('reads') && verbs.has('writes'))) ? 'read/write'
      : [...verbs].join('/'),
  }));
}

/** Ensure the synthetic "Internet" pseudo-resource exists (idempotent). */
function markInternetUsed(scan, byArn, region) {
  if (byArn.has('internet') || scan.resources.some(r => r.arn === 'internet')) return;
  const node = {
    arn: 'internet', service: 'internet', type: '', id: 'internet',
    region, name: 'Internet', tags: {}, extra: {}, pseudo: true,
  };
  scan.resources.push(node);
  byArn.set('internet', node);
}

function ensureExternalInstance(scan, byId, instanceId, region) {
  const part = scan.meta.partition || 'aws';
  const arn = `arn:${part}:ec2:${region}:${scan.meta.accountId || '000000000000'}:instance/${instanceId}`;
  let node = byId.get(instanceId);
  if (node) return node;
  node = {
    arn, service: 'ec2', type: 'instance', id: instanceId, region,
    account: scan.meta.accountId, partition: part,
    name: instanceId, tags: {}, extra: {}, untagged: true,
  };
  scan.resources.push(node);
  byId.set(instanceId, node);
  byId.set(idKey(region, instanceId), node);
  return node;
}
