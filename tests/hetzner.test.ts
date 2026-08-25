import { describe, expect, it, vi } from "vitest";
import { HetznerComputeProvider } from "../packages/adapter-compute-hetzner/src/index";

describe("Hetzner compute adapter", () => {
  it("creates deny-inbound compute without SSH and deletes every billable resource", async () => {
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      requests.push({ url, method, ...(body ? { body } : {}) });
      if (method === "GET" && url.includes("/servers?")) return response({ servers: [], meta: pageEnd() });
      if (method === "GET" && url.includes("/firewalls?")) return response({ firewalls: [], meta: pageEnd() });
      if (method === "POST" && url.endsWith("/firewalls")) {
        return response({ firewall: { id: 22, labels: body?.labels } }, 201);
      }
      if (method === "POST" && url.endsWith("/servers")) {
        return response({
          server: {
            id: 11,
            labels: body?.labels,
            public_net: { ipv4: { id: 33, ip: "192.0.2.10" } },
          },
        }, 201);
      }
      if (method === "PUT" && url.endsWith("/primary_ips/33")) return response({ primary_ip: {} });
      if (method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${method} ${url}`);
    }) as unknown as typeof fetch;

    const provider = new HetznerComputeProvider({ token: "test" }, fetcher);
    const resource = await provider.create({
      jobKey: "job-101",
      repository: "owner/repository",
      serverName: "jit-101",
      serverType: "cx33",
      location: "fsn1",
      image: "ubuntu-24.04",
      architecture: "x64",
      expiresAt: 1_300,
      bootstrapToken: "single-use-token",
      bootstrapUrl: "https://controller.example.test/v1/bootstrap/job-101",
    });
    expect(resource).toMatchObject({ serverId: "11", firewallId: "22", primaryIpv4Id: "33" });
    const firewallCreate = requests.find((request) => request.method === "POST" && request.url.endsWith("/firewalls"));
    expect(firewallCreate?.body?.rules).toEqual([]);
    const serverCreate = requests.find((request) => request.method === "POST" && request.url.endsWith("/servers"));
    expect(serverCreate?.body).not.toHaveProperty("ssh_keys");
    expect(serverCreate?.body?.user_data).toContain("#cloud-config");
    expect(serverCreate?.body?.user_data).not.toContain("encoded_jit_config");

    await provider.delete(resource);
    expect(requests.filter((request) => request.method === "DELETE").map((request) => request.url)).toEqual([
      "https://api.hetzner.cloud/v1/servers/11",
      "https://api.hetzner.cloud/v1/primary_ips/33",
      "https://api.hetzner.cloud/v1/firewalls/22",
    ]);
  });

  it("rolls back server, Primary IPv4, and firewall when post-create labeling fails", async () => {
    const deleted: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      if (method === "GET" && url.includes("/servers?")) return response({ servers: [], meta: pageEnd() });
      if (method === "GET" && url.includes("/firewalls?")) return response({ firewalls: [], meta: pageEnd() });
      if (method === "POST" && url.endsWith("/firewalls")) return response({ firewall: { id: 22, labels: body?.labels } }, 201);
      if (method === "POST" && url.endsWith("/servers")) return response({
        server: { id: 11, labels: body?.labels, public_net: { ipv4: { id: 33, ip: "192.0.2.10" } } },
      }, 201);
      if (method === "PUT" && url.endsWith("/primary_ips/33")) return response({ error: { message: "temporary" } }, 503);
      if (method === "DELETE") {
        deleted.push(url);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    }) as unknown as typeof fetch;
    const provider = new HetznerComputeProvider({ token: "test" }, fetcher);
    await expect(provider.create({
      jobKey: "job-101",
      repository: "owner/repository",
      serverName: "jit-101",
      serverType: "cx33",
      location: "fsn1",
      image: "ubuntu-24.04",
      architecture: "x64",
      expiresAt: 1_300,
      bootstrapToken: "single-use-token",
      bootstrapUrl: "https://controller.example.test/v1/bootstrap/job-101",
    })).rejects.toThrow("Hetzner API 503");
    expect(deleted).toEqual([
      "https://api.hetzner.cloud/v1/servers/11",
      "https://api.hetzner.cloud/v1/primary_ips/33",
      "https://api.hetzner.cloud/v1/firewalls/22",
    ]);
  });

  it("discovers and deletes a labeled server after an ambiguous create response", async () => {
    const deleted: string[] = [];
    let serverLists = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      if (method === "GET" && url.includes("/servers?")) {
        serverLists += 1;
        return response({
          servers: serverLists === 1 ? [] : [{
            id: 11,
            labels: { managed_by: "jit-runner-kit", controller: "cloudflare", job_key: "job-101" },
            public_net: { ipv4: { id: 33, ip: "192.0.2.10" } },
          }],
          meta: pageEnd(),
        });
      }
      if (method === "GET" && url.includes("/firewalls?")) return response({ firewalls: [], meta: pageEnd() });
      if (method === "POST" && url.endsWith("/firewalls")) return response({ firewall: { id: 22, labels: body?.labels } }, 201);
      if (method === "POST" && url.endsWith("/servers")) return response({ error: { message: "ambiguous" } }, 503);
      if (method === "DELETE") {
        deleted.push(url);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    }) as unknown as typeof fetch;
    const provider = new HetznerComputeProvider({ token: "test" }, fetcher);
    await expect(provider.create({
      jobKey: "job-101",
      repository: "owner/repository",
      serverName: "jit-101",
      serverType: "cx33",
      location: "fsn1",
      image: "ubuntu-24.04",
      architecture: "x64",
      expiresAt: 1_300,
      bootstrapToken: "single-use-token",
      bootstrapUrl: "https://controller.example.test/v1/bootstrap/job-101",
    })).rejects.toThrow("Hetzner API 503");
    expect(deleted).toEqual([
      "https://api.hetzner.cloud/v1/servers/11",
      "https://api.hetzner.cloud/v1/primary_ips/33",
      "https://api.hetzner.cloud/v1/firewalls/22",
    ]);
  });
});

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function pageEnd() {
  return { pagination: { next_page: null } };
}
