#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_ENDPOINT = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
const BLOCKING_SEVERITIES = new Set(['high', 'critical']);

/** Build the payload expected by npm's supported bulk advisory endpoint. */
export function productionPackageVersions(lock) {
  if (!lock || typeof lock !== 'object' || !lock.packages || typeof lock.packages !== 'object') {
    throw new Error('package-lock.json has no packages map');
  }

  const marker = 'node_modules/';
  const versionsByName = new Map();
  for (const [packagePath, pkg] of Object.entries(lock.packages)) {
    const markerIndex = packagePath.lastIndexOf(marker);
    if (markerIndex < 0 || !pkg || typeof pkg !== 'object') continue;
    if (typeof pkg.version !== 'string' || pkg.dev === true) continue;

    const name = packagePath.slice(markerIndex + marker.length);
    if (!name || name.includes(`/${marker}`)) {
      throw new Error(`cannot derive package name from lockfile path: ${packagePath}`);
    }

    let versions = versionsByName.get(name);
    if (!versions) {
      versions = new Set();
      versionsByName.set(name, versions);
    }
    versions.add(pkg.version);
  }

  return Object.fromEntries(
    [...versionsByName.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, versions]) => [name, [...versions].sort()]),
  );
}

/** Flatten npm's package-keyed response while preserving the package name. */
export function advisoriesFromReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('npm bulk audit returned an invalid report');
  }

  const advisories = [];
  for (const [packageName, entries] of Object.entries(report)) {
    if (!Array.isArray(entries)) {
      throw new Error(`npm bulk audit returned invalid advisories for ${packageName}`);
    }
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') {
        throw new Error(`npm bulk audit returned an invalid advisory for ${packageName}`);
      }
      advisories.push({ packageName, ...entry });
    }
  }
  return advisories;
}

export function blockingAdvisories(report) {
  return advisoriesFromReport(report).filter((entry) => (
    BLOCKING_SEVERITIES.has(String(entry.severity ?? '').toLowerCase())
  ));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBulkReport(packages, endpoint, timeoutMs) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(packages),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`npm bulk audit HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('npm bulk audit returned non-JSON content');
  }
}

async function main() {
  const lockfile = process.env.NPM_AUDIT_LOCKFILE || 'package-lock.json';
  const endpoint = process.env.NPM_AUDIT_BULK_URL || DEFAULT_ENDPOINT;
  const lock = JSON.parse(await readFile(lockfile, 'utf8'));
  const packages = productionPackageVersions(lock);
  const packageCount = Object.keys(packages).length;
  if (packageCount === 0) throw new Error('package-lock.json contains no production packages');

  let report;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      report = await fetchBulkReport(packages, endpoint, 60_000);
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        console.warn(`npm bulk audit attempt ${attempt}/3 failed: ${error.message}`);
        await delay(attempt * 5_000);
      }
    }
  }
  if (!report) throw lastError ?? new Error('npm bulk audit failed');

  const advisories = advisoriesFromReport(report);
  const blocking = blockingAdvisories(report);
  for (const advisory of advisories) {
    const line = `${String(advisory.severity).toUpperCase()} ${advisory.packageName}: ${advisory.title} (${advisory.url})`;
    if (BLOCKING_SEVERITIES.has(String(advisory.severity).toLowerCase())) console.error(line);
    else console.warn(line);
  }

  if (blocking.length > 0) {
    throw new Error(`npm bulk audit found ${blocking.length} high/critical production advisory(s)`);
  }
  console.log(`npm bulk audit: ${packageCount} production packages, no high/critical advisories`);
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`npm bulk audit failed: ${error.message}`);
    process.exitCode = 1;
  });
}
