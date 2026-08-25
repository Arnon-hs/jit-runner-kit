import type {
  BootstrapTokenBroker,
  Clock,
  ComputeProvider,
  ControllerConfig,
  JobRecord,
  JobStore,
  LeaseStore,
  RunnerControl,
  Telemetry,
  TrustedWorkflowJobEvent,
  WorkflowJobTrustPolicy,
} from "../../contracts/src/index";
import { RetryableError, TerminalError } from "../../contracts/src/index";

export interface ControllerPorts {
  jobs: JobStore;
  leases: LeaseStore;
  compute: ComputeProvider;
  runners: RunnerControl;
  bootstrapTokens: BootstrapTokenBroker;
  clock: Clock;
  telemetry: Telemetry;
}

export interface BootstrapResult {
  encodedJitConfig: string;
}

export interface PoolClaimResult extends BootstrapResult {
  jobKey: string;
  expiresAt: number;
}

export interface PoolEnrollmentResult {
  hostId: string;
}

export class Controller {
  constructor(
    private readonly config: ControllerConfig,
    private readonly ports: ControllerPorts,
  ) {}

  async handleWorkflowJob(event: TrustedWorkflowJobEvent): Promise<void> {
    if (event.action === "completed") {
      await this.handleCompleted(event);
      return;
    }
    await this.handleQueued(event);
  }

  async exchangeBootstrap(jobKey: string, token: string, sourceIp: string): Promise<BootstrapResult> {
    const record = await this.requireJob(jobKey);
    if (record.state !== "awaiting-bootstrap" || !record.bootstrapTokenHash || !record.compute) {
      throw new TerminalError("bootstrap is not available for this job");
    }
    if (record.expiresAt <= this.ports.clock.now()) {
      try {
        await this.cleanup(record, "bootstrap-ttl-expired");
      } catch (cleanupError) {
        this.emitCleanupFailure(jobKey, "bootstrap-expired", cleanupError);
      }
      throw new TerminalError("bootstrap has expired");
    }
    if (sourceIp !== record.compute.publicIpv4) {
      throw new TerminalError("bootstrap source address does not match the provisioned VM");
    }
    if (!(await this.ports.bootstrapTokens.matches(token, record.bootstrapTokenHash))) {
      throw new TerminalError("bootstrap token is invalid or already consumed");
    }

    const result = await this.startRunner(record);
    if (!result) throw new TerminalError("bootstrap token is invalid or already consumed");
    return result;
  }

  async identifyPoolHost(sourceIp: string): Promise<PoolEnrollmentResult> {
    const waiting = (await this.ports.jobs.listActive())
      .filter((record) =>
        record.state === "awaiting-bootstrap"
        && record.compute?.provider === "hetzner-pool-job"
        && record.compute.publicIpv4 === sourceIp,
      )
      .sort((left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key));
    const record = waiting[0];
    if (!record) throw new TerminalError("pool enrollment source does not match an active host");
    return { hostId: record.compute!.serverId };
  }

  async claimPoolRunner(
    sourceIp: string,
    expectedHostId?: string,
  ): Promise<PoolClaimResult | null> {
    const waiting = (await this.ports.jobs.listActive())
      .filter((record) =>
        record.state === "awaiting-bootstrap"
        && ["shared-host", "hetzner-pool-job"].includes(record.compute?.provider ?? "")
        && (!expectedHostId || record.compute?.serverId === expectedHostId)
        && record.compute?.publicIpv4 === sourceIp,
      )
      .sort((left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key));

    for (const record of waiting) {
      if (record.expiresAt <= this.ports.clock.now()) {
        try {
          await this.cleanup(record, "pool-claim-ttl-expired");
        } catch (cleanupError) {
          this.emitCleanupFailure(record.key, "pool-claim-expired", cleanupError);
        }
        continue;
      }
      const result = await this.startRunner(record);
      if (result) {
        this.ports.telemetry.emit("pool.claimed", {
          jobKey: record.key,
          hostId: record.compute!.serverId,
        });
        return { ...result, jobKey: record.key, expiresAt: record.expiresAt };
      }
    }
    return null;
  }

