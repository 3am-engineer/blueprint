import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.js';

test('--region all enables allRegions', () => {
  const args = parseArgs(['--tag', 'Env', '--region', 'all']);
  assert.equal(args.allRegions, true);
  assert.equal(args.region, undefined);
});

test('--region ap-southeast-1 stays explicit', () => {
  const args = parseArgs(['--tag', 'Env', '--region', 'ap-southeast-1']);
  assert.equal(args.allRegions, undefined);
  assert.deepEqual(args.region, ['ap-southeast-1']);
});

test('--all-regions still works', () => {
  const args = parseArgs(['--tag', 'Env', '--all-regions']);
  assert.equal(args.allRegions, true);
});

test('--role-arn and --external-id are parsed', () => {
  const args = parseArgs([
    '--account', '--role-arn', 'arn:aws:iam::1:role/Read', '--external-id', 'ext-1',
  ]);
  assert.equal(args.roleArn, 'arn:aws:iam::1:role/Read');
  assert.equal(args.externalId, 'ext-1');
  assert.equal(args.accountScope, true);
});

test('--diff <file> stores the previous scan path', () => {
  const args = parseArgs(['--from-json', 'new.json', '--diff', 'old.json']);
  assert.equal(args.diff, 'old.json');
  assert.equal(args.fromJson, 'new.json');
});

test('--diff without a path means compare against the last scan in --out', () => {
  const args = parseArgs(['--account', '--diff', '--out', 'diagrams']);
  assert.equal(args.diff, true);
  assert.equal(args.out, 'diagrams');
  assert.equal(args.accountScope, true);
});
