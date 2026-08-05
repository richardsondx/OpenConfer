import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { OperatorInboxShell } from "../components/layouts";
import { Badge, Button } from "../components/primitives";
import { SettingsModal } from "../components/SettingsModal";
import { GetStarted } from "../components/GetStarted";
import { IncomingCallBanner } from "../components/IncomingCallBanner";
import type { ApiSession } from "../lib/types";
import { isDemoSession, isTerminalStatus } from "../lib/types";
import { sessionOutcome } from "../lib/session-outcome";
import { DEFAULT_ALERT_PREFS, normalizeAlertPrefs } from "../lib/alert-prefs";
import { shouldRingSession, startIncomingRing, type RingHandle } from "../lib/incoming-ring";
import {
  cancelSession,
  createDemoSession,
  declineSession,
  fetchPhoneDelivery,
  fetchSettings,
  joinPathFromUrl,
  readAgentConnected,
  snoozeSession,
  writeAgentConnected,
  type SettingsView,
  type DemoUseCase,
  type PhoneDelivery,
} from "../lib/settings";
import { TestCallPicker } from "../components/TestCallPicker";
import { LandingHero } from "../components/LandingHero";

type SettingsSection = "connect" | "access" | "alerts" | "preferences" | "voice" | "status" | "advanced";

type InstallMethod = "npm" | "source";

const installCommands: Record<InstallMethod, { command: string; hint: string }> = {
  npm: {
    command: "npm install --global @openconfer/cli",
    hint: "For published releases.",
  },
  source: {
    command: "pnpm setup",
    hint: "Recommended from a source checkout.",
  },
};

function CopyCommand({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="quickstart-command">
      <code>
        <span aria-hidden="true">$</span> {command}
      </code>
      <button type="button" onClick={() => void copy()} aria-label={`Copy ${label}`}>
        {copied ? (
          <span className="quickstart-copy-label">Copied</span>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="8" y="8" width="11" height="11" rx="2" />
            <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
          </svg>
        )}
      </button>
    </div>
  );
}

function PhoneModeStatus({
  enabled,
  ready,
  onClick,
}: {
  enabled: boolean;
  ready: boolean;
  onClick: () => void;
}) {
  const label = enabled
    ? ready
      ? "Phone calls enabled"
      : "Phone calls need setup"
    : "Phone calls disabled";
  return (
    <button
      type="button"
      className={`phone-mode-status${enabled && ready ? " is-enabled" : ""}`}
      aria-label={label}
      title={`${label}. Open how you're reached settings.`}
      onClick={onClick}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7.2 3.5 4.8 5.9c-.8.8-.9 2-.4 3 2.3 4.8 6 8.5 10.8 10.8 1 .5 2.2.3 3-.4l2.3-2.3-4.1-4.1-2.2 1.6c-.4.3-.9.3-1.3 0a15.4 15.4 0 0 1-3.5-3.5c-.3-.4-.3-.9 0-1.3L11 7.6 7.2 3.5Z" />
      </svg>
      <span>Phone</span>
    </button>
  );
}

function normalizedPhoneStatus(delivery: PhoneDelivery): string {
  if (delivery.status === "failed") return "failed";
  if (delivery.error && !delivery.provider_status) return "failed";
  return delivery.provider_status ?? "queued";
}

function isFinalPhoneStatus(status: string): boolean {
  return ["completed", "busy", "failed", "no-answer", "canceled"].includes(status);
}