  async releaseIdlePoolHost(sourceIp: string): Promise<boolean> {
    if (!this.ports.compute.releaseIdleHost) {
      throw new TerminalError("compute provider does not manage elastic shared hosts");
    }
    const active = (await this.ports.jobs.listActive()).some((record) =>
      record.compute?.provider === "hetzner-pool-job"
      && record.compute.publicIpv4 === sourceIp,
    );
    if (active) return false;
    return await this.ports.compute.releaseIdleHost(sourceIp);
  }

  private async startRunner(record: JobRecord): Promise<BootstrapResult | null> {
    if (record.state !== "awaiting-bootstrap" || !record.compute) return null;

    const bootstrapping: JobRecord = {
      ...record,
      version: record.version + 1,
      state: "bootstrapping",
      updatedAt: this.ports.clock.now(),
    };
    delete bootstrapping.bootstrapTokenHash;
    if (!(await this.ports.jobs.compareAndSet(record.key, record.version, bootstrapping))) {
      return null;
    }

    let mintedRunnerId: number | undefined;
    try {
      const jit = await this.ports.runners.createJitConfiguration(
        record.event,
        `jit-${record.event.jobId}`,
      );
      mintedRunnerId = jit.runnerId;
      const running: JobRecord = {
        ...bootstrapping,
        version: bootstrapping.version + 1,
        state: "running",
        runnerId: jit.runnerId,
        updatedAt: this.ports.clock.now(),
      };
      if (!(await this.ports.jobs.compareAndSet(record.key, bootstrapping.version, running))) {
        throw new RetryableError("job changed while consuming the bootstrap token", 5);
      }
      this.ports.telemetry.emit("bootstrap.consumed", { jobKey: record.key, runnerId: jit.runnerId });
      return { encodedJitConfig: jit.encodedJitConfig };
    } catch (error) {
      if (mintedRunnerId) {
        try {
          await this.ports.runners.deleteRunner(record.event, mintedRunnerId);
        } catch (cleanupError) {
          this.emitCleanupFailure(record.key, "bootstrap-runner", cleanupError);
        }
      }
      try {
        await this.cleanup(bootstrapping, "bootstrap-failed");
      } catch (cleanupError) {
        this.emitCleanupFailure(record.key, "bootstrap-job", cleanupError);
      }
      throw error;
    }
  }

  async reconcile(): Promise<void> {
    const now = this.ports.clock.now();
    const errors: unknown[] = [];
    const active = await this.ports.jobs.listActive();
    for (const job of active) {
      if (job.expiresAt <= now) {
        try {
          await this.cleanup(job, "job-ttl-expired");
        } catch (error) {
          if (error instanceof CapacityLeaseError) throw error;
          errors.push(error);
          this.emitCleanupFailure(job.key, "job-ttl", error);
        }
        continue;
      }
      if (job.state === "provisioning" && job.updatedAt + this.config.provisioningTimeoutSeconds <= now) {
        try {
          await this.retryStaleProvisioning(job);
        } catch (error) {
          errors.push(error);
          this.emitCleanupFailure(job.key, "provisioning-recovery", error);
        }
      }
    }
    try {
      const orphans = await this.ports.compute.listExpired(now);
      for (const resource of orphans) {
        try {
          await this.ports.compute.delete(resource);
          this.ports.telemetry.emit("compute.orphan_deleted", {
            jobKey: resource.jobKey,
            serverId: resource.serverId,
          });
        } catch (error) {
          errors.push(error);
          this.emitCleanupFailure(resource.jobKey, "provider-orphan", error);
        }
      }
    } catch (error) {
      errors.push(error);
      this.emitCleanupFailure("global", "provider-inventory", error);
    }
    await this.ports.jobs.pruneTerminal(now - Math.max(this.config.ttlSeconds * 2, 86_400));
    if (errors.length > 0) {
      throw new RetryableError(`reconciliation completed with ${errors.length} cleanup error(s)`, 30);
    }
  }

  private async retryStaleProvisioning(record: JobRecord): Promise<void> {
    const failed: JobRecord = {
      ...record,
      version: record.version + 1,
      state: "failed",
      failure: "stale provisioning attempt recovered",
      updatedAt: this.ports.clock.now(),
    };
    if (!(await this.ports.jobs.compareAndSet(record.key, record.version, failed))) return;
    try {
      await this.handleQueued(record.event);
    } catch (error) {
      if (error instanceof RetryableError) {
        const current = await this.ports.jobs.get(record.key);
        if (current?.state === "failed") {
          await this.ports.jobs.compareAndSet(current.key, current.version, {
            ...current,
            version: current.version + 1,
            state: "provisioning",
            updatedAt: this.ports.clock.now(),
          });
        }
      }
      throw error;
    }
  }

