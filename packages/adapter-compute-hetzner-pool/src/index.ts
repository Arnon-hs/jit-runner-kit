import type { ComputeCreateRequest, ComputeProvider, ComputeResource } from "../../contracts/src/index";
import { RetryableError, TerminalError } from "../../contracts/src/index";

interface HetznerPoolConfig {
  token: string;
  controllerUrl: string;
  agentUrl: string;
  agentSha256: string;
  runnerImage: string;
  dindImage: string;
  maxRunners: number;
  idleSeconds: number;
  enrollmentToken: string;
  bootstrapSshPublicKey: string;
  poolId: string;
  apiUrl?: string;
}

interface HetznerServer {
  id: number;
  labels: Record<string, string>;
  status: string;
  public_net: { ipv4: { id: number; ip: string } | null };
}

interface HetznerFirewall {
  id: number;
  labels: Record<string, string>;
}

interface HetznerPrimaryIp {
  id: number;
  ip: string;
  labels: Record<string, string>;
}

interface HetznerSshKey {
  id: number;
  labels: Record<string, string>;
}

interface HetznerAction {
  id: number;
  status: "running" | "success" | "error";
  error?: { code?: string; message?: string } | null;
}

interface HetznerApiError {
  code: string;
  message: string;
}

const ORPHAN_CREATION_GRACE_SECONDS = 300;
const PROVIDER_REQUEST_TIMEOUT_MS = 30_000;
const ACTION_WAIT_TIMEOUT_MS = 30_000;
const ACTION_POLL_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;
const RETRYABLE_ERROR_CODES = new Set([
  "bad_gateway",
  "conflict",
  "locked",
  "maintenance",
  "rate_limit_exceeded",
  "resource_limit_exceeded",
  "resource_unavailable",
  "server_error",
  "service_error",
  "timeout",
  "unavailable",
]);

class HetznerActionStillRunningError extends RetryableError {}
class HetznerTransportError extends RetryableError {}

/**
 * One elastic Hetzner host shared by a bounded number of disposable runner
 * containers. Per-job cleanup is intentionally a no-op; idle or TTL cleanup
 * deletes the single host and all provider objects as one capacity unit.
 */
export class HetznerPoolComputeProvider implements ComputeProvider {
  private readonly apiUrl: string;

  constructor(
    private readonly config: HetznerPoolConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly sleep: (milliseconds: number) => Promise<void> =
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.apiUrl = config.apiUrl ?? "https://api.hetzner.cloud/v1";
    validateConfig(config);
  }

