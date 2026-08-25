# Contributing

Thanks for helping improve `jit-runner-kit`. The project is pre-1.0, so discussing material behavior changes before implementation saves everyone time.

## Before opening a pull request

- Use an issue or discussion for new providers, public interface changes, security-boundary changes, or breaking behavior.
- Small documentation fixes and focused bug fixes may go directly to a pull request.
- Do not include real tokens, JIT configuration, infrastructure state, private keys, private repository names, or cloud identifiers in tests, logs, screenshots, or commits.

## Development setup

Prerequisites:

- Bash 3.2 or newer
- `curl`, `jq`, `ssh`, and `ssh-keygen`
- ShellCheck
- OpenTofu 1.7+ (recommended) or Terraform 1.7+
- Node.js 22 and npm for the provider-agnostic core and serverless adapters

Run all checks:

```bash
git clone https://github.com/Arnon-hs/jit-runner-kit.git
cd jit-runner-kit
npm ci
make check
```

To validate with Terraform instead of OpenTofu:

```bash
make IAC=terraform check
```

The tests mock GitHub, Cloudflare, and Hetzner boundaries and must not create real cloud resources. `npm run build:cloudflare` performs a Wrangler dry-run bundle only.

## Change expectations

- Keep shell scripts compatible with Bash 3.2 unless a version change is discussed first.
- Pass ShellCheck and the mocked CLI tests.
- Run infrastructure formatting and validation for provider changes.
- Update examples and documentation when public behavior changes.
- Add a regression test for bug fixes when practical.
- Preserve explicit cleanup ownership labels and the TTL backstop.
- Avoid adding dependencies when a small, testable shell implementation is sufficient.
- Keep Cloudflare bindings and Hetzner/GitHub HTTP models out of `packages/core` and `packages/contracts`.
- Add port-level conformance tests when introducing a controller, state, queue, secret, clock, or compute adapter.

## Commits and pull requests

Use short, imperative commit subjects such as `fix: retain cleanup metadata`. Conventional prefixes such as `feat:`, `fix:`, `docs:`, `test:`, and `chore:` are encouraged but not required.

A pull request should explain:

1. the problem and intended behavior;
2. the security and cleanup impact;
3. how the change was tested;
4. any compatibility or migration concern.

Maintainers review on a best-effort basis. A lack of response is not approval. Breaking changes require an issue or design discussion and may be deferred until a versioned release plan exists.

## Security reports

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).

By participating, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
