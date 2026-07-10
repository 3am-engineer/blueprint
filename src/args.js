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
};

export function parseArgs(argv) {
  const args = { region: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    if (a === '--all-regions') { args.allRegions = true; continue; }
    if (a === '--show-all') { args.showAll = true; continue; }
    if (a === '--account') { args.accountScope = true; continue; }
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
  return args;
}

export function printHelp() {
  console.error(`
blueprint_ by 3am_ — generate an AWS architecture diagram from tagged resources

USAGE
  blueprint                                           # interactive TUI (no args)
  blueprint --tag <TagKey> [--value <TagValue>] [--profile <name>] [options]
  blueprint --from-json <scan.json> [--out <dir>]     # offline render
  blueprint fetch-icons [provider|all] [dest]         # download an official icon
                                                      # set: aws (default), azure,
                                                      # gcp, oci, or all
                                                      # (default ~/.blueprint/icons/<provider>)

SCOPES (pick one)
  --tag <key>          Everything carrying this tag key (add --value to narrow)
  --vpc <vpc-id>       Everything inside one VPC (give --region too)
  --account            Every tagged resource the credentials can see

OPTIONS
  --value <value>      Only include resources whose tag value equals this
  --profile <name>     AWS shared-config profile to use
  --region <list>      Comma-separated regions (repeatable). Default: profile
                       region + us-east-1. Use --all-regions to sweep all.
  --all-regions        Scan every enabled region (slower)
  --group-by <mode>    Container grouping: "network" (account→VPC→subnet,
                       default) or "type" (Compute, Storage, Databases, …)
  --show-all           Include low-signal resources (AMIs, snapshots, volumes,
                       ENIs, route tables, security groups, etc.). Hidden by
                       default to keep the diagram readable.
  --out <dir>          Output directory (default: ./out)
  --icons-dir <path>   Path to the AWS icon set. Searched automatically in:
                       $BLUEPRINT_ICONS_DIR, ./icons, ~/.blueprint/icons,
                       <package>/icons. Run "blueprint fetch-icons" to install.
  --title <text>       Title shown in the portal header
  --from-json <file>   Render from a previously saved scan.json (no AWS calls)
  -h, --help           Show this help

EXAMPLES
  blueprint --tag Project --value acme --profile prod
  blueprint --tag Environment --value staging --all-regions --out diagrams/staging
  blueprint --from-json out/scan.json --out out
`);
}
