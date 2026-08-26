# Deploy the Cloudflare controller

Status: v0.2.0 controlled-canary package. The Worker compiles and the provider-agnostic lifecycle, trust, cryptography, configuration, GitHub repository/organization scopes, and Hetzner adapter have local conformance coverage. Complete the live-cloud gates below before using it for production releases.

## What this adapter owns

```text
GitHub workflow_job webhook
  -> signature + allowlist + branch + labels + non-PR trust gate
  -> repository-scoped App, or private organization runner group
  -> Cloudflare Queue
  -> singleton SQLite Durable Object (job CAS + global leases)
  -> Hetzner API (at most one deny-inbound pool host, no SSH)
  -> source-bound one-time host enrollment
  -> GitHub App JIT configuration per claimed job
  -> at most two disposable runner/DinD pairs
  -> completed event job cleanup + bounded host idle release

Durable Object alarm + Cron
  -> job TTL reconciliation
  -> provider-label orphan sweep
```

GitHub remains the workflow scheduler. Cloudflare becomes the JIT lifecycle controller. Hetzner supplies temporary compute. The target application platform is not part of this repository.

## Prerequisites

- A Cloudflare account with Workers, Queues, Durable Objects, and Cron Triggers available.
- A dedicated Hetzner Cloud project and read/write API token.
- One or more private GitHub repositories owned by a user or organization.
- A private GitHub App installed only on the repositories the controller may serve.
- For optional organization scope, a dedicated organization runner group restricted to an exact list of trusted workflows.
- Node.js 22 and npm.

The default and least-privilege setup is repository scope. Create the GitHub App with:

- Webhook event: **Workflow jobs** only.
- Repository permissions: **Actions: read**, **Administration: read and write**, **Metadata: read**.
- No organization permissions.
- Webhook URL: `https://YOUR_CONTROLLER/webhooks/github`.
- A random webhook secret.

The repository includes `examples/github-app-repository-manifest.json` as the default reviewable template. `examples/github-app-manifest.json` is the organization-scope variant and replaces repository **Administration** with organization **Self-hosted runners: read and write**. Neither file is submitted anywhere by the project and neither implements GitHub's one-hour manifest-conversion handshake. Register the private App under the account that owns the served repositories, install it on selected repositories only, then store the generated ID and private key only as Worker secrets. See GitHub's [App manifest parameters](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) and [self-hosted runner permission requirements](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps).

Do not enable the controller for public-fork or pull-request jobs. This implementation rejects every queued job with a non-empty `pull_requests` array.

Repository scope supports personal-account and organization repositories. It verifies the signed repository identity, the installation-scoped repository, workflow event, source repository, branch, branch- or SHA-pinned workflow path, and exactly one matching queued job before compute creation and again before JIT issuance. Keep direct write access to trusted branches restricted.

For organization scope, additionally create a dedicated runner group with public-repository access disabled, workflow access enabled, and only explicitly trusted workflow paths selected. The controller verifies that the live group policy exactly matches `TRUSTED_WORKFLOWS` before it creates compute and again before JIT issuance.

## Configure Cloudflare

### Prepare everything offline

The repository ships inert deployment templates. Copy them to ignored canary files before inserting real organization names or URLs:

```bash
cp packages/adapter-controller-cloudflare/wrangler.jsonc \
  packages/adapter-controller-cloudflare/wrangler.canary.jsonc
cp examples/github-app-repository-manifest.json examples/github-app-manifest.canary.json
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

The preflight verifies the SQLite Durable Object export, Queue/DLQ/Cron/rate-limit bindings, scope-specific GitHub App permissions, repository ownership where applicable, trusted events, exact branch- or SHA-pinned workflow paths, numeric limits, and HTTPS origin. It makes no provider calls and reads no secrets. The committed template itself is checked in CI with `npm run check:cloudflare-config`.

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
- keep `RUNNER_SCOPE=repository` for the least-privilege default, or use `organization` only with the stronger runner-group boundary;
- in repository scope, set `RUNNER_GROUP_ID` to the repository JIT endpoint's runner-group ID and leave `GITHUB_ORGANIZATION` informational;
- in organization scope, set `GITHUB_ORGANIZATION` and the dedicated `RUNNER_GROUP_ID`;
- set `TRUSTED_EVENTS` to trusted non-PR events such as `push,workflow_dispatch`;
- set `TRUSTED_WORKFLOWS` to exact branch- or SHA-pinned workflow paths; in organization scope these must also exactly match the runner group's selected-workflow list;
- keep `RUN_LABEL_PREFIX` non-empty and route jobs with `jit-run-${{ github.run_id }}` as defense in depth;
- keep `MAX_RUNNERS` at `1` for the first canary, then at most `2` initially;
- set `COMPUTE_MODE=hetzner-pool` and a unique, stable `POOL_ID` for this deployment;
- set `POOL_IDLE_SECONDS=600` (accepted range 300-3600);
- set `POOL_AGENT_URL` to the pool agent at an immutable Git commit and `POOL_AGENT_SHA256` to its exact SHA-256;
- set `POOL_RUNNER_IMAGE` and `POOL_DIND_IMAGE` to full registry references pinned with `@sha256:` digests;
- keep `PROVISIONING_TIMEOUT_SECONDS` long enough for normal API calls (the default is 300); stale attempts are claimed again after this window;
- set `PUBLIC_BASE_URL` to the final HTTPS Worker or custom-domain origin;
- select a Hetzner server type, location, image, architecture, and TTL.

Store credentials only as encrypted Worker secrets:

```bash
npx wrangler secret put GITHUB_WEBHOOK_SECRET --config packages/adapter-controller-cloudflare/wrangler.canary.jsonc
npx wrangler secret put GITHUB_APP_ID --config packages/adapter-controller-cloudflare/wrangler.canary.jsonc
npx wrangler secret put GITHUB_APP_PRIVATE_KEY --config packages/adapter-controller-cloudflare/wrangler.canary.jsonc
npx wrangler secret put HCLOUD_TOKEN --config packages/adapter-controller-cloudflare/wrangler.canary.jsonc
npx wrangler secret put POOL_ENROLLMENT_TOKEN --config packages/adapter-controller-cloudflare/wrangler.canary.jsonc
npx wrangler secret put POOL_HOST_TOKEN --config packages/adapter-controller-cloudflare/wrangler.canary.jsonc
```

Generate both pool tokens as independent 32-byte base64url values without padding (43 characters). The enrollment token enters cloud-init only to identify the newly created provider host; the host token is returned once after controller/IP validation and is never mounted into workload containers. The GitHub App private key may use GitHub's PKCS#1 PEM or PKCS#8 PEM format. Never put any secret in `vars`, `.dev.vars`, shell history, source control, logs, Durable Object storage, or Queue messages.

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

The webhook payload labels become the JIT runner labels. Labels are visible to repository workflows and GitHub's JIT API does not accept a job ID, so labels alone are not a security boundary. The adapter re-reads the run and its latest jobs from GitHub and requires exactly one queued job matching the webhook job ID, stable trigger label, and run-scoped label. Repository scope relies on the selected-repository App installation plus the exact trusted run policy; organization scope additionally verifies the workflow-restricted runner group. In `hetzner-pool` mode every accepted job receives a separate runner/DinD pair on the single active pool host.

## Security properties

- `X-Hub-Signature-256` is verified with HMAC-SHA256 before JSON parsing or queueing.
- The provider-agnostic core enforces repository, branch, trigger-label, run-scoped-label, and no-PR policy for both queued and completed events.
- Before provisioning, the GitHub adapter verifies the signed repository identity, trusted event and source repository, branch, workflow path/ref, and an unambiguous matching queued job.
- The trusted run is verified again immediately before JIT configuration is generated. Organization scope also verifies its private exact-workflow runner-group policy at both points.
- Public endpoints are rate-limited before expensive work. Webhook bodies must be JSON and are capped at 1 MiB; malformed bootstrap paths and authorization tokens are rejected before Durable Object dispatch.
- The Queue carries identifiers and lifecycle state, never credentials or JIT configuration.
- The Durable Object stores only a SHA-256 digest of the bootstrap token.
- Bootstrap also requires the request's observed public IPv4 to equal the created VM's IPv4.
- JIT configuration is generated only after successful bootstrap verification and an atomic state claim, returned once with `Cache-Control: no-store`, and never written to durable state.
- The pool host has no SSH key and a firewall with no inbound rules. It needs outbound HTTPS for Cloudflare, GitHub, Ubuntu, registries, and workload dependencies.
- Pool discovery and cleanup use an explicit `pool_id` label. A retryable create response performs bounded label recovery and blocks a second create while the first result is ambiguous. Primary IPv4 provisioning waits on the Hetzner action returned by `POST /primary_ips` through the generic `GET /actions/{id}` endpoint before the server may reference that IP.
- One Durable Object operation gate serializes queue, bootstrap, claim, release, alarm, and provider mutations.
- GitHub installation tokens are minted per operation and scoped to the webhook repository ID.

Cloud-init receives only the pool enrollment token plus immutable public artifact identities. It receives no GitHub credential, JIT configuration, host token, or application secret. The controller binds enrollment to the active provider host IPv4 and generation. Runner containers receive only their root-readable one-job JIT file and never the pool credentials.

## Required live-cloud gates

Run these in a dedicated Hetzner project and a non-production GitHub repository:

1. Valid signed queued event provisions exactly one pool VM and one runner container.
2. Duplicate webhook delivery, concurrent queue delivery, and ambiguous provider response do not provision a second VM.
3. Wrong repository, event, source repository, branch, workflow path/ref, organization-scope group policy, ambiguous job set, missing static/run-scoped label, PR association, signature, token, and source IP create no compute.
4. Two concurrent accepted runs use one VM and no more than two isolated runner/DinD pairs; no per-job server, IPv4, firewall, or SSH key is created.
5. Successful workload removes the JIT record and job containers; the idle window then removes the host, Primary IPv4, and firewall.
6. Intentionally failed workload performs the same job and idle cleanup.
7. Cancelled workflow is cleaned by completed delivery or TTL reconciliation, including cancellation before host enrollment.
8. A forced retry reaches the Queue retry path; an exhausted synthetic task reaches the DLQ without leaking secrets.
9. A deliberately orphaned expired labeled resource is removed by Cron/provider reconciliation.
10. The existing GitHub control-job fallback still passes without being invoked by the new workflow.
11. After the 10-15 minute idle observation, `bin/jit-runner inventory --require-empty` reports zero `ephemeral_*` and `pool_*` resources.
12. A workflow outside `TRUSTED_WORKFLOWS` cannot acquire a runner even if it copies all runner labels; organization scope also proves the same through the runner-group policy.

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
- Provider telemetry contains only the normalized operation, action/HTTP status, and machine-readable error code. It never records API tokens or provider response bodies.
- Inspect the DLQ before replay. Correct the cause first; do not bulk replay unknown tasks.

See [Serverless controller architecture](serverless-controller-architecture.md), [Operate the controller](controller-operations.md), and [Security policy](../SECURITY.md).
