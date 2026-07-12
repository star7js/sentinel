import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Address, SessionState } from '../types.js';

/**
 * Pluggable session-state persistence (SPEC §5). Without it, a process
 * restart silently resets session spend caps — an attacker who can crash the
 * agent gets fresh limits. Stores are synchronous on purpose: state is tiny,
 * and a simple contract keeps adapters trivial to audit.
 */
export interface SessionStore {
  /** Return the persisted state, or null if none exists yet. */
  load(): SessionState | null;
  save(state: SessionState): void;
}

/** Default store: state lives and dies with the process. */
export class MemoryStore implements SessionStore {
  private state: SessionState | null = null;
  load(): SessionState | null {
    return this.state;
  }
  save(state: SessionState): void {
    this.state = state;
  }
}

interface SerializedState {
  sessionStart: number;
  spentBySession: string;
  spentByToken: Record<string, string>;
  txCount: number;
}

/**
 * JSON file adapter. Writes atomically (temp file + rename) so a crash
 * mid-write can't truncate the state. A corrupt or unreadable existing file
 * throws at load time — refusing to start beats silently starting a fresh
 * session with reset caps.
 */
export class JsonFileStore implements SessionStore {
  constructor(private path: string) {}

  load(): SessionState | null {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const raw = JSON.parse(text) as SerializedState;
    if (
      typeof raw.sessionStart !== 'number' ||
      typeof raw.spentBySession !== 'string' ||
      typeof raw.txCount !== 'number' ||
      typeof raw.spentByToken !== 'object' ||
      raw.spentByToken === null
    ) {
      throw new Error(`Session state file ${this.path} is malformed; refusing to start.`);
    }
    return {
      sessionStart: raw.sessionStart,
      spentBySession: BigInt(raw.spentBySession),
      spentByToken: new Map(
        Object.entries(raw.spentByToken).map(([k, v]) => [k as Address, BigInt(v)])
      ),
      txCount: raw.txCount,
    };
  }

  save(state: SessionState): void {
    const serialized: SerializedState = {
      sessionStart: state.sessionStart,
      spentBySession: state.spentBySession.toString(),
      spentByToken: Object.fromEntries(
        [...state.spentByToken].map(([k, v]) => [k, v.toString()])
      ),
      txCount: state.txCount,
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(serialized));
    renameSync(tmp, this.path);
  }
}
