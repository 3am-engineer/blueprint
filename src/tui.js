/**
 * 3am_blueprint TUI — interactive terminal wizard (runs when the CLI is invoked
 * with no arguments, or via `blueprint tui`).
 *
 * Wraps the same pipeline as the flag CLI: pick a scope, profile, and regions,
 * watch the scan progress in a spinner, then open the rendered portal.
 */
import * as p from '@clack/prompts';
import pc from 'picocolors';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runPipeline, resolveIconsDir, projectRoot } from './pipeline.js';

/* ---------- small helpers ---------- */

function bail(value) {
  if (p.isCancel(value)) {
    p.cancel('Cancelled — nothing was scanned.');
    process.exit(0);
  }
  return value;
}

/** Profiles from ~/.aws/config ([profile x]) and ~/.aws/credentials ([x]). */
function awsProfiles() {
  const names = new Set();
  const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  for (const m of read(path.join(os.homedir(), '.aws', 'config')).matchAll(/^\[profile ([^\]]+)\]/gm)) {
    names.add(m[1].trim());
  }
  for (const m of read(path.join(os.homedir(), '.aws', 'credentials')).matchAll(/^\[([^\]]+)\]/gm)) {
    names.add(m[1].trim());
  }
  names.delete('default');
  return ['default', ...[...names].sort()];
}

/** Run a task while routing every console.error line into the spinner. */
async function withSpinner(startMsg, doneMsg, task) {
  const s = p.spinner();
  s.start(startMsg);
  const lines = [];
  const orig = console.error;
  console.error = (...a) => {
    const line = a.map(String).join(' ').split('\n')[0].trim();
    if (line) { lines.push(line); s.message(line.slice(0, 100)); }
  };
  try {
    const result = await task(line => { lines.push(line); s.message(line.slice(0, 100)); });
    console.error = orig;
    s.stop(doneMsg);
    return { result, lines };
  } catch (err) {
    console.error = orig;
    s.stop(pc.red('✖ failed'));
    throw err;
  }
}

function openInBrowser(target) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [target], { stdio: 'ignore', detached: true }).unref();
}

/* ---------- wizard steps ---------- */

async function askScanArgs(mode) {
  const args = {};

  if (mode === 'tag') {
    args.tag = bail(await p.text({
      message: 'Tag key to scan for',
      placeholder: 'Project',
      validate: v => (v?.trim() ? undefined : 'Required'),
    })).trim();
    const value = bail(await p.text({
      message: 'Tag value (leave empty to match the key alone)',
      placeholder: '',
      defaultValue: '',
    })).trim();
    if (value) args.value = value;
  } else if (mode === 'vpc') {
    args.vpcId = bail(await p.text({
      message: 'VPC id',
      placeholder: 'vpc-0abc123',
      validate: v => (/^vpc-[0-9a-f]+$/i.test(v?.trim() || '') ? undefined : 'Expected a vpc-… id'),
    })).trim();
  } else if (mode === 'account') {
    args.accountScope = true;
  }

  const profiles = awsProfiles();
  args.profile = bail(await p.select({
    message: 'AWS profile',
    options: [
      ...profiles.map(name => ({ value: name, label: name })),
      { value: '\u0000env', label: '(none — use environment credentials)' },
    ],
  }));
  if (args.profile === '\u0000env' || args.profile === 'default') delete args.profile;

  const regionMode = bail(await p.select({
    message: 'Regions to scan',
    options: [
      { value: 'default', label: 'Profile default (+ us-east-1)', hint: 'fastest' },
      { value: 'pick', label: 'Specific regions…' },
      { value: 'all', label: 'Every enabled region', hint: 'slower' },
    ],
  }));
  if (regionMode === 'all') args.allRegions = true;
  if (regionMode === 'pick') {
    const list = bail(await p.text({
      message: 'Regions (comma-separated)',
      placeholder: 'ap-southeast-1, us-east-1',
      validate: v => (v?.trim() ? undefined : 'Required'),
    }));
    args.region = list.split(',').map(s => s.trim()).filter(Boolean);
  }

  args.groupBy = bail(await p.select({
    message: 'Group the diagram by',
    options: [
      { value: 'network', label: 'Network', hint: 'Account → Region → VPC → subnet' },
      { value: 'type', label: 'Type', hint: 'Compute / Storage / Databases / …' },
    ],
  }));

  const extra = bail(await p.multiselect({
    message: 'Extras (space to toggle, enter to continue)',
    options: [
      { value: 'showAll', label: 'Include low-signal resources', hint: 'AMIs, volumes, ENIs, …' },
      { value: 'diff', label: 'Diff against last scan in the output dir', hint: 'needs a previous scan.json' },
    ],
    required: false,
  }));
  if (extra.includes('showAll')) args.showAll = true;
  if (extra.includes('diff')) args.diff = true;

  args.out = bail(await p.text({
    message: 'Output directory',
    initialValue: 'out',
  })).trim() || 'out';

  return args;
}

