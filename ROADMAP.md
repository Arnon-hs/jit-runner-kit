# Roadmap

This roadmap describes direction, not delivery promises.

## Before the first public release

- [ ] Complete a real Hetzner end-to-end pilot with a non-production repository.
- [ ] Verify cancellation, failed provisioning, failed workload, and TTL cleanup paths.
- [ ] Publish immutable action tags and release notes.
- [ ] Enable private vulnerability reporting and branch protection.
- [ ] Add an operator service example and log-retention guidance.

## Near term

- [ ] Replace polling with an optional authenticated `workflow_job` webhook path.
- [ ] Add structured controller metrics and health output.
- [ ] Add controller locking for safe restart and multi-process operation.
- [ ] Define and test the provider-driver contract.

## Later, if demand is demonstrated

- [ ] Add a second cloud provider driver.
- [ ] Support organization-level JIT runners and runner groups.
- [ ] Add ARM examples and compatibility guidance.

Ideas should start in GitHub Discussions or an issue. Scope decisions follow [VISION.md](VISION.md).
