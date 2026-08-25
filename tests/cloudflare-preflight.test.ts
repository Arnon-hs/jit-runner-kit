import { describe, expect, it } from "vitest";
import {
  readJsonc,
  validateCloudflareConfig,
  validateGithubAppManifest,
} from "../scripts/cloudflare-preflight.mjs";

const configPath = new URL("../packages/adapter-controller-cloudflare/wrangler.jsonc", import.meta.url);
const manifestPath = new URL("../examples/github-app-manifest.json", import.meta.url);

describe("Cloudflare deployment preflight", () => {
  it("keeps the committed deployment templates internally consistent", async () => {
    const config = await readJsonc(configPath);
    const manifest = await readJsonc(manifestPath);
    expect(validateCloudflareConfig(config, { template: true })).toEqual([]);
    expect(validateGithubAppManifest(manifest, { template: true })).toEqual([]);
  });

  it("rejects placeholders in a live deployment configuration", async () => {
    const config = await readJsonc(configPath);
    const manifest = await readJsonc(manifestPath);
    expect(validateCloudflareConfig(config)).toContain("GITHUB_ORGANIZATION still contains a template placeholder");
    expect(validateGithubAppManifest(manifest)).toContain("GitHub App webhook URL still contains a template placeholder");
  });

  it("accepts a complete organization-scoped canary configuration without contacting providers", async () => {
    const config = structuredClone(await readJsonc(configPath));
    config.vars.GITHUB_ORGANIZATION = "example-org";
    config.vars.ALLOWED_REPOSITORIES = "example-org/example-repo";
    config.vars.TRUSTED_WORKFLOWS = "example-org/example-repo/.github/workflows/ci.yml@refs/heads/main";
    config.vars.PUBLIC_BASE_URL = "https://jit-controller.example-org.workers.dev";
    const manifest = structuredClone(await readJsonc(manifestPath));
    manifest.hook_attributes.url = "https://jit-controller.example-org.workers.dev/webhooks/github";
    expect(validateCloudflareConfig(config)).toEqual([]);
    expect(validateGithubAppManifest(manifest)).toEqual([]);
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
});
