import { useEffect, useRef, useState } from "react";
import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  createAudioAnalyser,
  type LocalAudioTrack,
  type RemoteAudioTrack,
  type RemoteParticipant,
} from "livekit-client";
import {
  parseDecisionSignal,
  type DecisionSignal,
  type UnderstoodDecision,
} from "../lib/decision-signal";
import type { JoinSession } from "../lib/types";
import { AgentPresence, type AgentPresenceState } from "./AgentPresence";
import { Button } from "./primitives";
import { VoiceUnderstoodPreview } from "./VoiceUnderstoodPreview";

export interface RoomCredentials {
  url: string;
  token: string;
}

export type { DecisionSignal };

function isAgentParticipant(participant: RemoteParticipant): boolean {
  if (participant.isAgent) return true;
  const identity = participant.identity.toLowerCase();
  return identity.includes("agent") || identity.includes("openconfer");
}

function MicrophoneIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2a3.5 3.5 0 0 0-3.5 3.5v7a3.5 3.5 0 1 0 7 0v-7A3.5 3.5 0 0 0 12 2Z"
        fill="currentColor"
      />
      <path
        d="M6.5 11.5a.75.75 0 0 0-1.5 0 7 7 0 0 0 6.25 6.96V21a.75.75 0 0 0 1.5 0v-2.54A7 7 0 0 0 19 11.5a.75.75 0 0 0-1.5 0 5.5 5.5 0 1 1-11 0Z"
        fill="currentColor"
      />
    </svg>
  );
}

function startMicLevelWatch(
  track: LocalAudioTrack,
  onLevel: (level: number) => void,
): (() => void) | null {
  try {
    const { calculateVolume, cleanup } = createAudioAnalyser(track, {
      smoothingTimeConstant: 0.65,
      fftSize: 256,
    });
    let frame = 0;
    let lastLevel = -1;
    const tick = () => {
      const volume = calculateVolume();
      const speaking = volume > 0.015;
      const level = speaking ? Math.min(1, volume * 4) : volume * 0.35;
      if (Math.abs(level - lastLevel) > 0.02) {
        lastLevel = level;
        onLevel(level);
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame);
      void cleanup();
      onLevel(0);
    };
  } catch {
    // AudioContext can fail before a user gesture; keep the mic icon without levels.
    return null;
  }
}

