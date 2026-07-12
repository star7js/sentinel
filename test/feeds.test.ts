import { describe, it, expect, afterEach } from 'vitest';
import { createServer, Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeedSource, loadFeeds, startThreatFeeds } from '../src/intel/feeds.js';

const DRAINER_A = '0xDEAD00000000000000000000000000000000BEEF';
const DRAINER_B = '0xBAD0000000000000000000000000000000000001';

type Responder = (respond: (status: number, body: string) => void) => void;

const servers: Server[] = [];
afterEach(() => {
  servers.splice(0).forEach((s) => s.close());
});

async function feedServer(handler: { current: Responder }): Promise<string> {
  const server = createServer((_req, res) => {
    handler.current((status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}/feed.json`;
}

const jsonArraySource = (name: string, url: string): FeedSource => ({
  name,
  url,
  parse: (body) => {
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed)) throw new Error('expected array');
    return parsed;
  },
});

const tmpCache = () => mkdtempSync(join(tmpdir(), 'sentinel-feeds-'));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('loadFeeds', () => {
  it('fetches, normalizes to lowercase, and reports counts', async () => {
    const handler = { current: ((respond) => respond(200, JSON.stringify([DRAINER_A, DRAINER_B]))) as Responder };
    const url = await feedServer(handler);

    const { intel, report } = await loadFeeds([jsonArraySource('test-feed', url)]);
    expect(intel.blocked.has(DRAINER_A.toLowerCase())).toBe(true);
    expect(intel.blocked.has(DRAINER_B.toLowerCase())).toBe(true);
    expect(report).toEqual([{ source: 'test-feed', addresses: 2, fromCache: false }]);
  });

  it('falls back to the disk cache when a fetch fails', async () => {
    const handler = { current: ((respond) => respond(200, JSON.stringify([DRAINER_A]))) as Responder };
    const url = await feedServer(handler);
    const cacheDir = tmpCache();
    const source = jsonArraySource('cached-feed', url);

    await loadFeeds([source], { cacheDir }); // warm the cache
    handler.current = (respond) => respond(500, '{}'); // feed goes down

    const { intel, report } = await loadFeeds([source], { cacheDir });
    expect(intel.blocked.has(DRAINER_A.toLowerCase())).toBe(true);
    expect(report[0].fromCache).toBe(true);
    expect(report[0].error).toMatch(/HTTP 500/);
  });

  it('reports the failure and contributes nothing when there is no cache', async () => {
    const source = jsonArraySource('dead-feed', 'http://127.0.0.1:9/nope.json');
    const { intel, report } = await loadFeeds([source], { timeoutMs: 1000 });
    expect(intel.blocked.size).toBe(0);
    expect(report[0].addresses).toBe(0);
    expect(report[0].error).toBeDefined();
  });

  it('rejects malformed feed bodies via the parser', async () => {
    const handler = { current: ((respond) => respond(200, '{"not": "an array"}')) as Responder };
    const url = await feedServer(handler);
    const { intel, report } = await loadFeeds([jsonArraySource('bad-feed', url)]);
    expect(intel.blocked.size).toBe(0);
    expect(report[0].error).toMatch(/expected array/);
  });
});

describe('startThreatFeeds', () => {
  it('refreshes the live intel object in place and survives feed outages', async () => {
    const handler = { current: ((respond) => respond(200, JSON.stringify([DRAINER_A]))) as Responder };
    const url = await feedServer(handler);

    const feeds = await startThreatFeeds([jsonArraySource('live-feed', url)], {
      intervalMs: 50,
    });
    try {
      expect(feeds.intel.blocked.has(DRAINER_A.toLowerCase())).toBe(true);

      // New address appears upstream → picked up on refresh.
      handler.current = (respond) => respond(200, JSON.stringify([DRAINER_A, DRAINER_B]));
      await sleep(150);
      expect(feeds.intel.blocked.has(DRAINER_B.toLowerCase())).toBe(true);

      // Feed goes down → last-known-good data is retained, not dropped.
      handler.current = (respond) => respond(500, '{}');
      await sleep(150);
      expect(feeds.intel.blocked.has(DRAINER_A.toLowerCase())).toBe(true);
      expect(feeds.intel.blocked.has(DRAINER_B.toLowerCase())).toBe(true);
    } finally {
      feeds.stop();
    }
  });
});
