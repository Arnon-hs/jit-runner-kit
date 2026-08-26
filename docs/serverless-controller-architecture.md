# Serverless controller architecture

Status: released for pre-1.0 production pilots in v0.3.1. Local conformance, offline deployment preflight, Worker bundle validation, and real-cloud lifecycle gates are complete; each installation still requires its own canary evidence.

JIT Runner Kit keeps lifecycle policy in a provider-agnostic core and puts deployment details behind adapters. Cloudflare is the first implemented controller platform and Hetzner Cloud is the first compute provider. Neither is part of the core contract.

## Invariants

- The recommended compute adapter creates at most one burst host per pool ID; each workflow job receives one disposable runner/DinD pair and one JIT registration.
- Only authenticated, allowlisted `workflow_job` events from trusted repositories can create compute.
- Repository scope binds the private App installation to selected repositories and revalidates the exact trusted run/job; organization scope additionally requires a private runner group restricted to exact trusted workflows. A run-scoped label is routing defense in depth, not a job binding.
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

The first compute adapter uses the Hetzner Cloud API. It owns Hetzner request/response translation and labels every resource with stable ownership, job, controller, repository, and expiry identifiers. Serverless VMs have a deny-inbound firewall and no usable SSH credential. The elastic pool briefly registers a public-only key during server creation to prevent provider root-password email, deletes the provider key object immediately, retains no private key, and disables SSH in cloud-init.

## Serverless lifecycle

```text
workflow_job: queued
  -> verify signature, installation, repository, event, branch, static label, run-scoped label
  -> verify repository-scoped App access and exact run/job metadata
  -> in organization scope, verify the private exact-workflow runner group
  -> create or load idempotent job record
  -> acquire concurrency lease
  -> create or reuse one labeled pool host with a source-bound enrollment token
  -> host enrolls once, then atomically claims waiting jobs
  -> controller requests JIT config and returns it once
  -> pool host executes at most two jobs in disposable runner/DinD pairs

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

The current Bash/OpenTofu GitHub control-job mode remains supported as a compatibility fallback. The Cloudflare adapter is suitable for a controlled production pilot after operators complete the checklist in [Deploy the Cloudflare controller](cloudflare-controller.md), including success, failure, cancellation, concurrent two-job isolation, DLQ, idle release, and TTL cleanup evidence with a final empty Hetzner inventory. The application workflow migration is covered by [Production cutover](production-cutover.md).
