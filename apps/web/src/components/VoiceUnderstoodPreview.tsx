import { formatDecisionResult, formatSessionDetail } from "../lib/session-outcome";
import type { UnderstoodDecision } from "../lib/decision-signal";
import type { JoinSession } from "../lib/types";

export type VoiceUnderstoodPreviewProps = {
  understood: UnderstoodDecision;
  sessionType: JoinSession["type"];
  options?: JoinSession["brief"]["options"];
};

/** Humanized headline for an in-call (not yet saved) understanding. */
export function understoodHeadline(
  understood: UnderstoodDecision,
  sessionType: string,
  options?: Array<{ id: string; label: string }>,
): string {
  if (!understood.result) return "Context noted";
  const fromResult =
    formatSessionDetail({
      status: "active",
      type: sessionType,
      result: understood.result,
      brief: { reason: "", options },
    }) ??
    formatDecisionResult(understood.result, options) ??
    "Decision noted";
  return fromResult;
}

export function VoiceUnderstoodPreview({
  understood,
  sessionType,
  options,
}: VoiceUnderstoodPreviewProps) {
  const headline = understoodHeadline(understood, sessionType, options);
  const summary = understood.summary?.trim();
  const showSummary = Boolean(summary && summary !== headline);
  const capturedSections = [
    ["Steering", understood.captured_context?.steering],
    ["Additional instructions", understood.captured_context?.additional_instructions],
    ["New requests", understood.captured_context?.new_requests],
    ["Unresolved", understood.captured_context?.unresolved_topics],
  ] as const;
  const visibleCapturedSections = capturedSections.filter(([, items]) => items && items.length > 0);

  return (
    <aside className="voice-understood" aria-live="polite" aria-label="Understood so far">
      <div className="voice-understood-label">Understood so far</div>
      <div className="voice-understood-headline">{headline}</div>
      {showSummary && <p className="voice-understood-summary">{summary}</p>}
      {visibleCapturedSections.length > 0 && (
        <div className="voice-understood-captured" aria-label="Also captured">
          <div className="voice-understood-captured-title">Also captured</div>
          {visibleCapturedSections.map(([label, items]) => (
            <div key={label} className="voice-understood-captured-group">
              <strong>{label}</strong>
              <ul>
                {items?.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </div>
          ))}
        </div>
      )}
      <p className="voice-understood-hint">
        Still talking — say if this is wrong. Nothing is saved until the agent confirms.
      </p>
    </aside>
  );
}
