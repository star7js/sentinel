import { spawn } from 'node:child_process';
import {
  Address,
  ApprovalEffect,
  BalanceDiff,
  DelegationEffect,
  Hex,
  OperatorApprovalEffect,
  SimulatedEffects,
  TxRequest,
} from '../types.js';
import { Simulator } from './simulator.js';

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** keccak256("Approval(address,address,uint256)") */
const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
/** keccak256("ApprovalForAll(address,address,bool)") */
const APPROVAL_FOR_ALL_TOPIC = '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31';
/** EIP-7702: code of a delegated EOA is 0xef0100 ++ delegate address */
const DELEGATION_PREFIX = '0xef0100';

const lc = (a: string) => a.toLowerCase();
const toHex = (n: bigint) => `0x${n.toString(16)}` as Hex;
const topicToAddress = (t: Hex): Address => `0x${t.slice(26)}` as Address;

interface RpcLog {
  address: Address;
  topics: Hex[];
  data: Hex;
}

interface RpcReceipt {
  status: Hex;
  gasUsed: Hex;
  effectiveGasPrice?: Hex;
  logs: RpcLog[];
}

interface CallFrame {
  to?: Address;
  calls?: CallFrame[];
}

export interface AnvilSimulatorOptions {
  /** Per-RPC-call timeout in milliseconds. Default 10s. */
  timeoutMs?: number;
}

/**
 * Simulates transactions against a local fork node and decodes their actual
 * effects (SPEC §2). Built for `anvil --fork-url <rpc>` but speaks only the
 * hardhat-compatible test RPC surface (evm_snapshot/revert,
 * hardhat_impersonateAccount, eth_sendTransaction), so a Hardhat node works
 * too.
 *
 * Decoding:
 *  - balanceDiffs: native from pre/post eth_getBalance (gas cost excluded so
 *    caps measure value moved, not fees); ERC-20 from Transfer logs
 *  - approvals:    Approval(address,address,uint256) logs
 *  - delegations:  EIP-7702 code changes (0xef0100 ++ delegate) on `from` and
 *    any authorization authorities
 *  - contractsTouched: call tree via debug_traceTransaction(callTracer),
 *    falling back to `to` + log emitters if tracing is unavailable
 *
 * Every failure path returns null — never fabricated effects — so the
 * engine's onSimulationFailure default applies (deny-safe). The node's chain
 * id must match tx.chainId or the simulation is treated as unavailable:
 * effects observed on the wrong chain are worse than none.
 *
 * Simulations are serialized internally: snapshot/revert is global node
 * state, so concurrent runs against one node would corrupt each other.
 */
