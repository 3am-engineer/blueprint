/**
 * Compare two scan models and produce a structured diff plus a merged scan
 * the renderer can highlight (added / removed / changed).
 */
import pc from 'picocolors';
import { idKey } from './aws-ids.js';

const COMPARE_TOP = ['name', 'state', 'vpcId', 'subnetId', 'az'];

export function resourceKey(r) {
  if (!r) return '';
  if (r.arn) return r.arn;
  return idKey(r.region, r.id);
}

export function edgeKey(e) {
  return `${e?.from || ''}|${e?.to || ''}|${e?.kind || ''}`;
}

function stable(v) {
  if (v == null) return null;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(stable);
  const out = {};
  for (const k of Object.keys(v).sort()) out[k] = stable(v[k]);
  return out;
}

function same(a, b) {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

function isExposureField(path, to) {
  if (path === 'extra.publicPolicy' && to) return true;
  if (path === 'extra.scheme' && String(to).toLowerCase() === 'internet-facing') return true;
  return false;
}

function fieldDiffs(oldR, newR) {
  const fields = [];
  for (const k of COMPARE_TOP) {
    if (!same(oldR[k], newR[k]) && (oldR[k] != null || newR[k] != null)) {
      fields.push({ path: k, from: oldR[k] ?? null, to: newR[k] ?? null });
    }
  }
  const oldTags = oldR.tags || {};
  const newTags = newR.tags || {};
  for (const k of new Set([...Object.keys(oldTags), ...Object.keys(newTags)])) {
    if (!same(oldTags[k], newTags[k])) {
      fields.push({ path: `tags.${k}`, from: oldTags[k] ?? null, to: newTags[k] ?? null });
    }
  }
  const oldEx = oldR.extra || {};
  const newEx = newR.extra || {};
  for (const k of new Set([...Object.keys(oldEx), ...Object.keys(newEx)])) {
    if (!same(oldEx[k], newEx[k])) {
      fields.push({ path: `extra.${k}`, from: oldEx[k] ?? null, to: newEx[k] ?? null });
    }
  }
  return fields;
}

export function diffScans(oldScan, newScan) {
  const oldRes = (oldScan && oldScan.resources) || [];
  const newRes = (newScan && newScan.resources) || [];
  const oldMap = new Map(oldRes.map(r => [resourceKey(r), r]));
  const newMap = new Map(newRes.map(r => [resourceKey(r), r]));

  const added = [];
  const removed = [];
  const changed = [];

  for (const [k, r] of newMap) {
    if (!oldMap.has(k)) {
      added.push(r);
      continue;
    }
    const fields = fieldDiffs(oldMap.get(k), r);
    if (fields.length) {
      const exposure = fields.some(f => isExposureField(f.path, f.to));
      changed.push({ resource: r, before: oldMap.get(k), fields, exposure });
    }
  }
  for (const [k, r] of oldMap) {
    if (!newMap.has(k)) removed.push(r);
  }

  const oldEdges = (oldScan && oldScan.edges) || [];
  const newEdges = (newScan && newScan.edges) || [];
  const oldE = new Map(oldEdges.map(e => [edgeKey(e), e]));
  const newE = new Map(newEdges.map(e => [edgeKey(e), e]));

  const edgesAdded = [];
  const edgesRemoved = [];
  for (const [k, e] of newE) {
    if (!oldE.has(k)) {
      edgesAdded.push({ ...e, exposure: e.kind === 'internet' });
    }
  }
  for (const [k, e] of oldE) {
    if (!newE.has(k)) edgesRemoved.push(e);
  }

  const exposure = changed.filter(c => c.exposure).length
    + edgesAdded.filter(e => e.exposure).length
    + added.filter(r => r.extra?.publicPolicy || String(r.extra?.scheme || '').toLowerCase() === 'internet-facing').length;

  return {
    added,
    removed,
    changed,
    edges: { added: edgesAdded, removed: edgesRemoved },
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      edgesAdded: edgesAdded.length,
      edgesRemoved: edgesRemoved.length,
      exposure,
    },
    meta: {
      from: oldScan?.meta?.generatedAt || null,
      to: newScan?.meta?.generatedAt || null,
      accountId: newScan?.meta?.accountId || oldScan?.meta?.accountId || null,
    },
  };
}

export function hasChanges(diff) {
  const s = diff?.summary || {};
  return !!(s.added || s.removed || s.changed || s.edgesAdded || s.edgesRemoved);
}

