#!/usr/bin/env node
/**
 * Download official cloud-provider architecture icon sets.
 *
 * Each provider lives in scripts/providers/<id>.mjs and extracts into its
 * own folder (default: ~/.blueprint/icons/<provider>). Usage:
 *
 *   blueprint fetch-icons [provider|all] [dest]    (via the CLI)
 *   node scripts/fetch-icons.mjs [provider|all] [dest]
 *
 * Providers: aws (default), azure, gcp, oci. For backwards compatibility a
 * first argument that isn't a provider name is treated as the AWS dest:
 *
 *   node scripts/fetch-icons.mjs /some/dest       ≡  fetch-icons aws /some/dest
 */

export const PROVIDERS = ['aws', 'azure', 'gcp', 'oci'];

async function loadProvider(id) {
  return import(`./providers/${id}.mjs`);
}

/**
 * Fetch one provider's icons (or every provider with "all").
 * fetchIcons()            -> AWS into ~/.blueprint/icons/aws
 * fetchIcons('/dest')     -> AWS into /dest            (legacy call style)
 * fetchIcons('gcp')       -> GCP into ~/.blueprint/icons/gcp
 * fetchIcons('all')       -> every provider into ~/.blueprint/icons/<id>
 */
export async function fetchIcons(providerOrDest, dest) {
  let provider = providerOrDest;
  if (provider && provider !== 'all' && !PROVIDERS.includes(provider)) {
    // Legacy: single argument was the AWS destination path.
    dest = provider;
    provider = 'aws';
  }
  provider ||= 'aws';

  if (provider === 'all') {
    const results = [];
    for (const id of PROVIDERS) {
      const mod = await loadProvider(id);
      results.push(await mod.fetchProviderIcons(dest ? `${dest}/${id}` : undefined));
    }
    return results;
  }

  const mod = await loadProvider(provider);
  return mod.fetchProviderIcons(dest);
}

// Run directly?
if (import.meta.url === `file://${process.argv[1]}`) {
  fetchIcons(process.argv[2], process.argv[3]).catch(err => {
    console.error('✖ fetch-icons failed:', err.message);
    process.exit(1);
  });
}
