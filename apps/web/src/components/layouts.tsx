import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ContinuityMark } from "./primitives";

export function HumanSessionShell({
  children,
  endAction,
}: {
  children: ReactNode;
  endAction?: ReactNode;
}) {
  return (
    <div className="human-shell">
      <header className="human-shell-header">
        <Link to="/" className="human-shell-brand">
          <ContinuityMark className="continuity-mark" />
          OpenConfer
        </Link>
        {endAction}
      </header>
      <main className="human-shell-main">{children}</main>
    </div>
  );
}

export function OperatorInboxShell({
  children,
  actions,
}: {
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="inbox-shell">
      <header className="inbox-header">
        <div className="inbox-header-row">
          <div className="inbox-header-brand">
            <ContinuityMark className="continuity-mark" />
            <h1>OpenConfer</h1>
          </div>
          {actions ? <div className="inbox-header-actions">{actions}</div> : null}
        </div>
      </header>
      {children}
    </div>
  );
}
