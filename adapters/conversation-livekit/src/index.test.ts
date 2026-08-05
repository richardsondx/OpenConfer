import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConferSession } from "@openconfer/core";

const createRoom = vi.fn();
const deleteRoom = vi.fn();

vi.mock("livekit-server-sdk", () => {
  class AccessToken {
    addGrant() {}
    async toJwt() {
      return "jwt-token";
    }
  }
  class LiveKitAPI {
    room = { deleteRoom, createRoom };
  }
  class RoomAgentDispatch {
    constructor(options: Record<string, unknown>) {
      Object.assign(this, options);
    }
  }
  return { AccessToken, LiveKitAPI, RoomAgentDispatch };
});

const { createLiveKitAdapter } = await import("./index.js");

const session: ConferSession = {
  id: "ses_dispatch",
  type: "decision",
  status: "joining",
  initiator: { agentId: "agent", harness: "test" },
  participant: { operatorId: "me", callName: "Richardson" },
  objective: "Decide",
  brief: { reason: "Need a human" },
  resultSchema: { type: "object" },
  routing: { policy: "default" },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("LiveKit adapter dispatch", () => {
  beforeEach(() => {
    createRoom.mockReset();
    deleteRoom.mockReset();
    createRoom.mockResolvedValue({ name: "confer-ses_dispatch" });
  });

  it("creates the room with a named agent before returning join credentials", async () => {
    const adapter = createLiveKitAdapter({
      url: "wss://livekit.example",
      apiUrl: "https://livekit.example",
      apiKey: "key",
      apiSecret: "secret",
      agentName: "openconfer-voice",
      mock: false,
    });

    const room = await adapter.createRoom(session);
    expect(room).toEqual({
      roomName: "confer-ses_dispatch",
      token: "jwt-token",
      url: "wss://livekit.example",
    });
    expect(createRoom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "confer-ses_dispatch",
        agents: [
          expect.objectContaining({
            agentName: "openconfer-voice",
            metadata: expect.stringContaining("resultSchema"),
          }),
        ],
      }),
    );
    const metadata = JSON.parse(createRoom.mock.calls[0]![0].metadata);
    expect(metadata.operator.preferredName).toBe("Richardson");
  });

  it("still returns room credentials when createRoom fails", async () => {
    createRoom.mockRejectedValue(new Error("room service unavailable"));
    const adapter = createLiveKitAdapter({
      url: "wss://livekit.example",
      apiUrl: "https://livekit.example",
      apiKey: "key",
      apiSecret: "secret",
      agentName: "openconfer-voice",
      mock: false,
    });

    const room = await adapter.createRoom(session);
    expect(room.token).toBe("jwt-token");
    expect(room.url).toBe("wss://livekit.example");
  });

  it("deletes the room on endRoom", async () => {
    deleteRoom.mockResolvedValue({});
    const adapter = createLiveKitAdapter({
      url: "wss://livekit.example",
      apiUrl: "https://livekit.example",
      apiKey: "key",
      apiSecret: "secret",
      mock: false,
    });
    await adapter.endRoom("ses_dispatch");
    expect(deleteRoom).toHaveBeenCalledWith("confer-ses_dispatch");
  });
});
