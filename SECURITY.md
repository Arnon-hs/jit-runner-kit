# Security policy

## Supported versions

The project is pre-1.0. Security fixes are evaluated for the latest `0.1.x` release and the current `main` branch.

| Version | Supported |
| --- | --- |
| `0.1.x` | Yes |
| Earlier snapshots | No |

## Reporting a vulnerability

Do not open a public issue. Use the repository's private vulnerability reporting form under **Security → Advisories → Report a vulnerability** and include:

- the affected commit or version;
- a minimal reproduction;
- expected impact and required privileges;
- whether credentials or cloud resources may have been exposed;
- a safe way to coordinate follow-up.

The maintainer aims to acknowledge a complete report within five business days. This is a volunteer, pre-1.0 project and not a guaranteed SLA. Please allow time for a private fix before public disclosure.

## Operator responsibilities

- Scope the Hetzner token to a dedicated CI project.
- Scope the GitHub token to only the repositories that need runners and grant only Actions read and repository Administration write.
- In serverless mode, prefer a GitHub App installed only on served repositories. Store its private key, webhook secret, and the Hetzner token only as encrypted Worker secrets.
- Keep `ALLOWED_REPOSITORIES` and `TRUSTED_BRANCHES` explicit. Pull-request workloads are rejected by the Cloudflare adapter, including same-repository pull requests.
- Keep `RUN_LABEL_PREFIX` non-empty and include `jit-run-${{ github.run_id }}` in every Cloudflare-controlled job. A shared static runner label alone does not bind a GitHub JIT runner to one queued workflow run.
- Expose the bootstrap endpoint only over HTTPS. It accepts one hashed, single-use token and verifies the VM's observed public IPv4 before issuing JIT configuration.
- Never expose the provisioning path or privileged secrets to untrusted pull-request code.
- Keep runner VMs outside production networks and accounts.
- Keep the TTL sweeper independent from workload jobs.
- Pin action dependencies and released toolkit versions before production use.
- Forward runner diagnostics to protected external storage when release auditability matters.

Do not include credentials, runner JIT configuration, infrastructure state, cloud identifiers, private repository names, or a working exploit in public logs or issues.
