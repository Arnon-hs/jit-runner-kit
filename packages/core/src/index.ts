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

    const bootstrapping: JobRecord = {
      ...record,
      version: record.version + 1,
      state: "bootstrapping",
      updatedAt: this.ports.clock.now(),
    };
    delete bootstrapping.bootstrapTokenHash;
    if (!(await this.ports.jobs.compareAndSet(jobKey, record.version, bootstrapping))) {
      throw new TerminalError("bootstrap token is invalid or already consumed");
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
      if (!(await this.ports.jobs.compareAndSet(jobKey, bootstrapping.version, running))) {
        throw new RetryableError("job changed while consuming the bootstrap token", 5);
      }
      this.ports.telemetry.emit("bootstrap.consumed", { jobKey, runnerId: jit.runnerId });
      return { encodedJitConfig: jit.encodedJitConfig };
    } catch (error) {
      if (mintedRunnerId) {
        try {
          await this.ports.runners.deleteRunner(record.event, mintedRunnerId);
        } catch (cleanupError) {
          this.emitCleanupFailure(jobKey, "bootstrap-runner", cleanupError);
        }
      }
      try {
        await this.cleanup(bootstrapping, "bootstrap-failed");
      } catch (cleanupError) {
        this.emitCleanupFailure(jobKey, "bootstrap-job", cleanupError);
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
          errors.push(error);
          this.emitCleanupFailure(job.key, "job-ttl", error);
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

  private async handleQueued(event: TrustedWorkflowJobEvent): Promise<void> {
    const key = jobKey(event);
    let record = await this.ports.jobs.get(key);
    if (record && record.state !== "failed") return;

    const now = this.ports.clock.now();
    const expiresAt = now + this.config.ttlSeconds;
    if (!record || record.state === "failed") {
      const leased = await this.ports.leases.acquire("global", key, this.config.maxRunners, expiresAt);
      if (!leased) {
        throw new RetryableError("controller concurrency limit reached", 30);
      }
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
        await this.ports.leases.release("global", key);
        return;
      }
      record = next;
    }

    try {
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
        bootstrapToken: minted.token,
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
      await this.failProvision(record, error);
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

  private async failProvision(record: JobRecord, error: unknown): Promise<void> {
    const current = await this.ports.jobs.get(record.key);
    if (!current || current.version !== record.version || current.state !== "provisioning") return;
    if (!(await this.ports.jobs.compareAndSet(current.key, current.version, {
      ...current,
      version: current.version + 1,
      state: "failed",
      failure: errorMessage(error),
      updatedAt: this.ports.clock.now(),
    }))) return;
    await this.ports.leases.release("global", record.key);
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
        errors.push(error);
        this.emitCleanupFailure(cleanupRecord.key, "compute", error);
      }
    }
    try {
      await this.ports.leases.release("global", cleanupRecord.key);
    } catch (error) {
      errors.push(error);
      this.emitCleanupFailure(cleanupRecord.key, "lease", error);
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
