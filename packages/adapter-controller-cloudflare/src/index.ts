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
import { HetznerPoolComputeProvider } from "../../adapter-compute-hetzner-pool/src/index";
import { SharedHostComputeProvider } from "../../adapter-compute-shared-host/src/index";

export interface Env {
  CONTROLLER: DurableObjectNamespace;
  TASK_QUEUE: Queue<ControllerTask>;
  PUBLIC_RATE_LIMITER: RateLimit;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  RUNNER_SCOPE: string;
  GITHUB_ORGANIZATION: string;
  RUNNER_GROUP_ID: string;
  TRUSTED_WORKFLOWS: string;
  TRUSTED_EVENTS: string;
  HCLOUD_TOKEN?: string;
  COMPUTE_MODE: string;
  POOL_HOST_ID?: string;
  POOL_HOST_IPV4?: string;
  POOL_HOST_TOKEN?: string;
  POOL_ENROLLMENT_TOKEN?: string;
  POOL_AGENT_URL?: string;
  POOL_AGENT_SHA256?: string;
  POOL_RUNNER_IMAGE?: string;
  POOL_DIND_IMAGE?: string;
  POOL_IDLE_SECONDS?: string;
  POOL_ID?: string;
  ALLOWED_REPOSITORIES: string;
  TRUSTED_BRANCHES: string;
  TRIGGER_LABEL: string;
  RUN_LABEL_PREFIX: string;
  MAX_RUNNERS: string;
  TTL_SECONDS: string;
  PROVISIONING_TIMEOUT_SECONDS: string;
  SERVER_TYPE: string;
  SERVER_LOCATION: string;
  SERVER_IMAGE: string;
  RUNNER_ARCHITECTURE: string;
  PUBLIC_BASE_URL: string;
}

const MAX_WEBHOOK_BODY_BYTES = 1_048_576;
const BOOTSTRAP_PATH = /^\/v1\/bootstrap\/(job-[0-9]+)$/;
const BOOTSTRAP_AUTHORIZATION = /^Bearer [A-Za-z0-9_-]{43}$/;
const POOL_CLAIM_PATH = "/v1/pool/claim";
const POOL_ENROLL_PATH = "/v1/pool/enroll";
const POOL_RELEASE_PATH = "/v1/pool/release";
export const controllerVersion = "0.3.0";

