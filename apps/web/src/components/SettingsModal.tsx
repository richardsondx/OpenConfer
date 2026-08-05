import { useEffect, useState, type FormEvent } from "react";
import { Button, Badge } from "./primitives";
import { SecretField } from "./SecretField";
import { Tip } from "./Tip";
import { VoicePipelineDiagram } from "./VoicePipelineDiagram";
import { TestCallPicker } from "./TestCallPicker";
import {
  fetchSettings,
  hermesSkillMarkdown,
  liveKitStatusLabel,
  patchSettings,
  rotateApiToken,
  speakingStatusLabel,
  type SettingsPatch,
  type SettingsView,
  type SpeakingPreset,
  type DemoUseCase,
} from "../lib/settings";
import { previewAlertStyle } from "../lib/incoming-ring";
import {
  describeQuietHours,
  formatQuietHours,
  matchQuietHoursPreset,
  normalizeTimeValue,
  parseQuietHours,
  QUIET_HOURS_PRESETS,
} from "../lib/quiet-hours";
import { timeZoneOptions } from "../lib/timezones";

type Section = "connect" | "access" | "alerts" | "preferences" | "voice" | "status" | "advanced";

/** Stand-in when a secret is configured but the API only returns a short preview. */
const SAVED_SECRET_PREVIEW = "••••••••••••••";

const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: "status", label: "Status" },
  { id: "access", label: "Access key" },
  { id: "alerts", label: "How you're reached" },
  { id: "preferences", label: "Incoming calls" },
  { id: "voice", label: "Voice" },
  { id: "connect", label: "Connect Agent" },
  { id: "advanced", label: "Advanced" },
];

const SPEAKING_PRESETS: Array<{ value: SpeakingPreset; label: string; hint: string }> = [
  {
    value: "live",
    label: "Live (recommended)",
    hint: "OpenAI Realtime — best latency. One API key.",
  },
  {
    value: "flexible",
    label: "Flexible",
    hint: "Deepgram + OpenRouter LLM + Cartesia. Swap Claude/Gemini/etc. via OpenRouter model id.",
  },
  {
    value: "local",
    label: "Local / private",
    hint: "Ollama for intelligence. Still needs cloud STT/TTS keys unless you customize. Latency depends on your machine.",
  },
  {
    value: "custom",
    label: "Custom",
    hint: "Pick STT, LLM, and TTS providers yourself.",
  },
];

const REALTIME_MODELS = [
  { value: "gpt-realtime", label: "gpt-realtime (recommended)" },
  { value: "gpt-realtime-mini", label: "gpt-realtime-mini" },
  { value: "gpt-realtime-2.1", label: "gpt-realtime-2.1" },
  { value: "gpt-realtime-2.1-mini", label: "gpt-realtime-2.1-mini" },
] as const;

const REALTIME_VOICES = [
  { value: "marin", label: "marin (recommended)" },
  { value: "cedar", label: "cedar (recommended)" },
  { value: "alloy", label: "alloy" },
  { value: "ash", label: "ash" },
  { value: "ballad", label: "ballad" },
  { value: "coral", label: "coral" },
  { value: "echo", label: "echo" },
  { value: "sage", label: "sage" },
  { value: "shimmer", label: "shimmer" },
  { value: "verse", label: "verse" },
] as const;

const STT_PROVIDERS = [
  { value: "deepgram", label: "Deepgram" },
  { value: "openai", label: "OpenAI" },
] as const;

const LLM_PROVIDERS = [
  { value: "openrouter", label: "OpenRouter" },
  { value: "openai", label: "OpenAI" },
  { value: "ollama", label: "Ollama (local)" },
] as const;

const TTS_PROVIDERS = [
  { value: "cartesia", label: "Cartesia" },
  { value: "elevenlabs", label: "ElevenLabs" },
  { value: "openai", label: "OpenAI" },
] as const;

const OPENROUTER_MODELS = [
  { value: "openai/gpt-4o-mini", label: "openai/gpt-4o-mini (fast)" },
  { value: "openai/gpt-4o", label: "openai/gpt-4o" },
  { value: "anthropic/claude-sonnet-4", label: "anthropic/claude-sonnet-4" },
  { value: "google/gemini-2.5-flash", label: "google/gemini-2.5-flash" },
  { value: "x-ai/grok-4-fast", label: "x-ai/grok-4-fast" },
] as const;

function selectWithCurrent(options: readonly { value: string; label: string }[], current: string) {
  if (!current || options.some((o) => o.value === current)) return [...options];
  return [{ value: current, label: `${current} (saved)` }, ...options];
}

/** Green = connected, red = broken, grey = not connected. */
function StatusDot({
  state,
  label,
}: {
  state: "ready" | "broken" | "off";
  label: string;
}) {
  return (
    <span
      className={`status-dot is-${state}`}
      title={label}
      aria-label={label}
      role="img"
    />
  );
}