  private async handleQueued(event: TrustedWorkflowJobEvent): Promise<void> {
    const key = jobKey(event);
    let record = await this.ports.jobs.get(key);
    if (record && record.state !== "failed") return;

    const now = this.ports.clock.now();
    const expiresAt = now + this.config.ttlSeconds;
    let leaseAcquired = false;
    if (!record || record.state === "failed") {
      const next: JobRecord = {
        key,
        version: record ? record.version + 1 : 0,
        state: "provisioning",
        event,
        createdAt: record?.createdAt ?? now,
        updatedAt: now,
        expiresAt,
      };
      if (!(await this.ports.jobs.compareAndSet(key, record?.version ?? null, next))) {
        return;
      }
      record = next;
    }

    try {
      leaseAcquired = await this.ports.leases.acquire("global", key, this.config.maxRunners, expiresAt);
      if (!leaseAcquired) {
        throw new RetryableError("controller concurrency limit reached", 30);
      }
      await this.ports.runners.assertRepositoryAccess(event);
      const minted = await this.ports.bootstrapTokens.mint();
      const resource = await this.ports.compute.create({
        jobKey: key,
        repository: event.repository.fullName,
        serverName: `jit-${event.jobId}`,
        serverType: this.config.serverType,
        location: this.config.location,
        image: this.config.image,
        architecture: this.config.architecture,
        expiresAt: record.expiresAt,
        provisioningAttempt: record.version,
        bootstrapToken: minted.token,
        bootstrapTokenHash: minted.hash,
        bootstrapUrl: `${this.config.publicBaseUrl}/v1/bootstrap/${encodeURIComponent(key)}`,
      });
      const waiting: JobRecord = {
        ...record,
        version: record.version + 1,
        state: "awaiting-bootstrap",
        bootstrapTokenHash: minted.hash,
        compute: resource,
        updatedAt: this.ports.clock.now(),
      };
      if (!(await this.ports.jobs.compareAndSet(key, record.version, waiting))) {
        await this.ports.compute.delete(resource);
        throw new RetryableError("job changed while provisioning compute", 5);
      }
      this.ports.telemetry.emit("compute.created", { jobKey: key, serverId: resource.serverId });
    } catch (error) {
      await this.failProvision(record, error, leaseAcquired);
      throw error;
    }
  }

  private async handleCompleted(event: TrustedWorkflowJobEvent): Promise<void> {
    const key = jobKey(event);
    const record = await this.ports.jobs.get(key);
    if (!record) {
      const now = this.ports.clock.now();
      await this.ports.jobs.compareAndSet(key, null, {
        key,
        version: 0,
        state: "completed",
        event,
        createdAt: now,
        updatedAt: now,
        expiresAt: now,
      });
      return;
    }
    if (record.state === "completed") return;
    await this.cleanup(record, "workflow-job-completed");
  }

  private async failProvision(record: JobRecord, error: unknown, releaseLease: boolean): Promise<void> {
    const current = await this.ports.jobs.get(record.key);
    if (!current || current.version !== record.version || current.state !== "provisioning") return;
    if (!(await this.ports.jobs.compareAndSet(current.key, current.version, {
      ...current,
      version: current.version + 1,
      state: "failed",
      failure: errorMessage(error),
      updatedAt: this.ports.clock.now(),
    }))) return;
    if (releaseLease) await this.ports.leases.release("global", record.key);
  }