interface LeaseRecord {
  holder: string;
  expiresAt: number;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json({ status: "ok", adapter: "cloudflare", version: controllerVersion });
      }
      if (request.method === "POST" && url.pathname === "/webhooks/github") {
        const limited = await enforcePublicRateLimit(request, env, "webhook");
        if (limited) return limited;
        return await handleGithubWebhook(request, env);
      }
      if (request.method === "POST" && url.pathname.startsWith("/v1/bootstrap/")) {
        const match = url.pathname.match(BOOTSTRAP_PATH);
        if (!match) return json({ error: "invalid_bootstrap_path" }, 400);
        if (!BOOTSTRAP_AUTHORIZATION.test(request.headers.get("authorization") ?? "")) {
          return json({ error: "invalid_bootstrap_authorization" }, 401);
        }
        const limited = await enforcePublicRateLimit(request, env, "bootstrap");
        if (limited) return limited;
        const id = env.CONTROLLER.idFromName("global");
        return await env.CONTROLLER.get(id).fetch(request);
      }
      if (request.method === "POST" && url.pathname === POOL_CLAIM_PATH) {
        if (!isPoolMode(env.COMPUTE_MODE)) return json({ error: "not_found" }, 404);
        const authorization = request.headers.get("authorization") ?? "";
        if (!BOOTSTRAP_AUTHORIZATION.test(authorization)) {
          return json({ error: "invalid_pool_authorization" }, 401);
        }
        const limited = await enforcePublicRateLimit(request, env, "pool-claim");
        if (limited) return limited;
        if (!(await equalSecret(
          authorization.slice("Bearer ".length),
          required(env.POOL_HOST_TOKEN, "POOL_HOST_TOKEN"),
        ))) {
          return json({ error: "invalid_pool_authorization" }, 401);
        }
        const id = env.CONTROLLER.idFromName("global");
        return await env.CONTROLLER.get(id).fetch("https://controller.internal/v1/pool/claim", {
          method: "POST",
          headers: {
            "x-jrk-pool-authorized": "1",
            "x-jrk-source-ip": request.headers.get("cf-connecting-ip") ?? "",
          },
        });
      }
      if (request.method === "POST" && url.pathname === POOL_ENROLL_PATH) {
        if (!isPoolMode(env.COMPUTE_MODE)) return json({ error: "not_found" }, 404);
        const authorization = request.headers.get("authorization") ?? "";
        if (!BOOTSTRAP_AUTHORIZATION.test(authorization)) {
          return json({ error: "invalid_pool_enrollment" }, 401);
        }
        const limited = await enforcePublicRateLimit(request, env, "pool-enroll");
        if (limited) return limited;
        const sourceIp = request.headers.get("cf-connecting-ip") ?? "";
        if (!(await equalSecret(
          authorization.slice("Bearer ".length),
          required(env.POOL_ENROLLMENT_TOKEN, "POOL_ENROLLMENT_TOKEN"),
        )) || (env.COMPUTE_MODE === "shared-host" && sourceIp !== required(env.POOL_HOST_IPV4, "POOL_HOST_IPV4"))) {
          return json({ error: "invalid_pool_enrollment" }, 401);
        }
        const id = env.CONTROLLER.idFromName("global");
        return await env.CONTROLLER.get(id).fetch("https://controller.internal/v1/pool/enroll", {
          method: "POST",
          headers: {
            "x-jrk-pool-authorized": "1",
            "x-jrk-source-ip": sourceIp,
            authorization,
          },
        });
      }
      if (request.method === "POST" && url.pathname === POOL_RELEASE_PATH) {
        if (env.COMPUTE_MODE !== "hetzner-pool") return json({ error: "not_found" }, 404);
        const authorization = request.headers.get("authorization") ?? "";
        if (!BOOTSTRAP_AUTHORIZATION.test(authorization) || !(await equalSecret(
          authorization.slice("Bearer ".length),
          required(env.POOL_HOST_TOKEN, "POOL_HOST_TOKEN"),
        ))) return json({ error: "invalid_pool_authorization" }, 401);
        const limited = await enforcePublicRateLimit(request, env, "pool-release");
        if (limited) return limited;
        const id = env.CONTROLLER.idFromName("global");
        return await env.CONTROLLER.get(id).fetch("https://controller.internal/v1/pool/release", {
          method: "POST",
          headers: {
            "x-jrk-pool-authorized": "1",
            "x-jrk-source-ip": request.headers.get("cf-connecting-ip") ?? "",
          },
        });
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
  private readonly config: ControllerConfig;
  private readonly jobs: CloudflareJobStore;
  private readonly poolHostId: string | undefined;
  private readonly poolHostToken: string | undefined;
  private readonly operationGate = new SerialOperationGate();

  constructor(
    private readonly state: DurableObjectState,
    env: Env,
  ) {
    this.jobs = new CloudflareJobStore(state.storage);
    this.config = readControllerConfig(env);
    this.poolHostId = env.COMPUTE_MODE === "shared-host"
      ? required(env.POOL_HOST_ID, "POOL_HOST_ID")
      : undefined;
    this.poolHostToken = isPoolMode(env.COMPUTE_MODE)
      ? required(env.POOL_HOST_TOKEN, "POOL_HOST_TOKEN")
      : undefined;
    const clock: Clock = { now: () => Math.floor(Date.now() / 1000) };
    const telemetry = new JsonTelemetry();
    this.controller = new Controller(this.config, {
      jobs: this.jobs,
      leases: new CloudflareLeaseStore(state.storage, clock),
      compute: computeProvider(env),
      runners: new GithubAppRunnerControl({
        appId: required(env.GITHUB_APP_ID, "GITHUB_APP_ID"),
        privateKey: required(env.GITHUB_APP_PRIVATE_KEY, "GITHUB_APP_PRIVATE_KEY"),
        runnerScope: runnerScope(env.RUNNER_SCOPE),
        organization: env.GITHUB_ORGANIZATION,
        runnerGroupId: positiveInteger(env.RUNNER_GROUP_ID, "RUNNER_GROUP_ID"),
        trustedWorkflows: csv(env.TRUSTED_WORKFLOWS),
        trustedEvents: csv(env.TRUSTED_EVENTS),
        triggerLabel: required(env.TRIGGER_LABEL, "TRIGGER_LABEL"),
        runLabelPrefix: required(env.RUN_LABEL_PREFIX, "RUN_LABEL_PREFIX"),
      }),
      bootstrapTokens: new WebCryptoBootstrapTokenBroker(),
      clock,
      telemetry,
    });
  }

  async fetch(request: Request): Promise<Response> {
    return await this.operationGate.run(() => this.handleRequest(request));
  }

  private async handleRequest(request: Request): Promise<Response> {
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
        return json({ encoded_jit_config: result.encodedJitConfig }, 200, { "Cache-Control": "no-store" });
      }
      if (request.method === "POST" && url.pathname === POOL_CLAIM_PATH) {
        if (request.headers.get("x-jrk-pool-authorized") !== "1") {
          return json({ error: "not_found" }, 404);
        }
        const result = await this.controller.claimPoolRunner(
          request.headers.get("x-jrk-source-ip") ?? "",
          this.poolHostId,
        );
        await this.scheduleNextAlarm();
        if (!result) return new Response(null, { status: 204 });
        return json({
          job_key: result.jobKey,
          encoded_jit_config: result.encodedJitConfig,
          expires_at: result.expiresAt,
        }, 200, { "Cache-Control": "no-store" });
      }
      if (request.method === "POST" && url.pathname === POOL_ENROLL_PATH) {
        if (request.headers.get("x-jrk-pool-authorized") !== "1") {
          return json({ error: "not_found" }, 404);
        }
        const generation = this.poolHostId ?? (await this.controller.identifyPoolHost(
          request.headers.get("x-jrk-source-ip") ?? "",
        )).hostId;
        const enrolled = await this.state.storage.get<string>("pool:enrolled-generation");
        if (enrolled === generation) return json({ error: "pool_already_enrolled" }, 409);
        await this.state.storage.put("pool:enrolled-generation", generation);
        return json({ host_token: required(this.poolHostToken, "POOL_HOST_TOKEN") }, 200, {
          "Cache-Control": "no-store",
        });
      }
      if (request.method === "POST" && url.pathname === POOL_RELEASE_PATH) {
        if (request.headers.get("x-jrk-pool-authorized") !== "1") {
          return json({ error: "not_found" }, 404);
        }
        const released = await this.controller.releaseIdlePoolHost(
          request.headers.get("x-jrk-source-ip") ?? "",
        );
        return released ? json({ released: true }, 202) : json({ error: "pool_not_idle" }, 409);
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  }

  async alarm(): Promise<void> {
    await this.operationGate.run(async () => {
      await this.controller.reconcile();
      await this.scheduleNextAlarm();
    });
  }

  private async scheduleNextAlarm(): Promise<void> {
    const active = await this.jobs.listActive();
    const next = active.reduce<number | null>(
      (earliest, job) => {
        const due = ["provisioning", "awaiting-bootstrap", "bootstrapping"].includes(job.state)
          ? Math.min(job.expiresAt, job.updatedAt + this.config.provisioningTimeoutSeconds)
          : job.expiresAt;
        return earliest === null || due < earliest ? due : earliest;
      },
      null,
    );
    if (next === null) {
      await this.state.storage.deleteAlarm();
      return;
    }
    await this.state.storage.setAlarm(next * 1000);
  }
}

