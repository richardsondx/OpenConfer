import {
  AgentSessionEventTypes,
  ServerOptions,
  cli,
  defineAgent,
  llm,
  type JobContext,
  voice,
} from "@livekit/agents";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { CapturedContext } from "@openconfer/schemas";
import {
  createAgentSession,
  describeSpeakingConfig,
  readSpeakingWorkerEnv,
  speakingWorkerEnabled,
} from "./session-factory.js";
import {
  createVoiceSessionTimeoutGuard,
  readVoiceSessionTimeouts,
  type VoiceDisconnectReason,
} from "./idle-policy.js";
import { instructionsFor, type ConferMetadata } from "./prompt.js";
import {
  BoundedSaveRetry,
  retryAuthorizationMessage,
  saveFailureMessage,
  submitToolDescription,
  understandingSavedMessage,
  understandingToolDescription,
  understandingToolName,
} from "./voice-tool-policy.js";

function parseMetadata(value: string | undefined): ConferMetadata {
  if (!value) return {};
  try {
    return JSON.parse(value) as ConferMetadata;
  } catch {
    return {};
  }
}

async function publishDecisionSignal(
  room: JobContext["room"],
  payload: {
    status: "preview" | "ok" | "failed";
    error?: string;
    result?: Record<string, unknown>;
    summary?: string;
    capturedContext?: CapturedContext;
    revision?: number;
  },
): Promise<void> {
  const participant = room.localParticipant;
  if (!participant) return;
  const data = new TextEncoder().encode(
    JSON.stringify({
      type: "openconfer.decision",
      status: payload.status,
      error: payload.error,
      result: payload.result,
      summary: payload.summary,
      captured_context: payload.capturedContext,
      revision: payload.revision,
    }),
  );
  try {
    await participant.publishData(data, { reliable: true, topic: "openconfer.decision" });
  } catch {
    // UI also polls session status; signal is best-effort.
  }
}

function parseResultJson(resultJson: string):
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(resultJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "result_json must be a JSON object matching result_schema." };
    }
    return { ok: true, result: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: "result_json was not valid JSON. Retry with a plain JSON object." };
  }
}

async function confirmDecision(
  sessionId: string,
  result: Record<string, unknown>,
  summary?: string,
  capturedContext?: CapturedContext,
  previewRevision?: number,
  submissionId?: string,
): Promise<{ ok: true; status: string } | { ok: false; error: string }> {
  const baseUrl = (process.env.OPENCONFER_BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
  const token = process.env.OPENCONFER_API_TOKEN;
  if (!token) {
    return { ok: false, error: "OPENCONFER_API_TOKEN is not set on the speaking agent." };
  }
  try {
    const response = await fetch(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        result,
        summary,
        captured_context: capturedContext,
        method: "voice_agent",
        preview_revision: previewRevision,
        submission_id: submissionId,
      }),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: unknown; status?: string };
    if (!response.ok) {
      const detail =
        typeof body.error === "string"
          ? body.error
          : body.error
            ? JSON.stringify(body.error)
            : `HTTP ${response.status}`;
      return { ok: false, error: detail };
    }
    return { ok: true, status: typeof body.status === "string" ? body.status : "completed" };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not reach OpenConfer to confirm.",
    };
  }
}

async function persistPreview(
  sessionId: string,
  result: Record<string, unknown>,
  summary: string | undefined,
  capturedContext: CapturedContext,
  expectedRevision: number,
): Promise<{ ok: true; revision: number } | { ok: false; error: string }> {
  const baseUrl = (process.env.OPENCONFER_BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
  const token = process.env.OPENCONFER_API_TOKEN;
  if (!token) return { ok: false, error: "OPENCONFER_API_TOKEN is not set on the speaking agent." };
  try {
    const response = await fetch(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        result,
        summary,
        captured_context: capturedContext,
        expected_revision: expectedRevision,
      }),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: unknown; revision?: unknown };
    if (!response.ok || typeof body.revision !== "number") {
      return { ok: false, error: typeof body.error === "string" ? body.error : `HTTP ${response.status}` };
    }
    return { ok: true, revision: body.revision };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not persist preview." };
  }
}

