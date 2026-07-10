/**
 * AWS Architecture Icons.
 *
 * AWS publishes the icon set as a zip whose URL changes every release, so we
 * scrape the icons page for the current "Asset-Package" link.
 * https://aws.amazon.com/architecture/icons/
 */
import { defaultDest, downloadAndExtract, fetchPage } from './shared.mjs';

const ICONS_PAGE = 'https://aws.amazon.com/architecture/icons/';

export const provider = {
  id: 'aws',
  name: 'AWS Architecture Icons',
  page: ICONS_PAGE,
};

export async function fetchProviderIcons(dest = defaultDest('aws')) {
  console.error(`• Looking up the current AWS icon asset package (${ICONS_PAGE})`);
  const page = await fetchPage(ICONS_PAGE);
  // AWS has named the bundle both "Asset-Package" and "Icon-package" over time.
  const m = page.match(/https:\/\/[^"' ]+(?:Asset-Package|Icon-package)[^"' ]*\.zip/i);
  if (!m) {
    throw new Error(
      `Could not find the icon package link on ${ICONS_PAGE}.\n` +
      `  Download the icons manually from that page and unzip them to:\n  ${dest}`);
  }
  await downloadAndExtract(m[0], dest, 'aws-asset-package.zip');
  console.error(`✔ AWS icons ready in ${dest}`);
  return dest;
}