/** Serializes state mutations that include awaited provider calls. */
export class SerialOperationGate {
  private queue: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
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

  async retain(scope: string, holder: string, expiresAt: number): Promise<void> {
    await this.storage.put(`lease:${scope}:${holder}`, { holder, expiresAt } satisfies LeaseRecord);
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
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return json({ error: "unsupported_media_type" }, 415);
  }
  const body = await readBodyLimited(request, MAX_WEBHOOK_BODY_BYTES);
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

async function enforcePublicRateLimit(request: Request, env: Env, route: string): Promise<Response | null> {
  const sourceIp = request.headers.get("cf-connecting-ip") ?? "unknown";
  const outcome = await env.PUBLIC_RATE_LIMITER.limit({ key: `${route}:${sourceIp}` });
  return outcome.success ? null : json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
}

function isJsonContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function readBodyLimited(request: Request, limit: number): Promise<ArrayBuffer> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new PayloadTooLargeError();
  }
  if (!request.body) return new ArrayBuffer(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

class PayloadTooLargeError extends Error {}

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
  const ttlSeconds = boundedInteger(env.TTL_SECONDS, "TTL_SECONDS", 600, 86_400);
  const provisioningTimeoutSeconds = boundedInteger(
    env.PROVISIONING_TIMEOUT_SECONDS,
    "PROVISIONING_TIMEOUT_SECONDS",
    30,
    ttlSeconds - 1,
  );
  return {
    maxRunners: boundedInteger(env.MAX_RUNNERS, "MAX_RUNNERS", 1, 2),
    ttlSeconds,
    provisioningTimeoutSeconds,
    serverType: required(env.SERVER_TYPE, "SERVER_TYPE"),
    location: required(env.SERVER_LOCATION, "SERVER_LOCATION"),
    image: required(env.SERVER_IMAGE, "SERVER_IMAGE"),
    architecture,
    publicBaseUrl: publicBaseUrl.toString().replace(/\/$/, ""),
  };
}

