import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = 9090;
const WEBHOOK_SECRET = process.env.OPENCONFER_WEBHOOK_SECRET ?? "demo-webhook-secret-change-me";
const BASE_URL = process.env.OPENCONFER_BASE_URL ?? "http://localhost:8787";
const seenEvents = new Set();

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/openconfer/events") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const timestamp = req.headers["x-openconfer-timestamp"];
    const eventId = req.headers["x-openconfer-event-id"];
    const signature = req.headers["x-openconfer-signature"];
    if (!verifyWebhook(body, timestamp, eventId, signature)) {
      res.writeHead(401);
      res.end("Invalid webhook signature");
      return;
    }
    if (seenEvents.has(eventId)) {
      res.writeHead(200);
      res.end(JSON.stringify({ received: true, duplicate: true }));
      return;
    }
    seenEvents.add(eventId);
    console.log("\n--- Webhook received ---");
    console.log(body);
    const payload = JSON.parse(body);
    console.log(`Session ${payload.session_id}: ${payload.status}`);

    if (payload.session_id) {
      const token = loadToken();
      if (token) {
        setTimeout(async () => {
          const ackRes = await fetch(
            `${BASE_URL}/v1/sessions/${payload.session_id}/ack`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({ run_id: payload.continuation?.run_id }),
            },
          );
          console.log(`Ack sent: ${ackRes.status}`);
          console.log("Originating agent resumed.\n");
        }, 1000);
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ received: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});

function loadToken() {
  if (process.env.OPENCONFER_API_TOKEN) return process.env.OPENCONFER_API_TOKEN;
  try {
    const configPath = process.env.OPENCONFER_CONFIG ?? join(homedir(), ".openconfer", "config.yaml");
    if (!existsSync(configPath)) return null;
    const content = readFileSync(configPath, "utf8");
    const match = /api_token:\s*(\S+)/.exec(content);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function verifyWebhook(body, timestamp, eventId, signature) {
  if (!timestamp || !eventId || !signature) return false;
  const age = Math.abs(Date.now() - Date.parse(timestamp));
  if (!Number.isFinite(age) || age > 5 * 60_000) return false;
  const expected = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${eventId}.${body}`)
    .digest("hex");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

server.listen(PORT, () => {
  console.log(`Example harness webhook listening on http://localhost:${PORT}/openconfer/events`);
});
