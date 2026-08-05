import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TestCallPicker } from "./TestCallPicker";

describe("TestCallPicker", () => {
  it("explains the available scenarios and starts the selected one", () => {
    const onStartTestCall = vi.fn();
    render(<TestCallPicker voiceReady onStartTestCall={onStartTestCall} />);

    fireEvent.click(screen.getByRole("button", { name: /choose test call scenario/i }));
    expect(screen.getByRole("menu").parentElement).toBe(document.body);
    expect(screen.getAllByRole("menuitem")).toHaveLength(4);
    expect(screen.getByText(/choose a scenario/i)).toBeInTheDocument();
    expect(screen.getByText(/turn a progress update into one team focus/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: /standup/i }));

    expect(onStartTestCall).toHaveBeenCalledWith("standup");
  });
});