export function SettingsModal({
  token,
  open,
  initialSection = "status",
  onClose,
  onAgentConnected,
  onStartTestCall,
  testCallBusy = false,
  onTokenRotated,
}: {
  token: string;
  open: boolean;
  initialSection?: Section | "overview" | "token" | "notifications" | "conversation" | "prefs";
  onClose: () => void;
  /** Operator finished wiring a harness; dismisses the inbox “connect an agent” nudge. */
  onAgentConnected?: () => void;
  /** Start a no-agent sandbox voice session to verify room + speaking agent. */
  onStartTestCall?: (useCase: DemoUseCase) => void;
  testCallBusy?: boolean;
  onTokenRotated?: (nextToken: string) => void;
}) {
  const mapSection = (s: typeof initialSection): Section => {
    if (s === "overview") return "status";
    if (s === "token") return "access";
    if (s === "notifications") return "alerts";
    if (s === "prefs") return "preferences";
    if (s === "conversation") return "voice";
    if (
      s === "connect" ||
      s === "access" ||
      s === "alerts" ||
      s === "preferences" ||
      s === "voice" ||
      s === "status" ||
      s === "advanced"
    ) {
      return s;
    }
    return "status";
  };

  const [section, setSection] = useState<Section>(mapSection(initialSection));
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [activeToken, setActiveToken] = useState(token);

  const [baseUrl, setBaseUrl] = useState("");
  const [webUrl, setWebUrl] = useState("");
  const [notifyTwilio, setNotifyTwilio] = useState(false);
  const [twilioAccountSid, setTwilioAccountSid] = useState("");
  const [twilioAuthToken, setTwilioAuthToken] = useState("");
  const [twilioFromNumber, setTwilioFromNumber] = useState("");
  const [twilioDestinationNumber, setTwilioDestinationNumber] = useState("");
  const [alertStyle, setAlertStyle] = useState<"off" | "subtle" | "standard">("subtle");
  const [alertSound, setAlertSound] = useState(true);
  const [browserNotifications, setBrowserNotifications] = useState(false);
  const [snoozeMinutes, setSnoozeMinutes] = useState(3);
  const [callName, setCallName] = useState("");
  const [quietEnabled, setQuietEnabled] = useState(false);
  const [quietFrom, setQuietFrom] = useState("22:00");
  const [quietTo, setQuietTo] = useState("07:00");
  const [quietPreset, setQuietPreset] = useState("off");
  const [timezone, setTimezone] = useState("UTC");
  const [livekitUrl, setLivekitUrl] = useState("");
  const [livekitPublicUrl, setLivekitPublicUrl] = useState("");
  const [livekitKey, setLivekitKey] = useState("");
  const [livekitSecret, setLivekitSecret] = useState("");
  const [preset, setPreset] = useState<SpeakingPreset>("live");
  const [openaiKey, setOpenaiKey] = useState("");
  const [realtimeModel, setRealtimeModel] = useState("gpt-realtime");
  const [realtimeVoice, setRealtimeVoice] = useState("marin");
  const [sttProvider, setSttProvider] = useState("deepgram");
  const [sttModel, setSttModel] = useState("nova-3");
  const [sttKey, setSttKey] = useState("");
  const [llmProvider, setLlmProvider] = useState("openrouter");
  const [llmModel, setLlmModel] = useState("openai/gpt-4o-mini");
  const [llmBaseUrl, setLlmBaseUrl] = useState("");
  const [llmKey, setLlmKey] = useState("");
  const [ttsProvider, setTtsProvider] = useState("cartesia");
  const [ttsModel, setTtsModel] = useState("sonic-3");
  const [ttsVoice, setTtsVoice] = useState("");
  const [ttsKey, setTtsKey] = useState("");

  const hydrateSpeaking = (view: SettingsView) => {
    setPreset(view.conversation.preset ?? "live");
    setRealtimeModel(view.conversation.realtime?.model || view.conversation.model || "gpt-realtime");
    setRealtimeVoice(view.conversation.realtime?.voice || view.conversation.voice || "marin");
    setSttProvider(view.conversation.stt?.provider || "deepgram");
    setSttModel(view.conversation.stt?.model || "nova-3");
    setLlmProvider(view.conversation.llm?.provider || "openrouter");
    setLlmModel(view.conversation.llm?.model || "openai/gpt-4o-mini");
    setLlmBaseUrl(view.conversation.llm?.base_url || "");
    setTtsProvider(view.conversation.tts?.provider || "cartesia");
    setTtsModel(view.conversation.tts?.model || "sonic-3");
    setTtsVoice(view.conversation.tts?.voice || "");
  };

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), 4000);
    return () => window.clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    if (!open) return;
    setSection(mapSection(initialSection));
    setError(null);
    setMessage(null);
    setActiveToken(token);
    fetchSettings(token)
      .then((view) => {
        setSettings(view);
        setBaseUrl(view.server.base_url);
        setWebUrl(view.server.web_url);
        setNotifyTwilio(view.routes.default.notify.includes("twilio"));
        setTwilioAccountSid("");
        setTwilioAuthToken("");
        setTwilioFromNumber(view.telephony.twilio.from_number ?? "");
        setTwilioDestinationNumber(view.telephony.twilio.destination_number ?? "");
        setAlertStyle(view.operator?.alerts?.style ?? "subtle");
        setAlertSound(view.operator?.alerts?.sound !== false);
        setBrowserNotifications(view.operator?.alerts?.browser_notifications === true);
        setSnoozeMinutes(view.operator?.alerts?.snooze_minutes ?? 3);
        setCallName(view.operator?.call_name ?? "");
        {
          const range = parseQuietHours(view.operator?.quiet_hours);
          setQuietEnabled(Boolean(range));
          setQuietFrom(range?.from ?? "22:00");
          setQuietTo(range?.to ?? "07:00");
          setQuietPreset(matchQuietHoursPreset(range));
        }
        setTimezone(view.operator?.timezone ?? "UTC");
        setLivekitUrl(view.conversation.livekit_url ?? "");
        setLivekitPublicUrl(view.conversation.livekit_public_url ?? "");
        setLivekitKey("");
        setLivekitSecret("");
        setOpenaiKey("");
        setSttKey("");
        setLlmKey("");
        setTtsKey("");
        hydrateSpeaking(view);
      })
      .catch((e: Error) => setError(e.message));
  }, [open, token, initialSection]);

  if (!open) return null;

  const hermesEnv = settings
    ? [
        `export OPENCONFER_BASE_URL="${settings.server.base_url}"`,
        `export OPENCONFER_API_TOKEN="${activeToken}"`,
      ].join("\n")
    : "";

  const connectCommand = settings?.hermes.connect_command ?? "openconfer connect hermes";
  const skillInstallPath =
    settings?.hermes.skill_install_path ?? "~/.hermes/skills/openconfer/SKILL.md";
  const skillMarkdown =
    settings?.hermes.skill_markdown?.trim() ||
    (settings ? hermesSkillMarkdown(settings.server.base_url) : "");

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMessage(`Copied ${label}`);
    } catch {
      setMessage("Could not copy — select the text manually");
    }
  };

  const generateKey = async () => {
    if (
      !confirm(
        "Create a new access key? Hermes must use the new key afterward. Your browser will switch automatically.",
      )
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await rotateApiToken(activeToken);
      setSettings(result.settings);
      setActiveToken(result.api_token);
      onTokenRotated?.(result.api_token);
      const env = [
        `export OPENCONFER_BASE_URL="${result.settings.server.base_url}"`,
        `export OPENCONFER_API_TOKEN="${result.api_token}"`,
      ].join("\n");
      await navigator.clipboard.writeText(env).catch(() => undefined);
      setMessage("New access key created and agent env copied to your clipboard");
      setSection("access");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create key");
    } finally {
      setSaving(false);
    }
  };

  const saveAlerts = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const notify = ["secure_link"];
      if (notifyTwilio) notify.push("twilio");
      const twilio: NonNullable<NonNullable<SettingsPatch["telephony"]>["twilio"]> = {
        from_number: twilioFromNumber.trim(),
        destination_number: twilioDestinationNumber.trim(),
      };
      if (twilioAccountSid.trim()) twilio.account_sid = twilioAccountSid.trim();
      if (twilioAuthToken.trim()) twilio.auth_token = twilioAuthToken.trim();
      const view = await patchSettings(activeToken, {
        routes: { default: { notify } },
        telephony: { adapter: "twilio", twilio },
      });
      setSettings(view);
      setTwilioAccountSid("");
      setTwilioAuthToken("");
      setMessage("Saved — how you're reached is updated");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const savePreferences = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const allowed = new Set([1, 3, 5, 10, 15, 30]);
      if (!allowed.has(snoozeMinutes)) {
        throw new Error("Snooze must be 1, 3, 5, 10, 15, or 30 minutes.");
      }
      const quiet = quietEnabled
        ? formatQuietHours({ from: quietFrom, to: quietTo })
        : null;
      const operatorId = settings?.operator?.id ?? "me";
      const view = await patchSettings(activeToken, {
        operators: {
          [operatorId]: {
            call_name: callName.trim(),
            timezone: timezone || "UTC",
            quiet_hours: quiet,
            alerts: {
              style: alertStyle,
              sound: alertSound,
              browser_notifications: browserNotifications,
              snooze_minutes: snoozeMinutes as 1 | 3 | 5 | 10 | 15 | 30,
            },
          },
        },
      });
      setSettings(view);
      setMessage("Saved — incoming call preferences updated");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const saveVoice = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const conversation: NonNullable<SettingsPatch["conversation"]> = {
        preset,
      };
      if (livekitUrl.trim()) conversation.livekit_url = livekitUrl.trim();
      if (livekitPublicUrl.trim()) conversation.livekit_public_url = livekitPublicUrl.trim();
      if (livekitKey.trim()) conversation.livekit_api_key = livekitKey.trim();
      if (livekitSecret.trim()) conversation.livekit_api_secret = livekitSecret.trim();

      // Always allow updating realtime credentials (Live preset + Custom realtime path).
      conversation.realtime = {
        model: realtimeModel.trim() || "gpt-realtime",
        voice: realtimeVoice.trim() || "marin",
        ...(openaiKey.trim() ? { api_key: openaiKey.trim() } : {}),
      };
      if (openaiKey.trim()) conversation.openai_api_key = openaiKey.trim();

      if (preset !== "live") {
        conversation.stt = {
          provider: sttProvider,
          model: sttModel.trim() || (sttProvider === "openai" ? "gpt-4o-mini-transcribe" : "nova-3"),
          ...(sttKey.trim() ? { api_key: sttKey.trim() } : {}),
        };
        conversation.llm = {
          provider: llmProvider,
          model: llmModel.trim() || "openai/gpt-4o-mini",
          ...(llmBaseUrl.trim() ? { base_url: llmBaseUrl.trim() } : {}),
          ...(llmKey.trim() ? { api_key: llmKey.trim() } : {}),
        };
        conversation.tts = {
          provider: ttsProvider,
          model: ttsModel.trim() || "sonic-3",
          ...(ttsVoice.trim() ? { voice: ttsVoice.trim() } : {}),
          ...(ttsKey.trim() ? { api_key: ttsKey.trim() } : {}),
        };
      }

      if (preset === "custom") {
        conversation.speaking_mode = settings?.conversation.speaking_mode ?? "pipeline";
      }

      const savedOpenaiKey = openaiKey.trim();
      const savedSttKey = sttKey.trim();
      const savedLlmKey = llmKey.trim();
      const savedTtsKey = ttsKey.trim();
      const savedLivekitKey = livekitKey.trim();
      const savedLivekitSecret = livekitSecret.trim();
      const view = await patchSettings(activeToken, { conversation });
      setSettings(view);
      if (savedOpenaiKey) setOpenaiKey(savedOpenaiKey);
      if (savedSttKey) setSttKey(savedSttKey);
      if (savedLlmKey) setLlmKey(savedLlmKey);
      if (savedTtsKey) setTtsKey(savedTtsKey);
      if (savedLivekitKey) setLivekitKey(savedLivekitKey);
      if (savedLivekitSecret) setLivekitSecret(savedLivekitSecret);
      hydrateSpeaking(view);

      const speakingReady =
        view.status.speaking_agent === "ready" || view.status.openai_worker === "ready";
      const parts: string[] = ["Saved."];
      if (view.status.livekit === "ready") {
        parts.push("LiveKit room is running.");
      } else if (view.status.livekit === "unreachable") {
        parts.push("LiveKit credentials are saved, but LiveKit is not running — restart with openconfer serve.");
      } else {
        parts.push("LiveKit room is not configured yet.");
      }
      if (speakingReady) {
        parts.push(
          view.status.restart_required
            ? `Speaking preset saved (${view.conversation.speaking_summary}) — restart openconfer serve.`
            : `Speaking agent ready: ${view.conversation.speaking_summary}.`,
        );
      } else {
        const missing = view.conversation.missing_credentials?.join(", ") || "speaking credentials";
        parts.push(`Add ${missing} to enable the speaking agent.`);
      }
      setMessage(parts.join(" "));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const saveAdvanced = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const view = await patchSettings(activeToken, {
        server: { base_url: baseUrl.trim(), web_url: webUrl.trim() },
      });
      setSettings(view);
      setMessage("Addresses saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const roomStatus = settings?.status.livekit ?? "not_configured";
  const speakingStatus =
    settings?.status.speaking_agent ??
    (settings?.status.openai_worker === "ready" ? "ready" : "missing_credentials");
  const speakingReady = speakingStatus === "ready";
  const voiceReady = settings?.status.voice_ready === true;
  const livekitSource = settings?.conversation.livekit_credential_source ?? "none";
  const livekitLocalDefaults = livekitSource === "local_defaults";
  const showRealtimeFields = preset === "live" || preset === "custom";
  const showPipelineFields = preset === "flexible" || preset === "local" || preset === "custom";
  const speakingMode =
    preset === "live"
      ? "realtime"
      : preset === "custom"
        ? (settings?.conversation.speaking_mode ?? "pipeline")
        : "pipeline";
  const speakingSummary =
    settings?.conversation.speaking_summary?.trim() ||
    (speakingMode === "realtime"
      ? `OpenAI Realtime · ${realtimeModel} · ${realtimeVoice}`
      : `${sttProvider}/${sttModel} → ${llmProvider}/${llmModel} → ${ttsProvider}/${ttsModel}`);

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Settings">
      <button type="button" className="settings-backdrop" aria-label="Close settings" onClick={onClose} />
      <div className="settings-modal">
        <aside className="settings-sidebar">
          <div className="settings-sidebar-title">Settings</div>
          <nav className="settings-nav">
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`settings-nav-item${section === item.id ? " is-active" : ""}`}
                onClick={() => setSection(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </aside>
        <div className="settings-content">
          {error && (
            <div className="alert alert-warning" role="alert">
              {error}
            </div>
          )}
          {message && (
            <div className="alert alert-success" role="status">
              {message}
            </div>
          )}
          {!settings && !error && <div className="skeleton" style={{ height: 120 }} />}

          {settings && section === "connect" && (
            <div className="settings-panel">
              <h2>
                Connect Agent{" "}
                <Tip label="What is this?">
                  Expand a harness below to wire credentials so it can open decision sessions in this
                  inbox. Skills are shared — any harness that can install them can use OpenConfer.
                </Tip>
              </h2>
              <p className="settings-lead">
                Expand the harness your agent runs in, then run its connect command once on this Mac.
              </p>

              <details className="settings-details harness-details" open>
                <summary>Hermes</summary>
                <div className="harness-panel">
                  <p className="settings-lead">
                    Run this <strong>once</strong> in any terminal on this Mac (where Hermes is installed).
                    It updates <code className="inline-code">~/.hermes/.env</code> and installs the skill.
                  </p>
                  <div className="code-block">
                    <pre>{connectCommand}</pre>
                    <Button
                      type="button"
                      variant="primary"
                      onClick={() => copy(connectCommand, "Hermes connect command")}
                    >
                      Copy command
                    </Button>
                  </div>
                  <ol className="settings-steps">
                    <li>Paste the command into Terminal and press Enter.</li>
                    <li>Restart Hermes (or start a new chat).</li>
                    <li>When Hermes needs you, a session shows up here.</li>
                  </ol>
                  <details className="settings-details">
                    <summary>Manual env (if you cannot run connect)</summary>
                    <div className="code-block">
                      <pre>{hermesEnv}</pre>
                      <Button type="button" variant="ghost" onClick={() => copy(hermesEnv, "manual env")}>
                        Copy manual env
                      </Button>
                    </div>
                  </details>
                </div>
              </details>

              <details className="settings-details harness-details">
                <summary>
                  OpenClaw <Badge variant="default">Coming soon</Badge>
                </summary>
                <div className="harness-panel">
                  <p className="settings-lead">
                    OpenClaw connect is not available yet. Use Hermes for now, or install the skill below
                    in any harness that supports skills.
                  </p>
                </div>
              </details>

              <h3>
                Skill preview{" "}
                <Tip label="What is a skill?">
                  A short instruction file any agent harness can read so it knows how to call OpenConfer.
                  Hermes install path: {skillInstallPath}.
                </Tip>
              </h3>
              <div className="skill-preview">
                <pre className="skill-preview-text" tabIndex={0}>
                  {skillMarkdown}
                </pre>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => copy(skillMarkdown, "skill markdown")}
                >
                  Copy skill.md
                </Button>
              </div>

              <div className="settings-actions">
                {onAgentConnected && (
                  <Button type="button" onClick={onAgentConnected}>
                    I connected the agent
                  </Button>
                )}
                <Button type="button" variant="secondary" onClick={() => setSection("access")}>
                  Need a new access key?
                </Button>
              </div>
            </div>
          )}

          {settings && section === "access" && (
            <div className="settings-panel">
              <h2>
                Access key{" "}
                <Tip label="What is an access key?">
                  This is the password agents and this browser use to talk to your OpenConfer server.
                  Keep it private — anyone with it can create sessions.
                </Tip>
              </h2>
              <p className="settings-lead">
                This browser already has it. Agents need the same key in their environment (Connect Agent).
              </p>
              <SecretField
                id="access-key"
                label="Access key"
                value={activeToken}
                onChange={() => undefined}
                readOnly
              />
              <div className="settings-actions">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => copy(activeToken, "access key")}
                >
                  Copy access key
                </Button>
                <Button type="button" disabled={saving} onClick={generateKey}>
                  {saving ? "Creating…" : "Generate new key"}
                </Button>
              </div>
              <p className="settings-hint">
                Generate creates a new key, saves it to config, updates this browser, and copies a ready
                agent env block.
              </p>
            </div>
          )}

          {settings && section === "alerts" && (
            <form className="settings-panel" onSubmit={saveAlerts}>
              <h2>
                How you're reached{" "}
                <Tip label="What does this control?">
                  Every agent request appears in this inbox with a secure link you can open or copy.
                  Phone calls are optional.
                </Tip>
              </h2>
              <label className="settings-check">
                <input type="checkbox" checked disabled readOnly />
                <span>
                  <strong>Inbox with copyable secure links</strong>
                  <small>Always on. Use Copy link beside any session to share or save its join link.</small>
                </span>
              </label>
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={notifyTwilio}
                  onChange={(e) => setNotifyTwilio(e.target.checked)}
                />
                <span>
                  <strong>
                    Phone call <Badge variant="active">Twilio</Badge>
                  </strong>
                  <small>
                    Automatically calls your phone and connects it to the current LiveKit voice agent.
                    Status: {settings.status.twilio === "ready"
                      ? "ready"
                      : settings.status.twilio === "missing_config"
                        ? "needs Twilio setup"
                        : settings.status.twilio === "needs_livekit_voice"
                          ? "needs LiveKit voice"
                          : "off"}.
                  </small>
                </span>
              </label>
              {notifyTwilio && (
                <div className="settings-channel-config" aria-label="Twilio phone call setup">
                  <SecretField
                    id="twilio-account-sid"
                    label="Twilio Account SID"
                    value={twilioAccountSid}
                    onChange={setTwilioAccountSid}
                    placeholder="AC…"
                    savedPreview={settings.telephony.twilio.account_sid_preview}
                  />
                  <SecretField
                    id="twilio-auth-token"
                    label="Twilio Auth Token"
                    value={twilioAuthToken}
                    onChange={setTwilioAuthToken}
                    placeholder="Paste the Auth Token from Twilio"
                    savedPreview={settings.telephony.twilio.auth_token_preview}
                  />
                  <label className="field-label" htmlFor="twilio-from-number">
                    Twilio phone number
                  </label>
                  <input
                    id="twilio-from-number"
                    className="field-input"
                    type="tel"
                    value={twilioFromNumber}
                    onChange={(e) => setTwilioFromNumber(e.target.value)}
                    placeholder="+14165550100"
                  />
                  <label className="field-label" htmlFor="twilio-destination-number">
                    Call me at
                  </label>
                  <input
                    id="twilio-destination-number"
                    className="field-input"
                    type="tel"
                    value={twilioDestinationNumber}
                    onChange={(e) => setTwilioDestinationNumber(e.target.value)}
                    placeholder="+14165550101"
                  />
                  <p className="settings-hint">
                    Use international E.164 format beginning with <code className="inline-code">+</code>.
                    Twilio number rental and call charges apply. Outbound calls require a LiveKit deployment
                    with the Twilio Connector available.
                  </p>
                </div>
              )}
              <p className="settings-hint">
                Ring style, snooze presets, and quiet hours live under{" "}
                <button type="button" className="settings-inline-link" onClick={() => setSection("preferences")}>
                  Incoming calls
                </button>
                .
              </p>

              <div className="settings-actions">
                <Button type="submit" disabled={saving}>
                  Save
                </Button>
              </div>
            </form>
          )}

          {settings && section === "preferences" && (
            <form className="settings-panel" onSubmit={savePreferences}>
              <h2>
                Incoming calls{" "}
                <Tip label="What is this?">
                  Waiting sessions ring briefly in the inbox — like a short business call, not a phone
                  that never stops. Urgency still makes high/incident asks more insistent.
                </Tip>
              </h2>
              <p className="settings-lead">
                Choose how OpenConfer gets your attention, and how long snooze waits before alerting you
                again through every enabled channel.
              </p>
              <label className="field-label" htmlFor="operator-call-name">
                What should the caller call you?
              </label>
              <input
                id="operator-call-name"
                className="field-input"
                value={callName}
                onChange={(e) => setCallName(e.target.value)}
                placeholder="Richardson"
                maxLength={80}
                autoComplete="name"
              />
              <p className="settings-hint">
                The voice agent uses this for a natural opening, such as “Hey Richardson!” Leave it blank
                for a greeting without a name.
              </p>
              <label className="field-label" htmlFor="alert-style">
                Alert style
              </label>
              <select
                id="alert-style"
                className="field-input"
                value={alertStyle}
                onChange={(e) => {
                  const next = e.target.value as "off" | "subtle" | "standard";
                  setAlertStyle(next);
                  previewAlertStyle(next, alertSound);
                }}
              >
                <option value="off">Off — visual list only</option>
                <option value="subtle">Subtle — short soft pulses (office default)</option>
                <option value="standard">Standard — a bit more insistent</option>
              </select>
              <p className="settings-hint">Changing Subtle or Standard plays a short preview.</p>
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={alertSound}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setAlertSound(next);
                    if (next) previewAlertStyle(alertStyle, true);
                  }}
                  disabled={alertStyle === "off"}
                />
                <span>
                  <strong>Play soft chime</strong>
                  <small>Quiet two-tone cue. Turns off with style Off.</small>
                </span>
              </label>
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={browserNotifications}
                  onChange={(e) => setBrowserNotifications(e.target.checked)}
                />
                <span>
                  <strong>Browser notifications</strong>
                  <small>Opt-in desktop notices, especially useful for high/incident urgency.</small>
                </span>
              </label>
              <label className="field-label" htmlFor="snooze-minutes">
                Snooze for
              </label>
              <select
                id="snooze-minutes"
                className="field-input"
                value={snoozeMinutes}
                onChange={(e) => setSnoozeMinutes(Number(e.target.value))}
              >
                <option value={1}>1 minute</option>
                <option value={3}>3 minutes</option>
                <option value={5}>5 minutes</option>
                <option value={10}>10 minutes</option>
                <option value={15}>15 minutes</option>
                <option value={30}>30 minutes</option>
              </select>
              <p className="settings-hint">
                One Snooze button on the incoming request uses this duration. When it ends, OpenConfer
                alerts you again through every enabled channel.
              </p>
              <label className="field-label" id="quiet-hours-label">
                Quiet hours
              </label>
              <div className="quiet-hours-presets" role="group" aria-labelledby="quiet-hours-label">
                {QUIET_HOURS_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={`quiet-hours-preset${quietPreset === preset.id ? " is-active" : ""}`}
                    onClick={() => {
                      setQuietPreset(preset.id);
                      if (preset.id === "off" || !preset.range) {
                        setQuietEnabled(false);
                        return;
                      }
                      setQuietEnabled(true);
                      setQuietFrom(preset.range.from);
                      setQuietTo(preset.range.to);
                    }}
                  >
                    <strong>{preset.label}</strong>
                    <small>{preset.hint}</small>
                  </button>
                ))}
              </div>
              {quietEnabled && (
                <div className="quiet-hours-times">
                  <label className="quiet-hours-time">
                    <span className="field-label">From</span>
                    <input
                      className="field-input"
                      type="time"
                      value={quietFrom}
                      onChange={(e) => {
                        setQuietFrom(normalizeTimeValue(e.target.value));
                        setQuietPreset("custom");
                      }}
                    />
                  </label>
                  <label className="quiet-hours-time">
                    <span className="field-label">To</span>
                    <input
                      className="field-input"
                      type="time"
                      value={quietTo}
                      onChange={(e) => {
                        setQuietTo(normalizeTimeValue(e.target.value));
                        setQuietPreset("custom");
                      }}
                    />
                  </label>
                </div>
              )}
              <p className="settings-hint">
                {describeQuietHours(
                  quietEnabled ? { from: quietFrom, to: quietTo } : null,
                )}{" "}
                Incidents can still break through.
              </p>
              <label className="field-label" htmlFor="operator-timezone">
                Timezone
              </label>
              <select
                id="operator-timezone"
                className="field-input"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              >
                {timeZoneOptions(timezone).map((zone) => (
                  <option key={zone} value={zone}>
                    {zone.replaceAll("_", " ")}
                  </option>
                ))}
              </select>

              <div className="settings-actions">
                <Button type="submit" disabled={saving}>
                  Save
                </Button>
              </div>
            </form>
          )}

          {settings && section === "voice" && (
            <form className="settings-panel" onSubmit={saveVoice}>
              <h2>
                Voice{" "}
                <Tip label="What is Voice?">
                  Two parts: a LiveKit <strong>room</strong> (audio transport) and a pluggable{" "}
                  <strong>speaking agent</strong> (Live realtime, Flexible STT→LLM→TTS, or Local via
                  Ollama). Text decisions always work without voice. Dot: green connected, red broken,
                  grey off.
                </Tip>
              </h2>
              <p className="settings-lead">
                Configure the room and speaking agent below. Prefer <strong>Live</strong> for the
                snappiest call; use Flexible/Local when you need open or private models.
              </p>

              <VoicePipelineDiagram
                mode={speakingMode}
                preset={preset}
                realtimeModel={realtimeModel}
                realtimeVoice={realtimeVoice}
                sttProvider={sttProvider}
                sttModel={sttModel}
                llmProvider={llmProvider}
                llmModel={llmModel}
                ttsProvider={ttsProvider}
                ttsModel={ttsModel}
                roomLabel={
                  livekitLocalDefaults ? "LiveKit (local)" : "LiveKit (audio room)"
                }
              />

              <div className="settings-test-call">
                <div>
                  <strong>Sandbox test call</strong>
                  <p className="settings-hint">
                    {voiceReady
                      ? `No agent required. Practice a voice session with ${speakingSummary}.`
                      : "Needs a running LiveKit room and speaking credentials. Save below, then restart openconfer serve."}
                  </p>
                </div>
                <TestCallPicker
                  id="settings-test-call-use-case"
                  busy={testCallBusy}
                  voiceReady={voiceReady}
                  buttonVariant="secondary"
                  onStartTestCall={(useCase) => onStartTestCall?.(useCase)}
                />
              </div>

              {(roomStatus !== "ready" || !speakingReady || settings.status.restart_required) && (
                <div className="code-block">
                  <pre>openconfer serve</pre>
                  <Button
                    type="button"
                    variant="primary"
                    onClick={() => copy("openconfer serve", "serve command")}
                  >
                    Copy command
                  </Button>
                </div>
              )}

              <details className="settings-details" open={!speakingReady}>
                <summary>
                  <StatusDot
                    state={speakingReady ? "ready" : "off"}
                    label={speakingReady ? "Speaking agent ready" : "Speaking agent not ready"}
                  />
                  <span>Speaking agent</span>
                </summary>
                <p className="settings-hint">
                  {speakingReady
                    ? `Using ${speakingSummary}.`
                    : settings.conversation.missing_credentials?.length
                      ? `Missing: ${settings.conversation.missing_credentials.join(", ")}.`
                      : "Choose a preset and add credentials."}{" "}
                  Text decisions still work without this.
                </p>

                <label className="field-label" htmlFor="speaking-preset">
                  Preset
                </label>
                <select
                  id="speaking-preset"
                  className="field-input"
                  value={preset}
                  onChange={(e) => setPreset(e.target.value as SpeakingPreset)}
                >
                  {SPEAKING_PRESETS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <p className="settings-hint">
                  {SPEAKING_PRESETS.find((p) => p.value === preset)?.hint}
                </p>

                {showRealtimeFields && (
                  <>
                    <SecretField
                      id="openai-key"
                      label="OpenAI API key"
                      value={openaiKey}
                      onChange={setOpenaiKey}
                      placeholder="sk-…"
                      savedPreview={
                        settings.conversation.realtime?.api_key_configured ||
                        settings.conversation.openai_api_key_configured
                          ? settings.conversation.realtime?.api_key_preview ||
                            settings.conversation.openai_api_key_preview ||
                            SAVED_SECRET_PREVIEW
                          : undefined
                      }
                    />
                    <label className="field-label" htmlFor="realtime-model">
                      Realtime model
                    </label>
                    <select
                      id="realtime-model"
                      className="field-input"
                      value={realtimeModel}
                      onChange={(e) => setRealtimeModel(e.target.value)}
                    >
                      {selectWithCurrent(REALTIME_MODELS, realtimeModel).map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <label className="field-label" htmlFor="realtime-voice">
                      Realtime voice
                    </label>
                    <select
                      id="realtime-voice"
                      className="field-input"
                      value={realtimeVoice}
                      onChange={(e) => setRealtimeVoice(e.target.value)}
                    >
                      {selectWithCurrent(REALTIME_VOICES, realtimeVoice).map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </>
                )}

                {showPipelineFields && (
                  <>
                    <label className="field-label" htmlFor="stt-provider">
                      Transcriber (STT)
                    </label>
                    <select
                      id="stt-provider"
                      className="field-input"
                      value={sttProvider}
                      onChange={(e) => setSttProvider(e.target.value)}
                    >
                      {STT_PROVIDERS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <label className="field-label" htmlFor="stt-model">
                      STT model
                    </label>
                    <input
                      id="stt-model"
                      className="field-input"
                      value={sttModel}
                      onChange={(e) => setSttModel(e.target.value)}
                      placeholder={sttProvider === "openai" ? "gpt-4o-mini-transcribe" : "nova-3"}
                    />
                    <SecretField
                      id="stt-key"
                      label={sttProvider === "deepgram" ? "Deepgram API key" : "OpenAI API key (STT)"}
                      value={sttKey}
                      onChange={setSttKey}
                      placeholder="API key"
                      savedPreview={
                        settings.conversation.stt?.api_key_configured
                          ? settings.conversation.stt.api_key_preview || SAVED_SECRET_PREVIEW
                          : undefined
                      }
                    />

                    <label className="field-label" htmlFor="llm-provider">
                      Intelligence (LLM)
                    </label>
                    <select
                      id="llm-provider"
                      className="field-input"
                      value={llmProvider}
                      onChange={(e) => setLlmProvider(e.target.value)}
                    >
                      {LLM_PROVIDERS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <label className="field-label" htmlFor="llm-model">
                      LLM model
                    </label>
                    {llmProvider === "openrouter" ? (
                      <select
                        id="llm-model"
                        className="field-input"
                        value={llmModel}
                        onChange={(e) => setLlmModel(e.target.value)}
                      >
                        {selectWithCurrent(OPENROUTER_MODELS, llmModel).map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id="llm-model"
                        className="field-input"
                        value={llmModel}
                        onChange={(e) => setLlmModel(e.target.value)}
                        placeholder={llmProvider === "ollama" ? "llama3.2" : "gpt-4o-mini"}
                      />
                    )}
                    {(llmProvider === "ollama" || llmProvider === "openrouter" || preset === "custom") && (
                      <>
                        <label className="field-label" htmlFor="llm-base-url">
                          LLM base URL
                        </label>
                        <input
                          id="llm-base-url"
                          className="field-input"
                          value={llmBaseUrl}
                          onChange={(e) => setLlmBaseUrl(e.target.value)}
                          placeholder={
                            llmProvider === "ollama"
                              ? "http://127.0.0.1:11434/v1"
                              : "https://openrouter.ai/api/v1"
                          }
                        />
                      </>
                    )}
                    {llmProvider !== "ollama" && (
                      <SecretField
                        id="llm-key"
                        label={
                          llmProvider === "openrouter" ? "OpenRouter API key" : "OpenAI API key (LLM)"
                        }
                        value={llmKey}
                        onChange={setLlmKey}
                        placeholder="API key"
                        savedPreview={
                          settings.conversation.llm?.api_key_configured
                            ? settings.conversation.llm.api_key_preview || SAVED_SECRET_PREVIEW
                            : undefined
                        }
                      />
                    )}

                    <label className="field-label" htmlFor="tts-provider">
                      Voice (TTS)
                    </label>
                    <select
                      id="tts-provider"
                      className="field-input"
                      value={ttsProvider}
                      onChange={(e) => setTtsProvider(e.target.value)}
                    >
                      {TTS_PROVIDERS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <label className="field-label" htmlFor="tts-model">
                      TTS model
                    </label>
                    <input
                      id="tts-model"
                      className="field-input"
                      value={ttsModel}
                      onChange={(e) => setTtsModel(e.target.value)}
                      placeholder={
                        ttsProvider === "elevenlabs"
                          ? "eleven_flash_v2_5"
                          : ttsProvider === "openai"
                            ? "gpt-4o-mini-tts"
                            : "sonic-3"
                      }
                    />
                    <label className="field-label" htmlFor="tts-voice">
                      TTS voice id
                    </label>
                    <input
                      id="tts-voice"
                      className="field-input"
                      value={ttsVoice}
                      onChange={(e) => setTtsVoice(e.target.value)}
                      placeholder="Provider voice id"
                    />
                    <SecretField
                      id="tts-key"
                      label={
                        ttsProvider === "cartesia"
                          ? "Cartesia API key"
                          : ttsProvider === "elevenlabs"
                            ? "ElevenLabs API key"
                            : "OpenAI API key (TTS)"
                      }
                      value={ttsKey}
                      onChange={setTtsKey}
                      placeholder="API key"
                      savedPreview={
                        settings.conversation.tts?.api_key_configured
                          ? settings.conversation.tts.api_key_preview || SAVED_SECRET_PREVIEW
                          : undefined
                      }
                    />
                  </>
                )}
              </details>

              <details className="settings-details" open={!livekitLocalDefaults && roomStatus !== "ready"}>
                <summary>
                  <StatusDot
                    state={
                      roomStatus === "ready"
                        ? "ready"
                        : roomStatus === "unreachable"
                          ? "broken"
                          : "off"
                    }
                    label={
                      roomStatus === "ready"
                        ? "LiveKit connected"
                        : roomStatus === "unreachable"
                          ? "LiveKit broken — credentials saved but room not running"
                          : "LiveKit not connected"
                    }
                  />
                  <span>LiveKit (audio room)</span>
                </summary>
                {livekitLocalDefaults ? (
                  <p className="settings-hint">
                    <strong>You did not add these.</strong>{" "}
                    <code className="inline-code">openconfer serve</code> wrote local Docker defaults (
                    <code className="inline-code">devkey</code> / <code className="inline-code">secret</code>{" "}
                    at <code className="inline-code">ws://127.0.0.1:7880</code>). Only change these for
                    LiveKit Cloud or a custom server.
                  </p>
                ) : (
                  <p className="settings-hint">
                    Carries microphone audio between your browser and OpenConfer. Paste LiveKit Cloud
                    credentials here, or run openconfer serve for local defaults.
                  </p>
                )}
                <label className="field-label" htmlFor="lk-url">
                  LiveKit URL
                </label>
                <input
                  id="lk-url"
                  className="field-input"
                  value={livekitUrl}
                  onChange={(e) => setLivekitUrl(e.target.value)}
                  placeholder="ws://127.0.0.1:7880 or wss://….livekit.cloud"
                />
                <label className="field-label" htmlFor="lk-public">
                  Browser-facing URL (optional)
                </label>
                <input
                  id="lk-public"
                  className="field-input"
                  value={livekitPublicUrl}
                  onChange={(e) => setLivekitPublicUrl(e.target.value)}
                  placeholder="Usually the same as above"
                />
                <SecretField
                  id="lk-key"
                  label="API key"
                  hint={livekitLocalDefaults ? "(local default from serve)" : undefined}
                  value={livekitKey}
                  onChange={setLivekitKey}
                  placeholder="API key"
                  savedPreview={
                    livekitLocalDefaults || settings.conversation.livekit_api_key_configured
                      ? settings.conversation.livekit_api_key_preview ||
                        (livekitLocalDefaults ? "…vkey" : SAVED_SECRET_PREVIEW)
                      : undefined
                  }
                />
                <SecretField
                  id="lk-secret"
                  label="API secret"
                  hint={livekitLocalDefaults ? "(local default from serve)" : undefined}
                  value={livekitSecret}
                  onChange={setLivekitSecret}
                  placeholder="API secret"
                  savedPreview={
                    livekitLocalDefaults || settings.conversation.livekit_api_secret_configured
                      ? livekitLocalDefaults
                        ? "…cret"
                        : SAVED_SECRET_PREVIEW
                      : undefined
                  }
                />
              </details>

              <div className="settings-actions">
                <Button type="submit" disabled={saving}>
                  Save voice settings
                </Button>
              </div>
            </form>
          )}

          {settings && section === "status" && (
            <div className="settings-panel">
              <h2>Status</h2>
              <p className="settings-lead">
                Quick health check. Config file: <code className="inline-code">{settings.config_path}</code>
              </p>
              <ul className="settings-status-list">
                <li>
                  <span>Access key</span>
                  <Badge variant="success">Ready {settings.auth.api_token_preview}</Badge>
                </li>
                <li>
                  <span>Alerts</span>
                  <Badge variant="active">{settings.routes.default.notify.join(" · ")}</Badge>
                </li>
                <li>
                  <span>Voice room (LiveKit)</span>
                  <Badge
                    variant={
                      roomStatus === "ready" ? "success" : roomStatus === "unreachable" ? "urgent" : "default"
                    }
                  >
                    {liveKitStatusLabel(roomStatus)}
                  </Badge>
                </li>
                <li>
                  <span>Speaking agent</span>
                  <Badge variant={speakingReady ? "success" : "urgent"}>
                    {speakingReady
                      ? speakingSummary || speakingStatusLabel(speakingStatus)
                      : speakingStatusLabel(speakingStatus)}
                  </Badge>
                </li>
                <li>
                  <span>Voice overall</span>
                  <Badge variant={voiceReady ? "success" : "urgent"}>
                    {voiceReady ? "Ready" : "Incomplete"}
                  </Badge>
                </li>
                <li>
                  <span>Phone call (Twilio)</span>
                  <Badge variant={settings.status.twilio === "ready" ? "success" : "default"}>
                    {settings.status.twilio === "ready"
                      ? "Ready"
                      : settings.status.twilio === "missing_config"
                        ? "Needs setup"
                        : settings.status.twilio === "needs_livekit_voice"
                          ? "Needs LiveKit voice"
                          : "Off"}
                  </Badge>
                </li>
              </ul>
            </div>
          )}

          {settings && section === "advanced" && (
            <form className="settings-panel" onSubmit={saveAdvanced}>
              <h2>Advanced</h2>
              <p className="settings-lead">
                Addresses agents and join links use. Prefer <code className="inline-code">127.0.0.1</code>{" "}
                on Mac.
              </p>
              <label className="field-label" htmlFor="base-url">
                API address
              </label>
              <input
                id="base-url"
                className="field-input"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                required
              />
              <label className="field-label" htmlFor="web-url">
                Web app address
              </label>
              <input
                id="web-url"
                className="field-input"
                value={webUrl}
                onChange={(e) => setWebUrl(e.target.value)}
                required
              />
              <div className="settings-actions">
                <Button type="submit" disabled={saving}>
                  Save
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
