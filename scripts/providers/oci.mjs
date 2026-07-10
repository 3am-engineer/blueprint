/**
 * Oracle Cloud Infrastructure (OCI) architecture icons.
 *
 * Oracle's diagram-toolkit page mostly links draw.io/Visio/PowerPoint
 * bundles, but raw PNG+SVG icon zips are published on docs.oracle.com at
 * stable URLs, so we try those directly.
 * https://docs.oracle.com/en-us/iaas/Content/General/Reference/graphicsfordiagrams.htm
 */
import { defaultDest, downloadAndExtract } from './shared.mjs';

const ICONS_PAGE = 'https://docs.oracle.com/en-us/iaas/Content/General/Reference/graphicsfordiagrams.htm';
const CANDIDATE_URLS = [
  'https://docs.oracle.com/iaas/Content/Resources/Assets/OCI_Icons_PNG_SVG.zip',
  'https://docs.oracle.com/iaas/Content/Resources/Assets/OCI_Icons_SVG.zip',
];

export const provider = {
  id: 'oci',
  name: 'OCI architecture icons',
  page: ICONS_PAGE,
};

export async function fetchProviderIcons(dest = defaultDest('oci')) {
  console.error(`• Downloading the OCI icon package (see ${ICONS_PAGE})`);
  let lastErr;
  for (const url of CANDIDATE_URLS) {
    try {
      await downloadAndExtract(url, dest, 'oci-icons.zip');
      console.error(`✔ OCI icons ready in ${dest}`);
      return dest;
    } catch (err) {
      lastErr = err;
      console.error(`! ${err.message}`);
    }
  }
  throw new Error(
    `Could not download the OCI icons.\n` +
    `  Download them manually from ${ICONS_PAGE} and unzip into:\n  ${dest}\n` +
    `  (last error: ${lastErr?.message})`);
}
