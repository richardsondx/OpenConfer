import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { DecisionTray } from "../components/DecisionTray";
import { IncomingBrief } from "../components/IncomingBrief";
import { HumanSessionShell } from "../components/layouts";
import { Badge, Button } from "../components/primitives";
import { SessionRecap } from "../components/SessionRecap";
import type { UnderstoodDecision } from "../lib/decision-signal";
import { sessionOutcome } from "../lib/session-outcome";
import type { RoomCredentials } from "../components/VoiceSession";
import { DEFAULT_ALERT_PREFS, normalizeAlertPrefs } from "../lib/alert-prefs";
import { shouldRingSession, startIncomingRing, type RingHandle } from "../lib/incoming-ring";
import {
  fetchSettings,
  snoozeSession,
} from "../lib/settings";
import {
  isDemoSession,
  isTerminalStatus,
  type JoinSession,
  STATUS_LABELS,
} from "../lib/types";

/** Prefer server flag; demos never deliver so treat missing flag as no callback for demo initiators. */
export function sessionHasCallback(session: JoinSession): boolean {
  if (typeof session.has_callback === "boolean") return session.has_callback;
  return !isDemoSession(session);
}

type Mode = "incoming" | "joining" | "live" | "text" | "done";
const VoiceSession = lazy(() => import("../components/VoiceSession").then((module) => ({ default: module.VoiceSession })));
type JoinResponse = {
  session: JoinSession;
  acknowledged?: boolean;
  connection?: Record<string, unknown>;
  room?: Record<string, unknown>;
  room_url?: string;
  room_token?: string;
  url?: string;
  token?: string;
};

function apiPath(id: string, suffix = "") {
  return `/v1/join/${encodeURIComponent(id)}${suffix}`;
}

function credentialsFrom(data: JoinResponse): RoomCredentials | undefined {
  const source = (data.connection ?? data.room ?? data) as Record<string, unknown>;
  const url = source.url ?? source.room_url ?? source.roomUrl;
  const token = source.token ?? source.room_token ?? source.roomToken;
  return typeof url === "string" && /^wss?:\/\//.test(url) && typeof token === "string" && token
    ? { url, token }
    : undefined;
}

/** Map persisted session status to UI mode after load/reload. */
export function resolveModeAfterLoad(status: string): Mode {
  if (isTerminalStatus(status) || ["confirming", "completed", "result_delivered"].includes(status)) {
    return "done";
  }
  // Reload during joining/active/snoozed returns to the brief so the operator can rejoin;
  // leave-view (not end-session) intentionally does the same.
  return "incoming";
}

export function shouldPollOutcome(
  status: string,
  acknowledged: boolean,
  hasCallback = true,
): boolean {
  if (!hasCallback) return false;
  return !acknowledged && ["confirming", "completed", "result_delivered"].includes(status);
}

export function isBriefStale(expiresAt?: string, now = Date.now()): boolean {
  if (!expiresAt) return false;
  const expires = Date.parse(expiresAt);
  return Number.isFinite(expires) && expires <= now;
}

export function isBriefNearingExpiry(expiresAt?: string, now = Date.now(), windowMs = 5 * 60_000): boolean {
  if (!expiresAt) return false;
  const expires = Date.parse(expiresAt);
  return Number.isFinite(expires) && expires > now && expires - now <= windowMs;
}

/** Copy for the End session dialog based on save/preview state. */
export function endSessionDialogCopy(options: {
  submitIssue: boolean;
  hasUnderstoodPreview: boolean;
}): { body: string; confirmLabel: string } {
  if (options.submitIssue) {
    return {
      body:
        "The spoken decision may not have been saved. Prefer recording it with the text form before ending — ending cancels the session with no answer returned.",
      confirmLabel: "End without answer",
    };
  }
  if (options.hasUnderstoodPreview) {
    return {
      body:
        "The agent's on-screen understanding is only a preview — nothing has been saved yet. Ending cancels the session with no answer returned to the requesting agent.",
      confirmLabel: "End without answer",
    };
  }
  return {
    body:
      "Ending cancels the session for the requesting agent and deletes the voice room. Leave view only disconnects your browser without cancelling.",
    confirmLabel: "End session",
  };
}

