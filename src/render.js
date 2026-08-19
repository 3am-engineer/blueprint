/**
 * Layout (elkjs) + SVG rendering + self-contained HTML portal generation.
 *
 * Layout notes
 * ------------
 * ELK is run once over the whole hierarchy (INCLUDE_CHILDREN). Two things are
 * easy to get wrong and produced broken output in the past:
 *   1. Edge coordinates are relative to `edge.container` (the ELK node whose
 *      coordinate system the route was computed in) — NOT the node the edge
 *      was declared on. We resolve every container's absolute origin first,
 *      then offset each edge by its container's origin.
 *   2. Edge labels are placed by ELK itself (inline labels), so they sit ON
 *      the routed line, never on top of each other.
 */
import ELK from 'elkjs/lib/elk.bundled.js';
import { toDrawio, toMermaid, toExcalidraw } from './export.js';

const NODE_W = 138, NODE_H = 100, ICON = 44, OS_BADGE = 20;
const FONT = `'Amazon Ember','Segoe UI',Helvetica,Arial,sans-serif`;

/** Official AWS group-container palette (2023+ icon guidelines). */
const KIND_STYLE = {
  account:          { stroke: '#E7157B', fill: 'none' },
  region:           { stroke: '#00A4A6', fill: 'none', dash: '5 4' },
  vpc:              { stroke: '#8C4FFF', fill: 'none' },
  'subnet-public':  { stroke: '#7AA116', fill: '#7AA116', fillOpacity: 0.05 },
  'subnet-private': { stroke: '#00A4A6', fill: '#00A4A6', fillOpacity: 0.05 },
  eks:              { stroke: '#E07700', fill: '#E07700', fillOpacity: 0.04 },
  category:         { stroke: '#5F6B7A', fill: '#5F6B7A', fillOpacity: 0.03 },
  regional:         { stroke: '#7D8998', fill: '#7D8998', fillOpacity: 0.04, dash: '4 4' },
};

const LABEL_CHARS = 16;
const LABEL_LINES = 3;

/** Wrap a node label; ellipsize the last line so text never overflows the card. */
export function nodeLines(label) {
  let rest = String(label || '');
  const lines = [];
  while (rest && lines.length < LABEL_LINES) {
    if (rest.length <= LABEL_CHARS) { lines.push(rest); break; }
    let br = -1;
    for (let i = 1; i < rest.length && i <= LABEL_CHARS; i++) {
      if (/[ \-_.:/]/.test(rest[i])) br = i;
    }
    if (br < 6) br = LABEL_CHARS;
    const rawEnd = br + (rest[br] !== ' ' ? 1 : 0);
    let take = rest.slice(0, rawEnd).replace(/[\s\-_./]+$/, '');
    rest = rest.slice(rawEnd).replace(/^[\s\-_./]+/, '');
    if (!take) {
      take = rest.slice(0, LABEL_CHARS);
      rest = rest.slice(take.length);
    }
    if (lines.length === LABEL_LINES - 1) {
      const leftover = take + rest;
      take = leftover.length > LABEL_CHARS ? leftover.slice(0, LABEL_CHARS - 1) + '…' : leftover;
      rest = '';
    }
    lines.push(take);
  }
  return lines.length ? lines : [''];
}

export function fitSublabel(s) {
  s = String(s || '');
  return s.length > 20 ? s.slice(0, 19) + '…' : s;
}

/** Per-node card size — wide enough for the wrapped (ellipsized) label. */
function nodeSize(n) {
  const lines = nodeLines(n.label);
  const sub = n.sublabel && n.sublabel !== n.label ? fitSublabel(n.sublabel) : '';
  const textW = Math.max(
    ...lines.map(l => l.length * 6.9),
    sub.length * 5.2,
  ) + 20;
  return {
    w: Math.max(NODE_W, Math.min(196, Math.ceil(textW))),
    h: 58 + lines.length * 13 + (sub ? 16 : 8),
    lines,
    sub,
  };
}

const EDGE_STYLE = {
  internet:     { color: '#DD6B10', label: 'Internet ingress' },
  'internet-out': { color: '#C45500', label: 'Internet egress', dash: '5 4' },
  'nat-egress': { color: '#8C4FFF', label: 'Private subnet → NAT', dash: '5 4' },
  'lb-target':  { color: '#0972D3', label: 'Load balancer → target' },
  'sg-flow':    { color: '#067F68', label: 'Allowed traffic (security groups)' },
  'sg-wide':    { color: '#B7791F', label: 'Broad SG rule — review', dash: '3 3' },
  'asg-member': { color: '#8C4FFF', label: 'Auto Scaling / cluster member', dash: '5 4' },
  event:        { color: '#B0084D', label: 'Event / trigger' },
  origin:       { color: '#7048E8', label: 'CloudFront → origin' },
  iam:          { color: '#5C7CFA', label: 'IAM role access', dash: '2 3' },
  tls:          { color: '#DD344C', label: 'TLS certificate' },
  default:      { color: '#5F6B7A', label: 'Link' },
};
const edgeStyle = kind => EDGE_STYLE[kind] || EDGE_STYLE.default;

export async function renderPortal(graph, scan, opts = {}) {
  const title = opts.title || buildTitle(scan);

  const laid = await layout(graph);
  const svg = renderSvg(graph, laid, title);
  const exports = {
    drawio: toDrawio(graph, laid),
    mermaid: toMermaid(graph),
    excalidraw: toExcalidraw(graph, laid),
  };
  const html = renderHtml(graph, svg, title, scan, exports);
  return { html, svg, diagramJson: laid, exports };
}

function buildTitle(scan) {
  const m = scan.meta || {};
  const t = m.tagKey ? `${m.tagKey}${m.tagValue ? '=' + m.tagValue : ''}`
    : m.vpcId ? `VPC ${m.vpcId}`
    : m.accountId ? `Account ${m.accountId}` : 'AWS';
  return `AWS Architecture · ${t}`;
}

/* ---------------------------- ELK layout ---------------------------- */

const HEADER_H = 34;          // room reserved for the container title bar