/** Live scan plus ghost copies of removed resources/edges, tagged for the renderer. */
export function mergeScanForDiff(newScan, oldScan, diff) {
  const addedKeys = new Set(diff.added.map(resourceKey));
  const changedKeys = new Set(diff.changed.map(c => resourceKey(c.resource)));
  const addedEdgeKeys = new Set(diff.edges.added.map(edgeKey));

  const resources = [
    ...(newScan.resources || []).map(r => {
      const k = resourceKey(r);
      if (addedKeys.has(k)) return { ...r, diffStatus: 'added' };
      if (changedKeys.has(k)) return { ...r, diffStatus: 'changed' };
      return { ...r };
    }),
    ...diff.removed.map(r => ({ ...r, diffStatus: 'removed' })),
  ];
  const edges = [
    ...(newScan.edges || []).map(e => (
      addedEdgeKeys.has(edgeKey(e)) ? { ...e, diffStatus: 'added' } : { ...e }
    )),
    ...diff.edges.removed.map(e => ({ ...e, diffStatus: 'removed' })),
  ];
  return {
    ...newScan,
    resources,
    edges,
    vpcs: { ...(oldScan?.vpcs || {}), ...(newScan.vpcs || {}) },
    subnets: { ...(oldScan?.subnets || {}), ...(newScan.subnets || {}) },
    diff,
  };
}

function shortRes(r) {
  const kind = [r.service, r.type].filter(Boolean).join(':') || 'resource';
  const name = r.name || r.id || resourceKey(r);
  const where = r.region || '';
  return `${kind}  ${name}${where ? `  ${where}` : ''}`;
}

function fmtVal(v) {
  if (v == null || v === '') return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function paint(color) {
  if (color) return pc;
  const id = s => s;
  return { green: id, red: id, yellow: id, cyan: id, dim: id, bold: id };
}

export function formatDiff(diff, { color = true } = {}) {
  const c = paint(color);
  const s = diff.summary;
  const when = [diff.meta?.from, diff.meta?.to].filter(Boolean).join(' → ') || 'two scans';
  const lines = [
    c.bold(`Scan diff  ${when}`),
    diff.meta?.accountId ? c.dim(`Account ${diff.meta.accountId}`) : '',
    '',
    `  ${c.green(`+ ${s.added} added`)}`,
    `  ${c.red(`− ${s.removed} removed`)}`,
    `  ${c.yellow(`~ ${s.changed} changed`)}`,
    `  ${c.cyan(`→ ${s.edgesAdded} new links, ${s.edgesRemoved} gone`)}`,
  ];
  if (s.exposure) lines.push(`  ${c.red(`! ${s.exposure} new exposure`)}`);

  if (diff.added.length) {
    lines.push('', c.bold('Added'));
    for (const r of diff.added) {
      const exp = r.extra?.publicPolicy || String(r.extra?.scheme || '').toLowerCase() === 'internet-facing';
      lines.push(`  ${c.green('+')} ${shortRes(r)}${exp ? c.red('  (exposure)') : ''}`);
    }
  }
  if (diff.removed.length) {
    lines.push('', c.bold('Removed'));
    for (const r of diff.removed) lines.push(`  ${c.red('−')} ${shortRes(r)}`);
  }
  if (diff.changed.length) {
    lines.push('', c.bold('Changed'));
    for (const ch of diff.changed) {
      lines.push(`  ${c.yellow('~')} ${shortRes(ch.resource)}${ch.exposure ? c.red('  (exposure)') : ''}`);
      for (const f of ch.fields) {
        lines.push(c.dim(`      ${f.path}: ${fmtVal(f.from)} → ${fmtVal(f.to)}`));
      }
    }
  }
  if (diff.edges.added.length || diff.edges.removed.length) {
    lines.push('', c.bold('Links'));
    for (const e of diff.edges.added) {
      lines.push(`  ${c.green('+')} ${e.from} → ${e.to}  ${e.kind || ''}${e.exposure ? c.red('  (exposure)') : ''}`);
    }
    for (const e of diff.edges.removed) {
      lines.push(`  ${c.red('−')} ${e.from} → ${e.to}  ${e.kind || ''}`);
    }
  }
  if (!hasChanges(diff)) lines.push('', c.dim('No resource or link changes.'));
  return lines.filter((l, i) => l !== '' || i === 2).join('\n');
}
