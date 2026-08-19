/**
 * Scanner unit tests that do not talk to AWS: ARN parsing and the helpers
 * that turn a target-group member into a scanned resource.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArn, resolveLbTarget } from '../src/scan.js';

test('parseArn keeps the partition so china/gov ARNs stay intact', () => {
  const commercial = parseArn('arn:aws:ec2:us-east-1:123456789012:instance/i-abc');
  assert.equal(commercial.partition, 'aws');
  assert.equal(commercial.service, 'ec2');
  assert.equal(commercial.type, 'instance');
  assert.equal(commercial.id, 'i-abc');
  assert.equal(commercial.region, 'us-east-1');
  assert.equal(commercial.account, '123456789012');

  const china = parseArn('arn:aws-cn:s3:::bucket-cn');
  assert.equal(china.partition, 'aws-cn');
  assert.equal(china.service, 's3');
  assert.equal(china.id, 'bucket-cn');

  const gov = parseArn('arn:aws-us-gov:lambda:us-gov-west-1:111122223333:function:fn');
  assert.equal(gov.partition, 'aws-us-gov');
  assert.equal(gov.service, 'lambda');
  assert.equal(gov.type, 'function');
  assert.equal(gov.id, 'fn');
  assert.equal(gov.region, 'us-gov-west-1');
});

test('parseArn handles S3, SNS and ELB resource shapes', () => {
  assert.equal(parseArn('arn:aws:sns:us-east-1:1:topic-name').id, 'topic-name');
  const lb = parseArn('arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/alb/abc');
  assert.equal(lb.type, 'loadbalancer');
  assert.equal(lb.id, 'app/alb/abc');
});

test('resolveLbTarget matches instance id, private IP, IPv6 and ARN', () => {
  const inst = { arn: 'arn:aws:ec2:us-east-1:1:instance/i-web', id: 'i-web' };
  const fn = { arn: 'arn:aws:lambda:us-east-1:1:function:api', id: 'api' };
  const idx = {
    byId: new Map([['i-web', inst], ['us-east-1::api', fn]]),
    byArn: new Map([[fn.arn, fn]]),
    byIp: new Map([['10.0.1.11', inst], ['2001:db8::10', inst]]),
  };

  assert.equal(resolveLbTarget('i-web', idx), inst);
  assert.equal(resolveLbTarget('10.0.1.11', idx), inst, 'IP-mode target groups');
  assert.equal(resolveLbTarget('2001:db8::10', idx), inst, 'IPv6 target groups');
  assert.equal(resolveLbTarget(fn.arn, idx), fn, 'Lambda / ARN targets');
  assert.equal(resolveLbTarget('10.9.9.9', idx), null);
  assert.equal(resolveLbTarget('', idx), null);
});
