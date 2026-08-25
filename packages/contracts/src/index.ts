export type WorkflowJobAction = "queued" | "completed";

export interface RepositoryRef {
  id: number;
  fullName: string;
}

export interface TrustedWorkflowJobEvent {
  deliveryId: string;
  action: WorkflowJobAction;
  jobId: number;
  runId: number;
  installationId: number;
  repository: RepositoryRef;
  headBranch: string;
  labels: string[];
  conclusion?: string;
}

export interface WorkflowJobTask {
  kind: "workflow-job";
  event: TrustedWorkflowJobEvent;
}

export interface ReconcileTask {
  kind: "reconcile";
  requestedAt: number;
}

export type ControllerTask = WorkflowJobTask | ReconcileTask;

export type JobState =
  | "provisioning"
  | "awaiting-bootstrap"
  | "bootstrapping"
  | "running"
  | "cleaning"
  | "completed"
  | "failed";

export interface ComputeResource {
  provider: string;
  serverId: string;
  firewallId?: string;
  primaryIpv4Id?: string;
  publicIpv4: string;
  expiresAt: number;
  jobKey: string;
}

export interface JobRecord {
  key: string;
  version: number;
  state: JobState;
  event: TrustedWorkflowJobEvent;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  bootstrapTokenHash?: string;
  compute?: ComputeResource;
  runnerId?: number;
  failure?: string;
}

export interface JitConfiguration {
  encodedJitConfig: string;
  runnerId: number;
}

export interface ComputeCreateRequest {
  jobKey: string;
  repository: string;
  serverName: string;
  serverType: string;
  location: string;
  image: string;
  architecture: "x64" | "arm64";
  expiresAt: number;
  bootstrapToken: string;
  bootstrapUrl: string;
}

export interface JobStore {
  get(key: string): Promise<JobRecord | null>;
  compareAndSet(key: string, expectedVersion: number | null, value: JobRecord): Promise<boolean>;
  listActive(): Promise<JobRecord[]>;
  pruneTerminal(before: number): Promise<number>;
}

export interface LeaseStore {
  acquire(scope: string, holder: string, limit: number, expiresAt: number): Promise<boolean>;
  release(scope: string, holder: string): Promise<void>;
}

export interface ComputeProvider {
  create(request: ComputeCreateRequest): Promise<ComputeResource>;
  delete(resource: ComputeResource): Promise<void>;
  listExpired(now: number): Promise<ComputeResource[]>;
}

export interface RunnerControl {
  assertRepositoryAccess(event: TrustedWorkflowJobEvent): Promise<void>;
  createJitConfiguration(event: TrustedWorkflowJobEvent, runnerName: string): Promise<JitConfiguration>;
  deleteRunner(event: TrustedWorkflowJobEvent, runnerId: number): Promise<void>;
}

export interface BootstrapTokenBroker {
  mint(): Promise<{ token: string; hash: string }>;
  matches(token: string, expectedHash: string): Promise<boolean>;
}

export interface Clock {
  now(): number;
}

export interface Telemetry {
  emit(name: string, attributes: Record<string, string | number | boolean>): void;
}

export interface ControllerConfig {
  maxRunners: number;
  ttlSeconds: number;
  serverType: string;
  location: string;
  image: string;
  architecture: "x64" | "arm64";
  publicBaseUrl: string;
}

export interface WorkflowJobTrustPolicy {
  allowedRepositories: readonly string[];
  trustedBranches: readonly string[];
  triggerLabel: string;
  runLabelPrefix: string;
  allowPullRequests: false;
}

export class RetryableError extends Error {
  constructor(message: string, readonly delaySeconds = 15) {
    super(message);
    this.name = "RetryableError";
  }
}

export class TerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalError";
  }
}
