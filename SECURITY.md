# Security policy

Please report vulnerabilities privately to the repository maintainer. Do not open a public issue containing credentials, runner JIT configuration, Terraform state, cloud resource identifiers, or a working exploit.

Supported releases and a private reporting address will be published before the first public release.

## Operator responsibilities

- Scope the Hetzner token to a dedicated CI project.
- Scope the GitHub token to only the repositories that need runners and grant only repository Administration write.
- Never expose the provisioning workflow to untrusted pull-request code.
- Keep the TTL sweeper independent from workload jobs.
- Review and pin the toolkit version before production use.

