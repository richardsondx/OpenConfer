import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InboxPage } from "./InboxPage";
import { mockConversation } from "../lib/settings-fixtures";

const settingsPayload = {
  config_path: "/tmp/config.yaml",
  server: { base_url: "http://127.0.0.1:8787", web_url: "http://127.0.0.1:5173", port: 8787, host: "0.0.0.0" },
  routes: { default: { notify: ["secure_link"], connect: ["browser"], fallback: [] } },
  conversation: mockConversation({
    livekit_credential_source: "none",
  }),
  telephony: {
    adapter: "twilio" as const,
    twilio: { account_sid_configured: false, auth_token_configured: false },
  },
  operators: ["me"],
  operator: { id: "me", call_name: "Richardson", timezone: "UTC", alerts: { style: "subtle", sound: true, browser_notifications: false, snooze_minutes: 3 } },
  auth: { api_token_configured: true, api_token_preview: "…token", webhook_secret_configured: false },
  status: {
    livekit: "not_configured",
    twilio: "not_enabled",
    openai_worker: "missing_key",
    speaking_agent: "missing_credentials",
    voice_ready: false,
    restart_required: false,
  },
  hermes: {
    base_url: "http://127.0.0.1:8787",
    connect_command: "openconfer connect hermes",
    openclaw_connect_command: "openconfer connect openclaw",
    skill_markdown: "# OpenConfer\n\nAsk a human.",
    skill_install_path: "~/.hermes/skills/openconfer/SKILL.md",
    env_export: "export OPENCONFER_BASE_URL=...",
    skill_commands: ["openconfer doctor"],
  },
};

const demoSession = {
  id: "ses_demo1",
  type: "decision",
  status: "completed",
  objective: "Choose the default transport for the MVP",
  brief: { reason: "practice" },
  summary: "Ship LiveKit first",
  result: { choice: "livekit" },
  initiator: { agent_id: "openconfer-demo", harness: "web-ui" },
  join_url: "http://127.0.0.1:5173/join/ses_demo1#token=x",
};

const cancelledSession = {
  id: "ses_cancel1",
  type: "decision",
  status: "cancelled",
  objective: "Should we order pizza or tacos for lunch?",
  brief: { reason: "sandbox" },
  initiator: { agent_id: "openconfer-demo", harness: "web-ui" },
  join_url: "http://127.0.0.1:5173/join/ses_cancel1#token=x",
};

const openSession = {
  id: "ses_open1",
  type: "decision",
  status: "joining",
  objective: "Should we order pizza or tacos for lunch?",
  brief: { reason: "sandbox" },
  initiator: { agent_id: "openconfer-demo", harness: "web-ui" },
  join_url: "http://127.0.0.1:5173/join/ses_open1#token=x",
};

const waitingSession = {
  id: "ses_waiting1",
  type: "decision",
  status: "waiting",
  objective: "Choose the launch window",
  brief: { reason: "Launch decision" },
  initiator: { agent_id: "release-agent", harness: "hermes" },
  join_url: "http://127.0.0.1:5173/join/ses_waiting1#token=x",
};

const phoneSettingsPayload = {
  ...settingsPayload,
  routes: {
    ...settingsPayload.routes,
    default: { ...settingsPayload.routes.default, notify: ["secure_link", "twilio"] },
  },
  status: {
    ...settingsPayload.status,
    livekit: "ready",
    twilio: "ready",
    speaking_agent: "ready",
    voice_ready: true,
  },
};

function stubFetch(
  sessions: unknown[] = [],
  settings: typeof settingsPayload = settingsPayload,
  phoneDelivery: { status: string; provider_status?: string; session_ended?: boolean } = {
    status: "succeeded",
    provider_status: "ringing",
  },
) {
  const list = [...sessions];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/sessions/demo") && init?.method === "POST") {
        const created = { ...demoSession, status: "notified", summary: undefined, result: undefined };
        list.unshift(created);
        return new Response(JSON.stringify(created), { status: 201 });
      }
      if (url.includes("/delivery/twilio")) {
        if (phoneDelivery.session_ended) {
          const id = url.split("/v1/sessions/")[1]?.split("/")[0];
          const index = list.findIndex((session) => (session as { id: string }).id === id);
          if (index >= 0) list[index] = { ...(list[index] as object), status: "cancelled" };
        }
        return new Response(JSON.stringify(phoneDelivery), { status: 200 });
      }
      if (url.includes("/v1/sessions/") && url.endsWith("/cancel") && init?.method === "POST") {
        const id = url.split("/v1/sessions/")[1]?.split("/")[0];
        const index = list.findIndex((session) => (session as { id: string }).id === id);
        if (index >= 0) {
          list[index] = { ...(list[index] as object), status: "cancelled" };
        }
        return new Response(JSON.stringify({ id, status: "cancelled" }), { status: 200 });
      }
      if (url.includes("/v1/sessions") && !url.includes("/demo") && !url.includes("/cancel")) {
        return new Response(JSON.stringify({ sessions: list }), { status: 200 });
      }
      if (url.includes("/v1/settings")) {
        return new Response(JSON.stringify(settings), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "missing mock" }), { status: 500 });
    }),
  );
}

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="current path">{location.pathname}</output>;
}

