/**
 * Icon indexing + resolution.
 *
 * Walks the official AWS icon set and lets us resolve an AWS ARN
 * service/resource-type to a concrete icon file, which we embed as a
 * base64 data URI so the generated SVG/HTML is fully self-contained.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Explicit map: `${service}` or `${service}:${type}` -> icon name candidates.
 *  Candidate strings are matched (normalized) against indexed icon file names. */
const ICON_MAP = {
  // Compute
  'ec2:instance': ['Amazon-EC2'],
  'ec2:spot-instances-request': ['Amazon-EC2'],
  'ec2:reserved-instances': ['Amazon-EC2'],
  'ec2:image': ['Amazon-EC2-Image-Builder', 'Amazon-EC2'],
  'ec2:volume': ['Amazon-Elastic-Block-Store'],
  'ec2:snapshot': ['Amazon-Elastic-Block-Store'],
  'ec2:elastic-ip': ['Elastic-IP', 'Amazon-EC2'],
  'ec2:natgateway': ['NAT-Gateway', 'Amazon-Virtual-Private-Cloud'],
  'ec2:internet-gateway': ['Internet-Gateway', 'Amazon-Virtual-Private-Cloud'],
  'ec2:transit-gateway': ['AWS-Transit-Gateway'],
  'ec2:vpc-endpoint': ['Endpoints', 'AWS-PrivateLink'],
  'ec2:vpc-peering-connection': ['Peering', 'Amazon-Virtual-Private-Cloud'],
  'ec2:security-group': ['Amazon-VPC_Network-Access-Analyzer', 'Amazon-Virtual-Private-Cloud'],
  'ec2:route-table': ['Route-Table', 'Amazon-Virtual-Private-Cloud'],
  'ec2:network-interface': ['Elastic-Network-Interface', 'Amazon-Virtual-Private-Cloud'],
  'ec2:vpc': ['Amazon-Virtual-Private-Cloud'],
  'ec2:subnet': ['Amazon-Virtual-Private-Cloud'],
  lambda: ['AWS-Lambda'],
  'lambda:function': ['AWS-Lambda'],
  autoscaling: ['Amazon-EC2-Auto-Scaling'],
  'autoscaling:autoScalingGroup': ['Amazon-EC2-Auto-Scaling'],
  elasticbeanstalk: ['AWS-Elastic-Beanstalk'],
  batch: ['AWS-Batch'],
  // Containers
  ecs: ['Amazon-Elastic-Container-Service'],
  'ecs:cluster': ['Amazon-Elastic-Container-Service'],
  'ecs:service': ['Amazon-Elastic-Container-Service'],
  'ecs:task-definition': ['Amazon-Elastic-Container-Service'],
  eks: ['Amazon-Elastic-Kubernetes-Service'],
  'eks:cluster': ['Amazon-Elastic-Kubernetes-Service'],
  ecr: ['Amazon-Elastic-Container-Registry'],
  'ecr:repository': ['Amazon-Elastic-Container-Registry'],
  // Networking / delivery
  elasticloadbalancing: ['Elastic-Load-Balancing'],
  'elasticloadbalancing:loadbalancer': ['Elastic-Load-Balancing'],
  'elasticloadbalancing:targetgroup': ['Elastic-Load-Balancing'],
  cloudfront: ['Amazon-CloudFront'],
  route53: ['Amazon-Route-53'],
  'route53:hostedzone': ['Amazon-Route-53'],
  apigateway: ['Amazon-API-Gateway'],
  globalaccelerator: ['AWS-Global-Accelerator'],
  directconnect: ['AWS-Direct-Connect'],
  // Databases
  rds: ['Amazon-RDS'],
  'rds:db': ['Amazon-RDS'],
  'rds:cluster': ['Amazon-Aurora', 'Amazon-RDS'],
  dynamodb: ['Amazon-DynamoDB'],
  'dynamodb:table': ['Amazon-DynamoDB'],
  elasticache: ['Amazon-ElastiCache'],
  'elasticache:cluster': ['Amazon-ElastiCache'],
  redshift: ['Amazon-Redshift'],
  neptune: ['Amazon-Neptune'],
  docdb: ['Amazon-DocumentDB'],
  memorydb: ['Amazon-MemoryDB'],
  timestream: ['Amazon-Timestream'],
  // Storage
  s3: ['Amazon-Simple-Storage-Service'],
  glacier: ['Amazon-Simple-Storage-Service-Glacier'],
  efs: ['Amazon-EFS'],
  fsx: ['Amazon-FSx'],
  backup: ['AWS-Backup'],
  // App integration
  sqs: ['Amazon-Simple-Queue-Service'],
  sns: ['Amazon-Simple-Notification-Service'],
  events: ['Amazon-EventBridge'],
  'events:rule': ['Amazon-EventBridge'],
  states: ['AWS-Step-Functions'],
  'states:stateMachine': ['AWS-Step-Functions'],
  mq: ['Amazon-MQ'],
  appsync: ['AWS-AppSync'],
  // Analytics / streaming
  kinesis: ['Amazon-Kinesis'],
  firehose: ['Amazon-Data-Firehose'],
  glue: ['AWS-Glue'],
  athena: ['Amazon-Athena'],
  es: ['Amazon-OpenSearch-Service'],
  elasticsearch: ['Amazon-OpenSearch-Service'],
  emr: ['Amazon-EMR'],
  kafka: ['Amazon-Managed-Streaming-for-Apache-Kafka'],
  // Security / identity
  iam: ['AWS-Identity-and-Access-Management'],
  kms: ['AWS-Key-Management-Service'],
  secretsmanager: ['AWS-Secrets-Manager'],
  acm: ['AWS-Certificate-Manager'],
  wafv2: ['AWS-WAF'],
  waf: ['AWS-WAF'],
  cognito: ['Amazon-Cognito'],
  'cognito-idp': ['Amazon-Cognito'],
  guardduty: ['Amazon-GuardDuty'],
  // Management / ML / misc
  cloudformation: ['AWS-CloudFormation'],
  cloudwatch: ['Amazon-CloudWatch'],
  logs: ['Amazon-CloudWatch'],
  ssm: ['AWS-Systems-Manager'],
  sagemaker: ['Amazon-SageMaker'],
  bedrock: ['Amazon-Bedrock'],
  ses: ['Amazon-Simple-Email-Service'],
  amplify: ['AWS-Amplify'],
  apprunner: ['AWS-App-Runner'],
  codepipeline: ['AWS-CodePipeline'],
  codebuild: ['AWS-CodeBuild'],
};