export function VoiceSession({
  credentials,
  onConnected,
  onDecisionSignal,
  objective,
  understood,
  sessionType = "decision",
  options,
}: {
  credentials?: RoomCredentials;
  onConnected?: () => void;
  onDecisionSignal?: (signal: DecisionSignal) => void;
  objective?: string;
  /** Live agent understanding before submit (not yet saved). */
  understood?: UnderstoodDecision | null;
  sessionType?: JoinSession["type"];
  options?: JoinSession["brief"]["options"];
}) {
  const roomRef = useRef<Room | null>(null);
  const audioMountRef = useRef<HTMLDivElement | null>(null);
  const analyserCleanupRef = useRef<(() => void) | null>(null);
  const micAnalyserCleanupRef = useRef<(() => void) | null>(null);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;
  const onDecisionSignalRef = useRef(onDecisionSignal);
  onDecisionSignalRef.current = onDecisionSignal;

  const [connection, setConnection] = useState<ConnectionState>(ConnectionState.Disconnected);
  const [microphone, setMicrophone] = useState<"off" | "starting" | "on" | "blocked">("off");
  const [micLevel, setMicLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [agentPresent, setAgentPresent] = useState(false);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [agentLevel, setAgentLevel] = useState(0);

  useEffect(() => {
    if (!credentials) return;
    const room = new Room({
      audioCaptureDefaults: { autoGainControl: true, echoCancellation: true, noiseSuppression: true },
    });
    roomRef.current = room;
    const attached = new Set<HTMLMediaElement>();

    const refreshAgentPresence = () => {
      const agents = [...room.remoteParticipants.values()].filter(isAgentParticipant);
      setAgentPresent(agents.length > 0);
    };

    const detachAnalyser = () => {
      analyserCleanupRef.current?.();
      analyserCleanupRef.current = null;
      setAgentLevel(0);
      setAgentSpeaking(false);
    };

    const detachMicAnalyser = () => {
      micAnalyserCleanupRef.current?.();
      micAnalyserCleanupRef.current = null;
      setMicLevel(0);
    };

    const watchAgentAudio = (track: RemoteAudioTrack) => {
      detachAnalyser();
      const { calculateVolume, cleanup } = createAudioAnalyser(track, {
        smoothingTimeConstant: 0.7,
        fftSize: 256,
      });
      let frame = 0;
      let lastSpeak = false;
      let lastLevel = -1;
      const tick = () => {
        const volume = calculateVolume();
        const speaking = volume > 0.02;
        const level = speaking ? Math.min(1, volume * 3) : volume * 0.4;
        if (speaking !== lastSpeak) {
          lastSpeak = speaking;
          setAgentSpeaking(speaking);
        }
        if (Math.abs(level - lastLevel) > 0.03) {
          lastLevel = level;
          setAgentLevel(level);
        }
        frame = window.requestAnimationFrame(tick);
      };
      frame = window.requestAnimationFrame(tick);
      analyserCleanupRef.current = () => {
        window.cancelAnimationFrame(frame);
        void cleanup();
      };
    };

    const watchLocalMic = (track: LocalAudioTrack) => {
      detachMicAnalyser();
      micAnalyserCleanupRef.current = startMicLevelWatch(track, setMicLevel);
    };

    const markLocalSpeaking = (speakers: { isLocal?: boolean }[]) => {
      // Fallback when AudioContext analyser is unavailable (autoplay policy).
      if (micAnalyserCleanupRef.current) return;
      const localSpeaking = speakers.some((speaker) => speaker.isLocal);
      setMicLevel(localSpeaking ? 0.55 : 0);
    };

    const startLocalMicWatch = () => {
      const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      const track = publication?.track;
      if (track && track.kind === Track.Kind.Audio) {
        watchLocalMic(track as LocalAudioTrack);
      }
    };

    const updateConnection = (state: ConnectionState) => setConnection(state);

    room.on(RoomEvent.ConnectionStateChanged, updateConnection);
    room.on(RoomEvent.Connected, () => {
      onConnectedRef.current?.();
      refreshAgentPresence();
      void room.startAudio().then(() => setAudioBlocked(!room.canPlaybackAudio));
      room.localParticipant
        .setMicrophoneEnabled(true)
        .then(() => {
          setMicrophone("on");
          startLocalMicWatch();
        })
        .catch((reason: unknown) => {
          setMicrophone("blocked");
          setError(reason instanceof Error ? reason.message : "Microphone permission was not granted.");
        });
    });
    room.on(RoomEvent.LocalTrackPublished, (publication) => {
      if (publication.source === Track.Source.Microphone && publication.track?.kind === Track.Kind.Audio) {
        setMicrophone("on");
        watchLocalMic(publication.track as LocalAudioTrack);
      }
    });
    room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
      if (publication.source === Track.Source.Microphone) {
        detachMicAnalyser();
      }
    });
    room.on(RoomEvent.ParticipantConnected, () => refreshAgentPresence());
    room.on(RoomEvent.ParticipantDisconnected, () => {
      refreshAgentPresence();
      detachAnalyser();
    });
    room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (track.kind !== Track.Kind.Audio) return;
      const remote = track as RemoteAudioTrack;
      // Always attach remote audio so the operator can hear the agent.
      const element = remote.attach();
      element.autoplay = true;
      element.setAttribute("playsinline", "true");
      element.style.display = "none";
      (audioMountRef.current ?? document.body).appendChild(element);
      attached.add(element);
      void room.startAudio().then(() => setAudioBlocked(!room.canPlaybackAudio));
      if (isAgentParticipant(participant) || room.remoteParticipants.size === 1) {
        watchAgentAudio(remote);
      }
      refreshAgentPresence();
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((element) => {
        element.remove();
        attached.delete(element);
      });
      detachAnalyser();
    });
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      markLocalSpeaking(speakers);
      const agentSpeakingNow = speakers.some(
        (speaker) => !speaker.isLocal && isAgentParticipant(speaker as RemoteParticipant),
      );
      if (agentSpeakingNow) setAgentSpeaking(true);
    });
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => setAudioBlocked(!room.canPlaybackAudio));
    room.on(RoomEvent.Reconnecting, () => setConnection(ConnectionState.Reconnecting));
    const onData = (payload: Uint8Array) => {
      const signal = parseDecisionSignal(payload);
      if (signal) onDecisionSignalRef.current?.(signal);
    };
    room.on(RoomEvent.DataReceived, onData);

    setMicrophone("starting");
    room.connect(credentials.url, credentials.token).catch((reason: unknown) => {
      setMicrophone("off");
      setError(reason instanceof Error ? reason.message : "Could not connect to the voice room.");
    });

    return () => {
      detachAnalyser();
      detachMicAnalyser();
      for (const element of attached) element.remove();
      attached.clear();
      room.off(RoomEvent.ConnectionStateChanged, updateConnection);
      room.off(RoomEvent.DataReceived, onData);
      room.disconnect();
      roomRef.current = null;
    };
  }, [credentials]);

  if (!credentials) {
    return (
      <section className="voice-panel fallback-panel" aria-labelledby="fallback-heading">
        <h2 id="fallback-heading">Voice room unavailable</h2>
        <p>
          No LiveKit room URL and token were provided, so this is not a call yet. Open Settings → Voice,
          confirm LiveKit is running (<code className="inline-code">openconfer serve</code>), then leave
          and join again.
        </p>
      </section>
    );
  }

  const enableMicrophone = async () => {
    const room = roomRef.current;
    if (!room) return;
    setMicrophone("starting");
    setError(null);
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
      setMicrophone("on");
      const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      const track = publication?.track;
      if (track && track.kind === Track.Kind.Audio) {
        micAnalyserCleanupRef.current?.();
        micAnalyserCleanupRef.current = startMicLevelWatch(track as LocalAudioTrack, setMicLevel);
      }
    } catch (reason) {
      setMicrophone("blocked");
      setError(reason instanceof Error ? reason.message : "Microphone permission was not granted.");
    }
  };

  const enableAudio = async () => {
    const room = roomRef.current;
    if (!room) return;
    await room.startAudio();
    setAudioBlocked(!room.canPlaybackAudio);
  };

  const connected = connection === ConnectionState.Connected;
  const micHearing = microphone === "on" && micLevel > 0.08;
  const presenceState: AgentPresenceState = !connected
    ? "waiting"
    : agentSpeaking
      ? "speaking"
      : agentPresent
        ? microphone === "on"
          ? "listening"
          : "joined"
        : "waiting";

  const statusCopy = !connected
    ? connection === ConnectionState.Reconnecting
      ? "Reconnecting…"
      : connection === ConnectionState.Connecting
        ? "Connecting…"
        : "Disconnected"
    : audioBlocked
      ? "Tap Enable agent audio to hear the agent"
      : !agentPresent
        ? "Waiting for the speaking agent to join the room…"
        : microphone === "on"
          ? "Say hello — the agent should answer out loud"
          : "Enable your microphone to talk";

  return (
    <section className="voice-stage" aria-labelledby="voice-heading">
      <div ref={audioMountRef} className="voice-audio-mount" hidden />
      <AgentPresence state={presenceState} level={agentLevel} />
      <div className="voice-stage-main">
        <h2 id="voice-heading">On a call</h2>
        <p className="voice-stage-prompt">
          {objective
            ? `Speak your decision about: ${objective}`
            : "Speak your decision. The agent will record it and send it back."}
        </p>
        <p className="connection-status" role="status">
          {statusCopy}
        </p>
      </div>
      {understood && (
        <VoiceUnderstoodPreview
          key={
            JSON.stringify(understood.result) +
            (understood.summary ?? "") +
            JSON.stringify(understood.captured_context ?? {})
          }
          understood={understood}
          sessionType={sessionType}
          options={options}
        />
      )}
      <div className="voice-stage-actions">
        {audioBlocked && (
          <Button variant="secondary" onClick={enableAudio}>
            Enable agent audio
          </Button>
        )}
        {microphone === "on" ? (
          <div
            className={`mic-indicator${micHearing ? " is-hearing" : ""}`}
            role="status"
            aria-live="polite"
            aria-label={micHearing ? "Microphone hearing you" : "Microphone ready"}
            title={micHearing ? "Hearing you" : "Microphone ready"}
            style={{ ["--mic-level" as string]: Math.min(1, micLevel).toFixed(3) }}
          >
            <span className="mic-indicator-ring" aria-hidden="true" />
            <span className="mic-indicator-ring mic-indicator-ring-delay" aria-hidden="true" />
            <span className="mic-indicator-icon" aria-hidden="true">
              <MicrophoneIcon />
            </span>
            <span className="sr-only">{micHearing ? "Hearing you" : "Microphone ready"}</span>
          </div>
        ) : (
          <Button
            variant="secondary"
            onClick={enableMicrophone}
            disabled={!connected || microphone === "starting"}
          >
            {microphone === "starting"
              ? "Starting microphone…"
              : microphone === "blocked"
                ? "Retry microphone"
                : "Enable microphone"}
          </Button>
        )}
      </div>
      {error && error !== "Client initiated disconnect" && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
