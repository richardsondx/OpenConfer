import { sessionOutcome } from "../lib/session-outcome";
import type { JoinSession } from "../lib/types";

export function SessionRecap({ session }: { session: JoinSession }) {
  const reason = session.brief.reason?.trim();
  const showReason = Boolean(reason && reason !== session.objective.trim());
  const completed = session.brief.completed ?? [];
  const options = session.brief.options ?? [];
  const recommendation = session.brief.recommendation?.trim();
  const context = session.brief.context?.trim();
  const outcome = sessionOutcome(session);
  const detail = outcome.detail;

  return (
    <section className="session-recap" aria-label="Session recap">
      <h2 className="session-recap-objective">{session.objective}</h2>
      {showReason && <p className="session-recap-reason">{reason}</p>}

      {detail && (
        <div
          className={`session-recap-outcome session-recap-outcome--${outcome.tone}`}
          role="status"
          aria-label={`Outcome: ${detail}`}
        >
          <div className="session-recap-label">Outcome</div>
          <p className="session-recap-outcome-value">{detail}</p>
        </div>
      )}

      <dl className="brief-details session-recap-details">
        {options.length > 0 && (
          <div>
            <dt>Options</dt>
            <dd>
              <ul>
                {options.map((option) => (
                  <li key={option.id}>
                    <strong>{option.label}</strong>{" "}
                    <span className="option-id">{option.id}</span>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        {completed.length > 0 && (
          <div>
            <dt>Completed</dt>
            <dd>
              <ul>
                {completed.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        {recommendation && (
          <div>
            <dt>Recommendation</dt>
            <dd>{recommendation}</dd>
          </div>
        )}
        {context && (
          <div>
            <dt>Context</dt>
            <dd>{context}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}