describe("InboxPage", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
    stubFetch([]);
  });

  it("requires confirmation before placing a phone test call", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    stubFetch([waitingSession], phoneSettingsPayload);
    sessionStorage.setItem("oc_token", "oc_test_token");

    render(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );

    await screen.findByRole("button", { name: /phone calls enabled/i });
    fireEvent.click(screen.getByRole("button", { name: /^test call$/i }));

    expect(window.confirm).toHaveBeenCalledWith("Place a test call to your configured phone now?");
    expect(fetch).not.toHaveBeenCalledWith("/v1/sessions/demo", expect.anything());
  });

  it("shows token gate guidance, then get-started and settings", async () => {
    render(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );

    expect(screen.getByText(/open your operator inbox/i)).toBeInTheDocument();
    expect(screen.getByText(/openconfer init/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /give every ai agent a way to call you/i })).toBeInTheDocument();
    expect(screen.getByText(/pnpm setup/i)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /from source/i })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("tab", { name: /^npm$/i }));
    expect(screen.getByText(/npm install --global @openconfer\/cli/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/access key/i), { target: { value: "oc_test_token" } });
    fireEvent.click(screen.getByRole("button", { name: /open inbox/i }));

    await waitFor(() => {
      expect(screen.queryByText("Human Decision Infrastructure")).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("heading", { name: /give every ai agent a way to call you/i })).not.toBeInTheDocument();
    expect(screen.getByText("Your first decision loop")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start test call/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^settings$/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^settings$/i }));
    const dialog = await screen.findByRole("dialog", { name: /settings/i });
    expect(screen.getByRole("heading", { name: /^status$/i })).toBeInTheDocument();

    const incomingCallsNav = Array.from(dialog.querySelectorAll("button")).find(
      (btn) => /^incoming calls$/i.test(btn.textContent ?? ""),
    );
    expect(incomingCallsNav).toBeTruthy();
    fireEvent.click(incomingCallsNav!);
    expect(await screen.findByLabelText(/what should the caller call you/i)).toHaveValue("Richardson");

    const connectNav = Array.from(dialog.querySelectorAll("button")).find(
      (btn) => /^connect agent$/i.test(btn.textContent ?? ""),
    );
    expect(connectNav).toBeTruthy();
    fireEvent.click(connectNav!);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /connect agent/i })).toBeInTheDocument();
    });
    const summaries = Array.from(dialog.querySelectorAll("summary"));
    const hermesToggle = summaries.find((el) =>
      /^hermes$/i.test(el.textContent?.trim() ?? ""),
    );
    const openclawToggle = summaries.find((el) =>
      /openclaw/i.test(el.textContent ?? ""),
    );
    expect(hermesToggle).toBeTruthy();
    expect(openclawToggle).toBeTruthy();
    expect(openclawToggle?.textContent).not.toMatch(/coming soon/i);
    expect(
      summaries.some((summary) => summary.textContent?.trim() === "Claude Code"),
    ).toBe(true);
    expect(summaries.some((summary) => summary.textContent?.trim() === "Codex")).toBe(true);
    expect(screen.getByRole("heading", { name: /skill preview/i })).toBeInTheDocument();
  });

  it("dismisses the connect-an-agent next step when the operator acknowledges", async () => {
    stubFetch([demoSession]);
    sessionStorage.setItem("oc_token", "oc_test_token");

    render(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /next: connect an agent/i })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /^test call$/i })).toBeInTheDocument();
    expect(document.querySelector(".inbox-sandbox-bar")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /i connected the agent/i }));

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: /next: connect an agent/i })).not.toBeInTheDocument();
    });
    expect(localStorage.getItem("oc_agent_connected")).toBe("1");
    expect(screen.getByText(/choose the default transport for the mvp/i)).toBeInTheDocument();
  });

  it("ends an open session from the inbox list", async () => {
    stubFetch([openSession]);
    sessionStorage.setItem("oc_token", "oc_test_token");
    localStorage.setItem("oc_agent_connected", "1");

    render(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/pizza or tacos/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("link", { name: /pizza or tacos/i })).toHaveAttribute(
      "href",
      "/join/ses_open1?autojoin=1#token=x",
    );
    fireEvent.click(screen.getByRole("button", { name: /copy secure link for.*pizza or tacos/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /copy secure link/i })).toHaveTextContent("Copied"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(openSession.join_url);
    expect(screen.getByRole("button", { name: /end 1 open session/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /end session ses_open1/i }));

    await waitFor(() => {
      expect(screen.getByText(/^cancelled$/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/no decision recorded/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /end session ses_open1/i })).not.toBeInTheDocument();
  });

  it("shows decision detail and outcome cues on completed and cancelled rows", async () => {
    stubFetch([demoSession, cancelledSession]);
    sessionStorage.setItem("oc_token", "oc_test_token");
    localStorage.setItem("oc_agent_connected", "1");

    const { container } = render(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/ship livekit first/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/^decided$/i)).toBeInTheDocument();
    expect(screen.getByText(/no decision recorded/i)).toBeInTheDocument();
    expect(screen.getByText(/^cancelled$/i)).toBeInTheDocument();
    expect(container.querySelector(".session-row--ok")).toBeTruthy();
    expect(container.querySelector(".session-row--bad")).toBeTruthy();
  });

  it("uses phone mode as the primary workflow and keeps the secure link copyable", async () => {
    stubFetch([waitingSession], phoneSettingsPayload);
    sessionStorage.setItem("oc_token", "oc_test_token");
    localStorage.setItem("oc_agent_connected", "1");

    render(
      <MemoryRouter>
        <LocationProbe />
        <InboxPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("button", { name: /phone calls enabled/i })).toHaveClass("is-enabled");
    expect(screen.queryByRole("button", { name: /^answer$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /choose the launch window/i })).toHaveAttribute(
      "href",
      "/join/ses_waiting1?autojoin=1#token=x",
    );
    expect(screen.getByRole("button", { name: /copy secure link for.*choose the launch window/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^test call$/i }));

    expect(await screen.findByText(/call requested/i)).toBeInTheDocument();
    expect(await screen.findByText(/your phone is ringing/i, {}, { timeout: 3_000 })).toBeInTheDocument();
    expect(screen.getByLabelText("current path")).toHaveTextContent("/");
    expect(fetch).toHaveBeenCalledWith(
      "/v1/sessions/demo",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps the session waiting when a phone call finishes without a decision", async () => {
    stubFetch([waitingSession], phoneSettingsPayload, {
      status: "succeeded",
      provider_status: "completed",
      session_ended: false,
    });
    sessionStorage.setItem("oc_token", "oc_test_token");
    localStorage.setItem("oc_agent_connected", "1");

    render(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );

    await screen.findByRole("button", { name: /phone calls enabled/i });
    fireEvent.click(screen.getByRole("button", { name: /^test call$/i }));

    expect(await screen.findByText(/session remains available in your inbox/i, {}, { timeout: 3_000 })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /check phone settings/i })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/^in progress$/i)).toBeInTheDocument());
  });

  it("shows type-aware labels and shape cues for standup, approval, and research rows", async () => {
    stubFetch([
      {
        id: "ses_standup",
        type: "briefing",
        status: "completed",
        objective: "Confirm today's priorities",
        brief: {
          reason: "Daily standup briefing",
          completed: ["Shipped session API", "Built browser client"],
        },
        summary: "Focus webhook reliability; ship notify path",
        initiator: { agent_id: "hermes-primary", harness: "hermes" },
        join_url: "http://127.0.0.1:5173/join/ses_standup#token=x",
      },
      {
        id: "ses_approve",
        type: "approval",
        status: "completed",
        objective: "Approve publishing release v0.1.0 to production",
        brief: { reason: "Release candidate passed all checks" },
        result: { approved: true, notes: "changelog looks good" },
        initiator: { agent_id: "hermes-primary", harness: "hermes" },
        join_url: "http://127.0.0.1:5173/join/ses_approve#token=x",
      },
      {
        id: "ses_research",
        type: "decision",
        status: "completed",
        objective: "Research complete: which launch path next?",
        brief: {
          reason: "Deep research finished",
          options: [
            { id: "soft", label: "Soft launch" },
            { id: "public", label: "Public launch" },
          ],
        },
        result: { selected_option: "soft" },
        initiator: { agent_id: "research-bot", harness: "openclaw" },
        join_url: "http://127.0.0.1:5173/join/ses_research#token=x",
      },
    ]);
    sessionStorage.setItem("oc_token", "oc_test_token");
    localStorage.setItem("oc_agent_connected", "1");

    render(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/^synced$/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/focus webhook reliability; ship notify path/i)).toBeInTheDocument();
    expect(screen.getByText(/2 updates · hermes-primary · hermes/i)).toBeInTheDocument();
    expect(screen.getByText(/^approved$/i)).toBeInTheDocument();
    expect(screen.getByText(/approval · hermes-primary · hermes/i)).toBeInTheDocument();
    expect(screen.getByText(/^decided$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Soft launch$/)).toBeInTheDocument();
    expect(screen.getByText(/soft launch · public launch · research-bot · openclaw/i)).toBeInTheDocument();
  });
});
