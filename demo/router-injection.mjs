// Sentinel M4 demo: the LLM-router injection attack, replayed and blocked.
//
// The documented attack class (April 2026): a compromised router sits between
// the model and the agent's tools and swaps or injects tool calls. The agent
// believes it is paying an invoice; the transaction that reaches the signer
// does something else entirely. This script replays that pattern against a
// local chain and shows Sentinel blocking it on decoded effects.
//
// Run: npm run demo
//   - uses `anvil` from PATH (https://getfoundry.sh), or
//   - point SENTINEL_TEST_RPC at any anvil/hardhat-compatible node.
//
// The script is self-checking: it exits non-zero unless the legitimate
// payment succeeds AND both injected transactions are stopped. CI runs it.

import { readFileSync } from 'node:fs';
import { encodeFunctionData, parseAbi } from 'viem';
import {
  AnvilSimulator,
  startAnvil,
  SentinelSigner,
  SentinelBlockedError,
  RejectingEscalator,
  compilePolicy,
  emptyIntel,
  INFINITE_APPROVAL,
} from '../dist/index.js';

const AGENT = '0x1111111111111111111111111111111111111111';
const API_PROVIDER = '0x2222222222222222222222222222222222222222';
const DRAINER = '0xdead00000000000000000000000000000000beef';

const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 value) returns (bool)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

const log = (s = '') => console.log(s);
const failures = [];
const check = (ok, label) => {
  log(`   ${ok ? '✔' : '✘ FAILED:'} ${label}`);
  if (!ok) failures.push(label);
};

// ---------------------------------------------------------------- node setup
let rpcUrl = process.env.SENTINEL_TEST_RPC;
let anvil = null;
if (!rpcUrl) {
  anvil = await startAnvil({ chainId: 8453, port: 8548 });
  rpcUrl = anvil.rpcUrl;
}

const rpc = async (method, params) => {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
};

const chainId = Number(await rpc('eth_chainId', []));

// Fund the agent and deploy the demo token (mints 1,000,000 mUSD to deployer).
const { bytecode } = JSON.parse(
  readFileSync(new URL('../test/fixtures/mini-erc20.json', import.meta.url), 'utf8')
);
await rpc('hardhat_setBalance', [AGENT, '0x21e19e0c9bab2400000']);
await rpc('hardhat_impersonateAccount', [AGENT]);
const deployHash = await rpc('eth_sendTransaction', [
  { from: AGENT, data: bytecode, gas: '0xe4e1c0' },
]);
let token;
for (let i = 0; i < 100 && !token; i++) {
  const r = await rpc('eth_getTransactionReceipt', [deployHash]);
  if (r) token = r.contractAddress;
  else await new Promise((res) => setTimeout(res, 50));
}

// The "raw signer": actually broadcasts to the chain. In production this is
// your wallet SDK; Sentinel wraps it.
const rawSigner = {
  async signAndSend(tx) {
    // Local-chain stand-in for a real wallet: impersonate + broadcast.
    await rpc('hardhat_impersonateAccount', [tx.from]);
    const hash = await rpc('eth_sendTransaction', [
      { from: tx.from, to: tx.to ?? undefined, value: `0x${tx.value.toString(16)}`, data: tx.data, gas: '0xe4e1c0' },
    ]);
    for (let i = 0; i < 100; i++) {
      if (await rpc('eth_getTransactionReceipt', [hash])) return hash;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error('no receipt');
  },
};

const policy = compilePolicy(
  `
schemaVersion: 1
defaults:
  unknownContract: escalate
  onSimulationFailure: escalate
  contractCreation: escalate
chains:
  allowed: [${chainId}]
contracts:
  allow:
    - address: "${token}"
      label: musd
  block: []
spend:
  perTx:
    native: "0.05 ether"
    erc20:
      musd: "250"
  perSession:
    native: "0.2 ether"
    erc20:
      musd: "1000"
  sessionDuration: 3600
approvals:
  maxAmount:
    musd: "500"
  infinite: block
delegations:
  allow: []
  default: escalate
time:
  activeHours: null
`,
  { musd: { address: token, decimals: 6 } }
);

const guarded = new SentinelSigner(
  rawSigner,
  policy,
  new AnvilSimulator(rpcUrl),
  emptyIntel(), // no threat feeds: show the attack dies even with zero intel
  new RejectingEscalator()
);

const balanceOf = async (owner) =>
  BigInt(
    await rpc('eth_call', [
      { to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] }) },
      'latest',
    ])
  );
