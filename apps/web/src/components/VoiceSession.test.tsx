import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceSession } from "./VoiceSession";

type Handler = (...args: unknown[]) => void;

const {
  ConnectionState,
  RoomEvent,
  Track,
  roomState,
  emit,
} = vi.hoisted(() => {
  const ConnectionState = {
    Disconnected: "disconnected",
    Connecting: "connecting",
    Connected: "connected",
    Reconnecting: "reconnecting",
  } as const;

  const RoomEvent = {
    ConnectionStateChanged: "connectionStateChanged",
    Connected: "connected",
    LocalTrackPublished: "localTrackPublished",
    LocalTrackUnpublished: "localTrackUnpublished",
    ParticipantConnected: "participantConnected",
    ParticipantDisconnected: "participantDisconnected",
    TrackSubscribed: "trackSubscribed",
    TrackUnsubscribed: "trackUnsubscribed",
    ActiveSpeakersChanged: "activeSpeakersChanged",
    AudioPlaybackStatusChanged: "audioPlaybackStatusChanged",
    Reconnecting: "reconnecting",
    DataReceived: "dataReceived",
  } as const;

  const Track = {
    Kind: { Audio: "audio", Video: "video" },
    Source: { Microphone: "microphone", Camera: "camera" },
  } as const;

  const roomState = {
    handlers: new Map<string, Handler[]>(),
    localMicTrack: { kind: "audio" } as { kind: string } | undefined,
    calculateVolume: () => 0 as number,
    micEnableImpl: async () => undefined as void,
    connectImpl: async () => undefined as void,
  };

  function emit(event: string, ...args: unknown[]) {
    for (const handler of roomState.handlers.get(event) ?? []) {
      handler(...args);
    }
  }

  roomState.connectImpl = async () => {
    emit(RoomEvent.ConnectionStateChanged, ConnectionState.Connected);
    emit(RoomEvent.Connected);
  };

  return { ConnectionState, RoomEvent, Track, roomState, emit };
});

vi.mock("livekit-client", () => {
  class Room {
    localParticipant = {
      setMicrophoneEnabled: vi.fn(() => roomState.micEnableImpl()),
      getTrackPublication: vi.fn(() =>
        roomState.localMicTrack ? { track: roomState.localMicTrack } : undefined,
      ),
    };
    remoteParticipants = new Map();
    canPlaybackAudio = true;

    constructor() {
      roomState.handlers = new Map();
    }

    on(event: string, handler: Handler) {
      const list = roomState.handlers.get(event) ?? [];
      list.push(handler);
      roomState.handlers.set(event, list);
      return this;
    }

    off(event: string, handler: Handler) {
      const list = roomState.handlers.get(event) ?? [];
      roomState.handlers.set(
        event,
        list.filter((entry) => entry !== handler),
      );
      return this;
    }

    connect = vi.fn(() => roomState.connectImpl());
    disconnect = vi.fn();
    startAudio = vi.fn(async () => undefined);
  }

  return {
    ConnectionState,
    Room,
    RoomEvent,
    Track,
    createAudioAnalyser: vi.fn(() => ({
      calculateVolume: () => roomState.calculateVolume(),
      cleanup: vi.fn(),
    })),
  };
});

describe("VoiceSession", () => {
  beforeEach(() => {
    roomState.handlers = new Map();
    roomState.localMicTrack = { kind: Track.Kind.Audio };
    roomState.calculateVolume = () => 0;
    roomState.micEnableImpl = async () => undefined;
    roomState.connectImpl = async () => {
      emit(RoomEvent.ConnectionStateChanged, ConnectionState.Connected);
      emit(RoomEvent.Connected);
    };
    vi.stubGlobal(
      "requestAnimationFrame",
      (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0) as unknown as number,
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  });

  it("shows a microphone icon when the mic is ready, not Microphone on text", async () => {
    render(
      <VoiceSession
        credentials={{ url: "ws://127.0.0.1:7880", token: "test-token" }}
        objective="Should we order pizza or tacos for lunch?"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("status", { name: /microphone ready/i })).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: /microphone on/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Microphone on")).not.toBeInTheDocument();
    expect(document.querySelector(".mic-indicator")).toBeTruthy();
    expect(document.querySelector(".mic-indicator-icon svg")).toBeTruthy();
  });

  it("animates the mic indicator when local audio energy is detected", async () => {
    roomState.calculateVolume = () => 0.2;

    render(
      <VoiceSession credentials={{ url: "ws://127.0.0.1:7880", token: "test-token" }} />,
    );

    await waitFor(() => {
      expect(screen.getByRole("status", { name: /microphone hearing you/i })).toBeInTheDocument();
    });

    const indicator = document.querySelector(".mic-indicator");
    expect(indicator?.classList.contains("is-hearing")).toBe(true);
    expect((indicator as HTMLElement).style.getPropertyValue("--mic-level")).not.toBe("0.000");
  });

  it("keeps a retry button when the microphone is blocked", async () => {
    roomState.micEnableImpl = async () => {
      throw new Error("Permission denied");
    };
    roomState.localMicTrack = undefined;

    render(
      <VoiceSession credentials={{ url: "ws://127.0.0.1:7880", token: "blocked-token" }} />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /retry microphone/i })).toBeInTheDocument();
    });

    expect(document.querySelector(".mic-indicator")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(/permission denied/i);
  });

  it("shows starting state before the room connects", () => {
    roomState.connectImpl = () => new Promise(() => undefined);

    render(
      <VoiceSession credentials={{ url: "ws://127.0.0.1:7880", token: "pending-token" }} />,
    );

    expect(screen.getByRole("button", { name: /starting microphone/i })).toBeInTheDocument();
    expect(document.querySelector(".mic-indicator")).toBeNull();
  });
});
