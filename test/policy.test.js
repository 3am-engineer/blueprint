import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPolicyEdges } from '../src/scan.js';

const BUCKET = 'arn:aws:s3:::my-assets';
const LOGS = 'arn:aws:s3:::my-logs';
const DIST = 'arn:aws:cloudfront::111122223333:distribution/E1ABC';
const TOPIC = 'arn:aws:sns:us-east-1:111122223333:alerts';
const QUEUE = 'arn:aws:sqs:us-east-1:111122223333:jobs';
const FN = 'arn:aws:lambda:us-east-1:111122223333:function:worker';

const KNOWN = new Set([BUCKET, LOGS, DIST, TOPIC, QUEUE, FN]);
const isKnown = arn => KNOWN.has(arn);
const matchKnown = pattern => {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return [...KNOWN].filter(a => re.test(a));
};

test('CloudFront OAC grant -> origin edge', () => {
  const edges = extractPolicyEdges({
    Statement: [{
      Effect: 'Allow',
      Principal: { Service: 'cloudfront.amazonaws.com' },
      Action: 's3:GetObject',
      Condition: { StringEquals: { 'AWS:SourceArn': DIST } },
    }],
  }, BUCKET, isKnown, matchKnown);
  assert.deepEqual(edges.edges, [{ from: DIST, to: BUCKET, label: 'OAC read', kind: 'origin' }]);
  assert.equal(edges.publicPolicy, null);
});

test('legacy CloudFront OAI principal -> origin edge', () => {
  const edges = extractPolicyEdges({
    Statement: [{
      Effect: 'Allow',
      Principal: { AWS: 'arn:aws:iam::cloudfront:user/CloudFront Origin Access Identity E2QWRUHXYZ' },
      Action: 's3:GetObject',
    }],
  }, BUCKET, isKnown, matchKnown, id => (id === 'E2QWRUHXYZ' ? DIST : undefined));
  assert.deepEqual(edges.edges, [{ from: DIST, to: BUCKET, label: 'OAI read', kind: 'origin' }]);
});

test('SNS -> SQS via queue policy (ArnEquals)', () => {
  const edges = extractPolicyEdges({
    Statement: [{
      Effect: 'Allow',
      Principal: { Service: 'sns.amazonaws.com' },
      Action: 'sqs:SendMessage',
      Condition: { ArnEquals: { 'aws:SourceArn': TOPIC } },
    }],
  }, QUEUE, isKnown, matchKnown);
  assert.deepEqual(edges.edges, [{ from: TOPIC, to: QUEUE, label: 'notifies', kind: 'event' }]);
});

test('S3 -> Lambda via resource policy with glob SourceArn', () => {
  const edges = extractPolicyEdges({
    Statement: [{
      Effect: 'Allow',
      Principal: { Service: 's3.amazonaws.com' },
      Action: 'lambda:InvokeFunction',
      Condition: { ArnLike: { 'AWS:SourceArn': 'arn:aws:s3:::my-a*' } },
    }],
  }, FN, isKnown, matchKnown);
  assert.deepEqual(edges.edges, [{ from: BUCKET, to: FN, label: 'invokes', kind: 'event' }]);
});

test('S3 server access logging -> "access logs" edge', () => {
  const edges = extractPolicyEdges({
    Statement: [{
      Effect: 'Allow',
      Principal: { Service: 'logging.s3.amazonaws.com' },
      Action: 's3:PutObject',
      Condition: { ArnLike: { 'aws:SourceArn': BUCKET } },
    }],
  }, LOGS, isKnown, matchKnown);
  assert.deepEqual(edges.edges, [{ from: BUCKET, to: LOGS, label: 'access logs', kind: '' }]);
});

test('public policy detected; conditioned wildcard is not public', () => {
  const pub = extractPolicyEdges({
    Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: `${BUCKET}/*` }],
  }, BUCKET, isKnown, matchKnown);
  assert.equal(pub.publicPolicy, 's3:GetObject');

  const conditioned = extractPolicyEdges({
    Statement: [{
      Effect: 'Allow', Principal: { AWS: '*' }, Action: 's3:GetObject',
      Condition: { StringEquals: { 'aws:SourceVpce': 'vpce-123' } },
    }],
  }, BUCKET, isKnown, matchKnown);
  assert.equal(conditioned.publicPolicy, null);
});

test('Deny statements and unknown sources are ignored', () => {
  const edges = extractPolicyEdges({
    Statement: [
      { Effect: 'Deny', Principal: '*', Action: 's3:*' },
      {
        Effect: 'Allow', Principal: { Service: 'cloudtrail.amazonaws.com' },
        Action: 's3:PutObject',
        Condition: { StringEquals: { 'aws:SourceArn': 'arn:aws:cloudtrail:us-east-1:111122223333:trail/unscanned' } },
      },
    ],
  }, LOGS, isKnown, matchKnown);
  assert.equal(edges.edges.length, 0);
  assert.equal(edges.publicPolicy, null);
});

test('multiple statements accumulate edges', () => {
  const edges = extractPolicyEdges({
    Statement: [
      { Effect: 'Allow', Principal: { Service: 'cloudfront.amazonaws.com' }, Action: 's3:GetObject',
        Condition: { StringEquals: { 'AWS:SourceArn': [DIST] } } },
      { Effect: 'Allow', Principal: { Service: 'logging.s3.amazonaws.com' }, Action: 's3:PutObject',
        Condition: { ArnLike: { 'aws:SourceArn': LOGS } } },
    ],
  }, BUCKET, isKnown, matchKnown);
  assert.equal(edges.edges.length, 2);
  assert.deepEqual(edges.edges.map(e => e.from).sort(), [DIST, LOGS].sort());
});
