import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applySpeakingPreset,
  ConfigSchema,
  normalizeSpeakingFields,
  resolveSpeakingReady,
  validateResultAgainstSchema,
} from "./index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../");
const approval = JSON.parse(readFileSync(join(root, "examples/approval-checkpoint/session.json"), "utf8"));
const standup = JSON.parse(readFileSync(join(root, "examples/daily-standup/session.json"), "utf8"));
const decision = JSON.parse(readFileSync(join(root, "examples/decision-session/session.json"), "utf8"));

describe("validateResultAgainstSchema", () => {
  const schema = {
    type: "object",
    required: ["selected_option", "constraints"],
    properties: {
      selected_option: { type: "string", enum: ["browser", "phone", "defer"] },
      constraints: { type: "array" },
    },
  };

  it("validates correct result", () => {
    const result = validateResultAgainstSchema(
      { selected_option: "browser", constraints: ["no mobile"] },
      schema,
    );
    expect(result.valid).toBe(true);
  });

  it("rejects missing required fields", () => {
    const result = validateResultAgainstSchema({ selected_option: "browser" }, schema);
    expect(result.valid).toBe(false);
  });

  it("supports standard JSON Schema constraints", () => {
    const result = validateResultAgainstSchema(
      { count: 1, tags: ["duplicate", "duplicate"] },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          count: { type: "integer", minimum: 2 },
          tags: { type: "array", uniqueItems: true },
        },
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects invalid JSON Schemas", () => {
    expect(validateResultAgainstSchema({}, { type: "not-a-type" }).valid).toBe(false);
  });

  it("validates the packaged example schemas", () => {
    expect(validateResultAgainstSchema({ approved: true }, approval.result_schema).valid).toBe(true);
    expect(
      validateResultAgainstSchema(
        { decisions: ["Focus"], next_actions: ["Test"] },
        standup.result_schema,
      ).valid,
    ).toBe(true);
    expect(
      validateResultAgainstSchema(
        { selected_option: "browser", constraints: [] },
        decision.result_schema,
      ).valid,
    ).toBe(true);
  });

  it("enforces nested objects, arrays of objects, ranges, and empty required values", () => {
    expect(
      validateResultAgainstSchema(
        { nested: { count: 1 }, items: [{ name: "a" }] },
        {
          type: "object",
          required: ["nested", "items"],
          properties: {
            nested: {
              type: "object",
              required: ["count"],
              properties: { count: { type: "integer", minimum: 2, maximum: 5 } },
            },
            items: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["name"],
                properties: { name: { type: "string", minLength: 1 } },
              },
            },
          },
        },
      ).valid,
    ).toBe(false);

    expect(
      validateResultAgainstSchema(
        { title: "" },
        {
          type: "object",
          required: ["title"],
          properties: { title: { type: "string", minLength: 1 }, optional: { type: "string" } },
        },
      ).valid,
    ).toBe(false);

    expect(
      validateResultAgainstSchema(
        { title: "ok" },
        {
          type: "object",
          required: ["title"],
          properties: { title: { type: "string", minLength: 1 }, optional: { type: "string" } },
        },
      ).valid,
    ).toBe(true);
  });

  it("migrates legacy conversation model/voice/openai_api_key into live realtime", () => {
    const speaking = normalizeSpeakingFields({
      model: "gpt-realtime-mini",
      voice: "cedar",
      openai_api_key: "sk-legacy",
    });
    expect(speaking.speaking_mode).toBe("realtime");
    expect(speaking.preset).toBe("live");
    expect(speaking.realtime.model).toBe("gpt-realtime-mini");
    expect(speaking.realtime.voice).toBe("cedar");
    expect(speaking.realtime.api_key).toBe("sk-legacy");
    expect(speaking.openai_api_key).toBe("sk-legacy");
  });

  it("applies flexible and local speaking presets", () => {
    const flexible = applySpeakingPreset("flexible", {});
    expect(flexible.speaking_mode).toBe("pipeline");
    expect(flexible.stt.provider).toBe("deepgram");
    expect(flexible.llm.provider).toBe("openrouter");
    expect(flexible.tts.provider).toBe("cartesia");

    const local = applySpeakingPreset("local", {});
    expect(local.speaking_mode).toBe("pipeline");
    expect(local.llm.provider).toBe("ollama");
    expect(local.llm.base_url).toContain("11434");
  });

  it("parses ConfigSchema with legacy conversation YAML", () => {
    const config = ConfigSchema.parse({
      server: { base_url: "http://127.0.0.1:8787" },
      storage: { adapter: "sqlite", path: "/tmp/oc.db" },
      conversation: {
        adapter: "livekit",
        model: "gpt-realtime",
        voice: "marin",
        openai_api_key: "sk-test",
      },
      auth: {},
    });
    expect(config.conversation.speaking_mode).toBe("realtime");
    expect(config.conversation.preset).toBe("live");
    expect(config.conversation.realtime.api_key).toBe("sk-test");
    expect(resolveSpeakingReady(config.conversation)).toBe("ready");
  });

  it("parses Twilio telephony config and requires E.164 phone numbers", () => {
    const base = {
      server: { base_url: "http://127.0.0.1:8787" },
      storage: { adapter: "sqlite" as const, path: "/tmp/oc.db" },
      conversation: { adapter: "livekit" },
      auth: {},
    };
    const telephony = {
      adapter: "twilio" as const,
      twilio: {
        account_sid: "AC0123456789abcdef0123456789abcdef",
        auth_token: "secret",
        from_number: "+14165550100",
        destination_number: "+14165550101",
      },
    };
    expect(ConfigSchema.parse({ ...base, telephony }).telephony?.twilio.destination_number).toBe(
      "+14165550101",
    );
    expect(() =>
      ConfigSchema.parse({
        ...base,
        telephony: {
          ...telephony,
          twilio: { ...telephony.twilio, destination_number: "4165550101" },
        },
      }),
    ).toThrow(/E\.164/);
  });

  it("reports missing pipeline credentials", () => {
    const speaking = applySpeakingPreset("flexible", {});
    expect(resolveSpeakingReady(speaking)).toBe("missing_credentials");
    expect(
      resolveSpeakingReady({
        ...speaking,
        stt: { ...speaking.stt, api_key: "dg" },
        llm: { ...speaking.llm, api_key: "or" },
        tts: { ...speaking.tts, api_key: "cart" },
      }),
    ).toBe("ready");
  });

  it("supports oneOf, anyOf, nullable, and additionalProperties", () => {
    expect(
      validateResultAgainstSchema(
        { mode: "a" },
        { type: "object", properties: { mode: { oneOf: [{ const: "a" }, { type: "integer" }] } } },
      ).valid,
    ).toBe(true);
    expect(
      validateResultAgainstSchema(
        { mode: true },
        { type: "object", properties: { mode: { anyOf: [{ type: "string" }, { type: "number" }] } } },
      ).valid,
    ).toBe(false);
    expect(
      validateResultAgainstSchema(
        { note: null },
        { type: "object", properties: { note: { type: ["string", "null"] } } },
      ).valid,
    ).toBe(true);
    expect(
      validateResultAgainstSchema(
        { ok: true, extra: 1 },
        { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } } },
      ).valid,
    ).toBe(false);
  });
});
