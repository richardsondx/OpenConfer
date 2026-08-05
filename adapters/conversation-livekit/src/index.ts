import { AccessToken, LiveKitAPI, RoomAgentDispatch } from "livekit-server-sdk";
import type { ConversationAdapter } from "@openconfer/adapter-sdk";

export interface LiveKitConfig {
  url?: string;
  apiKey?: string;
  apiSecret?: string;
  apiUrl?: string;
  agentName?: string;
  mock?: boolean;
}

function sessionMetadata(
  session: Parameters<ConversationAdapter["createRoom"]>[0],
  surface: NonNullable<Parameters<ConversationAdapter["createRoom"]>[1]>["surface"] = "browser",
): string {
  return JSON.stringify({
    sessionId: session.id,
    type: session.type,
    locale: session.locale,
    initiator: session.initiator,
    operator: { preferredName: session.participant.callName },
    objective: session.objective,
    brief: session.brief,
    resultSchema: session.resultSchema,
    surface,
    pendingDecision: session.pendingDecision
      ? {
          result: session.pendingDecision.result,
          summary: session.pendingDecision.summary,
          capturedContext: session.pendingDecision.capturedContext,
          revision: session.pendingDecision.revision,
        }
      : undefined,
  });
}

export function createLiveKitAdapter(config: LiveKitConfig): ConversationAdapter {
  const mock = config.mock ?? !config.apiKey;

  return {
    name: mock ? "browser-mock" : "livekit",
    async createRoom(session, options) {
      const roomName = options?.roomName ?? `confer-${session.id}`;
      if (mock) {
        return { roomName, token: `mock-${session.id}`, url: config.url ?? "mock://local" };
      }
      if (!config.url || !config.apiKey || !config.apiSecret) {
        throw new Error("LiveKit URL, API key, and API secret are required");
      }

      const metadata = sessionMetadata(session, options?.surface);
      const agentName = config.agentName;

      // Create the room (with agent dispatch) before minting the operator token.
      // Do not put roomConfig/agents on the JWT — local LiveKit --dev rejects newer
      // RoomAgentDispatch fields (e.g. restartPolicy) and the browser never connects.
      if (config.apiUrl) {
        try {
          const apiUrl = config.apiUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
          const api = new LiveKitAPI({
            host: apiUrl,
            apiKey: config.apiKey,
            secret: config.apiSecret,
          });
          await api.room.createRoom({
            name: roomName,
            emptyTimeout: 15 * 60,
            departureTimeout: 30,
            metadata,
            ...(agentName
              ? {
                  agents: [new RoomAgentDispatch({ agentName, metadata })],
                }
              : {}),
          });
        } catch (error) {
          console.warn(
            `[openconfer] LiveKit createRoom warning for ${roomName}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }

      const at = new AccessToken(config.apiKey!, config.apiSecret!, {
        identity: `operator-${session.participant.operatorId}`,
        ttl: "15m",
      });
      at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
      const token = await at.toJwt();
      return { roomName, token, url: config.url };
    },
    async endRoom(sessionIdOrRoomName) {
      if (mock || !config.apiUrl) return;
      const apiUrl = config.apiUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
      const api = new LiveKitAPI({ host: apiUrl, apiKey: config.apiKey, secret: config.apiSecret });
      const roomName = sessionIdOrRoomName.startsWith("confer-")
        ? sessionIdOrRoomName
        : `confer-${sessionIdOrRoomName}`;
      await api.room.deleteRoom(roomName).catch(() => undefined);
    },
    async test() {
      if (mock) return { ok: true, message: "Browser mock conversation adapter ready" };
      if (!config.url || !config.apiKey || !config.apiSecret) {
        return { ok: false, message: "LiveKit URL or credentials missing" };
      }
      return { ok: true, message: "LiveKit adapter configured" };
    },
  };
}
