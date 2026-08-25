# Customize the runner image

The one-VM-per-job compatibility runner starts from Ubuntu 24.04 and is prepared by [`providers/hetzner/cloud-init.yaml`](../providers/hetzner/cloud-init.yaml). The recommended scale-to-zero pool uses [`providers/shared-host/Dockerfile.runner`](../providers/shared-host/Dockerfile.runner) instead. Change the file for the operating mode you actually deploy when every runner needs another Ubuntu package, command shell, language runtime, or system library.

Keep application-specific setup in the application workflow when it benefits from an official, checksum-aware setup action or must vary between jobs. Put stable operating-system dependencies in cloud-init when downloading them for every workflow would be slower or less reliable.

## Add Ubuntu packages

For the compatibility VM, add package names to the cloud-init `packages` list. For the pool image, add them to the `apt-get install --yes --no-install-recommends` list in `Dockerfile.runner`. Both install as root before the JIT runner starts.

```yaml
packages:
  - build-essential
  - ca-certificates
  - curl
  - git
  - jq
  - php-cli
  - python3
  - python3-venv
  - ruby-full
  - shellcheck
  - unzip
  - zsh
```

Use package names available for the selected Ubuntu release and CPU architecture. Confirm availability before provisioning:

```bash
docker run --rm ubuntu:24.04 bash -lc \
  'apt-get update >/dev/null && apt-cache policy zsh python3-venv ruby-full'
```

Then run the repository checks:

```bash
make check
```

If `cloud-init` is installed locally, also validate the document itself:

```bash
cloud-init schema --config-file providers/hetzner/cloud-init.yaml
```

Test at least one real ephemeral runner before relying on a new package in a release workflow. A container package check does not prove that cloud-init completed successfully on the selected cloud image.

## Change the runner user's shell

First install the shell, then set its absolute path in the `runner` user definition.

Zsh:

```yaml
packages:
  - zsh

users:
  - default
  - name: runner
    groups:
      - docker
    shell: /usr/bin/zsh
    lock_passwd: true
```

Fish:

```yaml
packages:
  - fish

users:
  - default
  - name: runner
    groups:
      - docker
    shell: /usr/bin/fish
    lock_passwd: true
```

For the pool image, install the shell in `Dockerfile.runner` and pass `--shell /usr/bin/zsh` (or Fish) to `useradd`. This changes the login shell for the `runner` account. A GitHub Actions `run:` step still uses the workflow's configured shell, or the platform default, so request a non-default shell explicitly when needed:

```yaml
- name: Run with Zsh
  shell: zsh {0}
  run: |
    print -r -- "Running under ${ZSH_VERSION}"
```

For repository-wide workflow behavior, use [`defaults.run.shell`](https://docs.github.com/actions/writing-workflows/workflow-syntax-for-github-actions#defaultsrun) rather than relying only on the account login shell.

## Add setup commands

Use cloud-init `runcmd` for short, deterministic host setup that cannot be expressed as an Ubuntu package:

```yaml
runcmd:
  - systemctl enable --now docker
  - install -d -o runner -g runner /opt/actions-runner
  - install -d -o runner -g runner /opt/tool-cache
```

Avoid piping an unauthenticated remote script into a privileged shell. Prefer Ubuntu packages. Otherwise, pin the tool version, download over HTTPS from its official release location, verify a published checksum or signature, and only then install it.

Do not place GitHub tokens, cloud credentials, JIT configuration, or application secrets in cloud-init. Cloud providers can retain user-data, and local infrastructure state must be treated as operational metadata rather than a secret transport.

## Publish the pool runner image

The repository's `Runner image` workflow builds `providers/shared-host/Dockerfile.runner` after a relevant merge to `main` and pushes a commit-tagged image to GHCR. Record the workflow's `image@sha256:...` identity and put that exact digest in `POOL_RUNNER_IMAGE`; never configure a mutable tag in the Worker.

Forks can keep the workflow and change only its lowercase `IMAGE` value. Add shells, PHP extensions, Node/Python/Ruby runtimes, databases clients, or OS libraries to the Dockerfile, then run a ready PR through the normal quality and security review. After merge, use the new digest in a Worker revision and repeat success/failure cleanup canaries before production use.

## Use a prebuilt VM image

When setup becomes large or changes infrequently, bake and harden a custom Hetzner snapshot instead of expanding cloud-init indefinitely. Pass its image identifier through the existing controller or CLI `image` setting.

Controller configuration:

```json
{
  "image": "123456789"
}
```

CLI:

```bash
bin/jit-runner provision \
  --repository owner/repository \
  --image 123456789
```

Keep the snapshot free of runner registrations and credentials. Patch and rebuild it on a regular cadence, record its source and version, and retain cloud-init for the small amount of per-VM initialization.

## Choose the right layer

| Requirement | Recommended layer |
| --- | --- |
| Common Ubuntu library in the elastic pool | `Dockerfile.runner` apt list |
| Common Ubuntu library in compatibility VMs | `cloud-init.yaml` package list |
| Different login shell in pool containers | Dockerfile package plus `useradd --shell` |
| Different login shell in compatibility VMs | Package list plus `users.runner.shell` |
| Per-repository language or version | Pinned GitHub setup action in that workflow |
| Large, stable toolchain | Hardened custom cloud image |
| Token or deployment credential | GitHub secret injected only into the required step |

After any image change, verify successful, failed, and cancelled jobs. In pool mode also verify two concurrent disposable containers on at most one VM, then zero servers, Primary IPv4s, firewalls, SSH keys, and GitHub runner records after the idle window.
