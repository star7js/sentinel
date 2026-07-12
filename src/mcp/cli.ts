#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compilePolicy } from '../policy/loader.js';
import { AnvilSimulator } from '../simulation/anvil.js';
import { emptyIntel } from '../intel/blocklist.js';
import { startThreatFeeds, scamSnifferAddresses } from '../intel/feeds.js';
import { SentinelSigner, RejectingEscalator, Escalator } from '../signer/proxy.js';
import { TelegramEscalator, WebhookEscalator } from '../signer/escalators.js';
import { SentinelTypedDataSigner } from '../signatures/signer.js';
import { JsonFileStore } from '../state/store.js';
import { fromViemWalletClient, fromViemTypedDataSigner } from '../adapters/viem.js';
import { runMcpWallet } from './server.js';
import { Hex } from '../types.js';

/**
 * sentinel-mcp: a policy-guarded wallet as an MCP server.
 *
 * Required env:
 *   SENTINEL_POLICY       path to a policy YAML
 *   SENTINEL_RPC_URL      chain RPC used to broadcast
 *   SENTINEL_FORK_RPC     anvil/hardhat fork node used for simulation
 *   SENTINEL_PRIVATE_KEY  0x-prefixed key of the agent wallet
 *   SENTINEL_CHAIN_ID     chain id the policy applies to
 * Optional env:
 *   SENTINEL_TOKENS       path to JSON { label: { address, decimals } }
 *   SENTINEL_STATE_FILE   persist session spend caps across restarts
 *   SENTINEL_FEEDS        "scamsniffer" to enable the open drainer blocklist
 *   SENTINEL_FEEDS_CACHE  directory for feed disk cache
 *   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID   escalate to Telegram
 *   SENTINEL_WEBHOOK_URL                    …or to your approval webhook
 *   (neither set: escalations are rejected — deny by default)
 */

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`sentinel-mcp: missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

const policyPath = requireEnv('SENTINEL_POLICY');
const rpcUrl = requireEnv('SENTINEL_RPC_URL');
const forkRpc = requireEnv('SENTINEL_FORK_RPC');
const privateKey = requireEnv('SENTINEL_PRIVATE_KEY') as Hex;
const chainId = Number(requireEnv('SENTINEL_CHAIN_ID'));

const tokenMeta = process.env.SENTINEL_TOKENS
  ? (JSON.parse(readFileSync(process.env.SENTINEL_TOKENS, 'utf8')) as Record<
      string,
      { address: string; decimals: number }
    >)
  : {};

const policy = compilePolicy(readFileSync(policyPath, 'utf8'), tokenMeta);

const account = privateKeyToAccount(privateKey);
const chain = {
  id: chainId,
  name: `chain-${chainId}`,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
};
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

let escalator: Escalator = new RejectingEscalator();
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
  escalator = new TelegramEscalator({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    timeoutMs: (policy.escalation?.timeoutSeconds ?? 300) * 1000,
  });
} else if (process.env.SENTINEL_WEBHOOK_URL) {
  escalator = new WebhookEscalator(process.env.SENTINEL_WEBHOOK_URL, {
    timeoutMs: (policy.escalation?.timeoutSeconds ?? 300) * 1000,
  });
}

const intel =
  process.env.SENTINEL_FEEDS === 'scamsniffer'
    ? (
        await startThreatFeeds([scamSnifferAddresses], {
          cacheDir: process.env.SENTINEL_FEEDS_CACHE,
          onRefresh: (report) =>
            report
              .filter((r) => r.error)
              .forEach((r) => console.error(`sentinel-mcp: feed ${r.source} degraded: ${r.error}`)),
        })
      ).intel
    : emptyIntel();

const store = process.env.SENTINEL_STATE_FILE
  ? new JsonFileStore(process.env.SENTINEL_STATE_FILE)
  : undefined;

const simulator = new AnvilSimulator(forkRpc);
const signer = new SentinelSigner(
  fromViemWalletClient(wallet),
  policy,
  simulator,
  intel,
  escalator,
  store
);
const typedDataSigner = new SentinelTypedDataSigner(
  fromViemTypedDataSigner(wallet),
  policy,
  intel,
  escalator
);

console.error(
  `sentinel-mcp: guarding ${account.address} on chain ${chainId} (policy: ${policyPath})`
);
await runMcpWallet({ signer, typedDataSigner, chainId, from: account.address });