async function stopCallbacks(sessionId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const baseUrl = (process.env.OPENCONFER_BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
  const token = process.env.OPENCONFER_API_TOKEN;
  if (!token) return { ok: false, error: "OPENCONFER_API_TOKEN is not set on the speaking agent." };
  try {
    const response = await fetch(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/phone/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      return { ok: false, error: typeof body.error === "string" ? body.error : `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not stop callbacks." };
  }
}

async function disconnectVoiceResources(
  sessionId: string,
  reason: VoiceDisconnectReason,
): Promise<void> {
  const baseUrl = (process.env.OPENCONFER_BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
  const token = process.env.OPENCONFER_API_TOKEN;
  if (!token) throw new Error("OPENCONFER_API_TOKEN is not set on the speaking agent.");
  const response = await fetch(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/voice/stop`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
  }
}

const agent = defineAgent({
  entry: async (ctx: JobContext) => {
    const metadata = parseMetadata(ctx.job.metadata);
    const sessionId = metadata.sessionId;
    const locale = metadata.locale ?? "en";
    const surface = metadata.surface ?? "browser";
    const speaking = readSpeakingWorkerEnv();
    const session = await createAgentSession(speaking, locale);
    let currentPreviewRevision = metadata.pendingDecision?.revision ?? 0;
    const understandingRetry = new BoundedSaveRetry();
    const submissionRetry = new BoundedSaveRetry();

    const capturedContextParams = z.object({
      steering: z.array(z.string()).default([]),
      additional_instructions: z.array(z.string()).default([]),
      new_requests: z.array(z.string()).default([]),
      unresolved_topics: z.array(z.string()).default([]),
    });
    const resultParams = {
      result_json: z
        .string()
        .describe("JSON object matching the session result_schema exactly (not markdown)."),
      summary: z
        .string()
        .optional()
        .describe("One-sentence summary of what the operator decided."),
      captured_context: capturedContextParams.describe(
        "Confirmed sidecar for steering, additional instructions, new requests, and unresolved topics. Use empty arrays when a category has no items.",
      ),
      ...(surface === "phone"
        ? {
            retry_authorized: z
              .boolean()
              .optional()
              .describe("Set true only after the caller explicitly agrees to the one offered retry."),
          }
        : {}),
    };

    const previewDecision = llm.tool({
      description: understandingToolDescription(surface),
      parameters: z.object(resultParams),
      execute: async (args) => {
        const { result_json, summary, captured_context } = args;
        const retryAuthorized = "retry_authorized" in args && args.retry_authorized === true;
        if (!sessionId) {
          return surface === "phone"
            ? saveFailureMessage(surface, "understanding", true)
            : "Cannot save preview: session id missing from room metadata.";
        }
        const retryDecision = understandingRetry.beforeAttempt(retryAuthorized);
        if (surface === "phone" && retryDecision === "exhausted") {
          return saveFailureMessage(surface, "understanding", true);
        }
        if (surface === "phone" && retryDecision === "awaiting_authorization") {
          return retryAuthorizationMessage("understanding");
        }
        const parsed = parseResultJson(result_json);
        if (!parsed.ok) return parsed.error;
        const persisted = await persistPreview(
          sessionId,
          parsed.result,
          summary,
          captured_context,
          currentPreviewRevision,
        );
        if (!persisted.ok) {
          console.warn(`[openconfer] could not persist voice understanding for ${sessionId}: ${persisted.error}`);
          if (surface === "phone") {
            understandingRetry.recordFailure();
          }
          return saveFailureMessage(
            surface,
            "understanding",
            retryDecision === "retry",
            persisted.error,
          );
        }
        understandingRetry.recordSuccess();
        currentPreviewRevision = persisted.revision;
        await publishDecisionSignal(ctx.room, {
          status: "preview",
          result: parsed.result,
          summary,
          capturedContext: captured_context,
          revision: currentPreviewRevision,
        });
        return understandingSavedMessage(surface);
      },
    });

    const submitDecision = llm.tool({
      description: submitToolDescription(surface),
      parameters: z.object(resultParams),
      execute: async (args) => {
        const { result_json, summary, captured_context } = args;
        const retryAuthorized = "retry_authorized" in args && args.retry_authorized === true;
        if (!sessionId) {
          return surface === "phone"
            ? saveFailureMessage(surface, "submission", true)
            : "Cannot submit: session id missing from room metadata.";
        }
        const retryDecision = submissionRetry.beforeAttempt(retryAuthorized);
        if (surface === "phone" && retryDecision === "exhausted") {
          return saveFailureMessage(surface, "submission", true);
        }
        if (surface === "phone" && retryDecision === "awaiting_authorization") {
          return retryAuthorizationMessage("submission");
        }
        const parsed = parseResultJson(result_json);
        if (!parsed.ok) return parsed.error;
        const result = parsed.result;
        const outcome = await confirmDecision(
          sessionId,
          result,
          summary,
          captured_context,
          currentPreviewRevision,
          `voice:${sessionId}:${currentPreviewRevision}`,
        );
        if (!outcome.ok) {
          console.warn(`[openconfer] could not submit voice decision for ${sessionId}: ${outcome.error}`);
          await publishDecisionSignal(ctx.room, { status: "failed", error: outcome.error });
          if (surface === "phone") {
            submissionRetry.recordFailure();
          }
          return saveFailureMessage(surface, "submission", retryDecision === "retry", outcome.error);
        }
        submissionRetry.recordSuccess();
        await publishDecisionSignal(ctx.room, {
          status: "ok",
          result,
          summary,
          capturedContext: captured_context,
        });
        return `Decision recorded (${outcome.status}). Thank the operator and end the call.`;
      },
    });

    const waitForUser = llm.tool({
      description:
        "End the current turn silently when the latest audio is silence, background noise, hold music, TV audio, side conversation, or speech not addressed to the assistant.",
      parameters: z.object({}),
      execute: async () => undefined,
    });

    const stopAutomaticCallbacks = llm.tool({
      description:
        "Stop automatic phone callbacks for this session when the operator explicitly asks not to be called again. This does not decline or cancel the decision session.",
      parameters: z.object({}),
      execute: async () => {
        if (!sessionId) return "Cannot stop callbacks: session id missing from room metadata.";
        const outcome = await stopCallbacks(sessionId);
        return outcome.ok
          ? "Automatic callbacks stopped for this session. Confirm this briefly to the operator."
          : `Could not stop callbacks: ${outcome.error}`;
      },
    });

    await session.start({
      room: ctx.room,
      agent: voice.Agent.create({
        instructions: instructionsFor(metadata),
        tools: {
          [understandingToolName(surface)]: previewDecision,
          submit_decision: submitDecision,
          wait_for_user: waitForUser,
          stop_automatic_callbacks: stopAutomaticCallbacks,
        },
      }),
    });
    const timeoutGuard = createVoiceSessionTimeoutGuard(
      readVoiceSessionTimeouts(),
      async (reason) => {
        // Release the paid model connection before tearing down every room/call
        // attached to this decision. The decision itself remains open.
        session.shutdown({ drain: false, reason });
        if (sessionId) await disconnectVoiceResources(sessionId, reason);
        else await ctx.room.disconnect();
      },
    );
    session.on(AgentSessionEventTypes.UserStateChanged, (event) => {
      if (event.newState === "speaking") timeoutGuard.markUserActivity();
    });
    session.on(AgentSessionEventTypes.UserInputTranscribed, (event) => {
      if (event.isFinal && event.transcript.trim()) timeoutGuard.markUserActivity();
    });
    session.once(AgentSessionEventTypes.Close, () => timeoutGuard.stop());
    await session.generateReply({
      instructions: metadata.pendingDecision
        ? `Open in the session locale (${locale}) with a short greeting, say the previous call was interrupted, read back the pending decision packet, and ask whether it is still correct. Do not submit until the operator confirms again on this call.`
        : `Open the call now in the session locale (${locale}) with only a short, warm greeting. Use the operator's preferred name when provided, then stop and wait for their response. Do not state the objective or options yet.`,
    });
  },
});

export default agent;

const speakingConfig = readSpeakingWorkerEnv();
if (speakingWorkerEnabled(speakingConfig)) {
  console.log(`OpenConfer speaking agent: ${describeSpeakingConfig(speakingConfig)}`);
  cli.runApp(
    new ServerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: process.env.OPENCONFER_VOICE_AGENT_NAME ?? "openconfer-conversation",
    }),
  );
} else {
  console.log(
    "OpenConfer voice agent disabled: configure speaking credentials (Live preset needs OPENAI_API_KEY; Flexible needs Deepgram + OpenRouter + Cartesia).",
  );
  setInterval(() => undefined, 60_000);
}
