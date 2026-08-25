# Release control contract

This contract is for private repositories that use JIT Runner Kit for build, test, or deployment work. It separates control-plane evidence from application release evidence and prevents accidental fallback to billed or duplicate workflows.

## Workflow shape

- GitHub remains the scheduler and source of workflow/job state.
- Cloudflare is the serverless JIT lifecycle controller. Hetzner is the compute provider.
- A trusted release workflow contains one substantial JIT job with `self-hosted`, `linux`, architecture, `jit-runner`, and `jit-run-${{ github.run_id }}` labels. A deliberate concurrency canary may use two separate runs; normal releases stay one substantial job.
- Build, tests, container work, and deployment run only inside that JIT job. Do not add GitHub-hosted provision, cleanup, build, test, or deploy jobs after serverless cutover.
- One workflow run may contain only one queued job matching the JIT label pair. Combine related release stages into that job.
- In `hetzner-pool` mode, at most one temporary VM hosts at most two disposable runner/DinD pairs. Use only trusted-branch workloads; use the one-VM-per-job compatibility adapter when sharing a kernel is unacceptable.
- `workflow_job: completed` is the primary cleanup signal. Durable Object alarms and Cron provider-label TTL cleanup are independent backstops.

## Trust boundary

- Allow only configured `push` and deliberate `workflow_dispatch` events from the repository itself. Pull-request events are forbidden.
- Restrict execution to protected branches and exact branch- or SHA-pinned workflow paths.
- Install the GitHub App only on served repositories and grant the scope-specific minimum permissions documented in the Cloudflare guide.
- Set `actions/checkout` to `persist-credentials: false`. Pin every third-party action and released JIT Runner Kit integration to a full commit SHA.
- Expose deployment secrets only to the JIT job and only after the trusted event/ref conditions pass.

## Dispatch and merge gate

Before a release or merge that can deploy:

1. Fetch the remote default branch and record its exact SHA.
2. Record the pull request base and head SHAs and confirm the head has not changed since review.
3. Confirm there is no queued or in-progress workflow for the same release concurrency group.
4. Confirm the workflow file at the reviewed SHA matches `TRUSTED_WORKFLOWS` and contains no GitHub-hosted control or workload job.
5. Do not manually redispatch when the same push already triggered the release. Do not let cleanup dispatch a second release workflow.
6. Create ready-for-review PRs only after local and security gates, and publish one consolidated head update. Set `cancel-in-progress: true` for superseded non-release CI while keeping production release groups non-cancelling.

## Verification gate

A green workflow conclusion alone is insufficient. Record all of the following:

- exact workflow run URL, event, head SHA, conclusion, and runner name;
- proof that the substantial job ran on a `jit-` ephemeral runner and no job in the release used a GitHub-hosted image;
- controller cleanup completion and zero remaining managed runner records, servers, Primary IPv4s, firewalls, and SSH keys;
- deployment platform state tied to the same release SHA, not only a generic `Running` status;
- exact runtime SHA or immutable image identity for every changed service;
- browser verification of the changed behavior on the intended production route, including refresh/deep-link behavior where relevant.

Keep the release gate closed on red or missing required CI, SHA drift, duplicate active release, incomplete cleanup, deployment/runtime mismatch, or missing behavior proof.

## Transitional adapters

The GitHub control-job and polling adapters remain supported recovery paths, but they are not part of a serverless-cutover workflow. Re-enabling either is an explicit operational rollback that must be reviewed as a control-plane change. A Mac mini is never the production controller.
