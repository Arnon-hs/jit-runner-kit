import type { ComputeCreateRequest, ComputeProvider, ComputeResource } from "../../contracts/src/index";
import { RetryableError, TerminalError } from "../../contracts/src/index";

interface HetznerConfig {
  token: string;
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
  assignee_id: number | null;
}

export class HetznerComputeProvider implements ComputeProvider {
  private readonly apiUrl: string;

  constructor(
    private readonly config: HetznerConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.apiUrl = config.apiUrl ?? "https://api.hetzner.cloud/v1";
  }

  async create(request: ComputeCreateRequest): Promise<ComputeResource> {
    const existing = await this.findServer(request.jobKey);
    if (existing) return this.toResource(existing, await this.findFirewall(request.jobKey), request.expiresAt);

    const labels = resourceLabels(request.jobKey, request.repository, request.expiresAt);
    const firewall =
      (await this.findFirewall(request.jobKey)) ??
      (
        await this.request<{ firewall: HetznerFirewall }>("/firewalls", {
          method: "POST",
          body: JSON.stringify({ name: `${request.serverName}-deny-inbound`, labels, rules: [] }),
        })
      ).firewall;

    let createdServer: HetznerServer | undefined;
    try {
      const created = await this.request<{ server: HetznerServer }>("/servers", {
        method: "POST",
        body: JSON.stringify({
          name: request.serverName,
          server_type: request.serverType,
          image: request.image,
          location: request.location,
          labels,
          user_data: cloudInit(request),
          firewalls: [{ firewall: firewall.id }],
          public_net: { enable_ipv4: true, enable_ipv6: false },
          start_after_create: true,
        }),
      });
      createdServer = created.server;
      const ipv4 = createdServer.public_net.ipv4;
      if (!ipv4) throw new TerminalError("Hetzner server has no public IPv4");
      await this.request(`/primary_ips/${ipv4.id}`, {
        method: "PUT",
        body: JSON.stringify({ labels }),
      });
      return this.toResource(createdServer, firewall, request.expiresAt);
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      let serverLookupFailed = false;
      if (!createdServer) {
        try {
          createdServer = await this.findServer(request.jobKey);
        } catch (rollbackError) {
          serverLookupFailed = true;
          rollbackErrors.push(rollbackError);
        }
      }
      let serverDeleted = !createdServer && !serverLookupFailed;
      if (createdServer) {
        try {
          await this.deleteId("servers", createdServer.id);
          serverDeleted = true;
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (serverDeleted) {
        const ipv4 = createdServer?.public_net.ipv4;
        if (ipv4) {
          try {
            await this.deleteId("primary_ips", ipv4.id);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        try {
          await this.deleteId("firewalls", firewall.id);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new RetryableError(
          `Hetzner provisioning failed and rollback left ${rollbackErrors.length} resource error(s): ${errorMessage(error)}`,
          30,
        );
      }
      throw error;
    }
  }

  async delete(resource: ComputeResource): Promise<void> {
    if (resource.serverId) await this.deleteId("servers", resource.serverId);
    if (resource.primaryIpv4Id) await this.deleteId("primary_ips", resource.primaryIpv4Id);
    if (resource.firewallId) await this.deleteId("firewalls", resource.firewallId);
  }

  async listExpired(now: number): Promise<ComputeResource[]> {
    const [servers, firewalls, primaryIps] = await Promise.all([
      this.list<HetznerServer>("servers"),
      this.list<HetznerFirewall>("firewalls"),
      this.list<HetznerPrimaryIp>("primary_ips"),
    ]);
    const byJob = new Map<string, ComputeResource>();
    for (const server of servers) {
      if (!isExpired(server.labels, now)) continue;
      const jobKey = server.labels.job_key ?? `server-${server.id}`;
      byJob.set(jobKey, this.toResource(server, undefined, Number(server.labels.expires_at)));
    }
    for (const firewall of firewalls) {
      if (!isExpired(firewall.labels, now)) continue;
      const jobKey = firewall.labels.job_key ?? `firewall-${firewall.id}`;
      const current = byJob.get(jobKey) ?? emptyResource(jobKey, Number(firewall.labels.expires_at));
      byJob.set(jobKey, { ...current, firewallId: String(firewall.id) });
    }
    for (const ip of primaryIps) {
      if (!isExpired(ip.labels, now)) continue;
      const jobKey = ip.labels.job_key ?? `primary-ip-${ip.id}`;
      const current = byJob.get(jobKey) ?? emptyResource(jobKey, Number(ip.labels.expires_at));
      byJob.set(jobKey, { ...current, primaryIpv4Id: String(ip.id), publicIpv4: ip.ip });
    }
    return [...byJob.values()];
  }

  private async findServer(jobKey: string): Promise<HetznerServer | undefined> {
    return (await this.list<HetznerServer>("servers", jobKey))[0];
  }

  private async findFirewall(jobKey: string): Promise<HetznerFirewall | undefined> {
    return (await this.list<HetznerFirewall>("firewalls", jobKey))[0];
  }

  private async list<T>(resource: string, jobKey?: string): Promise<T[]> {
    const values: T[] = [];
    let page = 1;
    while (page > 0) {
      const selector = jobKey
        ? `managed_by=jit-runner-kit,controller=cloudflare,job_key=${jobKey}`
        : "managed_by=jit-runner-kit,controller=cloudflare";
      const query = new URLSearchParams({ label_selector: selector, page: String(page), per_page: "50" });
      const response = await this.request<Record<string, unknown>>(`/${resource}?${query}`, { method: "GET" });
      values.push(...((response[resource] as T[] | undefined) ?? []));
      const next = (response.meta as { pagination?: { next_page?: number | null } } | undefined)?.pagination?.next_page;
      page = next ?? 0;
    }
    return values;
  }

  private toResource(
    server: HetznerServer,
    firewall: HetznerFirewall | undefined,
    expiresAt: number,
  ): ComputeResource {
    const ipv4 = server.public_net.ipv4;
    if (!ipv4) throw new TerminalError("Hetzner server has no public IPv4");
    return {
      provider: "hetzner",
      serverId: String(server.id),
      ...(firewall ? { firewallId: String(firewall.id) } : {}),
      primaryIpv4Id: String(ipv4.id),
      publicIpv4: ipv4.ip,
      expiresAt,
      jobKey: server.labels.job_key ?? `server-${server.id}`,
    };
  }

  private async deleteId(resource: string, id: string | number): Promise<void> {
    await this.request(`/${resource}/${id}`, { method: "DELETE" }, true);
  }

  private async request<T = unknown>(path: string, init: RequestInit, allowMissing = false): Promise<T> {
    const response = await this.fetcher(`${this.apiUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
      },
    });
    if (response.ok) return (response.status === 204 ? undefined : await response.json()) as T;
    if (allowMissing && response.status === 404) return undefined as T;
    const body = await safeError(response);
    if (response.status === 429 || response.status === 423 || response.status >= 500) {
      throw new RetryableError(`Hetzner API ${response.status}: ${body}`, 30);
    }
    throw new TerminalError(`Hetzner API ${response.status}: ${body}`);
  }
}

function resourceLabels(jobKey: string, repository: string, expiresAt: number): Record<string, string> {
  return {
    managed_by: "jit-runner-kit",
    controller: "cloudflare",
    job_key: jobKey,
    repository: repository.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").slice(0, 63),
    expires_at: String(expiresAt),
  };
}

function isExpired(labels: Record<string, string>, now: number): boolean {
  const expiresAt = Number(labels.expires_at);
  return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now;
}

function emptyResource(jobKey: string, expiresAt: number): ComputeResource {
  return { provider: "hetzner", serverId: "", publicIpv4: "", expiresAt, jobKey };
}

async function safeError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string; code?: string } };
    return body.error?.message ?? body.error?.code ?? "request failed";
  } catch {
    return "request failed";
  }
}

function cloudInit(request: ComputeCreateRequest): string {
  const environment = [
    `BOOTSTRAP_URL=${request.bootstrapUrl}`,
    `BOOTSTRAP_TOKEN=${request.bootstrapToken}`,
    `RUNNER_ARCH=${request.architecture}`,
  ].join("\n");
  const script = `#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
source /run/jit-runner-bootstrap.env
response="$(curl --fail-with-body --silent --show-error --retry 20 --retry-connrefused --retry-delay 5 \\
  --header "Authorization: Bearer \${BOOTSTRAP_TOKEN}" \\
  --request POST "\${BOOTSTRAP_URL}")"
rm -f /run/jit-runner-bootstrap.env
unset BOOTSTRAP_TOKEN
jit_config="$(jq -er '.encoded_jit_config' <<<"$response")"
release="$(curl --fail-with-body --silent --show-error https://api.github.com/repos/actions/runner/releases/latest)"
asset="$(jq -cer --arg arch "$RUNNER_ARCH" '.assets[] | select(.name | test("actions-runner-linux-" + $arch + "-[0-9.]+\\\\.tar\\\\.gz$"))' <<<"$release")"
asset_url="$(jq -er '.browser_download_url' <<<"$asset")"
digest="$(jq -er '.digest | select(startswith("sha256:")) | sub("^sha256:"; "")' <<<"$asset")"
install -d -o runner -g runner /opt/actions-runner
curl --fail-with-body --location --silent --show-error "$asset_url" --output /tmp/actions-runner.tar.gz
printf '%s  %s\\n' "$digest" /tmp/actions-runner.tar.gz | sha256sum --check --status
tar -xzf /tmp/actions-runner.tar.gz -C /opt/actions-runner
/opt/actions-runner/bin/installdependencies.sh
chown -R runner:runner /opt/actions-runner
rm -f /tmp/actions-runner.tar.gz
cd /opt/actions-runner
exec runuser -u runner -- ./run.sh --jitconfig "$jit_config"
`;
  const unit = `[Unit]
Description=One-job GitHub Actions JIT runner bootstrap
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/sbin/jit-runner-bootstrap
Restart=no

[Install]
WantedBy=multi-user.target
`;
  return `#cloud-config
package_update: true
package_upgrade: false
packages:
  - build-essential
  - ca-certificates
  - curl
  - docker.io
  - docker-compose-v2
  - git
  - jq
  - php-cli
  - python3
  - shellcheck
users:
  - default
  - name: runner
    groups: [docker]
    shell: /bin/bash
    lock_passwd: true
write_files:
  - path: /run/jit-runner-bootstrap.env
    permissions: '0600'
    encoding: b64
    content: ${encodeBase64(environment)}
  - path: /usr/local/sbin/jit-runner-bootstrap
    permissions: '0700'
    encoding: b64
    content: ${encodeBase64(script)}
  - path: /etc/systemd/system/jit-runner-bootstrap.service
    permissions: '0644'
    encoding: b64
    content: ${encodeBase64(unit)}
runcmd:
  - systemctl enable --now docker
  - systemctl daemon-reload
  - systemctl enable --now jit-runner-bootstrap.service
`;
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
