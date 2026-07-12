import { ThreatIntel } from '../types.js';

/**
 * M3: Open threat feeds.
 *
 * Candidate sources (all fetched at startup + periodic refresh, cached to disk;
 * never fetched inline during evaluation):
 *  - ScamSniffer open blocklist (github.com/scamsniffer/scam-database)
 *  - MetaMask eth-phishing-detect address lists
 *  - Chainabuse / community-reported drainer addresses
 *
 * Feed data is normalized to lowercase addresses and injected into evaluate()
 * as plain data, keeping the engine pure.
 */
export function emptyIntel(): ThreatIntel {
  return { blocked: new Set() };
}

export function intelFromAddresses(addresses: string[]): ThreatIntel {
  return { blocked: new Set(addresses.map((a) => a.toLowerCase())) };
}
