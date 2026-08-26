#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfig = resolve(root, "packages/adapter-controller-cloudflare/wrangler.jsonc");
const defaultManifest = resolve(root, "examples/github-app-repository-manifest.json");

export function validateCloudflareConfig(config, { template = false } = {}) {
  const issues = [];
  const vars = config?.vars ?? {};
  const requiredVars = [
    "ALLOWED_REPOSITORIES",
    "TRUSTED_BRANCHES",
    "TRIGGER_LABEL",
    "RUN_LABEL_PREFIX",
    "RUNNER_SCOPE",
    "RUNNER_GROUP_ID",
    "TRUSTED_WORKFLOWS",
    "TRUSTED_EVENTS",
    "MAX_RUNNERS",
    "COMPUTE_MODE",
    "TTL_SECONDS",
    "PROVISIONING_TIMEOUT_SECONDS",
    "SERVER_TYPE",
    "SERVER_LOCATION",
    "SERVER_IMAGE",
    "RUNNER_ARCHITECTURE",
    "PUBLIC_BASE_URL",
  ];
  for (const name of requiredVars) {
    if (!String(vars[name] ?? "").trim()) issues.push(`vars.${name} is required`);
  }

  if (config?.migrations) issues.push("use declarative exports instead of legacy Durable Object migrations");
  const durableExport = config?.exports?.ControllerDurableObject;
  if (durableExport?.type !== "durable-object" || durableExport?.storage !== "sqlite") {
    issues.push("exports.ControllerDurableObject must be a SQLite durable-object");
  }
  const binding = config?.durable_objects?.bindings?.find((item) => item.name === "CONTROLLER");
  if (binding?.class_name !== "ControllerDurableObject") {
    issues.push("CONTROLLER must bind ControllerDurableObject");
  }

  const producer = config?.queues?.producers?.find((item) => item.binding === "TASK_QUEUE");
  const consumer = config?.queues?.consumers?.find((item) => item.queue === producer?.queue);
  if (!producer?.queue || !consumer) issues.push("TASK_QUEUE must have a matching queue consumer");
  if (!consumer?.dead_letter_queue) issues.push("the task queue consumer must define a dead-letter queue");
  if (!Array.isArray(config?.triggers?.crons) || config.triggers.crons.length === 0) {
    issues.push("at least one independent cleanup Cron trigger is required");
  }

  const runnerScope = String(vars.RUNNER_SCOPE ?? "").trim();
  if (!["organization", "repository"].includes(runnerScope)) {
    issues.push("RUNNER_SCOPE must be organization or repository");
  }
  const organization = String(vars.GITHUB_ORGANIZATION ?? "").trim().toLowerCase();
  if (runnerScope === "organization" && !organization) issues.push("GITHUB_ORGANIZATION is required for organization scope");
  const repositories = csv(vars.ALLOWED_REPOSITORIES).map((value) => value.toLowerCase());
  if (repositories.length === 0) issues.push("ALLOWED_REPOSITORIES must not be empty");
  for (const repository of repositories) {
    if (repository.split("/").length !== 2) issues.push(`allowed repository must use owner/name: ${repository}`);
    if (runnerScope === "organization" && !repository.startsWith(`${organization}/`)) {
      issues.push(`allowed repository must belong to GITHUB_ORGANIZATION: ${repository}`);
    }
  }

  const workflows = csv(vars.TRUSTED_WORKFLOWS);
  if (workflows.length === 0) issues.push("TRUSTED_WORKFLOWS must not be empty");
  for (const workflow of workflows) {
    const match = workflow.match(/^([^/]+\/[^/]+)\/\.github\/workflows\/[^@/]+\.ya?ml@(?:refs\/heads\/[A-Za-z0-9._/-]+|[0-9a-f]{40})$/i);
    if (!match) {
      issues.push(`trusted workflow must use a full branch- or SHA-pinned path: ${workflow}`);
      continue;
    }
    if (!repositories.includes(match[1].toLowerCase())) {
      issues.push(`trusted workflow repository is not allowlisted: ${match[1]}`);
    }
  }
  const trustedEvents = csv(vars.TRUSTED_EVENTS);
  if (trustedEvents.length === 0) issues.push("TRUSTED_EVENTS must not be empty");
  if (trustedEvents.some((event) => event.includes("pull_request"))) {
    issues.push("TRUSTED_EVENTS must not include pull request events");
  }

  const maxRunners = integer(vars.MAX_RUNNERS);
  const ttl = integer(vars.TTL_SECONDS);
  const provisioningTimeout = integer(vars.PROVISIONING_TIMEOUT_SECONDS);
  const runnerGroupId = integer(vars.RUNNER_GROUP_ID);
  if (maxRunners < 1 || maxRunners > 2) issues.push("MAX_RUNNERS must be between 1 and 2");
  const computeMode = String(vars.COMPUTE_MODE ?? "");
  if (!["hetzner-ephemeral", "shared-host", "hetzner-pool"].includes(computeMode)) {
    issues.push("COMPUTE_MODE must be hetzner-ephemeral, shared-host, or hetzner-pool");
  }
  if (computeMode === "shared-host") {
    const hostId = String(vars.POOL_HOST_ID ?? "");
    const hostIpv4 = String(vars.POOL_HOST_IPV4 ?? "");
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(hostId)) issues.push("POOL_HOST_ID is invalid for shared-host mode");
    if (!isIpv4(hostIpv4)) issues.push("POOL_HOST_IPV4 is invalid for shared-host mode");
  }
  if (computeMode === "hetzner-pool") {
    const idleSeconds = integer(vars.POOL_IDLE_SECONDS);
    if (idleSeconds < 300 || idleSeconds > 3600) {
      issues.push("POOL_IDLE_SECONDS must be between 300 and 3600 in hetzner-pool mode");
    }
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(vars.POOL_ID ?? ""))) {
      issues.push("POOL_ID is invalid in hetzner-pool mode");
    }
    if (!/^https:\/\//.test(String(vars.POOL_AGENT_URL ?? ""))) {
      issues.push("POOL_AGENT_URL must use HTTPS in hetzner-pool mode");
    }
    if (!/^[a-f0-9]{64}$/i.test(String(vars.POOL_AGENT_SHA256 ?? ""))) {
      issues.push("POOL_AGENT_SHA256 must be a SHA-256 digest in hetzner-pool mode");
    }
    for (const name of ["POOL_RUNNER_IMAGE", "POOL_DIND_IMAGE"]) {
      if (!/@sha256:[a-f0-9]{64}$/i.test(String(vars[name] ?? ""))) {
        issues.push(`${name} must use an immutable digest in hetzner-pool mode`);
      }
    }
    if (!isEd25519PublicKey(String(vars.POOL_BOOTSTRAP_SSH_PUBLIC_KEY ?? ""))) {
      issues.push("POOL_BOOTSTRAP_SSH_PUBLIC_KEY must be a single OpenSSH Ed25519 public key in hetzner-pool mode");
    }
  }
  if (ttl < 600 || ttl > 86_400) issues.push("TTL_SECONDS must be between 600 and 86400");
  if (provisioningTimeout < 30 || provisioningTimeout >= ttl) {
    issues.push("PROVISIONING_TIMEOUT_SECONDS must be at least 30 and lower than TTL_SECONDS");
  }
  if (runnerGroupId < 1) issues.push("RUNNER_GROUP_ID must be a positive integer");
  if (!["x64", "arm64"].includes(vars.RUNNER_ARCHITECTURE)) {
    issues.push("RUNNER_ARCHITECTURE must be x64 or arm64");
  }

  try {
    const publicUrl = new URL(vars.PUBLIC_BASE_URL);
    if (publicUrl.protocol !== "https:") issues.push("PUBLIC_BASE_URL must use HTTPS");
  } catch {
    issues.push("PUBLIC_BASE_URL must be an absolute URL");
  }

  if (!template) {
    for (const [name, value] of Object.entries({
      ALLOWED_REPOSITORIES: vars.ALLOWED_REPOSITORIES,
      TRUSTED_WORKFLOWS: vars.TRUSTED_WORKFLOWS,
      PUBLIC_BASE_URL: vars.PUBLIC_BASE_URL,
    })) {
      if (/your-|owner\/|\.example(?:\.|\/|$)/i.test(String(value ?? ""))) {
        issues.push(`${name} still contains a template placeholder`);
      }
    }
  }
  return unique(issues);
}

