import { describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../packages/adapter-controller-cloudflare/src/index";

const secret = "test-webhook-secret";

describe("Cloudflare public webhook boundary", () => {
  it("returns a non-retryable response for an authenticated but untrusted job", async () => {
    const env = fixtureEnv();
    const response = await worker.fetch(await webhookRequest({
      head_branch: "feature",
      labels: ["self-hosted", "jit-runner", "jit-run-51"],
      pull_requests: [],
    }), env);
    expect(response.status).toBe(400);
    expect(env.TASK_QUEUE.send).not.toHaveBeenCalled();
  });

  it("queues only a trusted job carrying its signed run-scoped label", async () => {
    const env = fixtureEnv();
    const response = await worker.fetch(await webhookRequest({
      head_branch: "main",
      labels: ["self-hosted", "jit-runner", "jit-run-51"],
      pull_requests: [],
    }), env);
    expect(response.status).toBe(202);
    expect(env.TASK_QUEUE.send).toHaveBeenCalledOnce();
  });
});

function fixtureEnv(): Env {
  return {
    TASK_QUEUE: { send: vi.fn(async () => undefined) },
    GITHUB_WEBHOOK_SECRET: secret,
    ALLOWED_REPOSITORIES: "owner/repository",
    TRUSTED_BRANCHES: "main",
    TRIGGER_LABEL: "jit-runner",
    RUN_LABEL_PREFIX: "jit-run-",
  } as unknown as Env;
}

async function webhookRequest(job: {
  head_branch: string;
  labels: string[];
  pull_requests: unknown[];
}): Promise<Request> {
  const body = JSON.stringify({
    action: "queued",
    installation: { id: 7 },
    repository: { id: 3, full_name: "owner/repository" },
    workflow_job: { id: 101, run_id: 51, ...job },
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request("https://controller.example.test/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": "00000000-0000-4000-8000-000000000001",
      "x-github-event": "workflow_job",
      "x-hub-signature-256": `sha256=${hex}`,
    },
    body,
  });
}