  private async cleanup(record: JobRecord, reason: string): Promise<void> {
    const latest = (await this.ports.jobs.get(record.key)) ?? record;
    if (latest.state === "completed") return;
    const cleaning: JobRecord = {
      ...latest,
      version: latest.version + 1,
      state: "cleaning",
      updatedAt: this.ports.clock.now(),
    };
    if (latest.state !== "cleaning") {
      if (!(await this.ports.jobs.compareAndSet(latest.key, latest.version, cleaning))) {
        throw new RetryableError("job changed while starting cleanup", 5);
      }
    }
    const cleanupRecord = latest.state === "cleaning" ? latest : cleaning;
    const errors: unknown[] = [];
    let computeDeleted = true;
    try {
      await this.ports.leases.retain(
        "global",
        cleanupRecord.key,
        this.ports.clock.now() + this.config.ttlSeconds,
      );
    } catch (error) {
      this.emitCleanupFailure(cleanupRecord.key, "lease-retain", error);
      throw new CapacityLeaseError("cleanup could not retain its capacity lease", 30);
    }
    if (cleanupRecord.runnerId) {
      try {
        await this.ports.runners.deleteRunner(cleanupRecord.event, cleanupRecord.runnerId);
      } catch (error) {
        errors.push(error);
        this.emitCleanupFailure(cleanupRecord.key, "runner", error);
      }
    }
    if (cleanupRecord.compute) {
      try {
        await this.ports.compute.delete(cleanupRecord.compute);
      } catch (error) {
        computeDeleted = false;
        errors.push(error);
        this.emitCleanupFailure(cleanupRecord.key, "compute", error);
      }
    }
    if (computeDeleted) {
      try {
        await this.ports.leases.release("global", cleanupRecord.key);
      } catch (error) {
        errors.push(error);
        this.emitCleanupFailure(cleanupRecord.key, "lease", error);
      }
    }
    if (errors.length > 0) {
      throw new RetryableError(`cleanup completed with ${errors.length} error(s)`, 30);
    }
    if (!(await this.ports.jobs.compareAndSet(cleanupRecord.key, cleanupRecord.version, {
      ...cleanupRecord,
      version: cleanupRecord.version + 1,
      state: "completed",
      updatedAt: this.ports.clock.now(),
    }))) {
      throw new RetryableError("job changed while finishing cleanup", 5);
    }
    this.ports.telemetry.emit("job.cleaned", { jobKey: cleanupRecord.key, reason });
  }

  private emitCleanupFailure(jobKey: string, phase: string, error: unknown): void {
    this.ports.telemetry.emit("cleanup.failed", {
      jobKey,
      phase,
      errorType: error instanceof Error ? error.name : "unknown",
    });
  }

  private async requireJob(key: string): Promise<JobRecord> {
    const record = await this.ports.jobs.get(key);
    if (!record) throw new TerminalError("unknown job");
    return record;
  }
}

export function jobKey(event: TrustedWorkflowJobEvent): string {
  return `job-${event.jobId}`;
}

export function trustWorkflowJobPayload(
  raw: unknown,
  deliveryId: string,
  policy: WorkflowJobTrustPolicy,
): TrustedWorkflowJobEvent {
  const payload = raw as {
    action?: string;
    installation?: { id?: number };
    repository?: { id?: number; full_name?: string };
    workflow_job?: {
      id?: number;
      run_id?: number;
      head_branch?: string;
      labels?: string[];
      conclusion?: string | null;
      pull_requests?: unknown[];
    };
  };
  if (payload.action !== "queued" && payload.action !== "completed") {
    throw new TerminalError("unsupported workflow_job action");
  }
  const repository = payload.repository;
  const job = payload.workflow_job;
  const installationId = payload.installation?.id;
  if (!repository?.id || !repository.full_name || !job?.id || !job.run_id || !installationId) {
    throw new TerminalError("workflow_job payload is missing required identifiers");
  }
  const allowedRepositories = policy.allowedRepositories.map((value) => value.toLowerCase());
  if (!allowedRepositories.includes(repository.full_name.toLowerCase())) {
    throw new TerminalError("repository is not allowlisted");
  }
  const labels = job.labels ?? [];
  const headBranch = job.head_branch ?? "";
  if (!policy.allowPullRequests && (job.pull_requests?.length ?? 0) > 0) {
    throw new TerminalError("pull request jobs are not trusted");
  }
  if (!policy.trustedBranches.includes(headBranch)) throw new TerminalError("branch is not trusted");
  if (!labels.includes(policy.triggerLabel)) throw new TerminalError("trigger label is missing");
  if (!labels.includes(`${policy.runLabelPrefix}${job.run_id}`)) {
    throw new TerminalError("run-scoped label is missing");
  }
  return {
    deliveryId,
    action: payload.action,
    jobId: job.id,
    runId: job.run_id,
    installationId,
    repository: { id: repository.id, fullName: repository.full_name },
    headBranch,
    labels,
    ...(job.conclusion ? { conclusion: job.conclusion } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class CapacityLeaseError extends RetryableError {}
