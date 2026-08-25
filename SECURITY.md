# Security policy

## Supported versions

The project is pre-1.0. Security fixes are evaluated for the latest `0.2.x` release and the current `main` branch.

| Version | Supported |
| --- | --- |
| `0.2.x` | Yes |
| `0.1.x` | No |
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
- In control-job mode, scope the GitHub token to only the repositories that need runners and grant only the documented runner-administration permissions.
- In serverless mode, require a private GitHub App installed only on served repositories. Use repository **Actions: read**, **Administration: write**, and **Metadata: read** permissions for repository scope. For organization scope, use organization **Self-hosted runners: write** and a dedicated private runner group restricted to the exact trusted workflows. Store the App private key, webhook secret, and Hetzner token only as encrypted Worker secrets.
- Keep `ALLOWED_REPOSITORIES`, `TRUSTED_EVENTS`, `TRUSTED_BRANCHES`, and branch- or SHA-pinned `TRUSTED_WORKFLOWS` explicit. Pull-request workloads are rejected by the Cloudflare adapter, including same-repository pull requests.
- Keep `RUN_LABEL_PREFIX` non-empty and include `jit-run-${{ github.run_id }}` in every Cloudflare-controlled job, but treat labels only as routing defense in depth. They do not bind a GitHub JIT runner to a job ID.
- Keep exactly one matching queued JIT job per run. The adapter revalidates the GitHub run and job immediately before JIT issuance.
- In organization scope, keep public-repository access disabled on the serverless runner group and make its selected workflow set exactly match `TRUSTED_WORKFLOWS`. The adapter fails closed if that policy drifts.
- Keep the public rate-limit binding enabled. Do not raise the 1 MiB webhook body limit or weaken pre-dispatch bootstrap path/token validation without a security review.
- Expose bootstrap, pool enrollment, claim, and release endpoints only over HTTPS. Keep `POOL_ENROLLMENT_TOKEN` and `POOL_HOST_TOKEN` independent 32-byte base64url Worker secrets. Enrollment and every claim/release are bound to Cloudflare's observed provider-host IPv4.
- Never expose the provisioning path or privileged secrets to untrusted pull-request code.
- Keep runner VMs outside production networks and accounts.
- Treat scale-to-zero pool containers as operational isolation for mutually trusted workloads, not hostile multi-tenancy. Jobs get separate networks and DinD daemons but share a VM kernel. Use the one-VM-per-job adapter when that boundary is insufficient.
- Pin the pool agent by immutable commit plus SHA-256 and both runner/DinD images by registry digest. Never mount the host Docker socket, enrollment token, host token, or Worker secrets into a workload container.
- Keep the TTL sweeper independent from workload jobs.
- Pin action dependencies and released toolkit versions before production use.
- In the SSH fallback, preserve strict host-key checking and protect the short-lived state artifact as secret operational data because it contains the rendered per-run SSH host private key. Serverless mode does not use SSH.
- Forward runner diagnostics to protected external storage when release auditability matters.

Do not include credentials, runner JIT configuration, infrastructure state, cloud identifiers, private repository names, or a working exploit in public logs or issues.
