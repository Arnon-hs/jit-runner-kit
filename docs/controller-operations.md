# Operate the controller

JIT Runner Kit separates scheduling from execution:

- GitHub Actions owns the workflow queue and assigns a queued job to a matching runner.
- `jit-runner-controller` is the external control plane. It polls allowlisted repositories, requests a one-job JIT configuration, provisions the VM, observes completion, and destroys the resources.
- Hetzner runs the untrusted build and deployment commands inside an ephemeral VM.
- Your application platform, such as Zeabur, remains the deployment target. It is not the runner controller.

The controller must run outside the GitHub Actions workflow it is serving. Otherwise no runner exists to start the job that would create the runner. A Mac mini, a small always-on VPS, or another trusted host with outbound HTTPS and SSH access can run it.

## Run jobs concurrently

`max_runners` is the controller-wide concurrency limit:

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
| Laptop or Mac mini controller | `2` | The controller does little work; the limit mainly bounds cloud spend. |
| Small always-on VPS controller | `2` to `4` | Suitable when several repositories release together. |
| First production pilot | `1` | Simplest failure analysis and cost observation. |

Concurrency shortens wall-clock time. It does not make each VM cheaper, and the cloud provider may apply a minimum billable interval to every VM and attached resource.

## Keep the controller running

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
- deployment verification checks the exact release commit rather than only an HTTP 200 response.

The controller is the source of provisioning decisions, GitHub is the source of queued-job state, and the cloud provider is the source of resource existence. Healthy operation requires all three views to agree.