export function outcomeCopy(
  status: string,
  acknowledged = false,
  harness?: string,
  hasCallback = true,
) {
  if (acknowledged || status === "result_acknowledged") {
    return { title: "Decision returned. Work resumed.", body: "The originating agent acknowledged the result and continued." };
  }
  if (status === "result_delivered") {
    return { title: "Decision delivered.", body: "The result reached the originating agent, but it has not acknowledged resuming yet." };
  }
  if (status === "completed" && !hasCallback) {
    return {
      title: "Sandbox decision recorded.",
      body: "No agent was waiting — this was a local test call. Connect a harness when you want real work to pause for your answer.",
    };
  }
  if (status === "completed") {
    return { title: "Decision confirmed.", body: "Your decision is recorded. Delivery to the originating agent is still pending." };
  }
  if (status === "confirming") {
    return { title: "Decision submitted.", body: "The server is still confirming your decision. Delivery has not been reported yet." };
  }
  const requester = harness ? `${harness} harness` : "requester";
  const terminal: Record<string, { title: string; body: string }> = {
    cancelled: {
      title: "Cancelled by the requesting agent",
      body: `The ${requester} cancelled this session. No response can be submitted.`,
    },
    expired: {
      title: "Session expired",
      body: "This join link is stale and no longer accepts a response.",
    },
    declined: {
      title: "Session declined",
      body: "This session was declined and is now closed.",
    },
    failed: {
      title: "Session failed",
      body: "The session could not continue. You can refresh to check for an updated state.",
    },
    policy_blocked: {
      title: "Session blocked",
      body: "Policy prevented this session from continuing.",
    },
  };
  return terminal[status] ?? { title: "Session closed", body: `This session is ${status.replaceAll("_", " ")}.` };
}