export class AnvilSimulator implements Simulator {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private rpcUrl: string,
    private opts: AnvilSimulatorOptions = {}
  ) {}

  simulate(tx: TxRequest): Promise<SimulatedEffects | null> {
    const run = this.queue.then(() => this.simulateExclusive(tx));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async simulateExclusive(tx: TxRequest): Promise<SimulatedEffects | null> {
    let snapshot: Hex | null = null;
    try {
      const nodeChainId = Number(await this.rpc<Hex>('eth_chainId', []));
      if (nodeChainId !== tx.chainId) return null;

      snapshot = await this.rpc<Hex>('evm_snapshot', []);

      const from = lc(tx.from) as Address;
      const authorities = [
        ...new Set([from, ...(tx.authorizationList ?? []).map((a) => lc(a.address) as Address)]),
      ];
      const preNative = BigInt(await this.rpc<Hex>('eth_getBalance', [from, 'latest']));
      const preCode = new Map<Address, string>();
      for (const a of authorities) {
        preCode.set(a, lc(await this.rpc<Hex>('eth_getCode', [a, 'latest'])));
      }

      await this.rpc('hardhat_impersonateAccount', [from]);
      let hash: Hex;
      let receipt: RpcReceipt;
      try {
        hash = await this.rpc<Hex>('eth_sendTransaction', [
          {
            from,
            to: tx.to ?? undefined,
            value: toHex(tx.value),
            data: tx.data,
            // Explicit gas skips estimation, so a reverting tx is mined with
            // status 0 instead of being rejected up front. 15M sits under
            // hardhat's 2^24 tx gas cap and anvil's 30M block limit.
            gas: '0xe4e1c0',
          },
        ]);
        receipt = await this.waitForReceipt(hash);
      } catch (err) {
        // Some nodes reject reverting transactions at send time instead of
        // mining them with status 0. That is still a definitive revert.
        if (isRevertError(err)) {
          return {
            balanceDiffs: [],
            approvals: [],
            approvalsForAll: [],
            delegations: [],
            contractsTouched: tx.to ? [tx.to] : [],
            reverted: true,
          };
        }
        throw err;
      } finally {
        await this.rpc('hardhat_stopImpersonatingAccount', [from]).catch(() => undefined);
      }

      const balanceDiffs: BalanceDiff[] = [];
      const postNative = BigInt(await this.rpc<Hex>('eth_getBalance', [from, 'latest']));
      const gasCost =
        BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? '0x0');
      const nativeDelta = postNative - preNative + gasCost;
      if (nativeDelta !== 0n) {
        balanceDiffs.push({ address: from, token: 'native', delta: nativeDelta });
      }

      const approvals: ApprovalEffect[] = [];
      const approvalsForAll: OperatorApprovalEffect[] = [];
      const tokenDiffs = new Map<string, bigint>();
      const bump = (holder: Address, token: Address, delta: bigint) => {
        const key = `${lc(holder)}|${lc(token)}`;
        tokenDiffs.set(key, (tokenDiffs.get(key) ?? 0n) + delta);
      };
      for (const log of receipt.logs) {
        if (log.topics[0] === TRANSFER_TOPIC && log.topics.length === 3) {
          const value = BigInt(log.data);
          bump(topicToAddress(log.topics[1]), log.address, -value);
          bump(topicToAddress(log.topics[2]), log.address, value);
        } else if (log.topics[0] === APPROVAL_TOPIC && log.topics.length === 3) {
          approvals.push({
            token: lc(log.address) as Address,
            spender: topicToAddress(log.topics[2]),
            amount: BigInt(log.data),
          });
        } else if (log.topics[0] === APPROVAL_FOR_ALL_TOPIC && log.topics.length === 3) {
          approvalsForAll.push({
            token: lc(log.address) as Address,
            operator: topicToAddress(log.topics[2]),
            approved: BigInt(log.data) !== 0n,
          });
        }
      }
      for (const [key, delta] of tokenDiffs) {
        if (delta === 0n) continue;
        const [holder, token] = key.split('|');
        balanceDiffs.push({ address: holder as Address, token: token as Address, delta });
      }

      const delegations: DelegationEffect[] = [];
      for (const a of authorities) {
        const post = lc(await this.rpc<Hex>('eth_getCode', [a, 'latest']));
        if (post !== preCode.get(a) && post.startsWith(DELEGATION_PREFIX)) {
          delegations.push({ authority: a, delegate: `0x${post.slice(8, 48)}` as Address });
        }
      }

      return {
        balanceDiffs,
        approvals,
        approvalsForAll,
        delegations,
        contractsTouched: await this.touchedContracts(hash, tx, receipt),
        reverted: receipt.status === '0x0',
      };
    } catch {
      return null;
    } finally {
      if (snapshot !== null) {
        await this.rpc('evm_revert', [snapshot]).catch(() => undefined);
      }
    }
  }

  private async touchedContracts(
    hash: Hex,
    tx: TxRequest,
    receipt: RpcReceipt
  ): Promise<Address[]> {
    try {
      const trace = await this.rpc<CallFrame>('debug_traceTransaction', [
        hash,
        { tracer: 'callTracer' },
      ]);
      const touched = new Set<string>();
      const walk = (frame: CallFrame) => {
        if (frame.to) touched.add(lc(frame.to));
        frame.calls?.forEach(walk);
      };
      walk(trace);
      touched.delete(lc(tx.from));
      return [...touched] as Address[];
    } catch {
      const touched = new Set<string>(receipt.logs.map((l) => lc(l.address)));
      if (tx.to) touched.add(lc(tx.to));
      return [...touched] as Address[];
    }
  }

  private async waitForReceipt(hash: Hex): Promise<RpcReceipt> {
    const deadline = Date.now() + (this.opts.timeoutMs ?? 10_000);
    while (Date.now() < deadline) {
      const receipt = await this.rpc<RpcReceipt | null>('eth_getTransactionReceipt', [hash]);
      if (receipt) return receipt;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`No receipt for ${hash} within timeout`);
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
    return body.result as T;
  }
}

function isRevertError(err: unknown): boolean {
  return err instanceof Error && /revert/i.test(err.message);
}

export interface StartAnvilOptions {
  /** Upstream RPC to fork. Omit for a blank dev chain. */
  forkUrl?: string;
  chainId?: number;
  port?: number;
  /** Path to the anvil binary. Default: "anvil" on PATH. */
  binary?: string;
}

export interface AnvilHandle {
  rpcUrl: string;
  stop(): void;
}

/**
 * Spawn a local anvil node and wait until it answers RPC. Convenience for
 * dev/test setups; in production you likely run `anvil --fork-url ...` as its
 * own supervised process and pass the URL to AnvilSimulator directly.
 */
export async function startAnvil(opts: StartAnvilOptions = {}): Promise<AnvilHandle> {
  const port = opts.port ?? 8545;
  const args = ['--port', String(port), '--silent'];
  if (opts.forkUrl) args.push('--fork-url', opts.forkUrl);
  if (opts.chainId !== undefined) args.push('--chain-id', String(opts.chainId));

  const proc = spawn(opts.binary ?? 'anvil', args, { stdio: 'ignore' });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const stop = () => {
    proc.kill();
  };

  const failed = new Promise<never>((_, reject) => {
    proc.on('error', (err) => reject(new Error(`Failed to start anvil: ${err.message}`)));
    proc.on('exit', (code) => reject(new Error(`anvil exited early with code ${code}`)));
  });

  const ready = (async () => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('anvil did not become ready within 15s');
  })();

  try {
    await Promise.race([ready, failed]);
  } catch (err) {
    stop();
    throw err;
  }
  proc.removeAllListeners('exit');
  return { rpcUrl, stop };
}
