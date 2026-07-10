/**
 * Google Cloud product icons.
 *
 * Google ships two zips (unique 4-color core product icons + 2-color category
 * icons), both linked from https://cloud.google.com/icons. We scrape the page
 * for the current links and fall back to the known asset URLs.
 */
import { defaultDest, downloadAndExtract, fetchPage } from './shared.mjs';

const ICONS_PAGE = 'https://cloud.google.com/icons';
const FALLBACK_URLS = [
  'https://services.google.com/fh/files/misc/core-products-icons.zip',
  'https://services.google.com/fh/files/misc/category-icons.zip',
];

export const provider = {
  id: 'gcp',
  name: 'Google Cloud product icons',
  page: ICONS_PAGE,
};

export async function fetchProviderIcons(dest = defaultDest('gcp')) {
  console.error(`• Looking up the current Google Cloud icon packages (${ICONS_PAGE})`);
  let urls = [];
  try {
    const page = await fetchPage(ICONS_PAGE);
    urls = [...new Set(page.match(/https:\/\/services\.google\.com\/[^"' ]+\.zip/gi) || [])]
      .filter(u => !/legacy/i.test(u));
  } catch (err) {
    console.error(`! Could not read ${ICONS_PAGE} (${err.message})`);
  }
  if (!urls.length) {
    console.error(`! Could not find download links on the page, using known asset URLs`);
    urls = FALLBACK_URLS;
  }
  for (const url of urls) {
    const name = url.split('/').pop();
    await downloadAndExtract(url, dest, name);
  }
  console.error(`✔ Google Cloud icons ready in ${dest}`);
  return dest;
}
