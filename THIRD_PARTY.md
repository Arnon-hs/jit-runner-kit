# Third-party software and license notes

The project source is licensed under MIT. It does not vendor the source of the tools below; operators and builds download or invoke them, and the pool image redistributes the components explicitly noted. This inventory is technical compliance information, not legal advice.

| Component | Use | License evidence | Distribution note |
| --- | --- | --- | --- |
| GitHub Actions runner | Downloaded onto each temporary VM at runtime | [MIT](https://github.com/actions/runner/blob/main/LICENSE) | Archive digest is verified; not committed to this repository. |
| GitHub CLI | Downloaded into the published pool runner image | [MIT](https://github.com/cli/cli/blob/trunk/LICENSE) | Version and per-architecture archive digests are pinned; the upstream license is retained at `/usr/share/doc/gh/LICENSE` in the image. |
| Hetzner Cloud provider | Downloaded by OpenTofu or Terraform | [MPL-2.0](https://github.com/hetznercloud/terraform-provider-hcloud/blob/main/LICENSE) | Provider binary is not vendored. The lock file records checksums. |
| OpenTofu setup action | Installs the default IaC CLI in Actions mode | [MPL-2.0](https://github.com/opentofu/setup-opentofu/blob/main/LICENSE) | Referenced workflow dependency, not redistributed here. |
| HashiCorp setup action | Optional Terraform installation path | [MPL-2.0](https://github.com/hashicorp/setup-terraform/blob/main/LICENSE) | Referenced only when `iac-engine: terraform` is selected. |
| Terraform 1.6+ | Optional operator CLI | [Business Source License 1.1](https://github.com/hashicorp/terraform/blob/main/LICENSE) | Source-available, not OSI open source. It is not bundled; OpenTofu is the default. |
| GitHub checkout/upload/download actions | Example and control-job workflow dependencies | MIT: [checkout](https://github.com/actions/checkout/blob/main/LICENSE), [upload](https://github.com/actions/upload-artifact/blob/main/LICENSE), [download](https://github.com/actions/download-artifact/blob/main/LICENSE) | Referenced actions, not vendored. |
| Cloudflare Wrangler and Workers types | Development, dry-run bundling, and Worker deployment | [MIT OR Apache-2.0](https://github.com/cloudflare/workers-sdk/blob/main/LICENSE-APACHE) | Development dependencies recorded in `package-lock.json`; not shipped to runner VMs. |
| TypeScript | Compile-time validation of controller packages | [Apache-2.0](https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt) | Development dependency only. |
| Vitest | Serverless core and adapter conformance tests | [MIT](https://github.com/vitest-dev/vitest/blob/main/LICENSE) | Development dependency only. |
| Contributor Covenant 3.0 | Community conduct policy | [CC BY-SA 4.0](https://www.contributor-covenant.org/version/3/0/) | Attribution is preserved in `CODE_OF_CONDUCT.md`. |

Ubuntu packages installed on runner VMs are obtained from the distribution repositories and are not redistributed by this source repository. Operators who publish custom VM images or redistribute bundled artifacts must perform a separate image-level license inventory.

When adding a dependency, record its exact source, license, use mode, and whether any binary, source, notice, or asset is redistributed. Preserve upstream license and NOTICE files when required.
