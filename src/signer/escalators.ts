import { randomUUID } from 'node:crypto';
import { TxRequest, Verdict } from '../types.js';
import { Escalator } from './proxy.js';

/**
 * M3: human escalation channels.
 *
 * Escalators present an ESCALATE verdict to a human and resolve to a
 * decision. The contract is deny-safe by construction: any transport error,
 * malformed response, or timeout resolves to false (reject) — SPEC §6's
 * "escalation channel unreachable → onTimeout behavior applies".
 */

/** Everything a human needs to decide, JSON-safe (bigints as strings). */
export function escalationPayload(tx: TxRequest, verdict: Verdict) {
  return {
    tx: {
      chainId: tx.chainId,
      from: tx.from,
      to: tx.to,
      value: tx.value.toString(),
      data: tx.data,
    },
    verdict: {
      decision: verdict.decision,
      reasons: verdict.reasons.filter((r) => r.decision !== 'ALLOW'),
    },
  };
}

/** Plain-language summary used for human-facing messages. */
export function escalationText(tx: TxRequest, verdict: Verdict): string {
  const lines = [
    '🛡 Sentinel: transaction needs approval',
    `chain ${tx.chainId} · from ${tx.from} → ${tx.to ?? '(contract creation)'}`,
    `value: ${tx.value.toString()} wei`,
    '',
    ...verdict.reasons
      .filter((r) => r.decision !== 'ALLOW')
      .map((r) => `• [${r.ruleId}] ${r.humanSummary}`),
  ];
  return lines.join('\n');
}

export interface WebhookEscalatorOptions {
  /** How long to wait for the endpoint's decision. Default 300s (SPEC example). */
  timeoutMs?: number;
  /** Extra headers, e.g. an Authorization token for your approval service. */
  headers?: Record<string, string>;
}

/**
 * POSTs the escalation payload to your endpoint and expects
 * `{ "approved": true | false }` back. Anything else — non-200, malformed
 * body, network error, timeout — rejects the transaction.
 */
export class WebhookEscalator implements Escalator {
  constructor(
    private url: string,
    private opts: WebhookEscalatorOptions = {}
  ) {}

  async requestApproval(tx: TxRequest, verdict: Verdict): Promise<boolean> {
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.opts.headers },
        body: JSON.stringify({ id: randomUUID(), ...escalationPayload(tx, verdict) }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 300_000),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { approved?: unknown };
      return body.approved === true;
    } catch {
      return false;
    }
  }
}

export interface TelegramEscalatorOptions {
  botToken: string;
  /** Chat to send approval requests to (user or group id). */
  chatId: string | number;
  /** How long to wait for a human tap. Default 300s. */
  timeoutMs?: number;
  /** Override for tests / self-hosted bot API. Default https://api.telegram.org */
  apiBase?: string;
}

/**
 * Sends the escalation summary to a Telegram chat with Approve/Reject
 * buttons and long-polls getUpdates for the tap. Timeout or any API error
 * rejects. Note: run one poller per bot token — Telegram allows only one
 * getUpdates consumer.
 */
export class TelegramEscalator implements Escalator {
  private apiBase: string;

  constructor(private opts: TelegramEscalatorOptions) {
    this.apiBase = opts.apiBase ?? 'https://api.telegram.org';
  }

  private api(method: string): string {
    return `${this.apiBase}/bot${this.opts.botToken}/${method}`;
  }

  private async call<T>(method: string, payload: object, timeoutMs: number): Promise<T> {
    const res = await fetch(this.api(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!body.ok) throw new Error(`Telegram ${method}: ${body.description ?? 'unknown error'}`);
    return body.result as T;
  }

  async requestApproval(tx: TxRequest, verdict: Verdict): Promise<boolean> {
    const requestId = randomUUID();
    const deadline = Date.now() + (this.opts.timeoutMs ?? 300_000);

    try {
      await this.call(
        'sendMessage',
        {
          chat_id: this.opts.chatId,
          text: escalationText(tx, verdict),
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Approve', callback_data: `approve:${requestId}` },
                { text: '❌ Reject', callback_data: `reject:${requestId}` },
              ],
            ],
          },
        },
        30_000
      );

      let offset = 0;
      while (Date.now() < deadline) {
        const pollSeconds = Math.min(25, Math.ceil((deadline - Date.now()) / 1000));
        if (pollSeconds <= 0) break;
        const updates = await this.call<
          { update_id: number; callback_query?: { id: string; data?: string } }[]
        >(
          'getUpdates',
          { offset, timeout: pollSeconds, allowed_updates: ['callback_query'] },
          (pollSeconds + 10) * 1000
        );
        for (const update of updates) {
          offset = update.update_id + 1;
          const data = update.callback_query?.data;
          if (data === `approve:${requestId}` || data === `reject:${requestId}`) {
            await this.call(
              'answerCallbackQuery',
              { callback_query_id: update.callback_query!.id },
              10_000
            ).catch(() => undefined);
            return data.startsWith('approve:');
          }
        }
      }
      return false; // timed out: deny
    } catch {
      return false; // channel unreachable: deny
    }
  }
}
