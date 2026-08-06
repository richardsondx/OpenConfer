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
  locale: "it-IT",
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
    expect(metadata.locale).toBe("it-IT");
    expect(metadata.surface).toBe("browser");
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

  it("passes safe continuity context but never provider memory references to the voice worker", async () => {
    const adapter = createLiveKitAdapter({
      url: "wss://livekit.example",
      apiUrl: "https://livekit.example",
      apiKey: "key",
      apiSecret: "secret",
      agentName: "openconfer-voice",
      mock: false,
    });
    await adapter.createRoom({
      ...session,
      continuity: {
        continuity_version: "1.0",
        agent: {
          id: "agent",
          name: "Hermes",
          personality_summary: {
            identity_statement: "An established collaborator",
            tone: ["direct"],
            speaking_style: [],
            interaction_style: [],
            values: [],
            preferred_phrasing: [],
            disallowed_phrasing: ["Nice to meet you"],
          },
        },
        relationship: { status: "established", first_interaction: false },
        thread: {
          summary: "Continue the handoff.",
          current_goal: "Preserve identity.",
          open_questions: [],
          decisions_so_far: [],
          commitments: [],
        },
        memory: {
          provider: "honcho",
          connection_id: "secret-ref",
          session_strategy: "per_source_conversation",
          permissions: ["relationship:read"],
        },
      },
    });
    const metadata = JSON.parse(createRoom.mock.calls[0]![0].metadata);
    expect(metadata.continuity.agent.name).toBe("Hermes");
    expect(metadata.continuity.thread.current_goal).toBe("Preserve identity.");
    expect(JSON.stringify(metadata)).not.toContain("secret-ref");
    expect(JSON.stringify(metadata)).not.toContain("honcho");
  });

  it("creates a fresh named room and passes an unconfirmed preview to the voice agent", async () => {
    const adapter = createLiveKitAdapter({
      url: "wss://livekit.example",
      apiUrl: "https://livekit.example",
      apiKey: "key",
      apiSecret: "secret",
      agentName: "openconfer-voice",
      mock: false,
    });
    const roomName = "confer-ses_dispatch-call-2";
    createRoom.mockResolvedValue({ name: roomName });
    const room = await adapter.createRoom(
      {
        ...session,
        pendingDecision: {
          result: { approved: true },
          summary: "Approve",
          revision: 3,
          previewedAt: "2026-08-05T12:00:00.000Z",
        },
      },
      { roomName, surface: "phone" },
    );

    expect(room.roomName).toBe(roomName);
    expect(createRoom).toHaveBeenCalledWith(expect.objectContaining({ name: roomName }));
    const metadata = JSON.parse(createRoom.mock.calls[0]![0].metadata);
    expect(metadata.pendingDecision).toMatchObject({
      result: { approved: true },
      summary: "Approve",
      revision: 3,
    });
    expect(metadata.surface).toBe("phone");
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
    await adapter.endRoom("confer-ses_dispatch-call-2");
    expect(deleteRoom).toHaveBeenLastCalledWith("confer-ses_dispatch-call-2");
  });
});
