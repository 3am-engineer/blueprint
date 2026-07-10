/**
 * Editable-diagram exporters: draw.io (.drawio), Mermaid (.mmd),
 * Excalidraw (.excalidraw).
 *
 * All three are pure functions of the graph model + computed layout, so the
 * exported file opens with the same geometry the portal shows (draw.io and
 * Excalidraw), or as clean diagram-as-code (Mermaid).
 *
 * Color maps mirror src/render.js (kept separate to avoid an import cycle —
 * render.js imports this module to embed exports in the portal).
 */

const KIND_COLOR = {
  account: '#E7157B',
  region: '#00A4A6',
  vpc: '#8C4FFF',
  'subnet-public': '#7AA116',
  'subnet-private': '#00A4A6',
  eks: '#E07700',
  category: '#5F6B7A',
  regional: '#7D8998',
};
const KIND_DASHED = new Set(['region', 'regional']);

const EDGE_COLOR = {
  internet: '#DD6B10',
  'lb-target': '#0972D3',
  'sg-flow': '#067F68',
  'sg-wide': '#B7791F',
  'asg-member': '#8C4FFF',
  event: '#B0084D',
  origin: '#7048E8',
  iam: '#5C7CFA',
  tls: '#DD344C',
  default: '#5F6B7A',
};
const EDGE_DASHED = new Set(['asg-member', 'iam', 'sg-wide']);
const edgeColor = k => EDGE_COLOR[k] || EDGE_COLOR.default;

const xml = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* ------------------------------ draw.io ------------------------------ */

/**
 * mxGraph XML with real containers (children positioned relative to parents),
 * image nodes using our embedded AWS icons, and orthogonal edges that stay
 * attached when nodes are dragged.
 * @returns {string} .drawio file contents
 */