async function runDiffFlow() {
  const oldPath = bail(await p.text({
    message: 'Previous scan.json',
    initialValue: fs.existsSync('out/scan.prev.json') ? 'out/scan.prev.json'
      : fs.existsSync('out/scan.json') ? 'out/scan.json' : '',
    validate: v => (fs.existsSync(v?.trim() || '') ? undefined : 'File not found'),
  })).trim();
  const newPath = bail(await p.text({
    message: 'New scan.json',
    initialValue: fs.existsSync('out/scan.json') && oldPath !== 'out/scan.json' ? 'out/scan.json' : '',
    validate: v => (fs.existsSync(v?.trim() || '') ? undefined : 'File not found'),
  })).trim();
  const out = bail(await p.text({ message: 'Output directory', initialValue: 'out' })).trim() || 'out';
  return runScanFlow('json', { fromJson: newPath, diff: oldPath, out });
}

async function runScanFlow(mode, preset) {
  const args = preset || (mode === 'json'
    ? { fromJson: bail(await p.text({
        message: 'Path to scan.json',
        initialValue: fs.existsSync('out/scan.json') ? 'out/scan.json' : '',
        validate: v => (fs.existsSync(v?.trim() || '') ? undefined : 'File not found'),
      })).trim(),
      out: bail(await p.text({ message: 'Output directory', initialValue: 'out' })).trim() || 'out' }
    : await askScanArgs(mode));

  const { result } = await withSpinner(
    mode === 'json' ? 'Rendering…' : 'Scanning AWS…',
    pc.green('Diagram rendered'),
    log => runPipeline(args, { log }),
  );

  const n = result.scan.resources?.length || 0;
  const d = result.diff?.summary;
  p.note(
    `${pc.bold(String(n))} resources · ${result.graph.stats.edges} links` +
    (d ? `\n${pc.green('+' + d.added)} ${pc.red('−' + d.removed)} ${pc.yellow('~' + d.changed)}` +
      (d.exposure ? pc.red(` · ${d.exposure} new exposure`) : '') : '') +
    `\n${pc.dim('portal ')}${result.htmlPath}\n` +
    `${pc.dim('also   ')}diagram.svg · .drawio · .mmd · .excalidraw · scan.json` +
    (result.diff ? ' · diff.json' : ''),
    'Result');

  const next = bail(await p.select({
    message: 'Next',
    options: [
      { value: 'open', label: 'Open the portal in a browser' },
      { value: 'menu', label: 'Back to menu' },
      { value: 'quit', label: 'Quit' },
    ],
  }));
  if (next === 'open') { openInBrowser(result.htmlPath); return 'menu'; }
  return next;
}

async function runFetchIconsFlow() {
  const { PROVIDERS, fetchIcons } = await import('../scripts/fetch-icons.mjs');
  const picked = bail(await p.multiselect({
    message: 'Icon sets to download',
    options: PROVIDERS.map(id => ({
      value: id, label: id.toUpperCase(),
      hint: id === 'aws' ? 'required for diagrams' : 'optional',
    })),
    initialValues: ['aws'],
  }));
  for (const id of picked) {
    await withSpinner(`Fetching ${id} icons…`, pc.green(`${id} icons ready`), () => fetchIcons(id));
  }
  return 'menu';
}

/** Background web UI state: { server, url, port } while running, else null. */
let webUi = null;

