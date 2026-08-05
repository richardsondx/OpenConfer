import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Badge } from "./primitives";
import {
  createDemoSession,
  joinPathFromUrl,
  type SettingsView,
  type DemoUseCase,
} from "../lib/settings";
import { TestCallPicker } from "./TestCallPicker";

export function GetStarted({
  token,
  settings,
  onOpenSettings,
  onSessionCreated,
}: {
  token: string;
  settings: SettingsView | null;
  onOpenSettings: (section?: "connect" | "access" | "voice" | "status") => void;
  onSessionCreated: () => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [joinPaste, setJoinPaste] = useState("");

  const createDemo = async (useCase: DemoUseCase) => {
    if (!voiceReady) {
      onOpenSettings("voice");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const session = await createDemoSession(token, useCase);
      onSessionCreated();
      if (phonePrimary) {
        if (session.delivery?.status === "failed" || session.status === "failed") {
          setError(session.delivery?.error ?? "Twilio could not place the call.");
        } else {
          setNotice("Call requested. Waiting for your phone to ring…");
        }
      } else if (session.join_url) {
        navigate(joinPathFromUrl(session.join_url));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the sandbox test call");
    } finally {
      setBusy(false);
    }
  };

  const openPastedJoin = () => {
    const raw = joinPaste.trim();
    if (!raw) return;
    if (!raw.includes("/join/")) {
      setError("Paste a full join URL from a session.");
      return;
    }
    try {
      navigate(joinPathFromUrl(raw));
    } catch {
      setError("That does not look like a valid join URL.");
    }
  };

  const roomStatus = settings?.status.livekit ?? "not_configured";
  const speakingReady =
    settings?.status.speaking_agent === "ready" || settings?.status.openai_worker === "ready";
  const voiceReady = settings?.status.voice_ready === true;
  const phonePrimary = settings?.routes.default.notify.includes("twilio") === true;
  const speakingSummary = settings?.conversation.speaking_summary;
  const voiceBadge =
    voiceReady
      ? "Voice ready"
      : roomStatus === "unreachable"
        ? "LiveKit not running"
        : !speakingReady
          ? "Needs speaking setup"
          : "Needs setup";
  const voiceCopy = voiceReady
    ? `LiveKit is running and the speaking agent is ready${speakingSummary ? ` (${speakingSummary})` : ""}. You can try a live voice decision.`
    : roomStatus === "unreachable"
      ? "LiveKit credentials are saved, but LiveKit is not running. Restart with openconfer serve."
      : !speakingReady && roomStatus === "ready"
        ? "Room is up. Finish the speaking preset in Voice settings so the agent can talk."
        : "Voice needs a running LiveKit room and speaking credentials before you can hear a decision.";

  const demoHint = !voiceReady
    ? roomStatus === "unreachable"
      ? "Start LiveKit (openconfer serve), then try again."
      : !speakingReady
        ? "Configure a speaking preset in Voice settings first."
        : "Finish voice setup before starting a demo."
    : null;

  return (
    <div className="get-started" id="get-started">
      <div className="get-started-intro">
        <p className="get-started-kicker">Your first decision loop</p>
        <h2>Go from install to a real voice decision.</h2>
        <p>
          Start with the voice, make one sandbox call, then give your agent a way to reach you.
        </p>
      </div>

      <ol className="get-started-checklist">
        <li className="get-started-step">
          <div className="get-started-step-head">
            <strong>1. Set up voice</strong>
            <Badge variant={voiceReady ? "success" : "urgent"}>{voiceBadge}</Badge>
          </div>
          <p>{voiceCopy}</p>
          <Button
            type="button"
            variant={voiceReady ? "secondary" : undefined}
            onClick={() => onOpenSettings("voice")}
          >
            {voiceReady ? "Voice settings" : "Set up voice"}
          </Button>
        </li>

        <li className="get-started-step">
          <div className="get-started-step-head">
            <strong>2. Start a sandbox test call</strong>
            <Badge variant={voiceReady ? "success" : "default"}>
              {voiceReady ? "Ready" : "Needs voice"}
            </Badge>
          </div>
          <p>
            {phonePrimary
              ? "No Hermes or agent required. Pick a familiar scenario and we'll call your phone."
              : "No Hermes or agent required. Pick a familiar scenario so you can join LiveKit and hear the speaking agent before wiring real work."}
          </p>
          <TestCallPicker
            id="get-started-test-call-use-case"
            busy={busy}
            voiceReady={voiceReady}
            onStartTestCall={(useCase) => void createDemo(useCase)}
          />
          {demoHint && <p className="get-started-hint">{demoHint}</p>}
        </li>

        <li className="get-started-step">
          <div className="get-started-step-head">
            <strong>3. Connect an agent</strong>
            <Badge variant="active">One copy-paste</Badge>
          </div>
          <p>
            After the sandbox feels right, wire a harness (Hermes, OpenClaw, …) so real work can
            pause and ask you. Pick yours in Settings → Connect Agent.
          </p>
          <Button type="button" variant="secondary" onClick={() => onOpenSettings("connect")}>
            Connect Agent
          </Button>
        </li>
      </ol>

      {error && (
        <div className="alert alert-warning" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="alert alert-success" role="status">
          {notice}
        </div>
      )}

      <div className="get-started-join">
        <label className="field-label" htmlFor="join-paste">
          Or open a join link
        </label>
        <div className="inbox-auth-row">
          <input
            id="join-paste"
            className="field-input"
            placeholder="http://127.0.0.1:5173/join/…#token=…"
            value={joinPaste}
            onChange={(e) => setJoinPaste(e.target.value)}
          />
          <Button type="button" variant="secondary" onClick={openPastedJoin}>
            Open
          </Button>
        </div>
      </div>
    </div>
  );
}
