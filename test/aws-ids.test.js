import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dnsSuffix, sqsQueueUrl, s3BucketArn, partitionOf, idKey,
  isIpv4, isIpv6, isInternetCidr, isSensitiveTagKey, redactTags, redactScan,
  extractArns,
} from '../src/aws-ids.js';

test('dnsSuffix and queue URLs follow the partition', () => {
  assert.equal(dnsSuffix('aws'), 'amazonaws.com');
  assert.equal(dnsSuffix('aws-us-gov'), 'amazonaws.com');
  assert.equal(dnsSuffix('aws-cn'), 'amazonaws.com.cn');
  assert.equal(
    sqsQueueUrl('aws-cn', 'cn-north-1', '123', 'jobs'),
    'https://sqs.cn-north-1.amazonaws.com.cn/123/jobs',
  );
  assert.equal(
    sqsQueueUrl('aws', 'us-east-1', '123', 'jobs'),
    'https://sqs.us-east-1.amazonaws.com/123/jobs',
  );
});

test('s3BucketArn and partitionOf keep china/gov partitions', () => {
  assert.equal(s3BucketArn('aws-cn', 'logs'), 'arn:aws-cn:s3:::logs');
  assert.equal(s3BucketArn('aws', 'logs'), 'arn:aws:s3:::logs');
  assert.equal(partitionOf('arn:aws-us-gov:iam::1:root'), 'aws-us-gov');
  assert.equal(partitionOf('not-an-arn'), 'aws');
});

test('idKey is region-qualified so duplicate names do not collide', () => {
  assert.notEqual(idKey('us-east-1', 'api'), idKey('eu-west-1', 'api'));
  assert.equal(idKey('us-east-1', 'api'), 'us-east-1::api');
});

test('address and internet CIDR helpers cover v4 and v6', () => {
  assert.equal(isIpv4('10.0.1.11'), true);
  assert.equal(isIpv4('2001:db8::1'), false);
  assert.equal(isIpv6('2001:db8::1'), true);
  assert.equal(isIpv6('10.0.1.11'), false);
  assert.equal(isInternetCidr('0.0.0.0/0'), true);
  assert.equal(isInternetCidr('::/0'), true);
  assert.equal(isInternetCidr('10.0.0.0/8'), false);
});

test('redactTags masks secret-looking keys and leaves the rest', () => {
  assert.equal(isSensitiveTagKey('db-password'), true);
  assert.equal(isSensitiveTagKey('Name'), false);
  const out = redactTags({ Name: 'web', api_key: 'AKIA', token: 'x' });
  assert.equal(out.Name, 'web');
  assert.equal(out.api_key, '***');
  assert.equal(out.token, '***');
  const scan = redactScan({
    meta: { accountId: '1' },
    resources: [{ arn: 'a', tags: { secret: 'shh', Env: 'prod' } }],
  });
  assert.equal(scan.resources[0].tags.secret, '***');
  assert.equal(scan.resources[0].tags.Env, 'prod');
});

test('extractArns pulls Step Functions task targets out of ASL', () => {
  const def = JSON.stringify({
    StartAt: 'Do',
    States: {
      Do: { Type: 'Task', Resource: 'arn:aws:lambda:us-east-1:1:function:fn' },
    },
  });
  assert.deepEqual(extractArns(def), ['arn:aws:lambda:us-east-1:1:function:fn']);
});
