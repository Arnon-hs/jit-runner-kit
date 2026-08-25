# Vision and scope

## Vision

Make short-lived, one-job GitHub Actions runners understandable and affordable for small teams and open-source maintainers without coupling their workflows to a specific application stack.

## In scope

- Ephemeral GitHub JIT runner registration.
- Provider drivers for temporary compute and narrow network access.
- Safe state ownership, cleanup, and TTL recovery.
- Provider-agnostic controller state and lifecycle logic.
- Pluggable controller and compute adapters, including a GitHub control-job fallback.
- A small controller that can run outside GitHub-hosted infrastructure.
- Copyable examples and observable failure states.

## Out of scope

- Application build or deployment logic.
- A hosted multi-tenant runner service.
- Long-lived or shared runners.
- Production network access by default.
- Replacing GitHub Actions as a scheduler.
- Hiding cloud costs or security trade-offs behind "zero cost" claims.

## Decision rules

Changes should preserve the one-job isolation model, keep cleanup independently recoverable, avoid storing JIT configuration in durable state, and remain useful outside any one consumer repository. Core packages must not import provider bindings or provider-specific HTTP models. Features that materially increase operator privilege or maintenance burden require a public design discussion first.
