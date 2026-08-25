export function readJsonc(path: URL | string): Promise<Record<string, any>>;
export function validateCloudflareConfig(
  config: Record<string, any>,
  options?: { template?: boolean },
): string[];
export function validateGithubAppManifest(
  manifest: Record<string, any>,
  options?: { template?: boolean; runnerScope?: "organization" | "repository" },
): string[];