export function JoinPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const autoJoin = searchParams.get("autojoin") === "1";
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? searchParams.get("token") ?? "";
  const navigate = useNavigate();
  const [session, setSession] = useState<JoinSession | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [mode, setMode] = useState<Mode>("incoming");
  const [credentials, setCredentials] = useState<RoomCredentials>();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [declining, setDeclining] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const [showTextEscape, setShowTextEscape] = useState(false);
  const [submitIssue, setSubmitIssue] = useState<string | null>(null);
  const [understood, setUnderstood] = useState<UnderstoodDecision | null>(null);
  const [snoozeMinutes, setSnoozeMinutes] = useState(DEFAULT_ALERT_PREFS.snooze_minutes);
  const [alertPrefs, setAlertPrefs] = useState(DEFAULT_ALERT_PREFS);
  const [actionBusy, setActionBusy] = useState(false);
  const ringHandleRef = useRef<RingHandle | null>(null);
  const rungKeyRef = useRef<string | null>(null);
  const autoJoinAttemptedRef = useRef(false);

  const loadSession = async (signal?: AbortSignal) => {
    if (!id || !token) throw new Error("This join link is missing its session ID or token.");
    const response = await fetch(apiPath(id), { signal, headers: { "X-Join-Token": token } });
    if (!response.ok) {
      throw new Error(response.status === 404 ? "This join link is invalid or no longer available." : "Could not load the session.");
    }
    const data = await response.json() as JoinResponse;
    setSession(data.session);
    setAcknowledged(Boolean(data.acknowledged));
    setMode((current) => {
      const next = resolveModeAfterLoad(data.session.status);
      // Keep live/text/joining local modes unless the server moved to a closed state.
      if (next === "done") return "done";
      if (current === "live" || current === "text" || current === "joining") return current;
      return next;
    });
    setError(null);
    return data;
  };

  const refreshOutcome = async () => {
    setRefreshing(true);
    setRefreshNote(null);
    setError(null);
    try {
      await loadSession();
      setRefreshNote("Up to date");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not refresh.");
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    loadSession(controller.signal).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load the session.");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [id, token]);

  useEffect(() => {
    const apiToken = sessionStorage.getItem("oc_token") ?? localStorage.getItem("oc_token");
    if (!apiToken) return;
    fetchSettings(apiToken)
      .then((view) => {
        const prefs = normalizeAlertPrefs(view.operator?.alerts);
        setAlertPrefs(prefs);
        setSnoozeMinutes(prefs.snooze_minutes);
      })
      .catch(() => undefined);
  }, []);

  // Soft ring on the join brief when the session is awaiting the operator.
  useEffect(() => {
    if (mode !== "incoming" || !session || !shouldRingSession(session)) {
      ringHandleRef.current?.stop();
      ringHandleRef.current = null;
      return;
    }
    const key = `${session.id}:${session.operator_seen_at ?? ""}:${session.status}`;
    if (rungKeyRef.current === key) return;
    rungKeyRef.current = key;
    ringHandleRef.current?.stop();
    ringHandleRef.current = startIncomingRing({
      reason: session.brief.reason,
      urgency: session.urgency,
      prefs: alertPrefs,
    });
    return () => {
      ringHandleRef.current?.stop();
      ringHandleRef.current = null;
    };
  }, [mode, session, alertPrefs]);

  const stopJoinRing = () => {
    ringHandleRef.current?.stop();
    ringHandleRef.current = null;
  };

  useEffect(() => {
    if (
      mode !== "done" ||
      !id ||
      !token ||
      !session ||
      !shouldPollOutcome(session.status, acknowledged, sessionHasCallback(session))
    ) {
      return;
    }
    const interval = window.setInterval(() => {
      loadSession().catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(interval);
  }, [mode, id, token, acknowledged, session?.status, session?.has_callback]);

  // Voice-first: when the speaking agent submits the decision, leave the call UI.
  useEffect(() => {
    if (mode !== "live" || !id || !token) return;
    const interval = window.setInterval(() => {
      loadSession()
        .then((data) => {
          if (
            isTerminalStatus(data.session.status) ||
            ["confirming", "completed", "result_delivered"].includes(data.session.status)
          ) {
            setCredentials(undefined);
            setMode("done");
          }
        })
        .catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(interval);
  }, [mode, id, token]);

  const handleSnooze = async () => {
    if (!id || !token) return;
    setActionBusy(true);
    setError(null);
    try {
      stopJoinRing();
      await snoozeSession({ joinToken: token }, id, snoozeMinutes);
      await loadSession();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not snooze this call.");
    } finally {
      setActionBusy(false);
    }
  };

  const handleJoin = async () => {
    if (!id || !token) return;
    stopJoinRing();
    setMode("joining");
    setError(null);
    try {
      const response = await fetch(apiPath(id, "/connect"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await response.json().catch(() => ({})) as JoinResponse & {
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        const detail =
          (typeof data.message === "string" && data.message) ||
          (typeof data.error === "string" && data.error) ||
          "";
        const livekitAuth =
          /invalid api key|unauthorized/i.test(detail) || response.status === 401;
        throw new Error(
          livekitAuth
            ? "LiveKit rejected the API key. For local openconfer serve, use the built-in room credentials (Settings → Voice → restore local defaults), then try Join again."
            : detail ||
                (response.status === 409
                  ? "The session changed before you joined. Refresh its state and try again."
                  : "Could not join the session. Check Settings → Voice and restart openconfer serve."),
        );
      }
      const room = credentialsFrom(data);
      setSession(data.session);
      setCredentials(room);
      if (!room) {
        setError(
          "Joined, but no LiveKit room credentials came back. Check Settings → Voice — LiveKit must be running with openconfer serve.",
        );
      }
      setMode(isTerminalStatus(data.session.status) ? "done" : "live");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not join the session.");
      setMode("incoming");
    }
  };

  // Answering from the inbox should enter the call directly. Direct join links
  // still show the brief first, and the ref prevents StrictMode from connecting twice.
  useEffect(() => {
    if (!autoJoin || !session || mode !== "incoming" || autoJoinAttemptedRef.current) return;
    if (isTerminalStatus(session.status)) return;
    autoJoinAttemptedRef.current = true;
    void handleJoin();
  }, [autoJoin, session, mode]);

  const openTextFallback = (reason?: string) => {
    setShowTextEscape(true);
    setSubmitIssue(
      reason?.trim() ||
        "Something went wrong saving the spoken decision. Record it with the text form below so the answer is not lost.",
    );
  };

  const handleDecisionSignal = (
    signal:
      | { kind: "preview"; result: Record<string, unknown>; summary?: string }
      | { kind: "ok"; result?: Record<string, unknown>; summary?: string }
      | { kind: "failed"; error?: string },
  ) => {
    if (signal.kind === "preview") {
      setUnderstood({ result: signal.result, summary: signal.summary });
      setSubmitIssue(null);
      return;
    }
    if (signal.kind === "ok") {
      setSubmitIssue(null);
      setUnderstood(null);
      return;
    }
    openTextFallback(
      signal.error
        ? `Could not save the spoken decision (${signal.error}). Record it with the text form below.`
        : undefined,
    );
  };

  const handleConfirm = async (result: Record<string, unknown>, summary: string) => {
    if (!id) return;
    setConfirming(true);
    setError(null);
    try {
      const response = await fetch(`/v1/sessions/${encodeURIComponent(id)}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Join-Token": token },
        body: JSON.stringify({ result, summary, method: mode === "text" ? "text_form" : "session_ui" }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? "Confirmation failed. Refresh the session state and try again.");
      }
      setSubmitIssue(null);
      setCredentials(undefined);
      await loadSession();
      setMode("done");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Confirmation failed.");
    } finally {
      setConfirming(false);
    }
  };

  const handleVoiceConnected = async () => {
    if (!id || !token || !session || session.status === "active") return;
    const response = await fetch(apiPath(id, "/active"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (response.ok) {
      const data = await response.json() as JoinResponse;
      setSession(data.session);
    }
  };

  /** Leave the voice UI without cancelling the session or deleting the room. */
  const handleLeaveView = () => {
    setCredentials(undefined);
    setUnderstood(null);
    setConfirmEnd(false);
    setMode("incoming");
  };

  const handleEndSession = async () => {
    if (!id) return;
    setEnding(true);
    setError(null);
    try {
      const response = await fetch(`/v1/sessions/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Join-Token": token },
        body: "{}",
      });
      if (!response.ok) throw new Error("Could not end this session. Refresh its state and try again.");
      setCredentials(undefined);
      setUnderstood(null);
      await loadSession();
      setMode("done");
      setConfirmEnd(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not end this session.");
    } finally {
      setEnding(false);
    }
  };

  const handleDecline = async () => {
    if (!id) return;
    setDeclining(true);
    setError(null);
    try {
      const response = await fetch(`/v1/sessions/${encodeURIComponent(id)}/decline`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Join-Token": token },
        body: JSON.stringify({ reason: declineReason.trim() || undefined }),
      });
      if (!response.ok) throw new Error("Could not decline this session. Refresh its state and try again.");
      setCredentials(undefined);
      await loadSession();
      setDeclineOpen(false);
      setMode("done");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not decline this session.");
    } finally {
      setDeclining(false);
    }
  };

  if (loading && !session) {
    return (
      <HumanSessionShell>
        <div className="skeleton" aria-label="Loading session" style={{ height: 320, borderRadius: "var(--oc-radius-lg)" }} />
      </HumanSessionShell>
    );
  }

  if (!session) {
    return (
      <HumanSessionShell>
        <Recovery
          error={error ?? "Session unavailable."}
          onRetry={() => {
            setLoading(true);
            loadSession().finally(() => setLoading(false)).catch(() => undefined);
          }}
        />
      </HumanSessionShell>
    );
  }

  if (mode === "done") {
    const hasCallback = sessionHasCallback(session);
    const copy = outcomeCopy(session.status, acknowledged, session.initiator.harness, hasCallback);
    const showRefresh = shouldPollOutcome(session.status, acknowledged, hasCallback);
    const outcome = sessionOutcome(session);
    return (
      <HumanSessionShell>
        <div className="post-session">
          <Badge variant={outcome.variant} live={outcome.label === "In progress"}>
            {outcome.label}
          </Badge>
          <h1>{copy.title}</h1>
          <p>{copy.body}</p>
          <SessionRecap session={session} />
          <div className="incoming-secondary">
            {hasCallback && showRefresh ? (
              <Button variant="secondary" onClick={() => void refreshOutcome()} disabled={refreshing}>
                {refreshing ? "Checking…" : "Refresh state"}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => navigate("/")}>Back to sessions</Button>
          </div>
          {refreshNote && !error && (
            <p className="muted-copy" role="status">{refreshNote}</p>
          )}
          {error && <p className="field-error" role="alert">{error}</p>}
        </div>
      </HumanSessionShell>
    );
  }

  if (mode === "incoming" || mode === "joining") {
    return (
      <HumanSessionShell>
        {error && (
          <Recovery
            error={error}
            onRetry={() => loadSession().catch((reason: Error) => setError(reason.message))}
            compact
          />
        )}
        {(isBriefStale(session.expires_at) || isBriefNearingExpiry(session.expires_at)) && (
          <div className="alert alert-warning" role="status">
            {isBriefStale(session.expires_at)
              ? "This brief has expired. Refresh to confirm whether the session is still open."
              : "This brief is nearing expiry. Join soon or the session may close."}
          </div>
        )}
        <IncomingBrief
          session={session}
          onJoin={handleJoin}
          onTextReply={() => {
            if (mode === "incoming") {
              stopJoinRing();
              setError(null);
              setMode("text");
            }
          }}
          onDecline={() => setDeclineOpen(true)}
          onSnooze={() => void handleSnooze()}
          snoozeMinutes={snoozeMinutes}
          snoozedUntil={session.snooze_until}
          loading={mode === "joining" || actionBusy}
        />
        {declineOpen && (
          <DeclineDialog
            reason={declineReason}
            onReasonChange={setDeclineReason}
            onCancel={() => setDeclineOpen(false)}
            onConfirm={handleDecline}
            busy={declining}
          />
        )}
      </HumanSessionShell>
    );
  }

  return (
    <HumanSessionShell
      endAction={
        <div className="human-shell-actions">
          <Button variant="ghost" onClick={handleLeaveView}>Leave view</Button>
          <Button variant="danger" onClick={() => setConfirmEnd(true)}>End session</Button>
        </div>
      }
    >
      <div className="live-header">
        <div>
          <Badge variant="active" live>
            {STATUS_LABELS[session.status] ?? session.status}
          </Badge>
          <span className="session-byline">{session.initiator.agent_id} · {session.type}</span>
        </div>
      </div>
      {mode === "live" && (
        <>
          <Suspense fallback={<div className="voice-stage" role="status">Connecting the call…</div>}>
            <VoiceSession
              credentials={credentials}
              onConnected={handleVoiceConnected}
              onDecisionSignal={handleDecisionSignal}
              objective={session.objective}
              understood={understood}
              sessionType={session.type}
              options={session.brief.options}
            />
          </Suspense>
          <p className="voice-wait-copy" role="status">
            No form needed — talk it through. When you decide, the agent records it and returns the answer.
          </p>
          {submitIssue && (
            <div className="alert alert-danger voice-submit-issue" role="alert">
              <div>
                <strong>Decision not saved</strong>
                <p>{submitIssue}</p>
              </div>
              {!showTextEscape && (
                <Button variant="secondary" onClick={() => setShowTextEscape(true)}>
                  Open text form
                </Button>
              )}
            </div>
          )}
          {error && (
            <Recovery
              error={error}
              onRetry={() => loadSession().catch((reason: Error) => setError(reason.message))}
              compact
            />
          )}
          {!showTextEscape ? (
            <div className="voice-escape">
              <Button variant="ghost" onClick={() => setShowTextEscape(true)}>
                Can&apos;t talk? Use text form
              </Button>
              <Button variant="ghost" onClick={() => openTextFallback()}>
                Something wrong?
              </Button>
            </div>
          ) : (
            <DecisionTray
              schema={session.result_schema}
              initialResult={session.result}
              onConfirm={handleConfirm}
              confirming={confirming}
              mode="text"
            />
          )}
        </>
      )}
      {mode === "text" && (
        <>
          <div className="alert alert-info" role="status">
            Text response mode. No voice connection has been started.
          </div>
          {error && (
            <Recovery
              error={error}
              onRetry={() => loadSession().catch((reason: Error) => setError(reason.message))}
              compact
            />
          )}
          <DecisionTray
            schema={session.result_schema}
            initialResult={session.result}
            onConfirm={handleConfirm}
            confirming={confirming}
            mode="text"
          />
        </>
      )}
      {confirmEnd && (
        <EndSessionDialog
          busy={ending}
          submitIssue={Boolean(submitIssue)}
          hasUnderstoodPreview={Boolean(understood) && !submitIssue}
          onCancel={() => setConfirmEnd(false)}
          onUseTextForm={() => {
            setConfirmEnd(false);
            openTextFallback();
          }}
          onConfirm={handleEndSession}
        />
      )}
    </HumanSessionShell>
  );
}

function Recovery({ error, onRetry, compact = false }: { error: string; onRetry: () => void; compact?: boolean }) {
  return (
    <div className={`alert alert-warning recovery ${compact ? "recovery-compact" : ""}`} role="alert">
      <span>{error}</span>
      <Button variant="secondary" onClick={onRetry}>Refresh state</Button>
    </div>
  );
}

function DeclineDialog({
  reason,
  onReasonChange,
  onCancel,
  onConfirm,
  busy,
}: {
  reason: string;
  onReasonChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  return (
    <div className="session-dialog-backdrop" role="presentation">
      <div className="session-dialog" role="dialog" aria-labelledby="decline-title">
        <h2 id="decline-title">Decline this session?</h2>
        <p>The requesting agent will be told the session was declined. The voice room will be closed.</p>
        <label className="field-label" htmlFor="decline-reason">Reason (optional)</label>
        <textarea
          id="decline-reason"
          className="field-textarea"
          value={reason}
          onChange={(event) => onReasonChange(event.target.value)}
          placeholder="Why this session is being declined"
        />
        <div className="confirm-bar">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Keep session</Button>
          <Button onClick={onConfirm} disabled={busy}>{busy ? "Declining…" : "Decline session"}</Button>
        </div>
      </div>
    </div>
  );
}

function EndSessionDialog({
  busy,
  submitIssue,
  hasUnderstoodPreview,
  onCancel,
  onUseTextForm,
  onConfirm,
}: {
  busy: boolean;
  submitIssue: boolean;
  hasUnderstoodPreview: boolean;
  onCancel: () => void;
  onUseTextForm: () => void;
  onConfirm: () => void;
}) {
  const copy = endSessionDialogCopy({ submitIssue, hasUnderstoodPreview });
  return (
    <div className="session-dialog-backdrop" role="presentation">
      <div className="session-dialog" role="dialog" aria-labelledby="end-session-title">
        <h2 id="end-session-title">End this session?</h2>
        <p>{copy.body}</p>
        <div className="confirm-bar">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Keep session</Button>
          {submitIssue && (
            <Button variant="secondary" onClick={onUseTextForm} disabled={busy}>
              Record with text form
            </Button>
          )}
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            {busy ? "Ending…" : copy.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
