#!/usr/bin/env node
/**
 * 3am_blueprint — scan AWS by tag and build a browsable architecture diagram.
 *
 * Usage:
 *   blueprint                                       (interactive TUI)
 *   blueprint --tag <TagKey> [--value <TagValue>] [--profile <name>] [options]
 *   blueprint --from-json <scan.json> [options]     (offline render, no AWS calls)
 *   blueprint diff <old.json> <new.json> [options]  (compare two scans)
 */
import { parseArgs, printHelp } from '../src/args.js';
import { runPipeline, resolveIconsDir, projectRoot } from '../src/pipeline.js';
import { formatDiff } from '../src/diff.js';

async function main() {
  const argv = process.argv.slice(2);

  // No arguments in a real terminal → interactive TUI.
  if ((argv.length === 0 && process.stdin.isTTY && process.stdout.isTTY) || argv[0] === 'tui') {
    const { runTui } = await import('../src/tui.js');
    await runTui();
    return;
  }

  // Subcommand: download an official provider icon set (aws/azure/gcp/oci/all).
  if (argv[0] === 'fetch-icons') {
    const { fetchIcons } = await import('../scripts/fetch-icons.mjs');
    await fetchIcons(argv[1], argv[2]);
    return;
  }

  // Subcommand: start the web UI.
  if (argv[0] === 'serve') {
    const { startServer } = await import('../src/server.js');
    const sArgs = parseArgs(argv.slice(1));
    const iconsDir = resolveIconsDir(sArgs);
    if (!iconsDir) {
      console.error('! AWS architecture icons not found — diagrams will use generic tiles.');
      console.error('  Run "blueprint fetch-icons" for the official icon set.');
    }
    try {
      startServer({
        port: Number(sArgs.port) || 8787,
        host: sArgs.host,
        iconsDir, projectRoot,
      });
    } catch (e) {
      // startServer refuses unsafe exposure (public bind with no access code);
      // it has already explained why.
      process.exit(e.exitCode || 1);
    }
    return;
  }

  // Subcommand: compare two saved scans (no AWS calls).
  if (argv[0] === 'diff') {
    const oldPath = argv[1];
    const newPath = argv[2];
    if (!oldPath || !newPath || String(oldPath).startsWith('-') || String(newPath).startsWith('-')) {
      console.error('Usage: blueprint diff <old-scan.json> <new-scan.json> [--out <dir>]');
      process.exit(1);
    }
    const rest = parseArgs(argv.slice(3));
    const result = await runPipeline({ ...rest, fromJson: newPath, diff: oldPath });
    if (result.diff) console.log(formatDiff(result.diff));
    console.error(`\n✔ Done. Open the portal:\n    ${result.htmlPath}\n`);
    console.error(`  Also written: diagram.svg, diff.json, scan.json in ${result.outDir}`);
    return;
  }

  const args = parseArgs(argv);
  if (args.help) { printHelp(); process.exit(0); }

  if (!args.fromJson && !args.tag && !args.vpcId && !args.accountScope) {
    console.error('Error: pick a scope — --tag <TagKey>, --vpc <vpc-id>, or --account (or use --from-json <file>).');
    console.error('Tip: run "blueprint" with no arguments for the interactive TUI.\n');
    printHelp();
    process.exit(1);
  }
  if (args.vpcId && !args.region?.length) {
    console.error('Note: --vpc without --region scans the default region only.');
  }

  const { htmlPath, outDir, diff } = await runPipeline(args);
  if (diff) console.log(formatDiff(diff));

  console.error(`\n✔ Done. Open the portal:\n    ${htmlPath}\n`);
  console.error(`  Also written: diagram.svg, diagram.drawio (editable), diagram.mmd (Mermaid),`);
  console.error(`  diagram.excalidraw, diagram.json, scan.json${diff ? ', diff.json' : ''} in ${outDir}`);
}

main().catch(err => {
  console.error('\n✖ Failed:', err?.message || err);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
