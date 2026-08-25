import type {
  Clock,
  ControllerConfig,
  ControllerTask,
  JobRecord,
  JobStore,
  LeaseStore,
  Telemetry,
} from "../../contracts/src/index";
import { RetryableError, TerminalError } from "../../contracts/src/index";
import { Controller, trustWorkflowJobPayload } from "../../core/src/index";
import { WebCryptoBootstrapTokenBroker, verifyWebhookSignature } from "../../crypto/src/index";
import { GithubAppRunnerControl } from "../../adapter-github-app/src/index";
import { HetznerComputeProvider } from "../../adapter-compute-hetzner/src/index";

export interface Env {
  CONTROLLER: DurableObjectNamespace;
  TASK_QUEUE: Queue<ControllerTask>;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  HCLOUD_TOKEN: string;
  ALLOWED_REPOSITORIES: string;
  TRUSTED_BRANCHES: string;
  TRIGGER_LABEL: string;
  RUN_LABEL_PREFIX: string;
  MAX_RUNNERS: string;
  TTL_SECONDS: string;
  SERVER_TYPE: string;
  SERVER_LOCATION: string;
  SERVER_IMAGE: string;
  RUNNER_ARCHITECTURE: string;
  PUBLIC_BASE_URL: string;
}

interface LeaseRecord {
  holder: string;
  expiresAt: number;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json({ status: "ok", adapter: "cloudflare", version: "0.2.0-dev" });
      }
      if (request.method === "POST" && url.pathname === "/webhooks/github") {
        return await handleGithubWebhook(request, env);
      }
      if (request.method === "POST" && url.pathname.startsWith("/v1/bootstrap/")) {
        const id = env.CONTROLLER.idFromName("global");
        return await env.CONTROLLER.get(id).fetch(request);
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  },

  async queue(batch: MessageBatch<ControllerTask>, env: Env): Promise<void> {
    const stub = env.CONTROLLER.get(env.CONTROLLER.idFromName("global"));
    for (const message of batch.messages) {
      try {
        const response = await stub.fetch("https://controller.internal/task", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message.body),
        });
        if (response.ok || response.status < 500) {
          message.ack();
          continue;
        }
        const delaySeconds = Math.min(Number(response.headers.get("retry-after")) || backoff(message.attempts), 900);
        message.retry({ delaySeconds });
      } catch {
        message.retry({ delaySeconds: backoff(message.attempts) });
      }
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const stub = env.CONTROLLER.get(env.CONTROLLER.idFromName("global"));
    ctx.waitUntil(stub.fetch("https://controller.internal/reconcile", { method: "POST" }));
  },
};

export class ControllerDurableObject {
  private readonly controller: Controller;
  private readonly jobs: CloudflareJobStore;

  constructor(
    private readonly state: DurableObjectState,
    env: Env,
  ) {
    this.jobs = new CloudflareJobStore(state.storage);
    const clock: Clock = { now: () => Math.floor(Date.now() / 1000) };
    const telemetry = new JsonTelemetry();
    this.controller = new Controller(readControllerConfig(env), {
      jobs: this.jobs,
      leases: new CloudflareLeaseStore(state.storage, clock),
      compute: new HetznerComputeProvider({ token: required(env.HCLOUD_TOKEN, "HCLOUD_TOKEN") }),
      runners: new GithubAppRunnerControl({
        appId: required(env.GITHUB_APP_ID, "GITHUB_APP_ID"),
        privateKey: required(env.GITHUB_APP_PRIVATE_KEY, "GITHUB_APP_PRIVATE_KEY"),
      }),
      bootstrapTokens: new WebCryptoBootstrapTokenBroker(),
      clock,
      telemetry,
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/task") {
        const task = (await request.json()) as ControllerTask;
        if (task.kind === "workflow-job") await this.controller.handleWorkflowJob(task.event);
        else if (task.kind === "reconcile") await this.controller.reconcile();
        else throw new TerminalError("unknown controller task");
        await this.scheduleNextAlarm();
        return json({ accepted: true });
      }
      if (request.method === "POST" && url.pathname === "/reconcile") {
        await this.controller.reconcile();
        await this.scheduleNextAlarm();
        return json({ reconciled: true });
      }
      if (request.method === "POST" && url.pathname.startsWith("/v1/bootstrap/")) {
        const jobKey = decodeURIComponent(url.pathname.slice("/v1/bootstrap/".length));
        const token = bearerToken(request.headers.get("authorization"));
        const sourceIp = request.headers.get("cf-connecting-ip") ?? "";
        const result = await this.controller.exchangeBootstrap(jobKey, token, sourceIp);
        await this.scheduleNextAlarm();
        return json(result, 200, { "Cache-Control": "no-store" });
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  }

  async alarm(): Promise<void> {
    await this.controller.reconcile();
    await this.scheduleNextAlarm();
  }

  private async scheduleNextAlarm(): Promise<void> {
    const active = await this.jobs.listActive();
    const next = active.reduce<number | null>(
      (earliest, job) => (earliest === null || job.expiresAt < earliest ? job.expiresAt : earliest),
      null,
    );
    if (next === null) {
      await this.state.storage.deleteAlarm();
      return;
    }
    await this.state.storage.setAlarm(next * 1000);
  }
}

class CloudflareJobStore implements JobStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  async get(key: string): Promise<JobRecord | null> {
    return (await this.storage.get<JobRecord>(`job:${key}`)) ?? null;
  }

  async compareAndSet(key: string, expectedVersion: number | null, value: JobRecord): Promise<boolean> {
    return this.storage.transaction(async (transaction) => {
      const current = await transaction.get<JobRecord>(`job:${key}`);
      if ((current?.version ?? null) !== expectedVersion) return false;
      await transaction.put(`job:${key}`, value);
      return true;
    });
  }

  async listActive(): Promise<JobRecord[]> {
    const records = await this.storage.list<JobRecord>({ prefix: "job:" });
    return [...records.values()].filter((record) =>
      ["provisioning", "awaiting-bootstrap", "bootstrapping", "running", "cleaning"].includes(record.state),
    );
  }

  async pruneTerminal(before: number): Promise<number> {
    const records = await this.storage.list<JobRecord>({ prefix: "job:" });
    const keys = [...records.entries()]
      .filter(([, record]) => ["completed", "failed"].includes(record.state) && record.updatedAt < before)
      .map(([key]) => key);
    if (keys.length > 0) await this.storage.delete(keys);
    return keys.length;
  }
}

class CloudflareLeaseStore implements LeaseStore {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly clock: Clock,
  ) {}

