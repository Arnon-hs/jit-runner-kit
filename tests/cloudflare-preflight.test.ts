import { describe, expect, it } from "vitest";
import {
  readJsonc,
  validateCloudflareConfig,
  validateGithubAppManifest,
} from "../scripts/cloudflare-preflight.mjs";

const configPath = new URL("../packages/adapter-controller-cloudflare/wrangler.jsonc", import.meta.url);
const repositoryManifestPath = new URL("../examples/github-app-repository-manifest.json", import.meta.url);
const organizationManifestPath = new URL("../examples/github-app-manifest.json", import.meta.url);
const productionTrustSetPath = new URL("../examples/production-controller-trust-set.json", import.meta.url);

describe("Cloudflare deployment preflight", () => {
  it("keeps the committed deployment templates internally consistent", async () => {
    const config = await readJsonc(configPath);
    const manifest = await readJsonc(repositoryManifestPath);
    expect(validateCloudflareConfig(config, { template: true })).toEqual([]);
    expect(validateGithubAppManifest(manifest, { template: true, runnerScope: "repository" })).toEqual([]);
  });

  it("rejects placeholders in a live deployment configuration", async () => {
    const config = await readJsonc(configPath);
    const manifest = await readJsonc(repositoryManifestPath);
    expect(validateCloudflareConfig(config)).toContain("ALLOWED_REPOSITORIES still contains a template placeholder");
    expect(validateGithubAppManifest(manifest, { runnerScope: "repository" })).toContain("GitHub App webhook URL still contains a template placeholder");
  });

  it("accepts a complete organization-scoped canary configuration without contacting providers", async () => {
    const config = structuredClone(await readJsonc(configPath));
    config.vars.RUNNER_SCOPE = "organization";
    config.vars.GITHUB_ORGANIZATION = "example-org";
    config.vars.ALLOWED_REPOSITORIES = "example-org/example-repo";
    config.vars.TRUSTED_WORKFLOWS = "example-org/example-repo/.github/workflows/ci.yml@refs/heads/main";
    config.vars.PUBLIC_BASE_URL = "https://jit-controller.example-org.workers.dev";
    const manifest = structuredClone(await readJsonc(organizationManifestPath));
    manifest.hook_attributes.url = "https://jit-controller.example-org.workers.dev/webhooks/github";
    expect(validateCloudflareConfig(config)).toEqual([]);
    expect(validateGithubAppManifest(manifest, { runnerScope: "organization" })).toEqual([]);
  });

  it("accepts a bounded multi-repository production trust set", async () => {
    const config = structuredClone(await readJsonc(configPath));
    const production = await readJsonc(productionTrustSetPath);
    Object.assign(config.vars, production);
    config.vars.GITHUB_ORGANIZATION = "example-org";
    config.vars.PUBLIC_BASE_URL = "https://jit-controller.example-org.workers.dev";

    expect(validateCloudflareConfig(config)).toEqual([]);
    expect(production.MAX_RUNNERS).toBe("2");
    expect(production.ALLOWED_REPOSITORIES.split(",")).toHaveLength(3);
    expect(production.TRUSTED_BRANCHES).toBe("main,master");
    expect(production.TRUSTED_WORKFLOWS).toContain(
      "example-org/example-schema/.github/workflows/release.yml@refs/heads/main",
    );
    expect(production.TRUSTED_WORKFLOWS).toContain(
      "example-org/example-media/.github/workflows/deploy.yml@refs/heads/master",
    );
  });

  it("rejects legacy Durable Object migrations and workflow scope drift", async () => {
    const config = structuredClone(await readJsonc(configPath));
    delete config.exports;
    config.migrations = [{ tag: "v1", new_sqlite_classes: ["ControllerDurableObject"] }];
    config.vars.TRUSTED_WORKFLOWS = "other/repository/.github/workflows/ci.yml@refs/heads/main";
    const issues = validateCloudflareConfig(config, { template: true });
    expect(issues).toContain("use declarative exports instead of legacy Durable Object migrations");
    expect(issues).toContain("exports.ControllerDurableObject must be a SQLite durable-object");
    expect(issues).toContain("trusted workflow repository is not allowlisted: other/repository");
  });

  it("validates the bounded shared-host pool configuration", async () => {
    const config = structuredClone(await readJsonc(configPath));
    config.vars.COMPUTE_MODE = "shared-host";
    config.vars.POOL_HOST_ID = "pool-fsn1-1";
    config.vars.POOL_HOST_IPV4 = "192.0.2.10";
    config.vars.MAX_RUNNERS = "2";
    expect(validateCloudflareConfig(config, { template: true })).toEqual([]);

    config.vars.POOL_HOST_IPV4 = "not-an-ip";
    config.vars.MAX_RUNNERS = "3";
    expect(validateCloudflareConfig(config, { template: true })).toEqual(expect.arrayContaining([
      "POOL_HOST_IPV4 is invalid for shared-host mode",
      "MAX_RUNNERS must be between 1 and 2",
    ]));
  });

  it("requires immutable fast-bootstrap inputs for an elastic Hetzner pool", async () => {
    const config = structuredClone(await readJsonc(configPath));
    config.vars.COMPUTE_MODE = "hetzner-pool";
    config.vars.MAX_RUNNERS = "2";
    config.vars.POOL_IDLE_SECONDS = "600";
    config.vars.POOL_ID = "canary";
    config.vars.POOL_AGENT_URL = "https://raw.githubusercontent.com/owner/repository/0123456789012345678901234567890123456789/bin/agent";
    config.vars.POOL_AGENT_SHA256 = "a".repeat(64);
    config.vars.POOL_RUNNER_IMAGE = `ghcr.io/owner/runner@sha256:${"b".repeat(64)}`;
    config.vars.POOL_DIND_IMAGE = `docker:27-dind@sha256:${"c".repeat(64)}`;
    config.vars.POOL_BOOTSTRAP_SSH_PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ7l5EFHZL3IS+N33HkgonD7hi6RCRtjKSo4EHJxKetI jrk-bootstrap-inert";
    expect(validateCloudflareConfig(config, { template: true })).toEqual([]);

    config.vars.POOL_IDLE_SECONDS = "60";
    config.vars.POOL_RUNNER_IMAGE = "ghcr.io/owner/runner:latest";
    config.vars.POOL_BOOTSTRAP_SSH_PUBLIC_KEY = "ssh-rsa not-an-ed25519-key";
    expect(validateCloudflareConfig(config, { template: true })).toEqual(expect.arrayContaining([
      "POOL_IDLE_SECONDS must be between 300 and 3600 in hetzner-pool mode",
      "POOL_RUNNER_IMAGE must use an immutable digest in hetzner-pool mode",
      "POOL_BOOTSTRAP_SSH_PUBLIC_KEY must be a single OpenSSH Ed25519 public key in hetzner-pool mode",
    ]));
  });
});
