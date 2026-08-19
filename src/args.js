/** Minimal, dependency-free CLI argument parser. */

const FLAGS = {
  '--tag': 'tag',
  '--value': 'value',
  '--profile': 'profile',
  '--region': 'region',      // comma-separated list, or repeated
  '--regions': 'region',
  '--vpc': 'vpcId',
  '--out': 'out',
  '--icons-dir': 'iconsDir',
  '--from-json': 'fromJson',
  '--title': 'title',
  '--port': 'port',
  '--host': 'host',
  '--group-by': 'groupBy',
  '--role-arn': 'roleArn',
  '--external-id': 'externalId',
};

/** `--region all` is a common mistake for `--all-regions`. */
function normalizeRegions(args) {
  if (!args.region?.length) return;
  const hasAll = args.region.some(r => /^all$/i.test(r));
  if (!hasAll) return;
  const rest = args.region.filter(r => !/^all$/i.test(r));
  if (rest.length) {
    console.error('Note: "all" in --region means every enabled region; specific regions were ignored.');
  } else if (!args.allRegions) {
    console.error('Note: --region all scans every enabled region (same as --all-regions).');
  }
  args.allRegions = true;
  if (rest.length) args.region = rest;
  else delete args.region;
}

export function parseArgs(argv) {
  const args = { region: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    if (a === '--all-regions') { args.allRegions = true; continue; }
    if (a === '--show-all') { args.showAll = true; continue; }
    if (a === '--account') { args.accountScope = true; continue; }
    if (a === '--diff') {
      const next = argv[i + 1];
      if (next && !String(next).startsWith('-')) args.diff = argv[++i];
      else args.diff = true;
      continue;
    }
    const key = FLAGS[a];
    if (!key) {
      console.error(`Warning: unknown argument "${a}"`);
      continue;
    }
    const val = argv[++i];
    if (key === 'region') {
      String(val || '').split(',').map(s => s.trim()).filter(Boolean).forEach(r => args.region.push(r));
    } else {
      args[key] = val;
    }
  }
  if (args.region.length === 0) delete args.region;
  normalizeRegions(args);
  return args;
}

export function printHelp() {
  console.error(`
3am_blueprint — generate an AWS architecture diagram from tagged resources

USAGE
  blueprint                                           # interactive TUI (no args)
  blueprint --tag <TagKey> [--value <TagValue>] [--profile <name>] [options]
  blueprint --from-json <scan.json> [--out <dir>]     # offline render
  blueprint diff <old.json> <new.json> [--out <dir>]  # compare two scans
  blueprint fetch-icons [provider|all] [dest]         # download an official icon
                                                      # set: aws (default), azure,
                                                      # gcp, oci, or all
                                                      # (default ~/.blueprint/icons/<provider>)

SCOPES (pick one)
  --tag <key>          Everything carrying this tag key (add --value to narrow)
  --vpc <vpc-id>       Everything inside one VPC (give --region too)
  --account            Every resource the credentials can see (tagged plus
                       untagged EC2, LBs, RDS/Aurora, Lambda, EKS, DynamoDB)

OPTIONS
  --value <value>      Only include resources whose tag value equals this
  --profile <name>     AWS shared-config profile to use
  --region <list>      Comma-separated regions, or "all" for every enabled
                       region. Default without --region: profile region or
                       us-east-1 only. Prefer --all-regions to sweep all.
  --all-regions        Scan every enabled region (slower; same as --region all)
  --group-by <mode>    Container grouping: "network" (account→VPC→subnet,
                       default) or "type" (Compute, Storage, Databases, …)
  --show-all           Include low-signal resources (AMIs, snapshots, volumes,
                       ENIs, route tables, security groups, EKS pods, ELB
                       listener rules, CloudFormation stacks, etc.). Hidden
                       by default to keep the diagram readable.
  --out <dir>          Output directory (default: ./out)
  --icons-dir <path>   Path to the AWS icon set. Searched automatically in:
                       $BLUEPRINT_ICONS_DIR, ./icons, ~/.blueprint/icons,
                       <package>/icons. Run "blueprint fetch-icons" to install.
  --title <text>       Title shown in the portal header
  --from-json <file>   Render from a previously saved scan.json (no AWS calls)
  --diff [file]        Compare against a previous scan.json. Omit the path to
                       use <out>/scan.json from the last run. Highlights added
                       (green), removed (red ghosts), and changed (amber)
                       resources in the portal, and writes diff.json.
  --role-arn <arn>     Assume this role before scanning (optional external id)
  --external-id <id>   External id for --role-arn (recommended cross-account)
  -h, --help           Show this help

EXAMPLES
  blueprint --tag Project --value acme --profile prod
  blueprint --tag Environment --value staging --all-regions --out diagrams/staging
  blueprint --from-json out/scan.json --out out
  blueprint --account --diff --out out                 # vs last out/scan.json
  blueprint diff out/scan.prev.json out/scan.json
`);
}