  async create(request: ComputeCreateRequest): Promise<ComputeResource> {
    const servers = await this.list<HetznerServer>("servers");
    if (servers.length > 1) throw new TerminalError("pool invariant violated: more than one host exists");
    const expiresAt = request.expiresAt + this.config.idleSeconds;
    if (servers[0]) {
      if (servers[0].status !== "running") {
        throw new RetryableError("pool host is still provisioning", 30);
      }
      await this.markBootstrapComplete(servers[0]);
      await this.deleteBootstrapKeysBestEffort();
      await this.refreshExpiry(servers[0], expiresAt);
      return await this.toJobResource(servers[0], request, expiresAt);
    }

    const [existingFirewalls, existingIps, existingSshKeys] = await Promise.all([
      this.list<HetznerFirewall>("firewalls"),
      this.list<HetznerPrimaryIp>("primary_ips"),
      this.list<HetznerSshKey>("ssh_keys"),
    ]);
    if (existingFirewalls.length > 1) throw new TerminalError("pool invariant violated: more than one firewall exists");
    if (existingIps.length > 1) throw new TerminalError("pool invariant violated: more than one Primary IPv4 exists");
    if (existingSshKeys.length > 1) throw new TerminalError("pool invariant violated: more than one bootstrap SSH key exists");
    const existingFirewall = existingFirewalls[0];
    const existingIp = existingIps[0];
    const existingSshKey = existingSshKeys[0];
    if (existingFirewall || existingIp || existingSshKey) {
      const recovered = await this.recoverSingleHost();
      if (recovered) {
        if (recovered.status !== "running") {
          throw new RetryableError("pool host is still provisioning", 30);
        }
        await this.markBootstrapComplete(recovered);
        if (existingSshKey) await this.deleteBootstrapKeysBestEffort();
        await this.refreshExpiry(recovered, expiresAt);
        return this.jobResource(recovered, existingFirewall, request, expiresAt);
      }
      const createdAt = Math.max(
        Number(existingFirewall?.labels.created_at) || 0,
        Number(existingIp?.labels.created_at) || 0,
        Number(existingSshKey?.labels.created_at) || 0,
      );
      if (createdAt + ORPHAN_CREATION_GRACE_SECONDS > Math.floor(this.now() / 1000)) {
        throw new RetryableError("pool host creation outcome is still ambiguous", 30);
      }
      if (existingIp) await this.deleteId("primary_ips", existingIp.id);
      if (existingFirewall) await this.deleteId("firewalls", existingFirewall.id);
      if (existingSshKey) await this.deleteId("ssh_keys", existingSshKey.id);
    }

    const labels = poolLabels(this.config.poolId, expiresAt, request.repository, Math.floor(this.now() / 1000));
    const firewall = (
      await this.request<{ firewall: HetznerFirewall }>("/firewalls", {
        method: "POST",
        body: JSON.stringify({ name: `jrk-${this.config.poolId}-deny-inbound`, labels, rules: [] }),
      })
    ).firewall;

    let primaryIp: HetznerPrimaryIp;
    let primaryIpAction: HetznerAction | undefined;
    try {
      const created = await this.request<{ primary_ip: HetznerPrimaryIp; action?: HetznerAction }>(
        "/primary_ips",
        {
          method: "POST",
          body: JSON.stringify({
            name: `jrk-${this.config.poolId}-ipv4`,
            type: "ipv4",
            location: request.location,
            auto_delete: false,
            labels,
          }),
        },
      );
      primaryIp = created.primary_ip;
      primaryIpAction = created.action;
    } catch (error) {
      if (error instanceof RetryableError) {
        const recovered = await this.recoverSinglePrimaryIp();
        if (recovered) primaryIp = recovered;
        else throw new RetryableError("pool Primary IPv4 create outcome remains ambiguous", 30);
      } else {
        await this.deleteId("firewalls", firewall.id);
        throw error;
      }
    }

    if (primaryIpAction) {
      try {
        await this.waitForAction(primaryIpAction, "primary_ip.create");
      } catch (error) {
        if (!(error instanceof HetznerActionStillRunningError)) {
          await this.deleteId("primary_ips", primaryIp.id);
          await this.deleteId("firewalls", firewall.id);
        }
        throw error;
      }
    }

    let bootstrapSshKey: HetznerSshKey;
    try {
      bootstrapSshKey = (
        await this.request<{ ssh_key: HetznerSshKey }>("/ssh_keys", {
          method: "POST",
          body: JSON.stringify({
            name: `jrk-${this.config.poolId}-bootstrap-inert`,
            public_key: this.config.bootstrapSshPublicKey,
            labels,
          }),
        })
      ).ssh_key;
    } catch (error) {
      if (error instanceof HetznerTransportError) {
        const recovered = await this.recoverSingleSshKey();
        if (recovered) bootstrapSshKey = recovered;
        else throw new RetryableError("pool bootstrap SSH key create outcome remains ambiguous", 30);
      } else {
        await this.deleteId("primary_ips", primaryIp.id);
        await this.deleteId("firewalls", firewall.id);
        throw error;
      }
    }

    let server: HetznerServer | undefined;
    let serverAction: HetznerAction | undefined;
    try {
      const created = await this.request<{ server: HetznerServer; action?: HetznerAction }>("/servers", {
          method: "POST",
          body: JSON.stringify({
            name: `jrk-${this.config.poolId}-${request.location}`,
            server_type: request.serverType,
            image: request.image,
            location: request.location,
            labels,
            user_data: cloudInit(request, this.config),
            ssh_keys: [bootstrapSshKey.id],
            firewalls: [{ firewall: firewall.id }],
            public_net: { enable_ipv4: true, enable_ipv6: false, ipv4: primaryIp.id },
            start_after_create: true,
          }),
        });
      server = created.server;
      serverAction = created.action;
    } catch (error) {
      if (error instanceof HetznerTransportError) {
        server = await this.recoverSingleHost();
        if (!server) throw new RetryableError("pool host create outcome remains ambiguous", 30);
      } else {
        await this.cleanupFailedProvisioning(undefined, bootstrapSshKey.id, primaryIp.id, firewall.id);
        throw error;
      }
    }

    if (serverAction) {
      try {
        await this.waitForAction(serverAction, "server.create");
      } catch (error) {
        if (error instanceof HetznerActionStillRunningError) throw error;
        await this.cleanupFailedProvisioning(server.id, bootstrapSshKey.id, primaryIp.id, firewall.id);
        throw error;
      }
    } else if (server.status !== "running") {
      throw new RetryableError("pool host create action is not observable", 30);
    }

    try {
      await this.markBootstrapComplete(server);
    } catch {
      emitProviderTelemetry("server.bootstrap_complete", "deferred");
      throw new RetryableError("pool host is running but bootstrap metadata is not yet durable", 30);
    }
    await this.deleteBootstrapKeysBestEffort();
    try {
      if (!server.public_net.ipv4) server.public_net.ipv4 = { id: primaryIp.id, ip: primaryIp.ip };
      const ipv4 = server.public_net.ipv4;
      if (!ipv4) throw new TerminalError("Hetzner pool host has no public IPv4");
      return this.jobResource(server, firewall, request, expiresAt);
    } catch (error) {
      await this.deleteHost(this.hostResource(server, firewall));
      throw error;
    }
  }

