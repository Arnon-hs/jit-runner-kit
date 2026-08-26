import { describe, expect, it, vi } from "vitest";
import packageMetadata from "../package.json";
import worker, {
  controllerVersion,
  SerialOperationGate,
  type Env,
} from "../packages/adapter-controller-cloudflare/src/index";

const secret = "test-webhook-secret";

describe("Cloudflare public webhook boundary", () => {
  it("reports the package release version from the health endpoint", async () => {
    const packageVersion = packageMetadata.version;
    const response = await worker.fetch(
      new Request("https://controller.example.test/healthz"),
      fixtureEnv(),
    );

    expect(controllerVersion).toBe(packageVersion);
    expect(await response.json()).toEqual({
      status: "ok",
      adapter: "cloudflare",
      version: packageVersion,
    });
  });

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

  it("rejects oversized and non-JSON webhooks before signature verification", async () => {
    const env = fixtureEnv();
    const oversized = new Request("https://controller.example.test/webhooks/github", {
      method: "POST",
      headers: {
        "content-length": "1048577",
        "content-type": "application/json",
        "x-github-delivery": "00000000-0000-4000-8000-000000000001",
        "x-github-event": "workflow_job",
      },
      body: "{}",
    });
    expect((await worker.fetch(oversized, env)).status).toBe(413);

    const text = new Request("https://controller.example.test/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-github-delivery": "00000000-0000-4000-8000-000000000001",
        "x-github-event": "workflow_job",
      },
      body: "{}",
    });
    expect((await worker.fetch(text, env)).status).toBe(415);
    expect(env.TASK_QUEUE.send).not.toHaveBeenCalled();
  });

  it("rejects malformed bootstrap requests before Durable Object dispatch", async () => {
    const env = fixtureEnv();
    const fetch = vi.fn();
    env.CONTROLLER = {
      idFromName: vi.fn(() => ({ toString: () => "global" })),
      get: vi.fn(() => ({ fetch })),
    } as unknown as DurableObjectNamespace;

    const malformed = new Request("https://controller.example.test/v1/bootstrap/not-a-job", {
      method: "POST",
      headers: { authorization: `Bearer ${"a".repeat(43)}` },
    });
    expect((await worker.fetch(malformed, env)).status).toBe(400);

    const missingBearer = new Request("https://controller.example.test/v1/bootstrap/job-101", {
      method: "POST",
    });
    expect((await worker.fetch(missingBearer, env)).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rate-limits public controller routes before privileged work", async () => {
    const env = fixtureEnv();
    env.PUBLIC_RATE_LIMITER.limit = vi.fn(async () => ({ success: false }));
    const response = await worker.fetch(await webhookRequest({
      head_branch: "main",
      labels: ["self-hosted", "jit-runner", "jit-run-51"],
      pull_requests: [],
    }), env);
    expect(response.status).toBe(429);
    expect(env.TASK_QUEUE.send).not.toHaveBeenCalled();
  });

  it("authenticates shared-host claims before Durable Object dispatch", async () => {
    const env = fixtureEnv();
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 204 }));
    env.COMPUTE_MODE = "shared-host";
    env.POOL_HOST_TOKEN = "a".repeat(43);
    env.CONTROLLER = {
      idFromName: vi.fn(() => ({ toString: () => "global" })),
      get: vi.fn(() => ({ fetch })),
    } as unknown as DurableObjectNamespace;

    const rejected = await worker.fetch(new Request("https://controller.example.test/v1/pool/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${"b".repeat(43)}` },
    }), env);
    expect(rejected.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();

    const accepted = await worker.fetch(new Request("https://controller.example.test/v1/pool/claim", {
      method: "POST",
      headers: {
        authorization: `Bearer ${"a".repeat(43)}`,
        "cf-connecting-ip": "192.0.2.10",
      },
    }), env);
    expect(accepted.status).toBe(204);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-jrk-pool-authorized": "1",
      "x-jrk-source-ip": "192.0.2.10",
    });
  });

  it("binds one-time pool enrollment to both its credential and expected source IP", async () => {
    const env = fixtureEnv();
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ host_token: "a".repeat(43) }));
    env.COMPUTE_MODE = "shared-host";
    env.POOL_HOST_IPV4 = "192.0.2.10";
    env.POOL_ENROLLMENT_TOKEN = "e".repeat(43);
    env.CONTROLLER = {
      idFromName: vi.fn(() => ({ toString: () => "global" })),
      get: vi.fn(() => ({ fetch })),
    } as unknown as DurableObjectNamespace;

    const wrongSource = await worker.fetch(new Request("https://controller.example.test/v1/pool/enroll", {
      method: "POST",
      headers: {
        authorization: `Bearer ${"e".repeat(43)}`,
        "cf-connecting-ip": "198.51.100.8",
      },
    }), env);
    expect(wrongSource.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();

    const accepted = await worker.fetch(new Request("https://controller.example.test/v1/pool/enroll", {
      method: "POST",
      headers: {
        authorization: `Bearer ${"e".repeat(43)}`,
        "cf-connecting-ip": "192.0.2.10",
      },
    }), env);
    expect(accepted.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("forwards elastic pool enrollment to the stateful controller for one-time validation", async () => {
    const env = fixtureEnv();
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ host_token: "a".repeat(43) }));
    const token = "e".repeat(43);
    env.COMPUTE_MODE = "hetzner-pool";
    env.POOL_ENROLLMENT_TOKEN = token;
    env.CONTROLLER = {
      idFromName: vi.fn(() => ({ toString: () => "global" })),
      get: vi.fn(() => ({ fetch })),
    } as unknown as DurableObjectNamespace;
    const response = await worker.fetch(new Request("https://controller.example.test/v1/pool/enroll", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": "192.0.2.10" },
    }), env);
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: `Bearer ${token}`,
      "x-jrk-source-ip": "192.0.2.10",
    });
  });

  it("authenticates elastic pool idle release before provider deletion", async () => {
    const env = fixtureEnv();
    const fetch = vi.fn(async () => Response.json({ released: true }, { status: 202 }));
    env.COMPUTE_MODE = "hetzner-pool";
    env.POOL_HOST_TOKEN = "a".repeat(43);
    env.CONTROLLER = {
      idFromName: vi.fn(() => ({ toString: () => "global" })),
      get: vi.fn(() => ({ fetch })),
    } as unknown as DurableObjectNamespace;

    const rejected = await worker.fetch(new Request("https://controller.example.test/v1/pool/release", {
      method: "POST",
      headers: { authorization: `Bearer ${"b".repeat(43)}` },
    }), env);
    expect(rejected.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();

    const accepted = await worker.fetch(new Request("https://controller.example.test/v1/pool/release", {
      method: "POST",
      headers: { authorization: `Bearer ${"a".repeat(43)}`, "cf-connecting-ip": "192.0.2.10" },
    }), env);
    expect(accepted.status).toBe(202);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("Cloudflare controller mutation serialization", () => {
  it("does not overlap provider-affecting operations, including after a failure", async () => {
    const gate = new SerialOperationGate();
    const trace: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = gate.run(async () => {
      trace.push("first:start");
      await firstBlocked;
      trace.push("first:end");
      throw new Error("expected failure");
    });
    const second = gate.run(async () => {
      trace.push("second:start");
      trace.push("second:end");
    });

    await Promise.resolve();
    expect(trace).toEqual(["first:start"]);
    releaseFirst();
    await expect(first).rejects.toThrow("expected failure");
    await second;
    expect(trace).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });
});

function fixtureEnv(): Env {
  return {
    TASK_QUEUE: { send: vi.fn(async () => undefined) },
    PUBLIC_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
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
