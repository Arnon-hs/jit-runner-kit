<div align="center">
  <img src="docs/images/jit-runner-mark.svg" width="72" alt="JIT Runner Kit" />
  <h1>JIT Runner Kit</h1>
  <p><strong>Fresh GitHub Actions runners. One job, one VM, zero idle compute.</strong></p>
  <p><a href="#github-actions-control-job-mode">Quickstart</a> · <a href="#architecture">Architecture</a> · <a href="SECURITY.md">Security</a> · <a href="CONTRIBUTING.md">Contributing</a> · <a href="https://github.com/Arnon-hs/jit-runner-kit/discussions">Discussions</a></p>
  <a href="https://github.com/Arnon-hs/jit-runner-kit/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Arnon-hs/jit-runner-kit/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="ROADMAP.md"><img alt="Pre-1.0 pilot" src="https://img.shields.io/badge/status-pre--1.0%20pilot-f59e0b.svg" /></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-4f46e5.svg" /></a>
  <a href="https://opentofu.org/"><img alt="OpenTofu" src="https://img.shields.io/badge/IaC-OpenTofu-ffda18.svg" /></a>
</div>

> Provider-agnostic, MIT-licensed infrastructure for trusted repositories that need elastic self-hosted CI without an always-on build fleet.

Create a clean, one-job GitHub Actions runner on demand and delete its cloud resources afterward.

`jit-runner-kit` is for maintainers of trusted repositories who want elastic self-hosted runners without keeping an expensive build server online. The public interface is repository-independent and contains no application deployment logic. Hetzner Cloud is the first provider driver; the provider interface is intentionally small so more drivers can be added later.

> **Project status:** pre-1.0 pilot. Real-cloud end-to-end runs on Hetzner CX33 have passed, including JIT registration, workload execution, runner deregistration, and deletion of the VM, Primary IPv4, firewall, and SSH key. Cleanup after an intentionally failed workload and a cancelled workflow has also passed, followed by an empty managed-resource inventory. The project is validated for controlled pilots, but is not yet production-stable.

## Why it exists

- Pay for short-lived cloud capacity instead of idle CI machines.
- Keep GitHub-hosted control jobs short while heavy work runs on temporary cloud capacity.
- Give every job a fresh VM and a GitHub just-in-time (JIT) runner registration.
- Limit cleanup blast radius with ownership labels, per-run state, and an independent TTL sweep.
- Keep application workflows independent from the runner provider implementation.

## Architecture

```text
GitHub workflow
  |-- short hosted provision job
  |        `-- OpenTofu/Terraform -> temporary compute + one JIT registration
  |-- heavy workload job -> one isolated VM
  `-- short hosted cleanup job -> runner + cloud resources removed
                              `-> independent TTL sweep is the backstop