  async delete(resource: ComputeResource): Promise<void> {
    if (resource.provider !== "hetzner-pool-host") return;
    await this.deleteHost(resource);
  }

  async releaseIdleHost(sourceIp: string): Promise<boolean> {
    const servers = await this.list<HetznerServer>("servers");
    const server = servers.find((candidate) => candidate.public_net.ipv4?.ip === sourceIp);
    if (!server) {
      if (servers.length > 0) return false;
      return (await this.deleteOrphanProviderObjects(Math.floor(Date.now() / 1000))) > 0;
    }
    await this.deleteHost(this.hostResource(server, (await this.list<HetznerFirewall>("firewalls"))[0]));
    return true;
  }

  async listExpired(now: number): Promise<ComputeResource[]> {
    const servers = await this.list<HetznerServer>("servers");
    if (servers.length > 1) throw new TerminalError("pool invariant violated: more than one host exists");
    const server = servers[0];
    if (server?.status === "running") await this.deleteBootstrapKeysBestEffort();
    if (server && expired(server.labels, now)) {
      return [this.hostResource(server, (await this.list<HetznerFirewall>("firewalls"))[0])];
    }
    if (!server) await this.deleteOrphanProviderObjects(now);
    return [];
  }

  private async toJobResource(
    server: HetznerServer,
    request: ComputeCreateRequest,
    expiresAt: number,
  ): Promise<ComputeResource> {
    return this.jobResource(server, (await this.list<HetznerFirewall>("firewalls"))[0], request, expiresAt);
  }

  private jobResource(
    server: HetznerServer,
    firewall: HetznerFirewall | undefined,
    request: ComputeCreateRequest,
    expiresAt: number,
  ): ComputeResource {
    const ipv4 = server.public_net.ipv4;
    if (!ipv4) throw new TerminalError("Hetzner pool host has no public IPv4");
    return {
      provider: "hetzner-pool-job",
      serverId: String(server.id),
      ...(firewall ? { firewallId: String(firewall.id) } : {}),
      primaryIpv4Id: String(ipv4.id),
      publicIpv4: ipv4.ip,
      expiresAt,
      jobKey: request.jobKey,
    };
  }

