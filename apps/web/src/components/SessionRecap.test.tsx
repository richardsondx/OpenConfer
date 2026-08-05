import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionRecap } from "./SessionRecap";

describe("SessionRecap", () => {
  it("shows objective, outcome, options, and completed work for a research decision", () => {
    render(
      <SessionRecap
        session={{
          id: "ses_research",
          type: "decision",
          status: "completed",
          objective: "Research complete: which launch path next?",
          summary: "Soft launch first",
          brief: {
            reason: "Deep research finished",
            recommendation: "Soft launch",
            options: [
              { id: "soft", label: "Soft launch to existing users" },
              { id: "public", label: "Public launch" },
            ],
            context: "Competitive analysis and funnel review attached.",
            completed: ["Interviewed 8 users", "Benchmarked pricing"],
          },
          initiator: { agent_id: "research-bot", harness: "openclaw" },
          result: { selected_option: "soft" },
          captured_context: {
            steering: ["Require passkeys"],
            additional_instructions: ["Update the runbook"],
            new_requests: ["Audit mobile login next"],
            unresolved_topics: ["Recovery codes"],
          },
        }}
      />,
    );

    expect(screen.getByRole("region", { name: /session recap/i })).toBeInTheDocument();
    expect(screen.getByText(/which launch path next/i)).toBeInTheDocument();
    expect(screen.getByText(/deep research finished/i)).toBeInTheDocument();
    expect(screen.getByRole("status", { name: /outcome: soft launch first/i })).toBeInTheDocument();
    expect(screen.getByText(/soft launch first/i)).toHaveClass("session-recap-outcome-value");
    expect(screen.getByText(/soft launch to existing users/i)).toBeInTheDocument();
    expect(screen.getByText(/interviewed 8 users/i)).toBeInTheDocument();
    expect(screen.getByText(/competitive analysis/i)).toBeInTheDocument();
    expect(screen.getByText(/require passkeys/i)).toBeInTheDocument();
    expect(screen.getByText(/update the runbook/i)).toBeInTheDocument();
    expect(screen.getByText(/audit mobile login next/i)).toBeInTheDocument();
    expect(screen.getByText(/recovery codes/i)).toBeInTheDocument();
  });

  it("shows standup completed work without inventing options", () => {
    render(
      <SessionRecap
        session={{
          id: "ses_standup",
          type: "briefing",
          status: "completed",
          objective: "Confirm today's priorities",
          brief: {
            reason: "Daily standup briefing",
            completed: ["Shipped session API", "Built browser client"],
            recommendation: "Focus on webhook reliability today",
          },
          initiator: { agent_id: "hermes-primary", harness: "hermes" },
          result: { next_actions: ["Focus webhook reliability"] },
        }}
      />,
    );

    expect(screen.getByText(/confirm today's priorities/i)).toBeInTheDocument();
    expect(screen.getByText(/focus webhook reliability/i)).toBeInTheDocument();
    expect(screen.getByText(/shipped session api/i)).toBeInTheDocument();
    expect(screen.queryByText(/^options$/i)).not.toBeInTheDocument();
  });
});
