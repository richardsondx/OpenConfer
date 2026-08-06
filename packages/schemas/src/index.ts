import { z } from "zod";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import {
  DEFAULT_CARTESIA_VOICE,
  DEFAULT_ELEVENLABS_VOICE,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OPENROUTER_BASE_URL,
  DEFAULT_REALTIME_MODEL,
  normalizeSpeakingFields,
  type SpeakingConversationFields,
} from "./speaking.js";

export * from "./speaking.js";

const resultValidator = new Ajv2020({ allErrors: true, strict: false });

export const InitiatorSchema = z.object({
  agent_id: z.string().min(1),
  harness: z.string().min(1),
  project: z.string().optional(),
});

export const ParticipantSchema = z.object({
  operator_id: z.string().min(1),
});

export const BriefSchema = z.object({
  reason: z.string().min(1),
  completed: z.array(z.string()).optional(),
  recommendation: z.string().optional(),
  options: z
    .array(z.object({ id: z.string(), label: z.string() }))
    .optional(),
  context: z.string().optional(),
  consequence_of_delay: z.string().optional(),
});

export const ContinuationSchema = z.object({
  run_id: z.string().min(1),
  opaque_token: z.string().optional(),
});

export const CallbackSchema = z.object({
  url: z.string().url(),
  secret: z.string().min(16).optional(),
});

const ContinuityTextArraySchema = z
  .array(z.string().trim().min(1).max(500))
  .max(20)
  .default([]);

export const ContinuityPersonalitySchema = z
  .object({
    identity_statement: z.string().trim().min(1).max(1_000),
    tone: ContinuityTextArraySchema,
    speaking_style: ContinuityTextArraySchema,
    interaction_style: ContinuityTextArraySchema,
    values: ContinuityTextArraySchema,
    preferred_phrasing: ContinuityTextArraySchema,
    disallowed_phrasing: ContinuityTextArraySchema,
    greeting_policy: z.string().trim().min(1).max(1_000).optional(),
    uncertainty_style: z.string().trim().min(1).max(1_000).optional(),
    humor_style: z.string().trim().min(1).max(1_000).optional(),
    verbosity: z.enum(["terse", "balanced", "detailed"]).optional(),
    relationship_behavior: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();

export const ContinuityMemorySchema = z
  .object({
    provider: z.string().trim().min(1).max(100).optional(),
    connection_id: z.string().trim().min(1).max(200).optional(),
    workspace: z.string().trim().min(1).max(200).optional(),
    user_peer: z.string().trim().min(1).max(200).optional(),
    agent_peer: z.string().trim().min(1).max(200).optional(),
    session_strategy: z
      .enum(["per_call", "per_source_conversation", "per_workspace", "per_project", "global"])
      .default("per_source_conversation"),
    permissions: z
      .array(
        z.enum([
          "identity:read",
          "relationship:read",
          "preferences:read",
          "episodes:search",
          "thread:read",
          "call_summary:write",
          "memory_suggestions:write",
        ]),
      )
      .max(20)
      .default([]),
  })
  .strict();

export const ContinuityRelationshipSchema = z
  .object({
    status: z.enum(["new", "established"]),
    first_interaction: z.boolean(),
    preferred_name: z.string().trim().min(1).max(80).optional(),
    summary: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export const ContinuityThreadSchema = z
  .object({
    topic: z.string().trim().min(1).max(500).optional(),
    summary: z.string().trim().min(1).max(4_000),
    current_goal: z.string().trim().min(1).max(1_000),
    open_questions: ContinuityTextArraySchema,
    decisions_so_far: ContinuityTextArraySchema,
    commitments: ContinuityTextArraySchema,
    last_user_intent: z.string().trim().min(1).max(1_000).optional(),
    last_agent_message: z.string().trim().min(1).max(2_000).optional(),
    handoff_instruction: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();

export const ContinuitySchema = z
  .object({
    continuity_version: z.literal("1.0"),
    agent: z
      .object({
        id: z.string().trim().min(1).max(200),
        name: z.string().trim().min(1).max(200).optional(),
        source: z.string().trim().min(1).max(100).optional(),
        personality_summary: ContinuityPersonalitySchema,
      })
      .strict(),
    relationship: ContinuityRelationshipSchema,
    thread: ContinuityThreadSchema,
    memory: ContinuityMemorySchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const expectedFirstInteraction = value.relationship.status === "new";
    if (value.relationship.first_interaction !== expectedFirstInteraction) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relationship", "first_interaction"],
        message: "Must agree with relationship.status",
      });
    }
  });

export type ContinuityPackage = z.infer<typeof ContinuitySchema>;

export const SessionLocaleSchema = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .refine((value) => {
    try {
      Intl.getCanonicalLocales(value);
      return true;
    } catch {
      return false;
    }
  }, "Must be a valid BCP 47 locale")
  .transform((value) => Intl.getCanonicalLocales(value)[0]!);

export const CreateSessionSchema = z
  .object({
  type: z.enum(["decision", "approval", "briefing", "incident"]).default("decision"),
  locale: SessionLocaleSchema.default("en"),
  initiator: InitiatorSchema,
  participant: ParticipantSchema,
  objective: z.string().min(1),
  brief: BriefSchema,
  result_schema: z.record(z.unknown()),
  routing: z.object({ policy: z.string().default("default") }).default({ policy: "default" }),
  continuation: ContinuationSchema.optional(),
  callback: CallbackSchema.optional(),
  continuity: ContinuitySchema.optional(),
  urgency: z.enum(["normal", "high", "incident"]).default("normal"),
  estimated_duration_minutes: z.number().positive().optional(),
  expires_at: z.string().datetime().optional(),
  idempotency_key: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.continuity) return;
    if (value.continuity.agent.id !== value.initiator.agent_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["continuity", "agent", "id"],
        message: "Must match initiator.agent_id",
      });
    }
    if (JSON.stringify(value.continuity).length > 32_768) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["continuity"],
        message: "Continuity package must be at most 32 KiB",
      });
    }
  });

