<div align="center">
  <img src="docs/images/jit-runner-mark.svg" width="72" alt="JIT Runner Kit" />
  <h1>JIT Runner Kit</h1>
  <p><strong>Burst GitHub Actions capacity. Up to two isolated jobs, one VM, scale to zero.</strong></p>
  <p><a href="#github-actions-control-job-mode">Quickstart</a> · <a href="#architecture">Architecture</a> · <a href="SECURITY.md">Security</a> · <a href="CONTRIBUTING.md">Contributing</a> · <a href="https://github.com/Arnon-hs/jit-runner-kit/discussions">Discussions</a></p>
  <a href="https://github.com/Arnon-hs/jit-runner-kit/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Arnon-hs/jit-runner-kit/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="ROADMAP.md"><img alt="Pre-1.0 pilot" src="https://img.shields.io/badge/status-pre--1.0%20pilot-f59e0b.svg" /></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-4f46e5.svg" /></a>
  <a href="https://opentofu.org/"><img alt="OpenTofu" src="https://img.shields.io/badge/IaC-OpenTofu-ffda18.svg" /></a>
</div>

> Provider-agnostic, MIT-licensed infrastructure for trusted repositories that need elastic self-hosted CI without an always-on build fleet.

Create one short-lived build host on demand, run up to two jobs in disposable runner/DinD container pairs, and delete every billed cloud resource after a bounded idle window. The original one-VM-per-job adapter remains available as a compatibility fallback.

`jit-runner-kit` is for maintainers of trusted repositories who want elastic self-hosted runners without keeping an expensive build server online. The public interface is repository-independent and contains no application deployment logic. Hetzner Cloud is the first provider driver; the provider interface is intentionally small so more drivers can be added later.

> **Project status:** v0.3.0, pre-1.0 production pilot. The Cloudflare serverless adapter has completed real-cloud success, failure, cancellation, retry, TTL, two-container isolation, and scale-to-zero gates on Hetzner CX33. It now serves trusted main-branch release workflows in multiple private repositories. Keep the compatibility adapters available as an explicit rollback path and repeat the conformance gates for every installation.

## Why it exists

- Pay for short-lived cloud capacity instead of idle CI machines.
- Remove GitHub-hosted control jobs entirely in serverless mode, or keep them short in the fallback mode.
- Give every job a fresh JIT runner container and dedicated Docker daemon while sharing at most one temporary VM.
- Limit cleanup blast radius with ownership labels, per-run state, and an independent TTL sweep.
- Keep application workflows independent from the runner provider implementation.

## Architecture

```text
GitHub queues one or two trusted workflow jobs
  -> Cloudflare webhook + Queue + Durable Object
  -> at most one Hetzner VM per pool ID
  -> one disposable runner + DinD pair per job (maximum two)
  -> completed events remove JIT records and job containers
  `-> 10-minute idle release + Durable Object alarm + Cron TTL sweep delete the host
```

The JIT configuration is never placed in cloud-init, infrastructure state, or workflow artifacts. The elastic pool pulls a repository-built runner image by immutable digest; that image verifies the official GitHub runner archive against GitHub's published SHA-256 digest while building.

The Hetzner image installs Docker with Compose v2, GitHub CLI, ShellCheck, PHP CLI, Python 3, and a native build toolchain. The official runner dependency installer runs before registration. The unprivileged `runner` user is not granted sudo access.

Need another shell, language runtime, or system library? The runner image is deliberately built from a small, readable cloud-init file. See [Customize the runner image](docs/custom-runner-image.md) for safe package-list changes, Bash/Zsh/Fish examples, third-party repository guidance, custom images, and validation steps.

Need concurrent jobs or an always-on controller? See [Operate the controller](docs/controller-operations.md) for the scale-to-zero pool, isolation boundary, concurrency sizing, compatibility controller, log retention, and recovery checks. Release pipelines should also adopt the [Release control contract](docs/release-control-contract.md).

## Choose an operating mode

| Mode | GitHub-hosted minutes | Best for | Trade-off |
| --- | ---: | --- | --- |
| GitHub control jobs | Two short hosted jobs; self-hosted workload is not a hosted job | Stable migration fallback | Hosted jobs are rounded and require a short-lived state artifact |
| External polling controller | 0 | Compatibility and constrained accounts | Needs a trusted always-on controller host |
| Cloudflare scale-to-zero pool | 0 | Cost-sensitive private repositories with short bursts of trusted jobs | One temporary host runs at most two disposable runner containers; each installation must pass live-cloud conformance |

After a verified cutover, the Cloudflare adapter removes the two rounded GitHub-hosted control jobs while retaining the fallback implementation for an explicit, reviewed rollback. Start with [Production cutover](docs/production-cutover.md) and keep the old and new flows from running for the same commit.

## Cloudflare serverless controller

The first serverless adapter is implemented with a verified GitHub App `workflow_job` webhook, Cloudflare Queues, a singleton SQLite Durable Object, Durable Object alarms, Cron reconciliation, and the direct Hetzner Cloud API compute adapter.

In the recommended `hetzner-pool` mode it creates at most one SSH-free, deny-inbound host for an explicit pool ID. The host verifies a pinned pool agent and immutable runner/DinD images, enrolls from its provider-assigned IPv4, and accepts at most two jobs. Each job receives a new JIT registration, network, runner container, and Docker daemon. The host is deleted after 10 minutes with no active controller job; Cron/provider TTL remains independent backstop cleanup.

Cloudflare-controlled jobs include both `jit-runner` and `"jit-run-${{ github.run_id }}"`. The repository-scoped mode is the least-privilege default and supports private repositories owned by either a user or an organization: the App is installed only on served repositories, and the controller re-reads the exact workflow run and job before provisioning and before issuing JIT configuration. Organization scope is optional and adds a private runner group restricted to the exact trusted workflows. In both modes the controller accepts only configured push or manual events from the source repository, protected branches, pinned workflow paths, and exactly one matching queued JIT job.

Start with the complete [Cloudflare controller deployment and canary guide](docs/cloudflare-controller.md), then follow the [production cutover runbook](docs/production-cutover.md). Keep production workflows on the existing adapter until success, failure, cancellation, two-job concurrency, idle release, retry/DLQ, and TTL gates all pass for your installation. The final independent provider inventory must report zero ephemeral and pool resources.

The committed Wrangler and GitHub App files are inert templates. `npm run preflight:cloudflare` rejects their placeholders for a live setup, while `npm run check:cloudflare-config` validates template consistency without contacting Cloudflare, GitHub, or Hetzner.

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
       runs-on: [self-hosted, linux, x64, jit-runner, "jit-run-${{ github.run_id }}"]
       steps:
         - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
         - run: ./your-ci-command
   ```

