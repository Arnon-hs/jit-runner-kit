# jit-runner-kit

Create a clean, one-job GitHub Actions runner on demand, run any job on it, and delete the cloud resources afterwards.

The toolkit is repository-agnostic. It contains no application deployment logic. The first infrastructure driver targets Hetzner Cloud; the public CLI and action interface is intentionally small so another provider can be added without changing consumer jobs.

## What it does

1. Terraform creates a temporary VM, Primary IPv4, firewall, and one-time SSH key.
2. The controller asks GitHub for a just-in-time runner configuration.
3. The configuration is streamed over SSH and is never written to Terraform state or cloud-init.
4. GitHub assigns exactly one job to the ephemeral runner.
5. A cleanup job destroys the Terraform resources.
6. A separate TTL sweep removes resources left behind by cancellation or controller failure.

GitHub recommends ephemeral runners for autoscaling. Each runner accepts one job and automatically deregisters after that job: [GitHub self-hosted runner reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners).

## Requirements

- Terraform 1.7 or newer
- `bash`, `curl`, `jq`, `ssh`, and `ssh-keygen`
- a Hetzner Cloud project token
- a GitHub fine-grained token with **Administration: write** for the target repository

The normal workflow `GITHUB_TOKEN` usually cannot generate repository JIT configurations. Keep the runner-administration token separate from application and deployment secrets.

## GitHub Actions usage

Publish this repository and replace `your-org/jit-runner-kit` in the example below with its immutable release tag or commit SHA.

While the toolkit repository is private, allow other private repositories owned by the same account to use its actions:

```bash
gh api --method PUT \
  repos/OWNER/jit-runner-kit/actions/permissions/access \
  -f access_level=user
```

This grants workflow access to the action code; it does not share caller secrets with the toolkit repository.

```yaml
jobs:
  provision:
    runs-on: ubuntu-latest
    outputs:
      runner-label: ${{ steps.runner.outputs.runner-label }}
      state-dir: ${{ steps.runner.outputs.state-dir }}
    steps:
      - id: runner
        uses: your-org/jit-runner-kit/actions/provision@v1
        with:
          hcloud-token: ${{ secrets.HCLOUD_TOKEN }}
          github-token: ${{ secrets.JIT_RUNNER_GITHUB_TOKEN }}
          repository: ${{ github.repository }}
          server-type: cx33
          location: fsn1
      - uses: actions/upload-artifact@v4
        with:
          name: runner-state-${{ github.run_id }}-${{ github.run_attempt }}
          path: ${{ steps.runner.outputs.state-dir }}
          retention-days: 1

  workload:
    needs: provision
    runs-on: [self-hosted, linux, x64, "${{ needs.provision.outputs.runner-label }}"]
    steps:
      - uses: actions/checkout@v4
      - run: ./your-ci-command

  cleanup:
    if: ${{ always() }}
    needs: [provision, workload]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: runner-state-${{ github.run_id }}-${{ github.run_attempt }}
          path: ${{ runner.temp }}/jit-runner-state
      - uses: your-org/jit-runner-kit/actions/destroy@v1
        with:
          hcloud-token: ${{ secrets.HCLOUD_TOKEN }}
          state-dir: ${{ runner.temp }}/jit-runner-state
```

The complete consumer and sweeper examples are in [`examples/`](examples/).

## Zero GitHub-hosted minutes

If GitHub-hosted jobs are disabled by budget or billing, run the controller outside GitHub Actions. It can run on a developer machine, an always-on free VM, or a small controller VPS:

```bash
export HCLOUD_TOKEN=...
export JIT_RUNNER_GITHUB_TOKEN=...

bin/jit-runner-controller \
  --config /etc/jit-runner-kit/controller.json
```

The controller polls only configured repositories and reacts only to queued jobs containing its trigger label. A consumer workflow then needs a single job:

```yaml
jobs:
  ci:
    runs-on: [self-hosted, linux, x64, jit-runner]
    steps:
      - uses: actions/checkout@v4
      - run: ./your-ci-command
```

The controller creates the VM, waits for the one-job runner to deregister, and destroys the VM. No provisioning or cleanup job runs on GitHub-hosted infrastructure. See [`examples/controller-config.json`](examples/controller-config.json) and [`examples/zero-hosted-minutes.yml`](examples/zero-hosted-minutes.yml).

Use `--once --dry-run` to inspect matching queued jobs without creating cloud resources.

## Local CLI

```bash
export HCLOUD_TOKEN=...
export JIT_RUNNER_GITHUB_TOKEN=...

bin/jit-runner provision \
  --repository owner/private-repo \
  --run-id manual-001 \
  --state-dir .jit-runner-state/manual-001

bin/jit-runner destroy \
  --state-dir .jit-runner-state/manual-001

bin/jit-runner sweep
```

`provision` prints machine-readable `key=value` outputs and also writes them to `$GITHUB_OUTPUT` when it is available.

## Security and failure model

- Use only with repositories and contributors you trust. A workflow job can fully control its runner VM.
- The VM is dedicated to CI and must not share a network or credentials with production workloads.
- JIT configuration is streamed over SSH. It is not placed in cloud-init, Terraform variables, state, or artifacts.
- SSH is restricted to the controller's observed public IPv4 by default.
- Terraform state contains cloud resource metadata and an SSH public key, but no private SSH key or GitHub JIT configuration. Store the artifact only in the private caller workflow and retain it briefly.
- `if: always()` is not a complete cleanup guarantee. Run the TTL sweeper from a separately scheduled workflow.
- Ephemeral runner diagnostic logs disappear with the VM. Forward them to external storage before using the toolkit for high-value production pipelines.

## Cost behavior

Hetzner bills while a server exists, including while it is powered off. Deleting the server and Primary IPv4 stops their respective usage billing. Very short server lifetimes are rounded to at least one hour. See the [Hetzner Cloud billing FAQ](https://docs.hetzner.com/cloud/billing/faq/).

## Development

```bash
make check
```

No real cloud resource is created by the test suite.
