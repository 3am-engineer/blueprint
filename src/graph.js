/**
 * Turn a scan model into a logical diagram model:
 *   - containers: account > region > vpc > subnet  (+ a "Regional services" box)
 *   - nodes: one per resource, placed in the deepest container we can determine
 *   - edges: the inferred, labeled relationships
 * Icons are resolved here (as data URIs) so the renderer just draws.
 */

const FRIENDLY = {
  'ec2:instance': 'EC2 Instance',
  'ec2:natgateway': 'NAT Gateway',
  'ec2:internet-gateway': 'Internet Gateway',
  'ec2:transit-gateway': 'Transit Gateway',
  'ec2:volume': 'EBS Volume',
  'ec2:security-group': 'Security Group',
  'ec2:vpc': 'VPC',
  'ec2:subnet': 'Subnet',
  'elasticloadbalancing:loadbalancer': 'Load Balancer',
  'elasticloadbalancing:targetgroup': 'Target Group',
  'rds:db': 'RDS Instance',
  'rds:cluster': 'RDS Cluster',
  'lambda:function': 'Lambda Function',
  'autoscaling:autoScalingGroup': 'Auto Scaling Group',
  's3': 'S3 Bucket',
  'dynamodb:table': 'DynamoDB Table',
  'sqs': 'SQS Queue',
  'sns': 'SNS Topic',
  'elasticache:cluster': 'ElastiCache',
  'elasticache:replicationgroup': 'ElastiCache replication group',
  'elasticfilesystem:file-system': 'EFS file system',
  'ecs:cluster': 'ECS Cluster',
  'ecs:service': 'ECS Service',
  'eks:cluster': 'EKS Cluster',
  'apigateway': 'API Gateway',
  'cloudfront': 'CloudFront',
  'events:rule': 'EventBridge Rule',
  'states:stateMachine': 'Step Functions',
};

function friendly(service, type) {
  return FRIENDLY[`${service}:${type}`] || FRIENDLY[service] ||
    (service.toUpperCase() + (type ? ' ' + type.replace(/[-_]/g, ' ') : ''));
}

