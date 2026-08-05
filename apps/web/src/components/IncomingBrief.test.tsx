import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IncomingBrief } from "./IncomingBrief";

describe("IncomingBrief", () => {
  it("shows the full supplied brief metadata", () => {
    render(<IncomingBrief session={{
      id: "ses_123456789012345",
      type: "decision",
      status: "notified",
      objective: "Choose a release path",
      initiator: { agent_id: "planner", harness: "test" },
      brief: { reason: "Deployment is paused", recommendation: "Canary", options: [{ id: "a", label: "Canary" }], completed: ["Tests passed"], context: "Friday release", consequence_of_delay: "Missed window" },
      urgency: "high",
      expires_at: "2026-08-04T18:00:00.000Z",
      privacy: { recording: false, notice: "Audio is not retained" },
    }} onJoin={vi.fn()} onTextReply={vi.fn()} onDecline={vi.fn()} onSnooze={vi.fn()} />);

    for (const text of ["Canary", "Tests passed", "Friday release", "Missed window", "high", "Audio is not retained"]) {
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    }
    expect(screen.getByRole("button", { name: /join confer session now/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reply by text/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /snooze 3m/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /check later/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/not recorded by default/i)).not.toBeInTheDocument();
  });

  it("leads sandbox sessions with voice join and demotes text reply", () => {
    render(
      <IncomingBrief
        session={{
          id: "ses_demo123456789",
          type: "decision",
          status: "notified",
          objective: "Should we order pizza or tacos for lunch?",
          initiator: { agent_id: "openconfer-demo", harness: "web-ui" },
          brief: { reason: "The team is hungry", options: [{ id: "pizza", label: "Pizza" }] },
        }}
        onJoin={vi.fn()}
        onTextReply={vi.fn()}
        onDecline={vi.fn()}
        onSnooze={vi.fn()}
      />,
    );

    expect(screen.getByText(/^sandbox$/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /join test call/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /prefer text instead/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reply by text/i })).not.toBeInTheDocument();
  });
});
