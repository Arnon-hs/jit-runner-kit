import type { BootstrapTokenBroker } from "../../contracts/src/index";

const encoder = new TextEncoder();

export class WebCryptoBootstrapTokenBroker implements BootstrapTokenBroker {
  async mint(): Promise<{ token: string; hash: string }> {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = base64Url(bytes);
    return { token, hash: await sha256Hex(token) };
  }

  async matches(token: string, expectedHash: string): Promise<boolean> {
    return constantTimeEqual(await sha256Hex(token), expectedHash);
  }
}

export async function verifyWebhookSignature(
  secret: string,
  body: ArrayBuffer,
  signature: string,
): Promise<boolean> {
  if (!signature.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, body);
  return constantTimeEqual(`sha256=${hex(new Uint8Array(digest))}`, signature.toLowerCase());
}

export async function createGithubAppJwt(appId: string, privateKeyPem: string, now: number): Promise<string> {
  const header = base64Url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64Url(
    encoder.encode(
      JSON.stringify({
        iat: now - 60,
        exp: now + 9 * 60,
        iss: appId,
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const unsigned = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return hex(new Uint8Array(digest));
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const normalized = pem.trim();
  if (normalized.includes("BEGIN PRIVATE KEY")) {
    return decodePem(normalized, "PRIVATE KEY").buffer as ArrayBuffer;
  }
  if (!normalized.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error("GitHub App private key must be PKCS#8 or PKCS#1 PEM");
  }
  const pkcs1 = decodePem(normalized, "RSA PRIVATE KEY");
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaAlgorithm = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const privateKey = der(0x04, pkcs1);
  return der(0x30, concat(version, rsaAlgorithm, privateKey)).buffer as ArrayBuffer;
}

function decodePem(pem: string, label: string): Uint8Array {
  const encoded = pem
    .replace(`-----BEGIN ${label}-----`, "")
    .replace(`-----END ${label}-----`, "")
    .replace(/\s+/g, "");
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function der(tag: number, value: Uint8Array): Uint8Array {
  return concat(new Uint8Array([tag]), derLength(value.length), value);
}

function derLength(length: number): Uint8Array {
  if (length < 128) return new Uint8Array([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concat(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((sum, value) => sum + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
