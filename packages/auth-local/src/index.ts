import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

export function generateApiToken(): string {
  return `oc_${randomBytes(32).toString("hex")}`;
}

export function verifyApiToken(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function generateJoinToken(): string {
  return randomBytes(24).toString("base64url");
}

export async function signJoinJwt(
  payload: { sessionId: string; joinToken: string },
  secret: string,
  expiresIn: string | number = "15m",
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  const expiration = typeof expiresIn === "number" ? `${expiresIn}s` : expiresIn;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiration)
    .sign(key);
}

export async function verifyJoinJwt(
  token: string,
  secret: string,
): Promise<{ sessionId: string; joinToken: string } | null> {
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key);
    return {
      sessionId: payload.sessionId as string,
      joinToken: payload.joinToken as string,
    };
  } catch {
    return null;
  }
}

export function signWebhookPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function webhookSignatureInput(
  timestamp: string,
  eventId: string,
  payload: string,
): string {
  return `${timestamp}.${eventId}.${payload}`;
}

export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  const expected = signWebhookPayload(payload, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Reject webhook timestamps outside the replay window (default 5 minutes). */
export function isWebhookTimestampFresh(
  timestamp: string,
  now = Date.now(),
  maxSkewMs = 5 * 60_000,
): boolean {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) return false;
  return Math.abs(now - value) <= maxSkewMs;
}

export function verifySignedWebhook(params: {
  timestamp: string;
  eventId: string;
  body: string;
  signature: string;
  secret: string;
  now?: number;
  maxSkewMs?: number;
}): boolean {
  if (!isWebhookTimestampFresh(params.timestamp, params.now, params.maxSkewMs)) return false;
  return verifyWebhookSignature(
    webhookSignatureInput(params.timestamp, params.eventId, params.body),
    params.signature,
    params.secret,
  );
}