export type CreateSessionInput = z.infer<typeof CreateSessionSchema>;

export const CapturedContextSchema = z.object({
  steering: z.array(z.string()).default([]),
  additional_instructions: z.array(z.string()).default([]),
  new_requests: z.array(z.string()).default([]),
  unresolved_topics: z.array(z.string()).default([]),
});

export type CapturedContext = z.infer<typeof CapturedContextSchema>;

export const ConfirmResultSchema = z.object({
  result: z.record(z.unknown()),
  summary: z.string().optional(),
  captured_context: CapturedContextSchema.optional(),
  method: z.enum(["session_ui", "text_form", "voice_agent"]).default("session_ui"),
  submission_id: z.string().trim().min(1).max(200).optional(),
  preview_revision: z.number().int().positive().optional(),
});

export const PreviewDecisionSchema = z.object({
  result: z.record(z.unknown()),
  summary: z.string().optional(),
  captured_context: CapturedContextSchema.optional(),
  expected_revision: z.number().int().nonnegative().optional(),
});

export const AckResultSchema = z.object({
  run_id: z.string().optional(),
});

export const ALLOWED_SNOOZE_MINUTES = [1, 3, 5, 10, 15, 30] as const;

export const SnoozeSessionSchema = z.object({
  minutes: z.union([
    z.literal(1),
    z.literal(3),
    z.literal(5),
    z.literal(10),
    z.literal(15),
    z.literal(30),
  ]),
});

const SnoozeMinutesSchema = z.union([
  z.literal(1),
  z.literal(3),
  z.literal(5),
  z.literal(10),
  z.literal(15),
  z.literal(30),
]);

export const OperatorAlertsObjectSchema = z.object({
  style: z.enum(["off", "subtle", "standard"]).default("subtle"),
  sound: z.boolean().default(true),
  browser_notifications: z.boolean().default(false),
  /** Single default snooze duration used by the inbox/join Snooze button. */
  snooze_minutes: SnoozeMinutesSchema.default(3),
  /** Bounded automatic phone callbacks after a missed or disconnected call. */
  phone_retry_policy: z.enum(["never", "brief", "persistent"]).default("brief"),
});

export const OperatorAlertsSchema = z.preprocess((input) => {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  // Migrate older snooze_presets arrays → single default snooze_minutes.
  if (raw.snooze_minutes === undefined && Array.isArray(raw.snooze_presets)) {
    const first = raw.snooze_presets.find((value) => typeof value === "number");
    if (typeof first === "number") {
      return { ...raw, snooze_minutes: first };
    }
  }
  return raw;
}, OperatorAlertsObjectSchema);

export type OperatorAlerts = z.infer<typeof OperatorAlertsObjectSchema>;

