import { describe, expect, it, vi } from "vitest";
import type { ComputeCreateRequest } from "../packages/contracts/src/index";
import { RetryableError, TerminalError } from "../packages/contracts/src/index";
import { HetznerPoolComputeProvider } from "../packages/adapter-compute-hetzner-pool/src/index";

const dind = `docker:27-dind@sha256:${"a".repeat(64)}`;
const runner = `ghcr.io/owner/runner@sha256:${"b".repeat(64)}`;

describe("elastic Hetzner pool compute adapter", () => {
  it("invokes a native-style fetcher without an instance receiver", async () => {
    const api = new FakeHetznerPoolApi();
    const receivers: unknown[] = [];
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetcher = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      receivers.push(this);
      signals.push(init?.signal);
      return api.fetch(input, init);
    } as typeof fetch;

    await createProvider(fetcher).listExpired(1_000);

    expect(receivers.length).toBeGreaterThan(0);
    expect(receivers.every((receiver) => receiver === undefined)).toBe(true);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it("reuses at most one host and deletes no provider object during per-job cleanup", async () => {
    const api = new FakeHetznerPoolApi();
    const provider = createProvider(api.fetch);
    const first = await provider.create(request("job-101"));
    const second = await provider.create(request("job-102"));

    expect(first.serverId).toBe(second.serverId);
    expect(first.publicIpv4).toBe("192.0.2.10");
    expect(api.serverCreates).toBe(1);
    expect(api.firewallCreates).toBe(1);
    expect(api.primaryIpCreates).toBe(1);
    expect(api.ips[0]?.labels).toMatchObject({
      managed_by: "jit-runner-kit-pool",
      controller: "cloudflare",
      pool_id: "canary",
    });
    expect(api.lastServerBody?.firewalls).toEqual([{ firewall: 21 }]);
    expect(api.lastServerBody?.public_net).toEqual({ enable_ipv4: true, enable_ipv6: false, ipv4: 31 });
    expect(String(api.lastServerBody?.user_data)).not.toContain("bootstrap-token");
    expect(String(api.lastServerBody?.user_data)).toContain("#cloud-config");
    const writtenFiles = decodeCloudInitFiles(String(api.lastServerBody?.user_data));
    expect(writtenFiles).toContain("StateDirectory=jit-runner-kit");
    expect(writtenFiles).toContain("install -d -m 0700 /var/lib/jit-runner-kit");

    await provider.delete(first);
    expect(api.deletes).toEqual([]);
  });

  it("releases one idle host with its IPv4 and firewall and is idempotent", async () => {
    const api = new FakeHetznerPoolApi();
    const provider = createProvider(api.fetch);
    await provider.create(request("job-101"));
    expect(await provider.releaseIdleHost("198.51.100.8")).toBe(false);
    expect(api.deletes).toEqual([]);
    expect(await provider.releaseIdleHost("192.0.2.10")).toBe(true);
    expect(api.deletes).toEqual(["servers/11", "primary_ips/31", "firewalls/21"]);
    expect(await provider.releaseIdleHost("192.0.2.10")).toBe(false);
  });

  it("keeps newly-created provider objects during the eventual-consistency grace", async () => {
    const api = new FakeHetznerPoolApi();
    const labels = { pool_id: "canary", created_at: "900", expires_at: "9999999999" };
    api.firewalls.push({ id: 21, labels });
    api.ips.push({ id: 31, ip: "192.0.2.10", labels });

    await createProvider(api.fetch).listExpired(1_000);

    expect(api.deletes).toEqual([]);
  });

  it("does not recycle an ambiguous pool capacity unit between 120 and 300 seconds", async () => {
    const api = new FakeHetznerPoolApi();
    const createdAt = Math.floor(Date.now() / 1000) - 121;
    const labels = { pool_id: "canary", created_at: String(createdAt), expires_at: "9999999999" };
    api.firewalls.push({ id: 21, labels });
    api.ips.push({ id: 31, ip: "192.0.2.10", labels });

    await expect(createProvider(api.fetch).create(request("job-101")))
      .rejects.toThrow("pool host creation outcome is still ambiguous");

    expect(api.deletes).toEqual([]);
    expect(api.serverCreates).toBe(0);
  });

  it("recycles detached pool capacity only after the full 300-second grace", async () => {
    const api = new FakeHetznerPoolApi();
    const createdAt = Math.floor(Date.now() / 1000) - 301;
    const labels = { pool_id: "canary", created_at: String(createdAt), expires_at: "9999999999" };
    api.firewalls.push({ id: 21, labels });
    api.ips.push({ id: 31, ip: "192.0.2.10", labels });

    await createProvider(api.fetch).create(request("job-101"));

    expect(api.deletes.slice(0, 2)).toEqual(["primary_ips/31", "firewalls/21"]);
    expect(api.serverCreates).toBe(1);
  });

  it("removes detached provider objects after a bounded creation grace", async () => {
    const api = new FakeHetznerPoolApi();
    const labels = { pool_id: "canary", created_at: "600", expires_at: "9999999999" };
    api.firewalls.push({ id: 21, labels });
    api.ips.push({ id: 31, ip: "192.0.2.10", labels });

    await createProvider(api.fetch).listExpired(1_000);

    expect(api.deletes).toEqual(["firewalls/21", "primary_ips/31"]);
  });

  it("fails closed instead of creating a second pool host", async () => {
    const api = new FakeHetznerPoolApi();
    api.servers = [api.makeServer(11), api.makeServer(12)];
    const provider = createProvider(api.fetch);
    await expect(provider.create(request("job-101"))).rejects.toBeInstanceOf(TerminalError);
    expect(api.serverCreates).toBe(0);
  });

  it("recovers an already-created host after an ambiguous server-create response", async () => {
    const api = new FakeHetznerPoolApi();
    api.loseFirstServerCreateTransportResponse = true;
    const provider = createProvider(api.fetch);

    const resource = await provider.create(request("job-101"));

    expect(resource.serverId).toBe("11");
    expect(api.serverCreates).toBe(1);
    expect(api.servers).toHaveLength(1);
  });

  it("preserves detached capacity only when the server-create outcome is unknown", async () => {
    const api = new FakeHetznerPoolApi();
    api.failFirstServerCreateTransportBeforeRequest = true;
    const provider = createProvider(api.fetch);

    await expect(provider.create(request("job-101")))
      .rejects.toThrow("pool host create outcome remains ambiguous");

    expect(api.serverCreates).toBe(1);
    expect(api.servers).toHaveLength(0);
    expect(api.firewalls).toHaveLength(1);
    expect(api.ips).toHaveLength(1);
    expect(api.deletes).toEqual([]);

    await expect(provider.create(request("job-101")))
      .rejects.toThrow("pool host creation outcome is still ambiguous");
    expect(api.serverCreates).toBe(1);
  });

  it("waits for the Primary IP action before creating a server", async () => {
    const api = new FakeHetznerPoolApi();
    api.primaryIpActionStatuses = ["running", "running", "success"];
    let now = 0;
    const sleeps: number[] = [];
    const provider = createProvider(api.fetch, "canary", {
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });

    await expect(provider.create(request("job-101"))).resolves.toMatchObject({ serverId: "11" });

    expect(api.actionReads).toBe(2);
    expect(api.serverCreateActionStatuses).toEqual(["success"]);
    expect(sleeps).toEqual([250, 500]);
  });

  it("bounds a still-running Primary IP action without deleting ambiguous resources", async () => {
    const api = new FakeHetznerPoolApi();
    api.primaryIpActionStatuses = ["running"];
    let now = 0;
    const provider = createProvider(api.fetch, "canary", {
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    });

    await expect(provider.create(request("job-101"))).rejects.toBeInstanceOf(RetryableError);

    expect(now).toBe(30_000);
    expect(api.serverCreates).toBe(0);
    expect(api.deletes).toEqual([]);
    expect(api.firewalls).toHaveLength(1);
    expect(api.ips).toHaveLength(1);
  });

  it("preserves ambiguous resources when the Primary IP action cannot be observed", async () => {
    const api = new FakeHetznerPoolApi();
    api.primaryIpActionStatuses = ["running"];
    api.actionReadFailure = { code: "unavailable", message: "temporary API outage" };
    let now = 0;

    await expect(createProvider(api.fetch, "canary", {
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    }).create(request("job-101"))).rejects.toBeInstanceOf(RetryableError);

    expect(api.serverCreates).toBe(0);
    expect(api.deletes).toEqual([]);
    expect(api.firewalls).toHaveLength(1);
    expect(api.ips).toHaveLength(1);
  });

  it("cleans a terminal Primary IP action and emits only safe error telemetry", async () => {
    const api = new FakeHetznerPoolApi();
    api.primaryIpActionStatuses = ["running", "error"];
    api.primaryIpActionError = { code: "invalid_input", message: "sensitive provider detail" };
    let now = 0;
    const logs: string[] = [];
    const log = vi.spyOn(console, "info").mockImplementation((value) => logs.push(String(value)));

    try {
      await expect(createProvider(api.fetch, "canary", {
        now: () => now,
        sleep: async (milliseconds) => { now += milliseconds; },
      }).create(request("job-101"))).rejects.toBeInstanceOf(TerminalError);
    } finally {
      log.mockRestore();
    }

    expect(api.serverCreates).toBe(0);
    expect(api.deletes).toEqual(["primary_ips/31", "firewalls/21"]);
    expect(logs.join("\n")).toContain('"operation":"primary_ip.create"');
    expect(logs.join("\n")).toContain('"errorCode":"invalid_input"');
    expect(logs.join("\n")).not.toContain("sensitive provider detail");
    expect(logs.join("\n")).not.toContain("test-token");
  });

  it("maps a resource-unavailable Primary IP action to a retryable failure and cleans it", async () => {
    const api = new FakeHetznerPoolApi();
    api.primaryIpActionStatuses = ["error"];
    api.primaryIpActionError = { code: "resource_unavailable", message: "try another moment" };

    await expect(createProvider(api.fetch).create(request("job-101"))).rejects.toBeInstanceOf(RetryableError);

    expect(api.serverCreates).toBe(0);
    expect(api.deletes).toEqual(["primary_ips/31", "firewalls/21"]);
  });

  it("cleans a known retryable server response and permits an immediate retry", async () => {
    const api = new FakeHetznerPoolApi();
    api.serverCreateFailure = { status: 412, code: "resource_unavailable", message: "capacity is warming" };
    const logs: string[] = [];
    const log = vi.spyOn(console, "info").mockImplementation((value) => logs.push(String(value)));

    try {
      const provider = createProvider(api.fetch);
      await expect(provider.create(request("job-101"))).rejects.toBeInstanceOf(RetryableError);

      expect(api.serverCreates).toBe(1);
      expect(api.deletes).toEqual(["primary_ips/31", "firewalls/21"]);
      expect(api.servers).toHaveLength(0);
      expect(api.firewalls).toHaveLength(0);
      expect(api.ips).toHaveLength(0);

      api.serverCreateFailure = null;
      await expect(provider.create(request("job-101"))).resolves.toMatchObject({ serverId: "11" });
      expect(api.serverCreates).toBe(2);
    } finally {
      log.mockRestore();
    }

    expect(logs.join("\n")).toContain('"operation":"POST /servers"');
    expect(logs.join("\n")).toContain('"httpStatus":412');
    expect(logs.join("\n")).toContain('"errorCode":"resource_unavailable"');
    expect(logs.join("\n")).not.toContain("capacity is warming");
    expect(logs.join("\n")).not.toContain("test-token");
  });

  it("cleans detached capacity after a known terminal server response", async () => {
    const api = new FakeHetznerPoolApi();
    api.serverCreateFailure = { status: 422, code: "invalid_input", message: "request cannot be accepted" };

    await expect(createProvider(api.fetch).create(request("job-101"))).rejects.toBeInstanceOf(TerminalError);

    expect(api.serverCreates).toBe(1);
    expect(api.deletes).toEqual(["primary_ips/31", "firewalls/21"]);
    expect(api.servers).toHaveLength(0);
    expect(api.firewalls).toHaveLength(0);
    expect(api.ips).toHaveLength(0);
  });

  it("scopes discovery and cleanup to one explicit pool id", async () => {
    const api = new FakeHetznerPoolApi();
    const canary = createProvider(api.fetch, "canary");
    const production = createProvider(api.fetch, "production");
    const first = await canary.create(request("job-101"));
    const second = await production.create(request("job-102"));

    expect(first.serverId).not.toBe(second.serverId);
    expect(api.servers).toHaveLength(2);
    expect(await canary.releaseIdleHost(first.publicIpv4)).toBe(true);
    expect(api.servers).toHaveLength(1);
    expect(api.servers[0]?.labels.pool_id).toBe("production");
  });
});

function createProvider(
  fetcher: typeof fetch,
  poolId = "canary",
  timing: {
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => number;
  } = {},
): HetznerPoolComputeProvider {
  return new HetznerPoolComputeProvider({
    token: "test-token",
    controllerUrl: "https://controller.example.test",
    agentUrl: "https://raw.githubusercontent.com/owner/repository/0123456789012345678901234567890123456789/bin/jit-runner-pool-agent",
    agentSha256: "c".repeat(64),
    runnerImage: runner,
    dindImage: dind,
    maxRunners: 2,
    idleSeconds: 600,
    enrollmentToken: "e".repeat(43),
    poolId,
    apiUrl: "https://api.example.test/v1",
  }, fetcher, timing.sleep ?? (async () => undefined), timing.now ?? (() => Date.now()));
}

function request(jobKey: string): ComputeCreateRequest {
  return {
    jobKey,
    repository: "owner/repository",
    serverName: "ignored-per-job-name",
    serverType: "cx33",
    location: "fsn1",
    image: "ubuntu-24.04",
    architecture: "x64",
    expiresAt: 2_000,
    provisioningAttempt: 1,
    bootstrapToken: "bootstrap-token",
    bootstrapTokenHash: "d".repeat(64),
    bootstrapUrl: "https://controller.example.test/v1/bootstrap/job-101",
  };
}

function decodeCloudInitFiles(value: string): string {
  return [...value.matchAll(/content: ([A-Za-z0-9+/=]+)/g)]
    .map((match) => Buffer.from(match[1]!, "base64").toString("utf8"))
    .join("\n");
}

class FakeHetznerPoolApi {
  servers: Array<ReturnType<FakeHetznerPoolApi["makeServer"]>> = [];
  firewalls: Array<{ id: number; labels: Record<string, string> }> = [];
  ips: Array<{ id: number; ip: string; labels: Record<string, string> }> = [];
  serverCreates = 0;
  firewallCreates = 0;
  primaryIpCreates = 0;
  actionReads = 0;
  deletes: string[] = [];
  lastServerBody: Record<string, unknown> | undefined;
  loseFirstServerCreateTransportResponse = false;
  failFirstServerCreateTransportBeforeRequest = false;
  primaryIpActionStatuses: Array<"running" | "success" | "error"> = ["success"];
  primaryIpActionError: { code: string; message: string } | null = null;
  actionReadFailure: { code: string; message: string } | null = null;
  serverCreateFailure: { status: number; code: string; message: string } | null = null;
  serverCreateActionStatuses: Array<"running" | "success" | "error"> = [];
  private nextServerId = 11;
  private nextFirewallId = 21;
  private nextIpId = 31;
  private actionStatusIndex = 0;

  readonly fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1\//, "");
    const method = init?.method ?? "GET";
    const poolId = new URLSearchParams(url.search).get("label_selector")
      ?.split(",")
      .find((part) => part.startsWith("pool_id="))
      ?.slice("pool_id=".length);
    const scoped = <T extends { labels: Record<string, string> }>(items: T[]) =>
      poolId ? items.filter((item) => item.labels.pool_id === poolId) : items;
    if (method === "GET") {
      if (path === "servers") return Response.json({ servers: scoped(this.servers) });
      if (path === "firewalls") return Response.json({ firewalls: scoped(this.firewalls) });
      if (path === "primary_ips") return Response.json({ primary_ips: scoped(this.ips) });
      if (path === "actions/41") {
        this.actionReads += 1;
        if (this.actionReadFailure) {
          return Response.json({ error: this.actionReadFailure }, { status: 503 });
        }
        this.actionStatusIndex = Math.min(this.actionStatusIndex + 1, this.primaryIpActionStatuses.length - 1);
        return Response.json({ action: this.primaryIpAction() });
      }
    }
    if (method === "POST" && path === "firewalls") {
      this.firewallCreates += 1;
      const body = JSON.parse(String(init?.body)) as { labels: Record<string, string> };
      const firewall = { id: this.nextFirewallId++, labels: body.labels };
      this.firewalls.push(firewall);
      return Response.json({ firewall }, { status: 201 });
    }
    if (method === "POST" && path === "primary_ips") {
      this.primaryIpCreates += 1;
      const body = JSON.parse(String(init?.body)) as { labels: Record<string, string> };
      const id = this.nextIpId++;
      const primaryIp = { id, ip: `192.0.2.${id - 21}`, labels: body.labels };
      this.ips.push(primaryIp);
      return Response.json({ primary_ip: primaryIp, action: this.primaryIpAction() }, { status: 201 });
    }
    if (method === "POST" && path === "servers") {
      this.serverCreates += 1;
      this.serverCreateActionStatuses.push(this.primaryIpAction().status);
      this.lastServerBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (this.failFirstServerCreateTransportBeforeRequest) {
        this.failFirstServerCreateTransportBeforeRequest = false;
        throw new TypeError("connection reset before provider accepted request");
      }
      if (this.primaryIpAction().status !== "success") {
        return Response.json({
          error: { code: "invalid_input", message: "Primary IPv4 is not ready" },
        }, { status: 422 });
      }
      if (this.serverCreateFailure) {
        return Response.json({
          error: { code: this.serverCreateFailure.code, message: this.serverCreateFailure.message },
        }, { status: this.serverCreateFailure.status });
      }
      const serverId = this.nextServerId++;
      const publicNet = this.lastServerBody.public_net as { ipv4: number };
      const primaryIp = this.ips.find((item) => item.id === publicNet.ipv4);
      if (!primaryIp) return Response.json({ error: { message: "Primary IPv4 missing" } }, { status: 400 });
      const ipId = primaryIp.id;
      const ip = primaryIp.ip;
      const server = this.makeServer(serverId, this.lastServerBody.labels as Record<string, string>, ipId, ip);
      this.servers.push(server);
      if (this.loseFirstServerCreateTransportResponse) {
        this.loseFirstServerCreateTransportResponse = false;
        throw new TypeError("connection reset after provider accepted request");
      }
      return Response.json({ server }, { status: 201 });
    }
    if (method === "PUT") {
      const labels = (JSON.parse(String(init?.body)) as { labels: Record<string, string> }).labels;
      const [kind, rawId] = path.split("/");
      const id = Number(rawId);
      const target = kind === "servers"
        ? this.servers.find((item) => item.id === id)
        : kind === "primary_ips"
          ? this.ips.find((item) => item.id === id)
          : this.firewalls.find((item) => item.id === id);
      if (target) target.labels = labels;
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE") {
      this.deletes.push(path);
      const [kind, rawId] = path.split("/");
      const id = Number(rawId);
      if (kind === "servers") this.servers = this.servers.filter((item) => item.id !== id);
      if (kind === "primary_ips") this.ips = this.ips.filter((item) => item.id !== id);
      if (kind === "firewalls") this.firewalls = this.firewalls.filter((item) => item.id !== id);
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: { message: `${method} ${path} not mocked` } }, { status: 500 });
  }) as unknown as typeof fetch;

  makeServer(
    id: number,
    labels: Record<string, string> = { expires_at: "2600", pool_id: "canary" },
    ipId = 31,
    ip = "192.0.2.10",
  ) {
    return { id, labels, public_net: { ipv4: { id: ipId, ip } } };
  }

  private primaryIpAction() {
    const status = this.primaryIpActionStatuses[this.actionStatusIndex] ?? "running";
    return {
      id: 41,
      status,
      error: status === "error" ? this.primaryIpActionError : null,
    };
  }
}
