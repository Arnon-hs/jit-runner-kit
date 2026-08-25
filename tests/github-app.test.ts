import { describe, expect, it, vi } from "vitest";
import { GithubAppRunnerControl } from "../packages/adapter-github-app/src/index";
import { TerminalError } from "../packages/contracts/src/index";
import type { TrustedWorkflowJobEvent } from "../packages/contracts/src/index";

const workflow = "owner/repository/.github/workflows/ci.yml@refs/heads/main";
const event: TrustedWorkflowJobEvent = {
  deliveryId: "00000000-0000-4000-8000-000000000001",
  action: "queued",
  jobId: 101,
  runId: 51,
  installationId: 7,
  repository: { id: 3, fullName: "owner/repository" },
  headBranch: "main",
  labels: ["self-hosted", "jit-runner", "jit-run-51"],
};

describe("GitHub App runner control", () => {
  it("requires a private organization runner group restricted to the configured workflows", async () => {
    const fetcher = githubFetcher({ selected_workflows: [workflow] });
    const control = createControl(fetcher);
    await expect(control.assertRepositoryAccess(event)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.test/orgs/owner/actions/runner-groups/42",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects runner groups with broader workflow access", async () => {
    const fetcher = githubFetcher({
      selected_workflows: [workflow, "owner/other/.github/workflows/ci.yml@refs/heads/main"],
    });
    await expect(createControl(fetcher).assertRepositoryAccess(event)).rejects.toBeInstanceOf(TerminalError);
  });

  it("fails closed when GitHub omits a runner-group security field", async () => {
    const fetcher = githubFetcher({
      selected_workflows: [workflow],
      allows_public_repositories: undefined,
    });
    await expect(createControl(fetcher).assertRepositoryAccess(event)).rejects.toBeInstanceOf(TerminalError);
  });

  it("creates and deletes JIT runners through organization endpoints", async () => {
    const fetcher = githubFetcher({ selected_workflows: [workflow] });
    const control = createControl(fetcher);
    await expect(control.createJitConfiguration(event, "jit-101")).resolves.toEqual({
      encodedJitConfig: "encoded-jit-config",
      runnerId: 9001,
    });
    await control.deleteRunner(event, 9001);
    const urls = fetcher.mock.calls.map(([url]) => String(url));
    const groupIndex = urls.indexOf("https://api.github.test/orgs/owner/actions/runner-groups/42");
    const jitIndex = urls.indexOf("https://api.github.test/orgs/owner/actions/runners/generate-jitconfig");
    expect(groupIndex).toBeGreaterThanOrEqual(0);
    expect(jitIndex).toBeGreaterThan(groupIndex);
    expect(urls).toContain("https://api.github.test/orgs/owner/actions/runners/9001");
  });

  it("rejects workflow selectors that are not pinned to a branch or commit SHA", () => {
    expect(() => createControl(githubFetcher({ selected_workflows: [] }), [
      "owner/repository/.github/workflows/ci.yml",
    ])).toThrow("branch- or SHA-pinned");
  });
});

function createControl(fetcher: ReturnType<typeof githubFetcher>, trustedWorkflows = [workflow]) {
  return new GithubAppRunnerControl(
    {
      appId: "1",
      privateKey: "test-private-key",
      organization: "owner",
      runnerGroupId: 42,
      trustedWorkflows,
      apiUrl: "https://api.github.test",
    },
    fetcher as unknown as typeof fetch,
    () => 1_000,
    async () => "app-jwt",
  );
}

function githubFetcher(group: {
  selected_workflows: string[];
  allows_public_repositories?: boolean | undefined;
  restricted_to_workflows?: boolean | undefined;
}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/app/installations/7/access_tokens")) return json({ token: "installation-token" });
    if (url.endsWith("/repos/owner/repository")) return json({ id: 3 });
    if (url.endsWith("/orgs/owner/actions/runner-groups/42")) {
      return json({
        id: 42,
        allows_public_repositories: false,
        restricted_to_workflows: true,
        ...group,
      });
    }
    if (url.endsWith("/orgs/owner/actions/runners/generate-jitconfig")) {
      return json({ encoded_jit_config: "encoded-jit-config", runner: { id: 9001 } });
    }
    if (method === "DELETE" && url.endsWith("/orgs/owner/actions/runners/9001")) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  });
}

function json(body: unknown): Response {
  return Response.json(body);
}