/** Simple globe glyph for the synthetic "Internet" node (0.0.0.0/0 ingress). */
const INTERNET_ICON = 'data:image/svg+xml;base64,' + Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
    <circle cx="24" cy="24" r="20" fill="#ffffff" stroke="#5A6B7B" stroke-width="2"/>
    <ellipse cx="24" cy="24" rx="9" ry="20" fill="none" stroke="#5A6B7B" stroke-width="1.6"/>
    <line x1="4" y1="24" x2="44" y2="24" stroke="#5A6B7B" stroke-width="1.6"/>
    <path d="M8 15 H40 M8 33 H40" fill="none" stroke="#5A6B7B" stroke-width="1.4"/>
  </svg>`).toString('base64');

/** Low-signal resource types hidden by default (still present in scan.json).
 *  These are plumbing/backup artifacts that clutter an architecture view. */
const HIDDEN_TYPES = new Set([
  'ec2:image', 'ec2:snapshot', 'ec2:network-interface', 'ec2:volume',
  'ec2:route-table', 'ec2:network-acl', 'ec2:security-group', 'ec2:elastic-ip',
  'ec2:dhcp-options', 'ec2:vpc-flow-log', 'ec2:key-pair',
  // VPCs and subnets are drawn as containers — a node for them is just noise.
  // Internet gateways become an "IGW" chip on the VPC container instead.
  'ec2:vpc', 'ec2:subnet', 'ec2:internet-gateway',
  'ec2:launch-template', 'ec2:spot-instances-request', 'eks:addon',
  'resource-groups:group',
  'elasticloadbalancing:targetgroup', 'elasticloadbalancing:listener',
  'rds:subgrp', 'rds:pg', 'rds:og', 'rds:secgrp',
  'cloudwatch:alarm', 'cloudwatch:dashboard', 'logs:log-group',
]);

/** Logical category for --group-by type mode. */
function categoryOf(r) {
  const s = r.service, t = r.type;
  if (s === 'ec2' && ['natgateway', 'internet-gateway', 'transit-gateway', 'vpc-endpoint', 'vpc-peering-connection'].includes(t)) return 'Networking';
  if (['elasticloadbalancing', 'cloudfront', 'route53', 'apigateway', 'globalaccelerator', 'directconnect'].includes(s)) return 'Networking';
  if (['rds', 'dynamodb', 'elasticache', 'redshift', 'neptune', 'docdb', 'memorydb', 'timestream'].includes(s)) return 'Databases & caches';
  if (['s3', 'glacier', 'efs', 'elasticfilesystem', 'fsx', 'backup'].includes(s)) return 'Storage';
  if (['sqs', 'sns', 'events', 'states', 'mq', 'appsync', 'kinesis', 'firehose'].includes(s)) return 'Messaging & events';
  if (['iam', 'kms', 'secretsmanager', 'acm', 'wafv2', 'waf', 'cognito', 'cognito-idp', 'guardduty'].includes(s)) return 'Security & identity';
  if (['ec2', 'autoscaling', 'lambda', 'ecs', 'eks', 'batch', 'apprunner', 'elasticbeanstalk'].includes(s)) return 'Compute';
  return 'Other services';
}

export function buildGraph(scan, icons, options = {}) {
  const showAll = !!options.showAll;
  const byType = options.groupBy === 'type';
  const containers = new Map();   // id -> container
  const nodes = [];
  const edges = [];

  const ensureContainer = (id, kind, label, parent, iconKind) => {
    if (!containers.has(id)) {
      containers.set(id, { id, kind, label, parent, icon: iconKind ? icons.group(iconKind).dataUri : null });
    }
    return containers.get(id);
  };

  const accountId = scan.meta.accountId || 'AWS Account';
  const rootId = `account:${accountId}`;
  ensureContainer(rootId, 'account', `AWS Account · ${accountId}`, null, 'account');

  const regionOf = r => r.region || 'global';
  const isHidden = r => !showAll && (HIDDEN_TYPES.has(`${r.service}:${r.type}`) || HIDDEN_TYPES.has(r.service));

  // Subnets referenced per VPC, so we can render them as small chips in the
  // VPC header (subnets are metadata/badges here, not layout containers).
  const vpcSubnets = new Map();   // vpcId -> Map(subnetId -> meta)

  let hiddenCount = 0;
  for (const r of scan.resources) {
    if (isHidden(r)) { hiddenCount++; continue; }
    const region = regionOf(r);
    const regionId = `region:${region}`;
    ensureContainer(regionId, 'region', region, rootId, 'region');

    let parentId = regionId;
    let zone = null;

    // A resource belongs to a VPC if it (or its subnet) references one.
    const sn = r.subnetId ? scan.subnets[r.subnetId] : null;
    const vpcId = (sn && sn.vpcId) || r.vpcId;

    // EKS worker nodes / nodegroups / cluster resources group under an
    // "EKS cluster" container (they span subnets, so the cluster box wins).
    const eksName =
      (r.service === 'eks' && (r.type === 'cluster' || r.type === 'nodegroup'))
        ? String(r.id).split('/')[0] || r.name
        : r.tags?.['aws:eks:cluster-name'] || r.tags?.['eks:cluster-name'] ||
          Object.keys(r.tags || {}).find(k => k.startsWith('kubernetes.io/cluster/') &&
            ['owned', 'shared'].includes(r.tags[k]))?.split('/').pop();
    if (r.service === 'internet' || r.pseudo) {
      parentId = null;                           // Internet sits outside the AWS account
    } else if (byType) {
      // --group-by type: logical categories instead of network containment.
      const cat = categoryOf(r);
      const catId = `cat:${region}:${cat}`;
      ensureContainer(catId, 'category', cat, regionId, null);
      parentId = catId;
      if (sn) zone = { name: sn.name || r.subnetId, public: !!sn.public, az: sn.az };
    } else if (eksName) {
      const eksId = `ekscluster:${region}:${eksName}`;
      const eksParent = vpcId
        ? (ensureContainer(`vpc:${vpcId}`, 'vpc', vpcLabel(scan.vpcs[vpcId] || { name: vpcId, cidr: '' }), regionId, 'vpc'), `vpc:${vpcId}`)
        : regionId;
      ensureContainer(eksId, 'eks', `EKS cluster · ${eksName}`, eksParent, 'eks');
      // if the container was first created at region level and we now know
      // the VPC, move it inside
      const ec = containers.get(eksId);
      if (ec.parent === regionId && vpcId) ec.parent = `vpc:${vpcId}`;
      parentId = eksId;
      if (sn) zone = { name: sn.name || r.subnetId, public: !!sn.public, az: sn.az };
    } else if (vpcId) {
      const vId = `vpc:${vpcId}`;
      const vmeta = scan.vpcs[vpcId] || { name: vpcId, cidr: '' };
      ensureContainer(vId, 'vpc', vpcLabel(vmeta), regionId, 'vpc');
      parentId = vId;
      if (sn) {
        // Subnets are real containers (green = public, blue = private), the way
        // the official AWS reference diagrams draw them.
        const snId = `subnet:${r.subnetId}`;
        const kind = sn.public ? 'subnet-public' : 'subnet-private';
        ensureContainer(snId, kind, subnetLabel(sn), vId, kind);
        parentId = snId;
        zone = { name: sn.name || r.subnetId, public: !!sn.public, az: sn.az };
        if (!vpcSubnets.has(vpcId)) vpcSubnets.set(vpcId, new Map());
        vpcSubnets.get(vpcId).set(r.subnetId, { ...sn });
      }
    } else if (isRegionalService(r)) {
      const rgId = `regional:${region}`;
      ensureContainer(rgId, 'regional', 'Regional services', regionId, null);
      parentId = rgId;
    }

    const icon = r.service === 'internet' ? { dataUri: INTERNET_ICON, matched: true } : icons.resolve(r.service, r.type);
    nodes.push({
      id: r.arn,
      kind: r.service === 'internet' ? 'internet' : 'resource',
      parent: parentId,
      label: truncate(r.name || r.id, 44),   // renderer wraps to two lines
      sublabel: r.service === 'internet' ? 'Internet' : friendly(r.service, r.type),
      service: r.service,
      type: r.type,
      icon: icon.dataUri,
      iconMatched: icon.matched,
      zone,
      untagged: !!r.untagged,
      // Public resource policy (Principal "*", no conditions) — badge it.
      open: r.extra?.publicPolicy ? `public resource policy (${r.extra.publicPolicy})` : undefined,
    });
  }

  // Attach the subnet chip list to each VPC container.
  for (const [vpcId, subs] of vpcSubnets) {
    const c = containers.get(`vpc:${vpcId}`);
    if (c) c.subnets = [...subs.values()].sort((a, b) => (a.public === b.public ? 0 : a.public ? -1 : 1));
  }

  // Mark VPCs that have an internet gateway attached (chip on the container
  // header — the IGW node itself is hidden by default as boilerplate).
  for (const r of scan.resources) {
    if (r.service === 'ec2' && r.type === 'internet-gateway' && r.vpcId) {
      const c = containers.get(`vpc:${r.vpcId}`);
      if (c) c.igw = r.name || r.id;
    }
  }

  // Edges — keep only those whose endpoints both exist as nodes, and merge
  // parallel edges (same source, target, kind) into one with a combined label.
  // Security-group scans routinely yield e.g. HTTP :80 + HTTPS :443 between the
  // same pair; drawing them separately doubles every connector.
  const nodeIds = new Set(nodes.map(n => n.id));
  const merged = new Map();
  for (const e of scan.edges || []) {
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) continue;
    const key = `${e.from}|${e.to}|${e.kind || ''}`;
    if (!merged.has(key)) {
      merged.set(key, { from: e.from, to: e.to, kind: e.kind || '', labels: [] });
    }
    const m = merged.get(key);
    if (e.label && !m.labels.includes(e.label)) m.labels.push(e.label);
  }
  let ei = 0;
  for (const m of merged.values()) {
    const label = m.labels.length > 3
      ? `${m.labels.slice(0, 3).join(' · ')} +${m.labels.length - 3}`
      : m.labels.join(' · ');
    edges.push({ id: `e${ei++}`, from: m.from, to: m.to, label, kind: m.kind });
  }

  // Internet exposure: draw a real connector only into entry-point services
  // (load balancers, CDN, API gateways, IGW/NAT). Anything else that allows
  // 0.0.0.0/0 gets a compact "open to internet" badge on its card instead —
  // otherwise a permissive account becomes a wall of parallel orange lines.
  const ENTRY_SERVICES = new Set(['elasticloadbalancing', 'cloudfront', 'apigateway', 'globalaccelerator']);
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const keptEdges = [];
  for (const e of edges) {
    if (e.kind === 'internet') {
      const t = nodeById.get(e.to);
      const isEntry = t && (ENTRY_SERVICES.has(t.service) ||
        t.type === 'internet-gateway' || t.type === 'natgateway');
      if (!isEntry) {
        if (t && !t.open) t.open = e.label || 'all traffic';
        continue;
      }
    }
    keptEdges.push(e);
  }
  edges.length = 0; edges.push(...keptEdges);

  // Drop the synthetic Internet node if nothing connects to it anymore.
  const stillLinked = new Set(edges.flatMap(e => [e.from, e.to]));
  const inetIdx = nodes.findIndex(n => n.kind === 'internet');
  if (inetIdx >= 0 && !stillLinked.has(nodes[inetIdx].id)) nodes.splice(inetIdx, 1);

  // ---- Bundle collapse ----
  // EKS-style setups produce edge explosions: the cluster SG allows all
  // members ↔ all members (a full mesh), and one LB fans out to dozens of
  // nodes. When ≥4 edges share (kind, label) and connect the same pair of
  // containers, draw ONE container-to-container edge; when they form a mesh
  // INSIDE one container, drop them (intra-group traffic is implied).
  const COLLAPSE_MIN = 4;
  const KEEP_KINDS = new Set(['internet', 'tls', 'origin']);
  const parentOf = new Map(nodes.map(n => [n.id, n.parent]));
  {
    const containerIds = new Set(containers.keys());
    const kept = [];
    const groups = new Map();
    for (const e of edges) {
      const pf = parentOf.get(e.from), pt = parentOf.get(e.to);
      if (KEEP_KINDS.has(e.kind) || !pf || !pt ||
        !containerIds.has(pf) || !containerIds.has(pt)) { kept.push(e); continue; }
      const key = `${e.kind}|${e.label}|${pf}|${pt}`;
      if (!groups.has(key)) groups.set(key, { pf, pt, list: [] });
      groups.get(key).list.push(e);
    }
    let meshDropped = 0, bundled = 0, ei2 = edges.length;
    for (const { pf, pt, list } of groups.values()) {
      if (list.length < COLLAPSE_MIN) { kept.push(...list); continue; }
      if (pf === pt) {
        // Only drop true many-to-many meshes; a fan-in/out to a single hub
        // (e.g. everything -> syslog host) is real signal and stays.
        const srcs = new Set(list.map(e => e.from)).size;
        const tgts = new Set(list.map(e => e.to)).size;
        if (srcs > 2 && tgts > 2) { meshDropped += list.length; continue; }
        kept.push(...list); continue;
      }
      bundled += list.length;
      kept.push({ id: `e${ei2++}`, from: pf, to: pt, label: list[0].label, kind: list[0].kind });
    }
    edges.length = 0; edges.push(...kept);
    if (meshDropped || bundled) {
      console.error(`  (collapsed ${bundled} fan-out edges into container links, ` +
        `dropped ${meshDropped} intra-group mesh edges)`);
    }
  }

  // ---- Unconnected leftovers ----
  // Edge-less nodes sitting directly in a region (launch templates, stray
  // artifacts) otherwise stretch the region into one enormous row. Park them
  // in a strip container that the layouter grids at the bottom.
  {
    const touched = new Set(edges.flatMap(e => [e.from, e.to]));
    for (const n of nodes) {
      if (n.kind === 'internet' || touched.has(n.id)) continue;
      const p = n.parent && containers.get(n.parent);
      if (p && p.kind === 'region') {
        const region = p.label;
        const miscId = `misc:${region}`;
        ensureContainer(miscId, 'regional', 'Not connected', n.parent, null);
        n.parent = miscId;
      }
    }
  }

  // ---- Remove containers left empty by the moves above ----
  {
    let changed = true;
    const REMOVABLE = new Set(['subnet-public', 'subnet-private', 'vpc', 'regional', 'eks', 'category']);
    while (changed) {
      changed = false;
      const used = new Set(nodes.map(n => n.parent));
      for (const c of containers.values()) if (c.parent) used.add(c.parent);
      for (const [id, c] of containers) {
        if (REMOVABLE.has(c.kind) && !used.has(id)) {
          containers.delete(id);
          changed = true;
        }
      }
    }
  }

  // Legend — unique services present (excluding the synthetic Internet node).
  const legendMap = new Map();
  for (const n of nodes) {
    if (n.kind === 'internet') continue;
    if (!legendMap.has(n.sublabel)) legendMap.set(n.sublabel, n.icon);
  }
  const legend = [...legendMap.entries()].map(([label, icon]) => ({ label, icon }));

  // Subnet summary (for the sidebar) — subnets are metadata here, not containers.
  const subnetList = [];
  for (const [vpcId, subs] of vpcSubnets) {
    for (const sn of subs.values()) {
      subnetList.push({ vpcId, id: sn.id, name: sn.name, public: !!sn.public, az: sn.az, cidr: sn.cidr });
    }
  }
  subnetList.sort((a, b) => (a.public === b.public ? String(a.az).localeCompare(b.az) : a.public ? -1 : 1));

  return {
    meta: scan.meta,
    rootId,
    containers: [...containers.values()],
    nodes,
    edges,
    legend,
    subnets: subnetList,
    stats: {
      resources: nodes.filter(n => !n.untagged && n.kind !== 'internet').length,
      external: nodes.filter(n => n.untagged).length,
      open: nodes.filter(n => n.open).length,
      hidden: hiddenCount,
      edges: edges.length,
      regions: [...new Set(scan.resources.map(regionOf))],
    },
  };
}

function isRegionalService(r) {
  // Services that are not placed inside a VPC/subnet in these diagrams.
  return ['s3', 'dynamodb', 'sqs', 'sns', 'cloudfront', 'route53', 'apigateway',
    'kinesis', 'firehose', 'glue', 'athena', 'states', 'events', 'sagemaker',
    'bedrock', 'ses', 'kms', 'secretsmanager', 'cloudformation', 'iam', 'ssm',
    'lambda', 'ecr', 'backup', 'cloudwatch', 'logs'].includes(r.service);
}

const vpcLabel = v => `VPC · ${v.name}${v.cidr ? ` (${v.cidr})` : ''}`;
const subnetLabel = s => [
  `${s.public ? 'Public' : 'Private'} subnet`,
  azShort(s.az),
  s.cidr || '',
].filter(Boolean).join(' · ');

/** "us-east-1a" -> "1a"; falls back to the raw value. */
function azShort(az) {
  if (!az) return '';
  const m = String(az).match(/(\d+[a-z])$/i);
  return m ? m[1] : az;
}

function truncate(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
