/**
 * Shared helpers for the per-provider icon fetchers.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Default root for downloaded icon sets: ~/.blueprint/icons/<provider>. */
export function defaultDest(provider) {
  return path.join(os.homedir(), '.blueprint', 'icons', provider);
}

/** Fetch a page and return its text (used to scrape download links). */
export async function fetchPage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  return res.text();
}

/**
 * Download a zip to `dest` and extract it there.
 * If "unzip" is unavailable the archive is kept on disk with instructions.
 */
export async function downloadAndExtract(url, dest, zipName = 'icons.zip') {
  console.error(`• Downloading ${url}`);
  fs.mkdirSync(dest, { recursive: true });
  const zipPath = path.join(dest, zipName);

  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} (${url})`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(zipPath));
  console.error(`• Saved ${(fs.statSync(zipPath).size / 1e6).toFixed(1)} MB, extracting…`);

  try {
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', dest], { stdio: 'inherit' });
    fs.unlinkSync(zipPath);
  } catch {
    console.error(
      `! Could not run "unzip". The archive was saved to:\n    ${zipPath}\n` +
      `  Extract it into ${dest} yourself.`);
    return dest;
  }
  return dest;
}