```

The JIT configuration is never placed in cloud-init, infrastructure state, or workflow artifacts. The runner package is resolved from the latest official GitHub release and its published SHA-256 digest is verified before extraction.

The Hetzner image installs Docker with Compose v2, GitHub CLI, ShellCheck, PHP CLI, Python 3, and a native build toolchain. The official runner dependency installer runs before registration. The unprivileged `runner` user is not granted sudo access.

Need another shell, language runtime, or system library? The runner image is deliberately built from a small, readable cloud-init file. See [Customize the runner image](docs/custom-runner-image.md) for safe package-list changes, Bash/Zsh/Fish examples, third-party repository guidance, custom images, and validation steps.

Need concurrent jobs or an always-on controller? See [Operate the controller](docs/controller-operations.md) for the control-plane roles, one-VM-per-job isolation model, `max_runners` sizing, a hardened `systemd` example, log-retention guidance, and recovery checks.

## Choose an operating mode

| Mode | GitHub-hosted minutes | Best for | Trade-off |
| --- | ---: | --- | --- |
| GitHub control jobs | Two short hosted jobs; self-hosted workload is not a hosted job | Current recommended integration | Hosted jobs are rounded and require a short-lived state artifact |
| External polling controller | 0 | Compatibility and constrained accounts | Needs a trusted always-on controller host |
| Cloudflare serverless controller | No hosted provision/cleanup jobs | Event-driven controlled canaries | Initial implementation is available; live-cloud conformance is still required before production use |

The GitHub control-job mode is the current recommended path. The provider-agnostic serverless design keeps it as a fallback adapter rather than removing it.

## Cloudflare serverless controller

The first serverless adapter is implemented with a verified GitHub App `workflow_job` webhook, Cloudflare Queues, a singleton SQLite Durable Object, Durable Object alarms, Cron reconciliation, and the direct Hetzner Cloud API compute adapter.

It creates SSH-free, deny-inbound VMs. A VM receives only a one-time bootstrap token, exchanges it over HTTPS from its expected public IPv4, and receives a JIT configuration that is never written to Queue, Durable Object, cloud-init, or provider state.

Cloudflare-controlled jobs must include both `jit-runner` and a run-scoped label: `"jit-run-${{ github.run_id }}"`. The controller verifies that label before provisioning so a queued pull-request run with shared static labels cannot take a runner created for a trusted branch run.

Start with the complete [Cloudflare controller deployment and canary guide](docs/cloudflare-controller.md). Keep production workflows on the GitHub control-job adapter until its success, failure, cancellation, retry/DLQ, and TTL gates all pass with an empty final provider inventory.

## Requirements

Control plane:

- GitHub Actions control jobs, or Linux/macOS for the compatibility polling controller
- `bash`, `curl`, `jq`, `ssh`, and `ssh-keygen`
- OpenTofu 1.7+ (recommended) or Terraform 1.7+
- a dedicated Hetzner Cloud project token
- a GitHub fine-grained token scoped to the target repositories with **Actions: read** and **Administration: write**

The normal workflow `GITHUB_TOKEN` usually cannot generate repository JIT configurations. Keep runner administration credentials separate from application and deployment secrets.

## External polling controller compatibility mode

1. Clone the controller onto a trusted host:

   ```bash
   git clone https://github.com/Arnon-hs/jit-runner-kit.git
   cd jit-runner-kit
   cp examples/controller-config.json controller.json
   ```

2. Edit `controller.json` and list only repositories the controller may serve.

3. Export credentials without writing them to the repository:

   ```bash
   export HCLOUD_TOKEN='...'
   export JIT_RUNNER_GITHUB_TOKEN='...'
   ```

4. Inspect matching jobs without creating infrastructure:

   ```bash
   bin/jit-runner-controller --config ./controller.json --once --dry-run
   ```

5. Start the controller:

   ```bash
   bin/jit-runner-controller --config ./controller.json
   ```

6. Route one trusted workflow job to it:

   ```yaml
   jobs:
     ci:
       runs-on: [self-hosted, linux, x64, jit-runner]
       steps:
         - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
         - run: ./your-ci-command
   ```

The controller polls only configured repositories and reacts only to queued jobs containing its trigger label. It creates one VM per job, waits for the JIT runner to deregister or reach its TTL, then deletes the GitHub runner record and cloud resources. GitHub JIT-configuration throttling is retried according to GitHub's rate-limit response; the request runs before cloud provisioning so an API rejection does not create a billable VM. See [`examples/controller-config.json`](examples/controller-config.json) and [`examples/zero-hosted-minutes.yml`](examples/zero-hosted-minutes.yml).

Set `max_runners` above `1` to run multiple jobs concurrently. Every active job still receives a separate ephemeral VM; the setting limits concurrency rather than placing multiple jobs on one shared worker.

## GitHub Actions control-job mode

If GitHub-hosted control jobs are available, the composite actions can provision and destroy a runner from a workflow. Pin the toolkit to an immutable release tag or commit SHA in production.

The full three-job example and the separate sweeper are in [`examples/github-actions.yml`](examples/github-actions.yml) and [`examples/ttl-sweeper.yml`](examples/ttl-sweeper.yml). The provision and cleanup jobs must not check out or execute untrusted application code. Set artifact retention to the shortest practical period; the state contains resource metadata but never the JIT configuration or private SSH key.

The actions use OpenTofu by default. Set `iac-engine: terraform` on both `provision` and `destroy` if Terraform is required.

Provisioning retries transient provider errors with bounded backoff. The action also defaults to `nbg1,hel1` as ordered fallbacks after the primary `fsn1` location, so temporary capacity pressure in one zone does not fail the entire control job. Override `fallback-locations` with a comma-separated list, or set it to an empty string to stay in one location.

## Local CLI

```bash
export HCLOUD_TOKEN='...'
export JIT_RUNNER_GITHUB_TOKEN='...'