export const DEFAULT_OPERATOR_ALERTS: OperatorAlerts = {
  style: "subtle",
  sound: true,
  browser_notifications: false,
  snooze_minutes: 3,
  phone_retry_policy: "brief",
};

const RealtimeConfigSchema = z.object({
  provider: z.literal("openai").default("openai"),
  model: z.string().default(DEFAULT_REALTIME_MODEL),
  voice: z.string().default("marin"),
  api_key: z.string().optional(),
});

const SttConfigSchema = z.object({
  provider: z.enum(["deepgram", "openai"]).default("deepgram"),
  model: z.string().default("nova-3"),
  api_key: z.string().optional(),
});

const LlmConfigSchema = z.object({
  provider: z.enum(["openrouter", "openai", "ollama"]).default("openrouter"),
  model: z.string().default("openai/gpt-4o-mini"),
  base_url: z.string().optional(),
  api_key: z.string().optional(),
});

const TtsConfigSchema = z.object({
  provider: z.enum(["cartesia", "elevenlabs", "openai"]).default("cartesia"),
  model: z.string().default("sonic-3"),
  voice: z.string().default(DEFAULT_CARTESIA_VOICE),
  api_key: z.string().optional(),
});

const ConversationObjectSchema = z.object({
  adapter: z.string().default("livekit"),
  speaking_mode: z.enum(["realtime", "pipeline"]).default("realtime"),
  preset: z.enum(["live", "flexible", "local", "custom"]).default("live"),
  /** @deprecated Prefer realtime.model — kept in sync for older YAML. */
  model: z.string().default(DEFAULT_REALTIME_MODEL),
  /** @deprecated Prefer realtime.voice — kept in sync for older YAML. */
  voice: z.string().default("marin"),
  livekit_url: z.string().optional(),
  livekit_public_url: z.string().optional(),
  livekit_api_key: z.string().optional(),
  livekit_api_secret: z.string().optional(),
  /** @deprecated Prefer realtime.api_key — kept in sync for older YAML. */
  openai_api_key: z.string().optional(),
  realtime: RealtimeConfigSchema.default({
    provider: "openai",
    model: DEFAULT_REALTIME_MODEL,
    voice: "marin",
  }),
  stt: SttConfigSchema.default({
    provider: "deepgram",
    model: "nova-3",
  }),
  llm: LlmConfigSchema.default({
    provider: "openrouter",
    model: "openai/gpt-4o-mini",
    base_url: DEFAULT_OPENROUTER_BASE_URL,
  }),
  tts: TtsConfigSchema.default({
    provider: "cartesia",
    model: "sonic-3",
    voice: DEFAULT_CARTESIA_VOICE,
  }),
});

function mergeSpeakingIntoConversation(
  value: z.infer<typeof ConversationObjectSchema>,
  speaking: SpeakingConversationFields,
): z.infer<typeof ConversationObjectSchema> {
  return {
    ...value,
    speaking_mode: speaking.speaking_mode,
    preset: speaking.preset,
    model: speaking.model,
    voice: speaking.voice,
    openai_api_key: speaking.openai_api_key,
    realtime: speaking.realtime,
    stt: speaking.stt,
    llm: speaking.llm,
    tts: speaking.tts,
  };
}

export const ConversationConfigSchema = z.preprocess((input) => {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const speaking = normalizeSpeakingFields(raw);
  return mergeSpeakingIntoConversation(
    {
      adapter: typeof raw.adapter === "string" ? raw.adapter : "livekit",
      speaking_mode: speaking.speaking_mode,
      preset: speaking.preset,
      model: speaking.model,
      voice: speaking.voice,
      livekit_url: typeof raw.livekit_url === "string" ? raw.livekit_url : undefined,
      livekit_public_url:
        typeof raw.livekit_public_url === "string" ? raw.livekit_public_url : undefined,
      livekit_api_key: typeof raw.livekit_api_key === "string" ? raw.livekit_api_key : undefined,
      livekit_api_secret:
        typeof raw.livekit_api_secret === "string" ? raw.livekit_api_secret : undefined,
      openai_api_key: speaking.openai_api_key,
      realtime: speaking.realtime,
      stt: speaking.stt,
      llm: speaking.llm,
      tts: speaking.tts,
    },
    speaking,
  );
}, ConversationObjectSchema);

