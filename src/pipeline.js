/**
 * The scan → graph → render pipeline, shared by the flag CLI and the TUI.
 * Reports progress through an injectable `log` callback and throws on errors
 * (callers decide how to exit).
 */
import { scanAws } from './scan.js';
import { buildGraph } from './graph.js';
import { renderPortal } from './render.js';
import { loadIconIndex } from './icons.js';
import { redactScan } from './aws-ids.js';
import { diffScans, hasChanges, mergeScanForDiff } from './diff.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(__dirname, '..');

/** First existing icons dir: flag → env → ./icons → ~/.blueprint/icons → package. */
export function resolveIconsDir(args = {}) {
  const candidates = [
    args.iconsDir,
    process.env.BLUEPRINT_ICONS_DIR,
    path.resolve('icons'),
    path.join(os.homedir(), '.blueprint', 'icons'),
    path.join(projectRoot, 'icons'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.readdirSync(c).length) return c;
  }
  return null;
}

/**
 * Run a full scan+render. Returns { htmlPath, outDir, scan, graph, diff }.
 * `log(line)` receives human-readable progress lines.
 */
export async function runPipeline(args, { log = console.error } = {}) {
  if (args.groupBy && !['network', 'type'].includes(args.groupBy)) {
    throw new Error(`--group-by must be "network" or "type" (got "${args.groupBy}").`);
  }

  const iconsDir = resolveIconsDir(args);
  if (!iconsDir) {
    log('! AWS architecture icons not found — rendering with generic tiles.');
    log('  Run "blueprint fetch-icons" (or pass --icons-dir <path>) for the official icon set.');
  }

  const outDir = path.resolve(args.out || 'out');
  let oldScan = null;
  let diffAgainst = null;
  if (args.diff) {
    diffAgainst = args.diff === true ? path.join(outDir, 'scan.json') : path.resolve(args.diff);
    if (fs.existsSync(diffAgainst)) {
      oldScan = JSON.parse(fs.readFileSync(diffAgainst, 'utf8'));
    } else if (args.diff !== true) {
      throw new Error(`--diff file not found: ${diffAgainst}`);
    } else {
      log('• No previous scan.json in the output dir — skipping diff');
    }
  }

  // 1. Obtain the scan model (from AWS or from a saved JSON).
  let scan;
  if (args.fromJson) {
    log(`• Loading scan from ${args.fromJson}`);
    scan = JSON.parse(fs.readFileSync(args.fromJson, 'utf8'));
  } else {
    const scope = args.tag
      ? `tag "${args.tag}"${args.value ? `=${args.value}` : ''}`
      : args.vpcId ? `VPC ${args.vpcId}` : 'the whole account (tagged resources)';
    log(`• Scanning AWS for ${scope}${args.profile ? ` (profile: ${args.profile})` : ''}`);
    scan = await scanAws(args);
  }

  const n = scan.resources?.length || 0;
  log(`• Found ${n} resource${n === 1 ? '' : 's'} across ${
    [...new Set((scan.resources || []).map(r => r.region))].filter(Boolean).length} region(s)`);
  if (n === 0 && !args.fromJson) {
    log('  Nothing matched. Things to check:');
    log(`    • Region — only scanned: ${(scan.meta.regions || []).join(', ')}.`);
    log('      Your resources may live elsewhere; re-run with --all-regions');
    log('      or --region <r1,r2>.');
    log('    • Tag key/value are case-sensitive (try dropping --value to match the key alone).');
    log(`    • The "${args.profile || 'default'}" profile can see the resources (account ${scan.meta.accountId || '?'}).`);
  }

  // 2. Diff against a previous scan (live scan.json is never mutated).
  let diff = null;
  let renderScan = scan;
  if (oldScan) {
    diff = diffScans(oldScan, scan);
    const s = diff.summary;
    log(`• Diff vs ${diffAgainst}: +${s.added} −${s.removed} ~${s.changed}` +
      (s.exposure ? ` · ${s.exposure} new exposure` : '') +
      (hasChanges(diff) ? '' : ' · no changes'));
    if (hasChanges(diff)) renderScan = mergeScanForDiff(scan, oldScan, diff);
  }

  // 3. Load & index the icon set.
  log('• Indexing AWS architecture icons');
  const icons = loadIconIndex(iconsDir);

  // 4. Build the layered graph model (containers + nodes + inferred edges).
  log('• Building graph model and inferring relationships');
  const graph = buildGraph(renderScan, icons, { showAll: args.showAll, groupBy: args.groupBy });
  log(`  ${graph.stats.resources} shown · ${graph.stats.hidden} hidden` +
    `${graph.stats.hidden ? ' (use --show-all to include)' : ''} · ${graph.stats.edges} links`);

  // 5. Lay it out (elkjs) and render the self-contained HTML portal.
  log('• Computing layout and rendering portal');
  fs.mkdirSync(outDir, { recursive: true });

  // Keep the previous live scan so the next `--diff` has a baseline.
  const scanOut = path.join(outDir, 'scan.json');
  if (fs.existsSync(scanOut)) {
    fs.copyFileSync(scanOut, path.join(outDir, 'scan.prev.json'));
  }
  fs.writeFileSync(scanOut, JSON.stringify(redactScan(scan), null, 2));
  if (diff) {
    fs.writeFileSync(path.join(outDir, 'diff.json'), JSON.stringify(diff, null, 2));
  }

  const { html, svg, diagramJson, exports } = await renderPortal(graph, renderScan, { title: args.title });
  fs.writeFileSync(path.join(outDir, 'diagram.json'), JSON.stringify(diagramJson, null, 2));
  fs.writeFileSync(path.join(outDir, 'diagram.svg'), svg);
  fs.writeFileSync(path.join(outDir, 'diagram.drawio'), exports.drawio);
  fs.writeFileSync(path.join(outDir, 'diagram.mmd'), exports.mermaid);
  fs.writeFileSync(path.join(outDir, 'diagram.excalidraw'), exports.excalidraw);
  const htmlPath = path.join(outDir, 'index.html');
  fs.writeFileSync(htmlPath, html);

  return { htmlPath, outDir, scan, graph, diff };
}
