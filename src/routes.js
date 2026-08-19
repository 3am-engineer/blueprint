/**
 * Classify subnets from route tables (IGW = public, NAT = private egress)
 * and infer outbound Internet / NAT connectors.
 *
 * MapPublicIpOnLaunch is not "public": a NAT gateway lives in a public
 * subnet, which is defined by a 0.0.0.0/0 route to an internet gateway.
 */
import { isInternetCidr } from './aws-ids.js';

/** Inbound clients (source). Outbound sink is a separate node so ELK
 *  does not drag the entry-point Internet under the VPC. */
export const INTERNET_IN = 'internet';
export const INTERNET_EGRESS = 'internet-egress';

export function isInternetId(id) {
  return id === INTERNET_IN || id === INTERNET_EGRESS;
}

function routeEgress(rt) {
  let via = null, igwId, natGatewayId;
  for (const r of rt.Routes || []) {
    if (r.State && r.State !== 'active') continue;
    const dest = r.DestinationCidrBlock || r.DestinationIpv6CidrBlock;
    if (!isInternetCidr(dest)) continue;
    if (r.GatewayId && String(r.GatewayId).startsWith('igw-')) {
      via = 'igw';
      igwId = r.GatewayId;
    } else if (r.NatGatewayId) {
      via = 'nat';
      natGatewayId = r.NatGatewayId;
    }
  }
  return { via, igwId, natGatewayId };
}

/** Mutate scan.subnets with public/egress from DescribeRouteTables results. */
export function applyRouteTables(scan, tables) {
  const mainByVpc = new Map();
  const bySubnet = new Map();
  for (const rt of tables || []) {
    const info = routeEgress(rt);
    for (const a of rt.Associations || []) {
      if (a.Main) mainByVpc.set(rt.VpcId, info);
      if (a.SubnetId) bySubnet.set(a.SubnetId, info);
    }
  }
  for (const sn of Object.values(scan.subnets || {})) {
    const info = bySubnet.get(sn.id) || mainByVpc.get(sn.vpcId);
    if (!info || !info.via) continue;
    sn.public = info.via === 'igw';
    sn.egress = info.via;
    if (info.natGatewayId) sn.natGatewayId = info.natGatewayId;
    if (info.igwId) sn.igwId = info.igwId;
  }
}

function ensureInternetEgress(scan) {
  if (scan.resources.some(r => r.arn === INTERNET_EGRESS)) return;
  const region = scan.meta?.regions?.[0] || scan.resources[0]?.region || 'us-east-1';
  scan.resources.push({
    arn: INTERNET_EGRESS, service: 'internet', type: 'egress', id: INTERNET_EGRESS,
    region, name: 'Internet', tags: {}, extra: {}, pseudo: true,
  });
}

const COMPUTE = new Set(['lambda', 'ecs', 'eks']);

function isCompute(r) {
  if (r.service === 'ec2' && r.type === 'instance') return true;
  return COMPUTE.has(r.service);
}

/** Old scans pointed egress at the inbound Internet node — split them. */
export function splitInternetNodes(scan) {
  let needEgress = false;
  for (const e of scan.edges || []) {
    if (e.kind === 'internet-out' && (e.to === INTERNET_IN || e.to === INTERNET_EGRESS)) {
      e.to = INTERNET_EGRESS;
      needEgress = true;
    }
  }
  if (needEgress) ensureInternetEgress(scan);
}

/** NAT → Internet, private compute → NAT, public compute → Internet. */
export function addOutboundEdges(scan) {
  scan.edges = scan.edges || [];
  splitInternetNodes(scan);
  const has = (from, to, kind) =>
    scan.edges.some(e => e.from === from && e.to === to && e.kind === kind);
  const add = (from, to, label, kind) => {
    if (!from || !to || from === to || has(from, to, kind)) return;
    scan.edges.push({ from, to, label, kind });
  };

  const nats = (scan.resources || []).filter(r => r.service === 'ec2' && r.type === 'natgateway');
  const natById = new Map(nats.map(n => [n.id, n]));

  if (nats.length) ensureInternetEgress(scan);
  for (const nat of nats) add(nat.arn, INTERNET_EGRESS, 'egress', 'internet-out');

  let anyDirect = false;
  for (const r of scan.resources || []) {
    if (r.pseudo || r.service === 'internet') continue;
    if (r.service === 'ec2' && r.type === 'natgateway') continue;
    const sn = r.subnetId && scan.subnets?.[r.subnetId];
    if (!sn) continue;

    if (sn.egress === 'nat' && sn.natGatewayId) {
      const nat = natById.get(sn.natGatewayId);
      if (nat && isCompute(r)) add(r.arn, nat.arn, 'egress', 'nat-egress');
    } else if (sn.egress === 'igw' && isCompute(r)) {
      // A NAT in this VPC already owns the outbound story; extra public-host
      // → Internet lines just pile up next to it.
      const natHere = nats.some(n => n.vpcId && n.vpcId === r.vpcId);
      if (natHere) continue;
      anyDirect = true;
      add(r.arn, INTERNET_EGRESS, 'egress', 'internet-out');
    }
  }
  if (anyDirect) ensureInternetEgress(scan);
}