async function layout(graph) {
  const elk = new ELK();
  const childrenOf = new Map();
  for (const c of graph.containers) {
    if (!childrenOf.has(c.parent)) childrenOf.set(c.parent, []);
    childrenOf.get(c.parent).push(c);
  }
  const nodesByParent = new Map();
  for (const n of graph.nodes) {
    if (!nodesByParent.has(n.parent)) nodesByParent.set(n.parent, []);
    nodesByParent.get(n.parent).push(n);
  }

  const containerOpts = {
    'elk.padding': `[top=${HEADER_H + 18},left=26,bottom=24,right=26]`,
    'elk.spacing.nodeNode': '34',
    'elk.layered.spacing.nodeNodeBetweenLayers': '64',
    'elk.spacing.edgeNode': '24',
    'elk.spacing.edgeEdge': '14',
    'elk.spacing.componentComponent': '40',
  };

  const nodeShape = n => {
    const { w, h } = nodeSize(n);
    return { id: n.id, width: w, height: h };
  };

  // Containers whose nodes have no edges at all (typically "Regional services")
  // are laid out by hand as a compact strip at the bottom of their parent —
  // ELK's component packer would otherwise center them in a band of whitespace.
  const edgeTouched = new Set();
  for (const e of graph.edges) { edgeTouched.add(e.from); edgeTouched.add(e.to); }
  const floating = new Set();
  for (const c of graph.containers) {
    const kids = nodesByParent.get(c.id) || [];
    const hasSubContainers = (childrenOf.get(c.id) || []).length > 0;
    const parentHasOtherContent =
      (childrenOf.get(c.parent) || []).some(s => s.id !== c.id) ||
      (nodesByParent.get(c.parent) || []).length > 0;
    // A container can itself be an edge endpoint (bundle-collapsed fan-outs);
    // it must then stay in the ELK graph or the edge reference breaks.
    if ((c.kind === 'regional' || c.kind === 'category') && !hasSubContainers &&
      parentHasOtherContent && !edgeTouched.has(c.id) &&
      kids.length && kids.every(n => !edgeTouched.has(n.id))) {
      floating.add(c.id);
    }
  }

  function buildContainer(c) {
    const kids = [
      ...(childrenOf.get(c.id) || []).filter(k => !floating.has(k.id)).map(buildContainer),
      ...(nodesByParent.get(c.id) || []).map(nodeShape),
    ];
    return {
      id: c.id,
      layoutOptions: { ...containerOpts },
      // The label makes ELK size the container wide enough for its title
      // (plus the IGW chip when present).
      labels: [{ text: c.label, width: (c.icon ? 34 : 12) + c.label.length * 7.2 + 10 + (c.igw ? 48 : 0), height: HEADER_H - 8 }],
      children: kids,
    };
  }

  const elkGraph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '44',
      'elk.spacing.componentComponent': '56',
      'elk.spacing.edgeNode': '24',
      'elk.spacing.edgeEdge': '14',
      'elk.spacing.edgeLabel': '4',
      'elk.layered.spacing.nodeNodeBetweenLayers': '64',
      'elk.layered.spacing.edgeNodeBetweenLayers': '28',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '14',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.unnecessaryBendpoints': 'true',
      'elk.padding': '[top=12,left=12,bottom=12,right=12]',
    },
    children: [
      ...(childrenOf.get(null) || []).filter(k => !floating.has(k.id)).map(buildContainer),
      ...(nodesByParent.get(null) || []).map(nodeShape),   // e.g. the Internet node
    ],
    edges: graph.edges.map(e => ({
      id: e.id, sources: [e.from], targets: [e.to],
      labels: e.label ? [{
        text: e.label,
        width: e.label.length * 6.2 + 14, height: 17,
        layoutOptions: { 'elk.edgeLabels.inline': 'true' },
      }] : [],
    })),
  };

  const res = await elk.layout(elkGraph);

  // ---- Flatten to absolute coordinates ----
  const outNodes = [], outContainers = [], rawEdges = [];
  const nodeMeta = new Map(graph.nodes.map(n => [n.id, n]));
  const contMeta = new Map(graph.containers.map(c => [c.id, c]));
  const absOrigin = new Map([['root', { x: 0, y: 0 }]]);

  function walk(node, ox, oy) {
    const x = (node.x || 0) + ox, y = (node.y || 0) + oy;
    if (node.id !== 'root') absOrigin.set(node.id, { x, y });
    for (const e of node.edges || []) rawEdges.push(e);
    for (const child of node.children || []) {
      const cx = (child.x || 0) + x, cy = (child.y || 0) + y;
      if (nodeMeta.has(child.id)) {
        outNodes.push({ ...nodeMeta.get(child.id), x: cx, y: cy, w: child.width, h: child.height });
        absOrigin.set(child.id, { x: cx, y: cy });
      } else {
        outContainers.push({ ...contMeta.get(child.id), x: cx, y: cy, w: child.width, h: child.height });
        walk(child, x, y);
      }
    }
  }
  walk(res, 0, 0);

  // Edge routes + label boxes, offset by the ELK coordinate container.
  const outEdges = [];
  for (const e of rawEdges) {
    const off = absOrigin.get(e.container) || { x: 0, y: 0 };
    for (const s of e.sections || []) {
      const pts = [s.startPoint, ...(s.bendPoints || []), s.endPoint]
        .map(p => ({ x: p.x + off.x, y: p.y + off.y }));
      const lbl = (e.labels || [])[0];
      outEdges.push({
        id: e.id, points: pts,
        label: lbl && lbl.x != null
          ? { x: lbl.x + off.x, y: lbl.y + off.y, w: lbl.width, h: lbl.height, text: lbl.text }
          : null,
      });
    }
  }

  // ---- Hand-placed strips for edge-less containers (see `floating`) ----
  let totalW = res.width || 800, totalH = res.height || 600;
  for (const cid of floating) {
    const c = contMeta.get(cid);
    const kids = nodesByParent.get(cid) || [];
    const parentBox = outContainers.find(k => k.id === c.parent);
    const PAD = 26, GAP_X = 28, GAP_Y = 30, HEAD = HEADER_H + 14, GAP_STRIP = 20;

    // Grid that fits within the parent's inner width — cells sized to the
    // widest/tallest card (labels wrap, so node sizes vary).
    const sizes = kids.map(k => nodeSize(k));
    const cellW = Math.max(NODE_W, ...sizes.map(s => s.w));
    const cellH = Math.max(NODE_H, ...sizes.map(s => s.h));
    const innerW = parentBox ? parentBox.w - 2 * PAD : Infinity;
    const cols = Math.max(1, Math.min(kids.length,
      Math.floor((Math.max(innerW, cellW + 1) + GAP_X) / (cellW + GAP_X))));
    const rows = Math.ceil(kids.length / cols);
    const usedCols = Math.min(cols, kids.length);
    const w = Math.max(usedCols * (cellW + GAP_X) - GAP_X + 2 * PAD, c.label.length * 7.2 + 24);
    const h = HEAD + rows * (cellH + GAP_Y) - GAP_Y + 22;
    const x = parentBox ? parentBox.x + PAD : 12;
    const oldBottom = parentBox ? parentBox.y + parentBox.h : totalH;
    const y = oldBottom - 24 + GAP_STRIP;              // just below existing content
    const delta = (y + h + 24) - oldBottom;

    outContainers.push({ ...c, x, y, w, h });
    kids.forEach((n, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const s = sizes[i];
      outNodes.push({
        ...n, w: s.w, h: s.h,
        x: x + PAD + col * (cellW + GAP_X) + (cellW - s.w) / 2,
        y: y + HEAD + row * (cellH + GAP_Y),
      });
    });

    if (parentBox) {
      // Grow every ancestor, and shift anything laid out below the parent.
      const ancestors = new Set();
      for (let p = c.parent; p; p = contMeta.get(p)?.parent) ancestors.add(p);
      for (const k of outContainers) {
        if (ancestors.has(k.id)) k.h += delta;
        else if (k.id !== cid && k.y >= oldBottom - 0.5) k.y += delta;
      }
      for (const n of outNodes) if (n.parent !== cid && n.y >= oldBottom - 0.5) n.y += delta;
      for (const e of outEdges) for (const p of e.points) if (p.y >= oldBottom - 0.5) p.y += delta;
      totalH += delta;
      totalW = Math.max(totalW, x + w + 24);
    } else {
      totalH = y + h + 12;
      totalW = Math.max(totalW, x + w + 12);
    }
  }

  // Internet nodes are root siblings of the account. ELK parks them beside
  // the box and routes ingress around the perimeter — the inbound globe
  // looks orphaned and the orange lines wrap the whole diagram. Pin inbound
  // above the account and egress below, then draw short orthogonal stubs.
  const sized = placeInternetPoles(graph, outNodes, outContainers, outEdges, totalW, totalH);
  totalW = sized.w;
  totalH = sized.h;

  return {
    width: Math.ceil(totalW),
    height: Math.ceil(totalH),
    nodes: outNodes, containers: outContainers, edges: outEdges,
  };
}