export const ConfigSchema = z.object({
  server: z.object({
    base_url: z.string().url(),
    web_url: z.string().url().default("http://localhost:5173"),
    port: z.number().default(8787),
    host: z.string().default("0.0.0.0"),
  }),
  storage: z.object({
    adapter: z.literal("sqlite").default("sqlite"),
    path: z.string().default("~/.openconfer/openconfer.db"),
  }),
  conversation: ConversationConfigSchema,
  telephony: z
    .object({
      adapter: z.literal("twilio").default("twilio"),
      twilio: z
        .object({
          account_sid: z.string().min(1).optional(),
          auth_token: z.string().min(1).optional(),
          from_number: z.string().regex(/^\+[1-9]\d{7,14}$/, "Must be an E.164 phone number").optional(),
          destination_number: z
            .string()
            .regex(/^\+[1-9]\d{7,14}$/, "Must be an E.164 phone number")
            .optional(),
        })
        .default({}),
    })
    .optional(),
  routes: z
    .object({
      default: z.object({
        notify: z.array(z.string()).default(["secure_link"]),
        connect: z.array(z.string()).default(["browser"]),
        fallback: z.array(z.string()).default([]),
      }),
    })
    .default({
      default: {
        notify: ["secure_link"],
        connect: ["browser"],
        fallback: [],
      },
    }),
  operators: z
    .record(
      z.object({
        call_name: z.string().trim().min(1).max(80).optional(),
        timezone: z.string().default("UTC"),
        quiet_hours: z.string().optional(),
        alerts: OperatorAlertsSchema.optional(),
      }),
    )
    .default({ me: { timezone: "UTC" } }),
  auth: z.object({
    api_token: z.string().optional(),
    jwt_secret: z.string().min(32).optional(),
    webhook_secret: z.string().min(16).optional(),
  }),
});

export type OpenConferConfig = z.infer<typeof ConfigSchema>;
export type ConversationConfig = z.infer<typeof ConversationObjectSchema>;

const ProviderSecretPatch = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  voice: z.string().optional(),
  base_url: z.string().optional(),
  /** Omit to leave unchanged; empty string clears the secret. */
  api_key: z.string().optional(),
});

export const SettingsPatchSchema = z.object({
  server: z
    .object({
      base_url: z.string().url().optional(),
      web_url: z.string().url().optional(),
    })
    .optional(),
  routes: z
    .object({
      default: z
        .object({
          notify: z.array(z.string()).optional(),
          connect: z.array(z.string()).optional(),
          fallback: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
  conversation: z
    .object({
      adapter: z.string().optional(),
      speaking_mode: z.enum(["realtime", "pipeline"]).optional(),
      preset: z.enum(["live", "flexible", "local", "custom"]).optional(),
      model: z.string().optional(),
      voice: z.string().optional(),
      livekit_url: z.string().optional(),
      livekit_public_url: z.string().optional(),
      /** Omit to leave unchanged; empty string clears the secret. */
      livekit_api_key: z.string().optional(),
      livekit_api_secret: z.string().optional(),
      /** Omit to leave unchanged; empty string clears the secret. Legacy alias for realtime.api_key. */
      openai_api_key: z.string().optional(),
      realtime: ProviderSecretPatch.optional(),
      stt: ProviderSecretPatch.optional(),
      llm: ProviderSecretPatch.optional(),
      tts: ProviderSecretPatch.optional(),
    })
    .optional(),
  telephony: z
    .object({
      adapter: z.literal("twilio").optional(),
      twilio: z
        .object({
          /** Omit to leave unchanged; empty string clears the value. */
          account_sid: z.string().optional(),
          auth_token: z.string().optional(),
          from_number: z.string().optional(),
          destination_number: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  operators: z
    .record(
      z.object({
        call_name: z.string().max(80).optional(),
        timezone: z.string().optional(),
        quiet_hours: z.string().nullable().optional(),
        alerts: OperatorAlertsObjectSchema.partial().optional(),
      }),
    )
    .optional(),
});

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export function validateResultAgainstSchema(
  result: Record<string, unknown>,
  schema: Record<string, unknown>,
): { valid: boolean; errors: string[] } {
  try {
    const validate = resultValidator.compile(schema);
    const valid = validate(result);
    return {
      valid,
      errors: valid
        ? []
        : (validate.errors ?? []).map(
            (error: ErrorObject) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
          ),
    };
  } catch (error) {
    return {
      valid: false,
      errors: [
        `Invalid result schema: ${error instanceof Error ? error.message : "unknown error"}`,
      ],
    };
  }
}
