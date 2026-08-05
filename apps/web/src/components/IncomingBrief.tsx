import { Button, Badge } from "../components/primitives";
import { isDemoSession, type JoinSession } from "../lib/types";

export function IncomingBrief({
  session,
  onJoin,
  onTextReply,
  onDecline,
  onSnooze,
  snoozeMinutes = 3,
  loading,
  snoozedUntil,
}: {
  session: JoinSession;
  onJoin: () => void;
  onTextReply: () => void;
  onDecline: () => void;
  onSnooze?: () => void;
  snoozeMinutes?: number;
  loading?: boolean;
  snoozedUntil?: string;
}) {
  const isUrgent = session.urgency === "incident" || session.urgency === "high";
  const isDemo = isDemoSession(session);
  const isSnoozed = session.status === "snoozed";
  const consequence = session.brief.consequenceOfDelay ?? session.brief.consequence_of_delay;
  const privacy = typeof session.privacy === "string"
    ? session.privacy
    : session.privacy?.notice ?? (session.privacy?.recording === false ? "Not recorded" : session.privacy?.retention);

  return (
    <article className={`incoming-card${isUrgent ? " is-urgent" : ""}`} aria-labelledby="incoming-reason">
      <div className="incoming-meta">
        <Badge variant={isUrgent ? "urgent" : "default"}>{session.type}</Badge>
        {isDemo && <Badge variant="success">Sandbox</Badge>}
        {isSnoozed && <Badge variant="active">Snoozed</Badge>}
        <span className="incoming-agent">
          <strong>{session.initiator.agent_id}</strong>
          {" · "}
          {session.initiator.harness}
          {session.initiator.project ? ` · ${session.initiator.project}` : ""}
        </span>
      </div>

      <h1 id="incoming-reason" className="incoming-reason">
        {session.brief.reason}
      </h1>

      <p className="incoming-question">{session.objective}</p>

      {isSnoozed && snoozedUntil && (
        <p className="incoming-snooze-note" role="status">
          Call back scheduled for {new Date(snoozedUntil).toLocaleString()}.
        </p>
      )}

      {session.brief.recommendation && (
        <div className="incoming-recommendation">
          <div className="incoming-recommendation-label">Agent recommendation</div>
          <div>{session.brief.recommendation}</div>
        </div>
      )}

      <dl className="brief-details">
        {session.brief.options && session.brief.options.length > 0 && <div><dt>Options</dt><dd><ul>{session.brief.options.map((option) => <li key={option.id}><strong>{option.label}</strong> <span className="option-id">{option.id}</span></li>)}</ul></dd></div>}
        {session.brief.completed && session.brief.completed.length > 0 && <div><dt>Completed</dt><dd><ul>{session.brief.completed.map((item) => <li key={item}>{item}</li>)}</ul></dd></div>}
        {session.brief.context && <div><dt>Context</dt><dd>{session.brief.context}</dd></div>}
        {consequence && <div><dt>Consequence of delay</dt><dd>{consequence}</dd></div>}
        {session.urgency && <div><dt>Urgency</dt><dd>{session.urgency}</dd></div>}
        {session.expires_at && <div><dt>Expires</dt><dd><time dateTime={session.expires_at}>{new Date(session.expires_at).toLocaleString()}</time></dd></div>}
        {privacy && <div><dt>Privacy</dt><dd>{privacy}</dd></div>}
      </dl>

      <div className="incoming-actions">
        <Button
          onClick={onJoin}
          disabled={loading}
          aria-label={isDemo ? "Join test call" : "Join confer session now"}
        >
          {isDemo ? "Join test call" : "Answer"}
        </Button>
      </div>

      {!isSnoozed && onSnooze && (
        <div className="incoming-snooze-row">
          <Button type="button" variant="secondary" disabled={loading} onClick={onSnooze}>
            Snooze {snoozeMinutes}m
          </Button>
        </div>
      )}

      <div className="incoming-secondary">
        {!isDemo && (
          <Button variant="ghost" onClick={onTextReply} disabled={loading}>
            Reply by text
          </Button>
        )}
        {isDemo && (
          <Button variant="ghost" onClick={onTextReply} disabled={loading} className="incoming-text-demoted">
            Prefer text instead
          </Button>
        )}
        <Button variant="ghost" onClick={onDecline} disabled={loading}>
          Decline
        </Button>
      </div>

      <div className="incoming-quiet-meta">
        {session.estimated_duration_minutes
          ? `Estimated ${session.estimated_duration_minutes} min · `
          : ""}
        {!privacy ? "Privacy details not provided · " : ""}
        Session {session.id.slice(0, 12)}…
      </div>
    </article>
  );
}