bin/jit-runner provision \
  --repository owner/private-repo \
  --run-id manual-001 \
  --fallback-locations nbg1,hel1 \
  --state-dir .jit-runner-state/manual-001

bin/jit-runner destroy \
  --state-dir .jit-runner-state/manual-001

bin/jit-runner sweep --dry-run
bin/jit-runner sweep
bin/jit-runner inventory --require-empty
```

`provision` prints machine-readable `key=value` outputs and also writes them to `$GITHUB_OUTPUT` when available. Set `JIT_RUNNER_IAC_CMD=terraform` to override the default OpenTofu-first auto-detection.

## Trust and failure boundaries

- Use the current design only for repositories and contributors you trust. A workflow job fully controls its runner VM.
- Keep public fork pull requests on GitHub-hosted or otherwise isolated, secret-free runners. This repository's own public quality job follows that pattern; JIT dogfooding is manual and disabled by default.
- Never expose runner-administration or deployment secrets to untrusted pull-request code.
- Keep runner VMs outside production networks and accounts.
- SSH is restricted to the controller's observed public IPv4 by default.
- Infrastructure state contains cloud resource metadata and an SSH public key, but no private key or JIT configuration.
- `if: always()` is not a cleanup guarantee. Run the TTL sweep independently.
- Ephemeral logs disappear with the VM. Forward diagnostics before using this for high-value releases.
- The polling controller is intentionally simple. The implemented provider-agnostic webhook architecture is documented in [Serverless controller architecture](docs/serverless-controller-architecture.md), with Cloudflare setup in [Deploy the Cloudflare controller](docs/cloudflare-controller.md).

Read the full [security policy](SECURITY.md) before operating the toolkit.

## Cost behavior

Hetzner bills while a server exists, including while it is powered off. Deleting the server and Primary IPv4 stops their respective usage billing. Very short server lifetimes are rounded to at least one hour. See the [Hetzner Cloud billing FAQ](https://docs.hetzner.com/cloud/billing/faq/).

One JIT runner accepts one job. Consolidating related build steps into one job usually matters more for cost than shortening individual steps.

## Development

```bash
make check
```

Use `make IAC=terraform check` to validate with Terraform. The test suite uses mocks and creates no cloud resources. See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete contributor workflow and [THIRD_PARTY.md](THIRD_PARTY.md) for tooling and license notes.

## Scope and roadmap

The project provisions ephemeral GitHub Actions JIT runners and cleans up their infrastructure. It does not deploy applications, manage application secrets, or provide a general-purpose CI scheduler. See [VISION.md](VISION.md), [ROADMAP.md](ROADMAP.md), and [CHANGELOG.md](CHANGELOG.md).

## Support and community

- Ask usage questions in [GitHub Discussions](https://github.com/Arnon-hs/jit-runner-kit/discussions).
- Report reproducible bugs with the [bug template](https://github.com/Arnon-hs/jit-runner-kit/issues/new/choose).
- Read [SUPPORT.md](SUPPORT.md) before opening a support request.
- Read [CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before contributing.
- Report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

Licensed under the [MIT License](LICENSE).
