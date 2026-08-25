import { describe, expect, it } from "vitest";
import { verifyWebhookSignature, WebCryptoBootstrapTokenBroker } from "../packages/crypto/src/index";

describe("webhook and bootstrap cryptography", () => {
  it("matches GitHub's published HMAC-SHA256 test vector", async () => {
    const body = new TextEncoder().encode("Hello, World!").buffer;
    await expect(
      verifyWebhookSignature(
        "It's a Secret to Everybody",
        body,
        "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
      ),
    ).resolves.toBe(true);
    await expect(verifyWebhookSignature("wrong", body, `sha256=${"0".repeat(64)}`)).resolves.toBe(false);
  });

  it("mints random tokens and stores only a non-reversible digest", async () => {
    const broker = new WebCryptoBootstrapTokenBroker();
    const first = await broker.mint();
    const second = await broker.mint();
    expect(first.token).not.toBe(second.token);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.hash).not.toContain(first.token);
    await expect(broker.matches(first.token, first.hash)).resolves.toBe(true);
    await expect(broker.matches(second.token, first.hash)).resolves.toBe(false);
  });
});