export function validateGithubAppManifest(manifest, { template = false, runnerScope = "organization" } = {}) {
  const issues = [];
  if (manifest?.default_permissions?.actions !== "read") issues.push("GitHub App Actions permission must be read");
  if (manifest?.default_permissions?.metadata !== "read") issues.push("GitHub App Metadata permission must be read");
  if (runnerScope === "organization" && manifest?.default_permissions?.organization_self_hosted_runners !== "write") {
    issues.push("organization scope requires organization self-hosted runners write");
  }
  if (runnerScope === "repository" && manifest?.default_permissions?.administration !== "write") {
    issues.push("repository scope requires repository Administration write");
  }
  if (!manifest?.default_events?.includes("workflow_job")) issues.push("GitHub App must subscribe to workflow_job");
  if (manifest?.public !== false) issues.push("GitHub App template must default to a private app");
  const webhookUrl = String(manifest?.hook_attributes?.url ?? "");
  if (!/^https:\/\/.+\/webhooks\/github$/.test(webhookUrl)) issues.push("GitHub App webhook URL must use HTTPS and /webhooks/github");
  if (!template && /\.example(?:\.|\/|$)/i.test(webhookUrl)) issues.push("GitHub App webhook URL still contains a template placeholder");
  return unique(issues);
}

export async function readJsonc(path) {
  return JSON.parse(stripJsonComments(await readFile(path, "utf8")));
}