function placeInternetPoles(graph, outNodes, outContainers, outEdges, totalW, totalH) {
  const account = outContainers.find(c => c.kind === 'account');
  const inbound = outNodes.find(n => n.kind === 'internet');
  const egress = outNodes.find(n => n.kind === 'internet-egress');
  if (!account || (!inbound && !egress)) return { w: totalW, h: totalH };

  const GAP = 72;
  let topPad = 0;
  if (inbound) {
    const need = inbound.h + GAP;
    if (account.y < need + 8) topPad = need + 8 - account.y;
  }
  if (topPad) {
    for (const n of outNodes) n.y += topPad;
    for (const c of outContainers) c.y += topPad;
    for (const e of outEdges) for (const p of e.points || []) p.y += topPad;
  }

  const acc = outContainers.find(c => c.kind === 'account');
  const cx = acc.x + acc.w / 2;
  if (inbound) {
    inbound.x = cx - inbound.w / 2;
    inbound.y = acc.y - inbound.h - GAP;
  }
  if (egress) {
    egress.x = cx - egress.w / 2;
    egress.y = acc.y + acc.h + GAP;
  }

  const boxOf = id => outNodes.find(n => n.id === id) || outContainers.find(c => c.id === id);
  const edgeById = new Map(graph.edges.map(e => [e.id, e]));
  const poleEdges = [];
  for (const e of outEdges) {
    const meta = edgeById.get(e.id);
    if (!meta) continue;
    const fromInet = meta.from === 'internet' || meta.from === 'internet-egress';
    const toInet = meta.to === 'internet' || meta.to === 'internet-egress';
    if (fromInet || toInet) poleEdges.push({ e, meta });
  }
  const inboundEdges = poleEdges.filter(x => x.meta.from === 'internet');
  const egressEdges = poleEdges.filter(x => x.meta.to === 'internet-egress' || x.meta.from === 'internet-egress');
  inboundEdges.sort((a, b) => (boxOf(a.meta.to)?.x || 0) - (boxOf(b.meta.to)?.x || 0));
  egressEdges.sort((a, b) => (boxOf(a.meta.from)?.x || 0) - (boxOf(b.meta.from)?.x || 0));

  const routePole = (items, pole, fromPole) => {
    items.forEach((item, i) => {
      const a = boxOf(item.meta.from), b = boxOf(item.meta.to);
      if (!a || !b || a.w == null || b.w == null) return;
      const spread = (i - (items.length - 1) / 2) * 32;
      const start = fromPole
        ? { x: pole.x + pole.w / 2 + spread, y: pole.y + pole.h }
        : { x: a.x + a.w / 2, y: a.y + a.h };
      const end = fromPole
        ? { x: b.x + b.w / 2, y: b.y }
        : { x: pole.x + pole.w / 2 + spread, y: pole.y };
      const midY = (start.y + end.y) / 2 + (i - (items.length - 1) / 2) * 18;
      item.e.points = [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end];
      if (item.e.label) {
        item.e.label.x = (start.x + end.x) / 2 - (item.e.label.w || 40) / 2;
        item.e.label.y = midY - (item.e.label.h || 14) / 2;
      }
    });
  };
  if (inbound) routePole(inboundEdges, inbound, true);
  if (egress) routePole(egressEdges, egress, false);
  deconflictLabels(outEdges);

  const maxX = Math.max(
    totalW,
    ...outNodes.map(n => n.x + n.w),
    ...outContainers.map(c => c.x + c.w),
  );
  const maxY = Math.max(
    totalH,
    ...outNodes.map(n => n.y + n.h),
    ...outContainers.map(c => c.y + c.h),
  );
  return { w: maxX + 16, h: maxY + 16 };
}

/** Nudge stacked edge-label boxes so HTTP / HTTPS chips do not sit on top of each other. */
export function deconflictLabels(outEdges) {
  const labs = outEdges.filter(e => e.label && e.label.w);
  labs.sort((a, b) => (a.label.y - b.label.y) || (a.label.x - b.label.x));
  for (let i = 0; i < labs.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = labs[j].label, b = labs[i].label;
      const overlapX = Math.abs((a.x + a.w / 2) - (b.x + b.w / 2)) < (a.w + b.w) / 2 + 8;
      const overlapY = Math.abs(a.y - b.y) < Math.max(a.h, b.h) + 4;
      if (overlapX && overlapY) b.y = a.y + a.h + 6;
    }
  }
}

/* ---------------------------- SVG rendering ---------------------------- */

function renderSvg(graph, laid, title) {
  const pad = 20;
  const W = laid.width + pad * 2, H = laid.height + pad * 2;
  const parts = [];

  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${esc(FONT)}">`);

  // Dedup icons: the same data URI used to be inlined on every node. A real
  // account scan was 56% duplicate bytes. One <symbol> per unique URI, then
  // <use href="#ico-N"> at each placement.
  const iconIds = new Map();
  const addIcon = uri => {
    if (!uri || iconIds.has(uri)) return;
    iconIds.set(uri, `ico-${iconIds.size}`);
  };
  for (const n of laid.nodes) { addIcon(n.icon); addIcon(n.osIcon); }
  for (const c of laid.containers) addIcon(c.icon);

  const kinds = [...new Set([...graph.edges.map(e => e.kind || 'default'), 'default'])];
  parts.push('<defs>');
  for (const k of kinds) {
    parts.push(`<marker id="arrow-${k}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">` +
      `<path d="M0,0.6 L9.5,5 L0,9.4 z" fill="${edgeStyle(k).color}"/></marker>`);
  }
  for (const [uri, id] of iconIds) {
    parts.push(`<symbol id="${id}" viewBox="0 0 64 64">` +
      `<image href="${esc(uri)}" width="64" height="64" preserveAspectRatio="xMidYMid meet"/></symbol>`);
  }
  parts.push('</defs>');
  parts.push(`<style>
    .flow{fill:none;stroke:#111418;stroke-width:2.6;stroke-linecap:round;stroke-dasharray:10 8;animation:bp-flow .8s linear infinite;opacity:.95;pointer-events:none}
    @keyframes bp-flow{to{stroke-dashoffset:-18}}
    @media (prefers-reduced-motion:reduce){.flow{animation:none;opacity:0}}
  </style>`);
  const useIcon = (uri, x, y, size) => {
    const id = iconIds.get(uri);
    return id
      ? `<use href="#${id}" x="${r(x)}" y="${r(y)}" width="${size}" height="${size}"/>`
      : '';
  };
  parts.push(`<rect class="bg" x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`);
  parts.push(`<g id="viewport" transform="translate(${pad},${pad})">`);

  // 1. Container bodies, outer → inner.
  const conts = [...laid.containers].sort((a, b) => containerDepth(a, graph) - containerDepth(b, graph));
  const headers = [];
  for (const c of conts) {
    const st = KIND_STYLE[c.kind] || KIND_STYLE.regional;
    parts.push(`<rect x="${r(c.x)}" y="${r(c.y)}" width="${r(c.w)}" height="${r(c.h)}" ` +
      `fill="${st.fill}"${st.fillOpacity ? ` fill-opacity="${st.fillOpacity}"` : ''} ` +
      `stroke="${st.stroke}" stroke-width="1.5"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''}/>`);
    // AWS-style header: group icon flush in the top-left corner, title beside it.
    const iconSize = 26;
    const tx = c.x + (c.icon ? iconSize + 8 : 10);
    let igwChip = '';
    if (c.igw) {
      const cx2 = tx + c.label.length * 7.05 + 12;
      igwChip = `<g><title>Internet gateway attached: ${esc(c.igw)}</title>` +
        `<rect x="${r(cx2)}" y="${r(c.y + 5.5)}" width="36" height="15" rx="7.5" ` +
        `fill="${st.stroke}" fill-opacity="0.12" stroke="${st.stroke}" stroke-opacity="0.5"/>` +
        `<text x="${r(cx2 + 18)}" y="${r(c.y + 16.5)}" font-size="8.5" font-weight="700" ` +
        `text-anchor="middle" fill="${st.stroke}">IGW</text></g>`;
    }
    headers.push(`<g>` +
      (c.icon ? useIcon(c.icon, c.x, c.y, iconSize) : '') +
      `<text x="${r(tx)}" y="${r(c.y + 17.5)}" font-size="12.5" font-weight="600" fill="${st.stroke}">${esc(c.label)}</text>${igwChip}</g>`);
  }

  // 2. Edges (rounded orthogonal routes + ELK-placed inline labels).
  const edgeMeta = new Map(graph.edges.map(e => [e.id, e]));
  for (const e of laid.edges) {
    if (!e.points || e.points.length < 2) continue;
    const meta = edgeMeta.get(e.id) || {};
    const st = edgeStyle(meta.kind);
    const diffEdge = meta.diffStatus ? ` ${meta.diffStatus}` : '';
    const eColor = meta.diffStatus === 'added' ? '#1D8102'
      : meta.diffStatus === 'removed' ? '#D13212' : st.color;
    const eDash = meta.diffStatus === 'removed' ? '4 3' : st.dash;
    parts.push(`<g class="edge${diffEdge}" data-from="${esc(meta.from || '')}" data-to="${esc(meta.to || '')}" ` +
      `data-kind="${esc(meta.kind || '')}" data-label="${esc(meta.label || '')}" data-diff="${esc(meta.diffStatus || '')}">`);
    // invisible wide stroke = a comfortable click target
    parts.push(`<path class="hit" d="${roundedPath(e.points)}" fill="none" stroke="transparent" stroke-width="14" pointer-events="stroke"/>`);
    const d = roundedPath(e.points);
    parts.push(`<path class="vis" d="${d}" fill="none" stroke="${eColor}" stroke-width="1.6"` +
      `${eDash ? ` stroke-dasharray="${eDash}"` : ''} marker-end="url(#arrow-${meta.kind || 'default'})"/>`);
    parts.push(`<path class="flow" d="${d}" fill="none"/>`);
    if (e.label) {
      const { x, y, w, h, text } = e.label;
      parts.push(`<rect class="el" x="${r(x - 3)}" y="${r(y - 1)}" width="${r(w + 6)}" height="${r(h + 2)}" rx="9" ` +
        `fill="#ffffff" stroke="${st.color}" stroke-opacity="0.45"/>` +
        `<text x="${r(x + w / 2)}" y="${r(y + h / 2 + 3.5)}" font-size="10" font-weight="600" ` +
        `text-anchor="middle" fill="${st.color}">${esc(text)}</text>`);
    }
    parts.push(`</g>`);
  }

  // 3. Nodes as cards, so connectors visibly attach to something.
  for (const n of laid.nodes) {
    const cx = n.x + n.w / 2;
    const diffClass = n.diffStatus ? ` ${n.diffStatus}` : '';
    const DIFF_STROKE = { added: '#1D8102', removed: '#D13212', changed: '#C67B00' };
    parts.push(`<g class="node${diffClass}" tabindex="0" role="img" aria-label="${esc(n.label)} ${esc(n.sublabel)}" data-id="${esc(n.id)}" data-service="${esc(n.sublabel)}" data-label="${esc(n.label)}" data-diff="${esc(n.diffStatus || '')}">`);
    parts.push(`<title>${esc(n.label)} — ${esc(n.sublabel)}${n.untagged ? ' (referenced, not tagged)' : ''}${n.diffStatus ? ` · ${n.diffStatus}` : ''}</title>`);
    const ghost = n.untagged || n.kind === 'internet' || n.kind === 'internet-egress' || n.diffStatus === 'removed';
    const stroke = DIFF_STROKE[n.diffStatus] || (ghost ? '#8D99A8' : '#D9DEE4');
    const dash = (n.diffStatus === 'removed' || ghost && !n.diffStatus) ? '4 3' : '';
    const sw = n.diffStatus ? '2.2' : '1.2';
    parts.push(`<rect class="card${ghost ? ' ref' : ''}${diffClass}" ` +
      `x="${r(n.x)}" y="${r(n.y)}" width="${r(n.w)}" height="${r(n.h)}" rx="9" fill="#ffffff" ` +
      `stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`);
    const subRaw = n.sublabel !== n.label ? `${n.sublabel}${n.untagged ? ' (ref)' : ''}` : (n.untagged ? '(ref)' : '');
    const sub = fitSublabel(subRaw);
    const lines = nodeLines(n.label);
    parts.push(useIcon(n.icon, cx - ICON / 2, n.y + 10, ICON));
    if (n.osIcon) {
      const bx = n.x + 8, by = n.y + 8;
      parts.push(`<g><title>${esc(n.osLabel || 'OS')}</title>` +
        `<rect x="${r(bx - 2)}" y="${r(by - 2)}" width="${OS_BADGE + 4}" height="${OS_BADGE + 4}" rx="5" ` +
        `fill="#ffffff" stroke="#D9DEE4" stroke-width="1"/>` +
        useIcon(n.osIcon, bx, by, OS_BADGE) + `</g>`);
    }
    const line0Y = n.y + 66;
    for (let i = 0; i < lines.length; i++) {
      parts.push(`<text class="tl" x="${r(cx)}" y="${r(line0Y + i * 13)}" font-size="11.5" font-weight="600" text-anchor="middle" fill="#0F141A">${esc(lines[i])}</text>`);
    }
    if (sub) parts.push(`<text class="ts" x="${r(cx)}" y="${r(n.y + n.h - 9)}" font-size="9.5" text-anchor="middle" fill="#5F6B7A">${esc(sub)}</text>`);
    if (n.open) {
      // "open to internet" badge: little orange globe in the card corner
      const bx = n.x + n.w - 14, by = n.y + 14;
      parts.push(`<g><title>Open to the internet (0.0.0.0/0): ${esc(n.open)}</title>` +
        `<circle cx="${r(bx)}" cy="${r(by)}" r="8" fill="#DD6B10"/>` +
        `<circle cx="${r(bx)}" cy="${r(by)}" r="4.6" fill="none" stroke="#ffffff" stroke-width="1.1"/>` +
        `<ellipse cx="${r(bx)}" cy="${r(by)}" rx="2" ry="4.6" fill="none" stroke="#ffffff" stroke-width="1.1"/>` +
        `<line x1="${r(bx - 4.6)}" y1="${r(by)}" x2="${r(bx + 4.6)}" y2="${r(by)}" stroke="#ffffff" stroke-width="1.1"/></g>`);
    }
    parts.push(`</g>`);
  }

  // 4. Container titles on top, so routed edges never hide them.
  parts.push(...headers);

  parts.push(`</g></svg>`);
  return parts.join('\n');
}

