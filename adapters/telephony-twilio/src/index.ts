import {
  ConnectTwilioCallRequest_TwilioCallDirection,
  LiveKitAPI,
} from "livekit-server-sdk";
import type { TelephonyAdapter } from "@openconfer/adapter-sdk";

export interface TwilioTelephonyConfig {
  accountSid?: string;
  authToken?: string;
  fromNumber?: string;
  destinationNumber?: string;
  livekitUrl?: string;
  livekitApiKey?: string;
  livekitApiSecret?: string;
}

export interface TwilioConnectorClient {
  connectTwilioCall(options: {
    twilioCallDirection: ConnectTwilioCallRequest_TwilioCallDirection;
    roomName: string;
    participantIdentity?: string;
    participantName?: string;
    participantMetadata?: string;
  }): Promise<{ connectUrl: string }>;
}

export interface TwilioTelephonyDependencies {
  fetch?: typeof fetch;
  connector?: TwilioConnectorClient;
}

const E164 = /^\+[1-9]\d{7,14}$/;

function missingConfiguration(config: TwilioTelephonyConfig): string[] {
  const missing: string[] = [];
  if (!config.accountSid) missing.push("Twilio Account SID");
  if (!config.authToken) missing.push("Twilio Auth Token");
  if (!config.fromNumber) missing.push("Twilio source number");
  if (!config.destinationNumber) missing.push("destination number");
  if (!config.livekitUrl) missing.push("LiveKit URL");
  if (!config.livekitApiKey) missing.push("LiveKit API key");
  if (!config.livekitApiSecret) missing.push("LiveKit API secret");
  return missing;
}

function connectorFor(config: TwilioTelephonyConfig): TwilioConnectorClient {
  const host = config.livekitUrl!.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  return new LiveKitAPI({
    host,
    apiKey: config.livekitApiKey!,
    secret: config.livekitApiSecret!,
  }).connector;
}

function twimlUrl(connectUrl: string): string {
  return connectUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

async function responseError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { message?: unknown };
  return typeof body.message === "string" ? body.message : `Twilio returned HTTP ${response.status}`;
}

export function createTwilioTelephonyAdapter(
  config: TwilioTelephonyConfig,
  dependencies: TwilioTelephonyDependencies = {},
): TelephonyAdapter {
  return {
    name: "twilio",
    async call(session, room) {
      const missing = missingConfiguration(config);
      if (missing.length > 0) {
        return {
          success: false,
          channel: "twilio",
          error: `Missing ${missing.join(", ")}`,
        };
      }
      if (!E164.test(config.fromNumber!) || !E164.test(config.destinationNumber!)) {
        return {
          success: false,
          channel: "twilio",
          error: "Twilio phone numbers must use E.164 format, for example +14165550123",
        };
      }

      try {
        const connector = dependencies.connector ?? connectorFor(config);
        const connected = await connector.connectTwilioCall({
          twilioCallDirection: ConnectTwilioCallRequest_TwilioCallDirection.OUTBOUND,
          roomName: room.roomName,
          participantIdentity: `phone-${session.participant.operatorId}`,
          participantName: session.participant.callName ?? "Phone operator",
          participantMetadata: JSON.stringify({
            sessionId: session.id,
            operatorId: session.participant.operatorId,
          }),
        });
        if (!connected.connectUrl) throw new Error("LiveKit did not return a Twilio connector URL");

        const body = new URLSearchParams({
          To: config.destinationNumber!,
          From: config.fromNumber!,
          Url: twimlUrl(connected.connectUrl),
        });
        const response = await (dependencies.fetch ?? fetch)(
          `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid!)}/Calls.json`,
          {
            method: "POST",
            headers: {
              Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body,
          },
        );
        if (!response.ok) throw new Error(await responseError(response));
        const created = (await response.json()) as { sid?: string; status?: string };
        return {
          success: true,
          channel: "twilio",
          callId: created.sid,
          message: `Twilio call ${created.status ?? "queued"}`,
        };
      } catch (error) {
        return {
          success: false,
          channel: "twilio",
          error: error instanceof Error ? error.message : "Twilio call failed",
        };
      }
    },
    async status(callId) {
      if (!config.accountSid || !config.authToken) {
        return { success: false, error: "Twilio credentials are not configured" };
      }
      try {
        const response = await (dependencies.fetch ?? fetch)(
          `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Calls/${encodeURIComponent(callId)}.json`,
          {
            headers: {
              Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`,
            },
          },
        );
        if (!response.ok) throw new Error(await responseError(response));
        const call = (await response.json()) as { status?: unknown };
        return {
          success: true,
          status: typeof call.status === "string" ? call.status : "unknown",
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Could not read Twilio call status",
        };
      }
    },
    async test() {
      const missing = missingConfiguration(config);
      return missing.length === 0
        ? { ok: true, message: "Twilio and LiveKit credentials are configured" }
        : { ok: false, message: `Missing ${missing.join(", ")}` };
    },
  };
}
