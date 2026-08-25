# Operate the controller

JIT Runner Kit separates scheduling from execution in every operating mode:

- GitHub Actions owns the workflow queue and assigns a queued job to a matching runner.
- In the recommended current mode, short GitHub-hosted provision and cleanup jobs are the control plane. The heavy workload runs only on the ephemeral runner.
- `jit-runner-controller` remains a compatibility control plane. It polls allowlisted repositories, requests a one-job JIT configuration, provisions the VM, observes completion, and destroys the resources.
- Hetzner runs the untrusted build and deployment commands inside an ephemeral VM.
- Your application platform, such as Zeabur, remains the deployment target. It is not the runner controller.

In GitHub control-job mode, the provision job runs before the dynamically labeled workload and cleanup runs with `if: always()`. Neither control job checks out application code or runs builds, tests, or deployment commands. In polling mode, the controller must run outside the workflow it serves; no permanent controller host is needed in GitHub control-job mode.

## Run jobs concurrently

`max_runners` is the polling controller's global concurrency limit:

```json
{
  "repositories": [
    "your-org/api",
    "your-org/web"
  ],
  "max_runners": 2
}
```

With `max_runners: 2`, two queued jobs can run at the same time on two separate VMs. Each VM gets its own firewall, SSH key, Primary IPv4, JIT runner registration, state directory, and TTL cleanup path.

This model preserves the main security property: one VM executes one job and is then destroyed. It also avoids Docker socket, workspace, cache, CPU, and memory collisions between jobs.

Running several runner processes or containers on one persistent server is possible with GitHub's self-hosted runner software, but JIT Runner Kit intentionally does not implement that mode. Those jobs share a kernel and host resources, cleanup is harder to prove, and one privileged build can affect another. Use separate ephemeral VMs for deployment and secret-bearing jobs.

Choose a conservative limit:

| Controller host | Suggested starting point | Why |
| --- | ---: | --- |
| Compatibility polling controller | `2` | The controller does little work; the limit mainly bounds cloud spend. |
| First production pilot | `1` | Simplest failure analysis and cost observation. |

Concurrency shortens wall-clock time. It does not make each VM cheaper, and the cloud provider may apply a minimum billable interval to every VM and attached resource.

GitHub `concurrency` groups are repository-local, so identical groups do not enforce a global limit across several repositories. Until a serverless lease adapter is available, coordinate cross-repository dispatches operationally or use the polling controller's `max_runners`. Do not implement the cap by placing several secret-bearing jobs on one VM.

## Keep the compatibility controller running

Run the controller as a dedicated, unprivileged service account. The account needs:

- read/write access to the configured `state_root`;
- OpenTofu or Terraform and the `hcloud` provider runtime;
- a GitHub token limited to the repositories and Actions runner operations it serves;
- a Hetzner API token limited to the project where ephemeral resources are created;
- outbound HTTPS and SSH access.

Keep credentials outside the repository and process arguments. On Linux, use a root-readable service environment file with mode `0600` and reference it from a `systemd` unit. On macOS, store secrets in Keychain and load them in a small local wrapper before `launchd` starts the controller. Do not put tokens directly in a plist, unit file, controller JSON, shell history, or GitHub Actions variable.

The service command itself is intentionally plain:

```bash
exec /opt/jit-runner-kit/bin/jit-runner-controller \
  --config /etc/jit-runner-kit/controller.json
```

Set the service to restart after an unexpected exit, but retain a short restart delay so authentication or provider outages do not create a tight loop.

A hardened starting unit is available at [`examples/jit-runner-controller.service`](../examples/jit-runner-controller.service). Copy it to `/etc/systemd/system`, create the dedicated account and directories named in the unit, set `state_root` in `controller.json` to `/var/lib/jit-runner-kit/jobs`, and put only the two required token assignments in `/etc/jit-runner-kit/controller.env` with owner `root` and mode `0600`.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now jit-runner-controller.service
sudo systemctl status jit-runner-controller.service
```

## Retain useful logs without retaining secrets

The example sends controller output to the system journal. Keep enough history to correlate a workflow job, runner name, run key, provider resource IDs, and cleanup result. Do not log token values, JIT configuration, private keys, infrastructure state, application secrets, or workload output that may contain them.

For a small controller host, a bounded journal is a reasonable starting point. Configure retention in `/etc/systemd/journald.conf.d/jit-runner-kit.conf`, for example:

```ini
[Journal]
SystemMaxUse=500M
MaxRetentionSec=14day
Compress=yes
Seal=yes
```

These are host-wide journald settings, so review them with the host operator before applying them. For production release auditability, forward sanitized controller lifecycle events to protected external storage with access control and its own retention policy. Ephemeral workload logs remain GitHub Actions logs unless the workflow explicitly forwards them; destroying the VM also destroys its local journal.

## Safe restart procedure

1. Check every job state under `state_root/jobs`. Wait until no job is `provisioning`, `watching`, or `cleaning`.
2. Stop the controller process.
3. Change the allowlist, concurrency, image, or TTL configuration.
4. Run `jit-runner-controller --config ... --once --dry-run`.
5. Start the service and dispatch one non-production canary job.
6. Confirm the GitHub runner record, VM, Primary IPv4, firewall, and SSH key are all deleted after the job.

Stopping the controller does not automatically make an active VM safe to abandon. If a restart is unavoidable during an active job, preserve its state directory and run the cleanup command recorded there before deleting or recreating controller state.

## Operational checks

For every successful and failed canary, verify:

- the job ran on a runner whose name starts with `jit-`;
- the runner registration disappeared after one job;
- the job state reached `completed` or an explicit terminal failure;
- no matching Hetzner VM, Primary IPv4, firewall, or SSH key remains;
- the TTL sweeper is able to find and remove deliberately stale test resources;
- `jit-runner inventory --require-empty` reports zero managed resources after cleanup;
- deployment verification checks the exact release commit rather than only an HTTP 200 response.

The repository's manual CI workflow accepts `workload-mode=fail` to exercise cleanup after an intentionally failed workload. For a cancellation canary, use a short `ttl-minutes` value, cancel only after the workload has started, then run the independent TTL sweeper after expiry and finish with `jit-runner inventory --require-empty`. Run these canaries in a dedicated cloud project with no unrelated resources.

The selected control-plane adapter is the source of provisioning decisions, GitHub is the source of queued-job state, and the cloud provider is the source of resource existence. Healthy operation requires all three views to agree. See [Serverless controller architecture](serverless-controller-architecture.md) for the accepted provider-agnostic event-driven design.
