# Deploy the Cloudflare controller

Status: v0.2.0 controlled-canary package. The Worker compiles and the provider-agnostic lifecycle, trust, cryptography, configuration, and Hetzner adapter have local conformance coverage. Complete the live-cloud gates below before using it for production releases.

## What this adapter owns

```text
GitHub workflow_job webhook
  -> signature + allowlist + branch + labels + non-PR trust gate
  -> private organization runner group restricted to exact trusted workflows
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
- A GitHub organization containing the private repositories the controller may serve.
- A dedicated organization runner group restricted to an exact list of trusted workflows.
- A GitHub App installed only on those repositories and granted access to the runner group.
- Node.js 22 and npm.

Create the GitHub App with:

- Webhook event: **Workflow jobs** only.
- Repository permissions: **Actions: read**, **Metadata: read**.
- Organization permissions: **Self-hosted runners: read and write**.
- Webhook URL: `https://YOUR_CONTROLLER/webhooks/github`.
- A random webhook secret.

The repository includes `examples/github-app-manifest.json` as a reviewable configuration template. It is not submitted anywhere by the project and it does not implement GitHub's one-hour manifest-conversion handshake. Register the private App in your organization settings (or through a one-time manifest flow that you control), then store the generated ID and private key only as Worker secrets. See GitHub's [App manifest parameters](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) and [self-hosted runner permission requirements](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps).

Do not enable the controller for public-fork or pull-request jobs. This implementation rejects every queued job with a non-empty `pull_requests` array.

Create a dedicated organization runner group with public-repository access disabled, workflow access enabled, and only explicitly trusted workflow paths selected. Pin every selected path to `refs/heads/main` (or another protected branch) or a full commit SHA. The controller verifies that the live group policy exactly matches `TRUSTED_WORKFLOWS` before it creates compute. Personal-account repositories are intentionally unsupported in this secure serverless mode; use the GitHub control-job adapter for them.

## Configure Cloudflare

### Prepare everything offline

The repository ships inert deployment templates. Copy them to ignored canary files before inserting real organization names or URLs:

```bash
cp packages/adapter-controller-cloudflare/wrangler.jsonc \
  packages/adapter-controller-cloudflare/wrangler.canary.jsonc
cp examples/github-app-manifest.json examples/github-app-manifest.canary.json
```

Edit both copies, then run the offline fail-closed preflight:

```bash
npm run preflight:cloudflare -- \
  --config packages/adapter-controller-cloudflare/wrangler.canary.jsonc \
  --manifest examples/github-app-manifest.canary.json

npx wrangler deploy --dry-run \
  --config packages/adapter-controller-cloudflare/wrangler.canary.jsonc \
  --outdir .wrangler-dist-canary
```

The preflight verifies the SQLite Durable Object export, Queue/DLQ/Cron bindings, organization and repository relationship, exact branch- or SHA-pinned workflow paths, numeric limits, HTTPS origin, and minimum GitHub App permissions. It makes no provider calls and reads no secrets. The committed template itself is checked in CI with `npm run check:cloudflare-config`.

The Wrangler template uses Cloudflare's [declarative `exports` lifecycle](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/) for the new SQLite Durable Object namespace. Do not add the legacy `migrations` array to a new deployment.

### Create resources only when the canary is approved

Install exact development dependencies and create the queues once:

```bash
npm ci
npx wrangler queues create jit-runner-kit-tasks
npx wrangler queues create jit-runner-kit-tasks-dlq
```

Edit the ignored `packages/adapter-controller-cloudflare/wrangler.canary.jsonc`:

- set `ALLOWED_REPOSITORIES` to a comma-separated `owner/repository` allowlist;
- set `TRUSTED_BRANCHES` to explicit branch names;
- set `GITHUB_ORGANIZATION` and the dedicated `RUNNER_GROUP_ID`;
- set `TRUSTED_WORKFLOWS` to the exact comma-separated selected-workflow list from the runner group;
- keep `RUN_LABEL_PREFIX` non-empty and route jobs with `jit-run-${{ github.run_id }}` as defense in depth;
- keep `MAX_RUNNERS` at `1` for the first canary, then at most `2` initially;
- keep `PROVISIONING_TIMEOUT_SECONDS` long enough for normal API calls (the default is 300); stale attempts are claimed again after this window;
- set `PUBLIC_BASE_URL` to the final HTTPS Worker or custom-domain origin;
- select a Hetzner server type, location, image, architecture, and TTL.