  async acquire(scope: string, holder: string, limit: number, expiresAt: number): Promise<boolean> {
    return this.storage.transaction(async (transaction) => {
      const leases = await transaction.list<LeaseRecord>({ prefix: `lease:${scope}:` });
      const now = this.clock.now();
      for (const [key, lease] of leases) {
        if (lease.expiresAt <= now) await transaction.delete(key);
      }
      const active = [...leases.values()].filter((lease) => lease.expiresAt > now);
      const key = `lease:${scope}:${holder}`;
      if (!active.some((lease) => lease.holder === holder) && active.length >= limit) return false;
      await transaction.put(key, { holder, expiresAt } satisfies LeaseRecord);
      return true;
    });
  }

  async release(scope: string, holder: string): Promise<void> {
    await this.storage.delete(`lease:${scope}:${holder}`);
  }
}

class JsonTelemetry implements Telemetry {
  emit(name: string, attributes: Record<string, string | number | boolean>): void {
    console.log(JSON.stringify({ level: "info", event: name, ...attributes }));
  }
}

async function handleGithubWebhook(request: Request, env: Env): Promise<Response> {
  const eventName = request.headers.get("x-github-event") ?? "";
  if (eventName === "ping") return json({ pong: true });
  if (eventName !== "workflow_job") return json({ ignored: true }, 202);

  const signature = request.headers.get("x-hub-signature-256") ?? "";
  const deliveryId = request.headers.get("x-github-delivery") ?? "";
  if (!/^[0-9a-f-]{16,64}$/i.test(deliveryId)) return json({ error: "invalid_delivery_id" }, 400);
  const body = await request.arrayBuffer();
  if (!(await verifyWebhookSignature(required(env.GITHUB_WEBHOOK_SECRET, "GITHUB_WEBHOOK_SECRET"), body, signature))) {
    return json({ error: "invalid_signature" }, 401);
  }

  const payload = JSON.parse(new TextDecoder().decode(body)) as unknown;
  const trusted = trustWorkflowJobPayload(payload, deliveryId, {
    allowedRepositories: csv(env.ALLOWED_REPOSITORIES),
    trustedBranches: csv(env.TRUSTED_BRANCHES),
    triggerLabel: env.TRIGGER_LABEL,
    runLabelPrefix: required(env.RUN_LABEL_PREFIX, "RUN_LABEL_PREFIX"),
    allowPullRequests: false,
  });
  await env.TASK_QUEUE.send({ kind: "workflow-job", event: trusted });
  return json({ accepted: true }, 202);
}

function readControllerConfig(env: Env): ControllerConfig {
  const architecture = env.RUNNER_ARCHITECTURE;
  if (architecture !== "x64" && architecture !== "arm64") {
    throw new Error("RUNNER_ARCHITECTURE must be x64 or arm64");
  }
  const publicBaseUrl = new URL(required(env.PUBLIC_BASE_URL, "PUBLIC_BASE_URL"));
  const localHttp = publicBaseUrl.protocol === "http:" && publicBaseUrl.hostname === "localhost";
  if (publicBaseUrl.protocol !== "https:" && !localHttp) {
    throw new Error("PUBLIC_BASE_URL must use HTTPS (or HTTP on localhost for development)");
  }
  return {
    maxRunners: positiveInteger(env.MAX_RUNNERS, "MAX_RUNNERS"),
    ttlSeconds: positiveInteger(env.TTL_SECONDS, "TTL_SECONDS"),
    serverType: required(env.SERVER_TYPE, "SERVER_TYPE"),
    location: required(env.SERVER_LOCATION, "SERVER_LOCATION"),
    image: required(env.SERVER_IMAGE, "SERVER_IMAGE"),
    architecture,
    publicBaseUrl: publicBaseUrl.toString().replace(/\/$/, ""),
  };
}

function bearerToken(value: string | null): string {
  if (!value?.startsWith("Bearer ") || value.length < 20) throw new TerminalError("missing bootstrap token");
  return value.slice("Bearer ".length);
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function csv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function backoff(attempts: number): number {
  return Math.min(15 * 2 ** Math.max(0, attempts - 1), 900);
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof RetryableError) {
    return json({ error: "retryable_failure" }, 503, { "Retry-After": String(error.delaySeconds) });
  }
  if (error instanceof TerminalError) return json({ error: "request_rejected" }, 400);
  console.error(JSON.stringify({ level: "error", event: "controller.unexpected_failure" }));
  return json({ error: "internal_error" }, 500);
}
