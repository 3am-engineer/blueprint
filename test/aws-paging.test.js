import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drain, chunk, mapLimit, dedupeEdges, isThrottleError, withRetry } from '../src/aws-paging.js';

test('drain follows Marker cursors to the last page', async () => {
  const pages = [
    { Items: ['a', 'b'], Marker: 'p2' },
    { Items: ['c'], Marker: 'p3' },
    { Items: ['d'] },
  ];
  const seen = [];
  const out = await drain(cursor => {
    seen.push(cursor);
    return Promise.resolve(pages.shift());
  }, p => p.Items);

  assert.deepEqual(out, ['a', 'b', 'c', 'd']);
  assert.deepEqual(seen, [undefined, 'p2', 'p3'], 'cursor is threaded back in');
});

test('drain honours a custom cursor field (Lambda uses NextMarker)', async () => {
  const pages = [
    { EventSourceMappings: [1], NextMarker: 'x' },
    { EventSourceMappings: [2] },
  ];
  const out = await drain(
    () => Promise.resolve(pages.shift()),
    p => p.EventSourceMappings,
    { nextKey: 'NextMarker' },
  );
  assert.deepEqual(out, [1, 2]);
});

test('drain stops on IsTruncated:false even when a Marker is echoed back', async () => {
  // The IAM list APIs return a Marker on the final page; only IsTruncated is
  // authoritative. Without this check the loop would never terminate.
  let calls = 0;
  const out = await drain(() => {
    calls++;
    return Promise.resolve({ PolicyNames: ['p' + calls], Marker: 'always', IsTruncated: false });
  }, p => p.PolicyNames);

  assert.equal(calls, 1);
  assert.deepEqual(out, ['p1']);
});

test('drain gives up rather than looping forever on a stuck cursor', async () => {
  let truncatedAt = 0;
  const out = await drain(
    () => Promise.resolve({ Items: ['x'], Marker: 'never-changes' }),
    p => p.Items,
    { onTruncate: pages => { truncatedAt = pages; } },
  );
  assert.equal(truncatedAt, 500, 'reports that it bailed out');
  assert.equal(out.length, 500);
});

test('drain tolerates pages with no items', async () => {
  const pages = [{ Marker: 'n' }, { Items: null, Marker: 'm' }, {}];
  const out = await drain(() => Promise.resolve(pages.shift()), p => p.Items);
  assert.deepEqual(out, []);
});

test('chunk splits to the API cap and keeps every item', () => {
  const arns = Array.from({ length: 45 }, (_, i) => 'arn-' + i);
  const batches = chunk(arns, 20);
  assert.deepEqual(batches.map(b => b.length), [20, 20, 5]);
  assert.deepEqual(batches.flat(), arns, 'nothing dropped or duplicated');
  assert.deepEqual(chunk([], 20), []);
  assert.throws(() => chunk([1], 0), RangeError);
});

test('mapLimit preserves order while capping concurrency', async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  let inFlight = 0, peak = 0;
  const out = await mapLimit(items, 6, async n => {
    peak = Math.max(peak, ++inFlight);
    await new Promise(r => setTimeout(r, n % 3));
    inFlight--;
    return n * 2;
  });
  assert.deepEqual(out, items.map(n => n * 2), 'results stay in input order');
  assert.ok(peak <= 6, `peak concurrency ${peak} exceeded the limit`);
  assert.ok(peak > 1, 'work actually ran in parallel');
});

test('mapLimit handles empty input and a limit above the item count', async () => {
  assert.deepEqual(await mapLimit([], 6, async () => 1), []);
  assert.deepEqual(await mapLimit([1, 2], 99, async n => n), [1, 2]);
});

test('isThrottleError recognises the SDK names AWS actually throws', () => {
  assert.equal(isThrottleError({ name: 'Throttling' }), true);
  assert.equal(isThrottleError({ name: 'ThrottlingException' }), true);
  assert.equal(isThrottleError({ name: 'TooManyRequestsException' }), true);
  assert.equal(isThrottleError({ name: 'RequestLimitExceeded' }), true);
  assert.equal(isThrottleError({ name: 'AccessDenied' }), false);
  assert.equal(isThrottleError({ message: 'Rate exceeded' }), true);
  assert.equal(isThrottleError(null), false);
});

test('withRetry retries a throttle then returns the success', async () => {
  let n = 0;
  const out = await withRetry(async () => {
    n++;
    if (n < 3) throw Object.assign(new Error('Rate exceeded'), { name: 'Throttling' });
    return 'ok';
  }, { attempts: 4, baseMs: 1 });
  assert.equal(out, 'ok');
  assert.equal(n, 3);
});

test('withRetry does not retry AccessDenied and surfaces the original error', async () => {
  let n = 0;
  await assert.rejects(
    () => withRetry(async () => {
      n++;
      throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    }, { attempts: 4, baseMs: 1 }),
    /denied/,
  );
  assert.equal(n, 1);
});

test('withRetry gives up after the last attempt', async () => {
  let n = 0;
  await assert.rejects(
    () => withRetry(async () => {
      n++;
      throw Object.assign(new Error('slow'), { name: 'Throttling' });
    }, { attempts: 3, baseMs: 1 }),
    /slow/,
  );
  assert.equal(n, 3);
});

test('drain retries a throttled page instead of aborting the list', async () => {
  const pages = [
    { Items: ['a'], Marker: 'p2' },
    { Items: ['b'] },
  ];
  let blows = 1;
  const out = await drain(cursor => {
    if (blows-- > 0) {
      return Promise.reject(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }));
    }
    return Promise.resolve(pages.shift());
  }, p => p.Items, { retry: { attempts: 3, baseMs: 1 } });
  assert.deepEqual(out, ['a', 'b']);
});

test('dedupeEdges collapses races but keeps genuinely distinct edges', () => {
  const edges = [
    { from: 'a', to: 'b', kind: 'sg-flow', label: 'tcp/443' },
    { from: 'a', to: 'b', kind: 'sg-flow', label: 'tcp/443' },   // concurrent duplicate
    { from: 'a', to: 'b', kind: 'iam', label: 'reads' },         // different kind
    { from: 'a', to: 'b', kind: 'sg-flow', label: 'tcp/80' },    // different port
    { from: 'b', to: 'a', kind: 'sg-flow', label: 'tcp/443' },   // opposite direction
  ];
  const out = dedupeEdges(edges);
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], edges[0], 'first occurrence is the one kept');
});