const allowanceOf = async (owner, spender) =>
  BigInt(
    await rpc('eth_call', [
      { to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender] }) },
      'latest',
    ])
  );
const tx = (data) => ({ chainId, from: AGENT, to: token, value: 0n, data });
const musd = (raw) => `${raw / 1_000_000n} mUSD`;

log('═══════════════════════════════════════════════════════════════════');
log(' SENTINEL DEMO — the LLM-router injection attack, replayed');
log('═══════════════════════════════════════════════════════════════════');
log();
log(` chain ${chainId} · agent ${AGENT}`);
log(` token ${token} (agent holds ${musd(await balanceOf(AGENT))})`);
log(` policy: 250 mUSD/tx, 1000 mUSD/session, infinite approvals blocked,`);
log(`         unknown contracts escalate to a human`);
log();

// ------------------------------------------------------- scene 1: the intent
log('─── Scene 1: what the agent MEANT to do ────────────────────────────');
log(' Agent tool call: pay 10 mUSD to the API provider.');
const payment = encodeFunctionData({
  abi: ERC20_ABI,
  functionName: 'transfer',
  args: [API_PROVIDER, 10_000_000n],
});
await guarded.signAndSend(tx(payment));
check((await balanceOf(API_PROVIDER)) === 10_000_000n, 'payment signed and delivered (in policy)');
log();

// -------------------------------------------- scene 2: the classic injection
log('─── Scene 2: compromised router swaps the tool call ────────────────');
log(' Same agent, same "payment" — but the calldata that reaches the');
log(' signer is approve(drainer, 2^256-1). On calldata alone this is');
log(' invisible. Sentinel simulates it on a fork and reads the effects:');
const drain = encodeFunctionData({
  abi: ERC20_ABI,
  functionName: 'approve',
  args: [DRAINER, INFINITE_APPROVAL],
});
try {
  await guarded.signAndSend(tx(drain));
  check(false, 'infinite approval should have been blocked');
} catch (err) {
  check(err instanceof SentinelBlockedError, 'BLOCKED before the signer was reached');
  log(`     reason: ${err.message.split(' | ').pop()}`);
}
check((await allowanceOf(AGENT, DRAINER)) === 0n, 'drainer allowance is still zero');
log();

// --------------------------------------- scene 3: the under-the-caps variant
log('─── Scene 3: stealth variant — stay under every spend cap ──────────');
log(' The attacker adapts: redirect a 0.04 ETH payment (under the 0.05');
log(' cap) straight to their own address. Caps alone would pass it, but');
log(' the destination is nothing the policy has ever approved:');
const stealthTx = { chainId, from: AGENT, to: DRAINER, value: 40_000_000_000_000_000n, data: '0x' };
try {
  await guarded.signAndSend(stealthTx);
  check(false, 'unknown-destination transfer should not sign silently');
} catch (err) {
  check(err instanceof SentinelBlockedError, 'ESCALATED to a human (auto-rejected in dev mode)');
}
check(BigInt(await rpc('eth_getBalance', [DRAINER, 'latest'])) === 0n, 'drainer received nothing');
log(' (Payments to allowlisted parties still flow; unknown ones need a tap');
log('  on Telegram. Session caps bound worst-case leakage either way.)');
log();

log('═══════════════════════════════════════════════════════════════════');
if (failures.length === 0) {
  log(' RESULT: legitimate payment signed; both injected transactions dead.');
  log(' The wallet judged what transactions DO, not what they claim.');
} else {
  log(` RESULT: ${failures.length} check(s) failed`);
}
log('═══════════════════════════════════════════════════════════════════');

anvil?.stop();
process.exit(failures.length === 0 ? 0 : 1);
