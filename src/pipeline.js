/**
 * The scan → graph → render pipeline, shared by the flag CLI and the TUI.
 * Reports progress through an injectable `log` callback and throws on errors
 * (callers decide how to exit).
 */
import { scanAws } from './scan.js';
import { buildGraph } from './graph.js';
import { renderPortal } from './render.js';
import { loadIconIndex } from './icons.js';
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
 * Run a full scan+render. Returns { htmlPath, outDir, scan, graph }.
 * `log(line)` receives human-readable progress lines.
 */
export async function runPipeline(args, { log = console.error } = {}) {
  if (args.groupBy && !['network', 'type'].includes(args.groupBy)) {
    throw new Error(`--group-by must be "network" or "type" (got "${args.groupBy}").`);
  }

  const iconsDir = resolveIconsDir(args);
  if (!iconsDir) {
    throw new Error(
      'AWS architecture icons not found. Run "blueprint fetch-icons" first, or ' +
      'download from https://aws.amazon.com/architecture/icons/ and pass --icons-dir <path>.');
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
  log(`• Found ${n} tagged resource${n === 1 ? '' : 's'} across ${
    [...new Set((scan.resources || []).map(r => r.region))].filter(Boolean).length} region(s)`);
  if (n === 0 && !args.fromJson) {
    log('  Nothing matched. Things to check:');
    log(`    • Region — only scanned: ${(scan.meta.regions || []).join(', ')}.`);
    log('      Your resources may live elsewhere; re-run with --all-regions');
    log('      or --region <r1,r2>.');
    log('    • Tag key/value are case-sensitive (try dropping --value to match the key alone).');
    log(`    • The "${args.profile || 'default'}" profile can see the resources (account ${scan.meta.accountId || '?'}).`);
  }

  // 2. Load & index the icon set.
  log('• Indexing AWS architecture icons');
  const icons = loadIconIndex(iconsDir);

  // 3. Build the layered graph model (containers + nodes + inferred edges).
  log('• Building graph model and inferring relationships');
  const graph = buildGraph(scan, icons, { showAll: args.showAll, groupBy: args.groupBy });
  log(`  ${graph.stats.resources} shown · ${graph.stats.hidden} hidden` +
    `${graph.stats.hidden ? ' (use --show-all to include)' : ''} · ${graph.stats.edges} links`);

  // 4. Lay it out (elkjs) and render the self-contained HTML portal.
  log('• Computing layout and rendering portal');
  const outDir = path.resolve(args.out || 'out');
  fs.mkdirSync(outDir, { recursive: true });

  // Always drop the raw scan next to the output for auditing / re-rendering.
  fs.writeFileSync(path.join(outDir, 'scan.json'), JSON.stringify(scan, null, 2));

  const { html, svg, diagramJson, exports } = await renderPortal(graph, scan, { title: args.title });
  fs.writeFileSync(path.join(outDir, 'diagram.json'), JSON.stringify(diagramJson, null, 2));
  fs.writeFileSync(path.join(outDir, 'diagram.svg'), svg);
  fs.writeFileSync(path.join(outDir, 'diagram.drawio'), exports.drawio);
  fs.writeFileSync(path.join(outDir, 'diagram.mmd'), exports.mermaid);
  fs.writeFileSync(path.join(outDir, 'diagram.excalidraw'), exports.excalidraw);
  const htmlPath = path.join(outDir, 'index.html');
  fs.writeFileSync(htmlPath, html);

  return { htmlPath, outDir, scan, graph };
}