Store credentials only as encrypted Worker secrets:

```bash
npx wrangler secret put GITHUB_WEBHOOK_SECRET --config packages/adapter-controller-cloudflare/wrangler.canary.jsonc
npx wrangler secret put GITHUB_APP_ID --config packages/adapter-controller-cloudflare/wrangler.canary.jsonc
npx wrangler secret put GITHUB_APP_PRIVATE_KEY --config packages/adapter-controller-cloudflare/wrangler.canary.jsonc
npx wrangler secret put HCLOUD_TOKEN --config packages/adapter-controller-cloudflare/wrangler.canary.jsonc
```

The GitHub App private key may use GitHub's PKCS#1 PEM or PKCS#8 PEM format. Never put it in `vars`, `.dev.vars`, shell history, source control, logs, Durable Object storage, or Queue messages.

Build locally, then deploy:

```bash
npm run check:serverless
npx wrangler deploy --config packages/adapter-controller-cloudflare/wrangler.canary.jsonc
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

The webhook payload labels become the JIT runner labels. The run-scoped label reduces accidental cross-routing, but GitHub's JIT API does not bind a runner to a job ID and labels are visible to repository workflows. The security boundary is the private organization runner group restricted to the exact trusted workflow definitions. Every queued job still receives a separate VM, and the controller rejects both queued and completed events that do not carry the expected run-scoped label.

## Security properties

- `X-Hub-Signature-256` is verified with HMAC-SHA256 before JSON parsing or queueing.
- The provider-agnostic core enforces repository, branch, trigger-label, run-scoped-label, and no-PR policy for both queued and completed events.
- Before provisioning, the GitHub adapter verifies that the repository belongs to the configured organization and the dedicated runner group is private and restricted to exactly `TRUSTED_WORKFLOWS`.
- The runner-group policy is verified again immediately before JIT configuration is generated, so policy drift during VM startup fails closed.
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
3. Wrong organization, repository, branch, workflow-group policy, missing static/run-scoped label, PR association, signature, token, and source IP create no compute.
4. Successful workload removes the runner, server, Primary IPv4, and firewall.
5. Intentionally failed workload performs the same cleanup.
6. Cancelled workflow is cleaned by completed delivery or TTL reconciliation.
7. A forced retry reaches the Queue retry path; an exhausted synthetic task reaches the DLQ without leaking secrets.
8. A deliberately orphaned expired labeled resource is removed by Cron/provider reconciliation.
9. The existing GitHub control-job fallback still passes.
10. `bin/jit-runner inventory --require-empty` reports zero managed Hetzner resources.
11. A workflow outside the runner group's selected list cannot acquire a runner even if it copies all runner labels.

Until all gates pass, keep production workflows on the GitHub control-job adapter.

## Failure recovery

- `completed` webhook delivery is the primary cleanup signal.
- The Durable Object alarm reconciles the earliest active job expiry.
- Cron invokes the same reconciliation independently and sweeps provider labels, including state-orphaned resources.
- Reconciliation attempts all job and provider cleanup paths even when one runner or VM deletion fails, then reports one retryable aggregate failure.
- Capacity-lease retention is a fail-closed precondition: if Durable Object storage cannot extend it, reconciliation performs no external deletion and retries later.
- A stale provisioning claim is retried after `PROVISIONING_TIMEOUT_SECONDS`; a failed VM deletion extends its concurrency lease until a later cleanup succeeds.
- Every provider resource carries a monotonic provisioning-attempt fence. An older, slow API call cannot adopt or delete a newer attempt's VM.
- Completed and failed Durable Object records are pruned after a bounded retention window of at least 24 hours.
- Queue messages retry only retryable upstream or concurrency failures. Terminal trust/auth/configuration failures are acknowledged and logged without their secret values.
- Inspect the DLQ before replay. Correct the cause first; do not bulk replay unknown tasks.

See [Serverless controller architecture](serverless-controller-architecture.md), [Operate the controller](controller-operations.md), and [Security policy](../SECURITY.md).