function PhoneCallFeedback({
  delivery,
  destination,
  onRetry,
  onCancel,
  onOpenSettings,
  onDismiss,
}: {
  delivery: PhoneDelivery & { sessionId?: string };
  destination?: string;
  onRetry: () => void;
  onCancel: () => void;
  onOpenSettings: () => void;
  onDismiss: () => void;
}) {
  const status = normalizedPhoneStatus(delivery);
  const failed = ["busy", "failed", "no-answer", "canceled"].includes(status);
  const showSettings = status === "failed";
  const canCancel = Boolean(delivery.sessionId) && !isFinalPhoneStatus(status);
  const destinationHint = destination ? ` ending in ${destination.slice(-4)}` : "";
  const copy = status === "starting"
    ? { title: "Starting your test call", detail: "Connecting to Twilio…" }
    : status === "queued"
      ? { title: "Call requested", detail: `Waiting for your phone${destinationHint} to ring…` }
      : status === "ringing"
        ? { title: "Your phone is ringing", detail: "Answer it to join the test call." }
        : status === "in-progress"
          ? { title: "Call connected", detail: "You can continue the conversation on your phone." }
          : status === "completed"
            ? {
                title: "Test call ended",
                detail: delivery.session_ended
                  ? "The call ended before a decision was recorded, so the session ended automatically."
                  : "Twilio reports that the call connected and ended.",
              }
            : status === "busy"
              ? { title: "Your phone was busy", detail: "The session ended automatically. Try again when the line is free." }
              : status === "no-answer"
                ? { title: "No answer", detail: "The session ended automatically. Check the number and try again." }
                : status === "canceled"
                  ? { title: "Call canceled", detail: "Twilio canceled the call and the session ended automatically." }
                  : {
                      title: "Call failed",
                      detail: delivery.error
                        ? `${delivery.error} The session ended automatically.`
                        : "Twilio could not place the call. The session ended automatically.",
                    };

  return (
    <section
      className={`phone-call-feedback is-${failed ? "failed" : status}`}
      role={failed ? "alert" : "status"}
      aria-live="polite"
    >
      <div className="phone-call-feedback-signal" aria-hidden="true">
        <span className="phone-call-feedback-ring" />
        <svg viewBox="0 0 24 24">
          <path d="M7.2 3.5 4.8 5.9c-.8.8-.9 2-.4 3 2.3 4.8 6 8.5 10.8 10.8 1 .5 2.2.3 3-.4l2.3-2.3-4.1-4.1-2.2 1.6c-.4.3-.9.3-1.3 0a15.4 15.4 0 0 1-3.5-3.5c-.3-.4-.3-.9 0-1.3L11 7.6 7.2 3.5Z" />
        </svg>
      </div>
      <div className="phone-call-feedback-copy">
        <strong>{copy.title}</strong>
        <span>{copy.detail}</span>
      </div>
      <div className="phone-call-feedback-actions">
        {canCancel && <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>}
        {failed && <Button type="button" onClick={onRetry}>Try again</Button>}
        {showSettings && <Button type="button" variant="secondary" onClick={onOpenSettings}>Check phone settings</Button>}
        <Button type="button" variant="ghost" onClick={onDismiss} aria-label="Dismiss call status">Dismiss</Button>
      </div>
    </section>
  );
}