/** Orthogonal polyline -> path with softly rounded corners. */
function roundedPath(pts, radius = 7) {
  if (pts.length < 3) return pts.map((p, i) => `${i ? 'L' : 'M'}${r(p.x)},${r(p.y)}`).join(' ');
  let d = `M${r(pts[0].x)},${r(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
    const inLen = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const outLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const rad = Math.min(radius, inLen / 2, outLen / 2);
    if (rad < 1) { d += ` L${r(p1.x)},${r(p1.y)}`; continue; }
    const inX = (p1.x - p0.x) / inLen, inY = (p1.y - p0.y) / inLen;
    const outX = (p2.x - p1.x) / outLen, outY = (p2.y - p1.y) / outLen;
    d += ` L${r(p1.x - inX * rad)},${r(p1.y - inY * rad)}` +
      ` Q${r(p1.x)},${r(p1.y)} ${r(p1.x + outX * rad)},${r(p1.y + outY * rad)}`;
  }
  d += ` L${r(pts[pts.length - 1].x)},${r(pts[pts.length - 1].y)}`;
  return d;
}

function containerDepth(c, graph) {
  let d = 0, cur = c, map = new Map(graph.containers.map(x => [x.id, x]));
  while (cur && cur.parent) { d++; cur = map.get(cur.parent); }
  return d;
}

/* ---------------------------- HTML portal ---------------------------- */

function renderHtml(graph, svg, title, scan, exports = {}) {
  const s = graph.stats;
  const exportsJson = JSON.stringify(exports).replace(/</g, '\\u003c');

  // Per-node details for the inspector panel, keyed by node id (= ARN).
  const resByArn = new Map(((scan && scan.resources) || []).map(r => [r.arn, r]));
  const changeByArn = new Map((scan?.diff?.changed || []).map(c => [c.resource.arn || c.resource.id, c]));
  const details = {};
  for (const n of graph.nodes) {
    const res = resByArn.get(n.id) || {};
    const sn = res.subnetId && scan?.subnets?.[res.subnetId];
    const ch = changeByArn.get(n.id);
    details[n.id] = {
      label: n.label, sublabel: n.sublabel, arn: n.id,
      region: res.region || '', az: res.az || sn?.az || '',
      subnet: sn ? `${sn.name || sn.id}${sn.cidr ? ` (${sn.cidr})` : ''}` : '',
      vpc: res.vpcId || sn?.vpcId || '',
      state: res.state || '',
      tags: res.tags || {},
      extra: res.extra || {},
      securityGroups: res.extra?.securityGroups || [],
      untagged: !!n.untagged, open: n.open || '',
      diffStatus: n.diffStatus || '',
      changes: ch?.fields || [],
      exposure: !!ch?.exposure,
    };
  }
  const detailsJson = JSON.stringify(details).replace(/</g, '\\u003c');
  const legendHtml = graph.legend.map(l =>
    `<div class="legend-item"><img src="${esc(l.icon)}" width="22" height="22"/><span>${esc(l.label)}</span></div>`).join('');

  const subnetHtml = (graph.subnets || []).map(sn => {
    const c = sn.public ? '#7AA116' : '#00A4A6';
    return `<div class="legend-item"><span class="dot" style="background:${c}"></span>` +
      `<span>${esc(sn.public ? 'public' : 'private')} · ${esc(azShort(sn.az))}</span>` +
      `<em>${esc(sn.cidr || sn.name || '')}</em></div>`;
  }).join('');

  const flowKinds = [...new Set(graph.edges.map(e => e.kind))];
  let flowHtml = flowKinds.filter(k => EDGE_STYLE[k]).map(k =>
    `<div class="legend-item flow-item" data-kind="${esc(k)}" title="Click to highlight these connectors">` +
    `<span class="line" style="background:${EDGE_STYLE[k].color}"></span><span>${esc(EDGE_STYLE[k].label)}</span></div>`).join('');
  if (s.open) {
    flowHtml += `<div class="legend-item"><span class="dot" style="background:#DD6B10"></span>` +
      `<span>Open to the internet (0.0.0.0/0) · ${s.open} resource${s.open === 1 ? '' : 's'}</span></div>`;
  }
  if (flowHtml) {
    flowHtml += `<div class="legend-item"><span class="line" style="background:#067F68"></span><span>Outbound from selected</span></div>` +
      `<div class="legend-item"><span class="line" style="background:#0972D3"></span><span>Inbound to selected</span></div>`;
  }

  const resourceList = graph.nodes.filter(n => !n.untagged && n.kind !== 'internet' && n.kind !== 'internet-egress')
    .sort((a, b) => a.sublabel.localeCompare(b.sublabel) || a.label.localeCompare(b.label))
    .map(n => `<li data-id="${esc(n.id)}" data-label="${esc(n.label)}" data-diff="${esc(n.diffStatus || '')}"><img src="${esc(n.icon)}" width="18" height="18"/><span>${esc(n.label)}</span>${n.diffStatus ? `<i class="dmark ${esc(n.diffStatus)}">${n.diffStatus === 'added' ? '+' : n.diffStatus === 'removed' ? '−' : '~'}</i>` : ''}<em>${esc(n.sublabel)}</em></li>`).join('');

  const dsum = scan?.diff?.summary;
  const changesHtml = dsum ? buildChangesHtml(scan.diff, graph) : '';
  const diffFilters = dsum
    ? `<span class="diff-filters" role="group" aria-label="Filter by change">
        <button type="button" data-diff-filter="all" class="on">All changes</button>
        <button type="button" data-diff-filter="added">Added (${dsum.added})</button>
        <button type="button" data-diff-filter="removed">Removed (${dsum.removed})</button>
        <button type="button" data-diff-filter="changed">Changed (${dsum.changed})</button>
      </span>` : '';
  const diffStats = dsum
    ? `<span class="diff-stat added"><b>+${dsum.added}</b></span>
       <span class="diff-stat removed"><b>−${dsum.removed}</b></span>
       <span class="diff-stat changed"><b>~${dsum.changed}</b></span>`
    : '';

  const meta = graph.meta || {};
  const sub = `${meta.tagKey ? `tag <code>${esc(meta.tagKey)}${meta.tagValue ? '=' + esc(meta.tagValue) : ''}</code>` : ''}` +
    `${meta.accountId ? ` · account ${esc(meta.accountId)}` : ''}` +
    `${s.regions?.length ? ` · ${s.regions.length} region(s)` : ''}`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<style>
  :root { --ink:#16191F; --squid:#232F3E; --line:#E4E8EB; --accent:#FF9900;
    --bg:#F2F3F3; --panel:#ffffff; --panel2:#FAFBFB; --mut:#687078; --dim:#879196;
    --stage:#FAFBFB; --grid:#0000000a; --hover:#F2F3F3; --chip:#EDF3F7; --chipline:#D9E4EC;
    --flow:#111418; }
  [data-theme="dark"] { --ink:#E6EDF3; --squid:#04070C; --line:#1B2735; --accent:#00E5A0;
    --bg:#05080D; --panel:#0B121C; --panel2:#0E1622; --mut:#93A3B8; --dim:#5B6B80;
    --stage:#04070C; --grid:#FFFFFF0d; --hover:#101A27; --chip:#101A27; --chipline:#2A3B52;
    --flow:#ffffff; }
  * { box-sizing: border-box; }
  .lic { width:1em; height:1em; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; vertical-align:-0.12em; }
  body { margin:0; font-family:"Segoe UI",Helvetica,Arial,sans-serif; color:var(--ink); background:var(--bg); }
  header { background:var(--squid); color:#fff; padding:12px 18px; display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
  header h1 { font-size:16px; margin:0; font-weight:600; }
  header .sub { font-size:12px; color:#C9D1D9; }
  header code { background:#00000030; padding:1px 5px; border-radius:4px; color:#FFD79A; }
  .stats { margin-left:auto; display:flex; gap:14px; font-size:12px; }
  .stats b { color:var(--accent); font-size:15px; }
  .toolbar { background:var(--panel); border-bottom:1px solid var(--line); padding:8px 14px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .toolbar button { border:1px solid var(--line); background:var(--panel); color:var(--ink); border-radius:6px; padding:6px 12px; font-size:13px; cursor:pointer; }
  .toolbar button:hover { background:var(--hover); }
  .toolbar button.primary { background:var(--squid); color:#fff; border-color:var(--squid); }
  .toolbar button.on { background:var(--squid); color:#fff; border-color:var(--squid); }
  .export { position:relative; }
  .export-menu { position:absolute; top:calc(100% + 6px); left:0; z-index:20; min-width:220px;
    background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:5px;
    box-shadow:0 10px 30px #00000033; }
  .export-menu button { display:flex; width:100%; text-align:left; border:none; background:none;
    color:var(--ink); padding:8px 10px; border-radius:6px; font-size:13px; gap:8px; align-items:baseline; }
  .export-menu button em { margin-left:auto; font-style:normal; font-size:11px; color:var(--dim); }
  .export-menu button:hover { background:var(--hover); }
  .toolbar input { border:1px solid var(--line); background:var(--panel2); color:var(--ink); border-radius:6px; padding:6px 10px; font-size:13px; width:190px; }
  .layout { display:flex; height:calc(100vh - 98px); }
  #stage { flex:1; overflow:hidden; position:relative; background:
      linear-gradient(var(--grid) 1px,transparent 1px) 0 0/22px 22px,
      linear-gradient(90deg,var(--grid) 1px,transparent 1px) 0 0/22px 22px, var(--stage); cursor:grab; }
  #stage.grabbing { cursor:grabbing; }
  #stage .empty { position:absolute; top:38%; left:50%; transform:translate(-50%,-50%);
    background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:18px 22px;
    max-width:430px; font-size:13px; display:flex; flex-direction:column; gap:8px;
    box-shadow:0 2px 10px #0000000f; z-index:2; }
  #stage .empty code { background:var(--hover); padding:1px 5px; border-radius:4px; }
  #stage svg { position:absolute; top:0; left:0; transform-origin:0 0; }
  #stage svg.anim { transition:transform .35s cubic-bezier(.22,1,.36,1); }
  /* dark mode restyles the diagram itself (classes set by the renderer) */
  [data-theme="dark"] #stage svg .bg { fill:#04070C; }
  [data-theme="dark"] #stage svg .card { fill:#0E1622; }
  [data-theme="dark"] #stage svg .card:not(.ref) { stroke:#22334A; }
  [data-theme="dark"] #stage svg .tl { fill:#E6EDF3; }
  [data-theme="dark"] #stage svg .ts { fill:#93A3B8; }
  [data-theme="dark"] #stage svg .el { fill:#0B121C; }
  aside { width:290px; border-left:1px solid var(--line); background:var(--panel); overflow-y:auto; padding:14px; }
  aside h2 { font-size:12px; text-transform:uppercase; letter-spacing:.5px; color:var(--mut); margin:16px 0 8px; }
  .legend-item { display:flex; align-items:center; gap:8px; font-size:12.5px; padding:3px 0; }
  .legend-item em { margin-left:auto; color:var(--dim); font-style:normal; font-size:11px; }
  .legend-item .dot { width:10px; height:10px; border-radius:50%; flex:0 0 auto; }
  .legend-item .line { width:18px; height:3px; border-radius:2px; flex:0 0 auto; }
  aside ul { list-style:none; margin:0; padding:0; }
  aside li { display:flex; align-items:center; gap:8px; font-size:12.5px; padding:5px 6px; border-radius:6px; cursor:pointer; }
  aside li:hover { background:var(--hover); }
  aside li em { margin-left:auto; color:var(--dim); font-style:normal; font-size:11px; }
  .hl { outline:3px solid var(--accent); outline-offset:2px; border-radius:6px; }
  #stage .node { cursor:pointer; }
  #stage .node:focus { outline:none; }
  #stage .node:focus .card { stroke:#DD344C; stroke-width:2; }
  #stage .edge { cursor:pointer; }
  #stage .edge:hover .vis { stroke-width:2.8; }
  #stage .edge.sel .vis { stroke-width:3; }
  #stage .edge.in .vis { stroke:#0972D3; }
  #stage .edge.out .vis { stroke:#067F68; }
  #stage .edge .flow { stroke:var(--flow); stroke-width:2.8; stroke-dasharray:10 8; stroke-linecap:round;
    animation:bp-flow .8s linear infinite; opacity:.95; pointer-events:none; }
  #stage .edge.sel .flow, #stage .edge.in .flow, #stage .edge.out .flow { stroke-width:3.2; opacity:1; }
  @keyframes bp-flow { to { stroke-dashoffset:-18; } }
  @media (prefers-reduced-motion:reduce) { #stage .edge .flow { animation:none; opacity:0; } }
  body.flow-off #stage .edge .flow { animation:none; opacity:0; }
  body.egress-off #stage .edge[data-kind="internet-out"],
  body.egress-off #stage .edge[data-kind="nat-egress"],
  body.egress-off #stage .node[data-id="internet-egress"] { display:none; }
  .flow-item { cursor:pointer; border-radius:6px; padding:3px 4px !important; }
  .flow-item:hover { background:var(--hover); }
  .flow-item.on { background:var(--hover); outline:1px solid var(--line); }
  #detail { border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin-bottom:4px; background:var(--panel2); }
  #detail h3 { margin:0 0 2px; font-size:14px; }
  #detail .svc { font-size:11.5px; color:var(--mut); margin-bottom:8px; }
  #detail .kv { display:flex; gap:8px; font-size:11.5px; padding:2px 0; }
  #detail .kv b { flex:0 0 78px; font-weight:600; color:var(--mut); }
  #detail .kv span { word-break:break-all; }
  #detail .warn { color:#DD6B10; font-weight:600; }
  #detail .tags { display:flex; flex-wrap:wrap; gap:4px; margin-top:6px; }
  #detail .tag { font-size:10.5px; background:var(--chip); border:1px solid var(--chipline); border-radius:10px; padding:1px 8px; }
  #detail .close { float:right; border:none; background:none; font-size:15px; cursor:pointer; color:var(--dim); }
  .diff-stat.added b { color:#1D8102; } .diff-stat.removed b { color:#D13212; } .diff-stat.changed b { color:#C67B00; }
  .diff-filters { display:flex; gap:4px; flex-wrap:wrap; }
  .diff-filters button.on { background:var(--squid); color:#fff; border-color:var(--squid); }
  .dmark { font-style:normal; font-weight:700; font-size:12px; width:14px; text-align:center; }
  .dmark.added, .chg.added { color:#1D8102; } .dmark.removed, .chg.removed { color:#D13212; } .dmark.changed, .chg.changed { color:#C67B00; }
  #changes li { align-items:flex-start; }
  #changes .why { display:block; font-size:10.5px; color:var(--dim); }
  #detail .diff-banner { font-size:11.5px; font-weight:600; margin-bottom:8px; }
  #detail .diff-banner.added { color:#1D8102; } #detail .diff-banner.removed { color:#D13212; } #detail .diff-banner.changed { color:#C67B00; }
  #stage .node.added .card { stroke:#1D8102; } #stage .node.removed .card { stroke:#D13212; } #stage .node.changed .card { stroke:#C67B00; }
  footer { font-size:11px; color:var(--dim); padding:6px 14px; background:var(--panel); border-top:1px solid var(--line); }
</style></head>
<body>
<header>
  <h1>${esc(title)}</h1>
  <span class="sub">${sub}</span>
  <div class="stats">
    <span><b>${s.resources}</b> resources</span>
    <span><b>${s.edges}</b> links</span>
    ${s.external ? `<span><b>${s.external}</b> referenced</span>` : ''}
    ${diffStats}
  </div>
</header>
<div class="toolbar">
  <div class="export" id="export">
    <button class="primary" id="exportBtn"><svg class="lic" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7.5m0 0L4.8 6.8M8 10l3.2-3.2M3 13.5h10"/></svg> Export ▾</button>
    <div class="export-menu" id="exportMenu" hidden>
      <button data-x="png">PNG <em>image</em></button>
      <button data-x="svg">SVG <em>vector</em></button>
      <button data-x="drawio">draw.io <em>editable</em></button>
      <button data-x="mermaid">Mermaid <em>diagram-as-code</em></button>
      <button data-x="excalidraw">Excalidraw <em>editable</em></button>
    </div>
  </div>
  <button id="fit">Fit</button>
  <button id="zin">＋</button>
  <button id="zout">－</button>
  <input id="search" placeholder="Search resources…"/>
  <button id="themeToggle" title="Toggle light / dark">◐</button>
  <button id="flowToggle" class="on" title="Animate inbound / outbound flow on connectors" aria-pressed="true">Flow</button>
  <button id="egressToggle" class="on" title="Show NAT and Internet egress (outbound)" aria-pressed="true">Outbound</button>
  ${diffFilters}
  <span id="hint" style="font-size:12px;color:var(--dim)">drag to pan · scroll to zoom · click a resource — green leaves, blue arrives</span>
</div>
<div class="layout">
  <div id="stage">${svg}${s.resources ? '' : `<div class="empty">
    <b>No resources matched this scan.</b>
    <span>Scanned region(s): ${esc((s.regions || []).join(', ') || '—')}.</span>
    <span>Check that the region is right (resources may live elsewhere — try <code>--all-regions</code>),
    the tag key/value case matches exactly, and the credentials can see the account.</span>
  </div>`}</div>
  <aside>
    <div id="detail" hidden></div>
    ${changesHtml}
    ${flowHtml ? `<h2>Connectivity</h2>${flowHtml}` : ''}
    ${subnetHtml ? `<h2>Subnets</h2>${subnetHtml}` : ''}
    <h2>Services</h2>
    ${legendHtml || '<div style="font-size:12px;color:#879196">No resources.</div>'}
    <h2>Resources (${s.resources})</h2>
    <ul id="rlist">${resourceList}</ul>
  </aside>
</div>
<footer>3am_blueprint · generated ${esc((graph.meta && graph.meta.generatedAt) || '')} · icons © Amazon Web Services</footer>

<script type="application/json" id="detail-data">${detailsJson}</script>
<script type="application/json" id="export-data">${exportsJson}</script>
<script>
(function(){
  // ---- theme (query param from the app wins, then saved preference) ----
  // Storage access throws in a sandboxed frame (opaque origin), so it is
  // optional: the app always passes ?theme= explicitly.
  const store = k => { try { return localStorage.getItem(k); } catch(e) { return null; } };
  const qTheme = new URLSearchParams(location.search).get('theme');
  const theme0 = qTheme || store('aa-theme') || 'light';
  document.documentElement.dataset.theme = theme0 === 'dark' ? 'dark' : 'light';
  document.getElementById('themeToggle').onclick = () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('aa-theme', t); } catch(e){}
  };
  const flowBtn = document.getElementById('flowToggle');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let flowOn = !reduceMotion && store('aa-flow') !== 'off';
  function applyFlow(){
    document.body.classList.toggle('flow-off', !flowOn);
    flowBtn.classList.toggle('on', flowOn);
    flowBtn.setAttribute('aria-pressed', flowOn ? 'true' : 'false');
  }
  applyFlow();
  flowBtn.onclick = ()=>{
    flowOn = !flowOn;
    try { localStorage.setItem('aa-flow', flowOn ? 'on' : 'off'); } catch(e){}
    applyFlow();
  };
  const egressBtn = document.getElementById('egressToggle');
  let egressOn = store('aa-egress') !== 'off';
  function applyEgress(){
    document.body.classList.toggle('egress-off', !egressOn);
    egressBtn.classList.toggle('on', egressOn);
    egressBtn.setAttribute('aria-pressed', egressOn ? 'true' : 'false');
  }
  applyEgress();
  egressBtn.onclick = ()=>{
    egressOn = !egressOn;
    try { localStorage.setItem('aa-egress', egressOn ? 'on' : 'off'); } catch(e){}
    applyEgress();
  };

  const stage = document.getElementById('stage');
  const svg = stage.querySelector('svg');
  const baseW = svg.width.baseVal.value, baseH = svg.height.baseVal.value;
  let scale = 1, tx = 0, ty = 0;
  function apply(){ svg.style.transform = 'translate('+tx+'px,'+ty+'px) scale('+scale+')'; }
  function fit(){
    const r = stage.getBoundingClientRect();
    scale = Math.min(r.width/baseW, r.height/baseH, 1.6) * 0.96;
    tx = (r.width - baseW*scale)/2; ty = (r.height - baseH*scale)/2; apply();
  }
  window.addEventListener('resize', fit);
  document.getElementById('fit').onclick = fit;
  document.getElementById('zin').onclick = ()=>{ scale*=1.2; apply(); };
  document.getElementById('zout').onclick = ()=>{ scale/=1.2; apply(); };

  // wheel zoom at cursor
  stage.addEventListener('wheel', e=>{
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const f = e.deltaY < 0 ? 1.1 : 1/1.1;
    tx = mx - (mx - tx)*f; ty = my - (my - ty)*f; scale *= f; apply();
  }, {passive:false});

  // drag to pan
  let dragging=false, sx, sy;
  stage.addEventListener('mousedown', e=>{ dragging=true; sx=e.clientX-tx; sy=e.clientY-ty; stage.classList.add('grabbing'); });
  window.addEventListener('mousemove', e=>{ if(!dragging) return; tx=e.clientX-sx; ty=e.clientY-sy; apply(); });
  window.addEventListener('mouseup', ()=>{ dragging=false; stage.classList.remove('grabbing'); });

  // search highlight
  const nodes = [...svg.querySelectorAll('.node')];
  const edges = [...svg.querySelectorAll('.edge')];
  document.querySelectorAll('[data-diff-filter]').forEach(btn=>{
    btn.onclick = ()=>{
      const f = btn.dataset.diffFilter;
      document.querySelectorAll('[data-diff-filter]').forEach(b=> b.classList.toggle('on', b===btn));
      nodes.forEach(n=>{
        const st = n.dataset.diff;
        const hit = f==='all' ? !!st : st===f;
        n.style.opacity = hit ? 1 : 0.18;
        n.classList.toggle('hl', hit);
      });
      edges.forEach(g=>{
        const st = g.dataset.diff;
        g.style.opacity = (f==='all' ? !!st : st===f) ? 1 : 0.08;
      });
    };
  });
  document.getElementById('search').addEventListener('input', e=>{
    const q = e.target.value.trim().toLowerCase();
    clearSelection();
    nodes.forEach(n=>{
      const hit = q && ((n.dataset.label||'').toLowerCase().includes(q) || (n.dataset.service||'').toLowerCase().includes(q));
      n.classList.toggle('hl', !!hit);
      n.style.opacity = (!q || hit) ? 1 : 0.25;
    });
  });

  // ---- selection: click a node -> highlight its connections + inspector ----
  const details = JSON.parse(document.getElementById('detail-data').textContent || '{}');
  const panel = document.getElementById('detail');
  const escHtml = v => String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const KIND_LABELS = ${JSON.stringify(Object.fromEntries(Object.entries(EDGE_STYLE).map(([k, v]) => [k, v.label])))};
  function clearEdgeFlow(){
    edges.forEach(g=>{ g.classList.remove('sel','in','out'); g.style.opacity = 1; });
  }
  function clearSelection(){
    nodes.forEach(n=>{ n.classList.remove('hl'); n.style.opacity = 1; });
    clearEdgeFlow();
    document.querySelectorAll('.flow-item').forEach(f=> f.classList.remove('on'));
    activeKind = null;
    panel.hidden = true;
  }

  // ---- connector selection: click an edge to inspect it ----
  function selectEdge(g){
    clearSelection();
    g.classList.add('sel','out');
    edges.forEach(x=>{ if (x !== g) x.style.opacity = 0.1; });
    const ends = new Set([g.dataset.from, g.dataset.to]);
    nodes.forEach(n=>{ n.style.opacity = ends.has(n.dataset.id) ? 1 : 0.2; });
    const df = details[g.dataset.from], dt = details[g.dataset.to];
    const name = id => {
      const d = details[id];
      return d ? escHtml(d.label) : '<i>' + escHtml((id || '').split(':').pop()) + '</i>';
    };
    panel.innerHTML =
      '<button class="close" title="Close">✕</button>' +
      '<h3>' + escHtml(g.dataset.label || 'Connection') + '</h3>' +
      '<div class="svc">' + escHtml(KIND_LABELS[g.dataset.kind] || 'Link') + '</div>' +
      '<div class="kv"><b>From</b><span class="jump" data-id="' + escHtml(g.dataset.from) + '" style="cursor:pointer;text-decoration:underline">' + name(g.dataset.from) + '</span></div>' +
      '<div class="kv"><b>To</b><span class="jump" data-id="' + escHtml(g.dataset.to) + '" style="cursor:pointer;text-decoration:underline">' + name(g.dataset.to) + '</span></div>' +
      (df && df.sublabel ? '<div class="kv"><b></b><span>' + escHtml(df.sublabel) + ' → ' + escHtml(dt ? dt.sublabel : '') + '</span></div>' : '');
    panel.hidden = false;
    panel.querySelector('.close').onclick = clearSelection;
    panel.querySelectorAll('.jump').forEach(j=>{ j.onclick = ()=> select(j.dataset.id); });
  }

  // ---- legend: click a connectivity kind to highlight all its edges ----
  let activeKind = null;
  document.querySelectorAll('.flow-item').forEach(f=>{
    f.onclick = ()=>{
      const kind = f.dataset.kind;
      if (activeKind === kind) { clearSelection(); return; }
      clearSelection();
      activeKind = kind;
      f.classList.add('on');
      const touched = new Set();
      edges.forEach(g=>{
        const on = g.dataset.kind === kind;
        g.style.opacity = on ? 1 : 0.08;
        if (on) { g.classList.add('sel','out'); touched.add(g.dataset.from); touched.add(g.dataset.to); }
      });
      nodes.forEach(n=>{ n.style.opacity = touched.has(n.dataset.id) ? 1 : 0.2; });
    };
  });
  function zoomTo(id){
    const g = nodes.find(n=> n.dataset.id===id);
    const rect = g && g.querySelector('rect');
    if (!rect) return;
    const pad = 20;   // viewport translate baked into the SVG
    const cx = (+rect.getAttribute('x')) + (+rect.getAttribute('width'))/2 + pad;
    const cy = (+rect.getAttribute('y')) + (+rect.getAttribute('height'))/2 + pad;
    const r = stage.getBoundingClientRect();
    scale = Math.min(Math.max(scale, 1.15), 1.8);
    tx = r.width/2 - cx*scale;
    ty = r.height/2 - cy*scale;
    svg.classList.add('anim');
    apply();
    setTimeout(()=> svg.classList.remove('anim'), 400);
  }
  function select(id){
    const connected = new Set([id]);
    edges.forEach(g=>{
      const out = g.dataset.from===id;
      const inn = g.dataset.to===id;
      g.classList.toggle('out', out);
      g.classList.toggle('in', inn);
      g.classList.toggle('sel', out || inn);
      g.style.opacity = (out || inn) ? 1 : 0.12;
      if (out || inn) { connected.add(g.dataset.from); connected.add(g.dataset.to); }
    });
    nodes.forEach(n=>{
      n.classList.toggle('hl', n.dataset.id===id);
      n.style.opacity = connected.has(n.dataset.id) ? 1 : 0.22;
    });
    showDetail(id);
    zoomTo(id);
  }
  function showDetail(id){
    const d = details[id];
    if (!d) { panel.hidden = true; return; }
    const kv = (k,v,cls)=> v ? '<div class="kv"><b>'+k+'</b><span'+(cls?' class="'+cls+'"':'')+'>'+escHtml(v)+'</span></div>' : '';
    const inbound = edges.filter(g=> g.dataset.to===id).length;
    const outbound = edges.filter(g=> g.dataset.from===id).length;
    const extras = Object.entries(d.extra||{})
      .filter(([k,v])=> k!=='securityGroups' && v!=null && v!=='')
      .map(([k,v])=> kv(k.replace(/([A-Z])/g,' $1').toLowerCase(), Array.isArray(v)? v.join(', ') : v)).join('');
    const tags = Object.entries(d.tags||{}).map(([k,v])=>
      '<span class="tag" title="'+escHtml(k)+'">'+escHtml(k)+'='+escHtml(v)+'</span>').join('');
    const DIFF_WORD = { added:'Added since last scan', removed:'Removed since last scan', changed:'Changed since last scan' };
    const show = v => v==null||v==='' ? '—' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    const changeRows = (d.changes||[]).map(f =>
      kv(escHtml(f.path), show(f.from) + ' → ' + show(f.to))
    ).join('');
    panel.innerHTML =
      '<button class="close" title="Close">✕</button>' +
      '<h3>'+escHtml(d.label)+'</h3><div class="svc">'+escHtml(d.sublabel)+(d.untagged?' · referenced (not tagged)':'')+'</div>' +
      (d.diffStatus ? '<div class="diff-banner '+escHtml(d.diffStatus)+'">'+escHtml(DIFF_WORD[d.diffStatus]||d.diffStatus)+(d.exposure?' · new exposure':'')+'</div>' : '') +
      changeRows +
      kv('ARN', (d.arn!=='internet' && d.arn!=='internet-egress') ? d.arn : '') +
      kv('Region', d.region) + kv('AZ', d.az) + kv('Subnet', d.subnet) + kv('VPC', d.vpc) +
      kv('State', d.state) +
      kv('Inbound', inbound ? inbound + (inbound===1?' link → here':' links → here') : '') +
      kv('Outbound', outbound ? outbound + (outbound===1?' link leaves':' links leave') : '') +
      kv('Open to net', d.open, 'warn') +
      kv('Sec. groups', (d.securityGroups||[]).join(', ')) +
      extras +
      (tags ? '<div class="tags">'+tags+'</div>' : '');
    panel.hidden = false;
    panel.querySelector('.close').onclick = clearSelection;
  }
  let moved = false;
  stage.addEventListener('mousedown', ()=>{ moved = false; });
  stage.addEventListener('mousemove', ()=>{ moved = true; });
  stage.addEventListener('click', e=>{
    if (moved) return;                      // it was a pan, not a click
    const g = e.target.closest('.node');
    if (g && g.dataset.id) return select(g.dataset.id);
    const eg = e.target.closest('.edge');
    if (eg) return selectEdge(eg);
    clearSelection();
  });
  // double-click empty space -> reset view
  stage.addEventListener('dblclick', e=>{
    if (e.target.closest('.node')) return;
    clearSelection();
    svg.classList.add('anim'); fit();
    setTimeout(()=> svg.classList.remove('anim'), 400);
  });
  // sidebar click -> same selection
  document.querySelectorAll('#rlist li, #changes li').forEach(li=>{
    li.onclick = ()=> select(li.dataset.id);
    li.tabIndex = 0;
    li.onkeydown = e=>{ if (e.key==='Enter' || e.key===' ') { e.preventDefault(); select(li.dataset.id); } };
  });
  nodes.forEach(n=>{
    n.addEventListener('keydown', e=>{
      if (e.key==='Enter' || e.key===' ') { e.preventDefault(); select(n.dataset.id); }
    });
  });
  document.addEventListener('keydown', e=>{
    if (e.target.closest('input,textarea,select,button,a')) return;
    const ids = nodes.map(n => n.dataset.id);
    if (!ids.length) return;
    if (e.key === 'Escape') { clearSelection(); return; }
    if (!['ArrowRight','ArrowDown','ArrowLeft','ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    let i = nodes.findIndex(n => n.classList.contains('hl'));
    if (i < 0) i = 0;
    else i = (e.key==='ArrowRight' || e.key==='ArrowDown') ? (i+1)%ids.length : (i-1+ids.length)%ids.length;
    select(ids[i]);
    nodes[i].focus();
  });

  // ---- downloads ----
  const isDark = ()=> document.documentElement.dataset.theme === 'dark';
  function serialize(opts = {}){
    const clone = svg.cloneNode(true);
    clone.style.transform=''; clone.removeAttribute('style');
    clone.querySelectorAll('[style]').forEach(el=> el.removeAttribute('style'));   // drop selection dimming
    clone.querySelectorAll('.hl').forEach(el=> el.classList.remove('hl'));
    clone.querySelectorAll('.hit').forEach(el=> el.remove());                      // click targets aren't content
    if (opts.still) clone.querySelectorAll('.flow').forEach(el=> el.remove());     // freeze PNG (no mid-dash snapshot)
    clone.querySelectorAll('.edge.sel').forEach(el=> el.classList.remove('sel'));
    if (isDark()) {
      // bake the dark theme into the exported file
      const st = document.createElementNS('http://www.w3.org/2000/svg','style');
      st.textContent = '.bg{fill:#04070C}.card{fill:#0E1622}.card:not(.ref){stroke:#22334A}' +
        '.tl{fill:#E6EDF3}.ts{fill:#93A3B8}.el{fill:#0B121C}.flow{stroke:#ffffff}';
      clone.insertBefore(st, clone.firstChild);
    }
    return '<?xml version="1.0" encoding="UTF-8"?>\\n' + new XMLSerializer().serializeToString(clone);
  }
  // ---- export dropdown ----
  const exports = JSON.parse(document.getElementById('export-data').textContent || '{}');
  const exportMenu = document.getElementById('exportMenu');
  document.getElementById('exportBtn').onclick = e=>{ e.stopPropagation(); exportMenu.hidden = !exportMenu.hidden; };
  document.addEventListener('click', ()=>{ exportMenu.hidden = true; });

  function downloadSvg(){
    const blob = new Blob([serialize()], {type:'image/svg+xml'});
    triggerDownload(URL.createObjectURL(blob), 'aws-architecture.svg');
  }
  function downloadPng(){
    const data = serialize({ still: true });
    const img = new Image();
    const url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(data)));
    img.onload = ()=>{
      const s = Math.min(2, 16000/Math.max(baseW, baseH));
      const c = document.createElement('canvas');
      c.width = Math.round(baseW*s); c.height = Math.round(baseH*s);
      const ctx = c.getContext('2d');
      ctx.fillStyle = isDark() ? '#04070C' : '#fff'; ctx.fillRect(0,0,c.width,c.height);
      ctx.scale(s,s); ctx.drawImage(img,0,0);
      c.toBlob(b=> triggerDownload(URL.createObjectURL(b), 'aws-architecture.png'), 'image/png');
    };
    img.onerror = ()=> alert('PNG export failed (browser could not rasterize the SVG).');
    img.src = url;
  }
  function downloadText(content, name, mime){
    const blob = new Blob([content], {type: mime});
    triggerDownload(URL.createObjectURL(blob), name);
  }
  exportMenu.querySelectorAll('button').forEach(btn=>{
    btn.onclick = ()=>{
      exportMenu.hidden = true;
      const kind = btn.dataset.x;
      if (kind === 'svg') return downloadSvg();
      if (kind === 'png') return downloadPng();
      if (kind === 'drawio' && exports.drawio) return downloadText(exports.drawio, 'aws-architecture.drawio', 'application/xml');
      if (kind === 'mermaid' && exports.mermaid) return downloadText(exports.mermaid, 'aws-architecture.mmd', 'text/plain');
      if (kind === 'excalidraw' && exports.excalidraw) return downloadText(exports.excalidraw, 'aws-architecture.excalidraw', 'application/json');
    };
  });
  function triggerDownload(href, name){
    const a = document.createElement('a'); a.href=href; a.download=name; document.body.appendChild(a); a.click(); a.remove();
  }

  fit();
})();
</script>
</body></html>`;
}

