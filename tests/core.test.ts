import { describe, expect, it } from "vitest";
import type {
  BootstrapTokenBroker,
  Clock,
  ComputeCreateRequest,
  ComputeProvider,
  ComputeResource,
  JobRecord,
  JobStore,
  JitConfiguration,
  LeaseStore,
  RunnerControl,
  Telemetry,
  TrustedWorkflowJobEvent,
} from "../packages/contracts/src/index";
import { RetryableError, TerminalError } from "../packages/contracts/src/index";
import { Controller, trustWorkflowJobPayload } from "../packages/core/src/index";

const event: TrustedWorkflowJobEvent = {
  deliveryId: "00000000-0000-4000-8000-000000000001",
  action: "queued",
  jobId: 101,
  runId: 51,
  installationId: 7,
  repository: { id: 3, fullName: "owner/repository" },
  headBranch: "main",
  labels: ["self-hosted", "linux", "x64", "jit-runner", "jit-run-51"],
};

describe("provider-agnostic controller", () => {
  it("runs queued -> bootstrap -> completed and cleans every external record", async () => {
    const fixture = createFixture();
    await fixture.controller.handleWorkflowJob(event);
    expect((await fixture.jobs.get("job-101"))?.state).toBe("awaiting-bootstrap");
    expect(fixture.compute.created).toHaveLength(1);

    const bootstrap = await fixture.controller.exchangeBootstrap("job-101", "bootstrap-token", "192.0.2.10");
    expect(bootstrap.encodedJitConfig).toBe("encoded-jit-config");
    expect((await fixture.jobs.get("job-101"))?.bootstrapTokenHash).toBeUndefined();
    expect((await fixture.jobs.get("job-101"))?.state).toBe("running");

    await fixture.controller.handleWorkflowJob({ ...event, action: "completed", conclusion: "success" });
    expect((await fixture.jobs.get("job-101"))?.state).toBe("completed");
    expect(fixture.compute.deleted).toEqual(["server-101"]);
    expect(fixture.runners.deleted).toEqual([9001]);
    expect(fixture.leases.active.size).toBe(0);
  });

  it("is idempotent for duplicate queued deliveries and one-time bootstrap exchange", async () => {
    const fixture = createFixture();
    await fixture.controller.handleWorkflowJob(event);
    await fixture.controller.handleWorkflowJob({ ...event, deliveryId: "00000000-0000-4000-8000-000000000002" });
    expect(fixture.compute.created).toHaveLength(1);
    await fixture.controller.exchangeBootstrap("job-101", "bootstrap-token", "192.0.2.10");
    await expect(
      fixture.controller.exchangeBootstrap("job-101", "bootstrap-token", "192.0.2.10"),
    ).rejects.toThrow("bootstrap is not available");
  });

  it("rejects a bootstrap request from any address other than the provisioned VM", async () => {
    const fixture = createFixture();
    await fixture.controller.handleWorkflowJob(event);
    await expect(
      fixture.controller.exchangeBootstrap("job-101", "bootstrap-token", "198.51.100.8"),
    ).rejects.toBeInstanceOf(TerminalError);
    expect(fixture.compute.deleted).toHaveLength(0);
  });

  it("atomically consumes bootstrap state when requests overlap", async () => {
    const fixture = createFixture();
    await fixture.controller.handleWorkflowJob(event);
    const results = await Promise.allSettled([
      fixture.controller.exchangeBootstrap("job-101", "bootstrap-token", "192.0.2.10"),
      fixture.controller.exchangeBootstrap("job-101", "bootstrap-token", "192.0.2.10"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(fixture.runners.created).toBe(1);
    expect((await fixture.jobs.get("job-101"))?.state).toBe("running");
  });

  it("rejects an expired bootstrap token and cleans its VM", async () => {
    const fixture = createFixture();
    await fixture.controller.handleWorkflowJob(event);
    fixture.clock.value = 1_301;
    await expect(
      fixture.controller.exchangeBootstrap("job-101", "bootstrap-token", "192.0.2.10"),
    ).rejects.toThrow("bootstrap has expired");
    expect(fixture.compute.deleted).toEqual(["server-101"]);
  });

  it("enforces the global one-VM-per-job concurrency lease", async () => {
    const fixture = createFixture(1);
    await fixture.controller.handleWorkflowJob(event);
    await expect(
      fixture.controller.handleWorkflowJob({ ...event, jobId: 102 }),
    ).rejects.toBeInstanceOf(RetryableError);
    expect(fixture.compute.created).toHaveLength(1);
  });

  it("cleans expired jobs and provider-labeled orphans", async () => {
    const fixture = createFixture();
    await fixture.controller.handleWorkflowJob(event);
    fixture.clock.value = 2_000;
    fixture.compute.expired.push({
      provider: "hetzner",
      serverId: "orphan",
      publicIpv4: "192.0.2.99",
      expiresAt: 1,
      jobKey: "job-orphan",
    });
    await fixture.controller.reconcile();
    expect((await fixture.jobs.get("job-101"))?.state).toBe("completed");
    expect(fixture.compute.deleted).toEqual(["server-101", "orphan"]);
  });

  it("does not let a duplicate task re-enter in-flight provisioning", async () => {
    const fixture = createFixture();
    fixture.compute.pauseNextCreate();
    const first = fixture.controller.handleWorkflowJob(event);
    await fixture.compute.waitUntilCreateStarted();
    await fixture.controller.handleWorkflowJob({ ...event, deliveryId: "00000000-0000-4000-8000-000000000003" });
    fixture.compute.resumeCreate();
    await first;
    expect(fixture.compute.created).toHaveLength(1);
    expect((await fixture.jobs.get("job-101"))?.state).toBe("awaiting-bootstrap");
  });

  it("continues provider sweeping after one job cleanup fails", async () => {
    const fixture = createFixture();
    await fixture.controller.handleWorkflowJob(event);
    await fixture.controller.exchangeBootstrap("job-101", "bootstrap-token", "192.0.2.10");
    fixture.runners.failDelete = true;
    fixture.clock.value = 2_000;
    fixture.compute.expired.push({
      provider: "hetzner",
      serverId: "orphan",
      publicIpv4: "192.0.2.99",
      expiresAt: 1,
      jobKey: "job-orphan",
    });
    await expect(fixture.controller.reconcile()).rejects.toBeInstanceOf(RetryableError);
    expect(fixture.compute.deleted).toEqual(["server-101", "orphan"]);
  });

  it("prunes terminal records after the bounded retention window", async () => {
    const fixture = createFixture();
    await fixture.controller.handleWorkflowJob(event);
    await fixture.controller.handleWorkflowJob({ ...event, action: "completed" });
    fixture.clock.value = 87_401;
    await fixture.controller.reconcile();
    expect(await fixture.jobs.get("job-101")).toBeNull();
  });
});

describe("provider-agnostic workflow_job trust policy", () => {
  const policy = {
    allowedRepositories: ["owner/repository"],
    trustedBranches: ["main"],
    triggerLabel: "jit-runner",
    runLabelPrefix: "jit-run-",
    allowPullRequests: false,
  } as const;
  const payload = {
    action: "queued",
    installation: { id: 7 },
    repository: { id: 3, full_name: "owner/repository" },
    workflow_job: {
      id: 101,
      run_id: 51,
      head_branch: "main",
      labels: ["self-hosted", "jit-runner", "jit-run-51"],
      pull_requests: [],
    },
  };

  it("accepts only allowlisted trusted-branch jobs carrying the trigger label", () => {
    expect(trustWorkflowJobPayload(payload, event.deliveryId, policy)).toMatchObject({
      jobId: 101,
      headBranch: "main",
    });
    expect(() => trustWorkflowJobPayload({ ...payload, repository: { id: 4, full_name: "other/repo" } }, event.deliveryId, policy)).toThrow("not allowlisted");
    expect(() => trustWorkflowJobPayload({ ...payload, workflow_job: { ...payload.workflow_job, head_branch: "feature" } }, event.deliveryId, policy)).toThrow("branch is not trusted");
    expect(() => trustWorkflowJobPayload({ ...payload, workflow_job: { ...payload.workflow_job, labels: ["self-hosted"] } }, event.deliveryId, policy)).toThrow("trigger label is missing");
  });

  it("rejects pull-request workloads and applies the same trust policy to completed events", () => {
    expect(() => trustWorkflowJobPayload({ ...payload, workflow_job: { ...payload.workflow_job, pull_requests: [{}] } }, event.deliveryId, policy)).toThrow("pull request jobs are not trusted");
    expect(() => trustWorkflowJobPayload({ ...payload, action: "completed", workflow_job: { ...payload.workflow_job, head_branch: "feature", labels: [] } }, event.deliveryId, policy)).toThrow("branch is not trusted");
  });

  it("requires a label scoped to the workflow run so PR jobs cannot steal a trusted runner", () => {
    expect(() => trustWorkflowJobPayload({
      ...payload,
      workflow_job: { ...payload.workflow_job, labels: ["self-hosted", "jit-runner"] },
    }, event.deliveryId, policy)).toThrow("run-scoped label is missing");
  });
});

function createFixture(maxRunners = 2) {
  const jobs = new MemoryJobStore();
  const leases = new MemoryLeaseStore();
  const compute = new MemoryComputeProvider();
  const runners = new MemoryRunnerControl();
  const clock = new MutableClock(1_000);
  const telemetry: Telemetry = { emit: () => undefined };
  const controller = new Controller(
    {
      maxRunners,
      ttlSeconds: 300,
      serverType: "cx33",
      location: "fsn1",
      image: "ubuntu-24.04",
      architecture: "x64",
      publicBaseUrl: "https://controller.example.test",
    },
    {
      jobs,
      leases,
      compute,
      runners,
      bootstrapTokens: new StaticBootstrapBroker(),
      clock,
      telemetry,
    },
  );
  return { controller, jobs, leases, compute, runners, clock };
}

class MemoryJobStore implements JobStore {
  private readonly records = new Map<string, JobRecord>();
  async get(key: string) { return this.records.get(key) ?? null; }
  async compareAndSet(key: string, expectedVersion: number | null, value: JobRecord) {
    if ((this.records.get(key)?.version ?? null) !== expectedVersion) return false;
    this.records.set(key, structuredClone(value));
    return true;
  }
  async listActive() {
    return [...this.records.values()].filter((record) => !["completed", "failed"].includes(record.state));
  }
  async pruneTerminal(before: number) {
    let pruned = 0;
    for (const [key, record] of this.records) {
      if (["completed", "failed"].includes(record.state) && record.updatedAt < before) {
        this.records.delete(key);
        pruned += 1;
      }
    }
    return pruned;
  }
}

class MemoryLeaseStore implements LeaseStore {
  readonly active = new Map<string, number>();
  async acquire(_scope: string, holder: string, limit: number, expiresAt: number) {
    if (!this.active.has(holder) && this.active.size >= limit) return false;
    this.active.set(holder, expiresAt);
    return true;
  }
  async release(_scope: string, holder: string) { this.active.delete(holder); }
}

class MemoryComputeProvider implements ComputeProvider {
  readonly created: ComputeCreateRequest[] = [];
  readonly deleted: string[] = [];
  readonly expired: ComputeResource[] = [];
  private createStarted: (() => void) | undefined;
  private createStartedPromise: Promise<void> | undefined;
  private resume: (() => void) | undefined;
  private createGate: Promise<void> | undefined;
  pauseNextCreate() {
    this.createStartedPromise = new Promise((resolve) => { this.createStarted = resolve; });
    this.createGate = new Promise((resolve) => { this.resume = resolve; });
  }
  async waitUntilCreateStarted() { await this.createStartedPromise; }
  resumeCreate() { this.resume?.(); }
  async create(request: ComputeCreateRequest) {
    this.created.push(request);
    this.createStarted?.();
    if (this.createGate) await this.createGate;
    return {
      provider: "hetzner",
      serverId: `server-${request.jobKey.replace("job-", "")}`,
      firewallId: "firewall-1",
      primaryIpv4Id: "ip-1",
      publicIpv4: "192.0.2.10",
      expiresAt: request.expiresAt,
      jobKey: request.jobKey,
    };
  }
  async delete(resource: ComputeResource) { this.deleted.push(resource.serverId); }
  async listExpired() { return this.expired.splice(0); }
}

class MemoryRunnerControl implements RunnerControl {
  readonly deleted: number[] = [];
  created = 0;
  failDelete = false;
  async assertRepositoryAccess() {}
  async createJitConfiguration(): Promise<JitConfiguration> {
    this.created += 1;
    return { encodedJitConfig: "encoded-jit-config", runnerId: 9001 };
  }
  async deleteRunner(_event: TrustedWorkflowJobEvent, runnerId: number) {
    if (this.failDelete) throw new Error("runner delete failed");
    this.deleted.push(runnerId);
  }
}

class StaticBootstrapBroker implements BootstrapTokenBroker {
  async mint() { return { token: "bootstrap-token", hash: "bootstrap-hash" }; }
  async matches(token: string, expectedHash: string) {
    return token === "bootstrap-token" && expectedHash === "bootstrap-hash";
  }
}

class MutableClock implements Clock {
  constructor(public value: number) {}
  now() { return this.value; }
}
