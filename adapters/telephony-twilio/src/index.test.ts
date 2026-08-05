import { describe, expect, it, vi } from "vitest";
import type { ConferSession } from "@openconfer/core";
import { createTwilioTelephonyAdapter } from "./index.js";

const session: ConferSession = {
  id: "ses_twilio",
  type: "decision",
  locale: "en",
  status: "dispatching",
  initiator: { agentId: "agent", harness: "test" },
  participant: { operatorId: "me", callName: "Richardson" },
  objective: "Approve release",
  brief: { reason: "Release is waiting" },
  resultSchema: {},
  routing: { policy: "default" },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const config = {
  accountSid: "AC0123456789abcdef0123456789abcdef",
  authToken: "secret-token",
  fromNumber: "+14165550100",
  destinationNumber: "+14165550101",
  livekitUrl: "wss://project.livekit.cloud",
  livekitApiKey: "livekit-key",
  livekitApiSecret: "livekit-secret",
};

describe("Twilio telephony adapter", () => {
  it("creates a LiveKit connector session and queues the Twilio call", async () => {
    const connectTwilioCall = vi.fn(async () => ({ connectUrl: "wss://connector.livekit.cloud/call" }));
    const fetchMock = vi.fn<typeof fetch>(async (_input, _init) =>
      new Response(JSON.stringify({ sid: "CA123", status: "queued" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const adapter = createTwilioTelephonyAdapter(config, {
      connector: { connectTwilioCall },
      fetch: fetchMock,
    });

    const result = await adapter.call(session, { roomName: "confer-ses_twilio" });

    expect(result).toMatchObject({ success: true, channel: "twilio", callId: "CA123" });
    expect(connectTwilioCall).toHaveBeenCalledWith(
      expect.objectContaining({ roomName: "confer-ses_twilio", participantName: "Richardson" }),
    );
    const [, init] = fetchMock.mock.calls[0]!;
    expect(String(init?.body)).toContain("To=%2B14165550101");
    expect(String(init?.body)).toContain("From=%2B14165550100");
    expect(String(init?.body)).toContain("Url=https%3A%2F%2Fconnector.livekit.cloud%2Fcall");
    expect(String(init?.body)).toContain("MachineDetection=Enable");
  });

  it("fails safely when configuration is incomplete", async () => {
    const adapter = createTwilioTelephonyAdapter({});
    await expect(adapter.call(session, { roomName: "room" })).resolves.toMatchObject({
      success: false,
      channel: "twilio",
      error: expect.stringContaining("Account SID"),
    });
  });

  it("returns Twilio errors without exposing credentials", async () => {
    const adapter = createTwilioTelephonyAdapter(config, {
      connector: { connectTwilioCall: async () => ({ connectUrl: "wss://connector/call" }) },
      fetch: async () =>
        new Response(JSON.stringify({ message: "The destination number is invalid" }), { status: 400 }),
    });
    const result = await adapter.call(session, { roomName: "room" });
    expect(result.error).toBe("The destination number is invalid");
    expect(result.retryable).toBe(false);
    expect(result.error).not.toContain(config.authToken);
  });

  it("classifies provider 5xx failures as retryable", async () => {
    const adapter = createTwilioTelephonyAdapter(config, {
      connector: { connectTwilioCall: async () => ({ connectUrl: "wss://connector/call" }) },
      fetch: async () => new Response(JSON.stringify({ message: "Twilio unavailable" }), { status: 503 }),
    });
    await expect(adapter.call(session, { roomName: "room" })).resolves.toMatchObject({
      success: false,
      retryable: true,
      error: "Twilio unavailable",
    });
  });

  it("reads the live Twilio call status", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ status: "ringing", answered_by: "human" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const adapter = createTwilioTelephonyAdapter(config, { fetch: fetchMock });

    await expect(adapter.status?.("CA123")).resolves.toEqual({
      success: true,
      status: "ringing",
      answeredBy: "human",
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/Calls/CA123.json");
  });

  it("ends an in-progress call when Twilio rejects the pre-connect cancel status", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const status = new URLSearchParams(String(init?.body)).get("Status");
      return status === "canceled"
        ? new Response(JSON.stringify({ message: "Call is already in progress" }), { status: 400 })
        : new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    });
    const adapter = createTwilioTelephonyAdapter(config, { fetch: fetchMock });

    await expect(adapter.cancel?.("CA-active")).resolves.toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain("Status=canceled");
    expect(String(fetchMock.mock.calls[1]?.[1]?.body)).toContain("Status=completed");
  });
});
