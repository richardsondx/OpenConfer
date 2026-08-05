import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockConversation } from "../lib/settings-fixtures";
import type { SettingsPatch, SettingsView } from "../lib/settings";
import { SettingsModal } from "./SettingsModal";

function settings(): SettingsView {
  return {
    config_path: "/tmp/config.yaml",
    server: {
      base_url: "http://127.0.0.1:8787",
      web_url: "http://127.0.0.1:5173",
      port: 8787,
      host: "127.0.0.1",
    },
    routes: { default: { notify: ["secure_link"], connect: ["browser"], fallback: [] } },
    conversation: mockConversation(),
    telephony: {
      adapter: "twilio",
      twilio: { account_sid_configured: false, auth_token_configured: false },
    },
    operators: ["me"],
    operator: {
      id: "me",
      timezone: "UTC",
      alerts: { style: "subtle", sound: true, browser_notifications: false, snooze_minutes: 3 },
    },
    auth: { api_token_configured: true, webhook_secret_configured: false },
    status: {
      livekit: "not_configured",
      twilio: "not_enabled",
      openai_worker: "missing_key",
      speaking_agent: "missing_credentials",
      voice_ready: false,
      restart_required: false,
    },
    hermes: { base_url: "http://127.0.0.1:8787", env_export: "", skill_commands: [] },
  };
}

describe("SettingsModal Twilio phone channel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("ties the Phone call checkbox directly to the twilio notification route", async () => {
    let current = settings();
    const patches: SettingsPatch[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          const patch = JSON.parse(String(init.body)) as SettingsPatch;
          patches.push(patch);
          current = {
            ...current,
            routes: {
              ...current.routes,
              default: { ...current.routes.default, ...patch.routes?.default },
            },
            status: {
              ...current.status,
              twilio: patch.routes?.default?.notify?.includes("twilio")
                ? "missing_config"
                : "not_enabled",
            },
          };
        }
        return new Response(JSON.stringify(current), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    render(
      <SettingsModal
        token="oc_test"
        open
        initialSection="alerts"
        onClose={() => undefined}
      />,
    );

    const phone = await screen.findByRole("checkbox", { name: /phone call/i });
    fireEvent.click(phone);
    expect(screen.getByLabelText("Twilio Account SID")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]?.routes?.default?.notify).toEqual(["secure_link", "twilio"]);
    expect(patches[0]?.telephony?.adapter).toBe("twilio");

    fireEvent.click(phone);
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]?.routes?.default?.notify).toEqual(["secure_link"]);
  });
});