function OperatorQuickstart({
  tokenInput,
  onTokenChange,
  onSubmit,
  error,
}: {
  tokenInput: string;
  onTokenChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  error: string | null;
}) {
  const [installMethod, setInstallMethod] = useState<InstallMethod>("source");
  const install = installCommands[installMethod];

  return (
    <form id="get-started" className="inbox-auth" onSubmit={onSubmit}>
      <div className="inbox-auth-heading">
        <span className="inbox-auth-kicker">CLI QUICKSTART</span>
        <h2>Open your operator inbox</h2>
        <p>Install OpenConfer, start it locally, then unlock this inbox with the key printed in your terminal.</p>
      </div>

      <ol className="quickstart-steps">
        <li className="quickstart-step">
          <div className="quickstart-step-number" aria-hidden="true">01</div>
          <div className="quickstart-step-body">
            <div className="quickstart-step-title">
              <strong>Install the CLI</strong>
              <span>{install.hint}</span>
            </div>
            <div className="quickstart-terminal">
              <div className="quickstart-tabs" role="tablist" aria-label="CLI install method">
                <button
                  type="button"
                  role="tab"
                  aria-selected={installMethod === "source"}
                  onClick={() => setInstallMethod("source")}
                >
                  From source
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={installMethod === "npm"}
                  onClick={() => setInstallMethod("npm")}
                >
                  npm
                </button>
              </div>
              <CopyCommand command={install.command} label={`${installMethod} install command`} />
            </div>
          </div>
        </li>

        <li className="quickstart-step">
          <div className="quickstart-step-number" aria-hidden="true">02</div>
          <div className="quickstart-step-body">
            <div className="quickstart-step-title">
              <strong>Initialize and launch</strong>
              <span>Use two terminal windows.</span>
            </div>
            <div className="quickstart-launch-grid">
              <div>
                <span className="quickstart-terminal-label">Terminal 1 · server</span>
                <CopyCommand command="openconfer init && openconfer serve" label="server command" />
              </div>
              <div>
                <span className="quickstart-terminal-label">Terminal 2 · inbox</span>
                <CopyCommand command="openconfer web" label="web app command" />
              </div>
            </div>
          </div>
        </li>

        <li className="quickstart-step quickstart-step-access">
          <div className="quickstart-step-number" aria-hidden="true">03</div>
          <div className="quickstart-step-body">
            <div className="quickstart-step-title">
              <strong>Paste your access key</strong>
              <span>Missed it? Run <code className="inline-code">openconfer token</code>.</span>
            </div>
            <label className="field-label" htmlFor="operator-token">
              Access key
            </label>
            <div className="inbox-auth-row">
              <input
                id="operator-token"
                className="field-input"
                type="password"
                autoComplete="off"
                value={tokenInput}
                onChange={(event) => onTokenChange(event.target.value)}
                placeholder="oc_…"
                required
              />
              <Button type="submit">Open inbox <span aria-hidden="true">→</span></Button>
            </div>
            {error && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
          </div>
        </li>
      </ol>
    </form>
  );
}

export function InboxPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessions, setSessions] = useState<ApiSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(
    () => sessionStorage.getItem("oc_token") ?? localStorage.getItem("oc_token") ?? "",
  );
  const [tokenInput, setTokenInput] = useState("");
  const [needsToken, setNeedsToken] = useState(!token);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("status");
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [agentConnected, setAgentConnected] = useState(() => readAgentConnected());
  const [testCallBusy, setTestCallBusy] = useState(false);
  const [phoneCallFeedback, setPhoneCallFeedback] = useState<(PhoneDelivery & { sessionId?: string }) | null>(null);
  const [lastTestUseCase, setLastTestUseCase] = useState<DemoUseCase>("decision");
  const [endingId, setEndingId] = useState<string | null>(null);
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);
  const [endingOpen, setEndingOpen] = useState(false);
  const [ringingSessionId, setRingingSessionId] = useState<string | null>(null);
  const [callBusy, setCallBusy] = useState(false);
  const ringHandleRef = useRef<RingHandle | null>(null);
  const rungKeysRef = useRef(new Set<string>());

  const alertPrefs = useMemo(
    () => normalizeAlertPrefs(settings?.operator?.alerts ?? DEFAULT_ALERT_PREFS),
    [settings?.operator?.alerts],
  );
  const phonePrimary = settings?.routes.default.notify.includes("twilio") === true;

  const stopRing = useCallback(() => {
    ringHandleRef.current?.stop();
    ringHandleRef.current = null;
    setRingingSessionId(null);
  }, []);

  const loadSessions = useCallback((opts?: { quiet?: boolean }) => {
    if (!token) {
      setLoading(false);
      setNeedsToken(true);
      return;
    }
    if (!opts?.quiet) setLoading(true);
    fetch("/v1/sessions", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => {
        if (r.status === 401) {
          setNeedsToken(true);
          throw new Error("That access key was not accepted. Paste the key from openconfer init / openconfer token.");
        }
        if (!r.ok) throw new Error("Could not reach the OpenConfer server. Is openconfer serve running?");
        return r.json();
      })
      .then((data) => {
        setSessions(data.sessions ?? []);
        setNeedsToken(false);
        setError(null);
      })
      .catch((e: Error) => {
        if (!opts?.quiet) setError(e.message);
      })
      .finally(() => {
        if (!opts?.quiet) setLoading(false);
      });
  }, [token]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // Poll for new Waiting sessions while authenticated.
  useEffect(() => {
    if (!token || needsToken) return;
    const id = window.setInterval(() => loadSessions({ quiet: true }), 8_000);
    return () => window.clearInterval(id);
  }, [token, needsToken, loadSessions]);

  // In browser mode, start a local ring when a Waiting session appears. Phone-primary requests
  // are handled by Twilio and remain copyable in the list without offering a browser Answer path.
  useEffect(() => {
    if (!settings || phonePrimary) {
      if (ringingSessionId) stopRing();
      return;
    }
    const candidate = sessions.find((s) => shouldRingSession(s));
    if (!candidate) {
      if (ringingSessionId) stopRing();
      return;
    }
    const ringKey = `${candidate.id}:${candidate.updated_at ?? candidate.created_at ?? ""}`;
    if (rungKeysRef.current.has(ringKey)) {
      return;
    }
    rungKeysRef.current.add(ringKey);
    ringHandleRef.current?.stop();
    ringHandleRef.current = startIncomingRing({
      reason: candidate.brief?.reason ?? candidate.objective,
      urgency: candidate.urgency,
      prefs: alertPrefs,
      onComplete: () => {
        ringHandleRef.current = null;
        setRingingSessionId(null);
      },
    });
    setRingingSessionId(candidate.id);
  }, [sessions, settings, phonePrimary, alertPrefs, ringingSessionId, stopRing]);

  useEffect(() => () => {
    ringHandleRef.current?.stop();
  }, []);

  useEffect(() => {
    const sessionId = phoneCallFeedback?.sessionId;
    if (!sessionId || isFinalPhoneStatus(normalizedPhoneStatus(phoneCallFeedback))) return;
    let cancelled = false;
    let timer: number | undefined;
    let checks = 0;
    const poll = async () => {
      try {
        const delivery = await fetchPhoneDelivery(token, sessionId);
        if (cancelled) return;
        checks += 1;
        if (checks >= 30 && !isFinalPhoneStatus(normalizedPhoneStatus(delivery))) {
          setPhoneCallFeedback({
            status: "failed",
            sessionId,
            error: "Twilio has not confirmed the call. Check the saved number and try again.",
          });
          return;
        }
        setPhoneCallFeedback({ ...delivery, sessionId });
        if (isFinalPhoneStatus(normalizedPhoneStatus(delivery))) {
          await loadSessions({ quiet: true });
        } else {
          timer = window.setTimeout(() => void poll(), 2_000);
        }
      } catch (e) {
        if (cancelled) return;
        setPhoneCallFeedback({
          status: "failed",
          sessionId,
          error: e instanceof Error ? e.message : "Could not check the phone call.",
        });
      }
    };
    timer = window.setTimeout(() => void poll(), 1_200);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [phoneCallFeedback?.sessionId, token, loadSessions]);

  useEffect(() => {
    if (!token || needsToken) {
      setSettings(null);
      return;
    }
    fetchSettings(token)
      .then(setSettings)
      .catch(() => setSettings(null));
  }, [token, needsToken]);

  useEffect(() => {
    if (needsToken || !token) return;
    if (searchParams.get("connect") !== "1") return;
    setSettingsSection("connect");
    setSettingsOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("connect");
    setSearchParams(next, { replace: true });
  }, [needsToken, token, searchParams, setSearchParams]);

  const submitToken = (event: FormEvent) => {
    event.preventDefault();
    const next = tokenInput.trim();
    if (!next) return;
    sessionStorage.setItem("oc_token", next);
    localStorage.removeItem("oc_token");
    setError(null);
    setToken(next);
  };

  const signOut = () => {
    sessionStorage.removeItem("oc_token");
    localStorage.removeItem("oc_token");
    setToken("");
    setTokenInput("");
    setNeedsToken(true);
    setSessions([]);
    setSettings(null);
    setSettingsOpen(false);
  };

  const openSettings = (section: SettingsSection = "status") => {
    setSettingsSection(section);
    setSettingsOpen(true);
  };

  const markAgentConnected = () => {
    writeAgentConnected(true);
    setAgentConnected(true);
    setSettingsOpen(false);
  };

  const voiceReady = settings?.status.voice_ready === true;
  const openSessions = sessions.filter((session) => !isTerminalStatus(session.status));

  const endSession = async (sessionId: string) => {
    if (!token) return;
    setEndingId(sessionId);
    setError(null);
    try {
      await cancelSession(token, sessionId);
      await loadSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not end this session.");
    } finally {
      setEndingId(null);
    }
  };

  const copyJoinLink = async (session: ApiSession) => {
    if (!session.join_url) return;
    setError(null);
    try {
      await navigator.clipboard.writeText(session.join_url);
      setCopiedLinkId(session.id);
      window.setTimeout(() => {
        setCopiedLinkId((current) => (current === session.id ? null : current));
      }, 1_600);
    } catch {
      setCopiedLinkId(null);
      setError("Could not copy the secure link. Open the session and copy it from your address bar.");
    }
  };

  const endOpenSessions = async () => {
    if (!token || openSessions.length === 0) return;
    setEndingOpen(true);
    setError(null);
    const failures: string[] = [];
    for (const session of openSessions) {
      try {
        await cancelSession(token, session.id);
      } catch {
        failures.push(session.id.slice(0, 12));
      }
    }
    await loadSessions();
    if (failures.length > 0) {
      setError(`Could not end ${failures.length} session${failures.length === 1 ? "" : "s"}.`);
    }
    setEndingOpen(false);
  };

  const startTestCall = async (useCase: DemoUseCase = "decision") => {
    if (!token) return;
    if (phonePrimary && !window.confirm("Place a test call to your configured phone now?")) return;
    if (!voiceReady) {
      openSettings("voice");
      return;
    }
    setTestCallBusy(true);
    setLastTestUseCase(useCase);
    setError(null);
    if (phonePrimary) setPhoneCallFeedback({ status: "succeeded", provider_status: "starting" });
    try {
      const session = await createDemoSession(token, useCase);
      loadSessions();
      setSettingsOpen(false);
      if (phonePrimary) {
        setPhoneCallFeedback({
          ...(session.delivery ?? {
            status: session.status === "failed" ? "failed" : "succeeded",
            ...(session.status === "failed" ? { error: "Twilio could not place the call." } : {}),
          }),
          sessionId: session.id,
        });
      } else if (session.join_url) {
        navigate(joinPathFromUrl(session.join_url));
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not start the sandbox test call.";
      if (phonePrimary) setPhoneCallFeedback({ status: "failed", error: message });
      else setError(message);
    } finally {
      setTestCallBusy(false);
    }
  };

  const cancelTestCall = async () => {
    if (!token || !phoneCallFeedback?.sessionId) return;
    const sessionId = phoneCallFeedback.sessionId;
    setPhoneCallFeedback({ ...phoneCallFeedback, provider_status: "canceled", session_ended: true });
    try {
      await cancelSession(token, sessionId);
      await loadSessions({ quiet: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not cancel the test call.");
    }
  };

  const onlyDemoSessions =
    sessions.length > 0 && sessions.every((session) => isDemoSession(session));
  const showConnectNextStep = onlyDemoSessions && !agentConnected;
  const ringingSession = sessions.find((s) => s.id === ringingSessionId && shouldRingSession(s));

  const answerRinging = () => {
    if (!ringingSession?.join_url) return;
    stopRing();
    navigate(joinPathFromUrl(ringingSession.join_url, { autoJoin: true }));
  };

  const snoozeRinging = async () => {
    if (!token || !ringingSession) return;
    setCallBusy(true);
    setError(null);
    try {
      stopRing();
      await snoozeSession({ token }, ringingSession.id, alertPrefs.snooze_minutes);
      await loadSessions({ quiet: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not snooze this call.");
    } finally {
      setCallBusy(false);
    }
  };

  const declineRinging = async () => {
    if (!token || !ringingSession) return;
    if (!window.confirm("Decline this decision request? The agent will not get an answer.")) return;
    setCallBusy(true);
    setError(null);
    try {
      stopRing();
      await declineSession({ token }, ringingSession.id, "declined from inbox");
      await loadSessions({ quiet: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not decline this session.");
    } finally {
      setCallBusy(false);
    }
  };

  return (
    <OperatorInboxShell
      actions={
        !needsToken && token ? (
          <>
            <PhoneModeStatus
              enabled={phonePrimary}
              ready={settings?.status.twilio === "ready"}
              onClick={() => openSettings("alerts")}
            />
            {sessions.length > 0 && (
              <TestCallPicker
                id="inbox-test-call-use-case"
                busy={testCallBusy}
                voiceReady={voiceReady}
                buttonVariant="secondary"
                buttonLabel="Test call"
                onStartTestCall={(useCase) => void startTestCall(useCase)}
              />
            )}
            <Button type="button" variant="secondary" onClick={() => openSettings("status")}>
              Settings
            </Button>
            <Button type="button" variant="ghost" onClick={signOut}>
              Sign out
            </Button>
          </>
        ) : undefined
      }
    >
      {needsToken && <LandingHero />}

      {loading && <div className="skeleton" style={{ height: 80 }} />}

      {needsToken && !loading && (
        <OperatorQuickstart
          tokenInput={tokenInput}
          onTokenChange={setTokenInput}
          onSubmit={submitToken}
          error={error}
        />
      )}

      {error && !needsToken && (
        <div className="alert alert-warning" role="alert">
          {error}
        </div>
      )}

      {phoneCallFeedback && !needsToken && (
        <PhoneCallFeedback
          delivery={phoneCallFeedback}
          destination={settings?.telephony.twilio.destination_number}
          onRetry={() => void startTestCall(lastTestUseCase)}
          onCancel={() => void cancelTestCall()}
          onOpenSettings={() => openSettings("alerts")}
          onDismiss={() => setPhoneCallFeedback(null)}
        />
      )}

      {!needsToken && ringingSession && (
        <IncomingCallBanner
          session={ringingSession}
          snoozeMinutes={alertPrefs.snooze_minutes}
          busy={callBusy}
          onAnswer={answerRinging}
          onSnooze={() => void snoozeRinging()}
          onDecline={() => void declineRinging()}
        />
      )}

      {!loading && !needsToken && sessions.length === 0 && !error && (
        <GetStarted
          token={token}
          settings={settings}
          onOpenSettings={openSettings}
          onSessionCreated={loadSessions}
        />
      )}

      {!needsToken && showConnectNextStep && (
        <div className="inbox-next-step">
          <div>
            <h2>Next: Connect an agent</h2>
            <p>
              Your sandbox test call worked. Wire Hermes or OpenClaw when you want real work to pause
              for your answer.
            </p>
          </div>
          <div className="inbox-next-step-actions">
            <Button type="button" onClick={() => openSettings("connect")}>
              Connect Agent
            </Button>
            <Button type="button" variant="ghost" onClick={markAgentConnected}>
              I connected the agent
            </Button>
          </div>
        </div>
      )}

      {!needsToken && sessions.length > 0 && (
        <ul className="session-list">
          {sessions.map((s) => {
            const open = !isTerminalStatus(s.status);
            const ending = endingId === s.id;
            const outcome = sessionOutcome(s);
            const metaParts = [
              isDemoSession(s) ? "sandbox" : null,
              outcome.shapeCue,
              `${s.initiator.agent_id} · ${s.initiator.harness}`,
              s.join_url ? null : "No join link",
            ].filter(Boolean);
            const body = (
              <>
                <div className="session-row-objective">{s.objective}</div>
                {outcome.detail && <div className="session-row-outcome">{outcome.detail}</div>}
                <div className="session-row-meta">{metaParts.join(" · ")}</div>
              </>
            );
            const isRinging = ringingSession?.id === s.id;
            const snoozedUntil = s.status === "snoozed" && s.snooze_until
              ? `Until ${new Date(s.snooze_until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
              : null;
            return (
              <li
                key={s.id}
                className={`session-row session-row--${outcome.tone}${isRinging ? " is-ringing" : ""}`}
              >
                {s.join_url ? (
                  <Link
                    to={joinPathFromUrl(s.join_url, { autoJoin: open })}
                    className="session-row-link"
                  >
                    {body}
                    {snoozedUntil && <div className="session-row-meta">{snoozedUntil}</div>}
                  </Link>
                ) : (
                  <div className="session-row-link">
                    {body}
                    {snoozedUntil && <div className="session-row-meta">{snoozedUntil}</div>}
                  </div>
                )}
                <div className="session-row-aside">
                  <Badge variant={outcome.variant} live={outcome.label === "In progress"}>
                    {outcome.label}
                  </Badge>
                  {s.join_url && (
                    <Button
                      type="button"
                      variant="ghost"
                      className={`session-copy-link${copiedLinkId === s.id ? " is-copied" : ""}`}
                      onClick={() => void copyJoinLink(s)}
                      aria-label={copiedLinkId === s.id
                        ? `Copy secure link for ${s.objective} — copied`
                        : `Copy secure link for ${s.objective}`}
                      title={copiedLinkId === s.id ? "Copied" : "Copy link"}
                    >
                      {copiedLinkId === s.id ? (
                        <>
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="m5 12 4 4L19 6" />
                          </svg>
                          <span className="sr-only">Copied</span>
                        </>
                      ) : (
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <rect x="8" y="8" width="11" height="11" rx="2" />
                          <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
                        </svg>
                      )}
                    </Button>
                  )}
                  {open && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={ending || endingOpen}
                      onClick={() => void endSession(s.id)}
                      aria-label={`End session ${s.id}`}
                    >
                      {ending ? "Ending…" : "End"}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!needsToken && sessions.length > 0 && (
        <div className="inbox-footer-actions">
          {openSessions.length > 0 && (
            <Button
              type="button"
              variant="secondary"
              disabled={endingOpen || endingId !== null}
              onClick={() => void endOpenSessions()}
            >
              {endingOpen
                ? "Ending open sessions…"
                : `End ${openSessions.length} open session${openSessions.length === 1 ? "" : "s"}`}
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={() => loadSessions()}>
            Refresh
          </Button>
        </div>
      )}

      {token && (
        <SettingsModal
          token={token}
          open={settingsOpen}
          initialSection={settingsSection}
          onClose={() => setSettingsOpen(false)}
          onAgentConnected={markAgentConnected}
          onStartTestCall={(useCase) => void startTestCall(useCase)}
          testCallBusy={testCallBusy}
          onTokenRotated={(next) => {
            sessionStorage.setItem("oc_token", next);
            setToken(next);
          }}
          onSettingsChanged={setSettings}
        />
      )}
    </OperatorInboxShell>
  );
}