/** Group/container icons keyed by our container kind. */
const GROUP_MAP = {
  cloud: ['AWS-Cloud_32.', 'AWS-Cloud-logo'],
  account: ['AWS-Account'],
  region: ['Region_'],
  vpc: ['Virtual-private-cloud-VPC'],
  'subnet-public': ['Public-subnet'],
  'subnet-private': ['Private-subnet'],
  eks: ['EKS-cluster', 'Amazon-Elastic-Kubernetes-Service'],
  az: ['Region_'],
  asg: ['Auto-Scaling-group'],
  datacenter: ['Corporate-data-center'],
};

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(svg|png)$/i.test(entry.name)) acc.push(full);
  }
}

export function loadIconIndex(iconsDir) {
  const files = [];
  walk(iconsDir, files);

  // Bucketed indexes so we can prefer service icons, then resource, then group.
  const service = [], resource = [], group = [];
  for (const f of files) {
    const base = path.basename(f);
    const rec = { file: f, base, n: norm(base), svg: /\.svg$/i.test(f) };
    if (f.includes('Architecture-Service-Icons')) { if (base.includes('_32.')) service.push(rec); }
    else if (f.includes('Resource-Icons')) resource.push(rec);
    else if (f.includes('Group-Icons')) group.push(rec);
  }
  // Prefer SVG within each bucket.
  const pref = arr => arr.sort((a, b) => (a.svg === b.svg ? 0 : a.svg ? -1 : 1));
  pref(service); pref(resource); pref(group);

  const cache = new Map();

  function findByCandidates(candidates, buckets) {
    for (const cand of candidates) {
      const nc = norm(cand);
      // exact-ish match first
      for (const bucket of buckets) {
        const hit = bucket.find(r => r.n.includes('arch' + nc) || r.n === 'arch' + nc + '32' || r.n.includes(nc));
        if (hit) return hit;
      }
    }
    return null;
  }

  function toDataUri(rec) {
    if (!rec) return null;
    const buf = fs.readFileSync(rec.file);
    const mime = rec.svg ? 'image/svg+xml' : 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  }

  return {
    counts: { service: service.length, resource: resource.length, group: group.length },

    /** Resolve a service/type to { dataUri, base } (with a generic fallback). */
    resolve(svc, type) {
      const key = `${svc}:${type}`;
      if (cache.has(key)) return cache.get(key);
      const candidates =
        ICON_MAP[key] || ICON_MAP[svc] || [prettyService(svc)];
      let rec = findByCandidates(candidates, [service, resource]);
      if (!rec) rec = findByCandidates([svc], [service, resource]);
      const out = rec
        ? { dataUri: toDataUri(rec), base: rec.base, matched: true }
        : { dataUri: genericDataUri(), base: 'generic', matched: false };
      cache.set(key, out);
      return out;
    },

    /** Resolve a container/group icon by kind. */
    group(kind) {
      const key = `group:${kind}`;
      if (cache.has(key)) return cache.get(key);
      const candidates = GROUP_MAP[kind] || [kind];
      const rec = findByCandidates(candidates, [group, service]);
      const out = rec ? { dataUri: toDataUri(rec), base: rec.base } : { dataUri: null };
      cache.set(key, out);
      return out;
    },
  };
}

function prettyService(svc) {
  // Heuristic: turn "sagemaker" into "SageMaker"-ish candidate.
  return svc.replace(/(^|[-_])(\w)/g, (_, s, c) => (s ? '-' : '') + c.toUpperCase());
}

let _generic;
function genericDataUri() {
  if (_generic) return _generic;
  // Neutral AWS-squid-ink rounded tile with a gear glyph — used when no icon matches.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
  <rect x="1" y="1" width="46" height="46" rx="8" fill="#232F3E"/>
  <path fill="#FF9900" d="M24 15a9 9 0 100 18 9 9 0 000-18zm0 4a5 5 0 110 10 5 5 0 010-10z"/>
  <circle cx="24" cy="24" r="2.4" fill="#232F3E"/>
</svg>`;
  _generic = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  return _generic;
}
