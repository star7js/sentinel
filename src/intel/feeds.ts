import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ThreatIntel } from '../types.js';

/**
 * M3: open threat-feed ingestion.
 *
 * Feeds are fetched at startup (and optionally on an interval), normalized to
 * lowercase addresses, and injected into evaluate() as plain data — the
 * engine stays pure and does no I/O. Feed data is *additive* protection: a
 * missing feed means fewer BLOCKs from intel, never an ALLOW the contract
 * allowlist wouldn't have granted, so load failures degrade loudly (via the
 * report) but don't halt the signer.
 */
export interface FeedSource {
  /** Stable name; also the disk-cache file name. */
  name: string;
  url: string;
  /** Parse a raw response body into addresses. Throw on malformed input. */
  parse(body: string): string[];
}

/** ScamSniffer open scam database — community-reported drainer addresses. */
export const scamSnifferAddresses: FeedSource = {
  name: 'scamsniffer-addresses',
  url: 'https://raw.githubusercontent.com/scamsniffer/scam-database/main/blacklist/address.json',
  parse: (body) => {
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array of addresses');
    return parsed.filter((a): a is string => typeof a === 'string');
  },
};

export interface FeedLoadOptions {
  /** Directory for on-disk feed caches. Stale cache is used when a fetch fails. */
  cacheDir?: string;
  /** Per-fetch timeout. Default 15s. */
  timeoutMs?: number;
}

export interface FeedReport {
  source: string;
  addresses: number;
  fromCache: boolean;
  error?: string;
}

export interface FeedLoadResult {
  intel: ThreatIntel;
  report: FeedReport[];
}

async function fetchSource(source: FeedSource, timeoutMs: number): Promise<string[]> {
  const res = await fetch(source.url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return source.parse(await res.text());
}

const cachePath = (dir: string, name: string) => join(dir, `${name}.json`);

function readCache(dir: string, name: string): string[] | null {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(dir, name), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string') : null;
  } catch {
    return null;
  }
}

function writeCache(dir: string, name: string, addresses: string[]): void {
  mkdirSync(dir, { recursive: true });
  const tmp = cachePath(dir, name) + '.tmp';
  writeFileSync(tmp, JSON.stringify(addresses));
  renameSync(tmp, cachePath(dir, name));
}

/**
 * Fetch all sources and merge them into one ThreatIntel. Per source: fresh
 * fetch wins; on failure the disk cache — or a caller-provided in-memory
 * fallback — is used; otherwise the source contributes nothing and the
 * report says why. Never throws — inspect the report to alert on degraded
 * intel.
 */
export async function loadFeeds(
  sources: FeedSource[],
  opts: FeedLoadOptions = {},
  fallbacks?: Map<string, string[]>
): Promise<FeedLoadResult> {
  const blocked = new Set<string>();
  const report: FeedReport[] = [];

  for (const source of sources) {
    try {
      const addresses = await fetchSource(source, opts.timeoutMs ?? 15_000);
      addresses.forEach((a) => blocked.add(a.toLowerCase()));
      if (opts.cacheDir) writeCache(opts.cacheDir, source.name, addresses);
      fallbacks?.set(source.name, addresses);
      report.push({ source: source.name, addresses: addresses.length, fromCache: false });
    } catch (err) {
      const stale =
        (opts.cacheDir ? readCache(opts.cacheDir, source.name) : null) ??
        fallbacks?.get(source.name) ??
        null;
      if (stale) stale.forEach((a) => blocked.add(a.toLowerCase()));
      report.push({
        source: source.name,
        addresses: stale?.length ?? 0,
        fromCache: stale !== null,
        error: (err as Error).message,
      });
    }
  }

  return { intel: { blocked }, report };
}

export interface FeedRefreshOptions extends FeedLoadOptions {
  /** Refresh interval. Default 1h. */
  intervalMs?: number;
  /** Called after each refresh with the load report (log it, alert on errors). */
  onRefresh?: (report: FeedReport[]) => void;
}

export interface FeedRefreshHandle {
  /** Live intel object; its blocked set is swapped in place on each refresh. */
  intel: ThreatIntel;
  /** Report from the initial load. */
  report: FeedReport[];
  stop(): void;
}

/**
 * Load feeds now and keep them fresh on an interval. The returned intel
 * object is updated in place, so hand it to SentinelSigner once and refreshes
 * apply to subsequent evaluations automatically.
 */
export async function startThreatFeeds(
  sources: FeedSource[],
  opts: FeedRefreshOptions = {}
): Promise<FeedRefreshHandle> {
  // Last-known-good data per source: a failed refresh can never shrink
  // coverage below what a previous fetch (or the disk cache) provided.
  const lastGood = new Map<string, string[]>();
  const initial = await loadFeeds(sources, opts, lastGood);
  const intel = initial.intel;

  const timer = setInterval(async () => {
    const result = await loadFeeds(sources, opts, lastGood);
    intel.blocked = result.intel.blocked;
    opts.onRefresh?.(result.report);
  }, opts.intervalMs ?? 3_600_000);
  timer.unref?.();

  return { intel, report: initial.report, stop: () => clearInterval(timer) };
}