  private hostResource(server: HetznerServer, firewall: HetznerFirewall | undefined): ComputeResource {
    const ipv4 = server.public_net.ipv4;
    return {
      provider: "hetzner-pool-host",
      serverId: String(server.id),
      ...(firewall ? { firewallId: String(firewall.id) } : {}),
      ...(ipv4 ? { primaryIpv4Id: String(ipv4.id), publicIpv4: ipv4.ip } : { publicIpv4: "" }),
      expiresAt: Number(server.labels.expires_at) || 0,
      jobKey: `pool-host-${server.id}`,
    };
  }

  private async refreshExpiry(server: HetznerServer, expiresAt: number): Promise<void> {
    const current = Number(server.labels.expires_at) || 0;
    if (current >= expiresAt) return;
    const labels = { ...server.labels, expires_at: String(expiresAt) };
    await this.request(`/servers/${server.id}`, { method: "PUT", body: JSON.stringify({ labels }) });
    const ipv4 = server.public_net.ipv4;
    if (ipv4) await this.request(`/primary_ips/${ipv4.id}`, { method: "PUT", body: JSON.stringify({ labels }) });
    for (const firewall of await this.list<HetznerFirewall>("firewalls")) {
      await this.request(`/firewalls/${firewall.id}`, { method: "PUT", body: JSON.stringify({ labels }) });
    }
    server.labels = labels;
  }

  private async markBootstrapComplete(server: HetznerServer): Promise<void> {
    if (server.labels.bootstrap_complete === "true") return;
    const labels = { ...server.labels, bootstrap_complete: "true" };
    await this.request(`/servers/${server.id}`, { method: "PUT", body: JSON.stringify({ labels }) });
    server.labels = labels;
  }

  private async recoverSingleHost(): Promise<HetznerServer | undefined> {
    for (const delay of [0, 100, 250, 500, 1_000, 2_000]) {
      if (delay > 0) await this.sleep(delay);
      const servers = await this.list<HetznerServer>("servers");
      if (servers.length > 1) throw new TerminalError("pool invariant violated: more than one host exists");
      if (servers[0]) return servers[0];
    }
    return undefined;
  }

  private async recoverSinglePrimaryIp(): Promise<HetznerPrimaryIp | undefined> {
    for (const delay of [0, 100, 250, 500, 1_000, 2_000]) {
      if (delay > 0) await this.sleep(delay);
      const ips = await this.list<HetznerPrimaryIp>("primary_ips");
      if (ips.length > 1) throw new TerminalError("pool invariant violated: more than one Primary IPv4 exists");
      if (ips[0]) return ips[0];
    }
    return undefined;
  }

  private async recoverSingleSshKey(): Promise<HetznerSshKey | undefined> {
    for (const delay of [0, 100, 250, 500, 1_000, 2_000]) {
      if (delay > 0) await this.sleep(delay);
      const keys = await this.list<HetznerSshKey>("ssh_keys");
      if (keys.length > 1) throw new TerminalError("pool invariant violated: more than one bootstrap SSH key exists");
      if (keys[0]) return keys[0];
    }
    return undefined;
  }

  private async waitForAction(initial: HetznerAction, operation: string): Promise<void> {
    const deadline = this.now() + ACTION_WAIT_TIMEOUT_MS;
    let action = initial;
    let delayIndex = 0;
    let lastStatus: HetznerAction["status"] | undefined;

    while (true) {
      if (action.status !== lastStatus) {
        emitProviderTelemetry(operation, action.status, undefined, action.error?.code);
        lastStatus = action.status;
      }
      if (action.status === "success") return;
      if (action.status === "error") throw actionError(operation, action.error);

      const remaining = deadline - this.now();
      if (remaining <= 0) {
        emitProviderTelemetry(operation, "timeout");
        throw new HetznerActionStillRunningError(`Hetzner ${operation} action is still running`, 30);
      }
      const delay = Math.min(
        ACTION_POLL_DELAYS_MS[Math.min(delayIndex, ACTION_POLL_DELAYS_MS.length - 1)]!,
        remaining,
      );
      await this.sleep(delay);
      delayIndex += 1;

      const requestBudget = deadline - this.now();
      if (requestBudget <= 0) continue;
      try {
        action = (
          await this.request<{ action: HetznerAction }>(
            `/actions/${action.id}`,
            { method: "GET" },
            false,
            Math.min(PROVIDER_REQUEST_TIMEOUT_MS, requestBudget),
          )
        ).action;
      } catch {
        throw new HetznerActionStillRunningError(`Hetzner ${operation} action could not be observed`, 30);
      }
    }
  }

