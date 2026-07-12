# Security Policy

Sentinel guards funds. If you find a way to make it sign something it should
not, we want to know before anyone else does.

## Reporting a vulnerability

Report privately via **GitHub Security Advisories**
(https://github.com/star7js/sentinel/security/advisories/new). Do not open a
public issue for anything that could be exploited. You should hear back within
72 hours; fixes for confirmed bypasses take priority over all other work.

In scope, in rough order of severity:

1. Any path where a policy-violating transaction or signature is **signed**
   (a failure mode that degrades to ALLOW) — this violates the project's core
   invariant and is always critical
2. Effect-decoding gaps: transactions/typed data whose real effect differs
   from what the simulator or decoder reports
3. Session-accounting bypasses (cap resets, state corruption)
4. Escalation-channel spoofing (forged approvals)

Denial-of-service against the *agent* (making Sentinel block valid
transactions) is deliberately lower severity: the system is designed to fail
closed.

## Operational guidance for deployers

Sentinel bounds an agent's blast radius; it does not make a hot key cold.

- **Use a dedicated agent wallet** holding only what the session caps assume.
  `SENTINEL_PRIVATE_KEY` is a hot key — treat the wallet as expendable.
- **Run your own fork node.** The simulator trusts the node it talks to; a
  malicious RPC can lie about effects. `anvil --fork-url <your-rpc>` on
  localhost, and restart/`anvil_reset` it periodically so state doesn't go
  stale.
- **Keep `onSimulationFailure`, `unknownContract`, and `contractCreation` at
  `escalate` or `block`.** Every "can't verify" path routes through them.
- **Do not expose `personal_sign`/`eth_sign` to agents at all.** Sentinel
  guards transactions and EIP-712 typed data; raw message signing is
  unguardable by design.
- **Persist session state** (`SENTINEL_STATE_FILE` / `JsonFileStore`) so a
  process crash cannot reset spend caps.

## Known residual risks

Documented honestly in [docs/SPEC.md §9](docs/SPEC.md); summary: simulation is
a point-in-time prediction (TOCTOU), ERC-20 transfer *recipients* are bounded
by spend caps rather than allowlisted, and threat feeds are additive, not
exhaustive.
