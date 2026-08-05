import { describe, expect, it } from "vitest";
import { createSecureLinkNotifier } from "@openconfer/notify-secure-link";
import { createLiveKitAdapter } from "@openconfer/conversation-livekit";
import type { ConferSession } from "@openconfer/core";

const mockSession: ConferSession = {
  id: "ses_test",
  type: "decision",
  locale: "en",
  status: "notified",
  initiator: { agentId: "test", harness: "test" },
  participant: { operatorId: "me" },
  objective: "Test",
  brief: { reason: "Test" },
  resultSchema: {},
  routing: { policy: "default" },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("adapter contracts", () => {
  it("secure link notifier returns join URL", async () => {
    const adapter = createSecureLinkNotifier();
    const result = await adapter.notify(mockSession, "http://localhost/join");
    expect(result.success).toBe(true);
    expect(result.joinUrl).toBe("http://localhost/join");
  });

  it("livekit mock adapter creates room", async () => {
    const adapter = createLiveKitAdapter({ mock: true });
    const room = await adapter.createRoom(mockSession);
    expect(room.roomName).toContain("confer-");
  });
});
