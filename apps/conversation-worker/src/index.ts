import {
  ServerOptions,
  cli,
  defineAgent,
  llm,
  type JobContext,
  voice,
} from "@livekit/agents";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  createAgentSession,
  describeSpeakingConfig,
  readSpeakingWorkerEnv,
  speakingWorkerEnabled,
} from "./session-factory.js";
import { instructionsFor, type ConferMetadata } from "./prompt.js";

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
        method: "voice_agent",
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

const agent = defineAgent({
  entry: async (ctx: JobContext) => {
    const metadata = parseMetadata(ctx.job.metadata);
    const sessionId = metadata.sessionId;
    const locale = metadata.locale ?? "en";
    const speaking = readSpeakingWorkerEnv();
    const session = await createAgentSession(speaking, locale);

    const resultParams = {
      result_json: z
        .string()
        .describe("JSON object matching the session result_schema exactly (not markdown)."),
      summary: z
        .string()
        .optional()
        .describe("One-sentence summary of what the operator decided."),
    };

    const previewDecision = llm.tool({
      description:
        "Show the operator what you currently understand as their decision (on-screen preview only). Call as soon as a clear candidate emerges, and again whenever they change their mind. Does not save the decision.",
      parameters: z.object(resultParams),
      execute: async ({ result_json, summary }) => {
        const parsed = parseResultJson(result_json);
        if (!parsed.ok) return parsed.error;
        await publishDecisionSignal(ctx.room, {
          status: "preview",
          result: parsed.result,
          summary,
        });
        return "Preview updated on the operator's screen. Keep talking. If they change their mind, call preview_decision again. Only call submit_decision after they clearly confirm aloud.";
      },
    });

    const submitDecision = llm.tool({
      description:
        "Submit the operator's final spoken decision to OpenConfer. Call only after the operator clearly confirmed the choice (preferably matching the last preview_decision).",
      parameters: z.object(resultParams),
      execute: async ({ result_json, summary }) => {
        if (!sessionId) {
          return "Cannot submit: session id missing from room metadata.";
        }
        const parsed = parseResultJson(result_json);
        if (!parsed.ok) return parsed.error;
        const result = parsed.result;
        const outcome = await confirmDecision(sessionId, result, summary);
        if (!outcome.ok) {
          await publishDecisionSignal(ctx.room, { status: "failed", error: outcome.error });
          return `Submission failed: ${outcome.error}. Tell the operator a technical issue prevented saving the decision, and that they can use the on-screen text form. Retry submit_decision once if they want to keep talking.`;
        }
        await publishDecisionSignal(ctx.room, { status: "ok", result, summary });
        return `Decision recorded (${outcome.status}). Thank the operator and end the call.`;
      },
    });

    await session.start({
      room: ctx.room,
      agent: voice.Agent.create({
        instructions: instructionsFor(metadata),
        tools: { preview_decision: previewDecision, submit_decision: submitDecision },
      }),
    });
    await session.generateReply({
      instructions:
        `Open the call now in the session locale (${locale}) with only a short, warm greeting. Use the operator's preferred name when provided, then stop and wait for their response. Do not state the objective or options yet.`,
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