  private async deleteHost(resource: ComputeResource): Promise<void> {
    const errors: unknown[] = [];
    for (const [kind, id] of [
      ["servers", resource.serverId],
      ["primary_ips", resource.primaryIpv4Id],
      ["firewalls", resource.firewallId],
    ] as const) {
      if (!id) continue;
      try { await this.deleteId(kind, id); } catch (error) { errors.push(error); }
    }
    try { await this.deleteBootstrapKeys(); } catch (error) { errors.push(error); }
    if (errors.length > 0) throw new RetryableError(`pool cleanup left ${errors.length} provider object(s)`, 30);
  }

  private async cleanupFailedProvisioning(
    serverId: number | undefined,
    sshKeyId: number,
    primaryIpId: number,
    firewallId: number,
  ): Promise<void> {
    const errors: unknown[] = [];
    for (const [kind, id] of [
      ["servers", serverId],
      ["ssh_keys", sshKeyId],
      ["primary_ips", primaryIpId],
      ["firewalls", firewallId],
    ] as const) {
      if (id === undefined) continue;
      try { await this.deleteId(kind, id); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) {
      throw new RetryableError(`failed provisioning cleanup left ${errors.length} provider object(s)`, 30);
    }
  }

  private async deleteBootstrapKeys(): Promise<void> {
    const keys = await this.list<HetznerSshKey>("ssh_keys");
    for (const key of keys) await this.deleteId("ssh_keys", key.id);
  }

  private async deleteBootstrapKeysBestEffort(): Promise<void> {
    try {
      await this.deleteBootstrapKeys();
    } catch {
      emitProviderTelemetry("bootstrap_ssh_key.cleanup", "deferred");
    }
  }

  private async deleteOrphanProviderObjects(now: number): Promise<number> {
    const [firewalls, ips, sshKeys] = await Promise.all([
      this.list<HetznerFirewall>("firewalls"),
      this.list<HetznerPrimaryIp>("primary_ips"),
      this.list<HetznerSshKey>("ssh_keys"),
    ]);
    let deleted = 0;
    for (const firewall of firewalls) {
      if (orphanCleanupDue(firewall.labels, now)) {
        await this.deleteId("firewalls", firewall.id);
        deleted += 1;
      }
    }
    for (const ip of ips) {
      if (orphanCleanupDue(ip.labels, now)) {
        await this.deleteId("primary_ips", ip.id);
        deleted += 1;
      }
    }
    for (const sshKey of sshKeys) {
      if (orphanCleanupDue(sshKey.labels, now)) {
        await this.deleteId("ssh_keys", sshKey.id);
        deleted += 1;
      }
    }
    return deleted;
  }

  private async list<T>(resource: string): Promise<T[]> {
    const selector = `managed_by=jit-runner-kit-pool,controller=cloudflare,pool_id=${this.config.poolId}`;
    const query = new URLSearchParams({ label_selector: selector, per_page: "50" });
    const response = await this.request<Record<string, unknown>>(`/${resource}?${query}`, { method: "GET" });
    return (response[resource] as T[] | undefined) ?? [];
  }

  private async deleteId(resource: string, id: string | number): Promise<void> {
    await this.request(`/${resource}/${id}`, { method: "DELETE" }, true);
  }

  private async request<T = unknown>(
    path: string,
    init: RequestInit,
    allowMissing = false,
    timeoutMs = PROVIDER_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    let response: Response;
    try {
      const fetcher = this.fetcher;
      response = await fetcher(`${this.apiUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
        headers: { Authorization: `Bearer ${this.config.token}`, "Content-Type": "application/json" },
      });
    } catch {
      emitProviderTelemetry(providerOperation(path, init.method), "transport_error");
      throw new HetznerTransportError("Hetzner API transport failure", 30);
    }
    if (response.ok) return response.status === 204 ? undefined as T : await response.json() as T;
    if (allowMissing && response.status === 404) return undefined as T;
    const error = await safeError(response);
    emitProviderTelemetry(providerOperation(path, init.method), "error", response.status, error.code);
    if (isRetryableProviderError(response.status, error.code)) {
      throw new RetryableError(`Hetzner API ${response.status}: ${error.message}`, 30);
    }
    throw new TerminalError(`Hetzner API ${response.status}: ${error.message}`);
  }
}

function actionError(operation: string, error?: HetznerAction["error"]): Error {
  const code = error?.code ?? "action_failed";
  const message = error?.message ?? "action failed";
  return RETRYABLE_ERROR_CODES.has(code)
    ? new RetryableError(`Hetzner ${operation} action ${code}: ${message}`, 30)
    : new TerminalError(`Hetzner ${operation} action ${code}: ${message}`);
}

function isRetryableProviderError(status: number, code: string): boolean {
  return [409, 412, 423, 429].includes(status) || status >= 500 || RETRYABLE_ERROR_CODES.has(code);
}

function providerOperation(path: string, method = "GET"): string {
  const normalized = path.split("?", 1)[0]!.replace(/\/\d+(?=\/|$)/g, "/:id");
  return `${method.toUpperCase()} ${normalized}`;
}

function emitProviderTelemetry(operation: string, status: string, httpStatus?: number, errorCode?: string): void {
  console.info(JSON.stringify({
    level: "info",
    event: "hetzner.operation",
    operation,
    status,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(errorCode ? { errorCode } : {}),
  }));
}

function validateConfig(config: HetznerPoolConfig): void {
  for (const [name, value] of [["controllerUrl", config.controllerUrl], ["agentUrl", config.agentUrl]] as const) {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
    if (url.username || url.password) throw new Error(`${name} must not contain URL credentials`);
    if (name === "controllerUrl" && (url.pathname !== "/" || url.search || url.hash)) {
      throw new Error("controllerUrl must be an HTTPS origin without a path, query, or fragment");
    }
  }
  if (!/^[a-f0-9]{64}$/i.test(config.agentSha256)) throw new Error("agentSha256 must be a SHA-256 digest");
  if (!/^[A-Za-z0-9_-]{43}$/.test(config.enrollmentToken)) {
    throw new Error("enrollmentToken must be 43 base64url characters");
  }
  if (!isEd25519PublicKey(config.bootstrapSshPublicKey)) {
    throw new Error("bootstrapSshPublicKey must be a single OpenSSH Ed25519 public key");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(config.poolId)) throw new Error("poolId is invalid");
  if (!isImmutableImage(config.runnerImage)) throw new Error("runnerImage must use a safe immutable digest reference");
  if (!isImmutableImage(config.dindImage)) throw new Error("dindImage must use a safe immutable digest reference");
  if (!Number.isInteger(config.maxRunners) || config.maxRunners < 1 || config.maxRunners > 2) {
    throw new Error("maxRunners must be between 1 and 2");
  }
  if (!Number.isInteger(config.idleSeconds) || config.idleSeconds < 300 || config.idleSeconds > 3600) {
    throw new Error("idleSeconds must be between 300 and 3600");
  }
}

function isEd25519PublicKey(value: string): boolean {
  if (value.includes("\n") || value.includes("\r")) return false;
  const [algorithm, encoded, ...comment] = value.trim().split(" ");
  if (algorithm !== "ssh-ed25519" || !encoded || comment.some((part) => !/^[A-Za-z0-9._@+-]+$/.test(part))) {
    return false;
  }
  try {
    const decoded = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const prefix = new TextEncoder().encode("\0\0\0\u000bssh-ed25519\0\0\0 ");
    return decoded.length === 51 && prefix.every((byte, index) => decoded[index] === byte);
  } catch {
    return false;
  }
}

function poolLabels(poolId: string, expiresAt: number, repository: string, createdAt: number): Record<string, string> {
  return {
    managed_by: "jit-runner-kit-pool",
    controller: "cloudflare",
    pool_id: poolId,
    repository: repository.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").slice(0, 63),
    expires_at: String(expiresAt),
    created_at: String(createdAt),
  };
}

function expired(labels: Record<string, string>, now: number): boolean {
  const expiresAt = Number(labels.expires_at);
  return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now;
}

function orphanCleanupDue(labels: Record<string, string>, now: number): boolean {
  if (expired(labels, now)) return true;
  const createdAt = Number(labels.created_at);
  return Number.isFinite(createdAt)
    && createdAt > 0
    && createdAt + ORPHAN_CREATION_GRACE_SECONDS <= now;
}

function cloudInit(request: ComputeCreateRequest, config: HetznerPoolConfig): string {
  const environment = [
    `JIT_POOL_CONTROLLER_URL=${config.controllerUrl}`,
    `JIT_POOL_ENROLLMENT_TOKEN=${config.enrollmentToken}`,
    `JIT_POOL_MAX_RUNNERS=${config.maxRunners}`,
    `JIT_POOL_IDLE_SECONDS=${config.idleSeconds}`,
    `JIT_POOL_RUNNER_IMAGE=${config.runnerImage}`,
    `JIT_POOL_DIND_IMAGE=${config.dindImage}`,
  ].join("\n");
  const install = `#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
agent_url="$(printf '%s' '${base64(config.agentUrl)}' | base64 --decode)"
runner_image="$(printf '%s' '${base64(config.runnerImage)}' | base64 --decode)"
dind_image="$(printf '%s' '${base64(config.dindImage)}' | base64 --decode)"
curl --fail --show-error --location --proto '=https' --tlsv1.2 "$agent_url" -o /usr/local/bin/jit-runner-pool-agent
echo '${config.agentSha256}  /usr/local/bin/jit-runner-pool-agent' | sha256sum --check --strict
chmod 0755 /usr/local/bin/jit-runner-pool-agent
systemctl disable --now ssh.service ssh.socket || true
systemctl enable --now docker
docker pull "$runner_image"
docker pull "$dind_image"
install -d -m 0700 /var/lib/jit-runner-kit /var/lib/jit-runner-kit/jobs
systemctl daemon-reload
systemctl enable --now jit-runner-pool-agent.service
`;
  const unit = `[Unit]
Description=JIT Runner Kit elastic pool agent
After=docker.service network-online.target
Wants=docker.service network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/jit-runner-kit/pool.env
ExecStart=/usr/local/bin/jit-runner-pool-agent
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
StateDirectory=jit-runner-kit
StateDirectoryMode=0700
ReadWritePaths=/var/lib/jit-runner-kit /var/run/docker.sock

[Install]
WantedBy=multi-user.target
`;
  return `#cloud-config
package_update: true
package_upgrade: false
ssh_pwauth: false
disable_root: true
packages: [ca-certificates, coreutils, curl, docker.io, jq]
write_files:
  - path: /etc/jit-runner-kit/pool.env
    owner: root:root
    permissions: '0600'
    encoding: b64
    content: ${base64(environment)}
  - path: /etc/systemd/system/jit-runner-pool-agent.service
    owner: root:root
    permissions: '0644'
    encoding: b64
    content: ${base64(unit)}
  - path: /usr/local/sbin/install-jit-runner-pool
    owner: root:root
    permissions: '0700'
    encoding: b64
    content: ${base64(install)}
runcmd:
  - /usr/local/sbin/install-jit-runner-pool
`;
}

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function isImmutableImage(value: string): boolean {
  return /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[a-z0-9_.-]+)?@sha256:[a-f0-9]{64}$/i.test(value);
}

async function safeError(response: Response): Promise<HetznerApiError> {
  try {
    const body = await response.json() as { error?: { message?: string; code?: string } };
    return {
      code: body.error?.code ?? "unknown_error",
      message: body.error?.message ?? body.error?.code ?? "request failed",
    };
  } catch {
    return { code: "unknown_error", message: "request failed" };
  }
}
