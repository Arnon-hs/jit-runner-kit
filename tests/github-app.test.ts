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

  it("creates and deletes JIT runners through repository endpoints without organization permissions", async () => {
    const fetcher = githubFetcher({ selected_workflows: [workflow] });
    const control = createControl(fetcher, [workflow], "repository");
    await expect(control.assertRepositoryAccess(event)).resolves.toBeUndefined();
    await expect(control.createJitConfiguration(event, "jit-101")).resolves.toEqual({
      encodedJitConfig: "encoded-jit-config",
      runnerId: 9001,
    });
    await control.deleteRunner(event, 9001);
    const urls = fetcher.mock.calls.map(([url]) => String(url));
    expect(urls).not.toContain("https://api.github.test/orgs/owner/actions/runner-groups/42");
    expect(urls).toContain("https://api.github.test/repos/owner/repository/actions/runners/generate-jitconfig");
    expect(urls).toContain("https://api.github.test/repos/owner/repository/actions/runners/9001");
  });

  it("rejects an untrusted event and ambiguous matching jobs", async () => {
    const untrustedEvent = githubFetcher({ selected_workflows: [workflow], event: "pull_request" });
    await expect(createControl(untrustedEvent).assertRepositoryAccess(event)).rejects.toThrow("trusted event boundary");

    const ambiguous = githubFetcher({ selected_workflows: [workflow], duplicateJob: true });
    await expect(createControl(ambiguous).assertRepositoryAccess(event)).rejects.toThrow("exactly one matching queued JIT job");

    const incomplete = githubFetcher({ selected_workflows: [workflow], incompleteJobInventory: true });
    await expect(createControl(incomplete).assertRepositoryAccess(event)).rejects.toThrow("job inventory is incomplete");
  });

  it("rejects workflow selectors that are not pinned to a branch or commit SHA", () => {
    expect(() => createControl(githubFetcher({ selected_workflows: [] }), [
      "owner/repository/.github/workflows/ci.yml",
    ])).toThrow("branch- or SHA-pinned");
  });
});

function createControl(
  fetcher: ReturnType<typeof githubFetcher>,
  trustedWorkflows = [workflow],
  runnerScope: "organization" | "repository" = "organization",
) {
  return new GithubAppRunnerControl(
    {
      appId: "1",
      privateKey: "test-private-key",
      runnerScope,
      organization: "owner",
      runnerGroupId: 42,
      trustedWorkflows,
      trustedEvents: ["push", "workflow_dispatch"],
      triggerLabel: "jit-runner",
      runLabelPrefix: "jit-run-",
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
  event?: string;
  duplicateJob?: boolean;
  incompleteJobInventory?: boolean;
}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/app/installations/7/access_tokens")) return json({ token: "installation-token" });
    if (url.endsWith("/repos/owner/repository")) return json({ id: 3 });
    if (url.endsWith("/repos/owner/repository/actions/runs/51")) {
      return json({
        id: 51,
        event: group.event ?? "push",
        head_branch: "main",
        head_sha: "a".repeat(40),
        path: ".github/workflows/ci.yml",
        head_repository: { full_name: "owner/repository" },
      });
    }
    if (url.endsWith("/repos/owner/repository/actions/runs/51/jobs?filter=latest&per_page=100")) {
      const job = { id: 101, status: "queued", labels: ["self-hosted", "jit-runner", "jit-run-51"] };
      const jobs = group.duplicateJob ? [job, { ...job, id: 102 }] : [job];
      return json({ total_count: group.incompleteJobInventory ? 101 : jobs.length, jobs });
    }
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
    if (url.endsWith("/repos/owner/repository/actions/runners/generate-jitconfig")) {
      return json({ encoded_jit_config: "encoded-jit-config", runner: { id: 9001 } });
    }
    if (method === "DELETE" && url.endsWith("/orgs/owner/actions/runners/9001")) {
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE" && url.endsWith("/repos/owner/repository/actions/runners/9001")) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  });
}

function json(body: unknown): Response {
  return Response.json(body);
}