export function toDrawio(graph, laid) {
  const cells = [];
  const cellId = new Map();          // graph id -> mxCell id
  let seq = 2;                       // 0 and 1 are reserved roots
  const idFor = gid => {
    if (!cellId.has(gid)) cellId.set(gid, `c${seq++}`);
    return cellId.get(gid);
  };

  const absById = new Map();
  for (const c of laid.containers) absById.set(c.id, c);

  const rel = (x, y, parent) => {
    const p = parent && absById.get(parent);
    return p ? { x: x - p.x, y: y - p.y } : { x, y };
  };

  // Containers, outer -> inner so parents exist before children.
  const depth = c => { let d = 0, cur = c; const m = new Map(laid.containers.map(k => [k.id, k]));
    while (cur && cur.parent) { d++; cur = m.get(cur.parent); } return d; };
  for (const c of [...laid.containers].sort((a, b) => depth(a) - depth(b))) {
    const col = KIND_COLOR[c.kind] || KIND_COLOR.regional;
    const { x, y } = rel(c.x, c.y, c.parent);
    const style = `rounded=0;whiteSpace=wrap;html=1;verticalAlign=top;align=left;spacingLeft=8;spacingTop=2;` +
      `fontSize=12;fontStyle=1;fillColor=none;strokeColor=${col};fontColor=${col};` +
      `${KIND_DASHED.has(c.kind) ? 'dashed=1;' : ''}container=1;collapsible=0;`;
    cells.push(`<mxCell id="${idFor(c.id)}" value="${xml(c.label)}" style="${style}" vertex="1" ` +
      `parent="${c.parent ? idFor(c.parent) : '1'}"><mxGeometry x="${r(x)}" y="${r(y)}" ` +
      `width="${r(c.w)}" height="${r(c.h)}" as="geometry"/></mxCell>`);
  }

  // Nodes: image cells with the label underneath (AWS diagram style).
  const ICON = 64;
  for (const n of laid.nodes) {
    // draw.io style values can't contain ';base64' — the comma form is
    // auto-detected as base64 by mxGraph.
    const img = String(n.icon || '').replace(';base64,', ',');
    const { x, y } = rel(n.x + (n.w - ICON) / 2, n.y + 4, n.parent);
    const style = `shape=image;html=1;verticalLabelPosition=bottom;verticalAlign=top;` +
      `labelBackgroundColor=none;imageAspect=0;aspect=fixed;fontSize=11;fontStyle=1;image=${img};`;
    cells.push(`<mxCell id="${idFor(n.id)}" value="${xml(n.label)}${n.sublabel && n.sublabel !== n.label ? '&#10;' + xml(n.sublabel) : ''}" ` +
      `style="${style}" vertex="1" parent="${n.parent ? idFor(n.parent) : '1'}">` +
      `<mxGeometry x="${r(x)}" y="${r(y)}" width="${ICON}" height="${ICON}" as="geometry"/></mxCell>`);
  }

  // Edges: let draw.io route orthogonally so they stay editable.
  for (const e of graph.edges) {
    if (!cellId.has(e.from) || !cellId.has(e.to)) continue;
    const col = edgeColor(e.kind);
    const style = `edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;fontSize=10;` +
      `strokeColor=${col};fontColor=${col};${EDGE_DASHED.has(e.kind) ? 'dashed=1;' : ''}` +
      `endArrow=block;endFill=1;jettySize=auto;orthogonalLoop=1;`;
    cells.push(`<mxCell id="e${seq++}" value="${xml(e.label || '')}" style="${style}" edge="1" parent="1" ` +
      `source="${cellId.get(e.from)}" target="${cellId.get(e.to)}">` +
      `<mxGeometry relative="1" as="geometry"/></mxCell>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<mxfile host="blueprint_" agent="3am-blueprint" version="22.0.0">` +
    `<diagram id="blueprint" name="AWS Architecture">` +
    `<mxGraphModel dx="1000" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" ` +
    `arrows="1" fold="1" page="1" pageScale="1" pageWidth="${Math.ceil(laid.width)}" ` +
    `pageHeight="${Math.ceil(laid.height)}" math="0" shadow="0">` +
    `<root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root>` +
    `</mxGraphModel></diagram></mxfile>`;
}

/* ------------------------------ Mermaid ------------------------------ */

/**
 * Diagram-as-code: nested subgraphs for containers, labeled edges, per-kind
 * link colors. Renders natively on GitHub / GitLab / most wikis.
 * @returns {string} .mmd file contents
 */
export function toMermaid(graph) {
  const lines = ['%% generated by blueprint_ (3am_) — https://3am.engineer/', 'flowchart TB'];
  const nid = new Map();
  let i = 0;
  const idOf = gid => { if (!nid.has(gid)) nid.set(gid, `n${i++}`); return nid.get(gid); };
  const clean = s => String(s == null ? '' : s).replace(/"/g, "'").replace(/[[\]{}|]/g, ' ');

  const byParent = new Map();
  for (const c of graph.containers) {
    if (!byParent.has(c.parent)) byParent.set(c.parent, { conts: [], nodes: [] });
    byParent.get(c.parent).conts.push(c);
  }
  for (const n of graph.nodes) {
    if (!byParent.has(n.parent)) byParent.set(n.parent, { conts: [], nodes: [] });
    byParent.get(n.parent).nodes.push(n);
  }

  let ci = 0;
  const cid4 = new Map();   // container graph id -> mermaid subgraph id
  function emit(parentId, indent) {
    const bucket = byParent.get(parentId);
    if (!bucket) return;
    for (const n of bucket.nodes) {
      const sub = n.sublabel && n.sublabel !== n.label ? `<br/><i>${clean(n.sublabel)}</i>` : '';
      lines.push(`${indent}${idOf(n.id)}["${clean(n.label)}${sub}"]`);
    }
    for (const c of bucket.conts) {
      const cid = `sg${ci++}`;
      cid4.set(c.id, cid);
      lines.push(`${indent}subgraph ${cid}["${clean(c.label)}"]`);
      emit(c.id, indent + '  ');
      lines.push(`${indent}end`);
      const col = KIND_COLOR[c.kind] || KIND_COLOR.regional;
      styleLines.push(`style ${cid} stroke:${col},fill:none${KIND_DASHED.has(c.kind) ? ',stroke-dasharray:5 4' : ''}`);
    }
  }
  const styleLines = [];
  emit(null, '  ');

  // Edges may target containers (bundle-collapsed fan-outs) — mermaid can
  // link subgraphs directly.
  const ref = gid => nid.get(gid) || cid4.get(gid);
  let emitted = 0;
  for (const e of graph.edges) {
    const a = ref(e.from), b = ref(e.to);
    if (!a || !b) continue;
    lines.push(`  ${a} ${e.label ? `-->|"${clean(e.label)}"|` : '-->'} ${b}`);
    styleLines.push(`linkStyle ${emitted++} stroke:${edgeColor(e.kind)},color:${edgeColor(e.kind)}`);
  }

  return [...lines, '', ...styleLines.map(s => '  ' + s), ''].join('\n');
}

/* ----------------------------- Excalidraw ----------------------------- */

/**
 * Excalidraw scene with our AWS icons embedded as image files, containers as
 * rectangles, and multi-point arrows following the computed routes.
 * @returns {string} .excalidraw file contents
 */
export function toExcalidraw(graph, laid) {
  let seed = 1234567;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483647);
  const now = Date.now();
  const els = [];
  const files = {};

  const base = o => ({
    angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
    fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 1,
    opacity: 100, groupIds: [], frameId: null, roundness: null,
    seed: rnd(), version: 1, versionNonce: rnd(), isDeleted: false,
    boundElements: null, updated: now, link: null, locked: false, ...o,
  });
  const text = (x, y, str, size, color, opts = {}) => base({
    id: `t${rnd()}`, type: 'text', x, y,
    width: str.length * size * 0.6, height: size * 1.3,
    text: str, originalText: str, fontSize: size, fontFamily: 3,
    textAlign: 'left', verticalAlign: 'top', strokeColor: color,
    containerId: null, lineHeight: 1.25, baseline: size, ...opts,
  });

  // Containers (outer first so they sit behind).
  const m = new Map(laid.containers.map(c => [c.id, c]));
  const depth = c => { let d = 0, cur = c; while (cur && cur.parent) { d++; cur = m.get(cur.parent); } return d; };
  for (const c of [...laid.containers].sort((a, b) => depth(a) - depth(b))) {
    const col = KIND_COLOR[c.kind] || KIND_COLOR.regional;
    els.push(base({
      id: `c${rnd()}`, type: 'rectangle', x: c.x, y: c.y, width: c.w, height: c.h,
      strokeColor: col, strokeStyle: KIND_DASHED.has(c.kind) ? 'dashed' : 'solid',
      roundness: { type: 3 },
    }));
    els.push(text(c.x + 8, c.y + 6, c.label, 13, col));
  }

  // Edges under nodes: multi-point arrows along the routed polyline.
  const edgeMeta = new Map(graph.edges.map(e => [e.id, e]));
  for (const e of laid.edges) {
    if (!e.points || e.points.length < 2) continue;
    const meta = edgeMeta.get(e.id) || {};
    const col = edgeColor(meta.kind);
    const [p0, ...rest] = e.points;
    els.push(base({
      id: `a${rnd()}`, type: 'arrow', x: p0.x, y: p0.y,
      width: Math.max(...e.points.map(p => p.x)) - Math.min(...e.points.map(p => p.x)),
      height: Math.max(...e.points.map(p => p.y)) - Math.min(...e.points.map(p => p.y)),
      strokeColor: col, strokeStyle: EDGE_DASHED.has(meta.kind) ? 'dashed' : 'solid',
      points: [[0, 0], ...rest.map(p => [p.x - p0.x, p.y - p0.y])],
      lastCommittedPoint: null, startBinding: null, endBinding: null,
      startArrowhead: null, endArrowhead: 'arrow', roundness: { type: 2 },
    }));
    if (e.label) {
      els.push(text(e.label.x, e.label.y, e.label.text, 10, col));
    }
  }

  // Nodes: embedded icon images + labels.
  const iconIds = new Map();
  for (const n of laid.nodes) {
    if (!iconIds.has(n.icon)) {
      const fid = `icon${iconIds.size}`;
      iconIds.set(n.icon, fid);
      files[fid] = {
        id: fid,
        mimeType: String(n.icon).startsWith('data:image/png') ? 'image/png' : 'image/svg+xml',
        dataURL: n.icon, created: now,
      };
    }
    const ICON = 56;
    const cx = n.x + n.w / 2;
    els.push(base({
      id: `img${rnd()}`, type: 'image', x: cx - ICON / 2, y: n.y + 4,
      width: ICON, height: ICON, fileId: iconIds.get(n.icon),
      scale: [1, 1], status: 'saved',
    }));
    els.push(text(cx - n.label.length * 6.6 / 2, n.y + ICON + 8, n.label, 11, '#1e1e1e'));
    if (n.sublabel && n.sublabel !== n.label) {
      els.push(text(cx - n.sublabel.length * 5.4 / 2, n.y + ICON + 24, n.sublabel, 9, '#5F6B7A'));
    }
  }

  return JSON.stringify({
    type: 'excalidraw', version: 2, source: 'https://3am.engineer/',
    elements: els, appState: { viewBackgroundColor: '#ffffff', gridSize: null },
    files,
  }, null, 1);
}

const r = v => Math.round((v + Number.EPSILON) * 10) / 10;
