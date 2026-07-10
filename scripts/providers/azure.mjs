/**
 * Microsoft Azure architecture icons.
 *
 * Microsoft links a versioned zip (Azure_Public_Service_Icons_V<N>.zip) from
 * the Azure Architecture Center icons page, so we scrape it for the current
 * link. https://learn.microsoft.com/en-us/azure/architecture/icons/
 */
import { defaultDest, downloadAndExtract, fetchPage } from './shared.mjs';

const ICONS_PAGE = 'https://learn.microsoft.com/en-us/azure/architecture/icons/';
// Known-good fallback in case the page markup changes.
const FALLBACK_URL = 'https://arch-center.azureedge.net/icons/Azure_Public_Service_Icons_V23.zip';

export const provider = {
  id: 'azure',
  name: 'Azure architecture icons',
  page: ICONS_PAGE,
};

export async function fetchProviderIcons(dest = defaultDest('azure')) {
  console.error(`• Looking up the current Azure icon package (${ICONS_PAGE})`);
  let url = FALLBACK_URL;
  try {
    const page = await fetchPage(ICONS_PAGE);
    const m = page.match(/https:\/\/[^"' ]+Azure_Public_Service_Icons[^"' ]*\.zip/i);
    if (m) url = m[0];
    else console.error(`! Could not find the download link on the page, using ${FALLBACK_URL}`);
  } catch (err) {
    console.error(`! Could not read ${ICONS_PAGE} (${err.message}), using ${FALLBACK_URL}`);
  }
  await downloadAndExtract(url, dest, 'azure-icons.zip');
  console.error(`✔ Azure icons ready in ${dest}`);
  return dest;
}
