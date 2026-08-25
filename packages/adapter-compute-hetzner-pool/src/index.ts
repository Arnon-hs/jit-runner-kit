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
  poolId: string;
  apiUrl?: string;
}

interface HetznerServer {
  id: number;
  labels: Record<string, string>;
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
  ) {
    this.apiUrl = config.apiUrl ?? "https://api.hetzner.cloud/v1";
    validateConfig(config);
  }

  async create(request: ComputeCreateRequest): Promise<ComputeResource> {
    const servers = await this.list<HetznerServer>("servers");
    if (servers.length > 1) throw new TerminalError("pool invariant violated: more than one host exists");
    const expiresAt = request.expiresAt + this.config.idleSeconds;
    if (servers[0]) {
      await this.refreshExpiry(servers[0], expiresAt);
      return await this.toJobResource(servers[0], request, expiresAt);
    }

    const existingFirewalls = await this.list<HetznerFirewall>("firewalls");
    if (existingFirewalls.length > 1) throw new TerminalError("pool invariant violated: more than one firewall exists");
    const existingFirewall = existingFirewalls[0];
    if (existingFirewall) {
      const recovered = await this.recoverSingleHost();
      if (recovered) {
        await this.refreshExpiry(recovered, expiresAt);
        return this.jobResource(recovered, existingFirewall, request, expiresAt);
      }
      const createdAt = Number(existingFirewall.labels.created_at) || 0;
      if (createdAt + 120 > Math.floor(Date.now() / 1000)) {
        throw new RetryableError("pool host creation outcome is still ambiguous", 30);
      }
      await this.deleteId("firewalls", existingFirewall.id);
    }

    const labels = poolLabels(this.config.poolId, expiresAt, request.repository, Math.floor(Date.now() / 1000));
    const firewall = (
      await this.request<{ firewall: HetznerFirewall }>("/firewalls", {
        method: "POST",
        body: JSON.stringify({ name: `jrk-${this.config.poolId}-deny-inbound`, labels, rules: [] }),
      })
    ).firewall;

    let server: HetznerServer | undefined;
    try {
      server = (
        await this.request<{ server: HetznerServer }>("/servers", {
          method: "POST",
          body: JSON.stringify({
            name: `jrk-${this.config.poolId}-${request.location}`,
            server_type: request.serverType,
            image: request.image,
            location: request.location,
            labels,
            user_data: cloudInit(request, this.config),
            firewalls: [{ firewall: firewall.id }],
            public_net: { enable_ipv4: true, enable_ipv6: false },
            start_after_create: true,
          }),
        })
      ).server;
    } catch (error) {
      if (!(error instanceof RetryableError)) {
        await this.deleteId("firewalls", firewall.id);
        throw error;
      }
      server = await this.recoverSingleHost();
      if (!server) throw new RetryableError("pool host create outcome remains ambiguous", 30);
    }

    try {
      const ipv4 = server.public_net.ipv4;
      if (!ipv4) throw new TerminalError("Hetzner pool host has no public IPv4");
      await this.request(`/primary_ips/${ipv4.id}`, {
        method: "PUT",
        body: JSON.stringify({ labels }),
      });
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
    if (!server) return false;
    await this.deleteHost(this.hostResource(server, (await this.list<HetznerFirewall>("firewalls"))[0]));
    return true;
  }

  async listExpired(now: number): Promise<ComputeResource[]> {
    const servers = await this.list<HetznerServer>("servers");
    if (servers.length > 1) throw new TerminalError("pool invariant violated: more than one host exists");
    const server = servers[0];
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

  private async recoverSingleHost(): Promise<HetznerServer | undefined> {
    for (const delay of [0, 100, 250, 500, 1_000, 2_000]) {
      if (delay > 0) await this.sleep(delay);
      const servers = await this.list<HetznerServer>("servers");
      if (servers.length > 1) throw new TerminalError("pool invariant violated: more than one host exists");
      if (servers[0]) return servers[0];
    }
    return undefined;
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
    if (errors.length > 0) throw new RetryableError(`pool cleanup left ${errors.length} provider object(s)`, 30);
  }

  private async deleteOrphanProviderObjects(now = Number.POSITIVE_INFINITY): Promise<void> {
    const [firewalls, ips] = await Promise.all([
      this.list<HetznerFirewall>("firewalls"),
      this.list<HetznerPrimaryIp>("primary_ips"),
    ]);
    for (const firewall of firewalls) {
      if (expired(firewall.labels, now)) await this.deleteId("firewalls", firewall.id);
    }
    for (const ip of ips) {
      if (expired(ip.labels, now)) await this.deleteId("primary_ips", ip.id);
    }
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

  private async request<T = unknown>(path: string, init: RequestInit, allowMissing = false): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.apiUrl}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.config.token}`, "Content-Type": "application/json" },
      });
    } catch (error) {
      throw new RetryableError(`Hetzner API transport failure: ${message(error)}`, 30);
    }
    if (response.ok) return response.status === 204 ? undefined as T : await response.json() as T;
    if (allowMissing && response.status === 404) return undefined as T;
    const body = await safeError(response);
    if ([409, 423, 429].includes(response.status) || response.status >= 500) {
      throw new RetryableError(`Hetzner API ${response.status}: ${body}`, 30);
    }
    throw new TerminalError(`Hetzner API ${response.status}: ${body}`);
  }
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
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(config.poolId)) throw new Error("poolId is invalid");
  if (!isImmutableImage(config.runnerImage)) throw new Error("runnerImage must use a safe immutable digest reference");
  if (!isImmutableImage(config.dindImage)) throw new Error("dindImage must use a safe immutable digest reference");
  if (!Number.isInteger(config.maxRunners) || config.maxRunners < 1 || config.maxRunners > 4) {
    throw new Error("maxRunners must be between 1 and 4");
  }
  if (!Number.isInteger(config.idleSeconds) || config.idleSeconds < 300 || config.idleSeconds > 3600) {
    throw new Error("idleSeconds must be between 300 and 3600");
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

async function safeError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string; code?: string } };
    return body.error?.message ?? body.error?.code ?? "request failed";
  } catch { return "request failed"; }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
