# jit-runner-kit

[![Status: pre-1.0 pilot](https://img.shields.io/badge/status-pre--1.0%20pilot-orange)](ROADMAP.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![OpenTofu](https://img.shields.io/badge/IaC-OpenTofu-ffda18)](https://opentofu.org/)

Create a clean, one-job GitHub Actions runner on demand and delete its cloud resources afterward.

`jit-runner-kit` is for maintainers of trusted repositories who want elastic self-hosted runners without keeping an expensive build server online. The public interface is repository-independent and contains no application deployment logic. Hetzner Cloud is the first provider driver; the provider interface is intentionally small so more drivers can be added later.

> **Project status:** pre-1.0 pilot. The security model is documented, the local and infrastructure checks pass, but the first real-cloud end-to-end run is still pending. Do not treat the current branch as production-stable.

## Why it exists

- Pay for short-lived cloud capacity instead of idle CI machines.
- Spend zero GitHub-hosted minutes by running the controller outside GitHub Actions.
- Give every job a fresh VM and a GitHub just-in-time (JIT) runner registration.
- Limit cleanup blast radius with ownership labels, per-run state, and an independent TTL sweep.
- Keep application workflows independent from the runner provider implementation.

## Architecture

```text
queued job with label "jit-runner"
              |
              v
external controller polls GitHub
              |
              v
OpenTofu/Terraform -> temporary Hetzner VM + firewall + IPv4 + SSH key
              |
              v
JIT configuration streamed over SSH -> one GitHub Actions job
              |
              v
runner deregisters -> controller destroys resources -> TTL sweep is the backstop
```

The JIT configuration is never placed in cloud-init, infrastructure state, or workflow artifacts. The runner package is resolved from the latest official GitHub release and its published SHA-256 digest is verified before extraction.

The Hetzner image installs Docker with Compose v2, GitHub CLI, ShellCheck, Python 3, and a native build toolchain. The official runner dependency installer runs before registration. The unprivileged `runner` user is not granted sudo access.

## Choose an operating mode

| Mode | GitHub-hosted minutes | Best for | Trade-off |
| --- | ---: | --- | --- |
| External controller | 0 | Tight Actions budgets and normal operation | Needs a small always-on controller host |
| Workflow provision/cleanup actions | Two hosted control jobs plus the workload | Evaluation and simple integrations | Still depends on GitHub-hosted jobs and artifact handoff |

The external controller is the recommended mode when the account cannot start GitHub-hosted jobs.

## Requirements

Controller host:

- Linux or macOS with `bash`, `curl`, `jq`, `ssh`, and `ssh-keygen`
- OpenTofu 1.7+ (recommended) or Terraform 1.7+
- a dedicated Hetzner Cloud project token
- a GitHub fine-grained token scoped to the target repositories with **Actions: read** and **Administration: write**

The normal workflow `GITHUB_TOKEN` usually cannot generate repository JIT configurations. Keep runner administration credentials separate from application and deployment secrets.

## Quickstart: zero hosted minutes

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

The controller polls only configured repositories and reacts only to queued jobs containing its trigger label. It creates one VM per job, waits for the JIT runner to deregister or reach its TTL, then deletes the GitHub runner record and cloud resources. See [`examples/controller-config.json`](examples/controller-config.json) and [`examples/zero-hosted-minutes.yml`](examples/zero-hosted-minutes.yml).

## GitHub Actions control-job mode

If GitHub-hosted control jobs are available, the composite actions can provision and destroy a runner from a workflow. Pin the toolkit to an immutable release tag or commit SHA in production.

While this repository is private, allow other private repositories owned by the same account to use its actions:

```bash
gh api --method PUT \
  repos/OWNER/jit-runner-kit/actions/permissions/access \
  -f access_level=user
```

This shares action code, not caller secrets. The full three-job example and the separate sweeper are in [`examples/github-actions.yml`](examples/github-actions.yml) and [`examples/ttl-sweeper.yml`](examples/ttl-sweeper.yml).

The actions use OpenTofu by default. Set `iac-engine: terraform` on both `provision` and `destroy` if Terraform is required.

## Local CLI

```bash
export HCLOUD_TOKEN='...'
export JIT_RUNNER_GITHUB_TOKEN='...'

bin/jit-runner provision \
  --repository owner/private-repo \
  --run-id manual-001 \
  --state-dir .jit-runner-state/manual-001

bin/jit-runner destroy \
  --state-dir .jit-runner-state/manual-001

bin/jit-runner sweep --dry-run
bin/jit-runner sweep
```

`provision` prints machine-readable `key=value` outputs and also writes them to `$GITHUB_OUTPUT` when available. Set `JIT_RUNNER_IAC_CMD=terraform` to override the default OpenTofu-first auto-detection.

## Trust and failure boundaries

- Use the current design only for repositories and contributors you trust. A workflow job fully controls its runner VM.
- Never expose runner-administration or deployment secrets to untrusted pull-request code.
- Keep runner VMs outside production networks and accounts.
- SSH is restricted to the controller's observed public IPv4 by default.
- Infrastructure state contains cloud resource metadata and an SSH public key, but no private key or JIT configuration.
- `if: always()` is not a cleanup guarantee. Run the TTL sweep independently.
- Ephemeral logs disappear with the VM. Forward diagnostics before using this for high-value releases.
- The polling controller is intentionally simple. A webhook-driven, horizontally safe controller is on the roadmap.

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

The project provisions ephemeral GitHub Actions JIT runners and cleans up their infrastructure. It does not deploy applications, manage application secrets, or provide a general-purpose CI scheduler. See [VISION.md](VISION.md) and [ROADMAP.md](ROADMAP.md).

## Support and community

- Ask usage questions in [GitHub Discussions](https://github.com/Arnon-hs/jit-runner-kit/discussions).
- Report reproducible bugs with the [bug template](https://github.com/Arnon-hs/jit-runner-kit/issues/new/choose).
- Read [SUPPORT.md](SUPPORT.md) before opening a support request.
- Read [CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before contributing.
- Report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

Licensed under the [MIT License](LICENSE).