async function main() {
  const args = process.argv.slice(2);
  const template = args.includes("--template");
  const configArgument = args.indexOf("--config");
  const manifestArgument = args.indexOf("--manifest");
  const configPath = configArgument >= 0 ? resolve(args[configArgument + 1] ?? "") : defaultConfig;
  const manifestPath = manifestArgument >= 0 ? resolve(args[manifestArgument + 1] ?? "") : defaultManifest;
  const [config, manifest] = await Promise.all([readJsonc(configPath), readJsonc(manifestPath)]);
  const issues = [
    ...validateCloudflareConfig(config, { template }),
    ...validateGithubAppManifest(manifest, { template, runnerScope: config?.vars?.RUNNER_SCOPE }),
  ];
  if (issues.length > 0) {
    console.error("Cloudflare deployment preflight failed:");
    for (const issue of issues) console.error(`- ${issue}`);
    process.exitCode = 1;
    return;
  }
  console.log(template
    ? "Cloudflare deployment templates are internally consistent; no external resources were contacted."
    : "Cloudflare deployment configuration is ready for authenticated canary setup; no external resources were contacted.");
}

function stripJsonComments(value) {
  let result = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    const next = value[index + 1];
    if (lineComment) {
      if (current === "\n") { lineComment = false; result += current; }
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") { blockComment = false; index += 1; }
      continue;
    }
    if (!inString && current === "/" && next === "/") { lineComment = true; index += 1; continue; }
    if (!inString && current === "/" && next === "*") { blockComment = true; index += 1; continue; }
    result += current;
    if (inString && current === "\\" && !escaped) { escaped = true; continue; }
    if (current === '"' && !escaped) inString = !inString;
    escaped = false;
  }
  return result;
}

function csv(value) {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function integer(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : -1;
}

function isIpv4(value) {
  const octets = String(value).split(".");
  return octets.length === 4 && octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet) || (octet.length > 1 && octet.startsWith("0"))) return false;
    const parsed = Number(octet);
    return parsed >= 0 && parsed <= 255;
  });
}

function isEd25519PublicKey(value) {
  if (value.includes("\n") || value.includes("\r")) return false;
  const [algorithm, encoded, ...comment] = value.trim().split(" ");
  if (algorithm !== "ssh-ed25519" || !encoded || comment.some((part) => !/^[A-Za-z0-9._@+-]+$/.test(part))) {
    return false;
  }
  try {
    const decoded = Buffer.from(encoded, "base64");
    const prefix = Buffer.from("\0\0\0\u000bssh-ed25519\0\0\0 ", "binary");
    return decoded.length === 51 && decoded.subarray(0, prefix.length).equals(prefix);
  } catch {
    return false;
  }
}

function unique(values) {
  return [...new Set(values)];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
