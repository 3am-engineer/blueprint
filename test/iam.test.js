import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractIamGrants } from '../src/scan.js';

const BUCKET = 'arn:aws:s3:::app-assets';
const TABLE = 'arn:aws:dynamodb:us-east-1:111122223333:table/sessions';
const QUEUE = 'arn:aws:sqs:us-east-1:111122223333:jobs';

const KNOWN = new Set([BUCKET, TABLE, QUEUE]);
const isKnown = arn => KNOWN.has(arn);
const matchKnown = pattern => {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return [...KNOWN].filter(a => re.test(a));
};

test('object-level S3 grant attributes to the bucket', () => {
  const grants = extractIamGrants({
    Statement: [{
      Effect: 'Allow',
      Action: ['s3:GetObject', 's3:PutObject'],
      Resource: [`${BUCKET}/*`],
    }],
  }, isKnown, matchKnown);
  assert.deepEqual(grants, [{ target: BUCKET, label: 'read/write' }]);
});

test('exact DynamoDB grant with read-only actions', () => {
  const grants = extractIamGrants({
    Statement: [{
      Effect: 'Allow',
      Action: ['dynamodb:GetItem', 'dynamodb:Query'],
      Resource: TABLE,
    }],
  }, isKnown, matchKnown);
  assert.deepEqual(grants, [{ target: TABLE, label: 'reads' }]);
});

test('Resource "*" is skipped; service wildcard action labels read/write', () => {
  const star = extractIamGrants({
    Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }],
  }, isKnown, matchKnown);
  assert.equal(star.length, 0);

  const scoped = extractIamGrants({
    Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: `${BUCKET}/*` }],
  }, isKnown, matchKnown);
  assert.deepEqual(scoped, [{ target: BUCKET, label: 'read/write' }]);
});

test('glob resource matches scanned ARNs; SQS send verb', () => {
  const grants = extractIamGrants({
    Statement: [{
      Effect: 'Allow',
      Action: 'sqs:SendMessage',
      Resource: 'arn:aws:sqs:us-east-1:111122223333:j*',
    }],
  }, isKnown, matchKnown);
  assert.deepEqual(grants, [{ target: QUEUE, label: 'sends' }]);
});

test('verbs accumulate across statements for the same target', () => {
  const grants = extractIamGrants({
    Statement: [
      { Effect: 'Allow', Action: 's3:GetObject', Resource: `${BUCKET}/*` },
      { Effect: 'Allow', Action: 's3:PutObject', Resource: `${BUCKET}/uploads/*` },
    ],
  }, isKnown, matchKnown);
  assert.deepEqual(grants, [{ target: BUCKET, label: 'read/write' }]);
});

test('Deny and unknown resources ignored', () => {
  const grants = extractIamGrants({
    Statement: [
      { Effect: 'Deny', Action: 's3:*', Resource: `${BUCKET}/*` },
      { Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::not-scanned/*' },
    ],
  }, isKnown, matchKnown);
  assert.equal(grants.length, 0);
});
