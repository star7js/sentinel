import { ThreatIntel } from '../types.js';

/**
 * Static/manual threat intel constructors. For live open feeds (fetched at
 * startup + periodic refresh, disk-cached), see ./feeds.ts — data is always
 * injected into evaluate() as plain sets, keeping the engine pure.
 */
export function emptyIntel(): ThreatIntel {
  return { blocked: new Set() };
}

export function intelFromAddresses(addresses: string[]): ThreatIntel {
  return { blocked: new Set(addresses.map((a) => a.toLowerCase())) };
}
