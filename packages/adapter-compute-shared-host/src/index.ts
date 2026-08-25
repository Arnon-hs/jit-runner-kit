import type {
  ComputeCreateRequest,
  ComputeProvider,
  ComputeResource,
} from "../../contracts/src/index";

export interface SharedHostComputeConfig {
  hostId: string;
  publicIpv4: string;
}

export class SharedHostComputeProvider implements ComputeProvider {
  constructor(private readonly config: SharedHostComputeConfig) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(config.hostId)) {
      throw new Error("shared host ID is invalid");
    }
    if (!isIpv4(config.publicIpv4)) throw new Error("shared host public IPv4 is invalid");
  }

  async create(request: ComputeCreateRequest): Promise<ComputeResource> {
    return {
      provider: "shared-host",
      serverId: this.config.hostId,
      publicIpv4: this.config.publicIpv4,
      expiresAt: request.expiresAt,
      jobKey: request.jobKey,
    };
  }

  async delete(_resource: ComputeResource): Promise<void> {
    // Job cleanup must never delete the long-lived shared host. The host agent
    // removes the per-job containers and the controller removes the JIT record.
  }

  async listExpired(_now: number): Promise<ComputeResource[]> {
    // Shared hosts are lifecycle-managed separately and are not job orphans.
    return [];
  }
}

function isIpv4(value: string): boolean {
  const octets = value.split(".");
  return octets.length === 4 && octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    if (octet.length > 1 && octet.startsWith("0")) return false;
    const parsed = Number(octet);
    return parsed >= 0 && parsed <= 255;
  });
}
