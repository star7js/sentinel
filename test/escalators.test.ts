import { describe, it, expect, afterEach } from 'vitest';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import {
  WebhookEscalator,
  TelegramEscalator,
  escalationPayload,
} from '../src/signer/escalators.js';
import { SentinelSigner, RejectingEscalator } from '../src/signer/proxy.js';
import { NoopSimulator } from '../src/simulation/simulator.js';
import { compilePolicy } from '../src/policy/loader.js';
import { emptyIntel } from '../src/intel/blocklist.js';
import { readFileSync } from 'node:fs';
import { Address, Hex, TxRequest, Verdict } from '../src/types.js';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
const AGENT = '0x1111111111111111111111111111111111111111' as Address;

const tx: TxRequest = { chainId: 8453, from: AGENT, to: USDC, value: 5n, data: '0x' };
const verdict: Verdict = {
  decision: 'ESCALATE',
  reasons: [
    { ruleId: 'chain-allowed', decision: 'ALLOW', humanSummary: 'ok' },
    { ruleId: 'contract-allowlist', decision: 'ESCALATE', humanSummary: 'Unrecognized contract.' },
  ],
};

const servers: Server[] = [];
afterEach(() => {
  servers.splice(0).forEach((s) => s.close());
});

async function httpServer(
  handle: (req: IncomingMessage, body: string, res: ServerResponse) => void
): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handle(req, body, res));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

describe('escalationPayload', () => {
  it('is JSON-safe and carries only non-ALLOW reasons', () => {
    const payload = escalationPayload(tx, verdict);
    expect(payload.tx.value).toBe('5');
    expect(payload.verdict.reasons).toHaveLength(1);
    expect(payload.verdict.reasons[0].ruleId).toBe('contract-allowlist');
    expect(() => JSON.stringify(payload)).not.toThrow();
  });
});

describe('WebhookEscalator', () => {
  it('approves when the endpoint approves', async () => {
    let received: string | null = null;
    const url = await httpServer((_req, body, res) => {
      received = body;
      json(res, 200, { approved: true });
    });
    const ok = await new WebhookEscalator(url).requestApproval(tx, verdict);
    expect(ok).toBe(true);
    const parsed = JSON.parse(received!);
    expect(parsed.tx.from).toBe(AGENT);
    expect(parsed.verdict.reasons[0].humanSummary).toBe('Unrecognized contract.');
  });

  it('rejects when the endpoint rejects', async () => {
    const url = await httpServer((_req, _body, res) => json(res, 200, { approved: false }));
    expect(await new WebhookEscalator(url).requestApproval(tx, verdict)).toBe(false);
  });

  it.each([
    ['non-200 response', (res: ServerResponse) => json(res, 500, {})],
    ['malformed body', (res: ServerResponse) => { res.writeHead(200); res.end('not json'); }],
    ['missing approved field', (res: ServerResponse) => json(res, 200, { fine: true })],
  ])('rejects on %s (deny-safe)', async (_name, respond) => {
    const url = await httpServer((_req, _body, res) => respond(res));
    expect(await new WebhookEscalator(url).requestApproval(tx, verdict)).toBe(false);
  });

  it('rejects on timeout instead of hanging', async () => {
    const url = await httpServer(() => {
      /* never respond */
    });
    const escalator = new WebhookEscalator(url, { timeoutMs: 300 });
    expect(await escalator.requestApproval(tx, verdict)).toBe(false);
  });

  it('rejects when the endpoint is unreachable', async () => {
    const escalator = new WebhookEscalator('http://127.0.0.1:9', { timeoutMs: 500 });
    expect(await escalator.requestApproval(tx, verdict)).toBe(false);
  });

  it('end-to-end: an approved escalation signs, RejectingEscalator never does', async () => {
    const policy = compilePolicy(
      readFileSync(new URL('../policies/example.policy.yaml', import.meta.url), 'utf8'),
      { usdc: { address: USDC, decimals: 6 } }
    );
    const url = await httpServer((_req, _body, res) => json(res, 200, { approved: true }));
    let signed = 0;
    const inner = { signAndSend: async () => { signed += 1; return ('0x' + 'ab'.repeat(32)) as Hex; } };

    // NoopSimulator → simulation unavailable → ESCALATE → webhook approves → signs.
    const approving = new SentinelSigner(inner, policy, new NoopSimulator(), emptyIntel(), new WebhookEscalator(url));
    await approving.signAndSend(tx);
    expect(signed).toBe(1);

    const rejecting = new SentinelSigner(inner, policy, new NoopSimulator(), emptyIntel(), new RejectingEscalator());
    await expect(rejecting.signAndSend(tx)).rejects.toThrow();
    expect(signed).toBe(1);
  });
});

describe('TelegramEscalator', () => {
  const BOT = 'test-bot-token';

  /** Mock of the two Telegram Bot API methods the escalator uses. */
  async function telegramMock(decide: (requestId: string) => 'approve' | 'reject' | 'ignore') {
    let requestId: string | null = null;
    const url = await httpServer((req, body, res) => {
      if (req.url === `/bot${BOT}/sendMessage`) {
        const msg = JSON.parse(body);
        const data: string = msg.reply_markup.inline_keyboard[0][0].callback_data;
        requestId = data.split(':')[1];
        json(res, 200, { ok: true, result: { message_id: 1 } });
      } else if (req.url === `/bot${BOT}/getUpdates`) {
        const action = requestId ? decide(requestId) : 'ignore';
        json(res, 200, {
          ok: true,
          result:
            action === 'ignore'
              ? []
              : [{ update_id: 1, callback_query: { id: 'cb1', data: `${action}:${requestId}` } }],
        });
      } else if (req.url === `/bot${BOT}/answerCallbackQuery`) {
        json(res, 200, { ok: true, result: true });
      } else {
        json(res, 404, { ok: false, description: 'unknown method' });
      }
    });
    return url;
  }

  const escalator = (apiBase: string, timeoutMs = 5000) =>
    new TelegramEscalator({ botToken: BOT, chatId: 42, apiBase, timeoutMs });

  it('approves on an Approve tap', async () => {
    const url = await telegramMock(() => 'approve');
    expect(await escalator(url).requestApproval(tx, verdict)).toBe(true);
  });

  it('rejects on a Reject tap', async () => {
    const url = await telegramMock(() => 'reject');
    expect(await escalator(url).requestApproval(tx, verdict)).toBe(false);
  });

  it('rejects on timeout when nobody responds', async () => {
    const url = await telegramMock(() => 'ignore');
    expect(await escalator(url, 700).requestApproval(tx, verdict)).toBe(false);
  });

  it('rejects when the API is unreachable (deny-safe)', async () => {
    const dead = new TelegramEscalator({
      botToken: BOT,
      chatId: 42,
      apiBase: 'http://127.0.0.1:9',
      timeoutMs: 500,
    });
    expect(await dead.requestApproval(tx, verdict)).toBe(false);
  });
});
