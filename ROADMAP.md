# Roadmap

This roadmap describes direction, not delivery promises.

## Before the first public release

- [x] Complete a real Hetzner end-to-end pilot with a non-production repository.
- [x] Verify successful execution, failed provisioning rollback, explicit recovery cleanup, and TTL cleanup mechanics.
- [x] Verify cancellation and failed-workload paths in real cloud canaries.
- [x] Publish immutable action tags and release notes.
- [x] Enable private vulnerability reporting and branch protection.
- [x] Add an operator service example and log-retention guidance.

## Near term

- [x] Implement the provider-agnostic controller core and its state-machine contract.
- [x] Add the first controller adapter: Cloudflare Workers, GitHub App/webhooks, Queues, Durable Objects, and Cron.
- [x] Add the first compute adapter: Hetzner Cloud API.
- [x] Add secure organization-level JIT runners with exact workflow-restricted runner-group verification.
- [x] Use one-time bootstrap tokens so serverless mode needs no SSH or local OpenTofu state.
- [x] Add structured controller events and health output.
- [x] Publish offline-validated Wrangler, GitHub App, Queue/DLQ, Durable Object, Cron, and configuration preflight templates.
- [x] Complete live-cloud conformance canaries for Queue retry/DLQ, Durable Object recovery, GitHub App bootstrap, success, failure, cancellation, two-container isolation, idle release, and TTL cleanup with an empty final provider inventory.
- [ ] Publish a reusable, secret-free conformance harness that operators can run in their own dedicated canary repository and cloud project.

## Later, if demand is demonstrated

- [ ] Add a second controller adapter, such as Cloud Run, AWS Lambda, or a normal webhook service.
- [ ] Add a second compute adapter.
- [ ] Add ARM examples and compatibility guidance.

Ideas should start in GitHub Discussions or an issue. Scope decisions follow [VISION.md](VISION.md).
