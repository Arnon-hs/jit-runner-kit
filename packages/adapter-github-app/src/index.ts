import type { JitConfiguration, RunnerControl, TrustedWorkflowJobEvent } from "../../contracts/src/index";
import { RetryableError, TerminalError } from "../../contracts/src/index";
import { createGithubAppJwt } from "../../crypto/src/index";

export interface GithubAppConfig {
  appId: string;
  privateKey: string;
  organization: string;
  runnerGroupId: number;
  trustedWorkflows: readonly string[];
  apiUrl?: string;
  apiVersion?: string;
}

interface InstallationTokenResponse {
  token: string;
}

interface JitResponse {
  encoded_jit_config: string;
  runner: { id: number };
}

interface RunnerGroupResponse {
  id: number;
  allows_public_repositories: boolean;
  restricted_to_workflows: boolean;
  selected_workflows?: string[];
}

export class GithubAppRunnerControl implements RunnerControl {
  private readonly apiUrl: string;
  private readonly apiVersion: string;
  private readonly runnerGroupId: number;
  private readonly trustedWorkflows: string[];

  constructor(
    private readonly config: GithubAppConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly jwtFactory: typeof createGithubAppJwt = createGithubAppJwt,
  ) {
    this.apiUrl = config.apiUrl ?? "https://api.github.com";
    this.apiVersion = config.apiVersion ?? "2026-03-10";
    if (!Number.isInteger(config.runnerGroupId) || config.runnerGroupId <= 0) {
      throw new TerminalError("runnerGroupId must be a positive integer");
    }
    this.runnerGroupId = config.runnerGroupId;
    this.trustedWorkflows = normalizedWorkflows(config.trustedWorkflows);
    if (this.trustedWorkflows.length === 0 || this.trustedWorkflows.some((workflow) => !isPinnedWorkflow(workflow))) {
      throw new TerminalError("trustedWorkflows must contain branch- or SHA-pinned workflow paths");
    }
  }

  async assertRepositoryAccess(event: TrustedWorkflowJobEvent): Promise<void> {
    const [owner] = event.repository.fullName.split("/", 1);
    if (owner?.toLowerCase() !== this.config.organization.toLowerCase()) {
      throw new TerminalError("repository is outside the configured GitHub organization");
    }
    const token = await this.installationToken(event);
    await this.request(`/repos/${event.repository.fullName}`, token, { method: "GET" });
    await this.assertRunnerGroupPolicy(token);
  }

  private async assertRunnerGroupPolicy(token: string): Promise<void> {
    const group = await this.request<RunnerGroupResponse>(
      `/orgs/${encodeURIComponent(this.config.organization)}/actions/runner-groups/${this.runnerGroupId}`,
      token,
      { method: "GET" },
    );
    if (
      group.id !== this.runnerGroupId ||
      group.allows_public_repositories !== false ||
      group.restricted_to_workflows !== true ||
      !Array.isArray(group.selected_workflows)
    ) {
      throw new TerminalError("runner group does not enforce the private trusted-workflow boundary");
    }
    const selected = normalizedWorkflows(group.selected_workflows);
    if (selected.length !== this.trustedWorkflows.length || selected.some((value, index) => value !== this.trustedWorkflows[index])) {
      throw new TerminalError("runner group selected workflows differ from controller configuration");
    }
  }

  async createJitConfiguration(
    event: TrustedWorkflowJobEvent,
    runnerName: string,
  ): Promise<JitConfiguration> {
    const token = await this.installationToken(event);
    await this.assertRunnerGroupPolicy(token);
    const labels = [...new Set(event.labels)].slice(0, 100);
    const result = await this.request<JitResponse>(
      `/orgs/${encodeURIComponent(this.config.organization)}/actions/runners/generate-jitconfig`,
      token,
      {
        method: "POST",
        body: JSON.stringify({
          name: runnerName,
          runner_group_id: this.runnerGroupId,
          labels,
          work_folder: "_work",
        }),
      },
    );
    return { encodedJitConfig: result.encoded_jit_config, runnerId: result.runner.id };
  }

  async deleteRunner(event: TrustedWorkflowJobEvent, runnerId: number): Promise<void> {
    const token = await this.installationToken(event);
    await this.request(
      `/orgs/${encodeURIComponent(this.config.organization)}/actions/runners/${runnerId}`,
      token,
      { method: "DELETE" },
      true,
    );
  }

  private async installationToken(event: TrustedWorkflowJobEvent): Promise<string> {
    const jwt = await this.jwtFactory(this.config.appId, this.config.privateKey, this.now());
    const response = await this.request<InstallationTokenResponse>(
      `/app/installations/${event.installationId}/access_tokens`,
      jwt,
      {
        method: "POST",
        body: JSON.stringify({ repository_ids: [event.repository.id] }),
      },
    );
    return response.token;
  }

  private async request<T = unknown>(
    path: string,
    token: string,
    init: RequestInit,
    allowMissing = false,
  ): Promise<T> {
    const response = await this.fetcher(`${this.apiUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "jit-runner-kit-cloudflare",
        "X-GitHub-Api-Version": this.apiVersion,
      },
    });
    if (response.ok) {
      return (response.status === 204 ? undefined : await response.json()) as T;
    }
    if (allowMissing && response.status === 404) return undefined as T;
    const message = await safeError(response);
    if (response.status === 429 || response.status >= 500) {
      throw new RetryableError(`GitHub API ${response.status}: ${message}`, retryAfter(response));
    }
    throw new TerminalError(`GitHub API ${response.status}: ${message}`);
  }
}

function normalizedWorkflows(workflows: readonly string[]): string[] {
  return [...new Set(workflows.map((workflow) => workflow.trim()).filter(Boolean))].sort();
}

function isPinnedWorkflow(workflow: string): boolean {
  return /^[^/]+\/[^/]+\/\.github\/workflows\/[^@/]+\.ya?ml@(?:refs\/heads\/[A-Za-z0-9._/-]+|[0-9a-f]{40})$/i.test(workflow);
}

function retryAfter(response: Response): number {
  const value = Number(response.headers.get("retry-after"));
  return Number.isFinite(value) && value > 0 ? Math.min(value, 900) : 30;
}

async function safeError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string };
    return body.message ?? "request failed";
  } catch {
    return "request failed";
  }
}
