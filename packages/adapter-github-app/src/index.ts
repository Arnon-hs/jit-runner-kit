import type { JitConfiguration, RunnerControl, TrustedWorkflowJobEvent } from "../../contracts/src/index";
import { RetryableError, TerminalError } from "../../contracts/src/index";
import { createGithubAppJwt } from "../../crypto/src/index";

interface GithubAppConfig {
  appId: string;
  privateKey: string;
  apiUrl?: string;
  apiVersion?: string;
  runnerGroupId?: number;
}

interface InstallationTokenResponse {
  token: string;
}

interface JitResponse {
  encoded_jit_config: string;
  runner: { id: number };
}

export class GithubAppRunnerControl implements RunnerControl {
  private readonly apiUrl: string;
  private readonly apiVersion: string;
  private readonly runnerGroupId: number;

  constructor(
    private readonly config: GithubAppConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.apiUrl = config.apiUrl ?? "https://api.github.com";
    this.apiVersion = config.apiVersion ?? "2026-03-10";
    this.runnerGroupId = config.runnerGroupId ?? 1;
  }

  async assertRepositoryAccess(event: TrustedWorkflowJobEvent): Promise<void> {
    const token = await this.installationToken(event);
    await this.request(`/repos/${event.repository.fullName}`, token, { method: "GET" });
  }

  async createJitConfiguration(
    event: TrustedWorkflowJobEvent,
    runnerName: string,
  ): Promise<JitConfiguration> {
    const token = await this.installationToken(event);
    const labels = [...new Set(event.labels)].slice(0, 100);
    const result = await this.request<JitResponse>(
      `/repos/${event.repository.fullName}/actions/runners/generate-jitconfig`,
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
      `/repos/${event.repository.fullName}/actions/runners/${runnerId}`,
      token,
      { method: "DELETE" },
      true,
    );
  }

  private async installationToken(event: TrustedWorkflowJobEvent): Promise<string> {
    const jwt = await createGithubAppJwt(this.config.appId, this.config.privateKey, this.now());
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
