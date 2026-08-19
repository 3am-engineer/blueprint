/**
 * AMI → OS detection and OS icon resolution.
 *
 * Detection order:
 *   1. Known AMI ID map (src/ami-map.json — extend with your own AMIs)
 *   2. EC2 Platform field ("windows")
 *   3. PlatformDetails string from DescribeImages
 *   4. Pattern match on AMI name / description
 *
 * Icons are bundled SVGs (the AWS architecture icon set has no OS logos).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {Record<string, string>} ami-id → os slug */
let KNOWN_AMIS = {};
try {
  KNOWN_AMIS = JSON.parse(fs.readFileSync(path.join(__dirname, 'ami-map.json'), 'utf8'));
} catch { /* optional file */ }

/** Pattern rules — first match wins. */
const OS_RULES = [
  { os: 'windows', test: ({ platform, platformDetails, name, description }) =>
    platform === 'windows' || /windows/i.test(platformDetails || '') ||
    /windows/i.test(name || '') || /windows/i.test(description || '') },
  { os: 'amazon-linux', test: ({ name, description, platformDetails }) =>
    /amazon.?linux|amzn|aws.?linux|amazonlinux/i.test(name || '') ||
    /amazon.?linux|amzn|aws.?linux/i.test(description || '') ||
    /amazon.?linux/i.test(platformDetails || '') },
  { os: 'ubuntu', test: ({ name, description, platformDetails }) =>
    /ubuntu|canonical/i.test(name || '') || /ubuntu/i.test(description || '') ||
    /ubuntu/i.test(platformDetails || '') },
  { os: 'debian', test: ({ name, description }) =>
    /debian/i.test(name || '') || /debian/i.test(description || '') },
  { os: 'rhel', test: ({ name, description, platformDetails }) =>
    /rhel|red.?hat|redhat/i.test(name || '') || /red.?hat/i.test(description || '') ||
    /red.?hat/i.test(platformDetails || '') },
  { os: 'rocky', test: ({ name, description }) =>
    /rocky/i.test(name || '') || /rocky/i.test(description || '') },
  { os: 'almalinux', test: ({ name, description }) =>
    /alma.?linux|almalinux/i.test(name || '') || /alma/i.test(description || '') },
  { os: 'centos', test: ({ name, description }) =>
    /centos/i.test(name || '') || /centos/i.test(description || '') },
  { os: 'suse', test: ({ name, description, platformDetails }) =>
    /suse|sles|opensuse/i.test(name || '') || /suse/i.test(description || '') ||
    /suse/i.test(platformDetails || '') },
  { os: 'fedora', test: ({ name, description }) =>
    /fedora/i.test(name || '') || /fedora/i.test(description || '') },
  { os: 'linux', test: ({ platformDetails }) =>
    /linux/i.test(platformDetails || '') },
];

export const OS_LABELS = {
  'amazon-linux': 'Amazon Linux',
  ubuntu: 'Ubuntu',
  debian: 'Debian',
  rhel: 'RHEL',
  rocky: 'Rocky Linux',
  almalinux: 'AlmaLinux',
  centos: 'CentOS',
  windows: 'Windows',
  suse: 'SUSE',
  fedora: 'Fedora',
  linux: 'Linux',
};

/** Detect OS slug from instance/AMI metadata. Returns null if unknown. */
export function detectOs({ imageId, platform, platformDetails, amiName, amiDescription } = {}) {
  if (imageId && KNOWN_AMIS[imageId]) return KNOWN_AMIS[imageId];

  const ctx = {
    platform,
    platformDetails: platformDetails || '',
    name: amiName || '',
    description: amiDescription || '',
  };
  for (const rule of OS_RULES) {
    if (rule.test(ctx)) return rule.os;
  }
  return null;
}

export function osLabel(slug) {
  return OS_LABELS[slug] || slug;
}

/** Simple branded SVG tiles — one per supported OS. */
const OS_SVGS = {
  'amazon-linux': `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
    <rect x="2" y="2" width="44" height="44" rx="8" fill="#232F3E"/>
    <path fill="#FF9900" d="M24 10c-7.7 0-14 6.3-14 14s6.3 14 14 14 14-6.3 14-14-6.3-14-14-14zm0 4a10 10 0 110 20 10 10 0 010-20z"/>
    <text x="24" y="28" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif" font-size="9" font-weight="700">AL</text>
  </svg>`,
  ubuntu: `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
    <circle cx="24" cy="24" r="22" fill="#E95420"/>
    <circle cx="24" cy="24" r="14" fill="none" stroke="#fff" stroke-width="2.5"/>
    <circle cx="24" cy="24" r="5" fill="#fff"/>
  </svg>`,
  debian: `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
    <rect x="2" y="2" width="44" height="44" rx="8" fill="#A80030"/>
    <path fill="#fff" d="M24 8c-8.8 0-16 7.2-16 16s7.2 16 16 16c2.2 0 4.3-.5 6.1-1.3-3.5-1.5-6-5-6-9.1 0-5.5 4.5-10 10-10 1.8 0 3.5.5 5 1.3C32.5 14.5 28.7 8 24 8z"/>
  </svg>`,
  rhel: `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
    <rect x="2" y="2" width="44" height="44" rx="8" fill="#EE0000"/>
    <ellipse cx="24" cy="26" rx="14" ry="10" fill="#fff"/>
    <path fill="#EE0000" d="M10 26c0-6 6.3-11 14-11s14 5 14 11"/>
  </svg>`,
  rocky: `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
    <rect x="2" y="2" width="44" height="44" rx="8" fill="#10B981"/>
    <path fill="#fff" d="M14 32l10-16 10 16H14z"/>
  </svg>`,
  almalinux: `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
    <rect x="2" y="2" width="44" height="44" rx="8" fill="#0066CC"/>
    <text x="24" y="29" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif" font-size="11" font-weight="700">Alma</text>
  </svg>`,
  centos: `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
    <rect x="2" y="2" width="44" height="44" rx="8" fill="#932279"/>
    <text x="24" y="29" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif" font-size="9" font-weight="700">CentOS</text>
  </svg>`,
  windows: `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
    <rect x="2" y="2" width="44" height="44" rx="8" fill="#0078D4"/>
    <path fill="#fff" d="M10 14h12v10H10V14zm16 0h12v10H26V14zM10 26h12v10H10V26zm16 0h12v10H26V26z"/>
  </svg>`,
  suse: `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
    <rect x="2" y="2" width="44" height="44" rx="8" fill="#73BA25"/>
    <text x="24" y="29" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif" font-size="10" font-weight="700">SUSE</text>
  </svg>`,
  fedora: `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
    <rect x="2" y="2" width="44" height="44" rx="8" fill="#294172"/>
    <text x="24" y="29" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif" font-size="9" font-weight="700">Fedora</text>
  </svg>`,
  linux: `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
    <rect x="2" y="2" width="44" height="44" rx="8" fill="#FCC624"/>
    <text x="24" y="29" text-anchor="middle" fill="#333" font-family="system-ui,sans-serif" font-size="10" font-weight="700">Linux</text>
  </svg>`,
};

const osCache = new Map();

/** Resolve an OS slug to { dataUri, base, matched }. */
export function resolveOsIcon(slug) {
  if (!slug) return null;
  if (osCache.has(slug)) return osCache.get(slug);
  const svg = OS_SVGS[slug];
  const out = svg
    ? { dataUri: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'), base: slug, matched: true }
    : null;
  osCache.set(slug, out);
  return out;
}