async function startWebUiFlow() {
  const port = Number(bail(await p.text({ message: 'Port', initialValue: '8787' }))) || 8787;
  const iconsDir = resolveIconsDir();
  if (!iconsDir) p.log.warn('No icons installed — diagrams will use generic tiles (fetch the AWS set from the menu).');

  const { startServer } = await import('./server.js');
  const s = p.spinner();
  s.start(`Starting the web UI on port ${port}…`);
  try {
    const server = startServer({ port, iconsDir, projectRoot, quiet: true });
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const url = `http://localhost:${port}`;
    webUi = { server, url, port };
    s.stop(pc.green(`Web UI running in the background at ${pc.cyan(url)}`));
    p.log.info(pc.dim('Localhost-only bind · credentials are per-request, in memory only.'));
    if (bail(await p.confirm({ message: 'Open it in a browser?' }))) openInBrowser(url);
  } catch (err) {
    s.stop(pc.red('✖ could not start'));
    p.log.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : (err.message || String(err)));
  }
  return 'menu';
}

async function webUiMenuFlow() {
  const action = bail(await p.select({
    message: `Web UI is running at ${webUi.url}`,
    options: [
      { value: 'open', label: 'Open in a browser' },
      { value: 'stop', label: 'Stop the web UI' },
      { value: 'back', label: 'Back to menu' },
    ],
  }));
  if (action === 'open') openInBrowser(webUi.url);
  if (action === 'stop') await stopWebUi();
  return 'menu';
}

async function stopWebUi() {
  if (!webUi) return;
  const { server, port } = webUi;
  webUi = null;
  await new Promise(resolve => {
    server.close(resolve);
    // Don't let idle browser keep-alive sockets delay the shutdown.
    server.closeAllConnections?.();
  });
  p.log.success(`Web UI on port ${port} stopped.`);
}

/* ---------- entry ---------- */

export async function runTui() {
  console.clear();
  p.intro(`${pc.bgCyan(pc.black(' 3am_blueprint '))} ${pc.dim('AWS architecture, drawn while you sleep')}`);

  if (!resolveIconsDir()) {
    p.log.warn('AWS architecture icons are not installed yet.');
    const fetch = bail(await p.confirm({ message: 'Download the official AWS icon set now?' }));
    if (fetch) {
      const { fetchIcons } = await import('../scripts/fetch-icons.mjs');
      await withSpinner('Fetching AWS icons…', pc.green('AWS icons ready'), () => fetchIcons('aws'));
    } else {
      p.log.info('You can fetch them later from the menu or with "blueprint fetch-icons".');
    }
  }

  for (;;) {
    const mode = bail(await p.select({
      message: 'What do you want to do?',
      options: [
        { value: 'tag', label: 'Scan by tag', hint: 'key or key=value' },
        { value: 'vpc', label: 'Scan one VPC' },
        { value: 'account', label: 'Scan the whole account', hint: 'tagged + untagged common services' },
        { value: 'json', label: 'Re-render a saved scan.json', hint: 'offline' },
        { value: 'diff', label: 'Compare two scans', hint: 'highlight what changed' },
        webUi
          ? { value: 'serve', label: `Web UI ${pc.green('● running')}`, hint: `${webUi.url} — open · stop` }
          : { value: 'serve', label: 'Start the web UI', hint: 'runs in the background' },
        { value: 'icons', label: 'Fetch provider icon sets', hint: 'aws · azure · gcp · oci' },
        { value: 'quit', label: 'Quit' },
      ],
    }));

    let next = 'quit';
    try {
      if (mode === 'quit') next = 'quit';
      else if (mode === 'icons') next = await runFetchIconsFlow();
      else if (mode === 'serve') next = webUi ? await webUiMenuFlow() : await startWebUiFlow();
      else if (mode === 'diff') next = await runDiffFlow();
      else next = await runScanFlow(mode);
    } catch (err) {
      p.log.error(err?.message || String(err));
      if (process.env.DEBUG) console.error(err);
      next = 'menu';
    }

    if (next === 'quit') break;
  }

  await stopWebUi();
  p.outro(pc.dim('bye — https://3am.engineer/'));
}