function computeProvider(env: Env): HetznerComputeProvider | SharedHostComputeProvider | HetznerPoolComputeProvider {
  if (env.COMPUTE_MODE === "hetzner-ephemeral") {
    return new HetznerComputeProvider({ token: required(env.HCLOUD_TOKEN, "HCLOUD_TOKEN") });
  }
  if (env.COMPUTE_MODE === "shared-host") {
    return new SharedHostComputeProvider({
      hostId: required(env.POOL_HOST_ID, "POOL_HOST_ID"),
      publicIpv4: required(env.POOL_HOST_IPV4, "POOL_HOST_IPV4"),
    });
  }
  if (env.COMPUTE_MODE === "hetzner-pool") {
    return new HetznerPoolComputeProvider({
      token: required(env.HCLOUD_TOKEN, "HCLOUD_TOKEN"),
      controllerUrl: required(env.PUBLIC_BASE_URL, "PUBLIC_BASE_URL"),
      agentUrl: required(env.POOL_AGENT_URL, "POOL_AGENT_URL"),
      agentSha256: required(env.POOL_AGENT_SHA256, "POOL_AGENT_SHA256"),
      runnerImage: required(env.POOL_RUNNER_IMAGE, "POOL_RUNNER_IMAGE"),
      dindImage: required(env.POOL_DIND_IMAGE, "POOL_DIND_IMAGE"),
      enrollmentToken: required(env.POOL_ENROLLMENT_TOKEN, "POOL_ENROLLMENT_TOKEN"),
      poolId: required(env.POOL_ID, "POOL_ID"),
      maxRunners: boundedInteger(env.MAX_RUNNERS, "MAX_RUNNERS", 1, 2),
      idleSeconds: boundedInteger(required(env.POOL_IDLE_SECONDS, "POOL_IDLE_SECONDS"), "POOL_IDLE_SECONDS", 300, 3600),
    });
  }
  throw new Error("COMPUTE_MODE must be hetzner-ephemeral, shared-host, or hetzner-pool");
}

function isPoolMode(value: string): boolean {
  return value === "shared-host" || value === "hetzner-pool";
}

async function equalSecret(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = left.length ^ right.length;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
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

function boundedInteger(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = positiveInteger(value, name);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function runnerScope(value: string): "organization" | "repository" {
  if (value === "organization" || value === "repository") return value;
  throw new Error("RUNNER_SCOPE must be organization or repository");
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
  if (error instanceof PayloadTooLargeError) return json({ error: "payload_too_large" }, 413);
  if (error instanceof RetryableError) {
    return json({ error: "retryable_failure" }, 503, { "Retry-After": String(error.delaySeconds) });
  }
  if (error instanceof TerminalError) return json({ error: "request_rejected" }, 400);
  console.error(JSON.stringify({
    level: "error",
    event: "controller.unexpected_failure",
    errorType: error instanceof Error ? error.name : typeof error,
  }));
  return json({ error: "internal_error" }, 500);
}
