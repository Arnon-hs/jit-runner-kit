# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from its first public tag.

## [Unreleased]

## [0.2.0] - 2026-08-25

### Added

- A provider-agnostic TypeScript controller core with explicit job, lease, compute, runner, bootstrap, clock, and telemetry ports.
- A Cloudflare Workers adapter using verified GitHub App webhooks, Queues with retry/DLQ configuration, a SQLite Durable Object, alarms, and Cron reconciliation.
- A direct Hetzner Cloud API compute adapter that creates deny-inbound, SSH-free VMs and labels servers, Primary IPv4s, and firewalls for independent TTL cleanup.
- A one-time bootstrap exchange that stores only the token digest, binds issuance to the VM public IPv4, and never persists JIT configuration.
- Local conformance tests and a Wrangler dry-run build gate for the serverless packages.
- An offline fail-closed Cloudflare deployment preflight and a least-privilege GitHub App manifest template.

### Changed

- New Cloudflare deployments use declarative SQLite Durable Object `exports` instead of the legacy migrations array.

### Security

- Serverless queued jobs require an authenticated webhook, repository allowlist, trusted branch, trigger label, and no pull-request association.
- Serverless jobs require a private organization runner group restricted to the exact configured workflow definitions; run-scoped labels remain defense in depth rather than a claimed job binding.
- GitHub App installation tokens are scoped to the webhook repository, while Worker secrets keep App and Hetzner credentials out of durable state.
- Bootstrap consumption is an atomic state transition, expired bootstrap tokens fail closed, provisioning is single-flight, and cleanup continues across independent resource failures.
- Initial job claims cannot release another delivery's lease, compute-delete failures retain capacity, and ambiguous Hetzner creates are reconciled against a bootstrap-token digest before adoption.
- Runner-group policy is revalidated immediately before JIT issuance, transport-level ambiguous creates enter recovery, and stale provisioning claims are retried on a shorter deadline.
- Cleanup extends capacity before external deletion, and monotonic provider attempt fences prevent slow stale calls from deleting a newer VM.

## [0.1.0] - 2026-08-25

### Added

- GitHub Actions provision and destroy actions for one-job ephemeral runners.
- A compatibility polling controller with repository allowlists and bounded concurrency.
- Hetzner Cloud provisioning through OpenTofu or Terraform.
- Independent TTL sweeping, recovery cleanup, and managed-resource inventory.
- Bounded retries across ordered Hetzner location fallbacks when a zone has temporary capacity pressure.
- Real-cloud success, failed-workload, and cancellation cleanup canaries.
- Custom runner image guidance for packages, shells, language runtimes, and prebuilt images.
- An accepted provider-agnostic serverless architecture with Cloudflare as the first controller adapter and Hetzner as the first compute adapter.
- OSS governance, security, contribution, support, and maintenance documentation.

### Security

- JIT configuration is delivered over SSH after provisioning and is excluded from cloud-init, infrastructure state, and workflow artifacts.
- Per-run ownership labels, rollback-safe provisioning, runner-record deletion, and two-path cleanup limit orphaned resources.
- Official GitHub runner archives are verified against their published SHA-256 digest.

[Unreleased]: https://github.com/Arnon-hs/jit-runner-kit/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Arnon-hs/jit-runner-kit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Arnon-hs/jit-runner-kit/releases/tag/v0.1.0
