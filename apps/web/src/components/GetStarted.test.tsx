import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { GetStarted } from "./GetStarted";
import type { SettingsView } from "../lib/settings";
import { mockConversation } from "../lib/settings-fixtures";

function settings(voiceReady: boolean): SettingsView {
  return {
    config_path: "/tmp/config.yaml",
    server: { base_url: "http://127.0.0.1:8787", web_url: "http://127.0.0.1:5173", port: 8787, host: "0.0.0.0" },
    routes: { default: { notify: ["secure_link"], connect: ["browser"], fallback: [] } },
    conversation: mockConversation({
      livekit_api_key_configured: voiceReady,
      livekit_api_secret_configured: voiceReady,
      openai_api_key_configured: voiceReady,
      realtime: {
        provider: "openai",
        model: "gpt-realtime",
        voice: "marin",
        api_key_configured: voiceReady,
      },
      missing_credentials: voiceReady ? [] : ["OpenAI API key"],
    }),
    telephony: {
      adapter: "twilio",
      twilio: { account_sid_configured: false, auth_token_configured: false },
    },
    operators: ["me"],
    auth: { api_token_configured: true, webhook_secret_configured: false },
    status: {
      livekit: voiceReady ? "ready" : "not_configured",
      twilio: "not_enabled",
      openai_worker: voiceReady ? "ready" : "missing_key",
      speaking_agent: voiceReady ? "ready" : "missing_credentials",
      voice_ready: voiceReady,
      restart_required: false,
    },
    hermes: {
      base_url: "http://127.0.0.1:8787",
      env_export: "export OPENCONFER_BASE_URL=...",
      skill_commands: [],
    },
  };
}

describe("GetStarted", () => {
  it("positions the first decision loop and gates the test call until voice is ready", () => {
    const onOpenSettings = vi.fn();
    render(
      <MemoryRouter>
        <GetStarted
          token="oc_test"
          settings={settings(false)}
          onOpenSettings={onOpenSettings}
          onSessionCreated={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Your first decision loop")).toBeInTheDocument();
    expect(screen.getByText(/go from install to a real voice decision/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /set up voice/i })).toBeInTheDocument();
    const demo = screen.getByRole("button", { name: /start test call/i });
    expect(demo).toBeDisabled();
    expect(screen.getByText(/configure a speaking preset/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^connect agent$/i })).toBeInTheDocument();
  });

  it("enables the test call CTA when voice is ready", () => {
    render(
      <MemoryRouter>
        <GetStarted
          token="oc_test"
          settings={settings(true)}
          onOpenSettings={vi.fn()}
          onSessionCreated={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: /start test call/i })).toBeEnabled();
    expect(screen.getByText(/no hermes or agent required/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /voice settings/i }));
  });
});
