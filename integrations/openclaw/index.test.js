import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createResultRouter,
  createWebhookReceiver,
  verifySignedWebhook,
  webhookSignatureInput,
} from "./index.js";

describe("OpenClaw OpenConfer plugin helpers", () => {
  const servers = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });

  it("verifies signed webhooks inside the replay window", () => {
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({ session_id: "ses_1", status: "completed" });
    const signature = createHmac("sha256", "secret")
      .update(webhookSignatureInput(timestamp, "evt_1", body))
      .digest("hex");
    expect(verifySignedWebhook({ timestamp, eventId: "evt_1", body, signature, secret: "secret" })).toBe(true);
    expect(
      verifySignedWebhook({
        timestamp: "2020-01-01T00:00:00.000Z",
        eventId: "evt_1",
        body,
        signature,
        secret: "secret",
      }),
    ).toBe(false);
  });

  it("routes results to the tracked OpenClaw task and acknowledges once", async () => {
    const router = createResultRouter();
    router.track("ses_1", { toolCallId: "tool-1", runId: "run-1" });
    const acknowledge = vi.fn(async () => undefined);
    const first = await router.ingest({
      eventId: "evt_1",
      sessionId: "ses_1",
      payload: { result: { approved: true } },
      acknowledge,
    });
    const second = await router.ingest({
      eventId: "evt_1",
      sessionId: "ses_1",
      payload: { result: { approved: true } },
      acknowledge,
    });
    expect(first.duplicate).toBe(false);
    expect(first.task).toEqual({ toolCallId: "tool-1", runId: "run-1" });
    expect(second.duplicate).toBe(true);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledWith("ses_1", "run-1");
  });

  it("serves a signed webhook receiver that auto-acknowledges", async () => {
    const router = createResultRouter();
    router.track("ses_1", { toolCallId: "tool-1", runId: "run-1" });
    const acknowledge = vi.fn(async () => undefined);
    const server = createWebhookReceiver({ secret: "secret", router, acknowledge });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const { port } = server.address();
    const body = JSON.stringify({ session_id: "ses_1", status: "completed", result: { approved: true } });
    const timestamp = new Date().toISOString();
    const eventId = "evt_live";
    const signature = createHmac("sha256", "secret")
      .update(webhookSignatureInput(timestamp, eventId, body))
      .digest("hex");
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openconfer-timestamp": timestamp,
        "x-openconfer-event-id": eventId,
        "x-openconfer-signature": signature,
      },
      body,
    });
    expect(response.status).toBe(204);
    expect(acknowledge).toHaveBeenCalledWith("ses_1", "run-1");
  });
});