The controller polls only configured repositories and accepts only explicitly trusted events, source repositories, branches, branch-pinned workflow paths, and runs whose complete job inventory contains exactly one queued job with both the static and run-scoped label. It rejects all pull-request-derived events. It creates one VM per accepted job, waits for the JIT runner to deregister or reach its TTL, then deletes the GitHub runner record and cloud resources. GitHub JIT-configuration throttling is retried according to GitHub's rate-limit response; the request runs before cloud provisioning so an API rejection does not create a billable VM. See [`examples/controller-config.json`](examples/controller-config.json) and [`examples/zero-hosted-minutes.yml`](examples/zero-hosted-minutes.yml).

In compatibility polling mode, `max_runners` still means one VM per job. In Cloudflare `hetzner-pool` mode, `MAX_RUNNERS=2` means one temporary CX33 and at most two disposable runner/DinD pairs.

## GitHub Actions control-job mode

If GitHub-hosted control jobs are available, the composite actions can provision and destroy a runner from a workflow. Pin the toolkit to a full commit SHA in production.

The full three-job example and the separate sweeper are in [`examples/github-actions.yml`](examples/github-actions.yml) and [`examples/ttl-sweeper.yml`](examples/ttl-sweeper.yml). The provision and cleanup jobs must not check out or execute untrusted application code. Set artifact retention to the shortest practical period. The state never contains JIT configuration, but the fallback currently renders a per-run SSH host key into sensitive OpenTofu state so the controller can pin the new VM before its first connection. Treat the state artifact as secret operational data and rely on cleanup plus short retention.

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

- Use the current design only for repositories and contributors you trust. Pool jobs have separate containers and Docker daemons but share the host kernel; this is not an adversarial tenant boundary.
- Keep public fork pull requests on GitHub-hosted or otherwise isolated, secret-free runners. This repository's own public quality job follows that pattern; JIT dogfooding is manual and disabled by default.
- Never expose runner-administration or deployment secrets to untrusted pull-request code.
- Keep runner VMs outside production networks and accounts.
- SSH is restricted to the controller's observed public IPv4 by default.
- Serverless mode has no SSH or local infrastructure state. The fallback mode uses a per-run SSH host key and stores its rendered private host key in sensitive OpenTofu state; protect and promptly delete that state. Neither mode stores JIT configuration in state.
- `if: always()` is not a cleanup guarantee. Run the TTL sweep independently.
- Ephemeral logs disappear with the VM. Forward diagnostics before using this for high-value releases.
- The polling controller is intentionally simple. The implemented provider-agnostic webhook architecture is documented in [Serverless controller architecture](docs/serverless-controller-architecture.md), with Cloudflare setup in [Deploy the Cloudflare controller](docs/cloudflare-controller.md).

Read the full [security policy](SECURITY.md) before operating the toolkit.

## Cost behavior

Hetzner bills while a server exists, including while it is powered off. Deleting the server and Primary IPv4 stops their respective usage billing. Very short server lifetimes are rounded to at least one hour. See the [Hetzner Cloud billing FAQ](https://docs.hetzner.com/cloud/billing/faq/).

The scale-to-zero pool converts several jobs in the same burst into one minimum-billed host hour instead of one minimum hour per job. `MAX_RUNNERS=2`, a ten-minute idle window, ready PRs with one consolidated push, and `concurrency.cancel-in-progress: true` on non-release CI are the recommended cost controls. A JIT runner still accepts exactly one job; reuse exists only at the temporary host/image layer.

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
