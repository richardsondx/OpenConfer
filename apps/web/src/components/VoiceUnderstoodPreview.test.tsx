import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { understoodHeadline, VoiceUnderstoodPreview } from "./VoiceUnderstoodPreview";

describe("understoodHeadline", () => {
  it("humanizes choice decisions with option labels", () => {
    expect(
      understoodHeadline(
        { result: { choice: "pizza" } },
        "decision",
        [
          { id: "pizza", label: "Pizza" },
          { id: "tacos", label: "Tacos" },
        ],
      ),
    ).toBe("Pizza");
  });

  it("humanizes approvals", () => {
    expect(understoodHeadline({ result: { approved: true } }, "approval")).toBe("Approved");
  });
});

describe("VoiceUnderstoodPreview", () => {
  it("shows understood label, headline, and not-saved hint", () => {
    render(
      <VoiceUnderstoodPreview
        understood={{ result: { choice: "tacos" }, summary: "Going with tacos" }}
        sessionType="decision"
        options={[
          { id: "pizza", label: "Pizza" },
          { id: "tacos", label: "Tacos" },
        ]}
      />,
    );

    expect(screen.getByText(/understood so far/i)).toBeInTheDocument();
    expect(screen.getByText(/^Tacos$/)).toBeInTheDocument();
    expect(screen.getByText(/going with tacos/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing is saved until the agent confirms/i)).toBeInTheDocument();
  });

  it("updates the headline when the understood result changes", () => {
    const { rerender } = render(
      <VoiceUnderstoodPreview
        understood={{ result: { choice: "pizza" } }}
        sessionType="decision"
      />,
    );
    expect(screen.getByText(/^pizza$/)).toBeInTheDocument();

    rerender(
      <VoiceUnderstoodPreview
        understood={{ result: { choice: "tacos" } }}
        sessionType="decision"
      />,
    );
    expect(screen.getByText(/^tacos$/)).toBeInTheDocument();
    expect(screen.queryByText(/^pizza$/)).not.toBeInTheDocument();
  });
});
