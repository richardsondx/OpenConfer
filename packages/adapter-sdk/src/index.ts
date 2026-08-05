import type { ConferSession } from "@openconfer/core";

export interface NotifyResult {
  success: boolean;
  channel: string;
  joinUrl?: string;
  message?: string;
  error?: string;
}

export interface NotifierAdapter {
  readonly name: string;
  notify(session: ConferSession, joinUrl: string): Promise<NotifyResult>;
  test?(): Promise<{ ok: boolean; message: string }>;
}

export interface ConversationRoom {
  roomName: string;
  token?: string;
  url?: string;
}

export type ConversationSurface = "browser" | "phone";

export interface CreateConversationRoomOptions {
  roomName?: string;
  /** The operator-facing surface attached to the room. Defaults to browser. */
  surface?: ConversationSurface;
}

export interface ConversationAdapter {
  readonly name: string;
  createRoom(session: ConferSession, options?: CreateConversationRoomOptions): Promise<ConversationRoom>;
  /** Accepts either a session id (legacy browser room) or a complete room name. */
  endRoom(sessionIdOrRoomName: string): Promise<void>;
  test?(): Promise<{ ok: boolean; message: string }>;
}

export interface TelephonyCallResult {
  success: boolean;
  channel: string;
  callId?: string;
  message?: string;
  error?: string;
  retryable?: boolean;
}

export interface TelephonyCallStatusResult {
  success: boolean;
  status?: string;
  answeredBy?: string;
  error?: string;
}

/**
 * Connects a conventional phone call to an already-created conversation room.
 * Keeping this separate from ConversationAdapter lets agent harnesses continue
 * to own the conversation while providers such as Twilio only supply transport.
 */
export interface TelephonyAdapter {
  readonly name: string;
  call(session: ConferSession, room: ConversationRoom): Promise<TelephonyCallResult>;
  status?(callId: string): Promise<TelephonyCallStatusResult>;
  cancel?(callId: string): Promise<{ success: boolean; error?: string }>;
  test?(): Promise<{ ok: boolean; message: string }>;
}

export interface StorageAdapter {
  readonly name: string;
}

export type AdapterKind =
  | "conversation"
  | "notification"
  | "telephony"
  | "model"
  | "stt"
  | "tts"
  | "storage"
  | "authentication"
  | "event_sink";

export interface AdapterInfo {
  name: string;
  kind: AdapterKind;
  description: string;
}
