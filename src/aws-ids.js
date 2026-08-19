/**
 * Partition-aware identifiers and small pure helpers used by the scanner.
 * Kept out of scan.js so china/gov URL construction and tag redaction can
 * be tested without standing up an AWS client.
 */

/** arn:partition:service:region:account:resourceType/resourceId (or :resourceId). */
export function parseArn(arn) {
  const p = String(arn || '').split(':');
  if (p[0] !== 'arn' || p.length < 4) {
    return { partition: 'aws', service: '', region: '', account: '', type: '', id: arn, arn };
  }
  const partition = p[1] || 'aws';
  const service = p[2];
  const region = p[3];
  const account = p[4];
  let type = '', id = p.slice(5).join(':');
  const rest = p.slice(5).join(':');
  if (rest.includes('/')) {
    const idx = rest.indexOf('/');
    type = rest.slice(0, idx);
    id = rest.slice(idx + 1);
  } else if (p.length > 6) {
    type = p[5]; id = p.slice(6).join(':');
  } else {
    type = ''; id = rest;
  }
  return { partition, service, region, account, type, id, arn };
}

export function dnsSuffix(partition) {
  return partition === 'aws-cn' ? 'amazonaws.com.cn' : 'amazonaws.com';
}

export function sqsQueueUrl(partition, region, account, queueName) {
  return `https://sqs.${region}.${dnsSuffix(partition)}/${account}/${queueName}`;
}

export function s3BucketArn(partition, bucket) {
  return `arn:${partition || 'aws'}:s3:::${bucket}`;
}

export function partitionOf(arn) {
  const p = String(arn || '').split(':');
  return p[0] === 'arn' && p[1] ? p[1] : 'aws';
}

/** Region-qualified lookup key so two Lambdas named "api" do not collide. */
export function idKey(region, id) {
  return `${region || ''}::${id}`;
}

export function isIpv4(addr) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(addr || ''));
}

export function isIpv6(addr) {
  const s = String(addr || '');
  return s.includes(':') && !isIpv4(s);
}

export function isInternetCidr(cidr) {
  return cidr === '0.0.0.0/0' || cidr === '::/0' || cidr === '0:0:0:0:0:0:0:0/0';
}

const SENSITIVE_TAG = /secret|password|token|credential|private.?key|api.?key/i;

export function isSensitiveTagKey(key) {
  return SENSITIVE_TAG.test(String(key || ''));
}

export function redactTags(tags) {
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return tags || {};
  const out = {};
  for (const [k, v] of Object.entries(tags)) {
    out[k] = isSensitiveTagKey(k) ? '***' : v;
  }
  return out;
}

/** Copy a scan model with sensitive tag values stripped — used before writing scan.json. */
export function redactScan(scan) {
  return {
    ...scan,
    resources: (scan.resources || []).map(r => ({ ...r, tags: redactTags(r.tags) })),
  };
}

/** Pull ARNs out of a Step Functions definition (or any JSON/ASL blob). */
export function extractArns(text) {
  const re = /arn:[a-z0-9-]+:[a-z0-9-]+:[a-z0-9-]*:\d*:[^\s"'\\,}\]]+/gi;
  return [...new Set(String(text || '').match(re) || [])];
}
