# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from its first public tag.

## [Unreleased]

## [0.1.0] - 2026-08-25

### Added

- GitHub Actions provision and destroy actions for one-job ephemeral runners.
- A compatibility polling controller with repository allowlists and bounded concurrency.
- Hetzner Cloud provisioning through OpenTofu or Terraform.
- Independent TTL sweeping, recovery cleanup, and managed-resource inventory.
- Custom runner image guidance for packages, shells, language runtimes, and prebuilt images.
- An accepted provider-agnostic serverless architecture with Cloudflare as the first controller adapter and Hetzner as the first compute adapter.
- OSS governance, security, contribution, support, and maintenance documentation.

### Security

- JIT configuration is delivered over SSH after provisioning and is excluded from cloud-init, infrastructure state, and workflow artifacts.
- Per-run ownership labels, rollback-safe provisioning, runner-record deletion, and two-path cleanup limit orphaned resources.
- Official GitHub runner archives are verified against their published SHA-256 digest.

[Unreleased]: https://github.com/Arnon-hs/jit-runner-kit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Arnon-hs/jit-runner-kit/releases/tag/v0.1.0