function buildChangesHtml(diff, graph) {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const row = (status, key, r, why) => {
    const n = byId.get(key);
    const label = n?.label || r?.name || r?.id || key;
    const sub = n?.sublabel || [r?.service, r?.type].filter(Boolean).join(':');
    const icon = n?.icon || '';
    const mark = status === 'added' ? '+' : status === 'removed' ? '−' : '~';
    return `<li data-id="${esc(key)}" data-diff="${esc(status)}" class="chg ${esc(status)}">` +
      (icon ? `<img src="${esc(icon)}" width="18" height="18"/>` : '') +
      `<span>${esc(label)}${why ? `<small class="why">${esc(why)}</small>` : ''}</span>` +
      `<i class="dmark ${esc(status)}">${mark}</i>` +
      `<em>${esc(sub)}</em></li>`;
  };
  const items = [];
  for (const r of diff.added || []) items.push(row('added', r.arn || r.id, r, 'new resource'));
  for (const r of diff.removed || []) items.push(row('removed', r.arn || r.id, r, 'gone'));
  for (const ch of diff.changed || []) {
    const why = ch.fields.map(f => f.path).slice(0, 4).join(', ') + (ch.exposure ? ' · exposure' : '');
    items.push(row('changed', ch.resource.arn || ch.resource.id, ch.resource, why));
  }
  if (!items.length) return '';
  return `<h2>Changes (${items.length})</h2><ul id="changes">${items.join('')}</ul>`;
}

/* ---------------------------- helpers ---------------------------- */

const r = v => Math.round((v + Number.EPSILON) * 10) / 10;

/** "ap-southeast-1a" -> "1a"; falls back to the raw value. */
function azShort(az) {
  if (!az) return '—';
  const m = String(az).match(/(\d+[a-z])$/i);
  return m ? m[1] : az;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
