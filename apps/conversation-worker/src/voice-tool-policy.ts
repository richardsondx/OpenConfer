export type VoiceSurface = "browser" | "phone";
export type SaveStage = "understanding" | "submission";
export type SaveAttemptDecision = "attempt" | "retry" | "awaiting_authorization" | "exhausted";

export class BoundedSaveRetry {
  private state: "ready" | "awaiting_authorization" | "exhausted" = "ready";

  beforeAttempt(retryAuthorized: boolean): SaveAttemptDecision {
    if (this.state === "exhausted") return "exhausted";
    if (this.state === "awaiting_authorization") {
      return retryAuthorized ? "retry" : "awaiting_authorization";
    }
    return "attempt";
  }

  recordFailure(): void {
    this.state = this.state === "awaiting_authorization" ? "exhausted" : "awaiting_authorization";
  }

  recordSuccess(): void {
    this.state = "ready";
  }
}

export function understandingToolName(surface: VoiceSurface): "preview_decision" | "record_current_understanding" {
  return surface === "phone" ? "record_current_understanding" : "preview_decision";
}

export function understandingToolDescription(surface: VoiceSurface): string {
  return surface === "phone"
    ? "Persist the current decision and captured context as internal state. Call as soon as either emerges and whenever either changes. Do not announce this operation. It does not finalize the answer."
    : "Show the operator the current decision and captured context (on-screen preview only). Call as soon as either emerges, and again whenever either changes. Does not save the packet.";
}

export function submitToolDescription(surface: VoiceSurface): string {
  const priorTool = understandingToolName(surface);
  return `Submit the final decision plus captured context to OpenConfer. Call only after the operator clearly confirmed the whole packet, matching the latest ${priorTool} call.`;
}

export function understandingSavedMessage(surface: VoiceSurface): string {
  return surface === "phone"
    ? "Internal state recorded. Continue the conversation naturally without announcing this operation. Only submit after the caller clearly confirms the complete answer aloud."
    : "Preview updated on the operator's screen. Keep talking. If they change their mind, call preview_decision again. Only call submit_decision after they clearly confirm aloud.";
}

export function saveFailureMessage(
  surface: VoiceSurface,
  stage: SaveStage,
  exhausted: boolean,
  internalDetail?: string,
): string {
  if (surface === "browser") {
    const detail = internalDetail ? `: ${internalDetail}` : "";
    return stage === "understanding"
      ? `Preview could not be saved${detail}. Ask the operator to repeat or use the text fallback.`
      : `Submission failed${detail}. Tell the operator a technical issue prevented saving the decision, and that they can use the on-screen text form. Retry submit_decision once if they want to keep talking.`;
  }
  if (exhausted) {
    return "No further save attempts are allowed. Briefly apologize, say the decision request remains pending, and end the conversation. Do not invoke another save tool.";
  }
  const answer = stage === "submission" ? "confirmed answer" : "answer";
  return `The ${answer} could not be saved. Briefly apologize and ask whether the caller wants you to try once more. Do not retry until they clearly agree. If they decline, say the decision request remains pending and end the conversation.`;
}

export function retryAuthorizationMessage(stage: SaveStage): string {
  const answer = stage === "submission" ? "confirmed answer" : "answer";
  return `The ${answer} is awaiting retry permission. Ask once whether the caller wants another save attempt. Do not invoke another save tool until they clearly agree.`;
}
