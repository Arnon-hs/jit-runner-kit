# Deploy the Cloudflare controller

Status: controlled canary. The Worker compiles and the provider-agnostic lifecycle, trust, cryptography, and Hetzner adapter have local conformance coverage. Complete the live-cloud gates below before using it for production releases.

## What this adapter owns

```text
GitHub workflow_job webhook
  -> signature + allowlist + branch + static label + run-scoped label + non-PR trust gate
  -> Cloudflare Queue
  -> singleton SQLite Durable Object (job CAS + global leases)
  -> Hetzner API (deny-inbound VM, no SSH)
  -> one-time bootstrap exchange
  -> GitHub App JIT configuration
  -> one job
  -> completed event cleanup

Durable Object alarm + Cron
  -> job TTL reconciliation
  -> provider-label orphan sweep
```

GitHub remains the workflow scheduler. Cloudflare becomes the JIT lifecycle controller. Hetzner supplies temporary compute. The target application platform is not part of this repository.

## Prerequisites

- A Cloudflare account with Workers, Queues, Durable Objects, and Cron Triggers available.
- A dedicated Hetzner Cloud project and read/write API token.
- A GitHub App installed only on repositories the controller may serve.
- Node.js 22 and npm.

Create the GitHub App with:

- Webhook event: **Workflow jobs** only.
- Repository permissions: **Actions: read**, **Administration: read and write**, **Metadata: read**.
- Webhook URL: `https://YOUR_CONTROLLER/webhooks/github`.
- A random webhook secret.

Do not enable the controller for public-fork or pull-request jobs. This implementation rejects every queued job with a non-empty `pull_requests` array.

## Configure Cloudflare

Install exact development dependencies and create the queues once:

```bash
npm ci
npx wrangler queues create jit-runner-kit-tasks
npx wrangler queues create jit-runner-kit-tasks-dlq
```

Edit `packages/adapter-controller-cloudflare/wrangler.jsonc`:

- set `ALLOWED_REPOSITORIES` to a comma-separated `owner/repository` allowlist;
- set `TRUSTED_BRANCHES` to explicit branch names;
- keep `RUN_LABEL_PREFIX` non-empty and route jobs with `jit-run-${{ github.run_id }}`;
- keep `MAX_RUNNERS` at `1` for the first canary, then at most `2` initially;
- set `PUBLIC_BASE_URL` to the final HTTPS Worker or custom-domain origin;
- select a Hetzner server type, location, image, architecture, and TTL.

Store credentials only as encrypted Worker secrets:

```bash
npx wrangler secret put GITHUB_WEBHOOK_SECRET --config packages/adapter-controller-cloudflare/wrangler.jsonc
npx wrangler secret put GITHUB_APP_ID --config packages/adapter-controller-cloudflare/wrangler.jsonc
npx wrangler secret put GITHUB_APP_PRIVATE_KEY --config packages/adapter-controller-cloudflare/wrangler.jsonc
npx wrangler secret put HCLOUD_TOKEN --config packages/adapter-controller-cloudflare/wrangler.jsonc
```

The GitHub App private key may use GitHub's PKCS#1 PEM or PKCS#8 PEM format. Never put it in `vars`, `.dev.vars`, shell history, source control, logs, Durable Object storage, or Queue messages.

Build locally, then deploy:

```bash
npm run check:serverless
npx wrangler deploy --config packages/adapter-controller-cloudflare/wrangler.jsonc
curl --fail https://YOUR_CONTROLLER/healthz
```

Cron changes may take several minutes to propagate. Queue retries use bounded exponential delay and route exhausted messages to `jit-runner-kit-tasks-dlq`.

## Workflow routing

Route one trusted substantial job with both the stable trigger label and a label scoped to the workflow run:

```yaml
jobs:
  ci:
    runs-on: [self-hosted, linux, x64, jit-runner, "jit-run-${{ github.run_id }}"]
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - run: ./your-ci-command
```

The webhook payload labels become the JIT runner labels. `jit-run-${{ github.run_id }}` prevents an older queued pull-request run with otherwise identical labels from taking a runner created for a trusted run. Jobs inside the same trusted run share that security boundary; every queued job still receives a separate VM. The controller rejects both queued and completed events that do not carry the expected run-scoped label.

## Security properties

- `X-Hub-Signature-256` is verified with HMAC-SHA256 before JSON parsing or queueing.
- The provider-agnostic core enforces repository, branch, trigger-label, run-scoped-label, and no-PR policy for both queued and completed events.
- The Queue carries identifiers and lifecycle state, never credentials or JIT configuration.
- The Durable Object stores only a SHA-256 digest of the bootstrap token.
- Bootstrap also requires the request's observed public IPv4 to equal the created VM's IPv4.
- JIT configuration is generated only after successful bootstrap verification and an atomic state claim, returned once with `Cache-Control: no-store`, and never written to durable state.
- The VM has no SSH key and a firewall with no inbound rules. It needs outbound HTTPS for Cloudflare, GitHub, Ubuntu, and workload dependencies.
- GitHub installation tokens are minted per operation and scoped to the webhook repository ID.

Cloud-init necessarily receives the one-time bootstrap token as Hetzner `user_data`. It is not a GitHub credential, is rejected synchronously after the job TTL, is deleted from `/run` before runner startup, and cannot be reused after the atomic bootstrap claim.

## Required live-cloud gates

Run these in a dedicated Hetzner project and a non-production GitHub repository:

1. Valid signed queued event provisions exactly one VM and one runner.
2. Duplicate webhook delivery does not provision a second VM.
3. Wrong repository, branch, missing static/run-scoped label, PR association, signature, token, and source IP create no compute.
4. Successful workload removes the runner, server, Primary IPv4, and firewall.
5. Intentionally failed workload performs the same cleanup.
6. Cancelled workflow is cleaned by completed delivery or TTL reconciliation.
7. A forced retry reaches the Queue retry path; an exhausted synthetic task reaches the DLQ without leaking secrets.
8. A deliberately orphaned expired labeled resource is removed by Cron/provider reconciliation.
9. The existing GitHub control-job fallback still passes.
10. `bin/jit-runner inventory --require-empty` reports zero managed Hetzner resources.

Until all gates pass, keep production workflows on the GitHub control-job adapter.

## Failure recovery

- `completed` webhook delivery is the primary cleanup signal.
- The Durable Object alarm reconciles the earliest active job expiry.
- Cron invokes the same reconciliation independently and sweeps provider labels, including state-orphaned resources.
- Reconciliation attempts all job and provider cleanup paths even when one runner or VM deletion fails, then reports one retryable aggregate failure.
- Completed and failed Durable Object records are pruned after a bounded retention window of at least 24 hours.
- Queue messages retry only retryable upstream or concurrency failures. Terminal trust/auth/configuration failures are acknowledged and logged without their secret values.
- Inspect the DLQ before replay. Correct the cause first; do not bulk replay unknown tasks.

See [Serverless controller architecture](serverless-controller-architecture.md), [Operate the controller](controller-operations.md), and [Security policy](../SECURITY.md).
