import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { encodeFunctionData, encodeAbiParameters, parseAbi } from 'viem';
import { AnvilSimulator, startAnvil, AnvilHandle } from '../src/simulation/anvil.js';
import { SentinelUserOpSender, userOpToTxRequest } from '../src/aa/userop.js';
import { SentinelBlockedError, RejectingEscalator } from '../src/signer/proxy.js';
import { compilePolicy } from '../src/policy/loader.js';
import { emptyIntel } from '../src/intel/blocklist.js';
import { Address, Hex, INFINITE_APPROVAL } from '../src/types.js';
import erc20Fixture from './fixtures/mini-erc20.json';
import accountFixture from './fixtures/mini-account.json';

const OWNER = '0x1111111111111111111111111111111111111111' as Address;
const BOB = '0x2222222222222222222222222222222222222222' as Address;
const DRAINER = '0xdead00000000000000000000000000000000beef' as Address;
// Test EntryPoint is an EOA we impersonate — the simulator only needs it as msg.sender.
const ENTRYPOINT = '0x4337000000000000000000000000000000004337' as Address;

const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 value) returns (bool)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
]);
const ACCOUNT_ABI = parseAbi(['function execute(address dest, uint256 value, bytes data)']);

const EXTERNAL_RPC = process.env.SENTINEL_TEST_RPC;
const hasAnvil = spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!EXTERNAL_RPC && !hasAnvil)('ERC-4337 userOp guarding', () => {
  let anvil: AnvilHandle | null = null;
  let rpcUrl: string;
  let chainId: number;
  let token: Address;
  let account: Address;
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

  const sendAs = async (from: Address, tx: Record<string, unknown>): Promise<Address | null> => {
    await rpc('hardhat_impersonateAccount', [from]);
    const hash = await rpc<Hex>('eth_sendTransaction', [{ from, gas: '0xe4e1c0', ...tx }]);
    for (let i = 0; i < 100; i++) {
      const r = await rpc<{ contractAddress: Address | null } | null>(
        'eth_getTransactionReceipt',
        [hash]
      );
      if (r) return r.contractAddress;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error('no receipt');
  };

  beforeAll(async () => {
    if (EXTERNAL_RPC) {
      rpcUrl = EXTERNAL_RPC;
    } else {
      anvil = await startAnvil({ chainId: 8453, port: 8551 });
      rpcUrl = anvil.rpcUrl;
    }
    chainId = Number(await rpc<Hex>('eth_chainId', []));

    await rpc('hardhat_setBalance', [OWNER, '0x21e19e0c9bab2400000']);
    await rpc('hardhat_setBalance', [ENTRYPOINT, '0x21e19e0c9bab2400000']);

    token = (await sendAs(OWNER, { data: erc20Fixture.bytecode }))!;
    const ctorArg = encodeAbiParameters([{ type: 'address' }], [ENTRYPOINT]).slice(2);
    account = (await sendAs(OWNER, { data: accountFixture.bytecode + ctorArg }))!;

    // Fund the smart account: 500 mUSD.
    await sendAs(OWNER, {
      to: token,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [account, 500_000_000n] }),
    });

    sim = new AnvilSimulator(rpcUrl);
  }, 30_000);

  afterAll(() => anvil?.stop());

  const policyFor = () =>
    compilePolicy(
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
      musd: "400"
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

  const executeCalldata = (dest: Address, data: Hex): Hex =>
    encodeFunctionData({ abi: ACCOUNT_ABI, functionName: 'execute', args: [dest, 0n, data] });

  const userOp = (innerData: Hex) => ({
    sender: account,
    callData: executeCalldata(token, innerData),
    nonce: 0n,
  });

  it('attributes decoded outflows to the smart account, not the EntryPoint', async () => {
    const transfer = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [BOB, 100_000_000n],
    });
    const req = userOpToTxRequest(userOp(transfer), { chainId, entryPoint: ENTRYPOINT });
    const effects = await sim.simulate(req);
    expect(effects).not.toBeNull();
    expect(effects!.reverted).toBe(false);
    expect(effects!.balanceDiffs).toContainEqual({
      address: account.toLowerCase(),
      token: token.toLowerCase(),
      delta: -100_000_000n,
    });
  });

  it('sends in-policy userOps, blocks the drain, enforces session caps on the account', async () => {
    let sent = 0;
    const bundler = {
      sendUserOperation: async () => {
        sent += 1;
        return ('0x' + 'ee'.repeat(32)) as Hex;
      },
    };
    const guarded = new SentinelUserOpSender(
      bundler,
      { chainId, entryPoint: ENTRYPOINT },
      policyFor(),
      sim,
      emptyIntel(),
      new RejectingEscalator()
    );

    const pay = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [BOB, 200_000_000n], // 200 mUSD, under the 250 per-tx cap
    });
    await guarded.sendUserOperation(userOp(pay));
    expect(sent).toBe(1);

    // Injected drain via the smart account: infinite approval → blocked.
    const drain = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [DRAINER, INFINITE_APPROVAL],
    });
    await expect(guarded.sendUserOperation(userOp(drain))).rejects.toThrow(SentinelBlockedError);
    expect(sent).toBe(1);

    // Session cap (400) counts the earlier 200: another 250 would breach it.
    const again = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [BOB, 250_000_000n],
    });
    await expect(guarded.sendUserOperation(userOp(again))).rejects.toThrow(SentinelBlockedError);
    expect(sent).toBe(1);
  });
});

describe('userOpToTxRequest', () => {
  it('models execution as EntryPoint → account with onBehalfOf attribution', () => {
    const req = userOpToTxRequest(
      { sender: BOB, callData: '0xdeadbeef' },
      { chainId: 8453, entryPoint: ENTRYPOINT }
    );
    expect(req.from).toBe(ENTRYPOINT);
    expect(req.to).toBe(BOB);
    expect(req.onBehalfOf).toBe(BOB);
    expect(req.data).toBe('0xdeadbeef');
  });

  it('fixture bytecode is available for the live-node suite', () => {
    expect(
      JSON.parse(readFileSync(new URL('./fixtures/mini-account.json', import.meta.url), 'utf8'))
        .bytecode
    ).toMatch(/^0x/);
  });
});
