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
import { SharedHostComputeProvider } from "../packages/adapter-compute-shared-host/src/index";

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

  it("claims at most one waiting job per shared-host request without deleting the host", async () => {
    const fixture = createFixture(2, new SharedHostComputeProvider({
      hostId: "pool-fsn1-1",
      publicIpv4: "192.0.2.10",
    }));
    await fixture.controller.handleWorkflowJob(event);
    await fixture.controller.handleWorkflowJob({ ...event, jobId: 102 });

    const first = await fixture.controller.claimPoolRunner("192.0.2.10", "pool-fsn1-1");
    const second = await fixture.controller.claimPoolRunner("192.0.2.10", "pool-fsn1-1");
    const empty = await fixture.controller.claimPoolRunner("192.0.2.10", "pool-fsn1-1");

    expect([first?.jobKey, second?.jobKey]).toEqual(["job-101", "job-102"]);
    expect(empty).toBeNull();
    expect(fixture.runners.created).toBe(2);
    await fixture.controller.handleWorkflowJob({ ...event, action: "completed" });
    expect(fixture.compute.deleted).toEqual([]);
  });

  it("does not expose shared-host work to a different host identity or source address", async () => {
    const fixture = createFixture(2, new SharedHostComputeProvider({
      hostId: "pool-fsn1-1",
      publicIpv4: "192.0.2.10",
    }));
    await fixture.controller.handleWorkflowJob(event);
    expect(await fixture.controller.claimPoolRunner("192.0.2.10", "pool-fsn1-2")).toBeNull();
    expect(await fixture.controller.claimPoolRunner("198.51.100.8", "pool-fsn1-1")).toBeNull();
    expect(fixture.runners.created).toBe(0);
  });

  it("enrolls an elastic pool host once and claims work only from its provider address", async () => {
    const provider = new MemoryElasticPoolProvider();
    const fixture = createFixture(2, provider);
    await fixture.controller.handleWorkflowJob(event);

    await expect(fixture.controller.identifyPoolHost("198.51.100.8")).rejects.toBeInstanceOf(TerminalError);
    await expect(fixture.controller.identifyPoolHost("192.0.2.10")).resolves.toEqual({
      hostId: "pool-server-1",
    });
    expect((await fixture.jobs.get("job-101"))?.bootstrapTokenHash).toBe("bootstrap-hash");

    const claim = await fixture.controller.claimPoolRunner("192.0.2.10");
    expect(claim?.jobKey).toBe("job-101");
  });

  it("releases an elastic pool host only after all referenced jobs are terminal", async () => {
    const provider = new MemoryElasticPoolProvider();
    const fixture = createFixture(2, provider);
    await fixture.controller.handleWorkflowJob(event);
    expect(await fixture.controller.releaseIdlePoolHost("192.0.2.10")).toBe(false);
    await fixture.controller.handleWorkflowJob({ ...event, action: "completed" });
    expect(await fixture.controller.releaseIdlePoolHost("192.0.2.10")).toBe(true);
    expect(provider.released).toBe(1);
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

  it("does not let a losing initial claim release the winning task lease", async () => {
    const fixture = createFixture();
    fixture.jobs.pauseInitialClaims(2);
    fixture.compute.pauseNextCreate();
    const attempts = [
      fixture.controller.handleWorkflowJob(event),
      fixture.controller.handleWorkflowJob({ ...event, deliveryId: "00000000-0000-4000-8000-000000000004" }),
    ];
    await fixture.compute.waitUntilCreateStarted();
    await Promise.resolve();
    expect(fixture.leases.active.size).toBe(1);
    fixture.compute.resumeCreate();
    await Promise.all(attempts);
    expect(fixture.compute.created).toHaveLength(1);
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

  it("retains capacity while compute deletion is still failing", async () => {
    const fixture = createFixture();
    await fixture.controller.handleWorkflowJob(event);
    fixture.compute.failDelete = true;
    fixture.clock.value = 2_000;
    await expect(fixture.controller.reconcile()).rejects.toBeInstanceOf(RetryableError);
    expect(fixture.leases.active.size).toBe(1);
    fixture.compute.failDelete = false;
    await fixture.controller.reconcile();
    expect(fixture.leases.active.size).toBe(0);
    expect((await fixture.jobs.get("job-101"))?.state).toBe("completed");
  });

  it("extends capacity before awaiting an expired VM deletion", async () => {
    const fixture = createFixture(1);
    await fixture.controller.handleWorkflowJob(event);
    fixture.compute.pauseNextDelete();
    fixture.clock.value = 2_000;
    const cleanup = fixture.controller.reconcile();
    await fixture.compute.waitUntilDeleteStarted();
    await expect(
      fixture.controller.handleWorkflowJob({ ...event, jobId: 102 }),
    ).rejects.toBeInstanceOf(RetryableError);
    fixture.compute.resumeDelete();
    await cleanup;
    expect(fixture.leases.active.size).toBe(0);
  });

  it("aborts cleanup before external I/O when capacity cannot be retained", async () => {
    const fixture = createFixture();
    await fixture.controller.handleWorkflowJob(event);
    fixture.leases.failRetain = true;
    fixture.clock.value = 2_000;
    await expect(fixture.controller.reconcile()).rejects.toBeInstanceOf(RetryableError);
    expect(fixture.compute.deleted).toHaveLength(0);
  });

  it("retries a provisioning record left stale by a controller crash", async () => {
    const fixture = createFixture();
    await fixture.jobs.compareAndSet("job-101", null, {
      key: "job-101",
      version: 0,
      state: "provisioning",
      event,
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 1_300,
    });
    fixture.clock.value = 1_061;
    await fixture.controller.reconcile();
    expect((await fixture.jobs.get("job-101"))?.state).toBe("awaiting-bootstrap");
    expect(fixture.compute.created).toHaveLength(1);
    expect(fixture.leases.active.size).toBe(1);
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

function createFixture(maxRunners = 2, provider?: ComputeProvider) {
  const jobs = new MemoryJobStore();
  const clock = new MutableClock(1_000);
  const leases = new MemoryLeaseStore(clock);
  const memoryCompute = new MemoryComputeProvider();
  const computePort = provider
    ? new RecordingComputeProvider(provider, memoryCompute)
    : memoryCompute;
  const compute = memoryCompute;
  const runners = new MemoryRunnerControl();
  const telemetry: Telemetry = { emit: () => undefined };
  const controller = new Controller(
    {
      maxRunners,
      ttlSeconds: 300,
      provisioningTimeoutSeconds: 60,
      serverType: "cx33",
      location: "fsn1",
      image: "ubuntu-24.04",
      architecture: "x64",
      publicBaseUrl: "https://controller.example.test",
    },
    {
      jobs,
      leases,
      compute: computePort,
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
  private initialClaimTarget = 0;
  private initialClaimArrivals = 0;
  private initialClaimGate: Promise<void> | undefined;
  private releaseInitialClaims: (() => void) | undefined;
  pauseInitialClaims(target: number) {
    this.initialClaimTarget = target;
    this.initialClaimGate = new Promise((resolve) => { this.releaseInitialClaims = resolve; });
  }
  async get(key: string) { return this.records.get(key) ?? null; }
  async compareAndSet(key: string, expectedVersion: number | null, value: JobRecord) {
    if (expectedVersion === null && this.initialClaimGate) {
      this.initialClaimArrivals += 1;
      if (this.initialClaimArrivals >= this.initialClaimTarget) this.releaseInitialClaims?.();
      await this.initialClaimGate;
    }
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
  failRetain = false;
  constructor(private readonly clock: Clock) {}
  async acquire(_scope: string, holder: string, limit: number, expiresAt: number) {
    for (const [key, expiry] of this.active) {
      if (expiry <= this.clock.now()) this.active.delete(key);
    }
    if (!this.active.has(holder) && this.active.size >= limit) return false;
    this.active.set(holder, expiresAt);
    return true;
  }
  async retain(_scope: string, holder: string, expiresAt: number) {
    if (this.failRetain) throw new Error("lease retain failed");
    this.active.set(holder, expiresAt);
  }
  async release(_scope: string, holder: string) { this.active.delete(holder); }
}

class MemoryComputeProvider implements ComputeProvider {
  readonly created: ComputeCreateRequest[] = [];
  readonly deleted: string[] = [];
  readonly expired: ComputeResource[] = [];
  failDelete = false;
  private createStarted: (() => void) | undefined;
  private createStartedPromise: Promise<void> | undefined;
  private resume: (() => void) | undefined;
  private createGate: Promise<void> | undefined;
  private deleteStarted: (() => void) | undefined;
  private deleteStartedPromise: Promise<void> | undefined;
  private resumeDeleteCallback: (() => void) | undefined;
  private deleteGate: Promise<void> | undefined;
  pauseNextCreate() {
    this.createStartedPromise = new Promise((resolve) => { this.createStarted = resolve; });
    this.createGate = new Promise((resolve) => { this.resume = resolve; });
  }
  async waitUntilCreateStarted() { await this.createStartedPromise; }
  resumeCreate() { this.resume?.(); }
  pauseNextDelete() {
    this.deleteStartedPromise = new Promise((resolve) => { this.deleteStarted = resolve; });
    this.deleteGate = new Promise((resolve) => { this.resumeDeleteCallback = resolve; });
  }
  async waitUntilDeleteStarted() { await this.deleteStartedPromise; }
  resumeDelete() { this.resumeDeleteCallback?.(); }
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
  async delete(resource: ComputeResource) {
    this.deleteStarted?.();
    if (this.deleteGate) await this.deleteGate;
    if (this.failDelete) throw new Error("compute delete failed");
    this.deleted.push(resource.serverId);
  }
  async listExpired() { return this.expired.splice(0); }
}

class RecordingComputeProvider implements ComputeProvider {
  constructor(
    private readonly delegate: ComputeProvider,
    private readonly recording: MemoryComputeProvider,
  ) {}
  get created() { return this.recording.created; }
  get deleted() { return this.recording.deleted; }
  get expired() { return this.recording.expired; }
  async create(request: ComputeCreateRequest) {
    this.recording.created.push(request);
    return this.delegate.create(request);
  }
  async delete(resource: ComputeResource) {
    await this.delegate.delete(resource);
  }
  async listExpired(now: number) {
    return this.delegate.listExpired(now);
  }
  async releaseIdleHost(sourceIp: string) {
    return this.delegate.releaseIdleHost ? this.delegate.releaseIdleHost(sourceIp) : false;
  }
}

class MemoryElasticPoolProvider implements ComputeProvider {
  released = 0;
  async create(request: ComputeCreateRequest): Promise<ComputeResource> {
    return {
      provider: "hetzner-pool-job",
      serverId: "pool-server-1",
      firewallId: "pool-firewall-1",
      primaryIpv4Id: "pool-ip-1",
      publicIpv4: "192.0.2.10",
      expiresAt: request.expiresAt,
      jobKey: request.jobKey,
    };
  }
  async delete() {}
  async listExpired() { return []; }
  async releaseIdleHost(sourceIp: string) {
    if (sourceIp !== "192.0.2.10") return false;
    this.released += 1;
    return true;
  }
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
