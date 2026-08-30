# Production cutover

This runbook moves a trusted private repository from GitHub-hosted control jobs or the one-VM-per-job adapter to the Cloudflare `hetzner-pool` controller. It does not change the application's deployment platform or own application secrets.

## Resulting control flow

```text
GitHub push or deliberate workflow_dispatch on main
  -> signed workflow_job webhook
  -> Cloudflare Queue + Durable Object
  -> zero or one temporary Hetzner CX33 pool host
  -> one disposable runner/DinD pair for this job
  -> application build, test, deploy, and exact-SHA verification
  -> runner and containers removed on completion
  -> host, Primary IPv4, and firewall removed after 600 idle seconds
```

GitHub remains the workflow scheduler. Cloudflare owns runner lifecycle. Hetzner supplies temporary compute. A platform such as Zeabur remains the deployment target.

## 1. Establish the least-privilege trust set

1. Install the GitHub App on **selected repositories** only.
2. Add the exact repository full name to `ALLOWED_REPOSITORIES`.
3. Add only the default branch to `TRUSTED_BRANCHES`.
4. Add only `push,workflow_dispatch` to `TRUSTED_EVENTS`.
5. Add the exact branch-pinned workflow identity to `TRUSTED_WORKFLOWS`, for example:

   ```text
   example-org/example-app/.github/workflows/ci.yml@refs/heads/main
   ```

6. Keep `MAX_RUNNERS` at `1` for the first canary and never above `2` for the shared-host implementation.
7. Use a dedicated Hetzner project token and keep every controller credential in Worker secrets.

For a multi-repository production installation, start from the non-secret
[`examples/production-controller-trust-set.json`](../examples/production-controller-trust-set.json)
inventory. Apply it only after the GitHub App is installed on every listed
repository. The App installation, `ALLOWED_REPOSITORIES`,
`TRUSTED_BRANCHES`, and `TRUSTED_WORKFLOWS` must agree before merging a
workflow that depends on the pool; otherwise GitHub will leave its JIT job
queued with no eligible runner.

Run the offline preflight before deployment. Read the deployed revision back after deployment and confirm the repository, workflow, branch, event, concurrency, immutable agent, and immutable image identities. An invalid signature and invalid bootstrap token must both fail closed without creating provider resources.

## 2. Collapse the release into one trusted JIT job

The release workflow must not contain GitHub-hosted provision, cleanup, build, test, or deploy jobs. Keep one substantial job with a static trigger label and a run-unique routing label:

```yaml
name: Release

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  checks: read

concurrency:
  group: example-app-release
  cancel-in-progress: false

jobs:
  release:
    if: >-
      github.repository == 'example-org/example-app' &&
      github.ref == 'refs/heads/main' &&
      (github.event_name == 'push' || github.event_name == 'workflow_dispatch')
    runs-on: [self-hosted, linux, x64, jit-runner, "jit-run-${{ github.run_id }}"]
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          persist-credentials: false
      - run: ./scripts/release.sh
```

Combine build, tests, deployment wait, migrations, exact runtime identity, public/API smoke, and cache revalidation in this job. Do not put pull-request code or automatic merge credentials in it. Run pull-request quality checks in an unprivileged path and authorize merge outside the workload that executed the PR code.

## 3. Account for the DinD network boundary

Every job receives a dedicated runner container and a dedicated Docker-in-Docker daemon. The runner uses `DOCKER_HOST=tcp://docker:2375`; it does not use the host Docker socket.

A service published by a nested Compose stack is not reachable at the runner container's `127.0.0.1`. Connect from workflow processes through the DinD hostname and the published port, or run the client in the same per-job Docker network. Prove this topology with the real integration service before merging the workflow migration.

The published pool runner image includes Node.js, Docker CLI/Compose, GitHub CLI, PHP CLI, Python, ShellCheck, and native build tools. See [Customize the runner image](custom-runner-image.md) for other shells, packages, and immutable custom images.

## 4. Make the cutover once

1. Verify the reviewed workflow head and fresh default-branch SHA.
2. Confirm there is no queued or in-progress release for the repository.
3. Confirm GitHub runner inventory and the dedicated Hetzner project are empty.
4. Publish one consolidated, ready-for-review PR. Do not create a draft if your repository intentionally runs checks and automerge only for ready PRs.
5. Merge the unchanged reviewed head once.
6. Let the resulting `push` create the single release run. Do not also dispatch it manually.
7. Treat an exact-SHA GitHub `PushEvent` as evidence that the automatic run can still arrive, even when the Actions API and check suites are temporarily empty. Do **not** use `workflow_dispatch` for that SHA while the push event exists.
8. Use `workflow_dispatch` only when the release intentionally has no corresponding push event, or after the push-trigger defect has been fixed in a separate reviewed change. Record the exact SHA and recheck runs, check suites, and repository runners immediately before dispatch.

Treat re-enabling the old provision/destroy workflow as an explicit rollback. Never leave both flows able to release the same SHA.

GitHub event-to-Actions scheduling can be delayed. A fixed ten-minute or similar observation window is not a deduplication primitive. If a repository needs an automatic fallback, implement a durable repository-and-SHA release claim outside the workload before enabling it; do not approximate that claim with a timer.

## 5. Prove application and cleanup outcomes separately

For the release, record:

- exact run, job, event, head SHA, runner ID/name, and labels;
- no GitHub-hosted control or workload job;
- at most one pool server and at most two isolated runner/DinD pairs;
- application build, tests, migrations, deployment check, exact runtime SHA, and browser behavior;
- runner record removal after the job;
- host deletion after the idle window;
- independent final inventory: zero servers, Primary IPv4s, firewalls, SSH keys, and repository runners.

A green workflow does not replace runtime or cleanup proof. A generic deployment status, HTTP 200, or an empty controller state does not prove the other layers.

## Cost controls

- Keep one release workflow per repository and one substantial job per run.
- Consolidate PR updates before pushing; avoid duplicate `push`, `pull_request`, and manual triggers for the same work.
- Never convert a delayed exact-SHA push into a manual release merely because the Actions API is temporarily empty.
- Use `MAX_RUNNERS=2` only when concurrent jobs materially shorten a burst. Each runner still accepts one job.
- Keep the recommended 600-second idle window so adjacent jobs can reuse one minimum-billed host hour without paying for an always-on server.
- Keep the steady idle target at zero provider resources. A powered-off Hetzner server is still billable.
- Cloudflare mode uses zero GitHub-hosted Actions minutes for control jobs; GitHub still stores workflow state and logs.

The [release control contract](release-control-contract.md) is the normative gate. The [Cloudflare controller guide](cloudflare-controller.md) covers installation and canaries; [controller operations](controller-operations.md) covers recovery and inventory.
