# Serverless controller architecture

Status: released in v0.2.0 for controlled canaries; local conformance, offline deployment preflight, and Worker bundle validation are complete, while live-cloud canaries remain required before production use.

JIT Runner Kit keeps lifecycle policy in a provider-agnostic core and puts deployment details behind adapters. Cloudflare is the first implemented controller platform and Hetzner Cloud is the first compute provider. Neither is part of the core contract.

## Invariants

- One workflow job receives one VM and one JIT registration.
- Only authenticated, allowlisted `workflow_job` events from trusted repositories can create compute.
- Serverless runners belong to a private organization runner group restricted to exact trusted workflow definitions; a run-scoped label adds routing defense in depth but is not a job binding.
- Event delivery is at-least-once; every transition and provider operation must therefore be idempotent.
- Provisioning claims have a shorter recovery deadline than the job TTL so a Worker crash cannot strand a queued job indefinitely.
- Provider resources carry a monotonic attempt fence so interleaved stale calls cannot delete a newer winner.
- A global or tenant concurrency lease is acquired before compute creation.
- JIT configuration and bootstrap credentials are never durable state.
- A completed event requests cleanup, while a provider-label TTL sweep independently guarantees eventual cleanup.
- The GitHub control-job mode remains a compatible adapter and migration fallback.

## Core responsibilities

The core owns:

- the `workflow_job` event model and trust decision;
- the job, lease, server, and runner state machines;
- idempotency keys and replay handling;
- retry classification, exponential backoff, and terminal failure policy;
- concurrency limits and lease expiry;
- JIT runner creation, observation, and deletion lifecycle;
- TTL cleanup decisions;
- typed configuration and secret references.

The core does not import Cloudflare bindings, GitHub webhook framework types, OpenTofu state, or Hetzner API response models.

## Ports

Adapters implement narrow ports. Names are illustrative; the released API may refine them without changing the boundary.

```text
EventVerifier       verify(rawRequest) -> TrustedWorkflowJobEvent
JobStore            load/create/compareAndSet(jobId, state)
LeaseStore          acquire/renew/release(scope, limit, ttl)
TaskQueue           enqueue(task, notBefore, idempotencyKey)
RunnerControl       createJitConfig/deleteRunner/getRunner
ComputeProvider     create/get/delete/listExpired
BootstrapBroker     mint/consume(oneTimeToken)
SecretProvider      resolve(secretReference)
Clock               now/schedule
Telemetry           event/metric/error
```

Provider adapters translate their native errors into core error classes such as retryable, rate-limited, conflict/already-exists, not-found, and terminal-authentication failure.

## First adapters

The first serverless controller adapter is implemented for Cloudflare:

- Workers receive GitHub App webhooks and expose the one-time bootstrap exchange.
- Queues isolate webhook acknowledgement from provisioning and cleanup work.
- Durable Objects provide atomic job transitions and concurrency leases.
- Cron triggers reconciliation and TTL cleanup.
- encrypted Worker secrets hold installation credentials and provider tokens.

The first compute adapter uses the Hetzner Cloud API. It owns Hetzner request/response translation and labels every resource with stable ownership, job, controller, repository, and expiry identifiers. Serverless VMs have a deny-inbound firewall and no SSH key.

## Serverless lifecycle

```text
workflow_job: queued
  -> verify signature, installation, repository, event, branch, static label, run-scoped label
  -> verify the organization runner group's private, exact-workflow policy
  -> create or load idempotent job record
  -> acquire concurrency lease
  -> create labeled VM with a one-time bootstrap token
  -> VM exchanges the unexpired token after attestation checks and an atomic state claim
  -> controller requests JIT config and returns it once
  -> runner executes exactly one job

workflow_job: completed
  -> transition to cleaning
  -> extend the capacity lease before awaiting external deletion
  -> delete runner record and compute resources
  -> release lease
  -> transition to completed

Cron reconciliation
  -> reclaim stale provisioning attempts
  -> attempt every expired job cleanup without global short-circuit
  -> list expired provider labels even after an individual cleanup failure
  -> remove orphaned runner and compute resources
  -> expire abandoned leases
  -> prune old terminal controller records
```

Serverless mode does not require a Mac mini, permanent controller VPS, inbound SSH, or local OpenTofu state. The VM gets only a one-time bootstrap token. JIT configuration is issued only after successful token consumption and is not stored after the response.

## Package boundaries

The package layout makes adapters additive:

```text
packages/
  core/
  contracts/
  adapter-github-control-jobs/
  adapter-controller-cloudflare/
  adapter-compute-hetzner/
  adapter-github-app/
  crypto/
```

Future Cloud Run, AWS Lambda, conventional webhook-service, or compute-provider adapters implement the same contracts. Adding one must not require a fork or provider conditionals in the core.

## Delivery boundary

The current Bash/OpenTofu GitHub control-job mode remains supported. The Cloudflare adapter is ready for a dedicated-project canary, not an unqualified production rollout. Operators must complete the checklist in [Deploy the Cloudflare controller](cloudflare-controller.md), including success, failure, cancellation, DLQ, and TTL cleanup evidence with a final empty Hetzner inventory.
