import { Button, Badge } from "./primitives";
import type { ApiSession } from "../lib/types";

export function IncomingCallBanner({
  session,
  snoozeMinutes = 3,
  busy,
  onAnswer,
  onSnooze,
  onDecline,
}: {
  session: ApiSession;
  snoozeMinutes?: number;
  busy?: boolean;
  onAnswer: () => void;
  onSnooze: () => void;
  onDecline: () => void;
}) {
  const isUrgent = session.urgency === "incident" || session.urgency === "high";
  const reason = session.brief?.reason ?? session.objective;

  return (
    <aside
      className={`incoming-call-banner${isUrgent ? " is-urgent" : ""}`}
      role="alertdialog"
      aria-labelledby="incoming-call-title"
      aria-describedby="incoming-call-desc"
    >
      <div className="incoming-call-banner-pulse" aria-hidden="true" />
      <div className="incoming-call-banner-body">
        <div className="incoming-call-banner-meta">
          <Badge variant={isUrgent ? "urgent" : "active"}>Incoming</Badge>
          {session.urgency && (
            <span className="incoming-call-urgency">{session.urgency}</span>
          )}
          <span className="incoming-call-agent">
            {session.initiator.agent_id} · {session.initiator.harness}
          </span>
        </div>
        <h2 id="incoming-call-title" className="incoming-call-title">
          {reason}
        </h2>
        <p id="incoming-call-desc" className="incoming-call-desc">
          {session.objective}
        </p>
        <div className="incoming-call-actions">
          <Button type="button" onClick={onAnswer} disabled={busy}>
            Answer
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={onSnooze}>
            Snooze {snoozeMinutes}m
          </Button>
          <Button type="button" variant="ghost" onClick={onDecline} disabled={busy}>
            Decline
          </Button>
        </div>
      </div>
    </aside>
  );
}
