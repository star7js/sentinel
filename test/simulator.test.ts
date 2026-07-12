import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { encodeFunctionData, parseAbi } from 'viem';
import { AnvilSimulator, startAnvil, AnvilHandle } from '../src/simulation/anvil.js';
import { compilePolicy } from '../src/policy/loader.js';
import { emptyIntel } from '../src/intel/blocklist.js';
import { SentinelSigner, SentinelBlockedError, RejectingEscalator } from '../src/signer/proxy.js';
import { Address, Hex, TxRequest, INFINITE_APPROVAL } from '../src/types.js';
import { MINI_ERC20_BYTECODE } from './fixtures/mini-erc20.js';

const AGENT = '0x1111111111111111111111111111111111111111' as Address;
const BOB = '0x2222222222222222222222222222222222222222' as Address;
const DRAINER = '0xdead00000000000000000000000000000000beef' as Address;

const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 value) returns (bool)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
  'function balanceOf(address owner) view returns (uint256)',
]);

// Runs against SENTINEL_TEST_RPC if set (any anvil/hardhat-compatible node),
// otherwise spawns a local anvil. Skipped entirely when neither is available.
const EXTERNAL_RPC = process.env.SENTINEL_TEST_RPC;
const hasAnvil = spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!EXTERNAL_RPC && !hasAnvil)('AnvilSimulator', () => {
  let anvil: AnvilHandle | null = null;
  let rpcUrl: string;
  let chainId: number;
  let token: Address;
  let sim: AnvilSimulator;

  const rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  };

  const baseTx = (over: Partial<TxRequest>): TxRequest => ({
    chainId,
    from: AGENT,
    to: token,
    value: 0n,
    data: '0x',
    ...over,
  });

  beforeAll(async () => {
    if (EXTERNAL_RPC) {
      rpcUrl = EXTERNAL_RPC;
    } else {
      anvil = await startAnvil({ chainId: 8453, port: 8547 });
      rpcUrl = anvil.rpcUrl;
    }
    chainId = Number(await rpc<Hex>('eth_chainId', []));

    await rpc('hardhat_setBalance', [AGENT, '0x21e19e0c9bab2400000']); // 10,000 ETH
    await rpc('hardhat_impersonateAccount', [AGENT]);
    const deployHash = await rpc<Hex>('eth_sendTransaction', [
      { from: AGENT, data: MINI_ERC20_BYTECODE, gas: '0xe4e1c0' },
    ]);
    for (let i = 0; i < 100; i++) {
      const receipt = await rpc<{ contractAddress: Address } | null>(
        'eth_getTransactionReceipt',
        [deployHash]
      );
      if (receipt) {
        token = receipt.contractAddress;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    await rpc('hardhat_stopImpersonatingAccount', [AGENT]);
    expect(token).toBeDefined();

    sim = new AnvilSimulator(rpcUrl);
  }, 30_000);

  afterAll(() => anvil?.stop());

  const agentTokenBalance = async (): Promise<bigint> => {
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [AGENT] });
    return BigInt(await rpc<Hex>('eth_call', [{ to: token, data }, 'latest']));
  };

  it('decodes a native transfer as a balance diff (gas excluded)', async () => {
    const effects = await sim.simulate(baseTx({ to: BOB, value: 10n ** 18n }));
    expect(effects).not.toBeNull();
    expect(effects!.reverted).toBe(false);
    expect(effects!.balanceDiffs).toContainEqual({
      address: AGENT,
      token: 'native',
      delta: -(10n ** 18n),
    });
  });

  it('decodes an ERC20 transfer from Transfer logs', async () => {
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [BOB, 100_000_000n], // 100 mUSD
    });
    const effects = await sim.simulate(baseTx({ data }));
    expect(effects).not.toBeNull();
    expect(effects!.reverted).toBe(false);
    expect(effects!.balanceDiffs).toContainEqual({
      address: AGENT,
      token: token.toLowerCase(),
      delta: -100_000_000n,
    });
    expect(effects!.balanceDiffs).toContainEqual({
      address: BOB,
      token: token.toLowerCase(),
      delta: 100_000_000n,
    });
    expect(effects!.contractsTouched).toContain(token.toLowerCase());
  });

  it('decodes an infinite approval — the drainer move', async () => {
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [DRAINER, INFINITE_APPROVAL],
    });
    const effects = await sim.simulate(baseTx({ data }));
    expect(effects).not.toBeNull();
    expect(effects!.approvals).toContainEqual({
      token: token.toLowerCase(),
      spender: DRAINER,
      amount: INFINITE_APPROVAL,
    });
  });

  it('decodes setApprovalForAll — the NFT drain move', async () => {
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'setApprovalForAll',
      args: [DRAINER, true],
    });
    const effects = await sim.simulate(baseTx({ data }));
    expect(effects).not.toBeNull();
    expect(effects!.approvalsForAll).toContainEqual({
      token: token.toLowerCase(),
      operator: DRAINER,
      approved: true,
    });
  });

  it('reports a reverting transaction', async () => {
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [BOB, 2_000_000_000_000n], // 2M mUSD > 1M supply
    });
    const effects = await sim.simulate(baseTx({ data }));
    expect(effects).not.toBeNull();
    expect(effects!.reverted).toBe(true);
  });

  it('never mutates node state (snapshot/revert)', async () => {
    const before = await agentTokenBalance();
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [BOB, 500_000_000n],
    });
    await sim.simulate(baseTx({ data }));
    await sim.simulate(baseTx({ to: BOB, value: 10n ** 18n }));
    expect(await agentTokenBalance()).toBe(before);
  });

  it('returns null when tx.chainId does not match the node', async () => {
    const effects = await sim.simulate(baseTx({ chainId: chainId + 1 }));
    expect(effects).toBeNull();
  });

  it('returns null when the node is unreachable', async () => {
    const dead = new AnvilSimulator('http://127.0.0.1:9', { timeoutMs: 1000 });
    expect(await dead.simulate(baseTx({}))).toBeNull();
  });

  describe('end-to-end with SentinelSigner', () => {
    const policyFor = () =>
      compilePolicy(
        `
schemaVersion: 1
defaults:
  unknownContract: escalate
  onSimulationFailure: escalate
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
escalation:
  channel: webhook
  timeoutSeconds: 300
  onTimeout: block
`,
        { musd: { address: token, decimals: 6 } }
      );

    it('signs an in-policy transfer, blocks an injected infinite approval', async () => {
      let signed = 0;
      const inner = {
        signAndSend: async () => {
          signed += 1;
          return ('0x' + 'ab'.repeat(32)) as Hex;
        },
      };
      const guarded = new SentinelSigner(
        inner,
        policyFor(),
        sim,
        emptyIntel(),
        new RejectingEscalator()
      );

      const pay = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [BOB, 100_000_000n], // 100 mUSD, within caps
      });
      await guarded.signAndSend(baseTx({ data: pay }));
      expect(signed).toBe(1);

      // The router-injection scenario: the "payment" was swapped for an
      // unlimited approval to an attacker. Simulation sees what it really
      // does; policy blocks before the signer is reached.
      const drain = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [DRAINER, INFINITE_APPROVAL],
      });
      await expect(guarded.signAndSend(baseTx({ data: drain }))).rejects.toThrow(
        SentinelBlockedError
      );
      expect(signed).toBe(1);
    });
  });
});
