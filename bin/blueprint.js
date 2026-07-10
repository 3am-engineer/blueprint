#!/usr/bin/env node
/**
 * blueprint_ by 3am_ — scan AWS by tag and build a browsable architecture diagram.
 *
 * Usage:
 *   blueprint                                       (interactive TUI)
 *   blueprint --tag <TagKey> [--value <TagValue>] [--profile <name>] [options]
 *   blueprint --from-json <scan.json> [options]     (offline render, no AWS calls)
 */
import { parseArgs, printHelp } from '../src/args.js';
import { runPipeline, resolveIconsDir, projectRoot } from '../src/pipeline.js';

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
      console.error('Error: AWS architecture icons not found. Run "blueprint fetch-icons" first.');
      process.exit(1);
    }
    startServer({
      port: Number(sArgs.port) || 8787,
      host: sArgs.host,
      iconsDir, projectRoot,
    });
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

  const { htmlPath, outDir } = await runPipeline(args);

  console.error(`\n✔ Done. Open the portal:\n    ${htmlPath}\n`);
  console.error(`  Also written: diagram.svg, diagram.drawio (editable), diagram.mmd (Mermaid),`);
  console.error(`  diagram.excalidraw, diagram.json, scan.json in ${outDir}`);
}

main().catch(err => {
  console.error('\n✖ Failed:', err?.message || err);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
