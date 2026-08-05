import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentPresence } from "./AgentPresence";

describe("AgentPresence", () => {
  it("exposes waiting and speaking states for assistive tech", () => {
    const { rerender } = render(<AgentPresence state="waiting" />);
    expect(screen.getByRole("img", { name: /waiting for the agent/i })).toBeInTheDocument();

    rerender(<AgentPresence state="speaking" level={0.6} />);
    expect(screen.getByRole("img", { name: /agent is speaking/i })).toBeInTheDocument();
    expect(screen.getByText(/agent is speaking/i)).toBeInTheDocument();
  });
});
