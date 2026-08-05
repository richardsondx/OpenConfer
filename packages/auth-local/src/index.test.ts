import { describe, expect, it } from "vitest";
import {
  isWebhookTimestampFresh,
  signJoinJwt,
  signWebhookPayload,
  verifyJoinJwt,
  verifySignedWebhook,
  verifyWebhookSignature,
  webhookSignatureInput,
} from "./index.js";

describe("local token security", () => {
  it("signs scoped, expiring join grants", async () => {
    const token = await signJoinJwt({ sessionId: "ses_1", joinToken: "nonce" }, "secret", 60);
    await expect(verifyJoinJwt(token, "secret")).resolves.toEqual({
      sessionId: "ses_1",
      joinToken: "nonce",
    });
    await expect(verifyJoinJwt(token, "wrong-secret")).resolves.toBeNull();
  });

  it("binds webhook signatures to timestamp and event id", () => {
    const input = webhookSignatureInput("2026-01-01T00:00:00Z", "evt_1", '{"ok":true}');
    const signature = signWebhookPayload(input, "secret");
    expect(verifyWebhookSignature(input, signature, "secret")).toBe(true);
    expect(verifyWebhookSignature(input.replace("evt_1", "evt_2"), signature, "secret")).toBe(false);
  });

  it("rejects webhook signatures outside the replay window", () => {
    const now = Date.parse("2026-08-04T12:00:00.000Z");
    const fresh = "2026-08-04T11:59:00.000Z";
    const stale = "2026-08-04T11:50:00.000Z";
    const body = '{"ok":true}';
    const signature = signWebhookPayload(webhookSignatureInput(fresh, "evt_1", body), "secret");
    expect(isWebhookTimestampFresh(fresh, now)).toBe(true);
    expect(isWebhookTimestampFresh(stale, now)).toBe(false);
    expect(
      verifySignedWebhook({
        timestamp: fresh,
        eventId: "evt_1",
        body,
        signature,
        secret: "secret",
        now,
      }),
    ).toBe(true);
    expect(
      verifySignedWebhook({
        timestamp: stale,
        eventId: "evt_1",
        body,
        signature: signWebhookPayload(webhookSignatureInput(stale, "evt_1", body), "secret"),
        secret: "secret",
        now,
      }),
    ).toBe(false);
  });
});
