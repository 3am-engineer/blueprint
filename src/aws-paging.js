/**
 * Helpers for talking to AWS list APIs without silently truncating results.
 *
 * Most `Describe*`/`List*` calls return one page and a cursor. Skipping the
 * cursor loop produces a diagram that looks complete but quietly omits
 * resources once an account grows past the default page size.
 */

/** Page cap per call site — a stuck cursor would otherwise loop forever. */
const MAX_PAGES = 500;

/** Names and messages AWS uses when it wants the caller to back off. */
export function isThrottleError(err) {
  if (!err) return false;
  const text = `${err.name || ''} ${err.Code || ''} ${err.message || ''}`;
  return /throttl|TooManyRequests|RequestLimitExceeded|SlowDown|Rate exceeded/i.test(text);
}

/**
 * Retry a call that AWS rejected for throttling. Permanent errors
 * (AccessDenied, ValidationException, …) are rethrown immediately.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ attempts?: number, baseMs?: number }} [opts]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, opts = {}) {
  const attempts = opts.attempts ?? 4;
  const baseMs = opts.baseMs ?? 200;
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isThrottleError(e) || i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, baseMs * 2 ** i));
    }
  }
  throw last;
}

/**
 * Drain a cursor-paginated AWS call.
 *
 * AWS is inconsistent about cursor field names: most `Describe*` APIs echo the
 * next cursor back in `Marker`, Lambda returns `NextMarker`, SNS and EC2 use
 * `NextToken`, and the tagging API uses `PaginationToken`. Pass whichever the
 * specific API returns.
 *
 * @template T
 * @param {(cursor: string|undefined) => Promise<object>} send Issues one page.
 * @param {(page: object) => T[]|undefined} pick Extracts items from a page.
 * @param {{ nextKey?: string, onTruncate?: (pages:number) => void, retry?: {attempts?:number, baseMs?:number} }} [opts]
 * @returns {Promise<T[]>}
 */
export async function drain(send, pick, opts = {}) {
  const nextKey = opts.nextKey || 'Marker';
  const out = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await withRetry(() => send(cursor), opts.retry);
    const items = pick(resp);
    if (items?.length) out.push(...items);
    cursor = resp?.[nextKey];
    // IsTruncated is authoritative on the IAM APIs, which return a Marker even
    // on the final page.
    if (!cursor || resp?.IsTruncated === false) return out;
  }
  opts.onTruncate?.(MAX_PAGES);
  return out;
}

/**
 * Split a list into fixed-size batches. Several AWS APIs cap how many
 * identifiers one request may carry (DescribeLoadBalancers allows 20 ARNs),
 * and exceeding the cap fails the whole call rather than truncating it.
 *
 * @template T @param {T[]} items @param {number} size @returns {T[][]}
 */
export function chunk(items, size) {
  if (size < 1) throw new RangeError('chunk size must be >= 1');
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Map over items with at most `limit` promises in flight. Used to fan out
 * per-region work without opening 35 simultaneous AWS connections and
 * tripping throttling.
 *
 * Results keep input order. A rejected item rejects the whole call, so callers
 * that want best-effort behaviour should catch inside `fn`.
 *
 * @template T,R @param {T[]} items @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: width }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/** Drop duplicate edges left behind by concurrent per-region enrichment. */
export function dedupeEdges(edges) {
  const seen = new Set();
  return edges.filter(e => {
    const key = `${e.from}\u0000${e.to}\u0000${e.kind || ''}\u0000${e.label || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
